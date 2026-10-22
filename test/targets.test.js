/**
 * Unit tests for Docker-target resolution: image classification, published-port
 * extraction, environment-credential reading, single/multi-instance selection and
 * manual/docker resolution against fixture candidates. No Docker daemon needed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DataError } from '../src/errors.js'
import {
  POSTGRES_FALLBACK_DATABASE,
  POSTGRES_FALLBACK_USER,
  connectionForCandidate,
  credentialsFromEnv,
  dialAddress,
  discoverCandidates,
  envToRecord,
  isServiceImage,
  manualConnection,
  publicCandidates,
  publishedPortOf,
  resolveConnection,
  resolveInstances,
  selectCandidate,
} from '../src/targets.js'

/**
 * @param {object} [overrides] - candidate overrides.
 * @returns {object} an internal redis candidate.
 */
function redisCandidate(overrides = {}) {
  return {
    service: 'redis',
    name: 'cache',
    image: 'redis:7',
    state: 'running',
    running: true,
    containerPort: '6379',
    hostPort: 56379,
    hostIp: '0.0.0.0',
    credentials: { password: 'localredis' },
    ...overrides,
  }
}

/**
 * @param {object} [overrides] - candidate overrides.
 * @returns {object} an internal postgres candidate.
 */
function postgresCandidate(overrides = {}) {
  return {
    service: 'postgres',
    name: 'db',
    image: 'postgres:18',
    state: 'running',
    running: true,
    containerPort: '5432',
    hostPort: 55432,
    hostIp: '0.0.0.0',
    credentials: { username: 'app', password: 'pw', database: 'appdb' },
    ...overrides,
  }
}

const REDIS_SETTINGS = { mode: 'docker', container: '', username: '', password: '', db: 0, tls: false, timeoutMs: 5000 }
const PG_SETTINGS = { mode: 'docker', container: '', user: '', password: '', database: '', ssl: 'prefer', timeoutMs: 8000 }

test('isServiceImage classifies registry paths, tags and variants', () => {
  assert.equal(isServiceImage('redis', 'redis:7'), true)
  assert.equal(isServiceImage('redis', 'docker.m.daocloud.io/library/redis:8.10.2'), true)
  assert.equal(isServiceImage('redis', 'redis-stack:latest'), true)
  assert.equal(isServiceImage('redis', 'bitnami/redis@sha256:abc'), true)
  assert.equal(isServiceImage('redis', 'postgres:16'), false)
  assert.equal(isServiceImage('redis', undefined), false)
  assert.equal(isServiceImage('postgres', 'postgres:18.6'), true)
  assert.equal(isServiceImage('postgres', 'docker.m.daocloud.io/library/postgres:18.6'), true)
  assert.equal(isServiceImage('postgres', 'postgis/postgis:16'), true)
  assert.equal(isServiceImage('postgres', 'timescale/timescaledb:latest-pg16'), true)
  assert.equal(isServiceImage('postgres', 'redis:7'), false)
})

test('envToRecord keeps string pairs and ignores malformed entries', () => {
  assert.deepEqual(envToRecord([{ key: 'A', value: '1' }, { key: 'B', value: 2 }, null, { value: 'x' }]), { A: '1', B: '2' })
  assert.deepEqual(envToRecord(undefined), {})
})

test('credentialsFromEnv reads the conventional image variables', () => {
  assert.deepEqual(credentialsFromEnv('redis', [{ key: 'REDISCLI_AUTH', value: 'localredis' }]), { password: 'localredis' })
  assert.deepEqual(
    credentialsFromEnv('redis', [
      { key: 'REDIS_USERNAME', value: 'app' },
      { key: 'REDIS_PASSWORD', value: 'pw' },
      { key: 'REDIS_DB', value: '3' },
    ]),
    { username: 'app', password: 'pw', db: 3 },
  )
  assert.deepEqual(
    credentialsFromEnv('postgres', [
      { key: 'POSTGRES_USER', value: 'app' },
      { key: 'POSTGRES_PASSWORD', value: 'pw' },
      { key: 'POSTGRES_DB', value: 'appdb' },
    ]),
    { username: 'app', password: 'pw', database: 'appdb' },
  )
  assert.deepEqual(credentialsFromEnv('postgres', []), {})
})

test('publishedPortOf finds only the published mapping of the wanted port', () => {
  const ports = [
    { host: '56379', container: '6379', protocol: 'tcp', ip: '0.0.0.0' },
    { host: '56379', container: '6379', protocol: 'tcp', ip: '::' },
    { host: '9000', container: '9000', protocol: 'tcp', ip: '0.0.0.0' },
  ]
  assert.deepEqual(publishedPortOf(ports, '6379'), { hostPort: 56379, hostIp: '0.0.0.0' })
  assert.equal(publishedPortOf(ports, '5432'), null)
  assert.equal(publishedPortOf([{ host: 'not-a-port', container: '6379', protocol: 'tcp', ip: null }], '6379'), null)
  assert.equal(publishedPortOf(undefined, '6379'), null)
})

test('dialAddress maps unspecific bind addresses to loopback', () => {
  assert.equal(dialAddress('0.0.0.0'), '127.0.0.1')
  assert.equal(dialAddress('::'), '127.0.0.1')
  assert.equal(dialAddress('192.168.1.5'), '192.168.1.5')
  assert.equal(dialAddress(null), '127.0.0.1')
})

test('publicCandidates expose flags but never the credentials', () => {
  const view = publicCandidates([redisCandidate(), postgresCandidate()])
  assert.equal(view.length, 2)
  assert.equal(view[0].name, 'cache')
  assert.equal(view[0].hasPassword, true)
  assert.equal(view[0].credentialsSource, 'container-env')
  assert.equal(view[0].hasPublishedPort, true)
  assert.equal(Object.hasOwn(view[0], 'credentials'), false)
  assert.equal(Object.hasOwn(view[0], 'password'), false)
  assert.equal(JSON.stringify(view).includes('localredis'), false)
  assert.equal(JSON.stringify(view).includes('"pw"'), false)
})

test('manual mode uses the configured address and credentials', () => {
  const redisSettings = {
    mode: 'manual', container: '', host: 'cache.local', port: 6380, username: 'u', password: 'p',
    db: 2, tls: true, timeoutMs: 1234,
  }
  const { connection, target } = resolveConnection('redis', redisSettings, [])
  assert.deepEqual(connection, { host: 'cache.local', port: 6380, username: 'u', password: 'p', db: 2, tls: true, timeoutMs: 1234 })
  assert.equal(target.mode, 'manual')
  assert.equal(target.container, null)
  assert.equal(target.credentialsSource, 'settings')

  const pgSettings = { mode: 'manual', container: '', host: 'db.local', port: 6432, user: '', password: '', database: '', ssl: 'disable', timeoutMs: 2000 }
  const resolved = resolveConnection('postgres', pgSettings, [])
  assert.equal(resolved.connection.user, POSTGRES_FALLBACK_USER)
  assert.equal(resolved.connection.database, POSTGRES_FALLBACK_DATABASE)
  assert.equal(resolved.connection.ssl, 'disable')
  assert.equal(resolved.target.credentialsSource, 'none')
})

test('docker mode uses the single running candidate and its env credentials', () => {
  const { connection, target } = resolveConnection('redis', REDIS_SETTINGS, [redisCandidate()])
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.port, 56379)
  assert.equal(connection.password, 'localredis')
  assert.equal(target.mode, 'docker')
  assert.equal(target.container, 'cache')
  assert.equal(target.credentialsSource, 'container-env')
})

test('two or more running candidates raise an ambiguity instead of picking one', () => {
  const first = redisCandidate({ name: 'cache-a', hostPort: 56379 })
  const second = redisCandidate({ name: 'cache-b', hostPort: 56380, credentials: {} })
  assert.throws(
    () => selectCandidate('redis', REDIS_SETTINGS, [first, second]),
    (error) => error instanceof DataError &&
      error.code === 'redis_ambiguous_container' &&
      error.details.candidates.length === 2 &&
      error.details.candidates.map((candidate) => candidate.name).sort().join(',') === 'cache-a,cache-b',
  )
})

test('a pinned container wins even when several run; a missing one is reported', () => {
  const first = redisCandidate({ name: 'cache-a' })
  const second = redisCandidate({ name: 'cache-b' })
  assert.equal(selectCandidate('redis', { ...REDIS_SETTINGS, container: 'cache-b' }, [first, second]).name, 'cache-b')
  assert.throws(
    () => selectCandidate('redis', { ...REDIS_SETTINGS, container: 'missing' }, [first, second]),
    (error) => error instanceof DataError && error.code === 'redis_container_not_found',
  )
})

test('stopped-only candidates are reported as not running, not as absent', () => {
  const stopped = redisCandidate({ name: 'cache', state: 'exited', running: false })
  assert.throws(
    () => selectCandidate('redis', REDIS_SETTINGS, [stopped]),
    (error) => error instanceof DataError && error.code === 'redis_no_running_container' && error.details.candidates.length === 1,
  )
  assert.throws(
    () => selectCandidate('postgres', PG_SETTINGS, []),
    (error) => error instanceof DataError && error.code === 'postgres_no_container' && typeof error.details.hint === 'string',
  )
})

test('docker mode lets explicit settings override container credentials', () => {
  const settings = { ...REDIS_SETTINGS, username: 'u', password: 'override', db: 4 }
  const { connection, target } = resolveConnection('redis', settings, [redisCandidate()])
  assert.equal(connection.password, 'override')
  assert.equal(connection.username, 'u')
  assert.equal(connection.db, 4)
  assert.equal(target.credentialsSource, 'settings')
})

test('docker mode falls back to the documented postgres defaults', () => {
  const { connection } = resolveConnection('postgres', PG_SETTINGS, [postgresCandidate({ credentials: {} })])
  assert.equal(connection.user, POSTGRES_FALLBACK_USER)
  assert.equal(connection.password, '')
  assert.equal(connection.database, POSTGRES_FALLBACK_DATABASE)
})

test('connectionForCandidate requires a published port', () => {
  assert.throws(
    () => connectionForCandidate('postgres', PG_SETTINGS, postgresCandidate({ hostPort: null })),
    (error) => error instanceof DataError && error.code === 'postgres_no_published_port' && error.details.container === 'db',
  )
})

test('resolveInstances reports every running instance with its endpoint', () => {
  const candidates = [
    redisCandidate({ name: 'cache-a', hostPort: 56379 }),
    redisCandidate({ name: 'cache-b', hostPort: 56380, hostIp: '127.0.0.1', credentials: {} }),
    redisCandidate({ name: 'cache-old', state: 'exited', running: false, hostPort: 6379 }),
  ]
  const instances = resolveInstances('redis', REDIS_SETTINGS, candidates)
  assert.deepEqual(instances.map((instance) => instance.container), ['cache-a', 'cache-b'])
  assert.equal(instances[0].port, 56379)
  assert.equal(instances[0].hasPassword, true)
  assert.equal(instances[0].credentialsSource, 'container-env')
  assert.equal(instances[1].port, 56380)
  assert.equal(instances[1].hasPassword, false)
  assert.equal(instances[0].hasPublishedPort, true)
})

test('resolveInstances marks an instance without a published port', () => {
  const instances = resolveInstances('postgres', PG_SETTINGS, [postgresCandidate({ name: 'db2', hostPort: null })])
  assert.equal(instances.length, 1)
  assert.equal(instances[0].hasPublishedPort, false)
  assert.equal(instances[0].port, null)
})

test('discoverCandidates inspects only matching containers and sorts running first', async () => {
  const inspected = []
  const dockerService = {
    async listContainers() {
      return [
        { id: 'a', name: 'redis-old', image: 'redis:7', state: 'exited', ports: [{ host: '6379', container: '6379', protocol: 'tcp', ip: '0.0.0.0' }] },
        { id: 'b', name: 'nginx', image: 'nginx:latest', state: 'running', ports: [] },
        { id: 'c', name: 'redis-live', image: 'docker.io/library/redis:8', state: 'running', ports: [{ host: '56379', container: '6379', protocol: 'tcp', ip: '0.0.0.0' }] },
        { id: 'd', name: 'db', image: 'postgres:18', state: 'running', ports: [{ host: '55432', container: '5432', protocol: 'tcp', ip: '0.0.0.0' }] },
      ]
    },
    async inspectContainer(id) {
      inspected.push(id)
      return {
        id,
        env: id === 'c' ? [{ key: 'REDISCLI_AUTH', value: 'localredis' }] : id === 'd' ? [{ key: 'POSTGRES_PASSWORD', value: 'pw' }] : [],
      }
    },
  }
  const found = await discoverCandidates(dockerService)
  assert.deepEqual(inspected.sort(), ['a', 'c', 'd'])
  assert.equal(found.redis.length, 2)
  assert.equal(found.redis[0].name, 'redis-live')
  assert.equal(found.redis[0].hostPort, 56379)
  assert.equal(found.redis[0].credentials.password, 'localredis')
  assert.equal(found.postgres.length, 1)
  assert.equal(found.postgres[0].hostPort, 55432)
})

test('discoverCandidates tolerates a container vanishing between ps and inspect', async () => {
  const dockerService = {
    async listContainers() {
      return [{ id: 'a', name: 'redis', image: 'redis:7', state: 'running', ports: [{ host: '6380', container: '6379', protocol: 'tcp', ip: '0.0.0.0' }] }]
    },
    async inspectContainer() {
      throw new Error('No such container')
    },
  }
  const found = await discoverCandidates(dockerService)
  assert.equal(found.redis.length, 1)
  assert.equal(found.redis[0].hostPort, 6380)
  assert.deepEqual(found.redis[0].credentials, {})
})
