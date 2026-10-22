/**
 * Redis service tests.
 *
 * Three layers, so a missing Docker container never makes the file vacuous:
 *
 * 1. the RESP2 encoder and incremental parser are pure and tested directly;
 * 2. the client is driven against an in-process fake TCP server — handshake
 *    order, reply mapping, timeouts, the 2 MiB cap and socket cleanup are all
 *    deterministic and need no external service;
 * 3. the public API round-trips against the local Redis from the contract
 *    (`127.0.0.1:6379`, no password; override with
 *    DSH_LONG_DATA_REDIS_HOST / PORT / PASSWORD), skipping every live test with
 *    a printed reason when that server is unavailable. Every key the live tests
 *    create lives under `dsh-long-data:test:<pid>:` and is deleted afterwards;
 *    nothing here ever flushes the server.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { after, describe, test } from 'node:test'

import { DataError } from '../src/errors.js'
import {
  RespParser,
  encodeCommand,
  redisClients,
  redisDbSize,
  redisDelete,
  redisExpire,
  redisGet,
  redisHashSet,
  redisInfo,
  redisListPush,
  redisMemoryUsage,
  redisPersist,
  redisPing,
  redisRename,
  redisScan,
  redisSet,
  redisSetAdd,
  redisSetRemove,
  withRedis,
} from '../src/redis.js'

/* --------------------------------------------------------------- RESP bytes */

const CRLF = '\r\n'

/** @param {string} text - a simple string payload. @returns {Buffer} the reply. */
const simple = (text) => Buffer.from(`+${text}${CRLF}`)

/** @param {string} text - an error payload. @returns {Buffer} the reply. */
const errorReply = (text) => Buffer.from(`-${text}${CRLF}`)

/** @param {number} value - an integer payload. @returns {Buffer} the reply. */
const integer = (value) => Buffer.from(`:${value}${CRLF}`)

/** @param {string} text - a bulk string payload. @returns {Buffer} the reply. */
const bulk = (text) => Buffer.from(`$${Buffer.byteLength(text)}${CRLF}${text}${CRLF}`)

/** @returns {Buffer} a nil bulk-string reply. */
const nilBulk = () => Buffer.from(`$-1${CRLF}`)

/** @param {Buffer[]} items - encoded elements. @returns {Buffer} an array reply. */
const array = (items) => Buffer.concat([Buffer.from(`*${items.length}${CRLF}`), ...items])

/* ------------------------------------------------------------- fake server */

/** Fake servers started by this file, cleaned up in `after`. */
const fakeServers = []

/**
 * Start a RESP2-speaking fake server on an ephemeral port.
 *
 * The handler receives each parsed command (an array of strings) plus the raw
 * socket; returning a Buffer (or an array of Buffers) writes those replies,
 * returning nothing lets the test answer manually.
 *
 * @param {(command: string[], socket: import('node:net').Socket) => Buffer|Buffer[]|void} handler - reply logic.
 * @returns {Promise<{ server: import('node:net').Server, port: number, sockets: Set<import('node:net').Socket>, rawChunks: Buffer[], connection: object, close: () => Promise<void> }>} the fixture.
 */
async function startFakeServer(handler) {
  const sockets = new Set()
  const rawChunks = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    const parser = new RespParser()
    socket.on('data', (chunk) => {
      rawChunks.push(chunk)
      let commands
      try {
        parser.feed(chunk)
        commands = parser.take()
      } catch {
        socket.destroy()
        return
      }
      for (const command of commands) {
        let replies
        try {
          replies = handler(command, socket)
        } catch {
          socket.destroy()
          return
        }
        if (replies === undefined || replies === null) continue
        for (const buffer of Array.isArray(replies) ? replies : [replies]) socket.write(buffer)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const fake = {
    server,
    port,
    sockets,
    rawChunks,
    connection: { host: '127.0.0.1', port, username: '', password: '', db: 0, tls: false, timeoutMs: 1000 },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  fakeServers.push(fake)
  return fake
}

/**
 * Every byte the client wrote to a fake server, in order.
 *
 * @param {{ rawChunks: Buffer[] }} fake - the fixture.
 * @returns {Buffer} the concatenated request bytes.
 */
const sentBytes = (fake) => Buffer.concat(fake.rawChunks)

/**
 * Wait until a predicate holds, polling briefly.
 *
 * @param {() => boolean} predicate - the condition.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * @param {string} code - the expected DataError code.
 * @returns {(error: unknown) => true} an assertion helper for `assert.rejects`.
 */
const codeIs = (code) => (error) => {
  assert.ok(error instanceof DataError, `expected a DataError, got ${String(error)}`)
  assert.equal(error.code, code)
  return true
}

/* ------------------------------------------------------------ live Redis */

/** Default live server from the build contract; the env lets CI point elsewhere. */
const LIVE_PORT = Number(process.env.DSH_LONG_DATA_REDIS_PORT ?? '6379')

const LIVE_CONNECTION = {
  host: process.env.DSH_LONG_DATA_REDIS_HOST || '127.0.0.1',
  port: Number.isInteger(LIVE_PORT) && LIVE_PORT > 0 && LIVE_PORT <= 65535 ? LIVE_PORT : 6379,
  username: '',
  password: process.env.DSH_LONG_DATA_REDIS_PASSWORD ?? '',
  db: 0,
  tls: false,
  timeoutMs: 3000,
}

/** Every live key is created under this per-process prefix and deleted later. */
const LIVE_PREFIX = `dsh-long-data:test:${process.pid}:`

/** @type {{ skip: string|null, authRequired: boolean }} */
const live = { skip: null, authRequired: false }

try {
  await redisPing(LIVE_CONNECTION)
  try {
    await redisPing({ ...LIVE_CONNECTION, password: '' })
  } catch (error) {
    if (error instanceof DataError && error.code === 'redis_auth_required') live.authRequired = true
  }
} catch (error) {
  live.skip = `local Redis at ${LIVE_CONNECTION.host}:${LIVE_CONNECTION.port} is unavailable: ${error.message}`
  console.log(`# ${live.skip} — live Redis integration tests will be skipped`)
}
if (live.skip === null) {
  console.log(`# live Redis reachable at ${LIVE_CONNECTION.host}:${LIVE_CONNECTION.port}; integration tests enabled`)
}

/**
 * Register a live-server test that skips cleanly when the server is absent.
 *
 * @param {string} name - test name.
 * @param {() => Promise<void>} fn - the test body.
 * @returns {void}
 */
const liveTest = (name, fn) => {
  test(name, { skip: live.skip ?? false }, fn)
}

after(async () => {
  for (const fake of fakeServers.splice(0)) {
    try {
      await fake.close()
    } catch {
      // The test already failed or closed it; nothing else to do.
    }
  }
  if (live.skip !== null) return
  try {
    await withRedis(LIVE_CONNECTION, async (client) => {
      let cursor = '0'
      let guard = 0
      do {
        const reply = await client.command(['SCAN', cursor, 'MATCH', `${LIVE_PREFIX}*`, 'COUNT', '500'])
        const page = Array.isArray(reply) ? reply : []
        const keys = Array.isArray(page[1]) ? page[1] : []
        if (keys.length > 0) await client.command(['DEL', ...keys])
        cursor = typeof page[0] === 'string' ? page[0] : '0'
        guard += 1
        if (guard > 1000) break
      } while (cursor !== '0')
    })
  } catch {
    // Best effort: the unique prefix keeps a leftover isolated to this process.
  }
})

/* ---------------------------------------------------------------- codec */

describe('encodeCommand', () => {
  test('encodes commands as RESP2 arrays of bulk strings', () => {
    assert.deepEqual(encodeCommand(['PING']), Buffer.from('*1\r\n$4\r\nPING\r\n'))
    assert.deepEqual(
      encodeCommand(['SET', 'key', 'value']),
      Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n'),
    )
  })

  test('length-prefixes arguments, including CRLF and multi-byte text', () => {
    const command = ['SET', 'a b\r\n', 'héllo ✓']
    const parser = new RespParser()
    parser.feed(encodeCommand(command))
    assert.deepEqual(parser.take(), [command])
  })

  test('coerces numbers and preserves buffers', () => {
    const parser = new RespParser()
    parser.feed(encodeCommand(['SELECT', 3, Buffer.from('raw')]))
    assert.deepEqual(parser.take(), [['SELECT', '3', 'raw']])
  })

  test('rejects empty or missing arguments', () => {
    assert.throws(() => encodeCommand([]), TypeError)
    assert.throws(() => encodeCommand(null), TypeError)
  })
})

describe('RespParser', () => {
  test('parses every RESP2 reply type', () => {
    const parser = new RespParser()
    parser.feed(
      Buffer.from('+OK\r\n-ERR boom\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*3\r\n$1\r\na\r\n:1\r\n$-1\r\n*-1\r\n'),
    )
    const replies = parser.take()
    assert.equal(replies[0], 'OK')
    assert.ok(replies[1] instanceof Error)
    assert.equal(replies[1].message, 'ERR boom')
    assert.equal(replies[2], 42)
    assert.equal(replies[3], 'hello')
    assert.equal(replies[4], null)
    assert.deepEqual(replies[5], ['a', 1, null])
    assert.equal(replies[6], null)
  })

  test('returns nothing until a reply is complete, even split into single bytes', () => {
    const parser = new RespParser()
    const wire = Buffer.from('+PONG\r\n$5\r\nhello\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n')
    const received = []
    for (const byte of wire) {
      parser.feed(Buffer.from([byte]))
      received.push(...parser.take())
    }
    assert.deepEqual(received, ['PONG', 'hello', ['a', 'b']])
  })

  test('takes several replies from one chunk and keeps the remainder', () => {
    const parser = new RespParser()
    parser.feed(Buffer.from('+ONE\r\n+TWO\r\n+THR'))
    assert.deepEqual(parser.take(), ['ONE', 'TWO'])
    parser.feed(Buffer.from('EE\r\n'))
    assert.deepEqual(parser.take(), ['THREE'])
    assert.deepEqual(parser.take(), [])
  })

  test('handles nested arrays', () => {
    const parser = new RespParser()
    parser.feed(Buffer.from('*2\r\n*2\r\n:1\r\n:2\r\n*1\r\n$3\r\nend\r\n'))
    assert.deepEqual(parser.take(), [[[1, 2], ['end']]])
  })

  test('tolerates RESP3 map and set markers', () => {
    const parser = new RespParser()
    parser.feed(Buffer.from('%2\r\n+one\r\n:1\r\n+two\r\n:2\r\n~2\r\n+a\r\n+b\r\n'))
    assert.deepEqual(parser.take(), [{ one: 1, two: 2 }, ['a', 'b']])
  })

  test('enforces the reply cap', () => {
    const parser = new RespParser({ maxBytes: 32 })
    parser.feed(Buffer.from('$100\r\n'))
    assert.throws(
      () => parser.take(),
      (error) => error instanceof DataError && error.code === 'redis_command_failed' && error.details.limit === 32,
    )
    const defaultCap = new RespParser()
    defaultCap.feed(Buffer.from('$2097153\r\n'))
    assert.throws(
      () => defaultCap.take(),
      (error) =>
        error instanceof DataError &&
        error.code === 'redis_command_failed' &&
        error.details.limit === 2 * 1024 * 1024,
    )
    const flooded = new RespParser()
    assert.throws(
      () => flooded.feed(Buffer.alloc(2 * 1024 * 1024 + 1, 0x2b)),
      (error) => error instanceof DataError && error.code === 'redis_command_failed',
    )
  })

  test('rejects malformed replies with a DataError', () => {
    const badInteger = new RespParser()
    badInteger.feed(Buffer.from(':nope\r\n'))
    assert.throws(
      () => badInteger.take(),
      (error) => error instanceof DataError && error.code === 'redis_command_failed',
    )
    const badMarker = new RespParser()
    badMarker.feed(Buffer.from('?garbage\r\n'))
    assert.throws(
      () => badMarker.take(),
      (error) => error instanceof DataError && error.code === 'redis_command_failed',
    )
  })
})

/* --------------------------------------------------------------- client */

describe('withRedis over a fake server', () => {
  test('runs a command and closes the socket', async () => {
    const fake = await startFakeServer((command) => (command[0] === 'PING' ? simple('PONG') : simple('OK')))
    const result = await withRedis(fake.connection, (client) => client.command(['PING']))
    assert.equal(result, 'PONG')
    await waitFor(() => fake.sockets.size === 0)
  })

  test('sends AUTH with the username, then SELECT, before the first command', async () => {
    const seen = []
    const fake = await startFakeServer((command) => {
      seen.push(command)
      return command[0] === 'PING' ? simple('PONG') : simple('OK')
    })
    const connection = { ...fake.connection, username: 'app', password: 'secret', db: 2 }
    const result = await withRedis(connection, (client) => client.command(['PING']))
    assert.equal(result, 'PONG')
    assert.deepEqual(seen, [
      ['AUTH', 'app', 'secret'],
      ['SELECT', '2'],
      ['PING'],
    ])
  })

  test('AUTH without a username uses the single-argument form', async () => {
    const seen = []
    const fake = await startFakeServer((command) => {
      seen.push(command)
      return command[0] === 'PING' ? simple('PONG') : simple('OK')
    })
    await withRedis({ ...fake.connection, password: 'secret' }, (client) => client.command(['PING']))
    assert.deepEqual(seen[0], ['AUTH', 'secret'])
  })

  test('skips AUTH and SELECT when they are not configured', async () => {
    const seen = []
    const fake = await startFakeServer((command) => {
      seen.push(command)
      return simple('PONG')
    })
    await withRedis(fake.connection, (client) => client.command(['PING']))
    assert.deepEqual(seen, [['PING']])
  })

  test('reassembles a reply split across TCP chunks', async () => {
    const payload = bulk('hello world')
    const fake = await startFakeServer((command, socket) => {
      socket.write(payload.subarray(0, 6))
      setTimeout(() => socket.write(payload.subarray(6)), 5)
    })
    const result = await withRedis(fake.connection, (client) => client.command(['GET', 'x']))
    assert.equal(result, 'hello world')
  })

  test('maps NOAUTH to redis_auth_required', async () => {
    const fake = await startFakeServer((command) =>
      command[0] === 'PING' ? errorReply('NOAUTH Authentication required.') : simple('OK'),
    )
    await assert.rejects(
      withRedis(fake.connection, (client) => client.command(['PING'])),
      codeIs('redis_auth_required'),
    )
  })

  test('maps WRONGPASS during AUTH to redis_auth_failed', async () => {
    const fake = await startFakeServer(() =>
      errorReply('WRONGPASS invalid username-password pair or user is disabled.'),
    )
    await assert.rejects(
      withRedis({ ...fake.connection, password: 'nope' }, (client) => client.command(['PING'])),
      (error) => {
        assert.ok(error instanceof DataError)
        assert.equal(error.code, 'redis_auth_failed')
        assert.match(error.details.reply, /WRONGPASS/u)
        return true
      },
    )
  })

  test('maps a server command error to redis_command_failed with details.reply', async () => {
    const fake = await startFakeServer(() => errorReply("ERR unknown command 'NOPE'"))
    await assert.rejects(
      withRedis(fake.connection, (client) => client.command(['NOPE'])),
      (error) => {
        assert.ok(error instanceof DataError)
        assert.equal(error.code, 'redis_command_failed')
        assert.equal(error.details.reply, "ERR unknown command 'NOPE'")
        return true
      },
    )
  })

  test('times out a silent command, reports redis_timeout and drops the socket', async () => {
    const fake = await startFakeServer(() => {})
    const started = Date.now()
    await assert.rejects(
      withRedis({ ...fake.connection, timeoutMs: 150 }, (client) => client.command(['SLOW'])),
      (error) => {
        assert.ok(error instanceof DataError)
        assert.equal(error.code, 'redis_timeout')
        assert.match(error.message, /timed out/u)
        return true
      },
    )
    assert.ok(Date.now() - started < 2000)
    await waitFor(() => fake.sockets.size === 0)
  })

  test('maps a refused connection to redis_unreachable', async () => {
    const fake = await startFakeServer(() => simple('OK'))
    await fake.close()
    await assert.rejects(redisPing({ ...fake.connection, timeoutMs: 500 }), codeIs('redis_unreachable'))
  })

  test('maps a connection closed before the reply to redis_unreachable', async () => {
    const fake = await startFakeServer((command, socket) => {
      socket.destroy()
    })
    await assert.rejects(
      withRedis(fake.connection, (client) => client.command(['PING'])),
      codeIs('redis_unreachable'),
    )
  })

  test('maps a malformed reply to redis_command_failed', async () => {
    const fake = await startFakeServer(() => Buffer.from('?garbage\r\n'))
    await assert.rejects(
      withRedis(fake.connection, (client) => client.command(['PING'])),
      codeIs('redis_command_failed'),
    )
  })

  test('maps an oversized reply to redis_command_failed and drops the socket', async () => {
    const fake = await startFakeServer(() => Buffer.from('$2097153\r\n'))
    await assert.rejects(
      withRedis(fake.connection, (client) => client.command(['BIG'])),
      (error) => {
        assert.ok(error instanceof DataError)
        assert.equal(error.code, 'redis_command_failed')
        assert.equal(error.details.limit, 2 * 1024 * 1024)
        return true
      },
    )
    await waitFor(() => fake.sockets.size === 0)
  })
})

/* -------------------------------------------------------- public shapes */

describe('redisGet and redisSet over a fake server', () => {
  test('decodes a zset, a hash and a stream type-aware', async () => {
    /** @type {Map<string, Buffer>} */
    const responses = new Map([
      ['TYPE type:zset', simple('zset')],
      ['PTTL type:zset', integer(2500)],
      ['ZRANGE type:zset 0 -1 WITHSCORES', array([bulk('low'), bulk('1.5'), bulk('high'), bulk('10')])],
      ['TYPE type:hash', simple('hash')],
      ['PTTL type:hash', integer(-1)],
      ['HGETALL type:hash', array([bulk('field'), bulk('value')])],
      ['TYPE type:stream', simple('stream')],
      ['PTTL type:stream', integer(-1)],
      ['XRANGE type:stream - + COUNT 50', array([array([bulk('1-0'), array([bulk('a'), bulk('1')])])])],
      ['TYPE missing', simple('none')],
    ])
    const fake = await startFakeServer(
      (command) => responses.get(command.join(' ')) ?? errorReply('ERR unexpected command'),
    )

    assert.deepEqual(await redisGet(fake.connection, 'type:zset'), {
      key: 'type:zset',
      type: 'zset',
      ttl: 3,
      value: [
        { member: 'low', score: 1.5 },
        { member: 'high', score: 10 },
      ],
    })
    assert.deepEqual(await redisGet(fake.connection, 'type:hash'), {
      key: 'type:hash',
      type: 'hash',
      ttl: -1,
      value: { field: 'value' },
    })
    assert.deepEqual(await redisGet(fake.connection, 'type:stream'), {
      key: 'type:stream',
      type: 'stream',
      ttl: -1,
      value: [{ id: '1-0', fields: { a: '1' } }],
    })
    assert.deepEqual(await redisGet(fake.connection, 'missing'), {
      key: 'missing',
      type: 'none',
      ttl: -2,
      value: null,
    })
  })

  test('redisSet sends EX only for a positive TTL and reports the resulting TTL', async () => {
    const seen = []
    const fake = await startFakeServer((command) => {
      seen.push(command)
      if (command[0] === 'SET') return simple('OK')
      if (command[0] === 'PTTL') return integer(command[1] === 'k1' ? 60000 : -1)
      return simple('OK')
    })
    assert.deepEqual(await redisSet(fake.connection, { key: 'k1', value: 'v', ttlSeconds: 60 }), {
      key: 'k1',
      ttl: 60,
    })
    assert.deepEqual(await redisSet(fake.connection, { key: 'k2', value: 7 }), { key: 'k2', ttl: -1 })
    assert.deepEqual(
      seen.filter((command) => command[0] === 'SET'),
      [
        ['SET', 'k1', 'v', 'EX', '60'],
        ['SET', 'k2', '7'],
      ],
    )
  })
})

describe('redisInfo and redisScan over a fake server', () => {
  const INFO_TEXT = [
    '# Server',
    'redis_version:7.4.1',
    'uptime_in_seconds:120',
    '# Clients',
    'connected_clients:3',
    '# Memory',
    'used_memory:1048576',
    'used_memory_human:1.00M',
    '# Stats',
    'instantaneous_ops_per_sec:12',
    'keyspace_hits:998',
    'keyspace_misses:2',
    '# Replication',
    'role:master',
    '# Keyspace',
    'db0:keys=2,expires=0,avg_ttl=0',
    'db1:keys=3,expires=1,avg_ttl=0',
    '',
  ].join(CRLF)

  test('splits INFO into sections and a summary', async () => {
    const fake = await startFakeServer(() => bulk(INFO_TEXT))
    const info = await redisInfo(fake.connection)
    assert.deepEqual(info.summary, {
      version: '7.4.1',
      uptimeSeconds: 120,
      connectedClients: 3,
      usedMemoryHuman: '1.00M',
      usedMemoryBytes: 1048576,
      totalKeys: 5,
      opsPerSec: 12,
      hitRate: 99.8,
      role: 'master',
    })
    assert.equal(info.sections.Server.redis_version, '7.4.1')
    assert.equal(info.sections.Memory.used_memory, '1048576')
    assert.equal(info.sections.Keyspace.db1, 'keys=3,expires=1,avg_ttl=0')
  })

  test('leaves absent metrics null and totalKeys zero', async () => {
    const fake = await startFakeServer(() => bulk('# Server\r\nuptime_in_seconds:5\r\n'))
    const info = await redisInfo(fake.connection)
    assert.deepEqual(info.summary, {
      version: null,
      uptimeSeconds: 5,
      connectedClients: null,
      usedMemoryHuman: null,
      usedMemoryBytes: null,
      totalKeys: 0,
      opsPerSec: null,
      hitRate: null,
      role: null,
    })
  })

  test('shapes the page and forwards MATCH/COUNT/TYPE', async () => {
    const seen = []
    const fake = await startFakeServer((command) => {
      seen.push(command)
      if (command[1] === '0') return array([bulk('42'), array([bulk('user:1'), bulk('user:2')])])
      return array([bulk('0'), array([])])
    })
    const first = await redisScan(fake.connection, { cursor: '0', match: 'user:*', count: 5, type: 'hash' })
    assert.deepEqual(first, { cursor: '42', keys: ['user:1', 'user:2'], done: false })
    const second = await redisScan(fake.connection, { cursor: '42', match: 'user:*', count: 5 })
    assert.deepEqual(second, { cursor: '0', keys: [], done: true })
    assert.deepEqual(seen[0], ['SCAN', '0', 'MATCH', 'user:*', 'COUNT', '5', 'TYPE', 'hash'])
    assert.deepEqual(seen[1], ['SCAN', '42', 'MATCH', 'user:*', 'COUNT', '5'])
  })
})

/* ------------------------------------------------------- v0.3 server data */

describe('v0.3 server commands over a fake server', () => {
  test('redisClients parses CLIENT LIST lines into typed fields', async () => {
    const list = [
      'id=7 addr=127.0.0.1:60123 laddr=127.0.0.1:56379 fd=8 name=app age=12 idle=3 flags=N db=2 sub=0 psub=0 ssub=0 multi=-1 qbuf=26 qbuf-free=20448 argv-mem=10 multi-mem=0 rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=17456 events=r cmd=client|list user=alice redir=-1 resp=2',
      'id=8 addr=127.0.0.1:60124 laddr=127.0.0.1:56379 fd=9 name= age=0 idle=0 flags=N db=0 sub=0 psub=0 ssub=0 multi=-1 qbuf=0 qbuf-free=20474 argv-mem=0 multi-mem=0 rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=16992 events=r cmd=ping user=default redir=-1 resp=2',
      '',
    ].join(CRLF)
    const fake = await startFakeServer(() => bulk(list))
    const result = await redisClients(fake.connection)
    assert.equal(result.count, 2)
    assert.deepEqual(result.clients, [
      {
        id: 7,
        addr: '127.0.0.1:60123',
        name: 'app',
        ageSeconds: 12,
        idleSeconds: 3,
        db: 2,
        command: 'client|list',
        user: 'alice',
      },
      {
        id: 8,
        addr: '127.0.0.1:60124',
        name: '',
        ageSeconds: 0,
        idleSeconds: 0,
        db: 0,
        command: 'ping',
        user: 'default',
      },
    ])
    assert.deepEqual(sentBytes(fake), encodeCommand(['CLIENT', 'LIST']))
  })

  test('redisDbSize returns the database key count', async () => {
    const fake = await startFakeServer(() => integer(42))
    assert.deepEqual(await redisDbSize(fake.connection), { keys: 42 })
    assert.deepEqual(sentBytes(fake), encodeCommand(['DBSIZE']))
  })

  test('redisMemoryUsage reports bytes plus a human size and nulls for a missing key', async () => {
    const fake = await startFakeServer((command) => {
      if (command[2] === 'missing') return nilBulk()
      return integer(command[2] === 'big' ? 1048576 : 1234)
    })
    assert.deepEqual(await redisMemoryUsage(fake.connection, 'small'), { key: 'small', bytes: 1234, human: '1.21K' })
    assert.deepEqual(await redisMemoryUsage(fake.connection, 'big'), {
      key: 'big',
      bytes: 1048576,
      human: '1.00M',
    })
    assert.deepEqual(await redisMemoryUsage(fake.connection, 'missing'), {
      key: 'missing',
      bytes: null,
      human: null,
    })
    assert.deepEqual(
      sentBytes(fake),
      Buffer.concat([
        encodeCommand(['MEMORY', 'USAGE', 'small']),
        encodeCommand(['MEMORY', 'USAGE', 'big']),
        encodeCommand(['MEMORY', 'USAGE', 'missing']),
      ]),
    )
  })
})

describe('v0.3 key edits over a fake server', () => {
  test('redisRename confirms a rename and maps a missing source to redis_command_failed', async () => {
    const fake = await startFakeServer((command) =>
      command[1] === 'missing' ? errorReply('ERR no such key') : simple('OK'),
    )
    assert.deepEqual(await redisRename(fake.connection, 'old', 'new'), { key: 'old', newKey: 'new', renamed: true })
    await assert.rejects(redisRename(fake.connection, 'missing', 'new'), (error) => {
      assert.ok(error instanceof DataError)
      assert.equal(error.code, 'redis_command_failed')
      assert.match(error.details.reply, /no such key/u)
      return true
    })
    assert.deepEqual(
      sentBytes(fake),
      Buffer.concat([encodeCommand(['RENAME', 'old', 'new']), encodeCommand(['RENAME', 'missing', 'new'])]),
    )
  })

  test('redisExpire applies a TTL and reports the resulting seconds', async () => {
    const fake = await startFakeServer((command) => {
      if (command[0] === 'EXPIRE') return integer(command[1] === 'missing' ? 0 : 1)
      return integer(command[1] === 'missing' ? -2 : 59900)
    })
    assert.deepEqual(await redisExpire(fake.connection, 'k', 60), { key: 'k', ttl: 60 })
    assert.deepEqual(await redisExpire(fake.connection, 'missing', 60), { key: 'missing', ttl: -2 })
    assert.deepEqual(
      sentBytes(fake),
      Buffer.concat([
        encodeCommand(['EXPIRE', 'k', '60']),
        encodeCommand(['PTTL', 'k']),
        encodeCommand(['EXPIRE', 'missing', '60']),
      ]),
    )
  })

  test('redisPersist clears the expiry and always reports ttl -1', async () => {
    const fake = await startFakeServer(() => integer(1))
    assert.deepEqual(await redisPersist(fake.connection, 'k'), { key: 'k', ttl: -1 })
    assert.deepEqual(sentBytes(fake), encodeCommand(['PERSIST', 'k']))
  })

  test('redisHashSet writes a field and reports the hash field count', async () => {
    const fake = await startFakeServer((command) => (command[0] === 'HLEN' ? integer(3) : integer(1)))
    assert.deepEqual(await redisHashSet(fake.connection, { key: 'h', field: 'f', value: 'v' }), {
      key: 'h',
      field: 'f',
      fieldCount: 3,
    })
    assert.deepEqual(
      sentBytes(fake),
      Buffer.concat([encodeCommand(['HSET', 'h', 'f', 'v']), encodeCommand(['HLEN', 'h'])]),
    )
  })

  test('redisListPush picks LPUSH or RPUSH and reports the list length', async () => {
    const fake = await startFakeServer((command) =>
      command[0] === 'LLEN' ? integer(command[1] === 'left' ? 2 : 5) : integer(1),
    )
    assert.deepEqual(await redisListPush(fake.connection, { key: 'left', value: 'a', side: 'left' }), {
      key: 'left',
      length: 2,
    })
    assert.deepEqual(await redisListPush(fake.connection, { key: 'right', value: 'b', side: 'right' }), {
      key: 'right',
      length: 5,
    })
    assert.deepEqual(
      sentBytes(fake),
      Buffer.concat([
        encodeCommand(['LPUSH', 'left', 'a']),
        encodeCommand(['LLEN', 'left']),
        encodeCommand(['RPUSH', 'right', 'b']),
        encodeCommand(['LLEN', 'right']),
      ]),
    )
  })

  test('redisSetAdd and redisSetRemove report the resulting cardinality', async () => {
    const fake = await startFakeServer((command) => {
      if (command[0] === 'SCARD') return integer(command[1] === 's' ? 2 : 1)
      if (command[0] === 'SREM') return integer(command[1] === 'removed' ? 1 : 0)
      return integer(1)
    })
    assert.deepEqual(await redisSetAdd(fake.connection, { key: 's', member: 'm' }), { key: 's', length: 2 })
    assert.deepEqual(await redisSetRemove(fake.connection, { key: 'removed', member: 'm' }), {
      key: 'removed',
      length: 1,
      removed: 1,
    })
    assert.deepEqual(await redisSetRemove(fake.connection, { key: 'cleared', member: 'm' }), {
      key: 'cleared',
      length: 1,
      removed: 0,
    })
    assert.deepEqual(
      sentBytes(fake),
      Buffer.concat([
        encodeCommand(['SADD', 's', 'm']),
        encodeCommand(['SCARD', 's']),
        encodeCommand(['SREM', 'removed', 'm']),
        encodeCommand(['SCARD', 'removed']),
        encodeCommand(['SREM', 'cleared', 'm']),
        encodeCommand(['SCARD', 'cleared']),
      ]),
    )
  })
})

describe('redis_invalid_argument validation', () => {
  const unreachable = { host: '127.0.0.1', port: 1, timeoutMs: 300 }

  /**
   * @param {Promise<unknown>} promise - the call that must reject.
   * @param {string} field - expected `details.field`.
   * @returns {Promise<void>}
   */
  const invalid = async (promise, field) => {
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof DataError, `expected a DataError, got ${String(error)}`)
      assert.equal(error.code, 'redis_invalid_argument')
      assert.deepEqual(error.details, { field })
      return true
    })
  }

  test('rejects invalid keys, new keys, fields, members, values, TTLs and sides before connecting', async () => {
    const tooLongKey = 'k'.repeat(513)
    const tooLongValue = 'v'.repeat(1024 * 1024 + 1)
    const keyed = [
      (key) => redisMemoryUsage(unreachable, key),
      (key) => redisPersist(unreachable, key),
      (key) => redisExpire(unreachable, key, 60),
      (key) => redisHashSet(unreachable, { key, field: 'f', value: 'v' }),
      (key) => redisListPush(unreachable, { key, value: 'v', side: 'left' }),
      (key) => redisSetAdd(unreachable, { key, member: 'm' }),
      (key) => redisSetRemove(unreachable, { key, member: 'm' }),
    ]
    for (const call of keyed) {
      for (const key of ['', null, 42, tooLongKey]) await invalid(call(key), 'key')
    }

    await invalid(redisRename(unreachable, 'a', ''), 'newKey')
    await invalid(redisRename(unreachable, 'a', tooLongKey), 'newKey')
    await invalid(redisHashSet(unreachable, { key: 'h', field: '', value: 'v' }), 'field')
    await invalid(redisHashSet(unreachable, { key: 'h', field: 7, value: 'v' }), 'field')
    await invalid(redisListPush(unreachable, { key: 'l', value: 'v', side: 'up' }), 'side')
    await invalid(redisListPush(unreachable, { key: 'l', value: 'v' }), 'side')
    await invalid(redisSetAdd(unreachable, { key: 's', member: '' }), 'member')
    await invalid(redisSetRemove(unreachable, { key: 's', member: null }), 'member')
    await invalid(redisHashSet(unreachable, { key: 'h', field: 'f', value: tooLongValue }), 'value')
    await invalid(redisHashSet(unreachable, { key: 'h', field: 'f', value: null }), 'value')
    await invalid(redisListPush(unreachable, { key: 'l', value: tooLongValue, side: 'right' }), 'value')
    for (const ttl of [0, -1, 1.5, 31536001, 'abc', null, undefined]) {
      await invalid(redisExpire(unreachable, 'k', ttl), 'ttlSeconds')
    }
  })

  test('still reaches the network for valid arguments', async () => {
    await assert.rejects(redisPersist(unreachable, 'valid'), codeIs('redis_unreachable'))
  })
})

describe('connection and key validation', () => {
  test('rejects malformed connections before opening a socket', async () => {
    const badConnections = [
      null,
      'redis://127.0.0.1',
      {},
      { host: '', port: 6379 },
      { host: '127.0.0.1', port: 0 },
      { host: '127.0.0.1', port: 70000 },
      { host: '127.0.0.1', port: 6379, db: -1 },
      { host: '127.0.0.1', port: 6379, timeoutMs: 10 },
    ]
    for (const connection of badConnections) {
      await assert.rejects(
        redisPing(connection),
        codeIs('redis_invalid_connection'),
        `expected ${JSON.stringify(connection)} to be rejected`,
      )
    }
  })

  test('rejects invalid keys before touching the network', async () => {
    const unreachable = { host: '127.0.0.1', port: 1, timeoutMs: 300 }
    for (const key of ['', null, undefined, 42]) {
      await assert.rejects(redisGet(unreachable, key), codeIs('redis_invalid_key'))
      await assert.rejects(redisDelete(unreachable, key), codeIs('redis_invalid_key'))
    }
    await assert.rejects(redisSet(unreachable, { key: '', value: 'x' }), codeIs('redis_invalid_key'))
  })
})

/* --------------------------------------------------------- live server */

describe('live Redis', () => {
  liveTest('pings with a latency and the server version', async () => {
    const result = await redisPing(LIVE_CONNECTION)
    assert.equal(result.pong, true)
    assert.equal(typeof result.latencyMs, 'number')
    assert.ok(result.latencyMs >= 0)
    assert.match(result.version, /^\d+\.\d+/u)
  })

  liveTest('reads INFO into a summary and raw sections', async () => {
    const { summary, sections } = await redisInfo(LIVE_CONNECTION)
    assert.match(summary.version, /^\d+\.\d+/u)
    assert.equal(typeof summary.uptimeSeconds, 'number')
    assert.ok(summary.connectedClients >= 1)
    assert.ok(summary.usedMemoryBytes > 0)
    assert.ok(Number.isInteger(summary.totalKeys) && summary.totalKeys >= 0)
    assert.ok(summary.role === 'master' || summary.role === 'replica' || summary.role === 'slave')
    assert.equal(sections.Server.redis_version, summary.version)
    assert.equal(typeof sections.Memory.used_memory_human, 'string')
    assert.ok(summary.hitRate === null || (summary.hitRate >= 0 && summary.hitRate <= 100))
  })

  liveTest('round-trips a string value with a TTL and deletes it', async () => {
    const key = `${LIVE_PREFIX}string`
    const value = 'hello from dsh-long-data ✓\nsecond line'
    const set = await redisSet(LIVE_CONNECTION, { key, value, ttlSeconds: 120 })
    assert.equal(set.key, key)
    assert.equal(typeof set.ttl, 'number')
    assert.ok(set.ttl > 0 && set.ttl <= 120, `expected a live TTL, got ${set.ttl}`)

    const got = await redisGet(LIVE_CONNECTION, key)
    assert.equal(got.key, key)
    assert.equal(got.type, 'string')
    assert.equal(got.value, value)
    assert.ok(got.ttl > 0 && got.ttl <= 120)

    assert.deepEqual(await redisDelete(LIVE_CONNECTION, key), { key, deleted: 1 })
    assert.deepEqual(await redisDelete(LIVE_CONNECTION, key), { key, deleted: 0 })
    assert.deepEqual(await redisGet(LIVE_CONNECTION, key), { key, type: 'none', ttl: -2, value: null })
  })

  liveTest('reports -1 for a key without an expiry', async () => {
    const key = `${LIVE_PREFIX}persistent`
    await redisSet(LIVE_CONNECTION, { key, value: 'forever' })
    const got = await redisGet(LIVE_CONNECTION, key)
    assert.equal(got.type, 'string')
    assert.equal(got.ttl, -1)
    await redisDelete(LIVE_CONNECTION, key)
  })

  liveTest('decodes list, set, zset, hash and bounded stream values', async () => {
    const keys = {
      list: `${LIVE_PREFIX}type:list`,
      set: `${LIVE_PREFIX}type:set`,
      zset: `${LIVE_PREFIX}type:zset`,
      hash: `${LIVE_PREFIX}type:hash`,
      stream: `${LIVE_PREFIX}type:stream`,
    }
    await withRedis(LIVE_CONNECTION, async (client) => {
      await client.command(['RPUSH', keys.list, 'a', 'b', 'c'])
      await client.command(['SADD', keys.set, 'x', 'y'])
      await client.command(['ZADD', keys.zset, '1.5', 'low', '10', 'high'])
      await client.command(['HSET', keys.hash, 'field', 'value', 'count', '2'])
      for (let index = 0; index < 60; index += 1) {
        await client.command(['XADD', keys.stream, '*', 'index', String(index)])
      }
    })

    const list = await redisGet(LIVE_CONNECTION, keys.list)
    assert.equal(list.type, 'list')
    assert.deepEqual(list.value, ['a', 'b', 'c'])
    assert.equal(list.ttl, -1)

    const set = await redisGet(LIVE_CONNECTION, keys.set)
    assert.equal(set.type, 'set')
    assert.deepEqual([...set.value].sort(), ['x', 'y'])

    const zset = await redisGet(LIVE_CONNECTION, keys.zset)
    assert.equal(zset.type, 'zset')
    assert.deepEqual(zset.value, [
      { member: 'low', score: 1.5 },
      { member: 'high', score: 10 },
    ])

    const hash = await redisGet(LIVE_CONNECTION, keys.hash)
    assert.equal(hash.type, 'hash')
    assert.deepEqual(hash.value, { field: 'value', count: '2' })

    const stream = await redisGet(LIVE_CONNECTION, keys.stream)
    assert.equal(stream.type, 'stream')
    assert.equal(stream.value.length, 50)
    assert.match(stream.value[0].id, /^\d+-\d+$/u)
    assert.deepEqual(stream.value[0].fields, { index: '0' })
    assert.deepEqual(stream.value[49].fields, { index: '49' })
  })

  liveTest('scans with MATCH, paginates by cursor and filters by TYPE', async () => {
    const scope = `${LIVE_PREFIX}scan:`
    const strings = [`${scope}s1`, `${scope}s2`]
    const listKey = `${scope}list`
    const hashKey = `${scope}hash`
    await withRedis(LIVE_CONNECTION, async (client) => {
      await client.command(['SET', strings[0], '1'])
      await client.command(['SET', strings[1], '2'])
      await client.command(['RPUSH', listKey, 'item'])
      await client.command(['HSET', hashKey, 'f', 'v'])
    })

    /**
     * @param {{ match: string, count: number, type?: string }} options - scan filters.
     * @returns {Promise<string[]>} all matching keys, de-duplicated.
     */
    const collect = async (options) => {
      const keys = new Set()
      let cursor = '0'
      let guard = 0
      do {
        const page = await redisScan(LIVE_CONNECTION, { ...options, cursor })
        assert.equal(typeof page.cursor, 'string')
        assert.equal(typeof page.done, 'boolean')
        assert.ok(Array.isArray(page.keys))
        for (const key of page.keys) keys.add(key)
        cursor = page.cursor
        guard += 1
        if (guard > 100) throw new Error('SCAN did not terminate')
      } while (cursor !== '0')
      return [...keys].sort()
    }

    assert.deepEqual(await collect({ match: `${scope}*`, count: 2 }), [hashKey, listKey, ...strings].sort())
    assert.deepEqual(await collect({ match: `${scope}*`, count: 2, type: 'list' }), [listKey])
    assert.deepEqual(await collect({ match: `${scope}*`, count: 100, type: 'hash' }), [hashKey])
  })

  liveTest('maps a wrong password to redis_auth_failed', async () => {
    const connection = { ...LIVE_CONNECTION, password: `${LIVE_CONNECTION.password}-wrong` }
    await assert.rejects(redisPing(connection), (error) => {
      assert.ok(error instanceof DataError)
      assert.equal(error.code, 'redis_auth_failed')
      assert.match(error.details.reply, /WRONGPASS|invalid password/iu)
      return true
    })
  })

  liveTest('lists the connected clients', async () => {
    const result = await redisClients(LIVE_CONNECTION)
    assert.ok(Array.isArray(result.clients))
    assert.equal(result.count, result.clients.length)
    assert.ok(result.count >= 1)
    for (const client of result.clients) {
      assert.equal(typeof client.id, 'number')
      assert.equal(typeof client.addr, 'string')
      assert.equal(typeof client.name, 'string')
      assert.ok(client.ageSeconds === null || typeof client.ageSeconds === 'number')
      assert.ok(client.idleSeconds === null || typeof client.idleSeconds === 'number')
      assert.ok(client.db === null || typeof client.db === 'number')
      assert.ok(client.command === null || typeof client.command === 'string')
      assert.ok(client.user === null || typeof client.user === 'string')
    }
    assert.ok(result.clients.some((client) => client.addr !== ''))
  })

  liveTest('returns the database key count', async () => {
    const { keys } = await redisDbSize(LIVE_CONNECTION)
    assert.ok(Number.isInteger(keys) && keys >= 0)
  })

  liveTest('reports MEMORY USAGE bytes for an existing key and nulls for a missing one', async () => {
    const key = `${LIVE_PREFIX}memory`
    await redisSet(LIVE_CONNECTION, { key, value: 'x'.repeat(100) })
    const usage = await redisMemoryUsage(LIVE_CONNECTION, key)
    assert.equal(usage.key, key)
    assert.ok(Number.isInteger(usage.bytes) && usage.bytes > 0)
    assert.match(usage.human, /^\d+(?:\.\d{2})?[BKMG]$/u)
    assert.deepEqual(await redisMemoryUsage(LIVE_CONNECTION, `${key}:missing`), {
      key: `${key}:missing`,
      bytes: null,
      human: null,
    })
  })

  liveTest('renames a key, applies an expiry and persists it', async () => {
    const key = `${LIVE_PREFIX}rename:from`
    const newKey = `${LIVE_PREFIX}rename:to`
    await redisSet(LIVE_CONNECTION, { key, value: 'value' })
    assert.deepEqual(await redisRename(LIVE_CONNECTION, key, newKey), { key, newKey, renamed: true })
    assert.deepEqual(await redisGet(LIVE_CONNECTION, key), { key, type: 'none', ttl: -2, value: null })
    const renamed = await redisGet(LIVE_CONNECTION, newKey)
    assert.equal(renamed.type, 'string')
    assert.equal(renamed.value, 'value')

    const expired = await redisExpire(LIVE_CONNECTION, newKey, 120)
    assert.equal(expired.key, newKey)
    assert.ok(expired.ttl > 0 && expired.ttl <= 120)
    assert.ok((await redisGet(LIVE_CONNECTION, newKey)).ttl > 0)

    assert.deepEqual(await redisPersist(LIVE_CONNECTION, newKey), { key: newKey, ttl: -1 })
    assert.equal((await redisGet(LIVE_CONNECTION, newKey)).ttl, -1)

    assert.deepEqual(await redisExpire(LIVE_CONNECTION, `${key}:missing`, 60), {
      key: `${key}:missing`,
      ttl: -2,
    })
    await assert.rejects(redisRename(LIVE_CONNECTION, `${key}:missing`, newKey), (error) => {
      assert.ok(error instanceof DataError)
      assert.equal(error.code, 'redis_command_failed')
      assert.match(error.details.reply, /no such key/u)
      return true
    })
  })

  liveTest('edits hash fields, list ends and set members', async () => {
    const hashKey = `${LIVE_PREFIX}editor:hash`
    const listKey = `${LIVE_PREFIX}editor:list`
    const setKey = `${LIVE_PREFIX}editor:set`

    assert.deepEqual(await redisHashSet(LIVE_CONNECTION, { key: hashKey, field: 'one', value: 'a' }), {
      key: hashKey,
      field: 'one',
      fieldCount: 1,
    })
    assert.deepEqual(await redisHashSet(LIVE_CONNECTION, { key: hashKey, field: 'two', value: 'b' }), {
      key: hashKey,
      field: 'two',
      fieldCount: 2,
    })
    const hash = await redisGet(LIVE_CONNECTION, hashKey)
    assert.equal(hash.type, 'hash')
    assert.deepEqual(hash.value, { one: 'a', two: 'b' })

    assert.deepEqual(await redisListPush(LIVE_CONNECTION, { key: listKey, value: 'first', side: 'left' }), {
      key: listKey,
      length: 1,
    })
    assert.deepEqual(await redisListPush(LIVE_CONNECTION, { key: listKey, value: 'zero', side: 'left' }), {
      key: listKey,
      length: 2,
    })
    assert.deepEqual(await redisListPush(LIVE_CONNECTION, { key: listKey, value: 'last', side: 'right' }), {
      key: listKey,
      length: 3,
    })
    const list = await redisGet(LIVE_CONNECTION, listKey)
    assert.equal(list.type, 'list')
    assert.deepEqual(list.value, ['zero', 'first', 'last'])

    assert.deepEqual(await redisSetAdd(LIVE_CONNECTION, { key: setKey, member: 'alpha' }), {
      key: setKey,
      length: 1,
    })
    assert.deepEqual(await redisSetAdd(LIVE_CONNECTION, { key: setKey, member: 'beta' }), {
      key: setKey,
      length: 2,
    })
    assert.deepEqual(await redisSetRemove(LIVE_CONNECTION, { key: setKey, member: 'alpha' }), {
      key: setKey,
      length: 1,
      removed: 1,
    })
    assert.deepEqual(await redisSetRemove(LIVE_CONNECTION, { key: setKey, member: 'alpha' }), {
      key: setKey,
      length: 1,
      removed: 0,
    })
    const set = await redisGet(LIVE_CONNECTION, setKey)
    assert.equal(set.type, 'set')
    assert.deepEqual(set.value, ['beta'])
  })

  const authRequiredSkip =
    live.skip !== null ? live.skip : live.authRequired ? false : 'the live server does not require a password'
  test('maps a missing password on an auth-protected server to redis_auth_required', { skip: authRequiredSkip }, async () => {
    await assert.rejects(redisPing({ ...LIVE_CONNECTION, password: '' }), (error) => {
      assert.ok(error instanceof DataError)
      assert.equal(error.code, 'redis_auth_required')
      return true
    })
  })
})
