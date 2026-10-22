/**
 * The Redis half of the Data panel: a dependency-free RESP2 client.
 *
 * Redis has no small, dependency-free client that fits the Host's "node:* only"
 * rule, so this module speaks the wire protocol itself over `node:net` (and
 * `node:tls` when the connection says so). Three pieces:
 *
 * - {@link encodeCommand} turns one command into its RESP2 array-of-bulk-strings
 *   wire form. It is pure, which keeps the encoding unit-testable without a
 *   server.
 * - {@link RespParser} is an incremental reply parser: `feed()` may receive any
 *   slice of the byte stream (a reply split across TCP chunks, several replies in
 *   one chunk) and `take()` returns whatever complete replies are available.
 * - {@link withRedis} owns one socket: it connects, optionally AUTHs and SELECTs,
 *   hands a command client to the caller, and always closes the socket. The named
 *   helpers (`redisPing`, `redisInfo`, …) are the small public operations the ops
 *   layer calls.
 *
 * Failures are `DataError`s with the contract's codes; a caller never sees a raw
 * socket error. The reply cap and the per-command timeout both drop the socket,
 * because a late reply would otherwise be matched to the next command.
 *
 * v0.3 layers server/key editors on the same client (`redisClients`,
 * `redisDbSize`, memory/rename/expire/persist and the hash/list/set writes). They
 * reuse the handshake, timeouts, reply cap and socket cleanup, and validate their
 * arguments as `redis_invalid_argument` before opening a connection.
 *
 * @module dsh-long-data/src/redis
 */

import { connect as netConnect, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

import { DataError, describeError } from './errors.js'

/** Connection/command timeout used when the caller does not supply one. */
const DEFAULT_TIMEOUT_MS = 5000

/** Replies larger than this are refused instead of buffered. */
const DEFAULT_MAX_REPLY_BYTES = 2 * 1024 * 1024

/** Bounds accepted for `timeoutMs`, so a typo cannot hang a request forever. */
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 300000

/** A key longer than this is almost certainly a mistake, not data. */
const MAX_KEY_BYTES = 1024 * 1024

/** v0.3 form arguments: keys/fields/members are capped in characters. */
const MAX_ARGUMENT_KEY_CHARS = 512

/** v0.3 form arguments: written values are capped in UTF-8 bytes (1 MiB). */
const MAX_ARGUMENT_VALUE_BYTES = 1024 * 1024

/** The largest TTL `SET … EX` / `EXPIRE` accepts here (100 years), matching the panel. */
const MAX_TTL_SECONDS = 31536000

const CRLF = Buffer.from('\r\n')
const CR = 0x0d
const LF = 0x0a

/**
 * @typedef {object} RedisConnection
 * @property {string} host - hostname or IP address.
 * @property {number} port - TCP port.
 * @property {string} [username] - ACL user; empty/absent means the default user.
 * @property {string} [password] - empty/absent means no AUTH is sent.
 * @property {number} [db] - database index; SELECT runs only when greater than 0.
 * @property {boolean} [tls] - connect over TLS.
 * @property {number} [timeoutMs] - connect and per-command timeout.
 */

/**
 * The client handed to a `withRedis` callback.
 *
 * @typedef {object} RedisClient
 * @property {(args: (string|number)[]) => Promise<unknown>} command - send one
 *   command and resolve its decoded reply (or reject with a `DataError`).
 */

/**
 * A server error reply (`-ERR …`), kept distinct from real values by the parser.
 * The client turns a top-level one into a `DataError`.
 */
class ReplyError extends Error {
  /** @param {string} message - the reply text after the leading `-`. */
  constructor(message) {
    super(message)
    this.name = 'RedisReplyError'
  }
}

/* ------------------------------------------------------------------ encoding */

/**
 * Encode one Redis command as a RESP2 array of bulk strings.
 *
 * Every argument is length-prefixed, so command injection is impossible: a value
 * containing `\r\n` is data, not a new command.
 *
 * @param {(string|number|Buffer)[]} args - the command and its arguments.
 * @returns {Buffer} the bytes to write to the socket.
 */
export function encodeCommand(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError('encodeCommand() needs a non-empty array of arguments')
  }
  const parts = [Buffer.from(`*${args.length}\r\n`, 'ascii')]
  for (const raw of args) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
    parts.push(Buffer.from(`$${bytes.length}\r\n`, 'ascii'), bytes, CRLF)
  }
  return Buffer.concat(parts)
}

/* ------------------------------------------------------------------ decoding */

/**
 * @param {Buffer} buffer - the unconsumed stream.
 * @param {number} offset - first byte of the line's payload.
 * @returns {{ text: string, offset: number } | null} the line and the byte after
 *   its CRLF, or `null` when the terminator has not arrived yet.
 */
function readLine(buffer, offset) {
  const end = buffer.indexOf(CRLF, offset)
  if (end === -1) return null
  return { text: buffer.toString('utf8', offset, end), offset: end + 2 }
}

/**
 * @param {Buffer} buffer - the stream being parsed.
 * @param {number} offset - where the malformed token starts.
 * @param {string} reason - what was wrong.
 * @returns {DataError} the protocol failure.
 */
function protocolError(buffer, offset, reason) {
  const snippet = buffer.toString('utf8', offset, Math.min(buffer.length, offset + 64))
  return new DataError('redis_command_failed', `the Redis server sent a malformed reply (${reason})`, {
    reply: snippet,
  })
}

/**
 * @param {number} limit - the configured reply cap.
 * @returns {DataError} the size failure.
 */
function oversizeError(limit) {
  return new DataError('redis_command_failed', `the Redis reply exceeded the ${limit} byte limit`, {
    reply: `reply exceeds ${limit} bytes`,
    limit,
  })
}

/**
 * Parse a RESP integer line.
 *
 * @param {string} text - the line's payload.
 * @param {Buffer} buffer - the stream, for the error snippet.
 * @param {number} offset - where the token starts.
 * @returns {number} the integer.
 */
function parseIntegerLine(text, buffer, offset) {
  if (!/^-?\d+$/u.test(text)) {
    throw protocolError(buffer, offset, `expected an integer, got "${text.slice(0, 32)}"`)
  }
  return Number(text)
}

/**
 * Read a bulk string / blob (`$`, `=` or `!`). A nil bulk (`$-1`) is `null`.
 *
 * @param {Buffer} buffer - the stream.
 * @param {number} offset - offset of the type marker.
 * @param {number} maxBytes - reply cap.
 * @returns {{ value: string|null, offset: number } | null} the blob, or `null`
 *   when more bytes are needed.
 */
function readBlob(buffer, offset, maxBytes) {
  const line = readLine(buffer, offset + 1)
  if (line === null) return null
  const length = parseIntegerLine(line.text, buffer, offset)
  if (length === -1) return { value: null, offset: line.offset }
  if (length < 0) throw protocolError(buffer, offset, 'negative bulk string length')
  if (length > maxBytes) throw oversizeError(maxBytes)
  const start = line.offset
  const end = start + length
  if (buffer.length < end + 2) return null
  if (buffer[end] !== CR || buffer[end + 1] !== LF) {
    throw protocolError(buffer, offset, 'bulk string is not terminated by CRLF')
  }
  return { value: buffer.toString('utf8', start, end), offset: end + 2 }
}

/**
 * Read an array/set/push (`*`, `~`, `>`) of values. A nil array (`*-1`) is `null`.
 *
 * @param {Buffer} buffer - the stream.
 * @param {number} offset - offset of the type marker.
 * @param {number} maxBytes - reply cap.
 * @returns {{ value: unknown[]|null, offset: number } | null} the array.
 */
function readArray(buffer, offset, maxBytes) {
  const line = readLine(buffer, offset + 1)
  if (line === null) return null
  const count = parseIntegerLine(line.text, buffer, offset)
  if (count === -1) return { value: null, offset: line.offset }
  if (count < 0) throw protocolError(buffer, offset, 'negative array length')
  if (count > maxBytes) throw oversizeError(maxBytes)
  const items = []
  let next = line.offset
  for (let index = 0; index < count; index += 1) {
    const item = readValue(buffer, next, maxBytes)
    if (item === null) return null
    items.push(item.value)
    next = item.offset
  }
  return { value: items, offset: next }
}

/**
 * Read a RESP3 map (`%`) or attribute (`|`) body into a plain object.
 *
 * @param {Buffer} buffer - the stream.
 * @param {number} offset - offset of the type marker.
 * @param {number} maxBytes - reply cap.
 * @returns {{ value: Record<string, unknown>, offset: number } | null} the map.
 */
function readMap(buffer, offset, maxBytes) {
  const line = readLine(buffer, offset + 1)
  if (line === null) return null
  const count = parseIntegerLine(line.text, buffer, offset)
  if (count < 0) throw protocolError(buffer, offset, 'negative map length')
  if (count > maxBytes) throw oversizeError(maxBytes)
  const pairs = []
  let next = line.offset
  for (let index = 0; index < count; index += 1) {
    const key = readValue(buffer, next, maxBytes)
    if (key === null) return null
    next = key.offset
    const value = readValue(buffer, next, maxBytes)
    if (value === null) return null
    next = value.offset
    pairs.push([typeof key.value === 'string' ? key.value : String(key.value), value.value])
  }
  return { value: Object.fromEntries(pairs), offset: next }
}

/**
 * Parse one complete RESP value starting at `offset`.
 *
 * `null` means "not enough bytes yet"; the caller keeps the stream untouched and
 * retries after the next `feed()`. Malformed input throws a `DataError`.
 *
 * @param {Buffer} buffer - the stream.
 * @param {number} offset - first byte of the value.
 * @param {number} maxBytes - reply cap.
 * @returns {{ value: unknown, offset: number } | null} the parsed value.
 */
function readValue(buffer, offset, maxBytes) {
  if (offset >= buffer.length) return null
  const marker = buffer[offset]
  switch (marker) {
    case 0x2b: {
      // +
      const line = readLine(buffer, offset + 1)
      return line === null ? null : { value: line.text, offset: line.offset }
    }
    case 0x2d: {
      // -
      const line = readLine(buffer, offset + 1)
      return line === null ? null : { value: new ReplyError(line.text), offset: line.offset }
    }
    case 0x3a: {
      // :
      const line = readLine(buffer, offset + 1)
      return line === null ? null : { value: parseIntegerLine(line.text, buffer, offset), offset: line.offset }
    }
    case 0x24: {
      // $
      return readBlob(buffer, offset, maxBytes)
    }
    case 0x2a: {
      // *
      return readArray(buffer, offset, maxBytes)
    }
    case 0x7e: {
      // ~ RESP3 set: an array
      return readArray(buffer, offset, maxBytes)
    }
    case 0x3e: {
      // > RESP3 push: an array
      return readArray(buffer, offset, maxBytes)
    }
    case 0x25: {
      // % RESP3 map
      return readMap(buffer, offset, maxBytes)
    }
    case 0x7c: {
      // | RESP3 attribute: parse and discard the map, return the value after it
      const attribute = readMap(buffer, offset, maxBytes)
      if (attribute === null) return null
      return readValue(buffer, attribute.offset, maxBytes)
    }
    case 0x5f: {
      // _ RESP3 null
      const line = readLine(buffer, offset + 1)
      return line === null ? null : { value: null, offset: line.offset }
    }
    case 0x23: {
      // # RESP3 boolean
      const line = readLine(buffer, offset + 1)
      if (line === null) return null
      if (line.text === 't') return { value: true, offset: line.offset }
      if (line.text === 'f') return { value: false, offset: line.offset }
      throw protocolError(buffer, offset, `expected a boolean, got "${line.text.slice(0, 16)}"`)
    }
    case 0x2c: {
      // , RESP3 double; non-finite spellings stay text
      const line = readLine(buffer, offset + 1)
      if (line === null) return null
      const numeric = Number(line.text)
      return { value: Number.isFinite(numeric) ? numeric : line.text, offset: line.offset }
    }
    case 0x28: {
      // ( RESP3 big number: keep the digits exact
      const line = readLine(buffer, offset + 1)
      return line === null ? null : { value: line.text, offset: line.offset }
    }
    case 0x3d: {
      // = RESP3 verbatim string; drop the "txt:" style prefix
      const blob = readBlob(buffer, offset, maxBytes)
      if (blob === null) return null
      const value = typeof blob.value === 'string' && /^[a-z]{3}:/iu.test(blob.value) ? blob.value.slice(4) : blob.value
      return { value, offset: blob.offset }
    }
    case 0x21: {
      // ! RESP3 blob error
      const blob = readBlob(buffer, offset, maxBytes)
      if (blob === null) return null
      return { value: new ReplyError(blob.value === null ? '' : blob.value), offset: blob.offset }
    }
    default: {
      const display = marker >= 0x20 && marker < 0x7f ? String.fromCharCode(marker) : `\\x${marker.toString(16)}`
      throw protocolError(buffer, offset, `unknown reply type "${display}"`)
    }
  }
}

/**
 * Incremental RESP2 reply parser.
 *
 * Feed raw socket chunks in any split; `take()` returns every reply that is now
 * complete. Error replies come back as `Error` instances (the client maps them to
 * `DataError`s); everything else decodes to string / number / `null` / array.
 *
 * @example
 * const parser = new RespParser()
 * parser.feed(Buffer.from('+OK\r\n$5\r\nhe'))
 * parser.take() // [] — the bulk string is not complete yet
 * parser.feed(Buffer.from('llo\r\n'))
 * parser.take() // ['OK', 'hello']
 */
export class RespParser {
  #buffer = Buffer.alloc(0)
  #offset = 0
  #maxBytes

  /**
   * @param {{ maxBytes?: number }} [options] - `maxBytes` caps buffered reply
   *   bytes (default 2 MiB).
   */
  constructor(options = {}) {
    const configured = options !== null && typeof options === 'object' ? options.maxBytes : undefined
    this.#maxBytes =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_MAX_REPLY_BYTES
  }

  /**
   * Append bytes received from the socket.
   *
   * @param {Buffer|Uint8Array|string} chunk - the newly received bytes.
   * @returns {void}
   */
  feed(chunk) {
    if (chunk === null || chunk === undefined) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length === 0) return
    if (this.#offset > 0) {
      this.#buffer = this.#buffer.subarray(this.#offset)
      this.#offset = 0
    }
    if (this.#buffer.length + bytes.length > this.#maxBytes) throw oversizeError(this.#maxBytes)
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes])
  }

  /**
   * Remove and return every complete reply parsed so far.
   *
   * @returns {unknown[]} the decoded replies in wire order.
   */
  take() {
    const replies = []
    const buffer = this.#buffer
    let offset = this.#offset
    while (offset < buffer.length) {
      const parsed = readValue(buffer, offset, this.#maxBytes)
      if (parsed === null) break
      replies.push(parsed.value)
      offset = parsed.offset
    }
    if (offset >= buffer.length) {
      this.#buffer = Buffer.alloc(0)
      this.#offset = 0
    } else if (offset > 0) {
      this.#buffer = buffer.subarray(offset)
      this.#offset = 0
    }
    return replies
  }
}

/* ------------------------------------------------------------------ client */

/**
 * Turn a socket/network failure into the contract's error codes.
 *
 * @param {unknown} error - the event payload from the socket.
 * @param {{ host: string, port: number, tls: boolean }} config - the endpoint.
 * @returns {DataError} the mapped failure.
 */
function socketFailure(error, config) {
  const code =
    error !== null && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'string'
      ? /** @type {any} */ (error).code
      : ''
  const endpoint = { host: config.host, port: config.port }
  if (code === 'ETIMEDOUT') {
    return new DataError(
      'redis_timeout',
      `connecting to Redis at ${config.host}:${config.port} timed out`,
      { ...endpoint, cause: code },
    )
  }
  const reason = code !== '' ? code : describeError(error)
  const transport = config.tls ? ' over TLS' : ''
  return new DataError(
    'redis_unreachable',
    `could not reach Redis at ${config.host}:${config.port}${transport} (${reason})`,
    { ...endpoint, cause: reason },
  )
}

/**
 * Map a server error reply to a `DataError`.
 *
 * @param {Error} reply - the parsed error reply.
 * @param {string} commandName - upper-case command name (never its arguments,
 *   because AUTH carries the password).
 * @returns {DataError} the mapped failure.
 */
function mapReplyError(reply, commandName) {
  const text = reply.message
  const token = text.split(' ', 1)[0].toUpperCase()
  if (token === 'NOAUTH') {
    return new DataError('redis_auth_required', 'Redis requires authentication: configure a password for this connection', {
      reply: text,
    })
  }
  if (token === 'WRONGPASS' || commandName === 'AUTH') {
    return new DataError('redis_auth_failed', `Redis rejected the credentials: ${text}`, { reply: text })
  }
  return new DataError('redis_command_failed', `Redis rejected ${commandName}: ${text}`, { reply: text })
}

/**
 * Open the TCP or TLS socket described by `config`.
 *
 * @param {{ host: string, port: number, tls: boolean }} config - the endpoint.
 * @returns {import('node:net').Socket | import('node:tls').TLSSocket} the socket.
 */
function createSocket(config) {
  if (!config.tls) return netConnect({ host: config.host, port: config.port })
  return tlsConnect({
    host: config.host,
    port: config.port,
    // An IP literal cannot be an SNI name; certificate verification still uses
    // the address, and a real server certificate mismatch fails loudly.
    servername: isIP(config.host) === 0 ? config.host : undefined,
  })
}

/**
 * One socket plus its reply queue. Not exported: `withRedis` is the entry point.
 */
class RedisClient {
  #config
  #socket = null
  #parser = new RespParser()
  /** @type {{ resolve: (value: unknown) => void, reject: (error: Error) => void, name: string, timer: NodeJS.Timeout }[]} */
  #pending = []
  /** @type {DataError|null} */
  #failure = null
  #closed = false
  #connectSettled = true
  #connectResolve = null
  #connectReject = null
  #connectTimer = null

  /** @param {ReturnType<typeof normalizeConnection>} config - validated endpoint. */
  constructor(config) {
    this.#config = config
  }

  /**
   * Open the socket and run the handshake (AUTH when configured, then SELECT).
   *
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      await this.#open()
      if (this.#config.password !== '') {
        const auth =
          this.#config.username !== ''
            ? ['AUTH', this.#config.username, this.#config.password]
            : ['AUTH', this.#config.password]
        await this.command(auth)
      }
      if (this.#config.db > 0) await this.command(['SELECT', String(this.#config.db)])
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /**
   * Send one command and resolve with its reply. Rejects with a `DataError` for
   * any server, network, parse or timeout failure.
   *
   * @param {(string|number|Buffer)[]} args - the command and its arguments.
   * @returns {Promise<unknown>} the decoded reply.
   */
  async command(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new TypeError('a Redis command needs at least one argument')
    }
    if (this.#failure !== null) throw this.#failure
    const socket = this.#socket
    if (socket === null || socket.destroyed || !socket.writable) {
      throw new DataError(
        'redis_unreachable',
        `the connection to Redis at ${this.#config.host}:${this.#config.port} is not open`,
        this.#endpoint(),
      )
    }
    const payload = encodeCommand(args)
    const name = String(args[0]).toUpperCase()
    return new Promise((resolve, reject) => {
      /** @type {any} */
      const entry = { resolve, reject, name, timer: null }
      entry.timer = setTimeout(() => {
        if (!this.#pending.includes(entry)) return
        // Dropping the socket is required: a reply that arrives after the
        // timeout would otherwise be matched to the next command.
        this.#fail(
          new DataError(
            'redis_timeout',
            `Redis command ${name} timed out after ${this.#config.timeoutMs}ms`,
            { command: name, timeoutMs: this.#config.timeoutMs, ...this.#endpoint() },
          ),
        )
      }, this.#config.timeoutMs)
      this.#pending.push(entry)
      socket.write(payload, (error) => {
        if (error) this.#fail(socketFailure(error, this.#config))
      })
    })
  }

  /**
   * Close the socket, waiting briefly for a graceful FIN.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.#closed = true
    const socket = this.#socket
    this.#socket = null
    if (socket === null || socket.destroyed) return
    await new Promise((resolve) => {
      let timer = null
      const finish = () => {
        if (timer !== null) clearTimeout(timer)
        socket.removeListener('close', finish)
        resolve()
      }
      timer = setTimeout(() => {
        if (!socket.destroyed) socket.destroy()
        finish()
      }, 500)
      timer.unref?.()
      socket.once('close', finish)
      try {
        socket.end()
      } catch {
        socket.destroy()
        finish()
      }
    })
    if (!socket.destroyed) socket.destroy()
  }

  /**
   * @returns {{ host: string, port: number }} the endpoint, safe for error details.
   */
  #endpoint() {
    return { host: this.#config.host, port: this.#config.port }
  }

  /**
   * Create the socket, wire its events and wait for the transport to be ready.
   *
   * @returns {Promise<void>}
   */
  #open() {
    return new Promise((resolve, reject) => {
      const socket = createSocket(this.#config)
      this.#socket = socket
      this.#connectSettled = false
      this.#connectResolve = resolve
      this.#connectReject = reject
      socket.setNoDelay(true)
      this.#connectTimer = setTimeout(() => {
        this.#fail(
          new DataError(
            'redis_timeout',
            `could not connect to Redis at ${this.#config.host}:${this.#config.port} within ${this.#config.timeoutMs}ms`,
            { timeoutMs: this.#config.timeoutMs, ...this.#endpoint() },
          ),
        )
      }, this.#config.timeoutMs)
      socket.on('data', (chunk) => this.#onData(chunk))
      socket.on('error', (error) => this.#fail(socketFailure(error, this.#config)))
      socket.on('close', () => {
        if (this.#closed) return
        this.#fail(
          new DataError(
            'redis_unreachable',
            `the connection to Redis at ${this.#config.host}:${this.#config.port} closed before the reply arrived`,
            this.#endpoint(),
          ),
        )
      })
      socket.once(this.#config.tls ? 'secureConnect' : 'connect', () => this.#settleConnect(null))
    })
  }

  /**
   * Resolve or reject the pending `connect()` promise.
   *
   * @param {DataError|null} error - the failure, or `null` on success.
   * @returns {void}
   */
  #settleConnect(error) {
    if (this.#connectSettled) return
    this.#connectSettled = true
    if (this.#connectTimer !== null) clearTimeout(this.#connectTimer)
    this.#connectTimer = null
    const resolve = this.#connectResolve
    const reject = this.#connectReject
    this.#connectResolve = null
    this.#connectReject = null
    if (error === null) {
      if (resolve !== null) resolve()
    } else if (reject !== null) {
      reject(error)
    }
  }

  /**
   * Fail every waiting command, remember the first failure, and drop the socket.
   *
   * @param {DataError} error - the failure to report.
   * @returns {void}
   */
  #fail(error) {
    if (this.#failure === null) this.#failure = error
    if (!this.#connectSettled) this.#settleConnect(error)
    const pending = this.#pending.splice(0)
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    const socket = this.#socket
    if (socket !== null && !socket.destroyed) socket.destroy()
  }

  /**
   * Feed one TCP chunk into the parser and settle the matching commands.
   *
   * @param {Buffer} chunk - the received bytes.
   * @returns {void}
   */
  #onData(chunk) {
    let replies
    try {
      this.#parser.feed(chunk)
      replies = this.#parser.take()
    } catch (error) {
      const failure =
        error instanceof DataError
          ? error
          : new DataError('redis_command_failed', `could not parse the Redis reply: ${describeError(error)}`, {
              reply: describeError(error),
            })
      this.#fail(failure)
      return
    }
    for (const reply of replies) {
      const entry = this.#pending.shift()
      if (entry === undefined) continue
      clearTimeout(entry.timer)
      if (reply instanceof ReplyError) entry.reject(mapReplyError(reply, entry.name))
      else entry.resolve(reply)
    }
  }
}

/**
 * Validate and normalize a connection object.
 *
 * @param {unknown} connection - the caller's connection.
 * @returns {{ host: string, port: number, username: string, password: string, db: number, tls: boolean, timeoutMs: number }} the config.
 */
function normalizeConnection(connection) {
  if (connection === null || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new DataError('redis_invalid_connection', 'the Redis connection must be an object', {
      field: 'connection',
    })
  }
  const source = /** @type {Record<string, unknown>} */ (connection)
  const host = typeof source.host === 'string' ? source.host.trim() : ''
  if (host === '') {
    throw new DataError('redis_invalid_connection', 'the Redis connection needs a non-empty host', {
      field: 'connection.host',
    })
  }
  const port = typeof source.port === 'string' ? Number(source.port) : source.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DataError('redis_invalid_connection', 'the Redis connection needs an integer port between 1 and 65535', {
      field: 'connection.port',
    })
  }
  const username = typeof source.username === 'string' ? source.username : ''
  const password = typeof source.password === 'string' ? source.password : ''
  const rawDb = source.db === undefined || source.db === null ? 0 : source.db
  const db = typeof rawDb === 'string' ? Number(rawDb) : rawDb
  if (typeof db !== 'number' || !Number.isInteger(db) || db < 0 || db > 255) {
    throw new DataError('redis_invalid_connection', 'the Redis connection needs an integer db between 0 and 255', {
      field: 'connection.db',
    })
  }
  const rawTimeout = source.timeoutMs === undefined || source.timeoutMs === null ? DEFAULT_TIMEOUT_MS : source.timeoutMs
  const timeoutMs = typeof rawTimeout === 'string' ? Number(rawTimeout) : rawTimeout
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new DataError(
      'redis_invalid_connection',
      `the Redis connection needs an integer timeoutMs between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      { field: 'connection.timeoutMs', min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS },
    )
  }
  return Object.freeze({
    host,
    port,
    username,
    password,
    db,
    tls: source.tls === true,
    timeoutMs,
  })
}

/**
 * Validate a key before a connection is even attempted.
 *
 * @param {unknown} key - the caller's key.
 * @returns {string} the key.
 */
function requireKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new DataError('redis_invalid_key', 'a Redis key must be a non-empty string', { field: 'key' })
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new DataError('redis_invalid_key', `a Redis key must be at most ${MAX_KEY_BYTES} bytes`, {
      field: 'key',
      limit: MAX_KEY_BYTES,
    })
  }
  return key
}

/**
 * Convert a PTTL reply (milliseconds) into the contract's seconds.
 *
 * @param {unknown} pttl - the PTTL reply.
 * @returns {number} seconds; `-1` no expiry, `-2` missing key.
 */
function toTtlSeconds(pttl) {
  if (pttl === -1) return -1
  if (pttl === -2) return -2
  if (typeof pttl !== 'number' || !Number.isFinite(pttl) || pttl < 0) return -2
  return Math.max(0, Math.ceil(pttl / 1000))
}

/* --------------------------------------------------- v0.3 argument helpers */

/**
 * @param {string} field - the argument name shown to the caller.
 * @param {string} message - one human-readable line.
 * @returns {DataError} a `redis_invalid_argument` failure with `details.field`.
 */
function invalidArgument(field, message) {
  return new DataError('redis_invalid_argument', message, { field })
}

/**
 * Validate a key, new-key, field or member argument.
 *
 * @param {unknown} value - the caller's value.
 * @param {string} field - the argument name for the error.
 * @returns {string} the non-empty string, at most 512 characters.
 */
function requireArgumentKey(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw invalidArgument(field, `"${field}" must be a non-empty string`)
  }
  if (value.length > MAX_ARGUMENT_KEY_CHARS) {
    throw invalidArgument(field, `"${field}" must be at most ${MAX_ARGUMENT_KEY_CHARS} characters`)
  }
  return value
}

/**
 * Validate a written value (`HSET` field value, `LPUSH`/`RPUSH` element).
 * Empty strings are valid Redis data; only the size is bounded.
 *
 * @param {unknown} value - the caller's value.
 * @param {string} field - the argument name for the error.
 * @returns {string} the text to send, at most 1 MiB of UTF-8.
 */
function requireArgumentText(value, field) {
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = String(value)
  else throw invalidArgument(field, `"${field}" must be a string`)
  if (Buffer.byteLength(text, 'utf8') > MAX_ARGUMENT_VALUE_BYTES) {
    throw invalidArgument(field, `"${field}" must be at most 1 MiB`)
  }
  return text
}

/**
 * Validate an expiry, which must be a whole number of seconds in 1..31536000.
 *
 * @param {unknown} value - the caller's value.
 * @returns {number} the validated TTL in seconds.
 */
function requireTtlSeconds(value) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_TTL_SECONDS) {
    throw invalidArgument('ttlSeconds', `"ttlSeconds" must be an integer between 1 and ${MAX_TTL_SECONDS}`)
  }
  return numeric
}

/**
 * Validate a list insertion side.
 *
 * @param {unknown} value - the caller's value.
 * @returns {'left'|'right'} the validated side.
 */
function requireSide(value) {
  if (value !== 'left' && value !== 'right') throw invalidArgument('side', '"side" must be "left" or "right"')
  return value
}

/**
 * @param {unknown} reply - a reply used in an error detail.
 * @returns {string} a printable version of the reply.
 */
function replyText(reply) {
  if (typeof reply === 'string') return reply
  return JSON.stringify(reply) ?? String(reply)
}

/**
 * Require an integer reply from a command that always returns one.
 *
 * @param {unknown} reply - the decoded reply.
 * @param {string} commandName - command name used in the error.
 * @returns {number} the integer.
 */
function expectedInteger(reply, commandName) {
  if (typeof reply === 'number' && Number.isFinite(reply)) return reply
  throw new DataError('redis_command_failed', `the Redis server returned an unexpected ${commandName} reply`, {
    reply: replyText(reply),
  })
}

/**
 * Format a byte count the way Redis formats `used_memory_human`.
 *
 * @param {number} bytes - a non-negative byte count.
 * @returns {string} e.g. "512B", "1.21K", "1.00M".
 */
function formatByteSize(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)}B`
  const units = ['K', 'M', 'G', 'T']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(2)}${units[unit]}`
}

/**
 * @param {string|undefined} value - a numeric field from CLIENT LIST.
 * @returns {number|null} the integer, or `null` when absent/not numeric.
 */
function integerOrNull(value) {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

/**
 * Parse one `CLIENT LIST` line (`key=value` pairs separated by spaces).
 *
 * @param {string} line - one client line.
 * @returns {Record<string, string>} the fields.
 */
function parseClientFields(line) {
  /** @type {Record<string, string>} */
  const fields = {}
  const pattern = /([A-Za-z0-9_-]+)=([^\s]*)/gu
  let match = pattern.exec(line)
  while (match !== null) {
    fields[match[1]] = match[2]
    match = pattern.exec(line)
  }
  return fields
}

/**
 * @param {unknown} reply - a reply that should be an array of strings.
 * @returns {string[]} the string elements; non-arrays and non-strings are dropped.
 */
function asStringArray(reply) {
  if (!Array.isArray(reply)) return []
  const out = []
  for (const item of reply) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

/**
 * Parse an INFO reply into `section -> field -> value`.
 *
 * @param {string} text - the raw INFO text.
 * @returns {Record<string, Record<string, string>>} the sections.
 */
function parseInfo(text) {
  /** @type {Record<string, Record<string, string>>} */
  const sections = {}
  let current = 'Default'
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    if (line.startsWith('#')) {
      current = line.slice(1).trim() || 'Default'
      if (sections[current] === undefined) sections[current] = {}
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (sections[current] === undefined) sections[current] = {}
    sections[current][line.slice(0, colon)] = line.slice(colon + 1)
  }
  return sections
}

/**
 * Build the panel summary out of parsed INFO sections.
 *
 * `hitRate` is a percentage (0–100, two decimals); it is `null` when the server
 * has served no lookups yet.
 *
 * @param {Record<string, Record<string, string>>} sections - parsed INFO.
 * @returns {{ version: string|null, uptimeSeconds: number|null, connectedClients: number|null, usedMemoryHuman: string|null, usedMemoryBytes: number|null, totalKeys: number, opsPerSec: number|null, hitRate: number|null, role: string|null }} the summary.
 */
function summarizeInfo(sections) {
  /**
   * @param {string} section - section name.
   * @param {string} field - field name.
   * @returns {string|null} the raw value.
   */
  const read = (section, field) => {
    const values = sections[section]
    if (values === undefined) return null
    const value = values[field]
    return typeof value === 'string' ? value : null
  }
  /**
   * @param {string|null} value - raw INFO value.
   * @returns {number|null} the number, or `null`.
   */
  const numeric = (value) => {
    if (value === null || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const hits = numeric(read('Stats', 'keyspace_hits'))
  const misses = numeric(read('Stats', 'keyspace_misses'))
  const lookups = hits !== null && misses !== null ? hits + misses : null

  let totalKeys = 0
  const keyspace = sections.Keyspace
  if (keyspace !== undefined) {
    for (const entry of Object.values(keyspace)) {
      const match = /(?:^|,)keys=(\d+)/u.exec(entry)
      if (match !== null) totalKeys += Number(match[1])
    }
  }

  return {
    version: read('Server', 'redis_version'),
    uptimeSeconds: numeric(read('Server', 'uptime_in_seconds')),
    connectedClients: numeric(read('Clients', 'connected_clients')),
    usedMemoryHuman: read('Memory', 'used_memory_human'),
    usedMemoryBytes: numeric(read('Memory', 'used_memory')),
    totalKeys,
    opsPerSec: numeric(read('Stats', 'instantaneous_ops_per_sec')),
    hitRate: lookups !== null && lookups > 0 && hits !== null ? Math.round((hits / lookups) * 10000) / 100 : null,
    role: read('Replication', 'role'),
  }
}

/**
 * Read one typed value. `present: false` means the key vanished between TYPE/PTTL
 * and the read (Redis cannot store empty list/set/zset/hash, so an empty reply
 * means "gone"; a stream may legitimately be empty).
 *
 * @param {RedisClient} client - the connected client.
 * @param {string} type - the TYPE reply.
 * @param {string} key - the key.
 * @returns {Promise<{ present: boolean, value: unknown }>} the value.
 */
async function readTypedValue(client, type, key) {
  switch (type) {
    case 'string': {
      const reply = await client.command(['GET', key])
      if (reply === null) return { present: false, value: null }
      return { present: true, value: typeof reply === 'string' ? reply : String(reply) }
    }
    case 'list': {
      const items = asStringArray(await client.command(['LRANGE', key, '0', '-1']))
      return items.length === 0 ? { present: false, value: null } : { present: true, value: items }
    }
    case 'set': {
      const items = asStringArray(await client.command(['SMEMBERS', key]))
      return items.length === 0 ? { present: false, value: null } : { present: true, value: items }
    }
    case 'zset': {
      const flat = asStringArray(await client.command(['ZRANGE', key, '0', '-1', 'WITHSCORES']))
      const value = []
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const score = Number(flat[index + 1])
        value.push({ member: flat[index], score: Number.isFinite(score) ? score : flat[index + 1] })
      }
      return value.length === 0 ? { present: false, value: null } : { present: true, value }
    }
    case 'hash': {
      const flat = asStringArray(await client.command(['HGETALL', key]))
      const pairs = []
      for (let index = 0; index + 1 < flat.length; index += 2) pairs.push([flat[index], flat[index + 1]])
      return pairs.length === 0 ? { present: false, value: null } : { present: true, value: Object.fromEntries(pairs) }
    }
    case 'stream': {
      const raw = await client.command(['XRANGE', key, '-', '+', 'COUNT', '50'])
      const value = []
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!Array.isArray(entry) || entry.length < 2) continue
          const id = typeof entry[0] === 'string' ? entry[0] : String(entry[0])
          const fields = asStringArray(entry[1])
          /** @type {Record<string, string>} */
          const object = {}
          for (let index = 0; index + 1 < fields.length; index += 2) object[fields[index]] = fields[index + 1]
          value.push({ id, fields: object })
        }
      }
      return { present: true, value }
    }
    default:
      // A newer/extension type this panel does not decode yet: report the type.
      return { present: true, value: null }
  }
}

/* ------------------------------------------------------------- public API */

/**
 * Connect to Redis, run the callback with a command client, and always close.
 *
 * AUTH is sent only when a password is configured (`AUTH user pass` when a
 * username is set); SELECT runs only when `db` is greater than 0.
 *
 * @param {RedisConnection} connection - where and how to connect.
 * @param {(client: RedisClient) => Promise<*>} run - callback using `client.command`.
 * @returns {Promise<*>} whatever `run` resolves to.
 */
export async function withRedis(connection, run) {
  if (typeof run !== 'function') throw new TypeError('withRedis(connection, run) needs a callback function')
  const config = normalizeConnection(connection)
  const client = new RedisClient(config)
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

/**
 * Round-trip check: PING latency plus the server version (best effort).
 *
 * @param {RedisConnection} connection - the connection.
 * @returns {Promise<{ pong: true, latencyMs: number, version: string|null }>} the ping result.
 */
export async function redisPing(connection) {
  return withRedis(connection, async (client) => {
    let version = null
    try {
      const info = await client.command(['INFO', 'server'])
      if (typeof info === 'string') {
        const sections = parseInfo(info)
        const server = sections.Server
        if (server !== undefined && typeof server.redis_version === 'string') version = server.redis_version
      }
    } catch (error) {
      // INFO can be denied by ACLs; PING is the actual health check.
      if (!(error instanceof DataError) || error.code !== 'redis_command_failed') throw error
    }
    const startedAt = process.hrtime.bigint()
    const reply = await client.command(['PING'])
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    if (reply !== 'PONG') {
      throw new DataError('redis_command_failed', 'the Redis server did not answer PING with PONG', {
        reply: typeof reply === 'string' ? reply : JSON.stringify(reply) ?? String(reply),
      })
    }
    return { pong: true, latencyMs: Math.round(elapsedMs * 1000) / 1000, version }
  })
}

/**
 * Read INFO and split it into the panel summary plus the raw sections.
 *
 * @param {RedisConnection} connection - the connection.
 * @returns {Promise<{ summary: object, sections: Record<string, Record<string, string>> }>} the info.
 */
export async function redisInfo(connection) {
  return withRedis(connection, async (client) => {
    const reply = await client.command(['INFO'])
    if (typeof reply !== 'string') {
      throw new DataError('redis_command_failed', 'the Redis server returned no INFO text', {
        reply: typeof reply === 'string' ? reply : JSON.stringify(reply) ?? String(reply),
      })
    }
    const sections = parseInfo(reply)
    return { summary: summarizeInfo(sections), sections }
  })
}

/**
 * One SCAN page.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {{ cursor?: string|number, match?: string, count?: number, type?: string }} [options] - scan options.
 * @returns {Promise<{ cursor: string, keys: string[], done: boolean }>} the page.
 */
export async function redisScan(connection, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const start = source.cursor === undefined || source.cursor === null || source.cursor === '' ? '0' : String(source.cursor)
  const pattern = typeof source.match === 'string' && source.match !== '' ? source.match : '*'
  const count = Number.isInteger(source.count) && source.count > 0 ? Math.min(source.count, 10000) : 100
  const type = typeof source.type === 'string' ? source.type.trim() : ''
  return withRedis(connection, async (client) => {
    const args = ['SCAN', start, 'MATCH', pattern, 'COUNT', String(count)]
    if (type !== '') args.push('TYPE', type)
    const reply = await client.command(args)
    if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) {
      throw new DataError('redis_command_failed', 'the Redis server returned an unexpected SCAN reply', {
        reply: JSON.stringify(reply) ?? 'null',
      })
    }
    const next = typeof reply[0] === 'string' ? reply[0] : String(reply[0])
    return { cursor: next, keys: reply[1].filter((key) => typeof key === 'string'), done: next === '0' }
  })
}

/**
 * Read one key with its type, TTL (seconds) and a type-appropriate value.
 *
 * Value shape by type: string → string; list/set → string[]; zset →
 * `{member, score}[]`; hash → `Record<string,string>`; stream →
 * `{id, fields}[]` (first 50 entries); none → `null`.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {string} key - the key.
 * @returns {Promise<{ key: string, type: string, ttl: number, value: unknown }>} the entry.
 */
export async function redisGet(connection, key) {
  const name = requireKey(key)
  return withRedis(connection, async (client) => {
    const typeReply = await client.command(['TYPE', name])
    const type = typeof typeReply === 'string' ? typeReply : 'none'
    if (type === 'none') return { key: name, type: 'none', ttl: -2, value: null }
    const pttl = await client.command(['PTTL', name])
    if (pttl === -2) return { key: name, type: 'none', ttl: -2, value: null }
    const ttl = toTtlSeconds(pttl)
    const read = await readTypedValue(client, type, name)
    if (!read.present) return { key: name, type: 'none', ttl: -2, value: null }
    return { key: name, type, ttl, value: read.value }
  })
}

/**
 * Write a string value, optionally with an expiry.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {{ key: string, value: string, ttlSeconds?: number }} options - the write.
 * @returns {Promise<{ key: string, ttl: number }>} the key and its resulting TTL.
 */
export async function redisSet(connection, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const name = requireKey(source.key)
  const text =
    source.value === null || source.value === undefined
      ? ''
      : typeof source.value === 'string'
        ? source.value
        : String(source.value)
  let ttlSeconds = 0
  if (source.ttlSeconds !== undefined && source.ttlSeconds !== null && source.ttlSeconds !== '') {
    const numeric = typeof source.ttlSeconds === 'number' ? source.ttlSeconds : Number(source.ttlSeconds)
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_TTL_SECONDS) {
      throw new TypeError(`ttlSeconds must be an integer between 0 and ${MAX_TTL_SECONDS}`)
    }
    ttlSeconds = numeric
  }
  return withRedis(connection, async (client) => {
    const args = ['SET', name, text]
    if (ttlSeconds > 0) args.push('EX', String(ttlSeconds))
    const reply = await client.command(args)
    if (reply !== 'OK') {
      throw new DataError('redis_command_failed', 'the Redis server did not confirm SET', {
        reply: typeof reply === 'string' ? reply : JSON.stringify(reply) ?? String(reply),
      })
    }
    const pttl = await client.command(['PTTL', name])
    return { key: name, ttl: toTtlSeconds(pttl) }
  })
}

/**
 * Delete one key.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {string} key - the key.
 * @returns {Promise<{ key: string, deleted: number }>} the key and DEL's count.
 */
export async function redisDelete(connection, key) {
  const name = requireKey(key)
  return withRedis(connection, async (client) => {
    const reply = await client.command(['DEL', name])
    return { key: name, deleted: typeof reply === 'number' && Number.isFinite(reply) ? reply : 0 }
  })
}

/* ------------------------------------------------- v0.3 server & key edits */

/**
 * List the server's connected clients (`CLIENT LIST`).
 *
 * @param {RedisConnection} connection - the connection.
 * @returns {Promise<{ clients: { id: number, addr: string, name: string, ageSeconds: number|null, idleSeconds: number|null, db: number|null, command: string|null, user: string|null }[], count: number }>} the clients.
 */
export async function redisClients(connection) {
  return withRedis(connection, async (client) => {
    const reply = await client.command(['CLIENT', 'LIST'])
    if (typeof reply !== 'string') {
      throw new DataError('redis_command_failed', 'the Redis server returned no CLIENT LIST text', {
        reply: replyText(reply),
      })
    }
    const clients = []
    for (const rawLine of reply.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.trim() === '') continue
      const fields = parseClientFields(line)
      const id = integerOrNull(fields.id)
      if (id === null) continue
      clients.push({
        id,
        addr: typeof fields.addr === 'string' ? fields.addr : '',
        name: typeof fields.name === 'string' ? fields.name : '',
        ageSeconds: integerOrNull(fields.age),
        idleSeconds: integerOrNull(fields.idle),
        db: integerOrNull(fields.db),
        command: typeof fields.cmd === 'string' && fields.cmd !== '' ? fields.cmd : null,
        user: typeof fields.user === 'string' && fields.user !== '' ? fields.user : null,
      })
    }
    return { clients, count: clients.length }
  })
}

/**
 * Count the keys in the selected database (`DBSIZE`).
 *
 * @param {RedisConnection} connection - the connection.
 * @returns {Promise<{ keys: number }>} the key count.
 */
export async function redisDbSize(connection) {
  return withRedis(connection, async (client) => {
    return { keys: expectedInteger(await client.command(['DBSIZE']), 'DBSIZE') }
  })
}

/**
 * Measure one key (`MEMORY USAGE`).
 *
 * @param {RedisConnection} connection - the connection.
 * @param {string} key - the key.
 * @returns {Promise<{ key: string, bytes: number|null, human: string|null }>} the usage; both metrics are `null` for a missing key.
 */
export async function redisMemoryUsage(connection, key) {
  const name = requireArgumentKey(key, 'key')
  return withRedis(connection, async (client) => {
    const reply = await client.command(['MEMORY', 'USAGE', name])
    if (reply === null) return { key: name, bytes: null, human: null }
    const bytes = expectedInteger(reply, 'MEMORY USAGE')
    return { key: name, bytes, human: formatByteSize(bytes) }
  })
}

/**
 * Rename a key (`RENAME`); a missing source reply becomes `redis_command_failed`.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {string} key - the current key.
 * @param {string} newKey - the destination key.
 * @returns {Promise<{ key: string, newKey: string, renamed: true }>} the confirmation.
 */
export async function redisRename(connection, key, newKey) {
  const name = requireArgumentKey(key, 'key')
  const target = requireArgumentKey(newKey, 'newKey')
  return withRedis(connection, async (client) => {
    const reply = await client.command(['RENAME', name, target])
    if (reply !== 'OK') {
      throw new DataError('redis_command_failed', 'the Redis server did not confirm RENAME', { reply: replyText(reply) })
    }
    return { key: name, newKey: target, renamed: true }
  })
}

/**
 * Set a key's expiry (`EXPIRE`).
 *
 * @param {RedisConnection} connection - the connection.
 * @param {string} key - the key.
 * @param {number} ttlSeconds - a whole number of seconds in 1..31536000.
 * @returns {Promise<{ key: string, ttl: number }>} the resulting TTL in seconds; `-2` when the key does not exist.
 */
export async function redisExpire(connection, key, ttlSeconds) {
  const name = requireArgumentKey(key, 'key')
  const ttl = requireTtlSeconds(ttlSeconds)
  return withRedis(connection, async (client) => {
    const applied = expectedInteger(await client.command(['EXPIRE', name, String(ttl)]), 'EXPIRE')
    if (applied !== 1) return { key: name, ttl: -2 }
    return { key: name, ttl: toTtlSeconds(await client.command(['PTTL', name])) }
  })
}

/**
 * Remove a key's expiry (`PERSIST`).
 *
 * @param {RedisConnection} connection - the connection.
 * @param {string} key - the key.
 * @returns {Promise<{ key: string, ttl: -1 }>} the key and the contract's "no expiry" TTL.
 */
export async function redisPersist(connection, key) {
  const name = requireArgumentKey(key, 'key')
  return withRedis(connection, async (client) => {
    expectedInteger(await client.command(['PERSIST', name]), 'PERSIST')
    return { key: name, ttl: -1 }
  })
}

/**
 * Set one hash field (`HSET`) and report the hash's field count.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {{ key: string, field: string, value: string }} options - the write.
 * @returns {Promise<{ key: string, field: string, fieldCount: number }>} the confirmation.
 */
export async function redisHashSet(connection, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const key = requireArgumentKey(source.key, 'key')
  const field = requireArgumentKey(source.field, 'field')
  const value = requireArgumentText(source.value, 'value')
  return withRedis(connection, async (client) => {
    expectedInteger(await client.command(['HSET', key, field, value]), 'HSET')
    const fieldCount = expectedInteger(await client.command(['HLEN', key]), 'HLEN')
    return { key, field, fieldCount }
  })
}

/**
 * Push one element onto a list (`LPUSH` or `RPUSH`) and report the length.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {{ key: string, value: string, side: 'left'|'right' }} options - the write.
 * @returns {Promise<{ key: string, length: number }>} the confirmation.
 */
export async function redisListPush(connection, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const key = requireArgumentKey(source.key, 'key')
  const value = requireArgumentText(source.value, 'value')
  const side = requireSide(source.side)
  const command = side === 'left' ? 'LPUSH' : 'RPUSH'
  return withRedis(connection, async (client) => {
    expectedInteger(await client.command([command, key, value]), command)
    const length = expectedInteger(await client.command(['LLEN', key]), 'LLEN')
    return { key, length }
  })
}

/**
 * Add one member to a set (`SADD`) and report the cardinality.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {{ key: string, member: string }} options - the write.
 * @returns {Promise<{ key: string, length: number }>} the confirmation.
 */
export async function redisSetAdd(connection, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const key = requireArgumentKey(source.key, 'key')
  const member = requireArgumentKey(source.member, 'member')
  return withRedis(connection, async (client) => {
    expectedInteger(await client.command(['SADD', key, member]), 'SADD')
    const length = expectedInteger(await client.command(['SCARD', key]), 'SCARD')
    return { key, length }
  })
}

/**
 * Remove one member from a set (`SREM`) and report what happened.
 *
 * @param {RedisConnection} connection - the connection.
 * @param {{ key: string, member: string }} options - the write.
 * @returns {Promise<{ key: string, length: number, removed: 0|1 }>} the cardinality and whether the member existed.
 */
export async function redisSetRemove(connection, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const key = requireArgumentKey(source.key, 'key')
  const member = requireArgumentKey(source.member, 'member')
  return withRedis(connection, async (client) => {
    const removed = expectedInteger(await client.command(['SREM', key, member]), 'SREM')
    const length = expectedInteger(await client.command(['SCARD', key]), 'SCARD')
    return { key, length, removed: removed === 0 ? 0 : 1 }
  })
}

export default {
  encodeCommand,
  RespParser,
  withRedis,
  redisPing,
  redisInfo,
  redisScan,
  redisGet,
  redisSet,
  redisDelete,
  redisClients,
  redisDbSize,
  redisMemoryUsage,
  redisRename,
  redisExpire,
  redisPersist,
  redisHashSet,
  redisListPush,
  redisSetAdd,
  redisSetRemove,
}
