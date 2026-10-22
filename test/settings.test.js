/**
 * Tests for the durable connection settings.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DataError } from '../src/errors.js'
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  normalizeSettings,
  sanitizeSettingsPatch,
} from '../src/settings.js'

/**
 * @param {object} [options] - store options.
 * @returns {{ store: SettingsStore, directory: string, path: string }} a store on a fresh temp dir.
 */
function makeStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-long-data-settings-'))
  const path = join(directory, 'settings.json')
  return { store: new SettingsStore({ path, ...options }), directory, path }
}

test('a fresh store exposes the row defaults without a password', () => {
  const { store, directory } = makeStore()
  try {
    store.load()
    assert.equal(store.loadedFromDisk, false)
    assert.deepEqual(store.warnings, [])
    const view = store.redacted()
    assert.equal(view.redis.host, '127.0.0.1')
    assert.equal(view.redis.port, 6379)
    assert.equal(view.redis.mode, 'docker')
    assert.equal(view.redis.container, '')
    assert.equal(view.postgres.mode, 'docker')
    assert.equal(view.postgres.container, '')
    assert.equal(view.redis.hasPassword, false)
    assert.equal(view.postgres.hasPassword, false)
    assert.equal(view.docker.binary, 'docker')
    assert.deepEqual(view.dockerfiles, { roots: [], maxDepth: 6 })
    assert.equal(Object.hasOwn(view.redis, 'password'), false)
    assert.equal(Object.hasOwn(view.postgres, 'password'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('save persists connections with mode 0600 and redacts the result', () => {
  const { store, directory, path } = makeStore()
  try {
    store.load()
    const saved = store.save({
      redis: { mode: 'manual', container: 'cache', host: 'cache.internal', port: 6380, username: 'app', password: 'r3dis', db: 2, tls: true },
      postgres: { mode: 'manual', container: 'db', host: 'db.internal', port: 6432, user: 'app', password: 'pgpass', database: 'appdb', ssl: 'require' },
      docker: { binary: '/opt/homebrew/bin/docker' },
    })
    assert.equal(saved.redis.mode, 'manual')
    assert.equal(saved.redis.container, 'cache')
    assert.equal(saved.postgres.mode, 'manual')
    assert.equal(saved.postgres.container, 'db')
    assert.equal(saved.redis.host, 'cache.internal')
    assert.equal(saved.redis.port, 6380)
    assert.equal(saved.redis.username, 'app')
    assert.equal(saved.redis.db, 2)
    assert.equal(saved.redis.tls, true)
    assert.equal(saved.redis.hasPassword, true)
    assert.equal(Object.hasOwn(saved.redis, 'password'), false)
    assert.equal(saved.postgres.hasPassword, true)
    assert.equal(saved.postgres.ssl, 'require')
    assert.equal(saved.docker.binary, '/opt/homebrew/bin/docker')
    assert.deepEqual(saved.dockerfiles, { roots: [], maxDepth: 6 })

    const document = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(document.version, 1)
    assert.equal(document.redis.mode, 'manual')
    assert.equal(document.redis.container, 'cache')
    assert.equal(document.redis.password, 'r3dis')
    assert.equal(document.postgres.password, 'pgpass')
    assert.equal(typeof document.updatedAt, 'string')

    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600, 'the settings document must not be world readable')
    }
    // The atomic write leaves no temp files behind.
    assert.deepEqual(readdirSync(directory), ['settings.json'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a later store reads what save wrote', () => {
  const { store, directory, path } = makeStore()
  try {
    store.load()
    store.save({ redis: { host: 'persisted', password: 'pw' } })
    const reopened = new SettingsStore({ path }).load()
    assert.equal(reopened.loadedFromDisk, true)
    assert.equal(reopened.redacted().redis.host, 'persisted')
    assert.equal(reopened.redacted().redis.hasPassword, true)
    assert.deepEqual(reopened.warnings, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an empty password keeps the stored one; clearPassword forgets it', () => {
  const { store, directory } = makeStore()
  try {
    store.load()
    store.save({ redis: { password: 'keep-me' } })
    store.save({ redis: { password: '', host: 'still-here' } })
    assert.equal(store.redacted().redis.hasPassword, true)
    assert.equal(store.redacted().redis.host, 'still-here')
    assert.equal(store.effective().redis.password, 'keep-me')
    store.save({ redis: { clearPassword: true } })
    assert.equal(store.redacted().redis.hasPassword, false)
    assert.equal(store.effective().redis.password, '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a corrupt document is reported and the defaults are used', () => {
  const { store, directory, path } = makeStore()
  try {
    writeFileSync(path, '{ not json')
    store.load()
    assert.equal(store.loadedFromDisk, false)
    assert.equal(store.warnings.length, 1)
    assert.match(store.warnings[0], /could not read/)
    assert.equal(store.redacted().redis.port, 6379)
    // Saving repairs the file.
    store.save({ redis: { host: 'repaired' } })
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).redis.host, 'repaired')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unusable values in a stored document are repaired on load', () => {
  const { store, directory, path } = makeStore()
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      redis: { host: '', port: 99999, db: 99, tls: 'yes' },
      postgres: { ssl: 'maybe' },
      docker: { binary: '' },
    }))
    store.load()
    const view = store.redacted()
    assert.equal(view.redis.host, DEFAULT_SETTINGS.redis.host)
    assert.equal(view.redis.port, DEFAULT_SETTINGS.redis.port)
    assert.equal(view.redis.db, DEFAULT_SETTINGS.redis.db)
    assert.equal(view.postgres.ssl, DEFAULT_SETTINGS.postgres.ssl)
    assert.equal(view.docker.binary, DEFAULT_SETTINGS.docker.binary)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sanitizeSettingsPatch validates present fields and ignores foreign keys', () => {
  assert.deepEqual(sanitizeSettingsPatch({}), {})
  assert.deepEqual(sanitizeSettingsPatch({ redis: { host: 'h', port: '6380' } }), { redis: { host: 'h', port: 6380 } })
  assert.deepEqual(sanitizeSettingsPatch({ unknown: { whatever: true } }), {})
  assert.deepEqual(sanitizeSettingsPatch({ redis: { password: '' } }), { redis: {} })

  /** @type {Array<[string, any]>} */
  const rejected = [
    ['not an object', null],
    ['docker not object', { docker: 'yes' }],
    ['empty binary', { docker: { binary: '' } }],
    ['port zero', { redis: { port: 0 } }],
    ['port too high', { redis: { port: 70000 } }],
    ['negative db', { redis: { db: -1 } }],
    ['db too high', { redis: { db: 16 } }],
    ['non-boolean tls', { redis: { tls: 'true' } }],
    ['relative scan root', { dockerfiles: { roots: ['relative/dir'] } }],
    ['too many scan roots', { dockerfiles: { roots: Array.from({ length: 21 }, (_, index) => `/tmp/scan-${index}`) } }],
    ['bad scan depth', { dockerfiles: { maxDepth: 0 } }],
    ['bad mode', { redis: { mode: 'auto' } }],
    ['bad container name', { redis: { container: '-nope' } }],
    ['non-string container', { postgres: { container: 42 } }],
    ['bad ssl', { postgres: { ssl: 'tls' } }],
    ['timeout too small', { redis: { timeoutMs: 10 } }],
  ]
  for (const [label, patch] of rejected) {
    assert.throws(
      () => sanitizeSettingsPatch(patch),
      (error) => error instanceof DataError && error.code === 'invalid_payload',
      label,
    )
  }
})

test('normalizeSettings drops unknown keys and keeps only owned fields', () => {
  const normalized = normalizeSettings({
    redis: { host: 'h', port: 6380, password: 'pw', extra: 'x' },
    postgres: { user: 'u' },
    other: true,
  })
  assert.deepEqual(Object.keys(normalized).sort(), ['docker', 'dockerfiles', 'postgres', 'redis'])
  assert.deepEqual(Object.keys(normalized.redis).sort(), ['container', 'db', 'host', 'mode', 'password', 'port', 'timeoutMs', 'tls', 'username'])
  assert.equal(normalized.redis.extra, undefined)
  assert.equal(normalized.postgres.host, DEFAULT_SETTINGS.postgres.host)
})

test('dockerfile settings are saved and exposed', () => {
  const { store, directory } = makeStore()
  try {
    store.load()
    const saved = store.save({ dockerfiles: { roots: ['/tmp/a', '/tmp/a', '/tmp/b'], maxDepth: 4 } })
    assert.deepEqual(saved.dockerfiles, { roots: ['/tmp/a', '/tmp/b'], maxDepth: 4 })
    assert.deepEqual(store.effective().dockerfiles, { roots: ['/tmp/a', '/tmp/b'], maxDepth: 4 })
    assert.deepEqual(store.dockerfileOptions(), { roots: ['/tmp/a', '/tmp/b'], maxDepth: 4 })
    store.save({ dockerfiles: { roots: [] } })
    assert.deepEqual(store.redacted().dockerfiles.roots, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('connection accessors shape the three service connection objects', () => {
  const { store, directory } = makeStore()
  try {
    store.load()
    store.save({
      docker: { binary: '/usr/bin/docker', timeoutMs: 1234 },
      redis: { host: 'rh', port: 6380, username: 'ru', password: 'rp', db: 4, tls: true, timeoutMs: 2222 },
      postgres: { host: 'ph', port: 6432, user: 'pu', password: 'pp', database: 'pd', ssl: 'disable', timeoutMs: 3333 },
    })
    assert.deepEqual(store.dockerOptions(), { binary: '/usr/bin/docker', timeoutMs: 1234 })
    assert.deepEqual(store.redisConnection(), {
      host: 'rh', port: 6380, username: 'ru', password: 'rp', db: 4, tls: true, timeoutMs: 2222,
    })
    assert.deepEqual(store.postgresConnection(), {
      host: 'ph', port: 6432, user: 'pu', password: 'pp', database: 'pd', ssl: 'disable', timeoutMs: 3333,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
