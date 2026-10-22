/**
 * The operations the panel calls.
 *
 * Every capability is implemented here once. The browser reaches it through
 * `/api/dsh-long-data`; there is no second caller (this plugin stays page-only
 * on purpose, so it spends no model context).
 *
 * ## Unit of work
 *
 * A connection is opened per operation and closed in a `finally`, which keeps
 * the plugin free of long-lived sockets it would have to reap across plugin
 * reloads. Redis and PostgreSQL run in Docker containers on this machine, so the
 * panel resolves the container (published port + environment credentials) on
 * every operation through `targets.js`; the discovery that feeds that resolution
 * is cached briefly because it costs one `docker ps` plus one inspect per
 * service container.
 *
 * ## Secrets
 *
 * The settings view is redacted (see `settings.js`), candidate containers expose
 * only `hasPassword`, and container environment variables whose key looks like a
 * credential are printed as `***` before they reach the browser.
 *
 * @module dsh-long-data/src/ops
 */

import { createDockerService, DOCKER_ACTIONS } from './docker.js'
import {
  DataError,
  describeError,
  isDataError,
  optionalBoolean,
  optionalInteger,
  requireObject,
  requireString,
} from './errors.js'
import { dirname, basename } from 'node:path'

import { parseDockerfile, readDockerfileText, scanDockerfiles } from './dockerfiles.js'
import * as postgres from './postgres.js'
import * as redis from './redis.js'
import { buildRelations } from './relations.js'
import {
  discoverCandidates,
  discoveryFailure,
  publicCandidates,
  resolveConnection,
  resolveInstances,
} from './targets.js'

/**
 * The plugin's public version, mirrored from package.json (asserted by the
 * manifest test). It is not read from disk: the packed bundle's package.json is
 * not guaranteed to sit beside the module at runtime.
 */
export const VERSION = '0.5.0'

/** The environment variable keys whose values are hidden before display. */
const SECRET_ENV_PATTERN = /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i

/** How long Docker discovery (container candidates) is reused. */
const DISCOVERY_TTL_MS = 4000

/** How long the Docker version probe is reused. */
const VERSION_TTL_MS = 5000

/** How long the container ↔ image/volume/network relation graph is reused. */
const RELATIONS_TTL_MS = 5000

/** How long the beginner-friendly overview is reused. */
const OVERVIEW_TTL_MS = 5000

/** How long a Dockerfile scan is reused. */
const DOCKERFILES_TTL_MS = 10000

/**
 * Hide the values of credential-looking environment variables.
 *
 * @param {{ key: string, value: string }[]} env - the container environment.
 * @returns {{ key: string, value: string }[]} the same list with marked values masked.
 */
export function redactEnv(env) {
  if (!Array.isArray(env)) return []
  return env.map((entry) => {
    if (entry === null || typeof entry !== 'object') return { key: String(entry), value: '***' }
    const key = String(entry.key ?? '')
    const value = String(entry.value ?? '')
    return { key, value: SECRET_ENV_PATTERN.test(key) ? '***' : value }
  })
}

/**
 * @param {unknown} error - a thrown value.
 * @returns {{ code: string, message: string, details: object }} the failure envelope body.
 */
function failurePayload(error) {
  if (isDataError(error)) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return { code: 'internal_error', message: describeError(error), details: {} }
}

/**
 * Build the operations object.
 *
 * @param {object} deps - collaborators.
 * @param {import('./settings.js').SettingsStore} deps.settings - the durable settings.
 * @param {ReturnType<import('./config.js').resolveConfig>} deps.config - the row config.
 * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [deps.logger] - logger.
 * @returns {{ run: (endpoint: string, payload?: unknown) => Promise<object>,
 *   state: () => Promise<object>, invalidateDocker: () => void }} the operations.
 */
export function createOps({ settings, config, logger = {}, workspaceRoots = () => [] }) {
  /** @type {{ key: string, at: number, value: object } | null} */
  let versionCache = null
  /** @type {{ key: string, service: ReturnType<typeof createDockerService> } | null} */
  let dockerCache = null
  /** @type {{ at: number, value: { redis: object[], postgres: object[] } | null, error: unknown } | null} */
  let discoveryCache = null
  /** @type {{ at: number, value: object } | null} */
  let relationsCache = null
  /** @type {{ at: number, value: object } | null} */
  let overviewCache = null
  /** @type {{ key: string, at: number, value: object } | null} */
  let dockerfilesCache = null

  /**
   * @returns {{ key: string, opts: { binary: string, timeoutMs: number } }} the docker service identity.
   */
  function dockerIdentity() {
    const opts = settings.dockerOptions()
    return { key: `${opts.binary}|${opts.timeoutMs}`, opts }
  }

  /**
   * @returns {ReturnType<typeof createDockerService>} a service for the current settings.
   */
  function dockerService() {
    const { key, opts } = dockerIdentity()
    if (dockerCache === null || dockerCache.key !== key) {
      dockerCache = { key, service: createDockerService(opts) }
    }
    return dockerCache.service
  }

  /** Drop everything derived from the Docker daemon. */
  function invalidateCaches() {
    versionCache = null
    discoveryCache = null
    relationsCache = null
    overviewCache = null
    dockerfilesCache = null
  }

  /**
   * The distinct scan roots: every workspace directory the Host knows about plus the
   * user's extra roots from the settings, in that order.
   *
   * @returns {{ roots: string[], maxDepth: number }} the scan configuration.
   */
  function dockerfileScanConfig() {
    const configured = settings.dockerfileOptions()
    let fromWorkspaces = []
    try {
      const value = typeof workspaceRoots === 'function' ? workspaceRoots() : []
      if (Array.isArray(value)) {
        fromWorkspaces = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
      }
    } catch {
      // A workspace registry that is not there yet must not stop the scan.
      fromWorkspaces = []
    }
    const roots = []
    for (const root of [...fromWorkspaces, ...configured.roots]) {
      if (!roots.includes(root)) roots.push(root)
    }
    return { roots, maxDepth: configured.maxDepth }
  }

  /**
   * @param {string} filePath - a scanned Dockerfile path.
   * @param {object} file - its scan record.
   * @returns {Promise<object>} the parsed summary plus the raw content.
   */
  async function readAndParseDockerfile(filePath, file) {
    const text = await readDockerfileText(filePath)
    const parsed = parseDockerfile(text.content)
    const contextPath = dirname(filePath)
    const slug = basename(contextPath).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'image'
    return {
      path: filePath,
      name: file.name ?? basename(filePath),
      relativePath: file.relativePath ?? filePath,
      root: file.root ?? '',
      size: file.size ?? text.size ?? 0,
      modifiedAt: file.modifiedAt ?? '',
      detectedBy: file.detectedBy ?? 'name',
      content: text.content,
      truncated: text.truncated,
      parsed,
      contextPath,
      suggestedTag: `${slug}:latest`,
    }
  }

  /**
   * Scan the configured roots and parse every recognized Dockerfile. Cached briefly;
   * `force` bypasses the cache. Unreadable individual files are skipped; root errors are
   * reported in `scan.errors`.
   *
   * @param {boolean} [force] - ignore the cache.
   * @returns {Promise<object>} `{ dockerfiles, roots, scan }`.
   */
  async function dockerfileSummaries(force = false) {
    const { roots, maxDepth } = dockerfileScanConfig()
    const key = `${maxDepth}|${roots.join('|')}`
    const now = Date.now()
    if (!force && dockerfilesCache !== null && dockerfilesCache.key === key && now - dockerfilesCache.at < DOCKERFILES_TTL_MS) {
      return dockerfilesCache.value
    }
    // Scan each root with its own budget: one huge workspace must not consume the
    // walk budget of every later root, which is what a single global visit limit
    // would do in a multi-workspace profile.
    const perRootLimit = 3000
    const perRoot = await Promise.all(roots.map(async (root) => {
      try {
        return await scanDockerfiles({ roots: [root], maxDepth, maxFiles: perRootLimit })
      } catch (error) {
        return { roots: [root], files: [], visitedFiles: 0, truncated: false, errors: [{ root, message: describeError(error) }] }
      }
    }))
    const files = []
    const seenPaths = new Set()
    const scanErrors = []
    let visitedFiles = 0
    let scanTruncated = false
    for (const result of perRoot) {
      visitedFiles += result.visitedFiles
      scanTruncated = scanTruncated || result.truncated
      scanErrors.push(...result.errors)
      for (const file of result.files) {
        if (seenPaths.has(file.path)) continue
        seenPaths.add(file.path)
        files.push(file)
      }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    if (files.length > 100) {
      files.length = 100
      scanTruncated = true
    }
    const scan = { roots: [...roots], files, visitedFiles, truncated: scanTruncated, errors: scanErrors }
    const dockerfiles = []
    for (const file of scan.files) {
      try {
        const detail = await readAndParseDockerfile(file.path, file)
        dockerfiles.push({
          path: detail.path,
          name: detail.name,
          relativePath: detail.relativePath,
          root: detail.root,
          size: detail.size,
          modifiedAt: detail.modifiedAt,
          detectedBy: detail.detectedBy,
          stageCount: detail.parsed.stageCount,
          multiStage: detail.parsed.multiStage,
          baseImages: detail.parsed.baseImages,
          finalBaseImage: detail.parsed.finalBaseImage,
          exposedPorts: detail.parsed.exposedPorts,
          instructionCount: detail.parsed.instructionCount,
          healthcheck: detail.parsed.healthcheck,
          command: detail.parsed.command,
          entrypoint: detail.parsed.entrypoint,
          cmd: detail.parsed.cmd,
          envKeys: detail.parsed.envKeys,
          volumes: detail.parsed.volumes,
          contextPath: detail.contextPath,
          suggestedTag: detail.suggestedTag,
        })
      } catch {
        // A file that vanished or cannot be read is simply not reported.
      }
    }
    const value = {
      dockerfiles,
      roots: scan.roots,
      scan: {
        visitedFiles: scan.visitedFiles,
        truncated: scan.truncated,
        errors: scan.errors,
        generatedAt: new Date().toISOString(),
      },
    }
    dockerfilesCache = { key, at: now, value }
    return value
  }

  /**
   * @param {number} bytes - a byte count.
   * @returns {string} a short human-readable size for the overview insights.
   */
  function humanBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
    return `${rounded} ${units[unit]}`
  }

  /**
   * Health of one Docker-resolved service, for the overview page. Never throws:
   * ambiguity, a missing container and a refused connection all become data.
   *
   * @param {'redis'|'postgres'} service - the service.
   * @returns {Promise<object>} the service health record.
   */
  async function serviceHealth(service) {
    const effective = settings.effective()[service]
    const health = {
      mode: effective.mode,
      container: null,
      reachable: false,
      version: null,
      instances: 0,
      ambiguous: false,
      summary: {},
      error: null,
    }
    let found = null
    let discoveryError = null
    try {
      found = await discovery()
    } catch (error) {
      discoveryError = error
    }
    const candidates = found === null ? [] : found[service]
    if (discoveryError !== null && effective.mode === 'docker') {
      health.error = failurePayload(discoveryFailure(service, discoveryError))
      return health
    }
    health.instances = effective.mode === 'docker' ? resolveInstances(service, effective, candidates).length : 0
    let resolved
    try {
      resolved = resolveConnection(service, effective, candidates)
    } catch (error) {
      health.error = failurePayload(error)
      health.ambiguous = isDataError(error) && error.code === `${service}_ambiguous_container`
      return health
    }
    health.container = resolved.target.container
    try {
      if (service === 'redis') {
        const info = await redis.redisInfo(resolved.connection)
        health.reachable = true
        health.version = info.summary.version ?? null
        health.summary = {
          keys: info.summary.totalKeys ?? null,
          memoryHuman: info.summary.usedMemoryHuman ?? null,
          clients: info.summary.connectedClients ?? null,
        }
      } else {
        const version = await postgres.pgVersion(resolved.connection)
        const databases = await postgres.pgDatabases(resolved.connection)
        health.reachable = true
        health.version = typeof version.version === 'string' ? version.version : null
        const sessions = databases.reduce((sum, database) => sum + (Number.isFinite(database.connections) ? database.connections : 0), 0)
        health.summary = {
          databases: databases.length,
          currentDatabase: version.currentDatabase ?? null,
          sessions,
        }
      }
    } catch (error) {
      health.error = failurePayload(isDataError(error) ? error : new DataError(`${service}_unreachable`, describeError(error)))
    }
    return health
  }

  /**
   * @param {'redis'|'postgres'} service - the service.
   * @param {object} health - its health record.
   * @returns {object[]} the insights for that service.
   */
  function serviceInsights(service, health) {
    const prefix = service === 'redis' ? 'redis' : 'postgres'
    if (health.reachable) {
      return [{ code: `${prefix}_ok`, level: 'good', params: { container: health.container ?? '', version: health.version ?? '' } }]
    }
    const code = health.error?.code ?? ''
    if (code === `${prefix}_ambiguous_container`) {
      return [{ code: `${prefix}_ambiguous`, level: 'warn', params: { count: health.instances } }]
    }
    if (code === `${prefix}_no_container`) return [{ code: `${prefix}_no_container`, level: 'info', params: {} }]
    if (code === `${prefix}_no_running_container`) return [{ code: `${prefix}_no_running`, level: 'warn', params: {} }]
    return [{
      code: `${prefix}_unreachable`,
      level: 'danger',
      params: { container: health.container ?? '', message: health.error?.message ?? '' },
    }]
  }

  /**
   * The beginner-friendly health report: counts, plain container rows, compose
   * projects, service health and a list of structured insights the browser
   * localizes into plain sentences.
   *
   * @returns {Promise<object>} the overview value.
   */
  async function overviewValue() {
    const now = Date.now()
    if (overviewCache !== null && now - overviewCache.at < OVERVIEW_TTL_MS) return overviewCache.value

    const docker = await dockerVersion()
    let relationGraph = null
    let disk = null
    if (docker.available === true) {
      try {
        relationGraph = await relations()
      } catch {
        relationGraph = null
      }
      try {
        disk = await dockerService().diskUsage()
      } catch {
        disk = null
      }
    }

    const containers = relationGraph === null ? [] : relationGraph.containers.map((row) => ({
      name: row.name,
      state: row.state,
      image: row.image,
      role: row.role ?? 'other',
      project: row.project ?? null,
      service: row.service ?? null,
      restartPolicy: row.restartPolicy ?? null,
      ports: row.ports,
      volumes: row.volumes.filter((volume) => volume.type === 'volume').length,
      bindMounts: row.volumes.filter((volume) => volume.type === 'bind').length,
      networks: row.networks.length,
    }))

    /** @type {Map<string, {name: string, containers: number, running: number}>} */
    const projectMap = new Map()
    for (const container of containers) {
      if (container.project === null) continue
      const project = projectMap.get(container.project) ?? { name: container.project, containers: 0, running: 0 }
      project.containers += 1
      if (container.state === 'running') project.running += 1
      projectMap.set(container.project, project)
    }

    const summary = relationGraph === null
      ? { containers: 0, running: 0, images: 0, volumes: 0, networks: 0, danglingImages: 0, unusedVolumes: 0 }
      : relationGraph.summary
    const counts = {
      containers: summary.containers,
      running: summary.running,
      stopped: Math.max(0, summary.containers - summary.running),
      images: summary.images,
      volumes: summary.volumes,
      networks: summary.networks,
      danglingImages: summary.danglingImages,
      unusedVolumes: summary.unusedVolumes,
    }

    const [redisHealth, postgresHealth] = await Promise.all([serviceHealth('redis'), serviceHealth('postgres')])
    const health = { redis: redisHealth, postgres: postgresHealth }

    /** @type {{code: string, level: string, params: object}[]} */
    const insights = []
    if (docker.available !== true) {
      insights.push({ code: 'docker_unavailable', level: 'danger', params: {} })
    } else if (relationGraph === null) {
      insights.push({ code: 'docker_unavailable', level: 'danger', params: {} })
    } else {
      if (counts.containers === 0) insights.push({ code: 'no_containers', level: 'info', params: {} })
      const stopped = relationGraph.containers.filter((container) => ['exited', 'created', 'dead'].includes(container.state))
      if (stopped.length > 0) {
        insights.push({ code: 'stopped_containers', level: 'warn', params: { count: stopped.length, names: stopped.slice(0, 8).map((container) => container.name) } })
      }
      const restarting = relationGraph.containers.filter((container) => container.state === 'restarting')
      if (restarting.length > 0) {
        insights.push({ code: 'restarting_containers', level: 'warn', params: { count: restarting.length, names: restarting.slice(0, 8).map((container) => container.name) } })
      }
      const unusedVolumes = relationGraph.volumes.filter((volume) => volume.containers.length === 0)
      if (unusedVolumes.length > 0) {
        insights.push({ code: 'unused_volumes', level: 'info', params: { count: unusedVolumes.length, names: unusedVolumes.slice(0, 8).map((volume) => volume.name) } })
      }
      if (counts.danglingImages > 0) insights.push({ code: 'dangling_images', level: 'info', params: { count: counts.danglingImages } })
      if (disk !== null) {
        const bytes = ['images', 'containers', 'volumes', 'buildCache']
          .map((key) => (Number.isFinite(disk[key]?.reclaimableBytes) ? disk[key].reclaimableBytes : 0))
          .reduce((sum, value) => sum + value, 0)
        if (bytes > 0) insights.push({ code: 'disk_reclaimable', level: 'info', params: { bytes, human: humanBytes(bytes) } })
      }
    }
    insights.push(...serviceInsights('redis', redisHealth), ...serviceInsights('postgres', postgresHealth))

    let dockerfilesInfo = null
    try {
      const dockerfileScan = await dockerfileSummaries()
      dockerfilesInfo = { count: dockerfileScan.dockerfiles.length, generatedAt: dockerfileScan.scan.generatedAt }
      if (dockerfileScan.dockerfiles.length > 0) {
        insights.push({
          code: 'dockerfiles_found',
          level: 'info',
          params: { count: dockerfileScan.dockerfiles.length, names: dockerfileScan.dockerfiles.slice(0, 8).map((file) => file.name) },
        })
      }
    } catch {
      dockerfilesInfo = null
    }

    const value = {
      generatedAt: new Date().toISOString(),
      docker: { available: docker.available === true, version: docker.serverVersion ?? docker.clientVersion ?? null, error: docker.error ?? null },
      counts,
      disk: disk ?? null,
      containers,
      projects: [...projectMap.values()],
      services: health,
      insights,
      dockerfiles: dockerfilesInfo,
    }
    overviewCache = { at: now, value }
    return value
  }

  /**
   * The relation graph, cached briefly: it costs one inspect per container.
   *
   * @returns {Promise<object>} the relations payload.
   */
  async function relations() {
    const now = Date.now()
    if (relationsCache !== null && now - relationsCache.at < RELATIONS_TTL_MS) return relationsCache.value
    const value = await buildRelations(dockerService())
    relationsCache = { at: now, value }
    return value
  }

  /**
   * Docker availability, cached briefly: the panel asks for `state` on every
   * refresh and a spawn per repaint would be wasteful.
   *
   * @returns {Promise<object>} the version result.
   */
  async function dockerVersion() {
    const { key } = dockerIdentity()
    const now = Date.now()
    if (versionCache !== null && versionCache.key === key && now - versionCache.at < VERSION_TTL_MS) return versionCache.value
    const value = await dockerService().version()
    versionCache = { key, at: now, value }
    return value
  }

  /**
   * Redis/PostgreSQL container discovery, cached for a few seconds.
   *
   * @returns {Promise<{ redis: object[], postgres: object[] }>} internal candidates.
   */
  async function discovery() {
    const now = Date.now()
    if (discoveryCache !== null && now - discoveryCache.at < DISCOVERY_TTL_MS) {
      if (discoveryCache.error !== null) throw discoveryCache.error
      return discoveryCache.value
    }
    try {
      const value = await discoverCandidates(dockerService())
      discoveryCache = { at: now, value, error: null }
      return value
    } catch (error) {
      discoveryCache = { at: now, value: null, error }
      throw error
    }
  }

  /**
   * Resolve where one service operation should connect.
   *
   * @param {'redis'|'postgres'} service - the service.
   * @returns {Promise<{ connection: object, target: object }>} the connection and its description.
   */
  async function serviceTarget(service) {
    const effective = settings.effective()[service]
    if (effective.mode !== 'docker') {
      return resolveConnection(service, effective, [])
    }
    let candidates
    try {
      candidates = (await discovery())[service]
    } catch (error) {
      throw discoveryFailure(service, error)
    }
    return resolveConnection(service, effective, candidates)
  }

  /**
   * @param {'redis'|'postgres'} service - the service.
   * @returns {Promise<object>} the connection object for that service.
   */
  async function serviceConnection(service) {
    return (await serviceTarget(service)).connection
  }

  /**
   * The bootstrap view of both Docker-resolved services.
   *
   * @returns {Promise<object>} `targets` for `state`.
   */
  async function targetView() {
    /** @type {{ redis?: object[], postgres?: object[] } | null} */
    let found = null
    let discoveryError = null
    try {
      found = await discovery()
    } catch (error) {
      discoveryError = error
    }
    /** @type {Record<string, object>} */
    const view = {}
    for (const service of ['redis', 'postgres']) {
      const effective = settings.effective()[service]
      const candidates = found === null ? [] : found[service]
      if (discoveryError !== null && effective.mode === 'docker') {
        view[service] = {
          candidates: [],
          instances: [],
          resolved: null,
          error: failurePayload(discoveryFailure(service, discoveryError)),
        }
        continue
      }
      let resolved = null
      let error = null
      try {
        resolved = resolveConnection(service, effective, candidates).target
      } catch (failure) {
        error = failurePayload(failure)
      }
      const instances = effective.mode === 'docker' ? resolveInstances(service, effective, candidates) : []
      view[service] = { candidates: publicCandidates(candidates), instances, resolved, error }
    }
    return view
  }

  /**
   * @param {unknown} payload - the request payload.
   * @param {object} connection - a PostgreSQL connection object.
   * @returns {object} the connection, with a per-request database override applied.
   */
  function withDatabase(payload, connection) {
    const input = payload === null || payload === undefined ? {} : requireObject(payload)
    if (input.database === undefined || input.database === null || input.database === '') return connection
    return { ...connection, database: requireString(input, 'database', 128) }
  }

  /** @type {Record<string, (payload: any) => Promise<object>>} */
  const handlers = {
    async state() {
      const docker = await dockerVersion()
      return {
        version: VERSION,
        settings: settings.redacted(),
        docker: {
          available: docker.available === true,
          binary: docker.binary,
          version: docker.serverVersion ?? docker.clientVersion ?? null,
          error: docker.error ?? null,
        },
        targets: await targetView(),
      }
    },

    async 'settings.save'(payload) {
      const saved = settings.save(payload)
      invalidateCaches()
      return saved
    },

    async 'docker.list'() {
      const containers = await dockerService().listContainers()
      return { containers, count: containers.length }
    },

    async 'docker.inspect'(payload) {
      const input = requireObject(payload)
      const id = requireString(input, 'id', 128)
      const container = await dockerService().inspectContainer(id)
      return { container: { ...container, env: redactEnv(container.env) } }
    },

    async 'docker.logs'(payload) {
      const input = requireObject(payload)
      const id = requireString(input, 'id', 128)
      const tail = optionalInteger(input, 'tail', config.logTailDefault, 1, 5000)
      return dockerService().logs(id, { tail })
    },

    async 'docker.stats'() {
      return { stats: await dockerService().stats() }
    },

    async 'docker.action'(payload) {
      const input = requireObject(payload)
      const id = requireString(input, 'id', 128)
      const action = requireString(input, 'action', 32)
      if (!DOCKER_ACTIONS.includes(action)) {
        throw new DataError('invalid_payload', `"action" must be one of ${DOCKER_ACTIONS.join(', ')}`, {
          field: 'action',
          allowed: DOCKER_ACTIONS,
        })
      }
      await dockerService().action(id, action)
      invalidateCaches()
      return { id, action, ok: true }
    },

    async 'docker.images'() {
      const images = await dockerService().listImages()
      return { images, count: images.length }
    },

    async 'docker.imageRemove'(payload) {
      const input = requireObject(payload)
      const id = requireString(input, 'id', 256)
      const force = optionalBoolean(input, 'force', false)
      await dockerService().removeImage(id, { force })
      invalidateCaches()
      return { id, ok: true }
    },

    async 'docker.volumes'() {
      const volumes = await dockerService().listVolumes()
      return { volumes, count: volumes.length }
    },

    async 'docker.volumeRemove'(payload) {
      const input = requireObject(payload)
      const name = requireString(input, 'name', 256)
      const force = optionalBoolean(input, 'force', false)
      await dockerService().removeVolume(name, { force })
      invalidateCaches()
      return { name, ok: true }
    },

    async 'docker.networks'() {
      const networks = await dockerService().listNetworks()
      return { networks, count: networks.length }
    },

    async 'docker.networkRemove'(payload) {
      const input = requireObject(payload)
      const name = requireString(input, 'name', 256)
      await dockerService().removeNetwork(name)
      invalidateCaches()
      return { name, ok: true }
    },

    async 'docker.diskUsage'() {
      return { usage: await dockerService().diskUsage() }
    },

    async overview() {
      return overviewValue()
    },

    async 'dockerfiles.list'(payload) {
      const input = payload === null || payload === undefined ? {} : requireObject(payload)
      const force = input.refresh === true
      return dockerfileSummaries(force)
    },

    async 'dockerfiles.read'(payload) {
      const input = requireObject(payload)
      const filePath = requireString(input, 'path', 4096)
      let found = (await dockerfileSummaries(false)).dockerfiles.find((file) => file.path === filePath)
      if (found === undefined) {
        // The file may be new since the cached scan; rescan once before refusing.
        found = (await dockerfileSummaries(true)).dockerfiles.find((file) => file.path === filePath)
      }
      if (found === undefined) {
        throw new DataError('dockerfiles_not_found', 'that Dockerfile is not part of the current scan', { field: 'path', path: filePath })
      }
      const detail = await readAndParseDockerfile(found.path, found)
      return {
        path: detail.path,
        name: detail.name,
        relativePath: detail.relativePath,
        root: detail.root,
        size: detail.size,
        modifiedAt: detail.modifiedAt,
        content: detail.content,
        truncated: detail.truncated,
        parsed: detail.parsed,
        contextPath: detail.contextPath,
        suggestedTag: detail.suggestedTag,
      }
    },

    async 'docker.relations'() {
      return { relations: await relations() }
    },

    async 'docker.imageInspect'(payload) {
      const input = requireObject(payload)
      const id = requireString(input, 'id', 256)
      return { image: await dockerService().inspectImage(id) }
    },

    async 'docker.volumeInspect'(payload) {
      const input = requireObject(payload)
      const name = requireString(input, 'name', 256)
      return { volume: await dockerService().inspectVolume(name) }
    },

    async 'docker.networkInspect'(payload) {
      const input = requireObject(payload)
      const name = requireString(input, 'name', 256)
      return { network: await dockerService().inspectNetwork(name) }
    },

    async 'redis.ping'() {
      return redis.redisPing(await serviceConnection('redis'))
    },

    async 'redis.info'() {
      return redis.redisInfo(await serviceConnection('redis'))
    },

    async 'redis.scan'(payload) {
      const input = requireObject(payload)
      const cursor = input.cursor === undefined || input.cursor === null ? '0' : String(input.cursor)
      if (!/^\d{1,20}$/.test(cursor)) {
        throw new DataError('invalid_payload', '"cursor" must be a numeric SCAN cursor', { field: 'cursor' })
      }
      const match = typeof input.match === 'string' && input.match !== '' ? input.match : '*'
      if (match.length > 512) {
        throw new DataError('invalid_payload', '"match" must be at most 512 characters', { field: 'match', limit: 512 })
      }
      const count = optionalInteger(input, 'count', Math.min(200, config.maxKeyScan), 1, config.maxKeyScan)
      const type = typeof input.type === 'string' ? input.type : ''
      return redis.redisScan(await serviceConnection('redis'), { cursor, match, count, type })
    },

    async 'redis.get'(payload) {
      const input = requireObject(payload)
      return redis.redisGet(await serviceConnection('redis'), requireString(input, 'key', 512))
    },

    async 'redis.set'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      if (typeof input.value !== 'string') {
        throw new DataError('invalid_payload', '"value" must be a string', { field: 'value' })
      }
      if (input.value.length > 1024 * 1024) {
        throw new DataError('invalid_payload', '"value" must be at most 1 MiB', { field: 'value', limit: 1048576 })
      }
      const ttlSeconds = optionalInteger(input, 'ttlSeconds', 0, 0, 31536000)
      return redis.redisSet(await serviceConnection('redis'), { key, value: input.value, ttlSeconds })
    },

    async 'redis.del'(payload) {
      const input = requireObject(payload)
      return redis.redisDelete(await serviceConnection('redis'), requireString(input, 'key', 512))
    },

    async 'redis.clients'() {
      return redis.redisClients(await serviceConnection('redis'))
    },

    async 'redis.dbsize'() {
      return redis.redisDbSize(await serviceConnection('redis'))
    },

    async 'redis.memory'(payload) {
      const input = requireObject(payload)
      return redis.redisMemoryUsage(await serviceConnection('redis'), requireString(input, 'key', 512))
    },

    async 'redis.rename'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      const newKey = requireString(input, 'newKey', 512)
      return redis.redisRename(await serviceConnection('redis'), key, newKey)
    },

    async 'redis.expire'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      const ttlSeconds = optionalInteger(input, 'ttlSeconds', 0, 0, 31536000)
      if (ttlSeconds < 1) {
        throw new DataError('invalid_payload', '"ttlSeconds" must be between 1 and 31536000', { field: 'ttlSeconds', min: 1, max: 31536000 })
      }
      return redis.redisExpire(await serviceConnection('redis'), key, ttlSeconds)
    },

    async 'redis.persist'(payload) {
      const input = requireObject(payload)
      return redis.redisPersist(await serviceConnection('redis'), requireString(input, 'key', 512))
    },

    async 'redis.hashSet'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      const field = requireString(input, 'field', 512)
      if (typeof input.value !== 'string') {
        throw new DataError('invalid_payload', '"value" must be a string', { field: 'value' })
      }
      return redis.redisHashSet(await serviceConnection('redis'), { key, field, value: input.value })
    },

    async 'redis.listPush'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      if (typeof input.value !== 'string') {
        throw new DataError('invalid_payload', '"value" must be a string', { field: 'value' })
      }
      const side = requireString(input, 'side', 8)
      if (side !== 'left' && side !== 'right') {
        throw new DataError('invalid_payload', '"side" must be "left" or "right"', { field: 'side', allowed: ['left', 'right'] })
      }
      return redis.redisListPush(await serviceConnection('redis'), { key, value: input.value, side })
    },

    async 'redis.setAdd'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      const member = requireString(input, 'member', 1024)
      return redis.redisSetAdd(await serviceConnection('redis'), { key, member })
    },

    async 'redis.setRemove'(payload) {
      const input = requireObject(payload)
      const key = requireString(input, 'key', 512)
      const member = requireString(input, 'member', 1024)
      return redis.redisSetRemove(await serviceConnection('redis'), { key, member })
    },

    async 'pg.version'(payload) {
      return postgres.pgVersion(withDatabase(payload, await serviceConnection('postgres')))
    },

    async 'pg.databases'() {
      return { databases: await postgres.pgDatabases(await serviceConnection('postgres')) }
    },

    async 'pg.tables'(payload) {
      const connection = withDatabase(payload, await serviceConnection('postgres'))
      const input = payload === null || payload === undefined ? {} : requireObject(payload)
      const schema = input.schema === undefined || input.schema === null || input.schema === ''
        ? undefined
        : requireString(input, 'schema', 128)
      const tables = await postgres.pgTables(connection, { schema })
      return { database: connection.database, schema: schema ?? null, tables }
    },

    async 'pg.columns'(payload) {
      const input = requireObject(payload)
      const connection = withDatabase(input, await serviceConnection('postgres'))
      const schema = requireString(input, 'schema', 128)
      const table = requireString(input, 'table', 256)
      const columns = await postgres.pgColumns(connection, { schema, table })
      return { database: connection.database, schema, table, columns }
    },

    async 'pg.query'(payload) {
      const input = requireObject(payload)
      const connection = withDatabase(input, await serviceConnection('postgres'))
      const sql = requireString(input, 'sql', 100000)
      const maxRows = optionalInteger(input, 'maxRows', config.maxQueryRows, 1, config.maxQueryRows)
      const result = await postgres.pgQuery(connection, { sql, maxRows })
      return { database: connection.database, ...result }
    },

    async 'pg.activity'(payload) {
      const connection = withDatabase(payload, await serviceConnection('postgres'))
      return { database: connection.database, sessions: await postgres.pgActivity(connection) }
    },

    async 'pg.tableDetail'(payload) {
      const input = requireObject(payload)
      const connection = withDatabase(input, await serviceConnection('postgres'))
      const schema = requireString(input, 'schema', 128)
      const table = requireString(input, 'table', 256)
      const detail = await postgres.pgTableDetail(connection, { schema, table })
      return { database: connection.database, schema, table, ...detail }
    },

    async 'pg.browse'(payload) {
      const input = requireObject(payload)
      const connection = withDatabase(input, await serviceConnection('postgres'))
      const schema = requireString(input, 'schema', 128)
      const table = requireString(input, 'table', 256)
      const limit = optionalInteger(input, 'limit', 50, 1, 500)
      const offset = optionalInteger(input, 'offset', 0, 0, 10000000)
      const orderBy = input.orderBy === undefined || input.orderBy === null || input.orderBy === ''
        ? undefined
        : requireString(input, 'orderBy', 128)
      const descending = optionalBoolean(input, 'descending', false)
      const withCount = optionalBoolean(input, 'withCount', false)
      const result = await postgres.pgBrowse(connection, { schema, table, limit, offset, orderBy, descending, withCount })
      return { database: connection.database, schema, table, ...result }
    },
  }

  /**
   * Run one endpoint, always answering with the contract envelope.
   *
   * @param {string} endpoint - the operation name.
   * @param {unknown} [payload] - the operation arguments.
   * @returns {Promise<{ok: true, value: any} | {ok: false, error: {code: string, message: string, details: object}}>} the envelope.
   */
  async function run(endpoint, payload) {
    const name = typeof endpoint === 'string' ? endpoint : ''
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined
    if (handler === undefined) {
      return fail('unknown_endpoint', `unknown endpoint "${name}"`, { endpoint: name })
    }
    try {
      return { ok: true, value: await handler(payload) }
    } catch (error) {
      if (isDataError(error)) return fail(error.code, error.message, error.details)
      logger.warn?.(`${name} failed unexpectedly: ${describeError(error)}`)
      return fail('internal_error', describeError(error), {})
    }
  }

  return {
    run,
    /**
     * @returns {Promise<object>} the panel bootstrap view (same as the `state` endpoint).
     */
    state: () => handlers.state({}),
    /** Drop the cached Docker probe after an external change. */
    invalidateDocker() {
      invalidateCaches()
    },
  }
}

/**
 * @param {string} code - machine reason.
 * @param {string} message - human reason.
 * @param {Record<string, unknown>} [details] - structured context.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the failure envelope.
 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

export default { createOps, VERSION, redactEnv }
