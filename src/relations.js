/**
 * The container ↔ image / volume / network relation graph.
 *
 * The Docker tab shows each resource on its own; this module answers the
 * question that needs all of them at once — "which container runs which image,
 * mounts which volumes, and sits on which networks?" — so the panel can render a
 * dedicated relations page instead of asking the user to join lists in their
 * head.
 *
 * ## Cost
 *
 * One `docker ps`, one inspect per container (for mounts, networks and the image
 * id), plus the image / volume / network lists. The ops layer caches the result
 * for a few seconds and invalidates it on every Docker mutation.
 *
 * ## Tolerant joins
 *
 * Docker's serialized shapes change between versions and a container may vanish
 * between `ps` and `inspect`. Every join degrades instead of throwing: a missing
 * inspect leaves the container row without mounts/networks, and an image id that
 * does not resolve to a listed image simply produces an empty `containers` list
 * on the image side (the container keeps its image tag for display).
 *
 * @module dsh-long-data/src/relations
 */

import { classifyRole, composeProject } from './roles.js'

/** A Docker volume name that is really an anonymous id. */
const ANONYMOUS_VOLUME_PATTERN = /^[0-9a-f]{64}$/u

/**
 * @param {unknown} value - a candidate.
 * @returns {value is Record<string, any>} whether it is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize an image reference to the bare sha256 hex used for joins.
 *
 * @param {unknown} value - an image id or reference.
 * @returns {string} the bare hex id, or '' when it is not an image id.
 */
export function normalizeImageId(value) {
  if (typeof value !== 'string') return ''
  const bare = value.replace(/^sha256:/u, '').trim().toLowerCase()
  return /^[0-9a-f]{12,64}$/u.test(bare) ? bare : ''
}

/**
 * @param {{ id?: unknown, shortId?: unknown }} image - an image row.
 * @returns {string} the bare hex id used for joins.
 */
function imageKey(image) {
  return normalizeImageId(image?.id) || normalizeImageId(image?.shortId)
}

/**
 * @param {unknown} mount - one inspect mount entry.
 * @returns {'volume'|'bind'|'tmpfs'|'other'} the mount kind.
 */
export function mountType(mount) {
  if (!isRecord(mount)) return 'other'
  const type = typeof mount.type === 'string' ? mount.type.toLowerCase() : ''
  if (type === 'volume' || type === 'bind' || type === 'tmpfs') return type
  // Older shapes: a named source without a path is almost certainly a volume.
  const source = typeof mount.source === 'string' ? mount.source : ''
  if (source === '') return 'other'
  return source.startsWith('/') || source.startsWith('~') ? 'bind' : 'volume'
}

/**
 * @param {unknown} mount - one inspect mount entry.
 * @param {'volume'|'bind'|'tmpfs'|'other'} type - its kind.
 * @returns {string|null} the volume name when there is one.
 */
function mountName(mount, type) {
  if (!isRecord(mount)) return null
  if (typeof mount.name === 'string' && mount.name !== '') return mount.name
  if (type === 'volume' && typeof mount.source === 'string') return mount.source
  return null
}

/**
 * Build the relation graph from the live Docker inventory.
 *
 * @param {object} dockerService - a `createDockerService` instance.
 * @returns {Promise<object>} the relations payload.
 */
export async function buildRelations(dockerService) {
  const [containers, images, volumes, networks] = await Promise.all([
    dockerService.listContainers(),
    dockerService.listImages(),
    dockerService.listVolumes(),
    dockerService.listNetworks(),
  ])

  const details = await Promise.all(containers.map(async (container) => {
    try {
      return await dockerService.inspectContainer(container.id)
    } catch {
      return null
    }
  }))

  /** @type {object[]} */
  const containerRows = containers.map((container, index) => {
    const detail = isRecord(details[index]) ? details[index] : {}
    const mounts = Array.isArray(detail.mounts) ? detail.mounts : []
    const attachedNetworks = Array.isArray(detail.networks) ? detail.networks : []
    const ports = Array.isArray(container.ports) ? container.ports : Array.isArray(detail.ports) ? detail.ports : []
    const labels = isRecord(detail.labels) ? detail.labels : {}
    const compose = composeProject(labels)
    return {
      id: String(container.id ?? ''),
      name: String(container.name ?? ''),
      state: String(container.state ?? ''),
      image: String(container.image ?? ''),
      imageId: normalizeImageId(detail.imageId) || null,
      role: classifyRole({ image: container.image, name: container.name, ports, labels }),
      project: compose.project,
      service: compose.service,
      restartPolicy: typeof detail.restartPolicy === 'string' && detail.restartPolicy !== '' ? detail.restartPolicy : null,
      createdAt: String(detail.createdAt ?? container.createdAt ?? ''),
      ports,
      volumes: mounts.map((mount) => {
        const type = mountType(mount)
        return {
          type,
          name: mountName(mount, type),
          source: isRecord(mount) && typeof mount.source === 'string' ? mount.source : '',
          destination: isRecord(mount) && typeof mount.destination === 'string' ? mount.destination : '',
          mode: isRecord(mount) && typeof mount.mode === 'string' ? mount.mode : '',
          rw: isRecord(mount) ? mount.rw !== false : true,
        }
      }),
      networks: attachedNetworks.map((network) => ({
        name: String(network?.name ?? ''),
        ipAddress: typeof network?.ipAddress === 'string' && network.ipAddress !== '' ? network.ipAddress : null,
      })),
    }
  })

  /** @type {Map<string, string[]>} bare image id -> container names */
  const containersByImage = new Map()
  /** @type {Map<string, string[]>} image reference -> container names */
  const containersByTag = new Map()
  for (const row of containerRows) {
    if (row.imageId !== null) {
      const list = containersByImage.get(row.imageId) ?? []
      list.push(row.name)
      containersByImage.set(row.imageId, list)
    }
    const list = containersByTag.get(row.image) ?? []
    list.push(row.name)
    containersByTag.set(row.image, list)
  }

  /** @type {Map<string, string[]>} volume name -> container names */
  const containersByVolume = new Map()
  /** @type {Map<string, string[]>} network name -> container names */
  const containersByNetwork = new Map()
  for (const row of containerRows) {
    for (const volume of row.volumes) {
      if (volume.type !== 'volume' || volume.name === null) continue
      const list = containersByVolume.get(volume.name) ?? []
      list.push(row.name)
      containersByVolume.set(volume.name, list)
    }
    for (const network of row.networks) {
      const list = containersByNetwork.get(network.name) ?? []
      list.push(row.name)
      containersByNetwork.set(network.name, list)
    }
  }

  const imageRows = images.map((image) => {
    const key = imageKey(image)
    const names = new Set(containersByImage.get(key) ?? [])
    for (const tag of Array.isArray(image.repoTags) ? image.repoTags : []) {
      for (const name of containersByTag.get(tag) ?? []) names.add(name)
    }
    return {
      id: String(image.id ?? ''),
      shortId: String(image.shortId ?? ''),
      repoTags: Array.isArray(image.repoTags) ? image.repoTags : [],
      size: String(image.size ?? ''),
      sizeBytes: Number.isFinite(image.sizeBytes) ? image.sizeBytes : 0,
      containers: [...names].sort(),
    }
  })

  const volumeRows = volumes.map((volume) => {
    const name = String(volume.name ?? '')
    const labels = isRecord(volume.labels) ? volume.labels : {}
    return {
      name,
      driver: String(volume.driver ?? ''),
      scope: String(volume.scope ?? ''),
      mountpoint: typeof volume.mountpoint === 'string' ? volume.mountpoint : null,
      anonymous: Object.hasOwn(labels, 'com.docker.volume.anonymous') || ANONYMOUS_VOLUME_PATTERN.test(name),
      containers: [...(containersByVolume.get(name) ?? [])].sort(),
    }
  })

  const networkRows = networks.map((network) => {
    const name = String(network.name ?? '')
    return {
      id: String(network.id ?? ''),
      name,
      driver: String(network.driver ?? ''),
      scope: String(network.scope ?? ''),
      internal: network.internal === true,
      containers: [...(containersByNetwork.get(name) ?? [])].sort(),
    }
  })

  return {
    summary: {
      containers: containerRows.length,
      running: containerRows.filter((row) => row.state === 'running').length,
      images: imageRows.length,
      volumes: volumeRows.length,
      networks: networkRows.length,
      danglingImages: imageRows.filter((image) => image.repoTags.length === 0).length,
      unusedVolumes: volumeRows.filter((volume) => volume.containers.length === 0).length,
    },
    containers: containerRows,
    images: imageRows,
    volumes: volumeRows,
    networks: networkRows,
  }
}

export default { buildRelations, normalizeImageId, mountType }
