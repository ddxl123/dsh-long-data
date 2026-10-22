/**
 * Tests for `src/postgres.js`.
 *
 * The interesting half is integration: a live PostgreSQL 18 container listens on
 * the documented local port and authenticates over SCRAM-SHA-256, so the
 * handshake, the catalogs, the activity view, table details, browsing and the
 * error mapping are exercised against a real server. The target can be moved
 * with `DSH_LONG_DATA_PG_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE`;
 * when the server (or its credentials) is not available the integration tests
 * skip instead of failing — `node --test` stays green on a machine without
 * Docker.
 *
 * The protocol-only paths a local server cannot demonstrate — SSL refusal,
 * cleartext/MD5 authentication, auth timeouts and the extended Query protocol
 * used for parameter binding — are covered by a tiny fake server built on
 * `node:net` in this file. Nothing here writes to PostgreSQL: the only
 * non-SELECT statements are BEGIN / ROLLBACK.
 *
 * Run: node --test test/postgres.test.js
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import test from 'node:test'

import {
  buildSslRequest,
  buildStartupMessage,
  computeMd5Password,
  parseErrorFields,
  pgActivity,
  pgBrowse,
  pgColumns,
  pgDatabases,
  pgQuery,
  pgTableDetail,
  pgTables,
  pgVersion,
  quoteIdentifier,
  quoteLiteral,
  withPostgres,
} from '../src/postgres.js'

/**
 * @param {string|undefined} value - environment value.
 * @param {string} fallback - used when the variable is absent.
 * @returns {string} the effective value.
 */
function envText(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** The integration target; overridable so the suite can follow other instances. */
const LIVE = Object.freeze({
  host: envText(process.env.DSH_LONG_DATA_PG_HOST, '127.0.0.1'),
  port: Number(envText(process.env.DSH_LONG_DATA_PG_PORT, '5432')),
  user: envText(process.env.DSH_LONG_DATA_PG_USER, 'postgres'),
  password: envText(process.env.DSH_LONG_DATA_PG_PASSWORD, ''),
  database: envText(process.env.DSH_LONG_DATA_PG_DATABASE, 'postgres'),
  ssl: 'prefer',
  timeoutMs: 5000,
})

/** Integration tests share these assertions about the local container. */
const LIVE_USER = LIVE.user
const LIVE_DATABASE = LIVE.database

/** The relation used for detail / browse tests: a real, read-only catalog table. */
const CATALOG = Object.freeze({ schema: 'pg_catalog', table: 'pg_database' })

/* ------------------------------------------------------------------ */
/* Fake server helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {number} value - int16 value.
 * @returns {Buffer} big-endian int16.
 */
function int16(value) {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeInt16BE(value, 0)
  return buffer
}

/**
 * @param {number} value - int32 value.
 * @returns {Buffer} big-endian int32.
 */
function int32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeInt32BE(value, 0)
  return buffer
}

/**
 * @param {string} value - the text.
 * @returns {Buffer} the NUL-terminated text.
 */
function cstr(value) {
  return Buffer.from(`${value}\0`, 'utf8')
}

/**
 * @param {string} type - message type byte.
 * @param {Buffer} [payload] - message body.
 * @returns {Buffer} the framed backend message.
 */
function frame(type, payload = Buffer.alloc(0)) {
  const header = Buffer.allocUnsafe(5)
  header[0] = type.charCodeAt(0)
  header.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([header, payload])
}

/**
 * @param {number} code - authentication request code.
 * @param {Buffer} [extra] - code-specific data.
 * @returns {Buffer} an Authentication message.
 */
function authentication(code, extra = Buffer.alloc(0)) {
  return frame('R', Buffer.concat([int32(code), extra]))
}

/**
 * @returns {Buffer} ReadyForQuery with an idle transaction status.
 */
function readyForQuery() {
  return frame('Z', Buffer.from('I'))
}

/**
 * @param {string|null} value - a text value.
 * @returns {string|null} the payload without its trailing NUL.
 */
function stripNul(payload) {
  const end = payload.indexOf(0)
  return payload.toString('utf8', 0, end === -1 ? payload.length : end)
}

/** Incremental framing reader used by the fake server. */
class WireReader {
  #socket
  #iterator
  #buffer = Buffer.alloc(0)

  /**
   * @param {import('node:net').Socket} socket - the accepted connection.
   */
  constructor(socket) {
    this.#socket = socket
    this.#iterator = socket[Symbol.asyncIterator]()
  }

  /**
   * @param {number} count - exact byte count.
   * @returns {Promise<Buffer>} the bytes.
   */
  async read(count) {
    while (this.#buffer.length < count) {
      const { value, done } = await this.#iterator.next()
      if (done === true) throw new Error('fake server: the client closed the connection')
      this.#buffer = Buffer.concat([this.#buffer, value])
    }
    const out = this.#buffer.subarray(0, count)
    this.#buffer = this.#buffer.subarray(count)
    return out
  }

  /**
   * @returns {Promise<Buffer>} the untyped startup message body (after its length).
   */
  async readStartup() {
    const header = await this.read(4)
    const length = header.readInt32BE(0)
    assert.ok(length >= 8, `implausible startup length ${length}`)
    return this.read(length - 4)
  }

  /**
   * @returns {Promise<{ type: string, payload: Buffer }>} one typed frontend message.
   */
  async readMessage() {
    const header = await this.read(5)
    const length = header.readInt32BE(1)
    assert.ok(length >= 4, `implausible message length ${length}`)
    return { type: String.fromCharCode(header[0]), payload: await this.read(length - 4) }
  }
}

/**
 * @param {Buffer} body - a startup body (protocol int32 + key/value cstrings).
 * @returns {Record<string, string>} the startup parameters.
 */
function parseStartupParameters(body) {
  assert.equal(body.readInt32BE(0), 196608, 'expected protocol 3.0')
  const parts = []
  let offset = 4
  while (offset < body.length) {
    const end = body.indexOf(0, offset)
    if (end === -1) break
    parts.push(body.toString('utf8', offset, end))
    offset = end + 1
  }
  const parameters = {}
  for (let index = 0; index + 1 < parts.length; index += 2) parameters[parts[index]] = parts[index + 1]
  return parameters
}

/**
 * Start a throwaway TCP server that speaks just enough PostgreSQL to test the
 * client. Each connection is delegated to `onConnection(reader, socket)`; its
 * failures are intentionally swallowed so a closed client cannot crash tests.
 *
 * @param {(reader: WireReader, socket: import('node:net').Socket) => Promise<void> | void} onConnection - connection handler.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} server handle.
 */
async function startFakeServer(onConnection) {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    Promise.resolve(onConnection(new WireReader(socket), socket)).catch(() => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Respond to the startup message of a plaintext fake connection.
 *
 * @param {WireReader} reader - the connection reader.
 * @returns {Promise<Record<string, string>>} the startup parameters.
 */
async function readPlainStartup(reader) {
  const body = await reader.readStartup()
  return parseStartupParameters(body)
}

/**
 * Finish a fake handshake with AuthenticationOk, parameters and ReadyForQuery.
 *
 * @param {import('node:net').Socket} socket - the connection.
 * @param {string} [version] - the advertised server_version.
 * @returns {void}
 */
function completeHandshake(socket, version = 'fake-1') {
  socket.write(Buffer.concat([
    authentication(0),
    frame('S', Buffer.concat([cstr('server_version'), cstr(version)])),
    frame('S', Buffer.concat([cstr('server_encoding'), cstr('UTF8')])),
    frame('K', Buffer.concat([int32(4242), int32(99)])),
    readyForQuery(),
  ]))
}

/** @returns {Buffer} a one-column int4 RowDescription. */
function answerRowDescription() {
  return frame('T', Buffer.concat([
    int16(1),
    cstr('answer'),
    int32(0),
    int16(0),
    int32(23),
    int16(4),
    int32(-1),
    int16(0),
  ]))
}

/** @returns {Buffer} a one-column int4 DataRow holding "1". */
function answerDataRow() {
  return frame('D', Buffer.concat([int16(1), int32(1), Buffer.from('1')]))
}

/**
 * @param {Buffer} payload - a Parse message body.
 * @returns {{ name: string, sql: string, parameterCount: number }} the parsed statement.
 */
function parseParseMessage(payload) {
  const nameEnd = payload.indexOf(0, 0)
  const name = payload.toString('utf8', 0, nameEnd)
  const sqlEnd = payload.indexOf(0, nameEnd + 1)
  const sql = payload.toString('utf8', nameEnd + 1, sqlEnd)
  const parameterCount = payload.readInt16BE(sqlEnd + 1)
  return { name, sql, parameterCount }
}

/**
 * @param {Buffer} payload - a Bind message body.
 * @returns {{ parameters: (string|null)[] }} the bound text values.
 */
function parseBindMessage(payload) {
  let offset = 0
  /** @returns {string} the next NUL-terminated string. */
  const readCString = () => {
    const end = payload.indexOf(0, offset)
    const value = payload.toString('utf8', offset, end)
    offset = end + 1
    return value
  }
  readCString() // portal
  readCString() // statement
  const formatCount = payload.readInt16BE(offset)
  offset += 2 + formatCount * 2
  const parameterCount = payload.readInt16BE(offset)
  offset += 2
  const parameters = []
  for (let index = 0; index < parameterCount; index += 1) {
    const length = payload.readInt32BE(offset)
    offset += 4
    if (length === -1) {
      parameters.push(null)
      continue
    }
    parameters.push(payload.toString('utf8', offset, offset + length))
    offset += length
  }
  return { parameters }
}

/* ------------------------------------------------------------------ */
/* Integration availability probe                                      */
/* ------------------------------------------------------------------ */

/** @type {false | string} */
let liveSkipReason = false
try {
  await pgVersion({ ...LIVE, timeoutMs: 2500 })
} catch (error) {
  liveSkipReason = `live PostgreSQL unavailable: ${error instanceof Error ? error.code ?? error.message : String(error)}`
}

/**
 * Register a test that skips cleanly when the local container is not usable.
 *
 * @param {string} name - test name.
 * @param {() => Promise<void>} fn - test body.
 * @returns {void}
 */
function liveTest(name, fn) {
  test(name, { skip: liveSkipReason, timeout: 45000 }, fn)
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('buildStartupMessage frames protocol 3.0 and its parameters', () => {
  const message = buildStartupMessage({ user: 'u', database: 'd', applicationName: 'app' })
  assert.ok(Buffer.isBuffer(message))
  assert.equal(message.readInt32BE(0), message.length, 'the length prefix covers the whole message')
  assert.equal(message.readInt32BE(4), 196608)
  const body = message.subarray(4)
  const parameters = parseStartupParameters(body)
  assert.deepEqual(parameters, {
    user: 'u',
    database: 'd',
    client_encoding: 'UTF8',
    application_name: 'app',
  })
  assert.equal(body[body.length - 1], 0, 'the startup body ends with a NUL terminator')
})

test('buildStartupMessage defaults the application name', () => {
  const parameters = parseStartupParameters(buildStartupMessage({ user: 'u', database: 'd' }).subarray(4))
  assert.equal(parameters.application_name, 'dsh-long-data')
})

test('buildSslRequest is the 8-byte 80877103 request', () => {
  const request = buildSslRequest()
  assert.equal(request.length, 8)
  assert.equal(request.readInt32BE(0), 8)
  assert.equal(request.readInt32BE(4), 80877103)
})

test('quoteLiteral escapes quotes, backslashes and rejects NUL', () => {
  assert.equal(quoteLiteral('public'), "E'public'")
  assert.equal(quoteLiteral("a'b"), "E'a''b'")
  assert.equal(quoteLiteral('a\\b'), "E'a\\\\b'")
  assert.throws(() => quoteLiteral('a\0b'), (error) => error.code === 'invalid_payload')
})

test('quoteIdentifier doubles embedded double quotes and rejects NUL', () => {
  assert.equal(quoteIdentifier('users'), '"users"')
  assert.equal(quoteIdentifier('my table'), '"my table"')
  assert.equal(quoteIdentifier('a"b'), '"a""b"')
  assert.equal(quoteIdentifier('MixedCase'), '"MixedCase"')
  assert.throws(() => quoteIdentifier(''), (error) => error.code === 'pg_invalid_argument')
  assert.throws(() => quoteIdentifier('a\0b'), (error) => error.code === 'pg_invalid_argument')
})

test('parseErrorFields reads the ErrorResponse letter codes', () => {
  const payload = Buffer.concat([
    Buffer.from('SERROR\0', 'utf8'),
    Buffer.from('VERROR\0', 'utf8'),
    Buffer.from('C42601\0', 'utf8'),
    Buffer.from('Msyntax error at or near "where"\0', 'utf8'),
    Buffer.from('Ddetail here\0', 'utf8'),
    Buffer.from('Hhint here\0', 'utf8'),
    Buffer.from('P13\0', 'utf8'),
    Buffer.from([0]),
  ])
  const fields = parseErrorFields(payload)
  assert.equal(fields.S, 'ERROR')
  assert.equal(fields.C, '42601')
  assert.equal(fields.M, 'syntax error at or near "where"')
  assert.equal(fields.D, 'detail here')
  assert.equal(fields.H, 'hint here')
  assert.equal(fields.P, '13')
})

test('computeMd5Password matches the two-stage MD5 response', () => {
  const salt = Buffer.from([0x01, 0x02, 0x03, 0x04])
  const inner = createHash('md5').update('secretpostgres').digest('hex')
  const outer = createHash('md5').update(Buffer.from(inner, 'utf8')).update(salt).digest('hex')
  assert.equal(computeMd5Password('postgres', 'secret', salt), `md5${outer}`)
})

test('invalid connection objects fail fast with pg_invalid_connection', async () => {
  await assert.rejects(pgVersion(null), (error) => error.code === 'pg_invalid_connection')
  await assert.rejects(
    pgVersion({ port: LIVE.port, user: 'u', database: 'd' }),
    (error) => error.code === 'pg_invalid_connection' && error.details.field === 'host',
  )
  await assert.rejects(
    pgVersion({ ...LIVE, ssl: 'sometimes' }),
    (error) => error.code === 'pg_invalid_connection' && error.details.field === 'ssl',
  )
  await assert.rejects(
    pgDatabases({ ...LIVE, port: 70000 }),
    (error) => error.code === 'pg_invalid_connection' && error.details.field === 'port',
  )
})

test('request validation happens before any network connection', async () => {
  // A dead port proves these throw before a socket is opened.
  const dead = { ...LIVE, port: 1, timeoutMs: 1500 }
  await assert.rejects(
    pgQuery(dead, { maxRows: 10 }),
    (error) => error.code === 'invalid_payload' && error.details.field === 'sql',
  )
  await assert.rejects(
    pgColumns(dead, { table: 't' }),
    (error) => error.code === 'invalid_payload' && error.details.field === 'schema',
  )
  await assert.rejects(
    pgColumns(dead, { schema: 'public' }),
    (error) => error.code === 'invalid_payload' && error.details.field === 'table',
  )
  await assert.rejects(
    pgVersion(dead, { database: '  ' }),
    (error) => error.code === 'invalid_payload' && error.details.field === 'database',
  )
})

test('v0.3 argument validation happens before any network connection', async () => {
  const dead = { ...LIVE, port: 1, timeoutMs: 1500 }
  await assert.rejects(
    pgTableDetail(dead, { table: 'pg_database' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'schema',
  )
  await assert.rejects(
    pgTableDetail(dead, { schema: 'pg_catalog' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'table',
  )
  await assert.rejects(
    pgBrowse(dead, { table: 'pg_database' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'schema',
  )
  await assert.rejects(
    pgBrowse(dead, { schema: 'pg_catalog' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'table',
  )
  await assert.rejects(
    pgBrowse(dead, { ...CATALOG, limit: 'many' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'limit',
  )
  await assert.rejects(
    pgBrowse(dead, { ...CATALOG, offset: 'later' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'offset',
  )
  await assert.rejects(
    pgBrowse(dead, { ...CATALOG, descending: 'yes' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'descending',
  )
  await assert.rejects(
    pgBrowse(dead, { ...CATALOG, withCount: 1 }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'withCount',
  )
  await assert.rejects(
    pgBrowse(dead, { ...CATALOG, orderBy: 42 }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'orderBy',
  )
})

/* ------------------------------------------------------------------ */
/* Protocol paths against a fake server                                */
/* ------------------------------------------------------------------ */

test('ssl: require fails with pg_ssl_failed when the server refuses SSL', async () => {
  const server = await startFakeServer(async (reader, socket) => {
    const request = await reader.readStartup()
    assert.equal(request.readInt32BE(0), 80877103, 'client must send an SSLRequest first')
    socket.write(Buffer.from('N'))
  })
  try {
    await assert.rejects(
      pgVersion({ ...LIVE, port: server.port, ssl: 'require', timeoutMs: 2500 }),
      (error) => error.code === 'pg_ssl_failed',
    )
  } finally {
    await server.close()
  }
})

test('ssl: prefer falls back to plaintext and the session still works', async () => {
  const FAKE_PASSWORD = 'test-password'
  const server = await startFakeServer(async (reader, socket) => {
    const request = await reader.readStartup()
    assert.equal(request.readInt32BE(0), 80877103)
    socket.write(Buffer.from('N'))
    const parameters = await readPlainStartup(reader)
    assert.equal(parameters.user, LIVE.user)
    assert.equal(parameters.database, LIVE.database)
    socket.write(authentication(3)) // cleartext
    const password = await reader.readMessage()
    assert.equal(password.type, 'p')
    assert.equal(stripNul(password.payload), FAKE_PASSWORD)
    completeHandshake(socket)
    const query = await reader.readMessage()
    assert.equal(query.type, 'Q')
    assert.equal(stripNul(query.payload), 'select 1 as answer')
    socket.write(Buffer.concat([
      answerRowDescription(),
      answerDataRow(),
      frame('C', cstr('SELECT 1')),
      readyForQuery(),
    ]))
  })
  try {
    const observed = await withPostgres(
      { ...LIVE, password: FAKE_PASSWORD, port: server.port, ssl: 'prefer', timeoutMs: 3000 },
      async (client) => {
        assert.equal(client.serverVersion, 'fake-1')
        assert.equal(client.backendProcessId, 4242)
        assert.equal(client.transactionStatus, 'I')
        return client.query('select 1 as answer')
      },
    )
    assert.equal(observed.truncated, false)
    assert.equal(observed.results.length, 1)
    assert.deepEqual(observed.results[0].columns, [{ name: 'answer', dataType: 'int4' }])
    assert.deepEqual(observed.results[0].rows, [['1']])
    assert.equal(observed.results[0].rowCount, 1)
    assert.equal(typeof observed.durationMs, 'number')
  } finally {
    await server.close()
  }
})

test('auth: MD5 challenges are answered with md5(md5(password+user)+salt)', async () => {
  const FAKE_PASSWORD = 'test-password'
  const salt = Buffer.from([0xde, 0xad, 0xbe, 0xef])
  const server = await startFakeServer(async (reader, socket) => {
    await readPlainStartup(reader)
    socket.write(authentication(5, salt))
    const password = await reader.readMessage()
    const inner = createHash('md5').update(`${FAKE_PASSWORD}${LIVE.user}`).digest('hex')
    const outer = createHash('md5').update(Buffer.from(inner, 'utf8')).update(salt).digest('hex')
    assert.equal(stripNul(password.payload), `md5${outer}`)
    completeHandshake(socket)
  })
  try {
    const outcome = await withPostgres(
      { ...LIVE, password: FAKE_PASSWORD, port: server.port, ssl: 'disable', timeoutMs: 3000 },
      async (client) => client.serverVersion,
    )
    assert.equal(outcome, 'fake-1')
  } finally {
    await server.close()
  }
})

test('auth: a server that asks for a password fails with pg_auth_required when none is set', async () => {
  const server = await startFakeServer(async (reader, socket) => {
    await readPlainStartup(reader)
    socket.write(authentication(3))
  })
  try {
    await assert.rejects(
      pgVersion({ ...LIVE, port: server.port, ssl: 'disable', password: '', timeoutMs: 2500 }),
      (error) => error.code === 'pg_auth_required',
    )
  } finally {
    await server.close()
  }
})

test('auth: an unsupported authentication request fails with pg_unsupported_auth', async () => {
  const server = await startFakeServer(async (reader, socket) => {
    await readPlainStartup(reader)
    socket.write(authentication(7)) // GSSAPI: not implemented
  })
  try {
    await assert.rejects(
      pgVersion({ ...LIVE, port: server.port, ssl: 'disable', timeoutMs: 2500 }),
      (error) => error.code === 'pg_unsupported_auth' && error.details.authCode === 7,
    )
  } finally {
    await server.close()
  }
})

test('timeouts: a silent server fails with pg_timeout', async () => {
  const server = await startFakeServer(async (reader, socket) => {
    await new Promise((resolve) => socket.once('close', resolve))
  })
  try {
    await assert.rejects(
      pgVersion({ ...LIVE, port: server.port, ssl: 'disable', timeoutMs: 300 }),
      (error) => error.code === 'pg_timeout',
    )
  } finally {
    await server.close()
  }
})

test('timeouts: a query that never finishes fails with pg_timeout', async () => {
  const server = await startFakeServer(async (reader, socket) => {
    await readPlainStartup(reader)
    completeHandshake(socket)
    await reader.readMessage() // the query arrives; intentionally never answered
    await new Promise((resolve) => socket.once('close', resolve))
  })
  try {
    await assert.rejects(
      withPostgres(
        { ...LIVE, port: server.port, ssl: 'disable', timeoutMs: 400 },
        (client) => client.query('select 1'),
      ),
      (error) => error.code === 'pg_timeout',
    )
  } finally {
    await server.close()
  }
})

test('unreachable: a closed port fails with pg_unreachable', async () => {
  const probe = await startFakeServer(async () => {})
  const port = probe.port
  await probe.close()
  await assert.rejects(
    pgVersion({ ...LIVE, port, ssl: 'disable', timeoutMs: 1500 }),
    (error) => error.code === 'pg_unreachable' && error.details.port === port,
  )
})

test('extended protocol: queryParams binds text parameters and reads the row', async () => {
  /** @type {{ sql: string, parameters: (string|null)[], size: number } | null} */
  let observed = null
  const server = await startFakeServer(async (reader, socket) => {
    await readPlainStartup(reader)
    completeHandshake(socket)
    const parse = await reader.readMessage()
    assert.equal(parse.type, 'P')
    const parsed = parseParseMessage(parse.payload)
    const bind = await reader.readMessage()
    assert.equal(bind.type, 'B')
    const { parameters } = parseBindMessage(bind.payload)
    const describe = await reader.readMessage()
    assert.equal(describe.type, 'D')
    assert.equal(describe.payload[0], 0x50, 'Describe targets a portal')
    const execute = await reader.readMessage()
    assert.equal(execute.type, 'E')
    const sync = await reader.readMessage()
    assert.equal(sync.type, 'S')
    observed = { sql: parsed.sql, parameters, size: parsed.parameterCount }
    // Echo the bound value back as a text-format row.
    const text = parameters[0] ?? 'null'
    socket.write(Buffer.concat([
      frame('1'),
      frame('2'),
      answerRowDescription(),
      frame('D', Buffer.concat([int16(1), int32(Buffer.byteLength(text, 'utf8')), Buffer.from(text, 'utf8')])),
      frame('C', cstr('SELECT 1')),
      readyForQuery(),
    ]))
  })
  try {
    const result = await withPostgres(
      { ...LIVE, port: server.port, ssl: 'disable', timeoutMs: 3000 },
      (client) => client.queryParams('SELECT $1::text AS answer', ['héllo']),
    )
    assert.equal(observed.sql, 'SELECT $1::text AS answer')
    assert.equal(observed.size, 0, 'parameter types are inferred by the server')
    assert.deepEqual(observed.parameters, ['héllo'])
    assert.equal(result.truncated, false)
    assert.deepEqual(result.results[0].columns, [{ name: 'answer', dataType: 'int4' }])
    assert.deepEqual(result.results[0].rows, [['héllo']])
    assert.equal(result.results[0].rowCount, 1)
  } finally {
    await server.close()
  }
})

test('extended protocol: queryParams reports server errors as pg_query_failed', async () => {
  const server = await startFakeServer(async (reader, socket) => {
    await readPlainStartup(reader)
    completeHandshake(socket)
    await reader.readMessage() // Parse
    socket.write(Buffer.concat([
      frame('E', Buffer.concat([
        Buffer.from('SERROR\0', 'utf8'),
        Buffer.from('C42601\0', 'utf8'),
        Buffer.from('Msyntax error\0', 'utf8'),
        Buffer.from([0]),
      ])),
      readyForQuery(),
    ]))
  })
  try {
    await assert.rejects(
      withPostgres(
        { ...LIVE, port: server.port, ssl: 'disable', timeoutMs: 3000 },
        (client) => client.queryParams('SELECT $1', ['x']),
      ),
      (error) => error.code === 'pg_query_failed' && error.details.sqlState === '42601',
    )
  } finally {
    await server.close()
  }
})

/* ------------------------------------------------------------------ */
/* Integration: live PostgreSQL 18 over SCRAM-SHA-256                  */
/* ------------------------------------------------------------------ */

liveTest('withPostgres completes the SCRAM handshake and runs a query', async () => {
  const observed = await withPostgres(LIVE, async (client) => {
    assert.match(client.serverVersion ?? '', /^18\./)
    assert.equal(client.parameters.server_encoding, 'UTF8')
    const result = await client.query('SELECT 1 AS answer')
    return { result, status: client.transactionStatus }
  })
  assert.equal(observed.status, 'I')
  assert.equal(observed.result.truncated, false)
  assert.equal(observed.result.results.length, 1)
  assert.deepEqual(observed.result.results[0].columns, [{ name: 'answer', dataType: 'int4' }])
  assert.deepEqual(observed.result.results[0].rows, [['1']])
  assert.equal(typeof observed.result.durationMs, 'number')
  assert.ok(observed.result.durationMs >= 0)
})

liveTest('withPostgres drains a failed statement and keeps the session usable', async () => {
  const [failure, after] = await withPostgres(LIVE, async (client) => {
    let caught = null
    try {
      await client.query('SELECT FROM WHERE')
    } catch (error) {
      caught = error
    }
    const next = await client.query('SELECT 7 AS seven')
    return [caught, next]
  })
  assert.notEqual(failure, null)
  assert.equal(failure.name, 'DataError')
  assert.equal(failure.code, 'pg_query_failed')
  assert.equal(failure.details.sqlState, '42601')
  assert.deepEqual(after.results[0].rows, [['7']])
})

liveTest('withPostgres reports transaction status through BEGIN and ROLLBACK', async () => {
  const statuses = await withPostgres(LIVE, async (client) => {
    const seen = [client.transactionStatus]
    await client.query('BEGIN')
    seen.push(client.transactionStatus)
    await client.query('SELECT 1')
    await client.query('ROLLBACK')
    seen.push(client.transactionStatus)
    return seen
  })
  assert.deepEqual(statuses, ['I', 'T', 'I'])
})

liveTest('pgVersion returns version, current user and current database', async () => {
  const version = await pgVersion(LIVE)
  assert.deepEqual(Object.keys(version).sort(), ['currentDatabase', 'currentUser', 'version'])
  assert.match(version.version, /^PostgreSQL \d+\./)
  assert.equal(version.currentUser, LIVE_USER)
  assert.equal(version.currentDatabase, LIVE_DATABASE)
})

liveTest('pgDatabases lists connectable, non-template databases with size and connection counts', async () => {
  const databases = await pgDatabases(LIVE)
  assert.ok(Array.isArray(databases))
  assert.ok(databases.length > 0)
  const names = databases.map((database) => database.name)
  assert.ok(names.includes(LIVE_DATABASE))
  assert.ok(names.every((name) => !name.startsWith('template')))
  for (const database of databases) {
    assert.equal(typeof database.name, 'string')
    assert.equal(typeof database.owner, 'string')
    assert.equal(typeof database.encoding, 'string')
    assert.equal(typeof database.size, 'string')
    assert.ok(database.sizeBytes === null || Number.isInteger(database.sizeBytes))
    assert.ok(database.connections === null || Number.isInteger(database.connections), 'connections is a count')
  }
  const live = databases.find((database) => database.name === LIVE_DATABASE)
  assert.equal(live.owner, LIVE_USER)
  assert.equal(live.encoding, 'UTF8')
  assert.ok(live.sizeBytes > 0)
  // The listing itself runs on a session connected to this database.
  assert.ok(live.connections >= 1)
})

liveTest('pgTables lists catalog relations, enriches them and honours the schema filter', async () => {
  const tables = await pgTables(LIVE)
  assert.ok(Array.isArray(tables))
  assert.ok(tables.length > 0)
  const kinds = new Set(['table', 'view', 'materialized view', 'foreign table'])
  const sizePattern = /^\d+(\.\d+)? (bytes|kB|MB|GB|TB|PB)$/
  for (const table of tables.slice(0, 100)) {
    assert.equal(typeof table.schema, 'string')
    assert.ok(table.schema.length > 0)
    assert.equal(typeof table.name, 'string')
    assert.ok(table.name.length > 0)
    assert.ok(kinds.has(table.kind), `unexpected kind ${table.kind}`)
    assert.ok(table.estimatedRows === null || Number.isInteger(table.estimatedRows))
    assert.ok(table.sizeBytes === null || Number.isInteger(table.sizeBytes), 'sizeBytes is a number or null')
    assert.ok(table.size === null || sizePattern.test(table.size), `unexpected size ${table.size}`)
    assert.ok(table.comment === null || typeof table.comment === 'string')
    assert.ok(table.columnCount === null || Number.isInteger(table.columnCount))
    if (table.kind === 'table' || table.kind === 'materialized view') {
      assert.ok(Number.isInteger(table.sizeBytes) && table.sizeBytes >= 0, `expected storage for ${table.name}`)
      assert.ok(Number.isInteger(table.columnCount) && table.columnCount >= 1)
    } else {
      assert.equal(table.sizeBytes, null, 'views have no storage')
      assert.equal(table.size, null)
    }
  }
  // The enrichment must agree with a direct catalog query.
  const sample = tables.find((table) => table.kind === 'table')
  assert.ok(sample, 'expected at least one ordinary table outside the system schemas')
  const qualified = `${quoteIdentifier(sample.schema)}.${quoteIdentifier(sample.name)}`
  const direct = await pgQuery(LIVE, {
    sql: `SELECT pg_total_relation_size(${quoteLiteral(qualified)}::regclass)`,
  })
  assert.equal(Number(direct.results[0].rows[0][0]), sample.sizeBytes)
  const publicTables = await pgTables(LIVE, { schema: 'public' })
  assert.ok(publicTables.every((table) => table.schema === 'public'))
  assert.ok(publicTables.length <= tables.length)
  assert.deepEqual(await pgTables(LIVE, { schema: '__dsh_long_data_missing__' }), [])
  // An explicit schema filter lists that schema even when it is a system one.
  const catalogTables = await pgTables(LIVE, { schema: 'pg_catalog' })
  assert.ok(catalogTables.every((table) => table.schema === 'pg_catalog'))
  const pgDatabase = catalogTables.find((table) => table.name === 'pg_database')
  assert.ok(pgDatabase, 'pg_catalog.pg_database is listed for an explicit schema filter')
  assert.equal(typeof pgDatabase.sizeBytes, 'number')
  assert.equal(typeof pgDatabase.columnCount, 'number')
})

liveTest('pgColumns describes an existing table', async () => {
  const tables = await pgTables(LIVE, { schema: 'public' })
  const target = tables.find((table) => table.kind === 'table') ?? tables[0]
  assert.ok(target, 'expected at least one relation in the public schema')
  const columns = await pgColumns(LIVE, { schema: target.schema, table: target.name })
  assert.ok(Array.isArray(columns))
  assert.ok(columns.length > 0)
  for (const column of columns) {
    assert.equal(typeof column.name, 'string')
    assert.ok(column.name.length > 0)
    assert.equal(typeof column.dataType, 'string')
    assert.ok(column.dataType.length > 0)
    assert.equal(typeof column.nullable, 'boolean')
    assert.ok(column.defaultValue === null || typeof column.defaultValue === 'string')
  }
  const catalogColumns = await pgColumns(LIVE, { schema: 'pg_catalog', table: 'pg_class' })
  assert.ok(catalogColumns.some((column) => column.name === 'oid'))
  assert.deepEqual(await pgColumns(LIVE, { schema: 'public', table: '__dsh_long_data_missing__' }), [])
})

liveTest('pgQuery returns text-format rows with NULL as null', async () => {
  const result = await pgQuery(LIVE, {
    sql: "SELECT 1::int4 AS one, NULL::text AS missing, 'hello'::text AS greeting, true AS flag",
  })
  assert.equal(result.truncated, false)
  assert.equal(result.results.length, 1)
  const resultSet = result.results[0]
  assert.equal(resultSet.command, 'SELECT')
  assert.equal(resultSet.rowCount, 1)
  assert.deepEqual(resultSet.columns.map((column) => column.name), ['one', 'missing', 'greeting', 'flag'])
  assert.deepEqual(resultSet.columns.map((column) => column.dataType), ['int4', 'text', 'text', 'bool'])
  assert.deepEqual(resultSet.rows, [['1', null, 'hello', 't']])
  assert.equal(typeof result.durationMs, 'number')
  assert.ok(result.durationMs >= 0)
})

liveTest('pgQuery truncates at maxRows but still reports the real row count', async () => {
  const truncated = await pgQuery(LIVE, { sql: 'SELECT generate_series(1, 25) AS n', maxRows: 5 })
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.results[0].rows.length, 5)
  assert.deepEqual(truncated.results[0].rows.map((row) => row[0]), ['1', '2', '3', '4', '5'])
  assert.equal(truncated.results[0].rowCount, 25)

  const exact = await pgQuery(LIVE, { sql: 'SELECT generate_series(1, 3) AS n', maxRows: 3 })
  assert.equal(exact.truncated, false)
  assert.equal(exact.results[0].rows.length, 3)
  assert.equal(exact.results[0].rowCount, 3)
})

liveTest('pgQuery truncates at maxBytes while draining the response', async () => {
  const result = await pgQuery(LIVE, {
    sql: 'SELECT repeat(chr(120), 600) AS padded FROM generate_series(1, 20)',
    maxRows: 100,
    maxBytes: 2000,
  })
  assert.equal(result.truncated, true)
  assert.ok(result.results[0].rows.length >= 1)
  assert.ok(result.results[0].rows.length <= 4)
  assert.equal(result.results[0].rows[0][0].length, 600)
  assert.equal(result.results[0].rowCount, 20)
})

liveTest('pgQuery maps a syntax error to pg_query_failed with SQLSTATE details', async () => {
  await assert.rejects(pgQuery(LIVE, { sql: 'SELECT FROM WHERE' }), (error) => {
    assert.equal(error.name, 'DataError')
    assert.equal(error.code, 'pg_query_failed')
    assert.deepEqual(Object.keys(error.details).sort(), ['detail', 'hint', 'position', 'sqlState'])
    assert.equal(error.details.sqlState, '42601')
    assert.equal(typeof error.details.position, 'number')
    assert.ok(error.details.position > 0)
    assert.match(error.message, /syntax error/)
    return true
  })
})

liveTest('pgQuery handles multiple result sets in one simple query', async () => {
  const result = await pgQuery(LIVE, { sql: 'SELECT 1 AS one; SELECT 2 AS two; BEGIN; ROLLBACK' })
  assert.equal(result.truncated, false)
  assert.deepEqual(result.results.map((resultSet) => resultSet.command), ['SELECT', 'SELECT', 'BEGIN', 'ROLLBACK'])
  assert.deepEqual(result.results[0].rows, [['1']])
  assert.deepEqual(result.results[1].rows, [['2']])
  assert.deepEqual(result.results[2].columns, [])
  assert.deepEqual(result.results[2].rows, [])
  assert.equal(result.results[2].rowCount, 0)
})

liveTest('pgQuery/pgVersion honour a per-call database override', async () => {
  const query = await pgQuery(LIVE, { database: 'postgres', sql: 'SELECT current_database() AS db' })
  assert.deepEqual(query.results[0].rows, [['postgres']])
  const version = await pgVersion(LIVE, { database: 'postgres' })
  assert.equal(version.currentDatabase, 'postgres')
  assert.equal(version.currentUser, LIVE_USER)
  const tables = await pgTables(LIVE, { database: 'postgres' })
  assert.ok(Array.isArray(tables))
})

liveTest('pgVersion works with ssl: disable', async () => {
  const version = await pgVersion({ ...LIVE, ssl: 'disable' })
  assert.equal(version.currentDatabase, LIVE_DATABASE)
})

liveTest('a wrong password maps to pg_auth_failed', async () => {
  await assert.rejects(
    pgVersion({ ...LIVE, password: 'definitely-not-the-password' }),
    (error) => error.code === 'pg_auth_failed' && error.details.sqlState === '28P01',
  )
})

liveTest('a missing password maps to pg_auth_required', async () => {
  await assert.rejects(
    pgVersion({ ...LIVE, password: '' }),
    (error) => error.code === 'pg_auth_required' && error.details.authMethod === 'SCRAM-SHA-256',
  )
})

liveTest('ssl: require either upgrades or fails with pg_ssl_failed', async () => {
  try {
    const version = await pgVersion({ ...LIVE, ssl: 'require' })
    assert.equal(version.currentDatabase, LIVE_DATABASE)
  } catch (error) {
    assert.equal(error.code, 'pg_ssl_failed')
  }
})

/* ------------------------------------------------------------------ */
/* v0.3 integration: activity, table detail, browse                    */
/* ------------------------------------------------------------------ */

liveTest('pgActivity lists visible sessions with typed, sorted fields', async () => {
  const sessions = await pgActivity(LIVE)
  assert.ok(Array.isArray(sessions))
  assert.ok(sessions.length > 0)
  const own = sessions.find((session) => session.database === LIVE_DATABASE)
  assert.ok(own, 'the current database has at least one visible session')
  assert.ok(
    sessions.some((session) => session.state === 'active' && typeof session.query === 'string' && session.query.includes('pg_stat_activity')),
    'the activity query itself appears as an active session',
  )
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
  for (const session of sessions) {
    assert.deepEqual(
      Object.keys(session).sort(),
      ['applicationName', 'backendStart', 'client', 'database', 'pid', 'query', 'querySeconds', 'queryStart', 'state', 'user', 'waitEvent'],
    )
    assert.ok(Number.isInteger(session.pid) && session.pid > 0)
    assert.ok(session.user === null || typeof session.user === 'string')
    assert.ok(session.database === null || typeof session.database === 'string')
    assert.ok(session.state === null || typeof session.state === 'string')
    assert.ok(session.client === null || typeof session.client === 'string')
    assert.ok(session.applicationName === null || typeof session.applicationName === 'string')
    assert.ok(session.backendStart === null || timestampPattern.test(session.backendStart))
    assert.ok(session.queryStart === null || timestampPattern.test(session.queryStart))
    assert.ok(session.querySeconds === null || (typeof session.querySeconds === 'number' && session.querySeconds >= 0))
    assert.ok(session.query === null || typeof session.query === 'string')
    assert.ok(session.query === null || [...session.query].length <= 500, 'query text is capped at 500 characters')
    assert.ok(session.waitEvent === null || typeof session.waitEvent === 'string')
    assert.ok(session.queryStart !== null || session.querySeconds === null, 'seconds only exist with a query start')
  }
  // ORDER BY state NULLS LAST, pid: null states trail, the rest are ascending,
  // and within one state group the pids are ascending too.
  const states = sessions.map((session) => session.state)
  const firstNull = states.indexOf(null)
  const notNull = firstNull === -1 ? states : states.slice(0, firstNull)
  assert.ok(notNull.every((state) => typeof state === 'string'))
  assert.ok(notNull.every((state, index) => index === 0 || notNull[index - 1] <= state), 'states are sorted')
  if (firstNull !== -1) assert.ok(states.slice(firstNull).every((state) => state === null), 'null states are last')
  /** @type {Map<string, number[]>} */
  const pidsByState = new Map()
  for (const session of sessions) {
    const key = session.state ?? '<null>'
    const group = pidsByState.get(key) ?? []
    group.push(session.pid)
    pidsByState.set(key, group)
  }
  for (const group of pidsByState.values()) {
    assert.deepEqual(group, [...group].sort((left, right) => left - right), 'pids ascend inside a state group')
  }
})

liveTest('pgActivity honours a database override', async () => {
  const sessions = await pgActivity(LIVE, { database: 'postgres' })
  assert.ok(Array.isArray(sessions))
  const version = await pgVersion(LIVE, { database: 'postgres' })
  assert.equal(version.currentDatabase, 'postgres')
})

liveTest('pgTableDetail describes a real table completely', async () => {
  const detail = await pgTableDetail(LIVE, CATALOG)
  assert.deepEqual(Object.keys(detail).sort(), ['columns', 'comment', 'constraints', 'estimatedRows', 'indexes', 'size'])
  assert.deepEqual(Object.keys(detail.size).sort(), ['indexes', 'table', 'toast', 'total'])
  const sizePattern = /^\d+(\.\d+)? (bytes|kB|MB|GB|TB|PB)$/
  for (const value of Object.values(detail.size)) {
    assert.equal(typeof value, 'string')
    assert.match(value, sizePattern)
  }
  assert.ok(detail.estimatedRows === null || Number.isInteger(detail.estimatedRows))
  assert.equal(detail.comment, null)

  assert.ok(detail.columns.length > 0)
  const columns = new Map(detail.columns.map((column) => [column.name, column]))
  assert.ok(columns.has('oid'))
  assert.equal(columns.get('oid').dataType, 'oid')
  assert.equal(columns.get('oid').nullable, false)
  assert.equal(columns.get('datname').dataType, 'name')
  for (const column of detail.columns) {
    assert.deepEqual(Object.keys(column).sort(), ['dataType', 'defaultValue', 'name', 'nullable'])
    assert.equal(typeof column.nullable, 'boolean')
    assert.ok(column.defaultValue === null || typeof column.defaultValue === 'string')
  }
  // Detail columns must agree with the dedicated columns API.
  assert.deepEqual(detail.columns, await pgColumns(LIVE, CATALOG))

  assert.ok(detail.indexes.length > 0)
  for (const index of detail.indexes) {
    assert.deepEqual(Object.keys(index).sort(), ['definition', 'name', 'primary', 'unique'])
    assert.equal(typeof index.unique, 'boolean')
    assert.equal(typeof index.primary, 'boolean')
    assert.match(index.definition, /CREATE .*INDEX/)
  }
  assert.ok(detail.indexes.some((index) => index.unique))
  assert.ok(detail.indexes.some((index) => index.primary))

  assert.ok(detail.constraints.length > 0)
  const constraintTypes = new Set(['check', 'foreign key', 'not null', 'primary key', 'trigger', 'unique', 'exclusion', 'other'])
  for (const constraint of detail.constraints) {
    assert.deepEqual(Object.keys(constraint).sort(), ['definition', 'name', 'type'])
    assert.ok(constraintTypes.has(constraint.type), `unexpected constraint type ${constraint.type}`)
    assert.ok(constraint.definition.length > 0)
  }
  assert.ok(detail.constraints.some((constraint) => constraint.type === 'primary key'))
})

liveTest('pgTableDetail handles views (no storage, no indexes/constraints)', async () => {
  const detail = await pgTableDetail(LIVE, { schema: 'information_schema', table: 'tables' })
  assert.deepEqual(detail.size, { total: null, table: null, indexes: null, toast: null })
  assert.ok(detail.columns.length > 0)
  assert.deepEqual(detail.indexes, [])
  assert.deepEqual(detail.constraints, [])
})

liveTest('pgTableDetail rejects a missing relation safely', async () => {
  await assert.rejects(
    pgTableDetail(LIVE, { schema: 'pg_catalog', table: '__dsh_long_data_missing__' }),
    (error) => error.code === 'pg_query_failed' && error.details.sqlState === '42P01',
  )
  // User text is bound as a parameter, so these never become SQL fragments.
  for (const schema of ["public' OR '1'='1", 'pg_catalog"; DROP TABLE pg_database; --', 'pg_catalog\\']) {
    await assert.rejects(
      pgTableDetail(LIVE, { schema, table: 'pg_database' }),
      (error) => error.code === 'pg_query_failed' && error.details.sqlState === '42P01',
    )
  }
})

liveTest('pgBrowse pages a real table with ORDER BY, offset and limits', async () => {
  const page = await pgBrowse(LIVE, CATALOG)
  assert.ok(Array.isArray(page.columns) && page.columns.length > 0)
  for (const column of page.columns) assert.deepEqual(Object.keys(column).sort(), ['dataType', 'name'])
  assert.ok(Array.isArray(page.rows))
  assert.ok(page.rows.length <= 50)
  assert.equal(page.rowCount, page.rows.length)
  assert.equal(page.totalRows, null)
  assert.equal(page.limitedBy, page.rows.length === 50 ? 'limit' : null)
  for (const row of page.rows) {
    assert.equal(row.length, page.columns.length)
    for (const value of row) assert.ok(value === null || typeof value === 'string', 'text-format values only')
  }
  const datnameIndex = page.columns.findIndex((column) => column.name === 'datname')
  assert.ok(datnameIndex >= 0)

  const ordered = await pgBrowse(LIVE, { ...CATALOG, limit: 2, offset: 0, orderBy: 'datname' })
  assert.equal(ordered.rowCount, 2)
  assert.equal(ordered.limitedBy, 'limit')
  const orderedNames = ordered.rows.map((row) => row[ordered.columns.findIndex((column) => column.name === 'datname')])
  assert.deepEqual(orderedNames, [...orderedNames].sort())

  const next = await pgBrowse(LIVE, { ...CATALOG, limit: 2, offset: 2, orderBy: 'datname' })
  const nextNames = next.rows.map((row) => row[next.columns.findIndex((column) => column.name === 'datname')])
  assert.equal(next.totalRows, null)
  if (nextNames.length > 0) assert.ok(orderedNames[orderedNames.length - 1] <= nextNames[0], 'pages do not overlap')

  const descending = await pgBrowse(LIVE, { ...CATALOG, limit: 500, orderBy: 'datname', descending: true })
  const descendingNames = descending.rows.map((row) => row[descending.columns.findIndex((column) => column.name === 'datname')])
  assert.deepEqual(descendingNames, [...descendingNames].sort().reverse())
  assert.equal(descending.limitedBy, null)
})

liveTest('pgBrowse counts rows with withCount and clamps limit/offset', async () => {
  const actual = await pgQuery(LIVE, { sql: 'SELECT count(*) FROM pg_catalog.pg_database' })
  const total = Number(actual.results[0].rows[0][0])
  assert.ok(total >= 2)

  const counted = await pgBrowse(LIVE, { ...CATALOG, limit: 2, withCount: true, orderBy: 'datname' })
  assert.equal(counted.totalRows, total)
  assert.equal(counted.rowCount, Math.min(2, total))
  assert.equal(counted.limitedBy, total > 2 ? 'limit' : null)

  const clampedLow = await pgBrowse(LIVE, { ...CATALOG, limit: 0, offset: -5, orderBy: 'datname' })
  assert.equal(clampedLow.rowCount, 1, 'limit is clamped to 1')
  assert.equal(clampedLow.totalRows, null)
  assert.equal(clampedLow.limitedBy, 'limit')

  const clampedHigh = await pgBrowse(LIVE, { ...CATALOG, limit: 9999, orderBy: 'datname' })
  assert.ok(clampedHigh.rowCount <= 500, 'limit is clamped to 500')
  assert.ok(clampedHigh.rowCount <= total)

  const empty = await pgBrowse(LIVE, { ...CATALOG, offset: 100000, withCount: true, orderBy: 'datname' })
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.rowCount, 0)
  assert.equal(empty.totalRows, total)
  assert.equal(empty.limitedBy, null)
  assert.ok(empty.columns.length > 0, 'the grid keeps its column headers when empty')
})

liveTest('pgBrowse only accepts real column names for orderBy', async () => {
  await assert.rejects(
    pgBrowse(LIVE, { ...CATALOG, orderBy: 'definitely_not_a_column' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'orderBy',
  )
  await assert.rejects(
    pgBrowse(LIVE, { ...CATALOG, orderBy: 'Datname' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'orderBy',
  )
  await assert.rejects(
    pgBrowse(LIVE, { ...CATALOG, orderBy: 'datname; DROP TABLE pg_database' }),
    (error) => error.code === 'pg_invalid_argument' && error.details.field === 'orderBy',
  )
})

liveTest('pgBrowse quotes identifiers and rejects unknown relations safely', async () => {
  await assert.rejects(
    pgBrowse(LIVE, { schema: 'pg_catalog"; DROP TABLE pg_database; --', table: 'pg_database' }),
    (error) => error.code === 'pg_query_failed' && error.details.sqlState === '42P01',
  )
  await assert.rejects(
    pgBrowse(LIVE, { schema: 'pg_catalog', table: 'pg_database"' }),
    (error) => error.code === 'pg_query_failed' && error.details.sqlState === '42P01',
  )
  // The catalog table is untouched after the injection attempts.
  const stillThere = await pgQuery(LIVE, { sql: 'SELECT count(*) FROM pg_catalog.pg_database' })
  assert.ok(Number(stillThere.results[0].rows[0][0]) >= 2)
})

liveTest('pgTableDetail and pgBrowse honour a database override', async () => {
  const detail = await pgTableDetail(LIVE, { database: 'postgres', ...CATALOG })
  assert.ok(detail.columns.length > 0)
  const page = await pgBrowse(LIVE, { database: 'postgres', ...CATALOG, limit: 1, orderBy: 'datname' })
  assert.equal(page.rowCount, 1)
  assert.ok(page.columns.some((column) => column.name === 'datname'))
})
