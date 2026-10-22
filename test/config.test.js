/**
 * Tests for the composition-row config resolution and the state directory.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONFIG_DEFAULTS, resolveConfig, settingsDefaultsFrom, stateDirectory } from '../src/config.js'

test('resolveConfig fills every default when the row carries no config', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.settingsFile, 'settings.json')
  assert.deepEqual(config.docker, { ...CONFIG_DEFAULTS.docker })
  assert.deepEqual(config.redis, { ...CONFIG_DEFAULTS.redis })
  assert.deepEqual(config.postgres, { ...CONFIG_DEFAULTS.postgres })
  assert.equal(config.logTailDefault, 200)
  assert.equal(config.maxQueryRows, 500)
  assert.equal(config.maxKeyScan, 500)
})

test('resolveConfig keeps valid overrides', () => {
  const config = resolveConfig({
    settingsFile: 'custom.json',
    docker: { binary: '/usr/local/bin/docker', timeoutMs: 5000 },
    redis: { mode: 'manual', container: 'cache', host: 'redis.local', port: 6380, username: 'app', password: 's3cret', db: 3, tls: true, timeoutMs: 2000 },
    postgres: { mode: 'manual', container: 'db', host: 'pg.local', port: 6432, user: 'app', password: 'pw', database: 'app', ssl: 'require', timeoutMs: 3000 },
    logTailDefault: 50,
    maxQueryRows: 100,
    maxKeyScan: 1000,
  })
  assert.equal(config.settingsFile, 'custom.json')
  assert.equal(config.docker.binary, '/usr/local/bin/docker')
  assert.equal(config.redis.mode, 'manual')
  assert.equal(config.redis.container, 'cache')
  assert.equal(config.postgres.mode, 'manual')
  assert.equal(config.postgres.container, 'db')
  assert.equal(config.redis.host, 'redis.local')
  assert.equal(config.redis.port, 6380)
  assert.equal(config.redis.password, 's3cret')
  assert.equal(config.redis.tls, true)
  assert.equal(config.postgres.ssl, 'require')
  assert.equal(config.logTailDefault, 50)
  assert.equal(config.maxQueryRows, 100)
  assert.equal(config.maxKeyScan, 1000)
  assert.deepEqual(config.dockerfiles, { roots: [], maxDepth: 6 })
})

test('resolveConfig repairs unusable overrides instead of failing later', () => {
  const config = resolveConfig({
    settingsFile: '   ',
    docker: { binary: '', timeoutMs: 1 },
    redis: { mode: 'auto', container: 42, host: 42, port: 70000, db: -1, tls: 'yes', timeoutMs: 1, username: null },
    postgres: { mode: 'left', container: null, host: '', port: 'abc', ssl: 'sometimes', user: '', database: null },
    logTailDefault: 0,
    maxQueryRows: -5,
    maxKeyScan: 999999,
  })
  assert.equal(config.settingsFile, CONFIG_DEFAULTS.settingsFile)
  assert.equal(config.docker.binary, CONFIG_DEFAULTS.docker.binary)
  assert.equal(config.docker.timeoutMs, CONFIG_DEFAULTS.docker.timeoutMs)
  assert.equal(config.redis.mode, CONFIG_DEFAULTS.redis.mode)
  assert.equal(config.redis.mode, 'docker')
  assert.equal(config.redis.container, '')
  assert.equal(config.postgres.mode, CONFIG_DEFAULTS.postgres.mode)
  assert.equal(config.postgres.container, '')
  assert.equal(config.redis.host, CONFIG_DEFAULTS.redis.host)
  assert.equal(config.redis.port, CONFIG_DEFAULTS.redis.port)
  assert.equal(config.redis.db, CONFIG_DEFAULTS.redis.db)
  assert.equal(config.redis.tls, CONFIG_DEFAULTS.redis.tls)
  assert.equal(config.redis.username, '')
  assert.equal(config.postgres.host, CONFIG_DEFAULTS.postgres.host)
  assert.equal(config.postgres.port, CONFIG_DEFAULTS.postgres.port)
  assert.equal(config.postgres.ssl, CONFIG_DEFAULTS.postgres.ssl)
  assert.equal(config.postgres.user, CONFIG_DEFAULTS.postgres.user)
  assert.equal(config.postgres.database, CONFIG_DEFAULTS.postgres.database)
  assert.equal(config.logTailDefault, CONFIG_DEFAULTS.logTailDefault)
  assert.equal(config.maxQueryRows, CONFIG_DEFAULTS.maxQueryRows)
  assert.equal(config.maxKeyScan, CONFIG_DEFAULTS.maxKeyScan)
})

test('settingsDefaultsFrom copies the connection groups and the Dockerfile roots', () => {
  const config = resolveConfig({ redis: { host: 'r' }, postgres: { host: 'p' }, docker: { binary: 'd' }, dockerfiles: { roots: ['/tmp/scan'] } })
  const defaults = settingsDefaultsFrom(config)
  assert.deepEqual(Object.keys(defaults).sort(), ['docker', 'dockerfiles', 'postgres', 'redis'])
  assert.deepEqual(defaults.dockerfiles, { roots: ['/tmp/scan'], maxDepth: 6 })
  assert.equal(defaults.redis.host, 'r')
  assert.equal(defaults.postgres.host, 'p')
  assert.equal(defaults.docker.binary, 'd')
  // A copy, not a live reference: a save must not mutate the row config.
  defaults.redis.host = 'changed'
  assert.equal(config.redis.host, 'r')
})

test('stateDirectory follows the profile home, then DSH_HOME, then ~/.dsh', () => {
  assert.equal(
    stateDirectory({ profileContext: { home: '/tmp/profile' } }),
    '/tmp/profile/dsh-long-data',
  )
  const previousDshHome = process.env.DSH_HOME
  const previousHome = process.env.HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home'
    assert.equal(stateDirectory({}), '/tmp/dsh-home/dsh-long-data')
    delete process.env.DSH_HOME
    process.env.HOME = '/tmp/user-home'
    assert.equal(stateDirectory({}), '/tmp/user-home/.dsh/dsh-long-data')
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})
