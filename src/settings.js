/**
 * The durable connection settings the panel edits.
 *
 * One JSON document in the plugin's state directory holds the Docker binary and
 * the Redis / PostgreSQL connections, because the browser must never be the
 * owner of those values: the same settings drive the Host-side tools and every
 * window sees one set of connections.
 *
 * ## Secrets
 *
 * The document may hold passwords, so it is written with mode `0600` through a
 * temp file + rename (a crash cannot leave a half-written file that then looks
 * like an empty configuration). Passwords never leave the Host: {@link
 * SettingsStore.redacted} is the only view the HTTP route returns, and it
 * reduces each password to a `hasPassword` boolean. A save with an absent or
 * empty password keeps the stored one, which is what a form that shows a masked
 * placeholder means; `clearPassword: true` is the explicit way to forget it.
 *
 * ## Precedence
 *
 * The composition row's `config` supplies the initial values; a saved document
 * overrides them key by key. Deleting the document is therefore "reset to the
 * row's defaults".
 *
 * @module dsh-long-data/src/settings
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { DataError, describeError } from './errors.js'

/** Bumped when the document's shape changes in a way an old reader cannot handle. */
export const SETTINGS_VERSION = 1

/** The shape a fresh document has. */
export const DEFAULT_SETTINGS = Object.freeze({
  docker: Object.freeze({ binary: 'docker', timeoutMs: 20000 }),
  redis: Object.freeze({ mode: 'docker', container: '', host: '127.0.0.1', port: 6379, username: '', password: '', db: 0, tls: false, timeoutMs: 5000 }),
  postgres: Object.freeze({ mode: 'docker', container: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: '', ssl: 'prefer', timeoutMs: 8000 }),
  dockerfiles: Object.freeze({ roots: Object.freeze([]), maxDepth: 6 }),
})

/**
 * @param {unknown} value - a candidate.
 * @returns {value is Record<string, unknown>} whether it is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value - a candidate.
 * @param {unknown} fallback - used unless `value` is a finite integer in range.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the bounded integer.
 */
function integerInRange(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

/**
 * @param {unknown} value - a candidate.
 * @param {string} fallback - used unless `value` is a non-empty string.
 * @returns {string} the trimmed string.
 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * @param {unknown} value - a candidate.
 * @param {boolean} fallback - used unless `value` is a boolean.
 * @returns {boolean} the switch.
 */
function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Deep-copy the parts of a settings document this module owns, dropping unknown
 * keys and repairing unusable ones.
 *
 * @param {unknown} raw - the loaded or supplied settings.
 * @param {{ docker: object, redis: object, postgres: object }} defaults - fallbacks.
 * @returns {{ docker: object, redis: object, postgres: object }} the normalized settings.
 */
export function normalizeSettings(raw, defaults = DEFAULT_SETTINGS) {
  const source = isRecord(raw) ? raw : {}
  const docker = isRecord(source.docker) ? source.docker : {}
  const redis = isRecord(source.redis) ? source.redis : {}
  const postgres = isRecord(source.postgres) ? source.postgres : {}

  const dockerfiles = isRecord(source.dockerfiles) ? source.dockerfiles : {}
  const defaultDockerfiles = isRecord(defaults.dockerfiles) ? defaults.dockerfiles : DEFAULT_SETTINGS.dockerfiles

  return {
    docker: {
      binary: text(docker.binary, text(defaults.docker.binary, DEFAULT_SETTINGS.docker.binary)),
      timeoutMs: integerInRange(docker.timeoutMs, defaults.docker.timeoutMs ?? DEFAULT_SETTINGS.docker.timeoutMs, 1000, 300000),
    },
    redis: {
      mode: redis.mode === 'manual' ? 'manual' : redis.mode === 'docker' ? 'docker' : defaults.redis.mode ?? 'docker',
      container: typeof redis.container === 'string' ? redis.container.trim() : defaults.redis.container ?? '',
      host: text(redis.host, defaults.redis.host),
      port: integerInRange(redis.port, defaults.redis.port, 1, 65535),
      username: typeof redis.username === 'string' ? redis.username : defaults.redis.username ?? '',
      password: typeof redis.password === 'string' ? redis.password : defaults.redis.password ?? '',
      db: integerInRange(redis.db, defaults.redis.db, 0, 15),
      tls: flag(redis.tls, defaults.redis.tls ?? false),
      timeoutMs: integerInRange(redis.timeoutMs, defaults.redis.timeoutMs ?? 5000, 500, 120000),
    },
    postgres: {
      mode: postgres.mode === 'manual' ? 'manual' : postgres.mode === 'docker' ? 'docker' : defaults.postgres.mode ?? 'docker',
      container: typeof postgres.container === 'string' ? postgres.container.trim() : defaults.postgres.container ?? '',
      host: text(postgres.host, defaults.postgres.host),
      port: integerInRange(postgres.port, defaults.postgres.port, 1, 65535),
      user: text(postgres.user, defaults.postgres.user),
      password: typeof postgres.password === 'string' ? postgres.password : defaults.postgres.password ?? '',
      database: text(postgres.database, defaults.postgres.database),
      ssl: ['disable', 'prefer', 'require'].includes(postgres.ssl) ? postgres.ssl : defaults.postgres.ssl ?? 'prefer',
      timeoutMs: integerInRange(postgres.timeoutMs, defaults.postgres.timeoutMs ?? 8000, 500, 120000),
    },
    dockerfiles: {
      roots: normalizeRoots(dockerfiles.roots, defaultDockerfiles.roots ?? []),
      maxDepth: integerInRange(dockerfiles.maxDepth, defaultDockerfiles.maxDepth ?? 6, 1, 12),
    },
  }
}

/**
 * @param {unknown} value - candidate scan roots.
 * @param {string[]} fallback - used when `value` is not an array.
 * @returns {string[]} the distinct, trimmed, non-empty absolute paths.
 */
function normalizeRoots(value, fallback) {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : []
  const out = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Validate a partial save request from the browser.
 *
 * Only the fields the panel owns are accepted; each present field is validated
 * and normalized, so a bad port is reported before anything is written.
 *
 * @param {unknown} patch - the raw payload.
 * @returns {{ docker?: object, redis?: object, postgres?: object }} the normalized patch.
 */
export function sanitizeSettingsPatch(patch) {
  if (!isRecord(patch)) {
    throw new DataError('invalid_payload', 'settings payload must be an object', { field: 'payload' })
  }
  const out = {}
  if (patch.dockerfiles !== undefined) {
    const raw = patch.dockerfiles
    if (!isRecord(raw)) {
      throw new DataError('invalid_payload', '"dockerfiles" must be an object', { field: 'dockerfiles' })
    }
    const next = {}
    if (raw.roots !== undefined) {
      if (!Array.isArray(raw.roots)) {
        throw new DataError('invalid_payload', '"dockerfiles.roots" must be an array of absolute paths', { field: 'dockerfiles.roots' })
      }
      const roots = []
      for (const entry of raw.roots) {
        if (typeof entry !== 'string' || entry.trim() === '') continue
        const root = entry.trim()
        if (!isAbsolute(root)) {
          throw new DataError('invalid_payload', `"dockerfiles.roots" entry is not an absolute path: ${root}`, { field: 'dockerfiles.roots' })
        }
        if (root.length > 1024) {
          throw new DataError('invalid_payload', '"dockerfiles.roots" entries must be at most 1024 characters', { field: 'dockerfiles.roots', limit: 1024 })
        }
        if (!roots.includes(root)) roots.push(root)
      }
      if (roots.length > 20) {
        throw new DataError('invalid_payload', '"dockerfiles.roots" accepts at most 20 directories', { field: 'dockerfiles.roots', limit: 20 })
      }
      next.roots = roots
    }
    if (raw.maxDepth !== undefined) next.maxDepth = requireBoundedInteger(raw.maxDepth, 'dockerfiles.maxDepth', 1, 12)
    out.dockerfiles = next
  }
  for (const service of ['docker', 'redis', 'postgres']) {
    if (patch[service] === undefined) continue
    if (!isRecord(patch[service])) {
      throw new DataError('invalid_payload', `"${service}" must be an object`, { field: service })
    }
    const raw = patch[service]
    const next = {}
    if (service === 'docker') {
      if (raw.binary !== undefined) {
        if (typeof raw.binary !== 'string' || raw.binary.trim() === '') {
          throw new DataError('invalid_payload', '"docker.binary" must be a non-empty string', { field: 'docker.binary' })
        }
        next.binary = raw.binary.trim()
      }
      if (raw.timeoutMs !== undefined) {
        next.timeoutMs = requireBoundedInteger(raw.timeoutMs, 'docker.timeoutMs', 1000, 300000)
      }
    } else {
      if (raw.mode !== undefined) {
        if (raw.mode !== 'docker' && raw.mode !== 'manual') {
          throw new DataError('invalid_payload', `"${service}.mode" must be "docker" or "manual"`, { field: `${service}.mode` })
        }
        next.mode = raw.mode
      }
      if (raw.container !== undefined) {
        if (typeof raw.container !== 'string') {
          throw new DataError('invalid_payload', `"${service}.container" must be a string`, { field: `${service}.container` })
        }
        const container = raw.container.trim()
        if (container !== '' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) {
          throw new DataError('invalid_payload', `"${service}.container" is not a valid container name`, { field: `${service}.container` })
        }
        next.container = container
      }
      const hostField = `${service}.host`
      if (raw.host !== undefined) {
        if (typeof raw.host !== 'string' || raw.host.trim() === '') {
          throw new DataError('invalid_payload', `"${hostField}" must be a non-empty string`, { field: hostField })
        }
        next.host = raw.host.trim()
      }
      if (raw.port !== undefined) next.port = requireBoundedInteger(raw.port, `${service}.port`, 1, 65535)
      if (raw.timeoutMs !== undefined) next.timeoutMs = requireBoundedInteger(raw.timeoutMs, `${service}.timeoutMs`, 500, 120000)
      if (raw.password !== undefined) {
        if (typeof raw.password !== 'string') {
          throw new DataError('invalid_payload', `"${service}.password" must be a string`, { field: `${service}.password` })
        }
        // The panel sends '' for "leave the stored password alone".
        if (raw.password !== '') next.password = raw.password
      }
      if (raw.clearPassword !== undefined) {
        if (typeof raw.clearPassword !== 'boolean') {
          throw new DataError('invalid_payload', `"${service}.clearPassword" must be a boolean`, { field: `${service}.clearPassword` })
        }
        if (raw.clearPassword) next.clearPassword = true
      }
    }
    if (service === 'redis') {
      if (raw.username !== undefined) {
        if (typeof raw.username !== 'string') {
          throw new DataError('invalid_payload', '"redis.username" must be a string', { field: 'redis.username' })
        }
        next.username = raw.username
      }
      if (raw.db !== undefined) next.db = requireBoundedInteger(raw.db, 'redis.db', 0, 15)
      if (raw.tls !== undefined) {
        if (typeof raw.tls !== 'boolean') {
          throw new DataError('invalid_payload', '"redis.tls" must be a boolean', { field: 'redis.tls' })
        }
        next.tls = raw.tls
      }
    }
    if (service === 'postgres') {
      if (raw.user !== undefined) {
        if (typeof raw.user !== 'string') {
          throw new DataError('invalid_payload', '"postgres.user" must be a string', { field: 'postgres.user' })
        }
        next.user = raw.user.trim()
      }
      if (raw.database !== undefined) {
        if (typeof raw.database !== 'string') {
          throw new DataError('invalid_payload', '"postgres.database" must be a string', { field: 'postgres.database' })
        }
        next.database = raw.database.trim()
      }
      if (raw.ssl !== undefined) {
        if (!['disable', 'prefer', 'require'].includes(raw.ssl)) {
          throw new DataError('invalid_payload', '"postgres.ssl" must be one of disable, prefer, require', { field: 'postgres.ssl' })
        }
        next.ssl = raw.ssl
      }
    }
    out[service] = next
  }
  return out
}

/**
 * @param {unknown} value - candidate.
 * @param {string} field - dotted field name for the error.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the integer.
 */
function requireBoundedInteger(value, field, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DataError('invalid_payload', `"${field}" must be an integer between ${min} and ${max}`, { field, min, max })
  }
  return number
}

/**
 * The durable settings document.
 *
 * The store keeps the effective settings in memory after {@link load}; a save
 * rewrites the document and updates the snapshot, so a later op reads the new
 * connection without a restart.
 */
export class SettingsStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.path - absolute path of the JSON document.
   * @param {{ docker: object, redis: object, postgres: object }} [options.defaults] - row defaults.
   */
  constructor({ path, defaults = DEFAULT_SETTINGS }) {
    this.path = path
    this.defaults = normalizeSettings(defaults, DEFAULT_SETTINGS)
    /** @type {ReturnType<typeof normalizeSettings>} */
    this.settings = this.defaults
    /** @type {string[]} */
    this.warnings = []
    this.loadedFromDisk = false
  }

  /**
   * Read the document, falling back to the row defaults on a missing or broken
   * file. Recovery never throws: a settings file that cannot be read must not
   * take the panel down, and the Host keeps working with the defaults until the
   * next save rewrites it.
   *
   * @returns {this} the store.
   */
  load() {
    this.warnings = []
    this.settings = this.defaults
    this.loadedFromDisk = false
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (!isRecord(parsed)) throw new Error('the document is not a JSON object')
      this.settings = normalizeSettings(parsed, this.defaults)
      this.loadedFromDisk = true
    } catch (error) {
      if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === 'ENOENT') {
        // First run: the defaults are the settings until the user saves.
      } else {
        this.warnings.push(`could not read ${this.path}: ${describeError(error)}; using the defaults`)
      }
    }
    return this
  }

  /**
   * @returns {ReturnType<typeof normalizeSettings>} the effective settings, passwords included.
   */
  effective() {
    return this.settings
  }

  /**
   * The only view that may cross to the browser: passwords become flags.
   *
   * @returns {object} the redacted settings.
   */
  redacted() {
    const { docker, redis, postgres } = this.settings
    return {
      docker: { binary: docker.binary, timeoutMs: docker.timeoutMs },
      redis: {
        mode: redis.mode,
        container: redis.container,
        host: redis.host,
        port: redis.port,
        username: redis.username,
        db: redis.db,
        tls: redis.tls,
        timeoutMs: redis.timeoutMs,
        hasPassword: typeof redis.password === 'string' && redis.password !== '',
      },
      dockerfiles: { roots: [...this.settings.dockerfiles.roots], maxDepth: this.settings.dockerfiles.maxDepth },
      postgres: {
        mode: postgres.mode,
        container: postgres.container,
        host: postgres.host,
        port: postgres.port,
        user: postgres.user,
        database: postgres.database,
        ssl: postgres.ssl,
        timeoutMs: postgres.timeoutMs,
        hasPassword: typeof postgres.password === 'string' && postgres.password !== '',
      },
    }
  }

  /**
   * Merge a validated patch, persist it atomically, and return the redacted view.
   *
   * @param {unknown} patch - the browser's save payload.
   * @returns {object} the redacted settings after the save.
   */
  save(patch) {
    const clean = sanitizeSettingsPatch(patch)
    /** @type {any} */
    const next = JSON.parse(JSON.stringify(this.settings))
    for (const service of ['docker', 'redis', 'postgres']) {
      const part = clean[service]
      if (part === undefined) continue
      const { clearPassword, ...fields } = part
      Object.assign(next[service], fields)
      if (clearPassword === true) next[service].password = ''
    }
    if (clean.dockerfiles !== undefined) Object.assign(next.dockerfiles, clean.dockerfiles)
    const normalized = normalizeSettings(next, this.defaults)
    this.#write(normalized)
    this.settings = normalized
    this.loadedFromDisk = true
    return this.redacted()
  }

  /**
   * @param {ReturnType<typeof normalizeSettings>} settings - the document to write.
   * @returns {void}
   */
  #write(settings) {
    const document = {
      version: SETTINGS_VERSION,
      updatedAt: new Date().toISOString(),
      ...settings,
    }
    const body = `${JSON.stringify(document, null, 2)}\n`
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = join(dirname(this.path), `.${Date.now().toString(36)}.${process.pid}.tmp`)
      writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(temp, 0o600)
      } catch {
        // Best effort: a filesystem without POSIX modes must still persist.
      }
      renameSync(temp, this.path)
    } catch (error) {
      throw new DataError('settings_write_failed', `could not save the connection settings: ${describeError(error)}`, {
        path: this.path,
      })
    }
  }

  /**
   * @returns {object} a connection object for `src/redis.js`.
   */
  redisConnection() {
    const { redis } = this.settings
    return {
      host: redis.host,
      port: redis.port,
      username: redis.username,
      password: redis.password,
      db: redis.db,
      tls: redis.tls,
      timeoutMs: redis.timeoutMs,
    }
  }

  /**
   * @returns {object} a connection object for `src/postgres.js`.
   */
  postgresConnection() {
    const { postgres } = this.settings
    return {
      host: postgres.host,
      port: postgres.port,
      user: postgres.user,
      password: postgres.password,
      database: postgres.database,
      ssl: postgres.ssl,
      timeoutMs: postgres.timeoutMs,
    }
  }

  /**
   * @returns {{ roots: string[], maxDepth: number }} the Dockerfile scan settings.
   */
  dockerfileOptions() {
    return { roots: [...this.settings.dockerfiles.roots], maxDepth: this.settings.dockerfiles.maxDepth }
  }

  /**
   * @returns {{ binary: string, timeoutMs: number }} options for `src/docker.js`.
   */
  dockerOptions() {
    return { binary: this.settings.docker.binary, timeoutMs: this.settings.docker.timeoutMs }
  }
}

export default { SettingsStore, DEFAULT_SETTINGS, SETTINGS_VERSION, normalizeSettings, sanitizeSettingsPatch }
