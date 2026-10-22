/**
 * PostgreSQL half of dsh-long-data: a dependency-free wire-protocol v3 client.
 *
 * The panel inspects one PostgreSQL server from the Host, and the Host must not
 * pull a driver into the bundle: this module speaks the v3 frontend/backend
 * protocol directly over `node:net` (upgraded with `node:tls` when SSL is
 * requested). It implements exactly the subset the panel uses — startup,
 * AuthenticationOk / cleartext / MD5 / SCRAM-SHA-256, parameter status, the
 * simple Query protocol with multiple result sets, and text-format rows — plus
 * the guardrails a panel needs: a row cap, a byte cap, a hard timeout, and the
 * drain-to-ReadyForQuery rule that keeps a truncated result from leaving the
 * session in a corrupt state.
 *
 * Failures are `DataError`s with the stable codes the ops envelope documents,
 * so the browser renders an honest message instead of a stack trace. The client
 * never retries by itself and never mutates the server: every statement it
 * builds is a `SELECT` over the catalog, so browsing a database is safe.
 *
 * @module dsh-long-data/src/postgres
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { connect as netConnect, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

import { DataError } from './errors.js'

/** Default per-operation timeout, matching the panel's settings default. */
export const DEFAULT_TIMEOUT_MS = 8000

/** Default display row cap for `pgQuery`. */
export const DEFAULT_MAX_ROWS = 500

/** Default display byte cap for `pgQuery` (2 MiB). */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** Catalog listings may legitimately exceed the query display cap. */
const METADATA_MAX_ROWS = 20000
const METADATA_MAX_BYTES = 8 * 1024 * 1024

/** Startup protocol version 3.0: major 3 in the high 16 bits. */
const PROTOCOL_VERSION = 196608

/** Magic code a client sends to ask for TLS before the startup message. */
const SSL_REQUEST_CODE = 80877103

/** No single protocol message may be larger than this; protects the buffer. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** After the byte cap is hit, drain at most this extra payload before closing. */
const DRAIN_LIMIT_BYTES = 64 * 1024 * 1024

const EMPTY_BUFFER = Buffer.alloc(0)

const TABLE_KINDS = new Set(['table', 'view', 'materialized view', 'foreign table'])

/**
 * OID -> human type name for the text-format columns the simple protocol
 * returns. Unknown types stay addressable as `oid:<n>` rather than being
 * silently mislabelled.
 */
const TYPE_OIDS = Object.freeze({
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  27: 'tid',
  28: 'xid',
  29: 'cid',
  114: 'json',
  142: 'xml',
  199: 'json[]',
  600: 'point',
  601: 'lseg',
  602: 'path',
  603: 'box',
  604: 'polygon',
  628: 'line',
  650: 'cidr',
  700: 'float4',
  701: 'float8',
  705: 'unknown',
  718: 'circle',
  790: 'money',
  829: 'macaddr',
  869: 'inet',
  1000: 'bool[]',
  1001: 'bytea[]',
  1005: 'int2[]',
  1007: 'int4[]',
  1009: 'text[]',
  1014: 'char[]',
  1015: 'varchar[]',
  1016: 'int8[]',
  1021: 'float4[]',
  1022: 'float8[]',
  1033: 'macaddr[]',
  1034: 'aclitem[]',
  1041: 'inet[]',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1115: 'timestamp[]',
  1182: 'date[]',
  1183: 'time[]',
  1184: 'timestamptz',
  1185: 'timestamptz[]',
  1186: 'interval',
  1231: 'numeric[]',
  1266: 'timetz',
  1270: 'timetz[]',
  1560: 'bit',
  1562: 'varbit',
  1700: 'numeric',
  1790: 'refcursor',
  2202: 'regprocedure',
  2203: 'regoper',
  2204: 'regoperator',
  2205: 'regclass',
  2206: 'regtype',
  2249: 'record',
  2275: 'cstring',
  2950: 'uuid',
  2951: 'uuid[]',
  3220: 'pg_lsn',
  3614: 'tsvector',
  3615: 'tsquery',
  3802: 'jsonb',
  3807: 'jsonb[]',
  3904: 'int4range',
  3906: 'numrange',
  3908: 'tsrange',
  3910: 'tstzrange',
  3912: 'daterange',
  3926: 'int8range',
})

/* ------------------------------------------------------------------ */
/* Small buffer helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {number} value - a signed 16-bit integer.
 * @returns {Buffer} big-endian int16.
 */
function int16(value) {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeInt16BE(value, 0)
  return buffer
}

/**
 * @param {number} value - a signed 32-bit integer.
 * @returns {Buffer} big-endian int32.
 */
function int32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeInt32BE(value, 0)
  return buffer
}

/**
 * @param {string} value - the text.
 * @returns {Buffer} the text plus a terminating NUL, as the protocol wants.
 */
function cstring(value) {
  return Buffer.from(`${value}\0`, 'utf8')
}

/**
 * Frame a typed frontend message: one type byte, int32 length, payload.
 *
 * @param {string} type - single-byte message type, e.g. `'Q'`.
 * @param {Buffer} payload - message body.
 * @returns {Buffer} the framed message.
 */
function frameMessage(type, payload) {
  const frame = Buffer.allocUnsafe(5 + payload.length)
  frame[0] = type.charCodeAt(0)
  frame.writeInt32BE(payload.length + 4, 1)
  payload.copy(frame, 5)
  return frame
}

/**
 * Split a payload of NUL-terminated strings into an array.
 *
 * @param {Buffer} payload - the cstring list.
 * @param {number} [start] - byte offset to start at.
 * @returns {string[]} the strings, in order.
 */
function splitCStrings(payload, start = 0) {
  const values = []
  let offset = start
  while (offset < payload.length) {
    const end = payload.indexOf(0, offset)
    if (end === -1) break
    values.push(payload.toString('utf8', offset, end))
    offset = end + 1
  }
  return values
}

/**
 * Read the first NUL-terminated string of a payload.
 *
 * @param {Buffer} payload - the message body.
 * @returns {string} the string before the first NUL.
 */
function firstCString(payload) {
  const end = payload.indexOf(0)
  return payload.toString('utf8', 0, end === -1 ? payload.length : end)
}

/* ------------------------------------------------------------------ */
/* Protocol message builders (pure, unit-tested)                       */
/* ------------------------------------------------------------------ */

/**
 * Build the untyped StartupMessage that opens a v3 session.
 *
 * @param {{ user: string, database: string, applicationName?: string }} options - startup parameters.
 * @returns {Buffer} the complete startup message.
 */
export function buildStartupMessage({ user, database, applicationName = 'dsh-long-data' }) {
  const parameters = [
    ['user', user],
    ['database', database],
    ['client_encoding', 'UTF8'],
    ['application_name', applicationName],
  ]
  const parts = [int32(PROTOCOL_VERSION)]
  for (const [key, value] of parameters) parts.push(Buffer.from(`${key}\0${value}\0`, 'utf8'))
  parts.push(Buffer.from([0]))
  const body = Buffer.concat(parts)
  return Buffer.concat([int32(body.length + 4), body])
}

/**
 * Build the SSLRequest message: the server answers with one byte, `S` or `N`.
 *
 * @returns {Buffer} the 8-byte request.
 */
export function buildSslRequest() {
  return Buffer.concat([int32(8), int32(SSL_REQUEST_CODE)])
}

/**
 * Build a Parse message for one parameterized statement.
 *
 * Zero parameter type OIDs are sent so the server infers `$n` types from the
 * query context; values are later bound in text format.
 *
 * @param {string} sql - one statement using `$1`-style placeholders.
 * @returns {Buffer} the framed Parse message.
 */
function buildParseMessage(sql) {
  return frameMessage('P', Buffer.concat([Buffer.from([0]), cstring(sql), int16(0)]))
}

/**
 * Build a Bind message that supplies every `$n` value in text format.
 *
 * @param {(string|null)[]} parameters - text values; `null` binds SQL NULL.
 * @returns {Buffer} the framed Bind message.
 */
function buildBindMessage(parameters) {
  const parts = [
    Buffer.from([0]), // unnamed portal
    Buffer.from([0]), // unnamed prepared statement
    int16(0), // all parameter formats are text
    int16(parameters.length),
  ]
  for (const parameter of parameters) {
    if (parameter === null) {
      parts.push(int32(-1))
      continue
    }
    const bytes = Buffer.from(parameter, 'utf8')
    parts.push(int32(bytes.length), bytes)
  }
  parts.push(int16(0)) // all result columns in text format
  return frameMessage('B', Buffer.concat(parts))
}

/**
 * @returns {Buffer} a Describe message for the unnamed portal.
 */
function buildDescribePortalMessage() {
  return frameMessage('D', Buffer.concat([Buffer.from([0x50]), Buffer.from([0])]))
}

/**
 * @returns {Buffer} an Execute message running the unnamed portal to completion.
 */
function buildExecuteMessage() {
  return frameMessage('E', Buffer.concat([Buffer.from([0]), int32(0)]))
}

/**
 * @returns {Buffer} a Sync message closing the extended-protocol exchange.
 */
function buildSyncMessage() {
  return frameMessage('S', EMPTY_BUFFER)
}

/**
 * Parse an ErrorResponse / NoticeResponse payload into its letter-coded fields.
 *
 * @param {Buffer} payload - the message body.
 * @returns {Record<string, string>} fields keyed by their protocol letter
 *   (`S` severity, `C` sqlState, `M` message, `D` detail, `H` hint, `P` position, …).
 */
export function parseErrorFields(payload) {
  /** @type {Record<string, string>} */
  const fields = {}
  let offset = 0
  while (offset < payload.length) {
    const code = payload[offset]
    if (code === 0) break
    const end = payload.indexOf(0, offset + 1)
    if (end === -1) break
    fields[String.fromCharCode(code)] = payload.toString('utf8', offset + 1, end)
    offset = end + 1
  }
  return fields
}

/**
 * Shape server error fields into the `details` document `pg_query_failed` carries.
 *
 * @param {Record<string, string>} fields - parsed ErrorResponse fields.
 * @returns {{ sqlState: string|null, detail: string|null, hint: string|null, position: number|null }} the details.
 */
function errorDetails(fields) {
  const position = fields.P !== undefined && /^\d+$/.test(fields.P) ? Number(fields.P) : null
  return {
    sqlState: fields.C ?? null,
    detail: fields.D ?? null,
    hint: fields.H ?? null,
    position,
  }
}

/**
 * Build a PostgreSQL string literal that is safe for any session configuration.
 *
 * The `E'…'` form is used so backslashes are unambiguous regardless of the
 * server's `standard_conforming_strings` setting; single quotes are doubled.
 *
 * @param {string} value - the literal text.
 * @returns {string} SQL text, e.g. `E'public'`.
 */
export function quoteLiteral(value) {
  const text = String(value)
  if (text.includes('\0')) {
    throw new DataError('invalid_payload', 'a SQL literal must not contain a NUL byte', { field: 'literal' })
  }
  return `E'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/**
 * Quote one SQL identifier, doubling embedded double quotes.
 *
 * Browsing user tables means the table and column names cannot be protocol
 * parameters (the protocol binds values, never identifiers), so they are
 * quoted here instead of being interpolated raw text.
 *
 * @param {string} name - an identifier.
 * @returns {string} the quoted identifier, e.g. `"my table"`.
 */
export function quoteIdentifier(name) {
  const text = String(name)
  if (text === '' || text.includes('\0')) {
    throw new DataError('pg_invalid_argument', 'an identifier must be non-empty and must not contain a NUL byte', {
      field: 'identifier',
    })
  }
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * Compute the response to an AuthenticationMD5Password request.
 *
 * @param {string} user - the startup user.
 * @param {string} password - the plaintext password.
 * @param {Buffer} salt - the 4-byte server salt.
 * @returns {string} the `md5…` response.
 */
export function computeMd5Password(user, password, salt) {
  const inner = createHash('md5').update(`${password}${user}`, 'utf8').digest('hex')
  const outer = createHash('md5').update(Buffer.from(inner, 'utf8')).update(salt).digest('hex')
  return `md5${outer}`
}

/* ------------------------------------------------------------------ */
/* SCRAM-SHA-256 (channel binding deliberately off)                    */
/* ------------------------------------------------------------------ */

/** The GS2 header advertising that the client does not support channel binding. */
const SCRAM_GS2_HEADER = 'n,,'

/**
 * @param {Buffer|string} key - HMAC key.
 * @param {string} text - message text.
 * @returns {Buffer} the HMAC-SHA-256 digest.
 */
function hmacSha256(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest()
}

/**
 * @param {Buffer} left - first buffer.
 * @param {Buffer} right - second buffer.
 * @returns {Buffer} the byte-wise XOR (length of the shorter input).
 */
function xorBuffers(left, right) {
  const length = Math.min(left.length, right.length)
  const out = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) out[index] = left[index] ^ right[index]
  return out
}

/**
 * Parse a SCRAM attribute list such as `r=nonce,s=salt,i=4096`.
 *
 * @param {string} text - the attribute list.
 * @returns {Record<string, string>} attributes keyed by their single-letter name.
 */
function parseScramAttributes(text) {
  /** @type {Record<string, string>} */
  const attributes = {}
  for (const part of text.split(',')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    attributes[part.slice(0, separator)] = part.slice(separator + 1)
  }
  return attributes
}

/* ------------------------------------------------------------------ */
/* Byte stream → protocol messages                                     */
/* ------------------------------------------------------------------ */

/** Raised when the socket ends or is detached while a read is pending. */
class ConnectionClosedError extends Error {
  constructor(message = 'the PostgreSQL connection closed') {
    super(message)
    this.name = 'ConnectionClosedError'
    this.code = 'PG_CONNECTION_CLOSED'
  }
}

/** A pooled, exact-read view of a connected socket. */
class ByteReader {
  #socket
  #chunks = []
  #length = 0
  #failure = null
  #pending = []
  #onData
  #onError
  #onClose

  /**
   * @param {import('node:net').Socket | import('node:tls').TLSSocket} socket - the connected socket.
   */
  constructor(socket) {
    this.#socket = socket
    this.#onData = (chunk) => {
      this.#chunks.push(chunk)
      this.#length += chunk.length
      this.#pump()
    }
    this.#onError = (error) => this.#fail(error)
    this.#onClose = () => this.#fail(new ConnectionClosedError())
    socket.on('data', this.#onData)
    socket.on('error', this.#onError)
    socket.on('close', this.#onClose)
  }

  /** @returns {number} bytes buffered but not yet consumed. */
  get bufferedBytes() {
    return this.#length
  }

  /**
   * Stop reading and release the socket to a new owner (the TLS upgrade).
   *
   * @returns {void}
   */
  detach() {
    this.#socket.removeListener('data', this.#onData)
    this.#socket.removeListener('error', this.#onError)
    this.#socket.removeListener('close', this.#onClose)
    this.#fail(new ConnectionClosedError('the byte reader was detached'))
  }

  /**
   * @param {Error} error - the socket failure.
   * @returns {void}
   */
  #fail(error) {
    if (this.#failure !== null) return
    this.#failure = error instanceof Error ? error : new Error(String(error))
    const pending = this.#pending.splice(0)
    for (const waiter of pending) waiter.reject(this.#failure)
  }

  /** @returns {void} */
  #pump() {
    while (this.#pending.length > 0) {
      const waiter = this.#pending[0]
      if (this.#failure !== null) {
        this.#pending.shift()
        waiter.reject(this.#failure)
        break
      }
      if (this.#length < waiter.need) break
      this.#pending.shift()
      waiter.resolve(this.#take(waiter.need))
    }
  }

  /**
   * @param {number} count - exact number of bytes to consume.
   * @returns {Buffer} the consumed bytes.
   */
  #take(count) {
    this.#length -= count
    if (count === 0) return EMPTY_BUFFER
    const first = this.#chunks[0]
    if (first.length === count) {
      this.#chunks.shift()
      return first
    }
    if (first.length > count) {
      this.#chunks[0] = first.subarray(count)
      return first.subarray(0, count)
    }
    const out = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count) {
      const chunk = this.#chunks[0]
      const slice = Math.min(chunk.length, count - offset)
      chunk.copy(out, offset, 0, slice)
      offset += slice
      if (slice === chunk.length) this.#chunks.shift()
      else this.#chunks[0] = chunk.subarray(slice)
    }
    return out
  }

  /**
   * Read exactly `count` bytes, waiting for the socket as needed.
   *
   * @param {number} count - byte count.
   * @returns {Promise<Buffer>} the bytes.
   */
  read(count) {
    if (this.#failure !== null) return Promise.reject(this.#failure)
    if (count === 0) return Promise.resolve(EMPTY_BUFFER)
    if (this.#length >= count) return Promise.resolve(this.#take(count))
    return new Promise((resolve, reject) => {
      this.#pending.push({ need: count, resolve, reject })
    })
  }

  /**
   * Read one complete backend message.
   *
   * @returns {Promise<{ type: number, payload: Buffer }>} the message type byte and body.
   */
  async readMessage() {
    const header = await this.read(5)
    const type = header[0]
    const length = header.readInt32BE(1)
    if (length < 4) {
      throw new DataError('pg_query_failed', 'the PostgreSQL server sent a malformed message length', {
        sqlState: null,
        detail: null,
        hint: null,
        position: null,
      })
    }
    if (length - 4 > MAX_MESSAGE_BYTES) {
      throw new DataError('pg_query_failed', 'the PostgreSQL server sent an oversized protocol message', {
        sqlState: null,
        detail: null,
        hint: null,
        position: null,
      })
    }
    const payload = await this.read(length - 4)
    return { type, payload }
  }
}

/* ------------------------------------------------------------------ */
/* Low-level failure mapping                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {string} message - human line.
 * @param {object} [details] - structured context.
 * @returns {DataError} a protocol-level query failure.
 */
function protocolError(message, details = {}) {
  return new DataError('pg_query_failed', message, {
    sqlState: null,
    detail: null,
    hint: null,
    position: null,
    ...details,
  })
}

/**
 * Map a socket-level failure onto a stable DataError.
 *
 * @param {unknown} error - the thrown value.
 * @param {{ host: string, port: number, timeoutMs: number }} config - the normalized connection.
 * @returns {DataError} the mapped failure.
 */
function toConnectionError(error, config) {
  if (error instanceof DataError) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  if (cause.code === 'ETIMEDOUT') {
    return new DataError('pg_timeout', `the PostgreSQL connection to ${config.host}:${config.port} timed out`, {
      host: config.host,
      port: config.port,
      timeoutMs: config.timeoutMs,
    })
  }
  return new DataError(
    'pg_unreachable',
    `the PostgreSQL connection to ${config.host}:${config.port} failed: ${cause.message}`,
    { host: config.host, port: config.port, cause: cause.code ?? null },
  )
}

/**
 * Map a startup ErrorResponse onto `pg_auth_failed` / `pg_query_failed`.
 *
 * @param {Record<string, string>} fields - parsed fields.
 * @param {{ user: string }} config - the normalized connection.
 * @returns {DataError} the failure to throw.
 */
function startupError(fields, config) {
  const details = errorDetails(fields)
  const message = fields.M ?? 'the PostgreSQL server rejected the connection'
  if (typeof details.sqlState === 'string' && details.sqlState.startsWith('28')) {
    return new DataError('pg_auth_failed', `PostgreSQL rejected the connection for user "${config.user}": ${message}`, details)
  }
  return new DataError('pg_query_failed', message, details)
}

/**
 * Reject when `promise` does not settle inside `timeoutMs`.
 *
 * @template T
 * @param {Promise<T>} promise - the operation.
 * @param {number} timeoutMs - deadline.
 * @param {() => DataError} createError - lazily built timeout failure.
 * @returns {Promise<T>} the operation's result.
 */
function withDeadline(promise, timeoutMs, createError) {
  let timer = null
  /** @type {Promise<never>} */
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(createError()), timeoutMs)
  })
  return Promise.race([promise, limit]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/* ------------------------------------------------------------------ */
/* Message parsers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Normalize the row / byte display caps a query runs under.
 *
 * @param {{ maxRows?: unknown, maxBytes?: unknown }} [options] - caller caps.
 * @returns {{ maxRows: number, maxBytes: number }} the bounded caps.
 */
function queryCaps(options = {}) {
  const input = isRecord(options) ? /** @type {Record<string, unknown>} */ (options) : {}
  const maxRows = Number.isInteger(input.maxRows) && input.maxRows > 0 ? Number(input.maxRows) : DEFAULT_MAX_ROWS
  const maxBytes = Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? Number(input.maxBytes) : DEFAULT_MAX_BYTES
  return { maxRows, maxBytes }
}

/**
 * @param {Buffer} payload - a RowDescription body.
 * @returns {{ name: string, dataType: string }[]} the described columns.
 */
function parseRowDescription(payload) {
  const count = payload.readInt16BE(0)
  const columns = []
  let offset = 2
  for (let index = 0; index < count; index += 1) {
    const end = payload.indexOf(0, offset)
    if (end === -1) throw protocolError('the PostgreSQL server sent a malformed row description')
    const name = payload.toString('utf8', offset, end)
    offset = end + 1
    if (offset + 18 > payload.length) throw protocolError('the PostgreSQL server sent a malformed row description')
    const typeOid = payload.readUInt32BE(offset + 6)
    columns.push({ name, dataType: TYPE_OIDS[typeOid] ?? `oid:${typeOid}` })
    offset += 18
  }
  return columns
}

/**
 * @param {Buffer} payload - a DataRow body (text format, NULL = length -1).
 * @returns {(string|null)[]} the row values.
 */
function parseDataRow(payload) {
  const count = payload.readInt16BE(0)
  const row = new Array(count)
  let offset = 2
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > payload.length) throw protocolError('the PostgreSQL server sent a malformed data row')
    const length = payload.readInt32BE(offset)
    offset += 4
    if (length === -1) {
      row[index] = null
      continue
    }
    if (length < 0 || offset + length > payload.length) throw protocolError('the PostgreSQL server sent a malformed data row')
    row[index] = payload.toString('utf8', offset, offset + length)
    offset += length
  }
  return row
}

/**
 * @param {string} tag - a CommandComplete tag, e.g. `'SELECT 3'`.
 * @returns {string} the command keyword, e.g. `'SELECT'`.
 */
function commandName(tag) {
  return tag.split(/\s+/)[0] ?? ''
}

/**
 * @param {string} tag - a CommandComplete tag.
 * @returns {number | null} the trailing row count when the tag carries one.
 */
function commandRowCount(tag) {
  const match = /(\d+)\s*$/.exec(tag)
  return match === null ? null : Number(match[1])
}

/**
 * @param {({ command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number } | null)[]} results - collected result sets.
 * @returns {(string|null)[][]} every row of every set, in order.
 */
function rowsOf(results) {
  const rows = []
  for (const result of results) {
    for (const row of result.rows) rows.push(row)
  }
  return rows
}

/**
 * @param {string|null|undefined} value - a bigint / numeric text value.
 * @returns {number|null} the integer, or null when absent or unparsable.
 */
function toInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number.parseInt(String(value), 10)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * @param {string|null|undefined} value - the SQL kind.
 * @returns {'table'|'view'|'materialized view'|'foreign table'} a contract kind.
 */
function normalizeTableKind(value) {
  return TABLE_KINDS.has(String(value)) ? /** @type {any} */ (value) : 'table'
}

/* ------------------------------------------------------------------ */
/* Connection validation                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {unknown} value - candidate.
 * @returns {value is Record<string, unknown>} whether it is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate and default the connection object the ops layer hands us.
 *
 * @param {unknown} connection - the connection candidate.
 * @returns {{ host: string, port: number, user: string, password: string, database: string,
 *   ssl: 'disable'|'prefer'|'require', timeoutMs: number, applicationName: string }} normalized config.
 */
function normalizeConnection(connection) {
  /**
   * @param {string} message - failure line.
   * @param {Record<string, unknown>} details - structured context.
   * @returns {never} never returns.
   */
  const fail = (message, details) => {
    throw new DataError('pg_invalid_connection', message, details)
  }
  if (!isRecord(connection)) fail('the PostgreSQL connection must be an object', { field: 'connection' })
  const record = /** @type {Record<string, unknown>} */ (connection)
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  if (host === '') fail('"postgres.host" must be a non-empty string', { field: 'host' })
  const port = Number(record.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('"postgres.port" must be an integer between 1 and 65535', { field: 'port' })
  }
  const user = typeof record.user === 'string' ? record.user.trim() : ''
  if (user === '') fail('"postgres.user" must be a non-empty string', { field: 'user' })
  const database = typeof record.database === 'string' ? record.database.trim() : ''
  if (database === '') fail('"postgres.database" must be a non-empty string', { field: 'database' })
  const ssl = record.ssl === undefined ? 'prefer' : record.ssl
  if (ssl !== 'disable' && ssl !== 'prefer' && ssl !== 'require') {
    fail('"postgres.ssl" must be one of disable, prefer, require', { field: 'ssl' })
  }
  const timeoutValue = Number(record.timeoutMs)
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue >= 100
    ? Math.min(Math.floor(timeoutValue), 300000)
    : DEFAULT_TIMEOUT_MS
  const password = typeof record.password === 'string' ? record.password : ''
  const applicationName = typeof record.applicationName === 'string' && record.applicationName.trim() !== ''
    ? record.applicationName.trim()
    : 'dsh-long-data'
  return { host, port, user, password, database, ssl, timeoutMs, applicationName }
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * One authenticated PostgreSQL session.
 *
 * Instances are created by {@link withPostgres}; callers receive one inside the
 * `run` callback and must not keep it beyond that callback (the socket is
 * closed when the callback settles).
 */
class PgClient {
  #config
  #socket = null
  #reader = null
  #scram = null
  #busy = false
  #closed = false

  /** @type {Record<string, string>} server ParameterStatus values. */
  parameters = {}

  /** @type {number | null} backend process id from BackendKeyData. */
  backendProcessId = null

  /** @type {'I'|'T'|'E'} ReadyForQuery transaction status. */
  transactionStatus = 'I'

  /**
   * @param {ReturnType<typeof normalizeConnection>} config - the normalized connection.
   */
  constructor(config) {
    this.#config = config
  }

  /** @returns {string|null} the server's `server_version` parameter. */
  get serverVersion() {
    return this.parameters.server_version ?? null
  }

  /** @returns {boolean} whether the socket has been closed. */
  get closed() {
    return this.#closed
  }

  /**
   * Open the socket, negotiate SSL when asked, and authenticate.
   *
   * @returns {Promise<void>} resolves once ReadyForQuery has been received.
   */
  async connect() {
    const config = this.#config
    const operation = this.#connectAndAuthenticate()
    try {
      await withDeadline(
        operation,
        config.timeoutMs,
        () => new DataError(
          'pg_timeout',
          `connecting to PostgreSQL at ${config.host}:${config.port} timed out after ${config.timeoutMs}ms`,
          { host: config.host, port: config.port, timeoutMs: config.timeoutMs },
        ),
      )
    } catch (error) {
      this.close()
      throw error
    }
  }

  /**
   * Run one simple-protocol query, enforcing the row and byte caps.
   *
   * @param {string} sql - one or more statements, separated by semicolons.
   * @param {{ maxRows?: number, maxBytes?: number }} [options] - display caps.
   * @returns {Promise<{ durationMs: number, truncated: boolean, results: { command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[] }>} the result.
   */
  async query(sql, options = {}) {
    this.#assertUsable()
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new DataError('invalid_payload', '"sql" must be a non-empty string', { field: 'sql' })
    }
    const { maxRows, maxBytes } = queryCaps(options)
    return this.#runOperation(this.#runQuery(sql, maxRows, maxBytes))
  }

  /**
   * Run one parameterized statement through the extended Query protocol.
   *
   * Every `$n` value is sent in text format, which is enough for the catalog
   * lookups (schema / table names) this module performs on behalf of the panel.
   * Identifiers are deliberately not accepted here: they must be quoted with
   * {@link quoteIdentifier} instead.
   *
   * @param {string} sql - one statement using `$1`-style placeholders.
   * @param {(string|number|boolean|null)[]} [parameters] - bound values.
   * @param {{ maxRows?: number, maxBytes?: number }} [options] - display caps.
   * @returns {Promise<{ durationMs: number, truncated: boolean, results: { command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[] }>} the result.
   */
  async queryParams(sql, parameters = [], options = {}) {
    this.#assertUsable()
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new DataError('invalid_payload', '"sql" must be a non-empty string', { field: 'sql' })
    }
    if (!Array.isArray(parameters)) {
      throw new DataError('invalid_payload', '"parameters" must be an array', { field: 'parameters' })
    }
    const values = parameters.map((parameter) => {
      if (parameter === null) return null
      if (typeof parameter === 'string') return parameter
      if (typeof parameter === 'number' && Number.isFinite(parameter)) return String(parameter)
      if (typeof parameter === 'boolean') return String(parameter)
      throw new DataError('invalid_payload', 'query parameters must be strings, finite numbers, booleans or null', {
        field: 'parameters',
      })
    })
    const { maxRows, maxBytes } = queryCaps(options)
    return this.#runOperation(this.#runParameterizedQuery(sql, values, maxRows, maxBytes))
  }

  /**
   * Reject use of a closed or busy session with the documented codes.
   *
   * @returns {void}
   */
  #assertUsable() {
    if (this.#closed) {
      throw new DataError('pg_unreachable', 'the PostgreSQL connection is closed', {
        host: this.#config.host,
        port: this.#config.port,
      })
    }
    if (this.#busy) throw protocolError('another query is already running on this PostgreSQL connection')
  }

  /**
   * Run one operation under the connection timeout and the single-query lock.
   *
   * @param {Promise<any>} operation - the started protocol exchange.
   * @returns {Promise<any>} the operation's result.
   */
  async #runOperation(operation) {
    const timeoutMs = this.#config.timeoutMs
    this.#busy = true
    try {
      return await withDeadline(
        operation,
        timeoutMs,
        () => new DataError('pg_timeout', `the PostgreSQL query timed out after ${timeoutMs}ms`, {
          timeoutMs,
          host: this.#config.host,
          port: this.#config.port,
        }),
      )
    } catch (error) {
      if (error instanceof DataError && error.code === 'pg_timeout') this.close()
      throw error
    } finally {
      this.#busy = false
    }
  }

  /**
   * Close the socket. Idempotent and never throws.
   *
   * @returns {void}
   */
  close() {
    this.#closed = true
    const socket = this.#socket
    this.#socket = null
    this.#reader = null
    if (socket !== null) {
      try {
        socket.destroy()
      } catch {
        // Already gone: closing must never fail.
      }
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * @returns {Promise<void>} resolves after ReadyForQuery.
   */
  async #connectAndAuthenticate() {
    const config = this.#config
    const socket = await new Promise((resolve, reject) => {
      const candidate = netConnect({ host: config.host, port: config.port })
      candidate.setNoDelay(true)
      this.#socket = candidate
      candidate.once('connect', () => resolve(candidate))
      // A lingering `once` error listener keeps a late socket error from
      // crashing the process; the ByteReader reports it to the active read.
      candidate.once('error', (error) => reject(toConnectionError(error, config)))
    })
    let reader = new ByteReader(socket)
    this.#reader = reader
    let activeSocket = socket

    if (config.ssl !== 'disable') {
      try {
        socket.write(buildSslRequest())
      } catch (error) {
        throw toConnectionError(error, config)
      }
      const answer = await this.#read(1)
      if (answer[0] === 0x53) {
        // The server accepted the request; the TLS handshake starts immediately.
        if (reader.bufferedBytes > 0) {
          throw new DataError('pg_ssl_failed', 'the PostgreSQL server sent unexpected plaintext bytes after accepting SSL', {
            host: config.host,
            port: config.port,
          })
        }
        reader.detach()
        activeSocket = await upgradeToTls(socket, config)
        this.#socket = activeSocket
        reader = new ByteReader(activeSocket)
        this.#reader = reader
      } else if (answer[0] === 0x4e) {
        if (config.ssl === 'require') {
          throw new DataError('pg_ssl_failed', `PostgreSQL at ${config.host}:${config.port} refused the SSL request`, {
            host: config.host,
            port: config.port,
          })
        }
      } else {
        throw new DataError('pg_ssl_failed', 'the PostgreSQL server responded to the SSL request with an unknown byte', {
          host: config.host,
          port: config.port,
          response: answer[0],
        })
      }
    }

    activeSocket.setNoDelay?.(true)
    this.#sendRaw(buildStartupMessage({
      user: config.user,
      database: config.database,
      applicationName: config.applicationName,
    }))
    await this.#authenticate()
  }

  /**
   * @param {number} count - exact byte count.
   * @returns {Promise<Buffer>} the bytes.
   */
  async #read(count) {
    try {
      return await this.#reader.read(count)
    } catch (error) {
      throw toConnectionError(error, this.#config)
    }
  }

  /**
   * @returns {Promise<{ type: number, payload: Buffer }>} the next backend message.
   */
  async #readMessage() {
    try {
      return await this.#reader.readMessage()
    } catch (error) {
      throw toConnectionError(error, this.#config)
    }
  }

  /**
   * @param {Buffer} buffer - bytes to write verbatim.
   * @returns {void}
   */
  #sendRaw(buffer) {
    const socket = this.#socket
    if (socket === null || socket.destroyed || this.#closed) {
      throw new DataError('pg_unreachable', 'the PostgreSQL connection is closed', {
        host: this.#config.host,
        port: this.#config.port,
      })
    }
    socket.write(buffer)
  }

  /**
   * @param {string} type - message type.
   * @param {Buffer} payload - message body.
   * @returns {void}
   */
  #send(type, payload) {
    this.#sendRaw(frameMessage(type, payload))
  }

  /**
   * @param {string} password - the password response body.
   * @returns {void}
   */
  #sendPassword(password) {
    this.#send('p', Buffer.from(`${password}\0`, 'utf8'))
  }

  /**
   * @param {string} method - the requested authentication method, for the error.
   * @returns {string} the configured password.
   */
  #requirePassword(method) {
    const password = this.#config.password
    if (typeof password !== 'string' || password === '') {
      throw new DataError('pg_auth_required', `PostgreSQL requires a password for user "${this.#config.user}"`, {
        user: this.#config.user,
        authMethod: method,
      })
    }
    return password
  }

  /**
   * Consume the startup message stream until ReadyForQuery.
   *
   * @returns {Promise<void>} resolves when the session is ready.
   */
  async #authenticate() {
    for (;;) {
      const { type, payload } = await this.#readMessage()
      switch (String.fromCharCode(type)) {
        case 'R':
          await this.#handleAuthentication(payload)
          break
        case 'S': {
          const values = splitCStrings(payload)
          if (values.length >= 2) this.parameters[values[0]] = values[1]
          break
        }
        case 'K':
          if (payload.length >= 8) this.backendProcessId = payload.readInt32BE(0)
          break
        case 'N':
          break
        case 'E':
          throw startupError(parseErrorFields(payload), this.#config)
        case 'Z':
          this.transactionStatus = payload.length > 0 ? /** @type {'I'|'T'|'E'} */ (String.fromCharCode(payload[0])) : 'I'
          return
        default:
          throw protocolError(
            `the PostgreSQL server sent an unexpected message "${String.fromCharCode(type)}" during startup`,
          )
      }
    }
  }

  /**
   * @param {Buffer} payload - an Authentication message body (int32 code + data).
   * @returns {void}
   */
  async #handleAuthentication(payload) {
    if (payload.length < 4) throw protocolError('the PostgreSQL server sent a malformed authentication request')
    const code = payload.readInt32BE(0)
    switch (code) {
      case 0:
        return
      case 3:
        this.#sendPassword(this.#requirePassword('cleartext'))
        return
      case 5: {
        const salt = payload.subarray(4, 8)
        this.#sendPassword(computeMd5Password(this.#config.user, this.#requirePassword('md5'), salt))
        return
      }
      case 10:
        this.#startScram(payload.subarray(4))
        return
      case 11:
        this.#continueScram(payload.subarray(4))
        return
      case 12:
        this.#completeScram(payload.subarray(4))
        return
      default:
        throw new DataError('pg_unsupported_auth', `PostgreSQL requested an unsupported authentication method (code ${code})`, {
          authCode: code,
        })
    }
  }

  /**
   * @param {Buffer} payload - the SASL mechanism list.
   * @returns {void}
   */
  #startScram(payload) {
    const mechanisms = splitCStrings(payload)
    const mechanism = mechanisms.find((candidate) => candidate === 'SCRAM-SHA-256')
    if (mechanism === undefined) {
      throw new DataError(
        'pg_unsupported_auth',
        `PostgreSQL offered no supported SASL mechanism (${mechanisms.join(', ') || 'none'})`,
        { mechanisms },
      )
    }
    const password = this.#requirePassword('SCRAM-SHA-256')
    const nonce = randomBytes(18).toString('base64')
    const clientFirstBare = `n=,r=${nonce}`
    this.#scram = { nonce, clientFirstBare, password, expectedServerSignature: null }
    const clientFirst = `${SCRAM_GS2_HEADER}${clientFirstBare}`
    const clientFirstBytes = Buffer.from(clientFirst, 'utf8')
    const body = Buffer.concat([
      Buffer.from(`${mechanism}\0`, 'utf8'),
      int32(clientFirstBytes.length),
      clientFirstBytes,
    ])
    this.#send('p', body)
  }

  /**
   * @param {Buffer} payload - the server-first-message.
   * @returns {void}
   */
  #continueScram(payload) {
    const scram = this.#scram
    if (scram === null) throw protocolError('the PostgreSQL server sent an unexpected SASL continue message')
    const serverFirst = payload.toString('utf8')
    const attributes = parseScramAttributes(serverFirst)
    if (attributes.m !== undefined) {
      throw new DataError('pg_unsupported_auth', 'PostgreSQL requested an unsupported SCRAM extension', {
        extension: attributes.m,
      })
    }
    const serverNonce = attributes.r
    const salt = attributes.s
    const iterations = Number.parseInt(attributes.i ?? '', 10)
    if (serverNonce === undefined || salt === undefined || !Number.isInteger(iterations) || iterations < 1) {
      throw new DataError('pg_auth_failed', 'the PostgreSQL server sent a malformed SCRAM challenge', {
        reason: 'malformed challenge',
      })
    }
    if (!serverNonce.startsWith(scram.nonce)) {
      throw new DataError('pg_auth_failed', 'the PostgreSQL server returned an invalid SCRAM nonce', {
        reason: 'nonce mismatch',
      })
    }
    const saltedPassword = pbkdf2Sync(scram.password, Buffer.from(salt, 'base64'), iterations, 32, 'sha256')
    const clientKey = hmacSha256(saltedPassword, 'Client Key')
    const storedKey = createHash('sha256').update(clientKey).digest()
    const clientFinalWithoutProof = `c=${Buffer.from(SCRAM_GS2_HEADER, 'utf8').toString('base64')},r=${serverNonce}`
    const authMessage = `${scram.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`
    const clientProof = xorBuffers(clientKey, hmacSha256(storedKey, authMessage)).toString('base64')
    const serverKey = hmacSha256(saltedPassword, 'Server Key')
    scram.expectedServerSignature = hmacSha256(serverKey, authMessage).toString('base64')
    this.#send('p', Buffer.from(`${clientFinalWithoutProof},p=${clientProof}`, 'utf8'))
  }

  /**
   * @param {Buffer} payload - the server-final-message.
   * @returns {void}
   */
  #completeScram(payload) {
    const scram = this.#scram
    if (scram === null) throw protocolError('the PostgreSQL server sent an unexpected SASL final message')
    const attributes = parseScramAttributes(payload.toString('utf8'))
    this.#scram = null
    if (attributes.v === undefined) {
      throw new DataError('pg_auth_failed', 'the PostgreSQL server did not prove it knows the password', {
        reason: 'missing server signature',
      })
    }
    if (attributes.v !== scram.expectedServerSignature) {
      throw new DataError('pg_auth_failed', 'the PostgreSQL server signature did not match', {
        reason: 'server signature mismatch',
      })
    }
  }

  /**
   * Execute one simple-protocol query and drain to ReadyForQuery.
   *
   * @param {string} sql - the statement text.
   * @param {number} maxRows - display row cap across all result sets.
   * @param {number} maxBytes - display byte cap.
   * @returns {Promise<{ durationMs: number, truncated: boolean, results: { command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[] }>} the result.
   */
  async #runQuery(sql, maxRows, maxBytes) {
    const startedAt = Date.now()
    return this.#readResults(
      () => this.#send('Q', Buffer.from(`${sql}\0`, 'utf8')),
      maxRows,
      maxBytes,
      startedAt,
    )
  }

  /**
   * Execute one extended-protocol statement: Parse, Bind, Describe, Execute, Sync.
   *
   * @param {string} sql - the statement with `$n` placeholders.
   * @param {(string|null)[]} parameters - text-format bound values.
   * @param {number} maxRows - display row cap.
   * @param {number} maxBytes - display byte cap.
   * @returns {Promise<{ durationMs: number, truncated: boolean, results: { command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[] }>} the result.
   */
  async #runParameterizedQuery(sql, parameters, maxRows, maxBytes) {
    const startedAt = Date.now()
    return this.#readResults(
      () => this.#sendRaw(Buffer.concat([
        buildParseMessage(sql),
        buildBindMessage(parameters),
        buildDescribePortalMessage(),
        buildExecuteMessage(),
        buildSyncMessage(),
      ])),
      maxRows,
      maxBytes,
      startedAt,
    )
  }

  /**
   * Send a query, collect the bounded result sets, and drain to ReadyForQuery.
   *
   * Both the simple and the extended protocol funnel through here so the row
   * cap, the byte cap and the drain rule are identical for both.
   *
   * @param {() => void} send - writes the queued frontend messages.
   * @param {number} maxRows - display row cap across all result sets.
   * @param {number} maxBytes - display byte cap.
   * @param {number} startedAt - wall-clock timestamp when the round trip began.
   * @returns {Promise<{ durationMs: number, truncated: boolean, results: { command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[] }>} the result.
   */
  async #readResults(send, maxRows, maxBytes, startedAt) {
    send()
    /** @type {{ command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[]} */
    const results = []
    /** @type {{ columns: { name: string, dataType: string }[], rows: (string|null)[][], received: number } | null} */
    let current = null
    let displayRows = 0
    let displayedBytes = 0
    let truncated = false
    let byteCapHit = false
    let drainedBytes = 0
    /** @type {DataError | null} */
    let queryError = null

    for (;;) {
      const { type, payload } = await this.#readMessage()
      drainedBytes += payload.length + 5
      switch (String.fromCharCode(type)) {
        case 'T':
          current = { columns: parseRowDescription(payload), rows: [], received: 0 }
          break
        case 'D': {
          if (current === null) break
          current.received += 1
          if (queryError !== null) break
          if (displayRows >= maxRows) {
            truncated = true
            break
          }
          const rowBytes = payload.length + 5
          if (displayedBytes + rowBytes > maxBytes) {
            truncated = true
            byteCapHit = true
            break
          }
          current.rows.push(parseDataRow(payload))
          displayRows += 1
          displayedBytes += rowBytes
          break
        }
        case 'C': {
          const tag = firstCString(payload)
          const command = commandName(tag)
          const reported = commandRowCount(tag)
          if (current !== null) {
            results.push({
              command,
              columns: current.columns,
              rows: current.rows,
              rowCount: reported ?? current.received,
            })
            current = null
          } else {
            results.push({ command, columns: [], rows: [], rowCount: reported ?? 0 })
          }
          break
        }
        case 'I':
          // EmptyQueryResponse: a comment-only statement produced nothing.
          break
        case 'E': {
          const fields = parseErrorFields(payload)
          queryError = new DataError('pg_query_failed', fields.M ?? 'the PostgreSQL query failed', errorDetails(fields))
          break
        }
        case 'Z': {
          this.transactionStatus = payload.length > 0 ? /** @type {'I'|'T'|'E'} */ (String.fromCharCode(payload[0])) : 'I'
          if (queryError !== null) throw queryError
          if (current !== null) {
            results.push({ command: '', columns: current.columns, rows: current.rows, rowCount: current.received })
            current = null
          }
          return { durationMs: Math.max(0, Date.now() - startedAt), truncated, results }
        }
        case 'S': {
          const values = splitCStrings(payload)
          if (values.length >= 2) this.parameters[values[0]] = values[1]
          break
        }
        case 'N':
        case 'A':
        case 'K':
          // Notices, notifications and backend keys need no handling here.
          break
        case '1': // ParseComplete
        case '2': // BindComplete
        case 't': // ParameterDescription
        case 'n': // NoData (Describe found no result columns)
        case 's': // PortalSuspended (Execute always asks for every row)
          break
        default:
          throw protocolError(`the PostgreSQL server sent an unexpected message "${String.fromCharCode(type)}"`)
      }
      if (byteCapHit && drainedBytes > maxBytes + DRAIN_LIMIT_BYTES) {
        // The display budget is exhausted and the response is far past it:
        // close instead of holding the connection hostage to a result nobody
        // will render. Closing mid-query is safe; the socket dies with it.
        this.close()
        if (current !== null) {
          results.push({ command: '', columns: current.columns, rows: current.rows, rowCount: current.received })
          current = null
        }
        if (queryError !== null) throw queryError
        return { durationMs: Math.max(0, Date.now() - startedAt), truncated: true, results }
      }
    }
  }
}

/**
 * Upgrade a connected plaintext socket to TLS.
 *
 * @param {import('node:net').Socket} socket - the plaintext socket.
 * @param {{ host: string, port: number }} config - the connection.
 * @returns {Promise<import('node:tls').TLSSocket>} the secured socket.
 */
function upgradeToTls(socket, config) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:tls').ConnectionOptions} */
    const options = { socket, rejectUnauthorized: false }
    if (isIP(config.host) === 0) options.servername = config.host
    const secure = tlsConnect(options)
    secure.once('secureConnect', () => resolve(secure))
    secure.once('error', (error) => {
      secure.destroy()
      reject(new DataError('pg_ssl_failed', `the PostgreSQL TLS handshake failed: ${error.message}`, {
        host: config.host,
        port: config.port,
        cause: error.code ?? null,
      }))
    })
  })
}

/* ------------------------------------------------------------------ */
/* Public service API                                                  */
/* ------------------------------------------------------------------ */

/**
 * Open one authenticated session, hand the client to `run`, then close.
 *
 * @param {object} connection - `{ host, port, user, password?, database, ssl?, timeoutMs? }`.
 * @param {(client: PgClient) => Promise<any>} run - the work to do on the session.
 * @returns {Promise<any>} whatever `run` resolved.
 */
export async function withPostgres(connection, run) {
  const config = normalizeConnection(connection)
  if (typeof run !== 'function') {
    throw new DataError('pg_invalid_connection', 'withPostgres(connection, run) needs a run function', {
      field: 'run',
    })
  }
  const client = new PgClient(config)
  try {
    await client.connect()
    return await run(client)
  } finally {
    client.close()
  }
}

/**
 * Run `run` against a connection, optionally on a different database.
 *
 * @template T
 * @param {object} connection - the base connection.
 * @param {unknown} database - per-call database override.
 * @param {(client: PgClient) => Promise<T>} run - the work.
 * @returns {Promise<T>} whatever `run` resolved.
 */
function withDatabase(connection, database, run) {
  /** @type {any} */
  let target = connection
  if (database !== undefined && database !== null) {
    if (typeof database !== 'string' || database.trim() === '') {
      throw new DataError('invalid_payload', '"database" must be a non-empty string', { field: 'database' })
    }
    if (isRecord(connection)) target = { ...connection, database: database.trim() }
  }
  return withPostgres(target, run)
}

/**
 * @param {unknown} value - candidate text.
 * @param {string} field - field name for the error.
 * @returns {string|undefined} the trimmed text, or undefined when absent.
 */
function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DataError('invalid_payload', `"${field}" must be a non-empty string`, { field })
  }
  return value.trim()
}

/**
 * @param {unknown} value - candidate text.
 * @param {string} field - field name for the error.
 * @returns {string} the trimmed text.
 */
function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DataError('invalid_payload', `"${field}" must be a non-empty string`, { field })
  }
  return value.trim()
}

/**
 * @param {unknown} options - the caller's options.
 * @returns {Record<string, unknown>} a plain options record.
 */
function optionsOf(options) {
  return isRecord(options) ? /** @type {Record<string, unknown>} */ (options) : {}
}

/**
 * @param {string|null|undefined} value - the protocol `version()` text.
 * @returns {string} the version line.
 */
function versionLine(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {string|null|undefined} value - a text value.
 * @returns {string} the value, or an empty string.
 */
function textValue(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {string|null|undefined} value - a text value from a nullable column.
 * @returns {string|null} the value, or null when absent or empty.
 */
function nullableText(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * @param {string|null|undefined} value - a numeric text value.
 * @returns {number|null} the finite number, or null when absent or unparsable.
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Shape the rows of the shared column catalog queries.
 *
 * @param {{ rows: (string|null)[][] }[]} results - query result sets.
 * @returns {{ name: string, dataType: string, nullable: boolean, defaultValue: string|null }[]} the columns.
 */
function mapColumnRows(results) {
  return rowsOf(results).map((row) => ({
    name: textValue(row[0]),
    dataType: textValue(row[1]),
    nullable: row[2] === 't',
    defaultValue: typeof row[3] === 'string' ? row[3] : null,
  }))
}

/** Human words for `pg_constraint.contype`, including PostgreSQL 18's not-null kind. */
const CONSTRAINT_TYPES = Object.freeze({
  c: 'check',
  f: 'foreign key',
  n: 'not null',
  p: 'primary key',
  t: 'trigger',
  u: 'unique',
  x: 'exclusion',
})

/**
 * @param {string|null|undefined} value - a `contype` letter.
 * @returns {string} the human-readable constraint type.
 */
function constraintType(value) {
  return CONSTRAINT_TYPES[String(value)] ?? 'other'
}

/**
 * @param {string} field - argument name.
 * @param {string} message - human line.
 * @returns {DataError} an `pg_invalid_argument` failure for the panel.
 */
function invalidArgument(field, message) {
  return new DataError('pg_invalid_argument', message, { field })
}

/**
 * Validate a required schema/table-style text argument.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - argument name.
 * @returns {string} the trimmed text.
 */
function argumentText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidArgument(field, `"${field}" must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Validate and clamp an integer argument for `pgBrowse`.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - argument name.
 * @param {number} fallback - used when absent.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the clamped integer.
 */
function argumentInteger(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw invalidArgument(field, `"${field}" must be a number`)
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * Validate a boolean argument for `pgBrowse`.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - argument name.
 * @returns {boolean} the flag.
 */
function argumentBoolean(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw invalidArgument(field, `"${field}" must be a boolean`)
  return value
}

/**
 * @param {string} schema - the relation's schema.
 * @param {string} table - the relation's name.
 * @returns {DataError} a `42P01`-shaped failure the panel already understands.
 */
function relationNotFound(schema, table) {
  return new DataError('pg_query_failed', `relation "${schema}.${table}" does not exist`, {
    sqlState: '42P01',
    detail: null,
    hint: null,
    position: null,
  })
}

const VERSION_SQL = 'SELECT version() AS version, current_user AS current_user, current_database() AS current_database'

const DATABASES_SQL = `SELECT d.datname AS name,
       pg_catalog.pg_get_userbyid(d.datdba) AS owner,
       pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
       CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT')
            THEN pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname))
       END AS size,
       CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT')
            THEN pg_catalog.pg_database_size(d.datname)
       END AS size_bytes,
       (SELECT count(*) FROM pg_catalog.pg_stat_activity a
         WHERE a.datname = d.datname) AS connections
FROM pg_catalog.pg_database d
WHERE d.datallowconn AND NOT d.datistemplate`

const TABLES_SQL = `SELECT n.nspname AS schema,
       c.relname AS name,
       CASE c.relkind
         WHEN 'r' THEN 'table'
         WHEN 'p' THEN 'table'
         WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized view'
         WHEN 'f' THEN 'foreign table'
       END AS kind,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
       CASE WHEN c.relkind IN ('r', 'm', 'p')
            THEN pg_catalog.pg_total_relation_size(c.oid)
       END AS size_bytes,
       CASE WHEN c.relkind IN ('r', 'm', 'p')
            THEN pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid))
       END AS size,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
       (SELECT count(*) FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS column_count
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')`

const COLUMNS_BASE_SQL = `SELECT a.attname AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS nullable,
       pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_value
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE a.attnum > 0
  AND NOT a.attisdropped`

const ACTIVITY_SQL = `SELECT pid,
       usename,
       datname,
       state,
       host(client_addr) AS client_addr,
       application_name,
       to_char(backend_start, 'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM') AS backend_start,
       to_char(query_start, 'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM') AS query_start,
       EXTRACT(EPOCH FROM (now() - query_start)) AS query_seconds,
       wait_event,
       left(query, 500) AS query
FROM pg_catalog.pg_stat_activity
ORDER BY state NULLS LAST, pid`

const TABLE_DETAIL_SQL = `SELECT CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relkind IN ('r', 'm', 'p')
            THEN pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid))
       END AS total_size,
       CASE WHEN c.relkind IN ('r', 'm', 'p')
            THEN pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.oid))
       END AS table_size,
       CASE WHEN c.relkind IN ('r', 'm', 'p')
            THEN pg_catalog.pg_size_pretty(pg_catalog.pg_indexes_size(c.oid))
       END AS index_size,
       CASE WHEN c.relkind IN ('r', 'm', 'p')
            THEN CASE WHEN c.reltoastrelid <> 0
                      THEN pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.reltoastrelid))
                      ELSE '0 bytes'
                 END
       END AS toast_size
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
LIMIT 1`

const COLUMNS_BY_NAME_SQL = `${COLUMNS_BASE_SQL}
  AND n.nspname = $1
  AND c.relname = $2
ORDER BY a.attnum`

const INDEXES_SQL = `SELECT i.relname AS name,
       pg_catalog.pg_get_indexdef(i.oid) AS definition,
       ix.indisunique AS is_unique,
       ix.indisprimary AS is_primary
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = $1
  AND t.relname = $2
ORDER BY ix.indisprimary DESC, i.relname`

const CONSTRAINTS_SQL = `SELECT con.conname AS name,
       con.contype AS type,
       pg_catalog.pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = $1
  AND t.relname = $2
ORDER BY con.conname`

/**
 * The server's version banner plus the current user and database.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string }} [options] - optional database override.
 * @returns {Promise<{ version: string, currentUser: string, currentDatabase: string }>} the identity.
 */
export async function pgVersion(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  return withDatabase(connection, database, async (client) => {
    const { results } = await client.query(VERSION_SQL, { maxRows: 1 })
    const row = rowsOf(results)[0]
    if (row === undefined) throw protocolError('PostgreSQL returned no version row')
    return {
      version: versionLine(row[0]),
      currentUser: textValue(row[1]),
      currentDatabase: textValue(row[2]),
    }
  })
}

/**
 * List the databases the user can connect to.
 *
 * @param {object} connection - the connection.
 * @returns {Promise<{ name: string, owner: string, encoding: string, size: string, sizeBytes: number|null, connections: number|null }[]>} the databases.
 */
export async function pgDatabases(connection) {
  return withPostgres(connection, async (client) => {
    const { results } = await client.query(DATABASES_SQL, {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    return rowsOf(results).map((row) => ({
      name: textValue(row[0]),
      owner: textValue(row[1]),
      encoding: textValue(row[2]),
      size: textValue(row[3]),
      sizeBytes: toInteger(row[4]),
      connections: toInteger(row[5]),
    }))
  })
}

/**
 * List tables, views, materialized views and foreign tables.
 *
 * Without a `schema` the list is the user-facing inventory (system and
 * temporary schemas are omitted); an explicit `schema` — including
 * `pg_catalog` — lists exactly that schema.
 *
 * Size fields are human-readable strings for the panel; they are null for
 * relations without storage (views and foreign tables). `columnCount` counts
 * live (non-dropped, non-system) attributes.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string, schema?: string }} [options] - database override and schema filter.
 * @returns {Promise<{ schema: string, name: string, kind: 'table'|'view'|'materialized view'|'foreign table', estimatedRows: number|null, sizeBytes: number|null, size: string|null, comment: string|null, columnCount: number|null }[]>} the tables.
 */
export async function pgTables(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  const schema = optionalText(input.schema, 'schema')
  return withDatabase(connection, database, async (client) => {
    // Without an explicit schema the panel shows user relations only; an
    // explicit schema (including pg_catalog) lists exactly what was asked for.
    const filter = schema === undefined
      ? "\n  AND n.nspname NOT IN ('pg_catalog', 'information_schema')"
        + "\n  AND n.nspname !~ '^pg_(toast|temp_)'"
      : `\n  AND n.nspname = ${quoteLiteral(schema)}`
    const { results } = await client.query(`${TABLES_SQL}${filter}\nORDER BY n.nspname, c.relname`, {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    return rowsOf(results).map((row) => ({
      schema: textValue(row[0]),
      name: textValue(row[1]),
      kind: normalizeTableKind(row[2]),
      estimatedRows: toInteger(row[3]),
      sizeBytes: toInteger(row[4]),
      size: nullableText(row[5]),
      comment: nullableText(row[6]),
      columnCount: toInteger(row[7]),
    }))
  })
}

/**
 * List the columns of one table or view.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string, schema: string, table: string }} options - required schema and table.
 * @returns {Promise<{ name: string, dataType: string, nullable: boolean, defaultValue: string|null }[]>} the columns.
 */
export async function pgColumns(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  const schema = requiredText(input.schema, 'schema')
  const table = requiredText(input.table, 'table')
  return withDatabase(connection, database, async (client) => {
    const sql = `${COLUMNS_BASE_SQL}
  AND n.nspname = ${quoteLiteral(schema)}
  AND c.relname = ${quoteLiteral(table)}
ORDER BY a.attnum`
    const { results } = await client.query(sql, {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    return mapColumnRows(results)
  })
}

/**
 * Run user SQL through the simple Query protocol.
 *
 * The result is bounded: at most `maxRows` display rows and roughly `maxBytes`
 * of row data are kept; the rest of the response is still drained to
 * ReadyForQuery (or the socket is closed safely once the byte cap is far
 * exceeded), so `truncated` honestly reports that more data existed.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string, sql: string, maxRows?: number, maxBytes?: number }} options - the statement and caps.
 * @returns {Promise<{ durationMs: number, truncated: boolean, results: { command: string, columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number }[] }>} the result.
 */
export async function pgQuery(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  const sql = requiredText(input.sql, 'sql')
  const maxRows = Number.isInteger(input.maxRows) && input.maxRows > 0 ? Number(input.maxRows) : DEFAULT_MAX_ROWS
  const maxBytes = Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? Number(input.maxBytes) : DEFAULT_MAX_BYTES
  return withDatabase(connection, database, (client) => client.query(sql, { maxRows, maxBytes }))
}

/**
 * List the visible server sessions from `pg_stat_activity`.
 *
 * Timestamps are ISO-8601 strings so the browser can format them; `querySeconds`
 * is the age of the current (or last) statement and `query` is truncated to 500
 * characters by the server. Background processes show null state/query fields.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string }} [options] - optional database override.
 * @returns {Promise<{ pid: number, user: string|null, database: string|null, state: string|null, client: string|null, applicationName: string|null, backendStart: string|null, queryStart: string|null, querySeconds: number|null, query: string|null, waitEvent: string|null }[]>} the sessions.
 */
export async function pgActivity(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  return withDatabase(connection, database, async (client) => {
    const { results } = await client.query(ACTIVITY_SQL, {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    return rowsOf(results).map((row) => ({
      pid: toInteger(row[0]) ?? 0,
      user: nullableText(row[1]),
      database: nullableText(row[2]),
      state: nullableText(row[3]),
      client: nullableText(row[4]),
      applicationName: nullableText(row[5]),
      backendStart: nullableText(row[6]),
      queryStart: nullableText(row[7]),
      querySeconds: toNumber(row[8]),
      query: nullableText(row[10]),
      waitEvent: nullableText(row[9]),
    }))
  })
}

/**
 * Describe one relation: storage sizes, comment, columns, indexes, constraints.
 *
 * The schema and table names are bound as protocol parameters, and the
 * identifier-shaped parts of the catalog queries are constants, so caller text
 * can never change the statement's shape.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string, schema: string, table: string }} options - required schema and table.
 * @returns {Promise<{ size: { total: string|null, table: string|null, indexes: string|null, toast: string|null }, estimatedRows: number|null, comment: string|null, columns: { name: string, dataType: string, nullable: boolean, defaultValue: string|null }[], indexes: { name: string, definition: string, unique: boolean, primary: boolean }[], constraints: { name: string, type: string, definition: string }[] }>} the detail.
 */
export async function pgTableDetail(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  const schema = argumentText(input.schema, 'schema')
  const table = argumentText(input.table, 'table')
  return withDatabase(connection, database, async (client) => {
    const detail = await client.queryParams(TABLE_DETAIL_SQL, [schema, table], { maxRows: 2 })
    const row = rowsOf(detail.results)[0]
    if (row === undefined) throw relationNotFound(schema, table)
    const columns = await client.queryParams(COLUMNS_BY_NAME_SQL, [schema, table], {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    const indexes = await client.queryParams(INDEXES_SQL, [schema, table], {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    const constraints = await client.queryParams(CONSTRAINTS_SQL, [schema, table], {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    return {
      size: {
        total: nullableText(row[2]),
        table: nullableText(row[3]),
        indexes: nullableText(row[4]),
        toast: nullableText(row[5]),
      },
      estimatedRows: toInteger(row[0]),
      comment: nullableText(row[1]),
      columns: mapColumnRows(columns.results),
      indexes: rowsOf(indexes.results).map((index) => ({
        name: textValue(index[0]),
        definition: textValue(index[1]),
        unique: index[2] === 't',
        primary: index[3] === 't',
      })),
      constraints: rowsOf(constraints.results).map((constraint) => ({
        name: textValue(constraint[0]),
        type: constraintType(constraint[1]),
        definition: textValue(constraint[2]),
      })),
    }
  })
}

/**
 * Read one page of a table or view.
 *
 * Identifiers are quoted by this module and `orderBy` is accepted only when it
 * names an actual column of that relation, so caller text cannot change the
 * statement's shape. `limit` is clamped to 1..500 and `offset` to >= 0.
 * `limitedBy` is `'limit'` when the page came back full (or the byte cap stopped
 * it), null when the relation is exhausted.
 *
 * @param {object} connection - the connection.
 * @param {{ database?: string, schema: string, table: string, limit?: number, offset?: number, orderBy?: string, descending?: boolean, withCount?: boolean }} options - browse arguments.
 * @returns {Promise<{ columns: { name: string, dataType: string }[], rows: (string|null)[][], rowCount: number, totalRows: number|null, limitedBy: string|null }>} the page.
 */
export async function pgBrowse(connection, options = {}) {
  const input = optionsOf(options)
  const database = optionalText(input.database, 'database')
  const schema = argumentText(input.schema, 'schema')
  const table = argumentText(input.table, 'table')
  const limit = argumentInteger(input.limit, 'limit', 50, 1, 500)
  const offset = argumentInteger(input.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
  const descending = argumentBoolean(input.descending, 'descending')
  const withCount = argumentBoolean(input.withCount, 'withCount')
  /** @type {string|undefined} */
  let orderBy
  if (input.orderBy !== undefined && input.orderBy !== null && input.orderBy !== '') {
    if (typeof input.orderBy !== 'string') throw invalidArgument('orderBy', '"orderBy" must be a string')
    orderBy = input.orderBy
  }
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  return withDatabase(connection, database, async (client) => {
    const columnQuery = await client.queryParams(COLUMNS_BY_NAME_SQL, [schema, table], {
      maxRows: METADATA_MAX_ROWS,
      maxBytes: METADATA_MAX_BYTES,
    })
    const knownColumns = mapColumnRows(columnQuery.results)
    if (knownColumns.length === 0) throw relationNotFound(schema, table)
    if (orderBy !== undefined && !knownColumns.some((column) => column.name === orderBy)) {
      throw invalidArgument('orderBy', `"orderBy" is not a column of "${schema}.${table}"`)
    }
    const orderClause = orderBy === undefined ? '' : ` ORDER BY ${quoteIdentifier(orderBy)} ${descending ? 'DESC' : 'ASC'}`
    const data = await client.query(`SELECT * FROM ${relation}${orderClause} LIMIT ${limit} OFFSET ${offset}`, {
      maxRows: limit,
      maxBytes: DEFAULT_MAX_BYTES,
    })
    const resultSet = data.results[0]
    const rows = resultSet === undefined ? [] : resultSet.rows
    const columns = resultSet === undefined
      ? knownColumns.map((column) => ({ name: column.name, dataType: column.dataType }))
      : resultSet.columns
    let totalRows = null
    if (withCount) {
      const counted = await client.query(`SELECT count(*) AS total FROM ${relation}`, { maxRows: 1 })
      totalRows = toNumber(rowsOf(counted.results)[0]?.[0])
    }
    return {
      columns,
      rows,
      rowCount: rows.length,
      totalRows,
      limitedBy: rows.length === limit || data.truncated ? 'limit' : null,
    }
  })
}

export default {
  withPostgres,
  pgVersion,
  pgDatabases,
  pgTables,
  pgColumns,
  pgQuery,
  pgActivity,
  pgTableDetail,
  pgBrowse,
}
