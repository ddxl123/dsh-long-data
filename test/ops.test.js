/**
 * Integration tests for the operations dispatcher against the services on this
 * machine.
 *
 * The unit tests already cover validation, settings and the route. These tests
 * prove the end-to-end contract: a real Docker daemon, a real Redis server and a
 * real PostgreSQL server answer through the same `run(endpoint, payload)` the
 * browser and the tools call. Every test that needs a service skips cleanly when
 * that service is not reachable, so the suite stays green on a machine without
 * Docker/Redis/PostgreSQL.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { createOps, redactEnv } from '../src/ops.js'
import { SettingsStore } from '../src/settings.js'

const DOCKER_CONTAINER = 'yida_nginx'
// Manual-mode fixtures for the protocol round-trip tests. They are optional: the
// tests skip when nothing listens there. Override with env vars when your Redis /
// PostgreSQL are reachable somewhere else.
const REDIS = {
  mode: 'manual',
  host: process.env.DSH_LONG_DATA_REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_LONG_DATA_REDIS_PORT ?? 6379),
  password: process.env.DSH_LONG_DATA_REDIS_PASSWORD ?? '',
}
const POSTGRES = {
  mode: 'manual',
  host: process.env.DSH_LONG_DATA_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_LONG_DATA_PG_PORT ?? 5432),
  user: process.env.DSH_LONG_DATA_PG_USER ?? 'postgres',
  password: process.env.DSH_LONG_DATA_PG_PASSWORD ?? '',
  database: process.env.DSH_LONG_DATA_PG_DATABASE ?? 'postgres',
}

/** The docker-mode overrides used by the discovery tests. */
const DOCKER_MODE = {
  redis: { mode: 'docker', container: '', host: '127.0.0.1', port: 6379, username: '', password: '', db: 0 },
  postgres: { mode: 'docker', container: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: '' },
}

/**
 * @param {object} [overrides] - settings overrides.
 * @returns {{ ops: ReturnType<typeof createOps>, directory: string }} the ops object and its temp dir.
 */
function makeOps(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-long-data-ops-'))
  const config = resolveConfig(undefined)
  const store = new SettingsStore({
    path: join(directory, 'settings.json'),
    defaults: {
      docker: { ...config.docker },
      redis: { ...config.redis, ...REDIS, ...(overrides.redis ?? {}) },
      postgres: { ...config.postgres, ...POSTGRES, ...(overrides.postgres ?? {}) },
      dockerfiles: { ...config.dockerfiles, ...(overrides.dockerfiles ?? {}) },
    },
  }).load()
  if (overrides.save !== undefined) store.save(overrides.save)
  return {
    ops: createOps({
      settings: store,
      config,
      workspaceRoots: typeof overrides.workspaceRoots === 'function' ? overrides.workspaceRoots : () => [],
    }),
    directory,
  }
}

/**
 * Write a small Dockerfile fixture tree.
 *
 * @returns {string} the scan root.
 */
function makeDockerfileTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-long-data-scan-'))
  mkdirSync(join(root, 'service'), { recursive: true })
  writeFileSync(join(root, 'service', 'Dockerfile'), [
    '# syntax=docker/dockerfile:1',
    'ARG BASE=nginx:1.31.6',
    'FROM ${BASE} AS web',
    'WORKDIR /usr/share/nginx/html',
    'COPY index.html .',
    'RUN echo built',
    'EXPOSE 80 443/tcp',
    'ENV APP_ENV=production PORT=8080',
    'HEALTHCHECK CMD curl -f http://localhost/ || exit 1',
    'CMD ["nginx", "-g", "daemon off;"]',
    'FROM alpine:3.20 AS tools',
    'RUN apk add curl',
  ].join('\n'))
  mkdirSync(join(root, 'plain'), { recursive: true })
  writeFileSync(join(root, 'plain', 'Dockerfile.dev'), 'FROM node:20\nWORKDIR /app\nCMD ["node","server.js"]\n')
  writeFileSync(join(root, 'notes.txt'), 'FROM is a word at the start of this line\n')
  return root
}

/**
 * @param {object} envelope - an ops envelope.
 * @returns {string} the failure code, or 'ok'.
 */
function codeOf(envelope) {
  return envelope.ok ? 'ok' : envelope.error.code
}

/**
 * Skip a test when the failure is "the service is not there", but fail it for
 * any other reason (a refused password is a real problem, not an absent service).
 *
 * @param {import('node:test').TestContext} t - the test context.
 * @param {object} envelope - the probe envelope.
 * @param {Set<string>} absentCodes - codes that mean "service absent".
 * @returns {boolean} whether the test should return early.
 */
function skipWhenAbsent(t, envelope, absentCodes) {
  const code = codeOf(envelope)
  if (!absentCodes.has(code)) return false
  t.skip(`service not reachable: ${envelope.ok ? 'ok' : envelope.error.message}`)
  return true
}

const DOCKER_ABSENT = new Set(['docker_unavailable', 'docker_timeout'])
const REDIS_ABSENT = new Set(['redis_unreachable', 'redis_timeout'])
const PG_ABSENT = new Set(['pg_unreachable', 'pg_timeout'])

test('state reports the version, the redacted settings and Docker availability', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const envelope = await ops.run('state')
    assert.equal(envelope.ok, true)
    const value = envelope.value
    assert.equal(typeof value.version, 'string')
    assert.equal(value.settings.redis.port, REDIS.port)
    assert.equal(value.settings.redis.hasPassword, REDIS.password !== '')
    assert.equal(value.settings.redis.mode, 'manual')
    assert.equal(Object.hasOwn(value.settings.redis, 'password'), false)
    assert.equal(Object.hasOwn(value.settings.postgres, 'password'), false)
    assert.equal(typeof value.docker.available, 'boolean')
    assert.equal(Array.isArray(value.targets.redis.candidates), true)
    assert.equal(Array.isArray(value.targets.postgres.candidates), true)
    assert.equal(Array.isArray(value.targets.redis.instances), true)
    assert.equal(Array.isArray(value.targets.postgres.instances), true)
    assert.equal(value.targets.redis.resolved.mode, 'manual')
    assert.equal(value.targets.redis.resolved.host, '127.0.0.1')
    assert.equal(value.targets.redis.resolved.port, REDIS.port)
    assert.equal(value.targets.postgres.resolved.mode, 'manual')
    if (value.docker.available === false) t.diagnostic(`docker unavailable: ${value.docker.error}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown endpoint is a failure envelope, not a throw', async () => {
  const { ops, directory } = makeOps()
  try {
    const envelope = await ops.run('does.not.exist')
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'unknown_endpoint')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('invalid payloads are reported with the failing field', async () => {
  const { ops, directory } = makeOps()
  try {
    for (const [endpoint, payload, field] of [
      ['docker.action', { action: 'start' }, 'id'],
      ['docker.action', { id: 'x', action: 'explode' }, 'action'],
      ['docker.inspect', {}, 'id'],
      ['redis.get', {}, 'key'],
      ['redis.set', { key: 'k' }, 'value'],
      ['redis.del', {}, 'key'],
      ['pg.query', {}, 'sql'],
      ['pg.columns', { schema: 'public' }, 'table'],
      ['settings.save', { redis: { port: 0 } }, 'redis.port'],
      ['settings.save', { redis: { mode: 'auto' } }, 'redis.mode'],
      ['settings.save', { postgres: { container: '-bad' } }, 'postgres.container'],
    ]) {
      const envelope = await ops.run(endpoint, payload)
      assert.equal(envelope.ok, false, `${endpoint} ${JSON.stringify(payload)} must fail`)
      assert.equal(envelope.error.code, 'invalid_payload', endpoint)
      assert.equal(envelope.error.details.field, field, `${endpoint} must name ${field}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a container id that looks like a flag is refused before any spawn', async () => {
  const { ops, directory } = makeOps()
  try {
    const envelope = await ops.run('docker.inspect', { id: '--help' })
    assert.equal(envelope.ok, false)
    assert.ok(['docker_invalid_id', 'invalid_payload'].includes(envelope.error.code), JSON.stringify(envelope.error))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('settings save is durable and the new connection is used by later ops', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const saved = await ops.run('settings.save', { redis: { mode: 'manual', host: '127.0.0.1', port: 1 } })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.redis.port, 1)
    assert.equal(saved.value.redis.mode, 'manual')
    const ping = await ops.run('redis.ping')
    assert.equal(ping.ok, false)
    assert.ok(['redis_unreachable', 'redis_timeout'].includes(ping.error.code), JSON.stringify(ping.error))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker lists containers and inspects one with credentials masked', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const list = await ops.run('docker.list')
    if (skipWhenAbsent(t, list, DOCKER_ABSENT)) return
    assert.equal(list.ok, true, JSON.stringify(list.error))
    assert.ok(list.value.containers.length >= 1)
    const nginx = list.value.containers.find((container) => container.name === DOCKER_CONTAINER) ?? list.value.containers[0]
    assert.equal(typeof nginx.id, 'string')
    assert.equal(typeof nginx.state, 'string')
    assert.ok(Array.isArray(nginx.ports))

    const inspect = await ops.run('docker.inspect', { id: nginx.id })
    assert.equal(inspect.ok, true, JSON.stringify(inspect.error))
    assert.ok(Array.isArray(inspect.value.container.env))
    for (const entry of inspect.value.container.env) {
      if (/auth|password|secret|token/i.test(entry.key)) assert.equal(entry.value, '***', entry.key)
    }

    const logs = await ops.run('docker.logs', { id: nginx.id, tail: 5 })
    assert.equal(logs.ok, true, JSON.stringify(logs.error))
    assert.equal(typeof logs.value.logs, 'string')

    const stats = await ops.run('docker.stats')
    assert.equal(stats.ok, true, JSON.stringify(stats.error))
    assert.ok(Array.isArray(stats.value.stats))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker images, volumes, networks and disk usage are readable', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return

    const images = await ops.run('docker.images')
    assert.equal(images.ok, true, JSON.stringify(images.error))
    assert.equal(images.value.count, images.value.images.length)
    if (images.value.images.length > 0) {
      const image = images.value.images[0]
      assert.equal(typeof image.id, 'string')
      assert.equal(image.shortId, image.id.replace('sha256:', '').slice(0, 12))
      assert.equal(typeof image.sizeBytes, 'number')
      assert.ok(Array.isArray(image.repoTags))
    }

    const volumes = await ops.run('docker.volumes')
    assert.equal(volumes.ok, true, JSON.stringify(volumes.error))
    assert.equal(volumes.value.count, volumes.value.volumes.length)
    for (const volume of volumes.value.volumes) {
      assert.equal(typeof volume.name, 'string')
      assert.equal(typeof volume.driver, 'string')
    }

    const networks = await ops.run('docker.networks')
    assert.equal(networks.ok, true, JSON.stringify(networks.error))
    assert.ok(networks.value.networks.some((network) => network.name === 'bridge'))
    for (const network of networks.value.networks) {
      assert.equal(typeof network.name, 'string')
      assert.equal(typeof network.internal, 'boolean')
    }

    const usage = await ops.run('docker.diskUsage')
    assert.equal(usage.ok, true, JSON.stringify(usage.error))
    for (const key of ['images', 'containers', 'volumes', 'buildCache']) {
      assert.equal(typeof usage.value.usage[key], 'object', key)
      assert.equal(typeof usage.value.usage[key].count, 'number')
      assert.equal(typeof usage.value.usage[key].size, 'string')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker remove endpoints reject option-like targets before touching anything', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const image = await ops.run('docker.imageRemove', { id: '--force' })
    assert.equal(image.ok, false)
    assert.ok(['docker_invalid_image', 'invalid_payload'].includes(image.error.code), JSON.stringify(image.error))
    const volume = await ops.run('docker.volumeRemove', { name: '--force' })
    assert.equal(volume.ok, false)
    assert.ok(['docker_invalid_volume', 'invalid_payload'].includes(volume.error.code), JSON.stringify(volume.error))
    const network = await ops.run('docker.networkRemove', { name: '--force' })
    assert.equal(network.ok, false)
    assert.ok(['docker_invalid_network', 'invalid_payload'].includes(network.error.code), JSON.stringify(network.error))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker mode exposes discovered candidates without leaking credentials', async (t) => {
  const { ops, directory } = makeOps(DOCKER_MODE)
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    assert.equal(state.ok, true)
    for (const service of ['redis', 'postgres']) {
      const targets = state.value.targets[service]
      assert.equal(Array.isArray(targets.candidates), true, service)
      assert.ok(targets.resolved === null || typeof targets.resolved === 'object', service)
      for (const candidate of targets.candidates) {
        assert.equal(typeof candidate.name, 'string')
        assert.equal(typeof candidate.image, 'string')
        assert.equal(typeof candidate.running, 'boolean')
        assert.equal(typeof candidate.hasPassword, 'boolean')
        assert.equal(Object.hasOwn(candidate, 'password'), false)
        assert.equal(Object.hasOwn(candidate, 'credentials'), false)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker mode connects to the discovered Redis container when it carries credentials', async (t) => {
  const { ops, directory } = makeOps(DOCKER_MODE)
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    const targets = state.value.targets.redis
    if (targets.resolved === null) {
      t.skip(`no usable Redis container here: ${targets.error?.message ?? 'none discovered'}`)
      return
    }
    if (targets.resolved.credentialsSource !== 'container-env') {
      t.skip('the discovered Redis container exposes no credentials in its environment')
      return
    }
    const ping = await ops.run('redis.ping')
    if (!ping.ok) {
      t.skip(`the discovered Redis container is not reachable right now: ${ping.error.message}`)
      return
    }
    assert.equal(ping.value.pong, true)
    const info = await ops.run('redis.info')
    assert.equal(info.ok, true, JSON.stringify(info.error))
    const scan = await ops.run('redis.scan', { match: 'dsh-long-data:never:*', count: 5 })
    assert.equal(scan.ok, true, JSON.stringify(scan.error))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker mode connects to the discovered PostgreSQL container when it carries credentials', async (t) => {
  const { ops, directory } = makeOps(DOCKER_MODE)
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    const targets = state.value.targets.postgres
    if (targets.resolved === null) {
      t.skip(`no usable PostgreSQL container here: ${targets.error?.message ?? 'none discovered'}`)
      return
    }
    if (targets.resolved.credentialsSource !== 'container-env') {
      t.skip('the discovered PostgreSQL container exposes no credentials in its environment')
      return
    }
    const version = await ops.run('pg.version')
    if (!version.ok) {
      t.skip(`the discovered PostgreSQL container is not reachable right now: ${version.error.message}`)
      return
    }
    assert.match(version.value.version, /PostgreSQL/)
    const query = await ops.run('pg.query', { sql: 'select 1 as n, current_user as u' })
    assert.equal(query.ok, true, JSON.stringify(query.error))
    assert.deepEqual(query.value.results[0].rows[0][0], '1')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docker mode reports a pinned container that does not exist', async (t) => {
  const { ops, directory } = makeOps({
    redis: { ...DOCKER_MODE.redis, container: 'definitely-not-a-container' },
    postgres: DOCKER_MODE.postgres,
  })
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    assert.equal(state.value.targets.redis.resolved, null)
    assert.equal(state.value.targets.redis.error.code, 'redis_container_not_found')
    assert.deepEqual(state.value.targets.redis.error.details.available !== undefined, true)
    const ping = await ops.run('redis.ping')
    assert.equal(ping.ok, false)
    assert.equal(ping.error.code, 'redis_container_not_found')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('redis ping, info, scan, set, get and del round-trip against the live server', async (t) => {
  const { ops, directory } = makeOps()
  const key = `dsh-long-data:test:${process.pid}:${Date.now()}`
  try {
    const ping = await ops.run('redis.ping')
    if (skipWhenAbsent(t, ping, REDIS_ABSENT)) return
    assert.equal(ping.ok, true, JSON.stringify(ping.error))
    assert.equal(ping.value.pong, true)
    assert.ok(ping.value.latencyMs >= 0)

    const info = await ops.run('redis.info')
    assert.equal(info.ok, true)
    assert.equal(typeof info.value.summary, 'object')
    assert.equal(typeof info.value.sections, 'object')

    const set = await ops.run('redis.set', { key, value: 'hello', ttlSeconds: 60 })
    assert.equal(set.ok, true, JSON.stringify(set.error))

    const get = await ops.run('redis.get', { key })
    assert.equal(get.ok, true, JSON.stringify(get.error))
    assert.equal(get.value.type, 'string')
    assert.equal(get.value.value, 'hello')
    assert.ok(get.value.ttl > 0 && get.value.ttl <= 60)

    // One SCAN round is a hint, not a guarantee: walk the cursor until the key
    // shows up (or the iteration closes) exactly as the panel's load-more does.
    let cursor = '0'
    let found = false
    for (let round = 0; round < 32 && !found; round += 1) {
      const scan = await ops.run('redis.scan', { cursor, match: `${key}*`, count: 100 })
      assert.equal(scan.ok, true, JSON.stringify(scan.error))
      assert.equal(typeof scan.value.cursor, 'string')
      assert.equal(typeof scan.value.done, 'boolean')
      if (scan.value.keys.includes(key)) found = true
      if (scan.value.done) break
      cursor = scan.value.cursor
    }
    assert.equal(found, true, 'the key created above must be discoverable through SCAN')

    const del = await ops.run('redis.del', { key })
    assert.equal(del.ok, true)
    assert.equal(del.value.deleted, 1)
    const gone = await ops.run('redis.get', { key })
    assert.equal(gone.ok, true)
    assert.equal(gone.value.type, 'none')
  } finally {
    await ops.run('redis.del', { key }).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('postgres version, databases, tables, columns and query work against the live server', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const version = await ops.run('pg.version')
    if (skipWhenAbsent(t, version, PG_ABSENT)) return
    assert.equal(version.ok, true, JSON.stringify(version.error))
    assert.match(version.value.version, /PostgreSQL/)
    assert.equal(version.value.currentUser, 'yida_postgres')
    assert.equal(version.value.currentDatabase, 'yida')

    const databases = await ops.run('pg.databases')
    assert.equal(databases.ok, true, JSON.stringify(databases.error))
    assert.ok(databases.value.databases.some((database) => database.name === 'yida'))

    const tables = await ops.run('pg.tables', { schema: 'public' })
    assert.equal(tables.ok, true, JSON.stringify(tables.error))
    assert.ok(Array.isArray(tables.value.tables))

    const query = await ops.run('pg.query', { sql: 'select 1 as n, null as nothing, current_database() as db' })
    assert.equal(query.ok, true, JSON.stringify(query.error))
    assert.equal(query.value.results.length, 1)
    const result = query.value.results[0]
    assert.deepEqual(result.columns.map((column) => column.name), ['n', 'nothing', 'db'])
    assert.deepEqual(result.rows[0], ['1', null, 'yida'])
    assert.equal(result.rowCount, 1)
    assert.equal(typeof query.value.durationMs, 'number')

    const truncated = await ops.run('pg.query', { sql: 'select generate_series(1, 10) as n', maxRows: 3 })
    assert.equal(truncated.ok, true)
    assert.equal(truncated.value.truncated, true)
    assert.equal(truncated.value.results[0].rows.length, 3)

    const truncatedById = await ops.run('pg.query', { sql: 'select datname from pg_database', maxRows: 1 })
    assert.equal(truncatedById.ok, true)
    assert.ok(truncatedById.value.results[0].rows.length <= 1)

    const failed = await ops.run('pg.query', { sql: 'select * from definitely_not_a_table' })
    assert.equal(failed.ok, false)
    assert.ok(['pg_query_failed', 'pg_internal_error'].includes(failed.error.code), JSON.stringify(failed.error))
    if (failed.error.code === 'pg_query_failed') assert.equal(failed.error.details.sqlState, '42P01')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('dockerfiles.list and dockerfiles.read recognize and parse real Dockerfiles', async () => {
  const scanRoot = makeDockerfileTree()
  const { ops, directory } = makeOps({ dockerfiles: { roots: [scanRoot], maxDepth: 6 } })
  try {
    const listed = await ops.run('dockerfiles.list', {})
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    assert.ok(listed.value.roots.includes(scanRoot))
    assert.equal(listed.value.dockerfiles.length, 2)
    const names = listed.value.dockerfiles.map((file) => file.name).sort()
    assert.deepEqual(names, ['Dockerfile', 'Dockerfile.dev'])
    const main = listed.value.dockerfiles.find((file) => file.name === 'Dockerfile')
    assert.equal(main.multiStage, true)
    assert.equal(main.stageCount, 2)
    assert.equal(typeof main.relativePath, 'string')
    assert.equal(main.relativePath.endsWith('service/Dockerfile'), true)
    assert.ok(main.baseImages.some((image) => image.includes('nginx')))
    assert.ok(main.exposedPorts.includes('80'))
    assert.equal(typeof main.instructionCount, 'number')
    assert.equal(typeof main.suggestedTag, 'string')
    assert.equal(typeof main.contextPath, 'string')

    const read = await ops.run('dockerfiles.read', { path: main.path })
    assert.equal(read.ok, true, JSON.stringify(read.error))
    assert.match(read.value.content, /^ARG BASE=/m)
    assert.equal(read.value.parsed.multiStage, true)
    assert.ok(read.value.parsed.stages.length === 2)
    assert.equal(read.value.parsed.stages[0].name, 'web')
    assert.ok(read.value.parsed.stages[0].exposedPorts.includes('443'))
    assert.equal(read.value.parsed.stages[0].healthcheck, true)
    assert.equal(read.value.parsed.warnings.length, 0)
    assert.equal(typeof read.value.truncated, 'boolean')

    const missing = await ops.run('dockerfiles.read', { path: '/tmp/definitely-not-in-scan/Dockerfile' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'dockerfiles_not_found')

    const outside = await ops.run('dockerfiles.read', { path: '/etc/hosts' })
    assert.equal(outside.ok, false)
    assert.equal(outside.error.code, 'dockerfiles_not_found')

    const refreshed = await ops.run('dockerfiles.list', { refresh: true })
    assert.equal(refreshed.ok, true)
    assert.equal(refreshed.value.dockerfiles.length, 2)

    const overview = await ops.run('overview')
    assert.equal(overview.ok, true)
    assert.equal(overview.value.dockerfiles.count, 2)
    assert.ok(overview.value.insights.some((insight) => insight.code === 'dockerfiles_found' && insight.params.count === 2))
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(scanRoot, { recursive: true, force: true })
  }
})

test('dockerfiles.list reports an empty result without configured roots', async () => {
  const { ops, directory } = makeOps()
  try {
    const listed = await ops.run('dockerfiles.list', {})
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.value.dockerfiles, [])
    assert.deepEqual(listed.value.roots, [])
    assert.equal(typeof listed.value.scan.visitedFiles, 'number')
    assert.deepEqual(listed.value.scan.errors, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the overview reports plain-language health, projects and insights', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const result = await ops.run('overview')
    assert.equal(result.ok, true, JSON.stringify(result.error))
    const value = result.value
    assert.equal(typeof value.generatedAt, 'string')
    assert.equal(value.docker.available, true)
    assert.equal(value.counts.containers, probe.value.containers.length)
    assert.equal(typeof value.counts.running, 'number')
    assert.equal(typeof value.counts.stopped, 'number')
    assert.equal(value.containers.length, probe.value.containers.length)
    for (const container of value.containers) {
      assert.ok(['website', 'application', 'database', 'cache', 'queue', 'storage', 'monitoring', 'other'].includes(container.role), `${container.name}: ${container.role}`)
      assert.equal(typeof container.volumes, 'number')
      assert.equal(typeof container.bindMounts, 'number')
      assert.equal(typeof container.networks, 'number')
      assert.ok(container.project === null || typeof container.project === 'string')
      assert.ok(container.restartPolicy === null || typeof container.restartPolicy === 'string')
    }
    assert.ok(Array.isArray(value.projects))
    for (const project of value.projects) {
      assert.equal(value.containers.filter((container) => container.project === project.name).length, project.containers)
    }
    for (const service of ['redis', 'postgres']) {
      const health = value.services[service]
      assert.equal(typeof health.mode, 'string')
      assert.equal(typeof health.reachable, 'boolean')
      assert.equal(typeof health.instances, 'number')
      assert.equal(typeof health.ambiguous, 'boolean')
      assert.equal(typeof health.summary, 'object')
      assert.ok(health.error === null || typeof health.error.code === 'string')
      assert.equal(Object.hasOwn(health, 'password'), false)
    }
    assert.ok(Array.isArray(value.insights))
    for (const insight of value.insights) {
      assert.ok(['good', 'info', 'warn', 'danger'].includes(insight.level), insight.code)
      assert.equal(typeof insight.code, 'string')
      assert.equal(typeof insight.params, 'object')
    }
    const codes = value.insights.map((insight) => insight.code)
    if (value.services.redis.reachable) assert.ok(codes.includes('redis_ok'))
    else assert.ok(codes.some((code) => code.startsWith('redis_')))
    if (value.services.postgres.reachable) assert.ok(codes.includes('postgres_ok'))
    else assert.ok(codes.some((code) => code.startsWith('postgres_')))
    assert.equal(JSON.stringify(value).includes('localredis'), false)
    assert.equal(JSON.stringify(value).includes('"password"'), false)
    assert.ok(value.dockerfiles === null || typeof value.dockerfiles === 'object')
    if (value.dockerfiles !== null) {
      assert.equal(typeof value.dockerfiles.count, 'number')
      assert.equal(typeof value.dockerfiles.generatedAt, 'string')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the Docker relation graph is available through ops', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const result = await ops.run('docker.relations')
    assert.equal(result.ok, true, JSON.stringify(result.error))
    const relations = result.value.relations
    assert.equal(relations.summary.containers, probe.value.containers.length)
    for (const key of ['containers', 'images', 'volumes', 'networks']) {
      assert.equal(Array.isArray(relations[key]), true, key)
    }
    for (const container of relations.containers) {
      assert.equal(typeof container.name, 'string')
      assert.equal(typeof container.image, 'string')
      assert.ok(Array.isArray(container.volumes))
      assert.ok(Array.isArray(container.networks))
    }
    assert.equal(JSON.stringify(relations).includes('POSTGRES_PASSWORD'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Docker inspect endpoints validate targets and read real resources', async (t) => {
  const { ops, directory } = makeOps()
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return

    for (const [endpoint, payload, allowed] of [
      ['docker.imageInspect', { id: '--force' }, ['docker_invalid_image', 'invalid_payload']],
      ['docker.volumeInspect', { name: '--force' }, ['docker_invalid_volume', 'invalid_payload']],
      ['docker.networkInspect', { name: '--force' }, ['docker_invalid_network', 'invalid_payload']],
    ]) {
      const rejected = await ops.run(endpoint, payload)
      assert.equal(rejected.ok, false, endpoint)
      assert.ok(allowed.includes(rejected.error.code), `${endpoint}: ${JSON.stringify(rejected.error)}`)
    }

    const images = await ops.run('docker.images')
    if (images.ok && images.value.images.length > 0) {
      const image = await ops.run('docker.imageInspect', { id: images.value.images[0].id })
      assert.equal(image.ok, true, JSON.stringify(image.error))
      assert.equal(typeof image.value.image.id, 'string')
      assert.ok(Array.isArray(image.value.image.repoTags))
      assert.equal(typeof image.value.image.sizeBytes, 'number')
    }

    const network = await ops.run('docker.networkInspect', { name: 'bridge' })
    assert.equal(network.ok, true, JSON.stringify(network.error))
    assert.equal(network.value.network.name, 'bridge')
    assert.ok(Array.isArray(network.value.network.subnets))
    assert.ok(Array.isArray(network.value.network.containers))

    const volumes = await ops.run('docker.volumes')
    if (volumes.ok && volumes.value.volumes.length > 0) {
      const volume = await ops.run('docker.volumeInspect', { name: volumes.value.volumes[0].name })
      assert.equal(volume.ok, true, JSON.stringify(volume.error))
      assert.equal(volume.value.volume.name, volumes.value.volumes[0].name)
      assert.equal(typeof volume.value.volume.anonymous, 'boolean')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('multiple running Redis instances are all reported, ambiguity is explicit, and a pin selects one', async (t) => {
  const { ops, directory } = makeOps(DOCKER_MODE)
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    const targets = state.value.targets.redis
    if (targets.instances.length < 2) {
      t.skip(`needs two running Redis containers, found ${targets.instances.length}`)
      return
    }
    assert.equal(targets.resolved, null)
    assert.equal(targets.error.code, 'redis_ambiguous_container')
    assert.equal(targets.error.details.candidates.length, targets.instances.length)
    for (const instance of targets.instances) {
      assert.equal(typeof instance.container, 'string')
      assert.equal(typeof instance.host, 'string')
      assert.equal(Object.hasOwn(instance, 'password'), false)
    }
    const ping = await ops.run('redis.ping')
    assert.equal(ping.ok, false)
    assert.equal(ping.error.code, 'redis_ambiguous_container')

    const chosen = targets.instances[0].container
    const saved = await ops.run('settings.save', { redis: { mode: 'docker', container: chosen } })
    assert.equal(saved.ok, true)
    const after = await ops.run('state')
    assert.equal(after.value.targets.redis.resolved.container, chosen)
    assert.equal(after.value.targets.redis.error, null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Redis v0.3 editors round-trip through ops', async (t) => {
  const { ops, directory } = makeOps(DOCKER_MODE)
  const base = `dsh-long-data:test:${process.pid}:${Date.now()}`
  const keys = [`${base}:str`, `${base}:hash`, `${base}:list`, `${base}:set`, `${base}:renamed`]
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    const targets = state.value.targets.redis
    if (targets.resolved === null) {
      t.skip(`no usable Redis container: ${targets.error?.message ?? 'none'}`)
      return
    }
    const ping = await ops.run('redis.ping')
    if (!ping.ok) {
      t.skip(`Redis not reachable through the discovered container: ${ping.error.message}`)
      return
    }

    const clients = await ops.run('redis.clients')
    assert.equal(clients.ok, true, JSON.stringify(clients.error))
    assert.ok(clients.value.count >= 1)
    assert.ok(Array.isArray(clients.value.clients))
    const size = await ops.run('redis.dbsize')
    assert.equal(size.ok, true)
    assert.equal(typeof size.value.keys, 'number')

    const str = await ops.run('redis.set', { key: keys[0], value: 'hello' })
    assert.equal(str.ok, true)
    const memory = await ops.run('redis.memory', { key: keys[0] })
    assert.equal(memory.ok, true, JSON.stringify(memory.error))
    assert.ok(memory.value.bytes > 0)
    assert.equal(typeof memory.value.human, 'string')

    const hash = await ops.run('redis.hashSet', { key: keys[1], field: 'name', value: 'alice' })
    assert.equal(hash.ok, true, JSON.stringify(hash.error))
    assert.equal(hash.value.fieldCount, 1)
    const hashGet = await ops.run('redis.get', { key: keys[1] })
    assert.equal(hashGet.value.type, 'hash')
    assert.equal(hashGet.value.value.name, 'alice')

    const pushed = await ops.run('redis.listPush', { key: keys[2], value: 'a', side: 'right' })
    assert.equal(pushed.ok, true)
    assert.equal(pushed.value.length, 1)

    const added = await ops.run('redis.setAdd', { key: keys[3], member: 'm1' })
    assert.equal(added.ok, true)
    assert.equal(added.value.length, 1)
    const removed = await ops.run('redis.setRemove', { key: keys[3], member: 'm1' })
    assert.equal(removed.ok, true)
    assert.equal(removed.value.removed, 1)

    const renamed = await ops.run('redis.rename', { key: keys[0], newKey: keys[4] })
    assert.equal(renamed.ok, true, JSON.stringify(renamed.error))
    const moved = await ops.run('redis.get', { key: keys[4] })
    assert.equal(moved.value.value, 'hello')

    const expired = await ops.run('redis.expire', { key: keys[4], ttlSeconds: 120 })
    assert.equal(expired.ok, true, JSON.stringify(expired.error))
    assert.ok(expired.value.ttl > 0 && expired.value.ttl <= 120)
    const persisted = await ops.run('redis.persist', { key: keys[4] })
    assert.equal(persisted.ok, true)
    assert.equal(persisted.value.ttl, -1)

    const badTtl = await ops.run('redis.expire', { key: keys[4], ttlSeconds: 0 })
    assert.equal(badTtl.ok, false)
    assert.equal(badTtl.error.code, 'invalid_payload')
    const badSide = await ops.run('redis.listPush', { key: keys[2], value: 'x', side: 'middle' })
    assert.equal(badSide.ok, false)
    assert.equal(badSide.error.details.field, 'side')
  } finally {
    for (const key of keys) await ops.run('redis.del', { key }).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL v0.3 endpoints work through ops', async (t) => {
  const { ops, directory } = makeOps(DOCKER_MODE)
  try {
    const probe = await ops.run('docker.list')
    if (skipWhenAbsent(t, probe, DOCKER_ABSENT)) return
    const state = await ops.run('state')
    const targets = state.value.targets.postgres
    if (targets.resolved === null) {
      t.skip(`no usable PostgreSQL container: ${targets.error?.message ?? 'none'}`)
      return
    }
    const version = await ops.run('pg.version')
    if (!version.ok) {
      t.skip(`PostgreSQL not reachable through the discovered container: ${version.error.message}`)
      return
    }

    const activity = await ops.run('pg.activity')
    assert.equal(activity.ok, true, JSON.stringify(activity.error))
    assert.ok(Array.isArray(activity.value.sessions))
    assert.ok(activity.value.sessions.length >= 1)
    for (const session of activity.value.sessions) {
      assert.equal(typeof session.pid, 'number')
    }

    const databases = await ops.run('pg.databases')
    assert.equal(databases.ok, true)
    assert.equal(typeof databases.value.databases[0].connections, 'number')

    const tables = await ops.run('pg.tables', { schema: 'pg_catalog' })
    assert.equal(tables.ok, true, JSON.stringify(tables.error))
    const rel = tables.value.tables.find((table) => table.name === 'pg_database')
    assert.ok(rel !== undefined)
    assert.equal(typeof rel.sizeBytes, 'number')
    assert.equal(typeof rel.columnCount, 'number')

    const detail = await ops.run('pg.tableDetail', { schema: 'pg_catalog', table: 'pg_database' })
    assert.equal(detail.ok, true, JSON.stringify(detail.error))
    assert.equal(typeof detail.value.size.total, 'string')
    assert.ok(detail.value.columns.some((column) => column.name === 'datname'))
    assert.ok(Array.isArray(detail.value.indexes))
    assert.ok(Array.isArray(detail.value.constraints))

    const browse = await ops.run('pg.browse', { schema: 'pg_catalog', table: 'pg_database', limit: 2, offset: 0, orderBy: 'datname', withCount: true })
    assert.equal(browse.ok, true, JSON.stringify(browse.error))
    assert.ok(browse.value.rows.length <= 2)
    assert.ok(browse.value.rowCount <= 2)
    assert.equal(typeof browse.value.totalRows, 'number')
    assert.equal(browse.value.limitedBy, 'limit')

    const badOrder = await ops.run('pg.browse', { schema: 'pg_catalog', table: 'pg_database', orderBy: 'not_a_column' })
    assert.equal(badOrder.ok, false)
    assert.equal(badOrder.error.code, 'pg_invalid_argument')
    const tooLarge = await ops.run('pg.browse', { schema: 'pg_catalog', table: 'pg_database', limit: 5000 })
    assert.equal(tooLarge.ok, false)
    assert.equal(tooLarge.error.code, 'invalid_payload')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('redactEnv masks credential-looking keys only', () => {
  const redacted = redactEnv([
    { key: 'PATH', value: '/usr/bin' },
    { key: 'POSTGRES_PASSWORD', value: 'hunter2' },
    { key: 'REDISCLI_AUTH', value: 'localredis' },
    { key: 'GITHUB_TOKEN', value: 'ghp_x' },
    { key: 'API_KEY', value: 'abc' },
    { key: 'HOME', value: '/root' },
  ])
  assert.deepEqual(redacted.map((entry) => entry.value), ['/usr/bin', '***', '***', '***', '***', '/root'])
})
