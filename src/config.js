/**
 * The composition row's accepted keys and their defaults.
 *
 * A row that omits a key keeps the default; a row that sets an unusable value
 * falls back instead of failing at the first request. The keys and defaults are
 * the ones `cordis.patch.yml` and the README document.
 *
 * Two layers exist on purpose:
 *
 *   - these values are the *initial* settings a fresh install starts with;
 * The `redis`/`postgres` groups carry a `mode` (`docker` by default: discover and
 * use the service's Docker container) and an optional `container` name (empty =
 * auto-pick). `host`/`port`/credentials are used in `manual` mode, and act as
 * overrides in `docker` mode.
 *
 *   - the settings the panel saves live in `<state dir>/settings.json` and take
 *     precedence, so changing a connection from the page survives an upgrade
 *     and does not require editing the profile patch.
 *
 * @module dsh-long-data/src/config
 */

import { join } from 'node:path'

/** Services the panel talks to. */
export const SERVICES = Object.freeze(['docker', 'redis', 'postgres'])

/** Defaults written by `cordis.patch.yml`; changing one here changes installs without a row. */
export const CONFIG_DEFAULTS = Object.freeze({
  settingsFile: 'settings.json',
  docker: Object.freeze({ binary: 'docker', timeoutMs: 20000 }),
  redis: Object.freeze({ mode: 'docker', container: '', host: '127.0.0.1', port: 6379, username: '', password: '', db: 0, tls: false, timeoutMs: 5000 }),
  postgres: Object.freeze({ mode: 'docker', container: '', host: '127.0.0.1', port: 5432, user: '', password: '', database: '', ssl: 'prefer', timeoutMs: 8000 }),
  logTailDefault: 200,
  maxQueryRows: 500,
  maxKeyScan: 500,
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
 * @param {unknown} fallback - used unless `value` is a finite number.
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
 * @param {unknown} value - a candidate list of directories.
 * @returns {string[]} the distinct, trimmed, non-empty entries (config-level values are
 *   trusted to be absolute; the ops layer only ever scans existing directories).
 */
function dockerfileRoots(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Normalize the row's `config` into the plugin's effective defaults.
 *
 * @param {unknown} rawConfig - the composition row's config.
 * @returns {{ settingsFile: string, docker: object, redis: object, postgres: object,
 *   logTailDefault: number, maxQueryRows: number, maxKeyScan: number }} the effective defaults.
 */
export function resolveConfig(rawConfig) {
  const config = isRecord(rawConfig) ? rawConfig : {}
  const docker = isRecord(config.docker) ? config.docker : {}
  const redis = isRecord(config.redis) ? config.redis : {}
  const postgres = isRecord(config.postgres) ? config.postgres : {}

  return {
    settingsFile: text(config.settingsFile, CONFIG_DEFAULTS.settingsFile),
    docker: {
      binary: text(docker.binary, CONFIG_DEFAULTS.docker.binary),
      timeoutMs: integerInRange(docker.timeoutMs, CONFIG_DEFAULTS.docker.timeoutMs, 1000, 300000),
    },
    redis: {
      mode: redis.mode === 'manual' ? 'manual' : CONFIG_DEFAULTS.redis.mode,
      container: typeof redis.container === 'string' ? redis.container.trim() : CONFIG_DEFAULTS.redis.container,
      host: text(redis.host, CONFIG_DEFAULTS.redis.host),
      port: integerInRange(redis.port, CONFIG_DEFAULTS.redis.port, 1, 65535),
      username: text(redis.username, CONFIG_DEFAULTS.redis.username),
      password: typeof redis.password === 'string' ? redis.password : CONFIG_DEFAULTS.redis.password,
      db: integerInRange(redis.db, CONFIG_DEFAULTS.redis.db, 0, 15),
      tls: flag(redis.tls, CONFIG_DEFAULTS.redis.tls),
      timeoutMs: integerInRange(redis.timeoutMs, CONFIG_DEFAULTS.redis.timeoutMs, 500, 120000),
    },
    postgres: {
      mode: postgres.mode === 'manual' ? 'manual' : CONFIG_DEFAULTS.postgres.mode,
      container: typeof postgres.container === 'string' ? postgres.container.trim() : CONFIG_DEFAULTS.postgres.container,
      host: text(postgres.host, CONFIG_DEFAULTS.postgres.host),
      port: integerInRange(postgres.port, CONFIG_DEFAULTS.postgres.port, 1, 65535),
      user: text(postgres.user, CONFIG_DEFAULTS.postgres.user),
      password: typeof postgres.password === 'string' ? postgres.password : CONFIG_DEFAULTS.postgres.password,
      database: text(postgres.database, CONFIG_DEFAULTS.postgres.database),
      ssl: ['disable', 'prefer', 'require'].includes(postgres.ssl) ? postgres.ssl : CONFIG_DEFAULTS.postgres.ssl,
      timeoutMs: integerInRange(postgres.timeoutMs, CONFIG_DEFAULTS.postgres.timeoutMs, 500, 120000),
    },
    logTailDefault: integerInRange(config.logTailDefault, CONFIG_DEFAULTS.logTailDefault, 10, 5000),
    maxQueryRows: integerInRange(config.maxQueryRows, CONFIG_DEFAULTS.maxQueryRows, 1, 10000),
    maxKeyScan: integerInRange(config.maxKeyScan, CONFIG_DEFAULTS.maxKeyScan, 1, 5000),
    dockerfiles: {
      roots: dockerfileRoots(isRecord(config.dockerfiles) ? config.dockerfiles.roots : undefined),
      maxDepth: integerInRange(isRecord(config.dockerfiles) ? config.dockerfiles.maxDepth : undefined, CONFIG_DEFAULTS.dockerfiles.maxDepth, 1, 12),
    },
  }
}

/**
 * The ship-time settings the store starts from: the row's config, minus the
 * fields that are not connection settings.
 *
 * @param {ReturnType<typeof resolveConfig>} config - the effective row config.
 * @returns {{ docker: object, redis: object, postgres: object }} the connection defaults.
 */
export function settingsDefaultsFrom(config) {
  return {
    docker: { ...config.docker },
    redis: { ...config.redis },
    postgres: { ...config.postgres },
    dockerfiles: { roots: [...config.dockerfiles.roots], maxDepth: config.dockerfiles.maxDepth },
  }
}

/**
 * The per-profile state directory. It follows the harness home, so every
 * profile keeps its own saved connections.
 *
 * @param {any} ctx - the plugin context (may be absent in tests).
 * @returns {string} absolute directory path.
 */
export function stateDirectory(ctx) {
  const profileHome = ctx?.profileContext?.home
  if (typeof profileHome === 'string' && profileHome !== '') return join(profileHome, 'dsh-long-data')
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'dsh-long-data')
}

export default { CONFIG_DEFAULTS, SERVICES, resolveConfig, settingsDefaultsFrom, stateDirectory }
