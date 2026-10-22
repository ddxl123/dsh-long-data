/**
 * Resolving where a Redis or PostgreSQL operation should connect.
 *
 * This machine has no host-installed Redis or PostgreSQL: both run inside Docker
 * containers. The panel therefore treats "the service" as "a container",
 * discovers the containers whose image is Redis/PostgreSQL, resolves the host
 * port each one publishes, and reads the credentials its image already carries
 * in its environment (`REDISCLI_AUTH`, `POSTGRES_PASSWORD`, …) when the settings
 * do not name them. Manual host/port mode remains for a service reached some
 * other way.
 *
 * ## Several running containers
 *
 * More than one Redis (or PostgreSQL) container may be running. Discovery lists
 * them all, `resolveInstances` exposes every running instance for the panel's
 * switcher, and auto mode refuses to guess: with two or more running candidates
 * it raises `<service>_ambiguous_container` and the operator picks one (pinned
 * through the settings, which every later operation then uses).
 *
 * ## What crosses to the browser
 *
 * Only flags: candidates and instances expose `hasPassword` and
 * `credentialsSource`, never the secret or the raw environment. Resolution
 * happens on the Host, and the connection object it returns is consumed by
 * `redis.js` / `postgres.js` and never serialized.
 *
 * ## Failure codes
 *
 * Every failure is a `DataError` prefixed with the service, so the panel can
 * say "Redis: two containers are running, pick one" instead of a generic Docker
 * error: `<service>_docker_unavailable`, `<service>_no_container`,
 * `<service>_no_running_container`, `<service>_ambiguous_container`,
 * `<service>_container_not_found`, `<service>_no_published_port`.
 *
 * @module dsh-long-data/src/targets
 */

import { DataError, describeError, isDataError } from './errors.js'

/** The in-container port each service listens on. */
export const SERVICE_CONTAINER_PORTS = Object.freeze({ redis: '6379', postgres: '5432' })

/** The documented default PostgreSQL role/database, used only when nothing else is known. */
export const POSTGRES_FALLBACK_USER = 'postgres'
export const POSTGRES_FALLBACK_DATABASE = 'postgres'

/** Image-name classification, tolerant of registry paths and tags. */
const IMAGE_PATTERNS = Object.freeze({
  redis: /(^|\/)(redis|redis-stack|redis-stack-server)([:\-@]|$)/i,
  postgres: /(^|\/)(postgres|postgresql|postgis|timescaledb)([:\-@]|$)/i,
})

/**
 * @param {string} service - `redis` | `postgres`.
 * @param {unknown} image - the container image reference.
 * @returns {boolean} whether the image looks like that service.
 */
export function isServiceImage(service, image) {
  const pattern = IMAGE_PATTERNS[service]
  return typeof image === 'string' && pattern !== undefined && pattern.test(image)
}

/**
 * @param {{ key: string, value: string }[]|undefined} env - a container environment.
 * @returns {Record<string, string>} the environment as a record.
 */
export function envToRecord(env) {
  /** @type {Record<string, string>} */
  const record = {}
  if (!Array.isArray(env)) return record
  for (const entry of env) {
    if (entry === null || typeof entry !== 'object') continue
    const key = String(entry.key ?? '')
    if (key === '') continue
    record[key] = String(entry.value ?? '')
  }
  return record
}

/**
 * Read the credentials an image's environment already carries.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {{ key: string, value: string }[]|undefined} env - the container environment.
 * @returns {{ username?: string, password?: string, database?: string, db?: number }} the known credentials.
 */
export function credentialsFromEnv(service, env) {
  const values = envToRecord(env)
  if (service === 'redis') {
    const username = values.REDIS_USERNAME ?? values.REDIS_USER ?? ''
    const password = values.REDISCLI_AUTH ?? values.REDIS_PASSWORD ?? values.REDIS_PASS ?? ''
    const dbText = values.REDIS_DB ?? values.REDIS_DATABASE ?? ''
    const db = /^\d{1,2}$/.test(dbText) ? Number(dbText) : undefined
    return {
      ...(username !== '' ? { username } : {}),
      ...(password !== '' ? { password } : {}),
      ...(db !== undefined && db >= 0 && db <= 15 ? { db } : {}),
    }
  }
  const username = values.POSTGRES_USER ?? values.PGUSER ?? ''
  const password = values.POSTGRES_PASSWORD ?? values.PGPASSWORD ?? ''
  const database = values.POSTGRES_DB ?? values.PGDATABASE ?? ''
  return {
    ...(username !== '' ? { username } : {}),
    ...(password !== '' ? { password } : {}),
    ...(database !== '' ? { database } : {}),
  }
}

/**
 * Find the host port publishing one container port.
 *
 * @param {{ host: string|null, container: string, protocol: string, ip: string|null }[]|undefined} ports - the container's port list.
 * @param {string} containerPort - the port inside the container.
 * @returns {{ hostPort: number, hostIp: string|null } | null} the published endpoint.
 */
export function publishedPortOf(ports, containerPort) {
  if (!Array.isArray(ports)) return null
  const matches = ports.filter((port) => {
    if (port === null || typeof port !== 'object') return false
    return String(port.container) === String(containerPort) && port.host !== null && port.host !== undefined && String(port.host) !== ''
  })
  if (matches.length === 0) return null
  const chosen = matches.find((port) => port.protocol === 'tcp') ?? matches[0]
  const hostPort = Number(chosen.host)
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) return null
  const hostIp = typeof chosen.ip === 'string' && chosen.ip !== '' ? chosen.ip : null
  return { hostPort, hostIp }
}

/**
 * @param {string|null} publishedIp - the HostIp Docker reports.
 * @returns {string} the address to dial from the Harness process.
 */
export function dialAddress(publishedIp) {
  if (publishedIp === null || publishedIp === undefined || publishedIp === '') return '127.0.0.1'
  if (publishedIp === '0.0.0.0' || publishedIp === '::' || publishedIp === '[::]') return '127.0.0.1'
  return publishedIp
}

/**
 * @param {object} container - a `DockerContainer` from `docker.js`.
 * @returns {object|null} the discovery record, or null when the container is not usable.
 */
function candidateOf(container) {
  if (container === null || typeof container !== 'object') return null
  const service = isServiceImage('redis', container.image)
    ? 'redis'
    : isServiceImage('postgres', container.image)
      ? 'postgres'
      : null
  if (service === null) return null
  const containerPort = SERVICE_CONTAINER_PORTS[service]
  const published = publishedPortOf(container.ports, containerPort)
  return {
    service,
    name: String(container.name ?? ''),
    image: String(container.image ?? ''),
    state: String(container.state ?? ''),
    running: container.state === 'running',
    containerPort,
    hostPort: published === null ? null : published.hostPort,
    hostIp: published === null ? null : published.hostIp,
    envEntries: container.envEntries,
  }
}

/**
 * Discover every Redis/PostgreSQL container and the credentials visible in its
 * environment. One `docker ps` plus one `docker inspect` per matching container.
 *
 * @param {{ listContainers: () => Promise<any[]>, inspectContainer: (id: string) => Promise<any> }} dockerService - the Docker service.
 * @returns {Promise<{ redis: object[], postgres: object[] }>} internal candidates (contain credentials; never serialize).
 */
export async function discoverCandidates(dockerService) {
  const containers = await dockerService.listContainers()
  /** @type {{ redis: object[], postgres: object[] }} */
  const result = { redis: [], postgres: [] }
  for (const container of containers) {
    if (!isServiceImage('redis', container.image) && !isServiceImage('postgres', container.image)) continue
    let detail
    try {
      detail = await dockerService.inspectContainer(container.id)
    } catch {
      // The container vanished between `ps` and `inspect`: listing it as a
      // candidate without its environment is still useful, so fall back to the
      // summary row instead of failing the whole discovery.
      detail = { ...container, env: [] }
    }
    const candidate = candidateOf({ ...container, ...detail, ports: container.ports ?? detail.ports })
    if (candidate === null) continue
    candidate.credentials = credentialsFromEnv(candidate.service, detail.env)
    candidate.envEntries = undefined
    result[candidate.service].push(candidate)
  }
  for (const service of ['redis', 'postgres']) {
    result[service].sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }
  return result
}

/**
 * The browser-safe view of one service's candidates.
 *
 * @param {object[]} candidates - internal candidates.
 * @returns {object[]} candidates without secrets.
 */
export function publicCandidates(candidates) {
  if (!Array.isArray(candidates)) return []
  return candidates.map((candidate) => ({
    name: candidate.name,
    image: candidate.image,
    state: candidate.state,
    running: candidate.running === true,
    containerPort: candidate.containerPort,
    hostPort: candidate.hostPort ?? null,
    hasPublishedPort: candidate.hostPort !== null && candidate.hostPort !== undefined,
    hasPassword: typeof candidate.credentials?.password === 'string' && candidate.credentials.password !== '',
    credentialsSource: hasEnvCredentials(candidate) ? 'container-env' : 'none',
  }))
}

/**
 * @param {object} candidate - an internal candidate.
 * @returns {boolean} whether its environment carries any credential.
 */
export function hasEnvCredentials(candidate) {
  const credentials = candidate.credentials ?? {}
  return ['username', 'password', 'database'].some((field) => typeof credentials[field] === 'string' && credentials[field] !== '')
}

/**
 * Where the credentials for one candidate come from.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {object} settings - the service's effective settings.
 * @param {object} candidate - an internal candidate.
 * @returns {'settings'|'container-env'|'none'} the credential source.
 */
export function credentialSourceFor(service, settings, candidate) {
  const explicit = service === 'redis'
    ? (settings.username ?? '') !== '' || (settings.password ?? '') !== ''
    : (settings.user ?? '') !== '' || (settings.password ?? '') !== ''
  if (explicit) return 'settings'
  return hasEnvCredentials(candidate) ? 'container-env' : 'none'
}

/**
 * @param {string} service - `redis` | `postgres`.
 * @param {object} settings - the service's effective settings.
 * @returns {object} the manual-mode connection object.
 */
export function manualConnection(service, settings) {
  if (service === 'redis') {
    return {
      host: settings.host,
      port: settings.port,
      username: settings.username ?? '',
      password: settings.password ?? '',
      db: settings.db ?? 0,
      tls: settings.tls === true,
      timeoutMs: settings.timeoutMs,
    }
  }
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user === '' || settings.user === undefined ? POSTGRES_FALLBACK_USER : settings.user,
    password: settings.password ?? '',
    database: settings.database === '' || settings.database === undefined ? POSTGRES_FALLBACK_DATABASE : settings.database,
    ssl: settings.ssl ?? 'prefer',
    timeoutMs: settings.timeoutMs,
  }
}

/**
 * Choose the container a docker-mode operation should talk to.
 *
 * Pinned wins; otherwise exactly one running candidate is used, and two or more
 * running candidates raise an ambiguity instead of silently picking one.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {object} settings - the service's effective settings.
 * @param {object[]} candidates - internal candidates, running first.
 * @returns {object} the chosen candidate.
 */
export function selectCandidate(service, settings, candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  const label = service === 'redis' ? 'Redis' : 'PostgreSQL'
  const wanted = typeof settings.container === 'string' ? settings.container.trim() : ''
  if (wanted !== '') {
    const match = list.find((candidate) => candidate.name === wanted)
    if (match === undefined) {
      throw new DataError(`${service}_container_not_found`, `the container "${wanted}" does not look like a ${label} container`, {
        container: wanted,
        available: list.map((candidate) => candidate.name),
      })
    }
    return match
  }
  const running = list.filter((candidate) => candidate.running === true)
  if (running.length === 0) {
    if (list.length === 0) {
      throw new DataError(`${service}_no_container`, `no ${label} container was found; create one or start it, or switch this connection to a manual address`, {
        hint: service === 'redis' ? 'docker run -d --name redis -p 6379:6379 redis:7' : 'docker run -d --name postgres -e POSTGRES_PASSWORD=... -p 5432:5432 postgres:16',
      })
    }
    throw new DataError(`${service}_no_running_container`, `the ${label} container${list.length > 1 ? 's are' : ' is'} not running`, {
      candidates: publicCandidates(list),
    })
  }
  if (running.length > 1) {
    throw new DataError(`${service}_ambiguous_container`, `${running.length} ${label} containers are running; choose one`, {
      candidates: publicCandidates(running),
    })
  }
  return running[0]
}

/**
 * Build the connection object for one chosen candidate.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {object} settings - the service's effective settings.
 * @param {object} candidate - the chosen internal candidate.
 * @returns {{ connection: object, credentialsSource: string }} the connection and its source.
 */
export function connectionForCandidate(service, settings, candidate) {
  const label = service === 'redis' ? 'Redis' : 'PostgreSQL'
  if (candidate.hostPort === null || candidate.hostPort === undefined) {
    throw new DataError(`${service}_no_published_port`, `the container "${candidate.name}" does not publish port ${candidate.containerPort} to the host`, {
      container: candidate.name,
      containerPort: candidate.containerPort,
      hint: `publish it with -p <host-port>:${candidate.containerPort}`,
    })
  }
  const host = dialAddress(candidate.hostIp)
  const envCredentials = candidate.credentials ?? {}
  const credentialsSource = credentialSourceFor(service, settings, candidate)
  if (service === 'redis') {
    return {
      connection: {
        host,
        port: candidate.hostPort,
        username: (settings.username ?? '') !== '' ? settings.username : envCredentials.username ?? '',
        password: (settings.password ?? '') !== '' ? settings.password : envCredentials.password ?? '',
        db: typeof settings.db === 'number' ? settings.db : envCredentials.db ?? 0,
        tls: settings.tls === true,
        timeoutMs: settings.timeoutMs,
      },
      credentialsSource,
    }
  }
  return {
    connection: {
      host,
      port: candidate.hostPort,
      user: (settings.user ?? '') !== '' ? settings.user : envCredentials.username ?? POSTGRES_FALLBACK_USER,
      password: (settings.password ?? '') !== '' ? settings.password : envCredentials.password ?? '',
      database: (settings.database ?? '') !== '' ? settings.database : envCredentials.database ?? POSTGRES_FALLBACK_DATABASE,
      ssl: settings.ssl ?? 'prefer',
      timeoutMs: settings.timeoutMs,
    },
    credentialsSource,
  }
}

/**
 * Resolve the connection one Redis/PostgreSQL operation should use.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {object} settings - the service's effective settings (`mode`, `container`, …).
 * @param {object[]} candidates - internal candidates for this service.
 * @returns {{ connection: object, target: object }} the connection and its browser-safe description.
 */
export function resolveConnection(service, settings, candidates) {
  if (settings.mode !== 'docker') {
    return {
      connection: manualConnection(service, settings),
      target: {
        mode: 'manual',
        container: null,
        host: settings.host,
        port: settings.port,
        credentialsSource: settings.password ? 'settings' : 'none',
      },
    }
  }
  const candidate = selectCandidate(service, settings, candidates)
  const { connection, credentialsSource } = connectionForCandidate(service, settings, candidate)
  return {
    connection,
    target: {
      mode: 'docker',
      container: candidate.name,
      host: connection.host,
      port: connection.port,
      credentialsSource,
    },
  }
}

/**
 * Every running instance of the service, with its resolved endpoint, for the
 * panel's instance switcher. Never throws: an instance without a published port
 * is reported with `hasPublishedPort: false`.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {object} settings - the service's effective settings.
 * @param {object[]} candidates - internal candidates.
 * @returns {object[]} the running instances.
 */
export function resolveInstances(service, settings, candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  return list.filter((candidate) => candidate.running === true).map((candidate) => {
    const host = dialAddress(candidate.hostIp)
    const hasPublishedPort = candidate.hostPort !== null && candidate.hostPort !== undefined
    let credentialsSource = credentialSourceFor(service, settings, candidate)
    let hasPassword = typeof candidate.credentials?.password === 'string' && candidate.credentials.password !== ''
    let port = hasPublishedPort ? candidate.hostPort : null
    if (hasPublishedPort) {
      try {
        const resolved = connectionForCandidate(service, settings, candidate)
        port = resolved.connection.port
        credentialsSource = resolved.credentialsSource
        hasPassword = typeof resolved.connection.password === 'string' && resolved.connection.password !== ''
      } catch {
        // Keep the descriptive row instead of throwing the whole view away.
      }
    }
    return {
      container: candidate.name,
      image: candidate.image,
      state: candidate.state,
      host,
      port,
      containerPort: candidate.containerPort,
      hasPublishedPort,
      hasPassword,
      credentialsSource,
    }
  })
}

/**
 * Wrap a discovery failure in the service's own vocabulary.
 *
 * @param {string} service - `redis` | `postgres`.
 * @param {unknown} error - the thrown discovery failure.
 * @returns {DataError} the service-scoped failure.
 */
export function discoveryFailure(service, error) {
  if (isDataError(error) && /_(no_container|no_running_container|ambiguous_container|container_not_found|no_published_port)$/.test(error.code)) return error
  const message = isDataError(error) && error.code === 'docker_unavailable'
    ? `Docker is not available, so the ${service === 'redis' ? 'Redis' : 'PostgreSQL'} container cannot be found: ${error.message}`
    : `could not look up the ${service === 'redis' ? 'Redis' : 'PostgreSQL'} container: ${describeError(error)}`
  return new DataError(`${service}_docker_unavailable`, message, { cause: isDataError(error) ? error.code : 'unknown' })
}

export default {
  SERVICE_CONTAINER_PORTS,
  POSTGRES_FALLBACK_USER,
  POSTGRES_FALLBACK_DATABASE,
  isServiceImage,
  envToRecord,
  credentialsFromEnv,
  publishedPortOf,
  dialAddress,
  discoverCandidates,
  publicCandidates,
  hasEnvCredentials,
  credentialSourceFor,
  manualConnection,
  selectCandidate,
  connectionForCandidate,
  resolveConnection,
  resolveInstances,
  discoveryFailure,
}
