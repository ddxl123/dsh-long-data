/**
 * Docker inspection and control through the local `docker` CLI.
 *
 * The panel and the agent tools share one service; wrapping the CLI instead of
 * the Engine API means the operator's existing context, Desktop port
 * forwarding and group memberships all apply unchanged, and a missing CLI is a
 * clean `docker_unavailable` answer rather than a socket error nobody can act
 * on.
 *
 * Two boundaries are enforced here on purpose:
 *
 *   - a container id, image reference, volume name or network name is checked
 *     against Docker's own grammar before it can reach argv, so a caller can
 *     never smuggle a `--flag` into the command;
 *   - every child is spawned with an argument array (no shell), killed at the
 *     deadline, and its output is capped, so a hung daemon or a large listing
 *     can neither stall the panel nor exhaust memory.
 *
 * The service covers the whole host: containers (list, inspect, logs, stats,
 * start/stop/…), images, volumes, networks and the daemon's disk usage. Listing
 * and removal methods are separate, and a removal is only ever commandeered by
 * an explicit caller request.
 *
 * ## GUI-app Hosts
 *
 * When the Host process is a macOS GUI app its PATH may omit `/usr/local/bin`
 * or Homebrew, so a bare `docker` spawn fails with ENOENT even though Docker
 * Desktop is installed. The first such failure makes the service look for the
 * CLI at the usual app locations, use the first one that exists and cache it
 * for the rest of the process.
 *
 * @module dsh-long-data/docker
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

import { DataError } from './errors.js'

/** Container actions the panel may request; `remove` is the wire name for `docker rm`. */
export const DOCKER_ACTIONS = Object.freeze(['start', 'stop', 'restart', 'pause', 'unpause', 'remove'])

/** Docker's container-id grammar: one alphanumeric character, then up to 127 safe ones. */
const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** `docker logs` is capped at 512 KiB: the panel renders a tail, not the history. */
const MAX_LOG_BYTES = 512 * 1024

/** Every other command is capped at 4 MiB (`docker inspect` can carry megabytes of env). */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** `docker logs` stderr (a container's STDERR) is kept, but bounded separately. */
const MAX_STDERR_BYTES = 256 * 1024

/** Upper bound Docker accepts for `--tail`. */
const MAX_LOG_TAIL = 5000

/** Default `docker logs --tail` value. */
const DEFAULT_LOG_TAIL = 200

/** Conservative image reference grammar; the first character may not be a dash. */
const IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,254}$/u

/** Volume and network names share Docker's naming grammar. */
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u

/** Docker CLI locations a GUI-app Host can have on disk while PATH omits them. */
const GUI_DOCKER_CANDIDATES = Object.freeze([
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
])

/** Human duration units, largest first. */
const DURATION_UNITS = Object.freeze([
  [31_536_000, 'year'],
  [2_592_000, 'month'],
  [604_800, 'week'],
  [86_400, 'day'],
  [3_600, 'hour'],
  [60, 'minute'],
])

/** Docker human-readable size suffixes, including both SI and IEC names. */
const SIZE_UNITS = Object.freeze({
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
  PIB: 1024 ** 5,
})

/**
 * @param {unknown} value - a candidate.
 * @returns {value is Record<string, any>} whether it is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} error - a thrown value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} value - a candidate.
 * @returns {string} the string value, or the empty string.
 */
function textValue(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * @param {unknown} value - a candidate.
 * @returns {string | null} the non-empty trimmed string, or null.
 */
function textOrNull(value) {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value.trim()
}

/**
 * @param {unknown} value - a candidate.
 * @returns {string[]} only the string entries.
 */
function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string')
}

/**
 * Validate a container reference before it may become an argv element.
 *
 * @param {unknown} value - the caller's id or name.
 * @returns {string} the trimmed id.
 * @throws {DataError} `docker_invalid_id` when it is not a legal Docker reference.
 */
function assertContainerId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!CONTAINER_ID_PATTERN.test(id)) {
    throw new DataError('docker_invalid_id', `invalid container id ${JSON.stringify(typeof value === 'string' ? value : String(value))}`, {
      id: typeof value === 'string' ? value : String(value),
    })
  }
  return id
}

/**
 * Validate an image reference before it may become an argv element.
 *
 * @param {unknown} value - the caller's image id or `repository:tag`.
 * @returns {string} the trimmed reference.
 * @throws {DataError} `docker_invalid_image` when it is not a legal image reference.
 */
function assertImageReference(value) {
  const reference = typeof value === 'string' ? value.trim() : ''
  if (!IMAGE_REFERENCE_PATTERN.test(reference)) {
    throw new DataError('docker_invalid_image', `invalid image reference ${JSON.stringify(typeof value === 'string' ? value : String(value))}`, {
      id: typeof value === 'string' ? value : String(value),
    })
  }
  return reference
}

/**
 * Validate a volume name before it may become an argv element.
 *
 * @param {unknown} value - the caller's volume name.
 * @returns {string} the trimmed name.
 * @throws {DataError} `docker_invalid_volume` when it is not a legal volume name.
 */
function assertVolumeName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    throw new DataError('docker_invalid_volume', `invalid volume name ${JSON.stringify(typeof value === 'string' ? value : String(value))}`, {
      name: typeof value === 'string' ? value : String(value),
    })
  }
  return name
}

/**
 * Validate a network name before it may become an argv element.
 *
 * @param {unknown} value - the caller's network name.
 * @returns {string} the trimmed name.
 * @throws {DataError} `docker_invalid_network` when it is not a legal network name.
 */
function assertNetworkName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    throw new DataError('docker_invalid_network', `invalid network name ${JSON.stringify(typeof value === 'string' ? value : String(value))}`, {
      name: typeof value === 'string' ? value : String(value),
    })
  }
  return name
}

/**
 * @param {string} text - a raw JSON string.
 * @returns {unknown} the parsed value, or undefined.
 */
function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Parse commands that emit one JSON object per line (`docker ps --format
 * '{{json .}}'`). A JSON array body is accepted too, since Docker has changed
 * that shape between releases.
 *
 * @param {string} text - the command's stdout.
 * @param {string} command - the docker subcommand, for the error message.
 * @returns {Record<string, any>[]} the records.
 * @throws {DataError} `docker_failed` when a line is not JSON.
 */
function parseJsonLines(text, command) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return []
  const whole = tryParseJson(trimmed)
  if (Array.isArray(whole)) return whole.filter(isRecord)
  if (isRecord(whole)) return [whole]
  const records = []
  for (const line of trimmed.split(/\r?\n/u)) {
    const entry = line.trim()
    if (entry === '') continue
    const parsed = tryParseJson(entry)
    if (!isRecord(parsed)) {
      throw new DataError('docker_failed', `could not parse docker ${command} output`, {
        stderr: '',
        line: entry.slice(0, 500),
      })
    }
    records.push(parsed)
  }
  return records
}

/**
 * Extract every top-level JSON object from a stream that may contain several
 * concatenated values (some Docker releases emit `docker stats` that way).
 *
 * @param {string} text - raw output.
 * @returns {Record<string, any>[]} the objects that parsed.
 */
function scanJsonObjects(text) {
  const records = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (character !== '}') continue
    depth -= 1
    if (depth !== 0 || start === -1) continue
    const record = tryParseJson(text.slice(start, index + 1))
    if (isRecord(record)) records.push(record)
    start = -1
  }
  return records
}

/**
 * Parse `docker stats --format '{{json .}}'`, accepting either a JSON array
 * (older CLIs), one object per line, or concatenated objects (newer CLIs).
 *
 * @param {string} text - the command's stdout.
 * @returns {Record<string, any>[]} the stats rows.
 */
function parseStatsOutput(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return []
  const whole = tryParseJson(trimmed)
  if (Array.isArray(whole)) return whole.filter(isRecord)
  if (isRecord(whole)) return [whole]
  const records = []
  let unparsed = false
  for (const line of trimmed.split(/\r?\n/u)) {
    const entry = line.trim()
    if (entry === '') continue
    const parsed = tryParseJson(entry)
    if (Array.isArray(parsed)) records.push(...parsed.filter(isRecord))
    else if (isRecord(parsed)) records.push(parsed)
    else unparsed = true
  }
  return unparsed ? scanJsonObjects(trimmed) : records
}

/**
 * @param {string} text - a percentage such as `1.25%`.
 * @returns {number} the numeric percentage (0 when unparsable).
 */
function parsePercent(text) {
  const value = Number.parseFloat(String(text ?? '').replace('%', ''))
  return Number.isFinite(value) ? value : 0
}

/**
 * @param {unknown} text - a Docker size such as `695.4MiB`.
 * @returns {number} the size in bytes (0 when unparsable).
 */
function parseSize(text) {
  const match = /([\d.]+)\s*([kmgtp]?i?b)/iu.exec(String(text ?? ''))
  if (match === null) return 0
  const amount = Number(match[1])
  const unit = SIZE_UNITS[match[2].toUpperCase()]
  if (!Number.isFinite(amount) || !Number.isFinite(unit)) return 0
  return Math.round(amount * unit)
}

/**
 * Split `usage / limit` style values (`MemUsage`, `NetIO`, `BlockIO`).
 *
 * @param {unknown} text - the Docker cell.
 * @returns {[number, number]} both sizes in bytes.
 */
function parseSizePair(text) {
  const [usage = '', limit = ''] = String(text ?? '').split('/')
  return [parseSize(usage), parseSize(limit)]
}

/**
 * @param {string} text - a duration in seconds.
 * @returns {string} a terse human duration such as `2 hours`.
 */
function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'a while'
  if (seconds < 60) return 'Less than a minute'
  for (const [size, label] of DURATION_UNITS) {
    if (seconds < size) continue
    const count = Math.floor(seconds / size)
    return `${count} ${label}${count === 1 ? '' : 's'}`
  }
  return 'Less than a minute'
}

/**
 * @param {string | null} value - an inspect timestamp.
 * @returns {string | null} the timestamp, or null for Docker's zero value.
 */
function isoOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.startsWith('0001-01-01') ? null : value
}

/**
 * Parse one `docker ps` Ports cell into the contract's port entries.
 *
 * @param {unknown} value - e.g. `0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp`.
 * @returns {{ host: string | null, container: string, protocol: string, ip: string | null }[]} ports.
 */
function parsePorts(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(parsePortEntry)
}

/**
 * @param {string} entry - one port mapping.
 * @returns {{ host: string | null, container: string, protocol: string, ip: string | null }} the mapping.
 */
function parsePortEntry(entry) {
  const arrow = entry.indexOf('->')
  const published = arrow === -1 ? null : entry.slice(0, arrow).trim()
  const target = (arrow === -1 ? entry : entry.slice(arrow + 2)).trim()
  const slash = target.lastIndexOf('/')
  const container = slash === -1 ? target : target.slice(0, slash)
  const protocol = slash === -1 ? 'tcp' : target.slice(slash + 1)
  if (published === null) return { host: null, container, protocol, ip: null }
  let ip = null
  let host = null
  if (published.startsWith('[')) {
    const end = published.indexOf(']')
    if (end !== -1) {
      ip = published.slice(1, end)
      const rest = published.slice(end + 1)
      host = rest.startsWith(':') ? rest.slice(1) || null : null
    }
  } else {
    const colon = published.lastIndexOf(':')
    if (colon === -1) {
      host = published === '' ? null : published
    } else {
      ip = published.slice(0, colon) || null
      host = published.slice(colon + 1) || null
    }
  }
  return { host, container, protocol, ip }
}

/**
 * Docker wraps some `Command` cells in quotes; strip them for display.
 *
 * @param {unknown} value - a `docker ps` Command cell.
 * @returns {string} the command.
 */
function normalizeCommand(value) {
  let text = textValue(value).trim()
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\"/gu, '"')
  }
  return text
}

/**
 * Map one `docker ps` JSON row to the contract's container shape.
 *
 * @param {Record<string, any>} record - a ps row.
 * @returns {object} the container.
 */
function toContainer(record) {
  const id = textValue(record.ID)
  return {
    id,
    shortId: id.slice(0, 12),
    name: textValue(record.Names),
    image: textValue(record.Image),
    // Compose project/service and maintainer labels are how the panel groups
    // containers into projects, so they belong on the list row.
    labels: parseLabels(record.Labels),
    command: normalizeCommand(record.Command),
    state: textValue(record.State).toLowerCase(),
    status: textValue(record.Status),
    ports: parsePorts(record.Ports),
    createdAt: textValue(record.CreatedAt),
    runningFor: textValue(record.RunningFor),
  }
}

/**
 * Parse `Config.Env` (`["K=V", ...]`) into pairs, splitting on the first `=`.
 *
 * @param {unknown} value - the env array.
 * @returns {{ key: string, value: string }[]} the pairs.
 */
function parseEnv(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => {
      const index = entry.indexOf('=')
      return index === -1
        ? { key: entry, value: '' }
        : { key: entry.slice(0, index), value: entry.slice(index + 1) }
    })
}

/**
 * @param {unknown} value - inspect's `Mounts`.
 * @returns {{ type: string, name: string, source: string, destination: string, mode: string, rw: boolean }[]} the mounts.
 */
function parseMounts(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((mount) => ({
    // Docker reports the mount kind explicitly; a path alone cannot tell a named
    // volume from a bind mount, and the relations page must tell them apart.
    type: textValue(mount.Type),
    name: textValue(mount.Name),
    source: textValue(mount.Source),
    destination: textValue(mount.Destination),
    mode: textValue(mount.Mode),
    rw: mount.RW === true,
  }))
}

/**
 * @param {unknown} value - inspect's `NetworkSettings`.
 * @returns {{ name: string, ipAddress: string | null }[]} the attached networks.
 */
function parseNetworks(value) {
  const settings = isRecord(value) ? value : {}
  const networks = isRecord(settings.Networks) ? settings.Networks : {}
  return Object.entries(networks).map(([name, network]) => ({
    name,
    ipAddress: isRecord(network) ? textOrNull(network.IPAddress) : null,
  }))
}

/**
 * Parse Docker's `k=v,k2=v2` label encoding — the `Labels` cell of
 * `docker ps --format '{{json .}}'` and of `docker volume ls` — into the
 * contract's record. The value may itself contain `=` (split on the first one);
 * a pair without any `=` is malformed and ignored.
 *
 * @param {unknown} value - the label cell.
 * @returns {Record<string, string>} the labels.
 */
function parseLabels(value) {
  /** @type {Record<string, string>} */
  const labels = {}
  if (typeof value !== 'string' || value === '' || value === 'N/A') return labels
  for (const pair of value.split(',')) {
    const entry = pair.trim()
    if (entry === '') continue
    const index = entry.indexOf('=')
    if (index === -1) continue
    labels[entry.slice(0, index)] = entry.slice(index + 1)
  }
  return labels
}

/**
 * Parse inspect's label object (`Record<string, string>`).
 *
 * @param {unknown} value - inspect's `Labels`.
 * @returns {Record<string, string>} the labels.
 */
function parseLabelsObject(value) {
  /** @type {Record<string, string>} */
  const labels = {}
  if (!isRecord(value)) return labels
  for (const [key, entry] of Object.entries(value)) labels[key] = textValue(entry)
  return labels
}

/**
 * @param {unknown} value - a Docker boolean cell (`"true"` / `"false"`).
 * @returns {boolean} the flag.
 */
function parseFlag(value) {
  if (value === true) return true
  if (value === false) return false
  const text = textValue(value).trim().toLowerCase()
  return text === 'true' || text === '1'
}

/**
 * @param {unknown} value - an image id cell, optionally carrying a `sha256:` prefix.
 * @returns {string} the bare id.
 */
function normalizeImageId(value) {
  return textValue(value).trim().replace(/^sha256:/iu, '')
}

/**
 * @param {unknown} value - a repository/tag cell.
 * @returns {string} the cell, or the empty string for Docker's `<none>` marker.
 */
function normalizeImagePart(value) {
  const text = textValue(value).trim()
  return text === '<none>' ? '' : text
}

/**
 * Map one `docker images` JSON row to the contract's image shape.
 *
 * @param {Record<string, any>} record - an images row.
 * @returns {object} the image.
 */
function toImage(record) {
  const id = normalizeImageId(record.ID)
  const repository = normalizeImagePart(record.Repository)
  const tag = normalizeImagePart(record.Tag)
  const repoTags = repository === ''
    ? []
    : [tag === '' ? repository : `${repository}:${tag}`]
  const containers = Number.parseInt(textValue(record.Containers), 10)
  const size = textValue(record.Size)
  return {
    id,
    shortId: id.slice(0, 12),
    repoTags,
    repository,
    tag,
    size,
    sizeBytes: parseSize(size),
    created: textValue(record.CreatedAt),
    createdSince: textValue(record.CreatedSince),
    containers: Number.isInteger(containers) ? containers : null,
  }
}

/**
 * Render a byte count the way `docker images` prints sizes: SI units with up to
 * four significant digits (`62.17MB`, `1.07GB`, `0B`).
 *
 * @param {number} bytes - the byte count.
 * @returns {string} the human size.
 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)}B`
  return `${Number.parseFloat(value.toPrecision(4))}${units[unit]}`
}

/**
 * Normalize `docker image inspect` RepoTags: Docker's `<none>` marker becomes
 * the empty string, and empty entries drop out so a dangling image has `[]`.
 *
 * @param {unknown} value - inspect's `RepoTags`.
 * @returns {string[]} the tag list.
 */
function normalizeRepoTags(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((tag) => typeof tag === 'string')
    .map((tag) => (tag === '<none>' || tag === '<none>:<none>' ? '' : tag))
    .filter((tag) => tag !== '')
}

/**
 * Map one `docker image inspect` document to the contract's image-detail shape.
 *
 * @param {Record<string, any>} record - the image inspect object.
 * @returns {object} the image detail.
 */
function toImageDetail(record) {
  const config = isRecord(record.Config) ? record.Config : {}
  const id = normalizeImageId(record.Id)
  const sizeBytes = Number.parseInt(textValue(record.Size), 10)
  const containers = Number.isInteger(record.Containers) ? record.Containers : null
  return {
    id,
    shortId: id.slice(0, 12),
    repoTags: normalizeRepoTags(record.RepoTags),
    size: formatSize(Number.isInteger(sizeBytes) ? sizeBytes : 0),
    sizeBytes: Number.isInteger(sizeBytes) ? sizeBytes : 0,
    created: textValue(record.Created),
    architecture: textValue(record.Architecture),
    os: textValue(record.Os),
    cmd: stringArray(config.Cmd).join(' '),
    entrypoint: stringArray(config.Entrypoint).join(' '),
    env: parseEnv(config.Env),
    labels: parseLabelsObject(config.Labels),
    exposedPorts: isRecord(config.ExposedPorts) ? Object.keys(config.ExposedPorts) : [],
    containers,
  }
}

/**
 * Map one `docker volume inspect` document to the contract's volume-detail shape.
 *
 * @param {Record<string, any>} record - the volume inspect object.
 * @param {string} requestedName - the name the caller asked for, used as a fallback.
 * @returns {object} the volume detail.
 */
function toVolumeDetail(record, requestedName) {
  const name = textValue(record.Name) === '' ? requestedName : textValue(record.Name)
  const labels = parseLabelsObject(record.Labels)
  return {
    name,
    driver: textValue(record.Driver),
    scope: textValue(record.Scope),
    mountpoint: textOrNull(record.Mountpoint),
    created: textOrNull(record.CreatedAt),
    labels,
    options: parseLabelsObject(record.Options),
    // Docker marks an auto-created volume with this label; older listings only
    // show the generated 64-hex name, which is just as anonymous.
    anonymous: Object.hasOwn(labels, 'com.docker.volume.anonymous') || /^[a-f0-9]{64}$/iu.test(name),
  }
}

/**
 * Map one `docker network inspect` document to the contract's network-detail shape.
 *
 * @param {Record<string, any>} record - the network inspect object.
 * @returns {object} the network detail.
 */
function toNetworkDetail(record) {
  const id = textValue(record.Id).trim()
  const ipam = isRecord(record.IPAM) ? record.IPAM : {}
  const subnetConfig = Array.isArray(ipam.Config) ? ipam.Config : []
  const attached = isRecord(record.Containers) ? record.Containers : {}
  return {
    id,
    shortId: id.slice(0, 12),
    name: textValue(record.Name),
    driver: textValue(record.Driver),
    scope: textValue(record.Scope),
    internal: parseFlag(record.Internal),
    // `network inspect` calls the switch EnableIPv6; `network ls` calls it IPv6.
    ipv6: parseFlag(record.EnableIPv6),
    labels: parseLabelsObject(record.Labels),
    subnets: subnetConfig
      .filter(isRecord)
      .map((entry) => ({ subnet: textValue(entry.Subnet), gateway: textOrNull(entry.Gateway) }))
      .filter((entry) => entry.subnet !== ''),
    containers: Object.entries(attached).map(([containerId, container]) => ({
      id: containerId,
      name: isRecord(container) ? textValue(container.Name) : '',
      ipv4Address: isRecord(container) ? textOrNull(container.IPv4Address) : null,
      ipv6Address: isRecord(container) ? textOrNull(container.IPv6Address) : null,
    })),
  }
}

/**
 * Map one `docker volume ls` JSON row to the contract's volume shape. `created`
 * starts null because `volume ls` does not report it; {@link enrichVolumeRow}
 * fills it for the rows whose listing is incomplete.
 *
 * @param {Record<string, any>} record - a volume row.
 * @returns {object} the volume.
 */
function toVolume(record) {
  return {
    name: textValue(record.Name),
    driver: textValue(record.Driver),
    scope: textValue(record.Scope),
    mountpoint: textOrNull(record.Mountpoint),
    created: null,
    labels: parseLabels(record.Labels),
  }
}

/**
 * Map one `docker network ls` JSON row to the contract's network shape.
 *
 * @param {Record<string, any>} record - a network row.
 * @returns {object} the network.
 */
function toNetwork(record) {
  const id = textValue(record.ID).trim()
  return {
    id,
    shortId: id.slice(0, 12),
    name: textValue(record.Name),
    driver: textValue(record.Driver),
    scope: textValue(record.Scope),
    internal: parseFlag(record.Internal),
    ipv6: parseFlag(record.IPv6),
  }
}

/**
 * A zero-filled disk-usage row, used for a category `docker system df` omits.
 *
 * @returns {{ count: number, active: number | null, size: string, sizeBytes: number,
 *   reclaimable: string, reclaimableBytes: number }} the empty row.
 */
function emptyDiskRow() {
  return { count: 0, active: null, size: '', sizeBytes: 0, reclaimable: '', reclaimableBytes: 0 }
}

/**
 * Map one `docker system df --format '{{json .}}'` row to the contract's DiskRow.
 *
 * @param {Record<string, any>} record - a df row.
 * @returns {{ count: number, active: number | null, size: string, sizeBytes: number,
 *   reclaimable: string, reclaimableBytes: number }} the row.
 */
function toDiskRow(record) {
  const count = Number.parseInt(textValue(record.TotalCount), 10)
  const active = Number.parseInt(textValue(record.Active), 10)
  const size = textValue(record.Size)
  const reclaimable = textValue(record.Reclaimable)
  return {
    count: Number.isInteger(count) ? count : 0,
    active: Number.isInteger(active) ? active : null,
    size,
    sizeBytes: parseSize(size),
    reclaimable,
    reclaimableBytes: parseSize(reclaimable),
  }
}

/**
 * Map the `docker system df` rows onto the contract's four disk-usage categories.
 *
 * @param {Record<string, any>[]} records - df rows.
 * @returns {{ images: object, containers: object, volumes: object, buildCache: object }} the usage.
 */
function toDiskUsage(records) {
  const usage = {
    images: emptyDiskRow(),
    containers: emptyDiskRow(),
    volumes: emptyDiskRow(),
    buildCache: emptyDiskRow(),
  }
  for (const record of records) {
    const type = textValue(record.Type).trim().toLowerCase()
    if (type === 'images') usage.images = toDiskRow(record)
    else if (type === 'containers') usage.containers = toDiskRow(record)
    else if (type === 'local volumes' || type === 'volumes') usage.volumes = toDiskRow(record)
    else if (type === 'build cache' || type === 'buildcache') usage.buildCache = toDiskRow(record)
  }
  return usage
}

/**
 * Parse the first object of a `docker … inspect` JSON-array response.
 *
 * @param {string} stdout - the command's stdout.
 * @returns {Record<string, any> | undefined} the first record.
 */
function firstRecord(stdout) {
  const parsed = tryParseJson(String(stdout ?? '').trim())
  return Array.isArray(parsed) ? parsed.find(isRecord) : isRecord(parsed) ? parsed : undefined
}

/**
 * Collect the published ports from an inspect document.
 *
 * @param {Record<string, any>} record - the inspect object.
 * @returns {{ host: string | null, container: string, protocol: string, ip: string | null }[]} ports.
 */
function portsFromInspect(record) {
  const settings = isRecord(record.NetworkSettings) ? record.NetworkSettings : {}
  const hostConfig = isRecord(record.HostConfig) ? record.HostConfig : {}
  const networkPorts = isRecord(settings.Ports) ? settings.Ports : null
  const hostBindings = isRecord(hostConfig.PortBindings) ? hostConfig.PortBindings : null
  const bindings = networkPorts !== null && Object.keys(networkPorts).length > 0 ? networkPorts : hostBindings
  if (bindings === null) return []
  const ports = []
  for (const key of Object.keys(bindings)) {
    const slash = key.lastIndexOf('/')
    const container = slash === -1 ? key : key.slice(0, slash)
    const protocol = slash === -1 ? 'tcp' : key.slice(slash + 1)
    const list = Array.isArray(bindings[key]) ? bindings[key] : []
    if (list.length === 0) {
      ports.push({ host: null, container, protocol, ip: null })
      continue
    }
    for (const binding of list) {
      ports.push({
        host: isRecord(binding) ? textOrNull(binding.HostPort) : null,
        container,
        protocol,
        ip: isRecord(binding) ? textOrNull(binding.HostIp) : null,
      })
    }
  }
  return ports
}

/**
 * @param {string} state - the container state.
 * @param {string} runningFor - human age.
 * @param {string | null} health - health status.
 * @param {number | null} exitCode - last exit code.
 * @returns {string} human status text, in the style of `docker ps`.
 */
function describeStatus(state, runningFor, health, exitCode) {
  switch (state) {
    case 'running':
      return health === null ? `Up ${runningFor}` : `Up ${runningFor} (${health})`
    case 'paused':
      return `Up ${runningFor} (Paused)`
    case 'exited':
      return `Exited (${exitCode === null ? 0 : exitCode}) ${runningFor} ago`
    case 'created':
      return 'Created'
    case 'restarting':
      return 'Restarting'
    case 'dead':
      return 'Dead'
    case 'removing':
      return 'Removing'
    default:
      return state
  }
}

/**
 * Compute how long a container has been in its current state.
 *
 * @param {string} state - the container state.
 * @param {string | null} startedAt - inspect's start timestamp.
 * @param {string | null} finishedAt - inspect's finish timestamp.
 * @returns {string} human age.
 */
function humanRunningFor(state, startedAt, finishedAt) {
  const now = Date.now()
  const reference = state === 'running' || state === 'paused' ? startedAt : finishedAt
  if (reference === null) return 'a while'
  const at = Date.parse(reference)
  if (!Number.isFinite(at)) return 'a while'
  return humanDuration((now - at) / 1000)
}

/**
 * Map one `docker inspect` document to the contract's detail shape.
 *
 * @param {Record<string, any>} record - the inspect object.
 * @returns {object} the container detail.
 */
function toContainerDetail(record) {
  const state = isRecord(record.State) ? record.State : {}
  const config = isRecord(record.Config) ? record.Config : {}
  const hostConfig = isRecord(record.HostConfig) ? record.HostConfig : {}
  const restartPolicyConfig = isRecord(hostConfig.RestartPolicy) ? hostConfig.RestartPolicy : {}
  const id = textValue(record.Id)
  const entrypoint = stringArray(config.Entrypoint).join(' ')
  const cmd = stringArray(config.Cmd).join(' ')
  const stateName = textValue(state.Status).toLowerCase()
  const startedAt = isoOrNull(state.StartedAt)
  const finishedAt = isoOrNull(state.FinishedAt)
  const exitCode = Number.isInteger(state.ExitCode) ? state.ExitCode : null
  const health = isRecord(state.Health) && textOrNull(state.Health.Status) !== null ? textOrNull(state.Health.Status) : null
  const runningFor = humanRunningFor(stateName, startedAt, finishedAt)
  const logPath = textOrNull(record.LogPath)
  return {
    id,
    shortId: id.slice(0, 12),
    name: textValue(record.Name).replace(/^\//u, ''),
    image: textValue(config.Image),
    // The full sha256 the container was created from; bytes for bytes what
    // `docker image inspect` reports, so the relations graph can join on it.
    imageId: textOrNull(record.Image),
    command: [entrypoint, cmd].filter((part) => part !== '').join(' '),
    state: stateName,
    status: describeStatus(stateName, runningFor, health, exitCode),
    ports: portsFromInspect(record),
    createdAt: textValue(record.Created),
    runningFor,
    startedAt,
    finishedAt,
    restartCount: Number.isInteger(record.RestartCount) ? record.RestartCount : 0,
    // Docker always writes RestartPolicy.Name, using '' for the default "no".
    restartPolicy: textOrNull(restartPolicyConfig.Name),
    health,
    exitCode,
    labels: parseLabelsObject(config.Labels),
    env: parseEnv(config.Env),
    mounts: parseMounts(record.Mounts),
    networks: parseNetworks(record.NetworkSettings),
    platform: textValue(record.Platform),
    entrypoint,
    cmd,
    ...(logPath === null ? {} : { logPath }),
  }
}

/**
 * Map one `docker stats` JSON row to the contract's stat shape.
 *
 * @param {Record<string, any>} record - a stats row.
 * @returns {object} the stat.
 */
function toStat(record) {
  const row = isRecord(record) ? record : {}
  const [memoryUsage, memoryLimit] = parseSizePair(row.MemUsage)
  const [rxBytes, txBytes] = parseSizePair(row.NetIO)
  const [readBytes, writeBytes] = parseSizePair(row.BlockIO)
  return {
    id: textValue(row.Container) === '' ? textValue(row.ID) : textValue(row.Container),
    name: textValue(row.Name),
    cpuPercent: parsePercent(row.CPUPerc),
    memory: {
      usageBytes: memoryUsage,
      limitBytes: memoryLimit,
      percent: parsePercent(row.MemPerc),
    },
    netIO: { rxBytes, txBytes },
    blockIO: { readBytes, writeBytes },
    pids: Number.parseInt(textValue(row.PIDs), 10) || 0,
  }
}

/**
 * Merge `docker logs` stdout (container STDOUT) and stderr (container STDERR),
 * bounded to the documented cap.
 *
 * @param {string} stdout - container stdout.
 * @param {string} stderr - container stderr.
 * @returns {string} the combined log text.
 */
function combineLogs(stdout, stderr) {
  if (stderr === '') return stdout.slice(0, MAX_LOG_BYTES)
  if (stdout === '') return stderr.slice(0, MAX_LOG_BYTES)
  const joined = `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`
  return joined.slice(0, MAX_LOG_BYTES)
}

/**
 * Create the Docker service for one configuration.
 *
 * @param {object} [options] - service options.
 * @param {string} [options.binary='docker'] - docker executable (PATH name or absolute path).
 * @param {number} [options.timeoutMs=20000] - per-command deadline.
 * @param {typeof import('node:child_process').spawn} [options.spawnProcess] - child-process factory (injectable for tests).
 * @returns {{ version: () => Promise<object>, listContainers: () => Promise<object[]>,
 *   inspectContainer: (id: string) => Promise<object>, logs: (id: string, options?: { tail?: number }) => Promise<object>,
 *   stats: () => Promise<object[]>, action: (id: string, action: string) => Promise<object>,
 *   listImages: () => Promise<object[]>, removeImage: (id: string, options?: { force?: boolean }) => Promise<object>,
 *   listVolumes: () => Promise<object[]>, removeVolume: (name: string, options?: { force?: boolean }) => Promise<object>,
 *   listNetworks: () => Promise<object[]>, removeNetwork: (name: string) => Promise<object>,
 *   inspectImage: (id: string) => Promise<object>, inspectVolume: (name: string) => Promise<object>,
 *   inspectNetwork: (name: string) => Promise<object>,
 *   diskUsage: () => Promise<object> }} the service.
 */
export function createDockerService({ binary = 'docker', timeoutMs = 20_000, spawnProcess } = {}) {
  const configuredExecutable = typeof binary === 'string' && binary.trim() !== '' ? binary.trim() : 'docker'
  /** The executable actually spawned; replaced once when a bare PATH name cannot be found. */
  let resolvedExecutable = configuredExecutable
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 20_000
  const spawnFn = typeof spawnProcess === 'function' ? spawnProcess : spawn

  /**
   * The docker executables a GUI-app Host may have even when PATH omits them.
   *
   * @returns {string[]} absolute candidates, most preferred first.
   */
  function guiDockerCandidates() {
    return [...GUI_DOCKER_CANDIDATES, `${homedir()}/.docker/bin/docker`]
  }

  /**
   * Find the first installed GUI-app docker after the bare PATH name failed.
   *
   * @returns {string | null} the executable to retry with, or null when none exists.
   */
  function resolveGuiDocker() {
    if (configuredExecutable.includes('/')) return null
    for (const candidate of guiDockerCandidates()) {
      if (candidate === resolvedExecutable) continue
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  /**
   * Run one docker subcommand with a deadline and bounded output.
   *
   * @param {string} target - the executable to spawn.
   * @param {string[]} args - argv, passed to the child without a shell.
   * @param {number} [maxBytes] - stdout cap.
   * @param {number} [timeout] - deadline override (used by the version fallback).
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>} the output.
   * @throws {DataError} `docker_unavailable` (ENOENT), `docker_timeout`, `docker_failed`.
   */
  function runOnce(target, args, maxBytes = MAX_OUTPUT_BYTES, timeout = deadline) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawnFn(target, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        reject(new DataError('docker_failed', `could not run ${target}: ${messageOf(error)}`))
        return
      }
      let settled = false
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      const finish = (operation) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        operation()
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        if (stdoutBytes >= maxBytes) return
        const text = String(chunk)
        const remaining = maxBytes - stdoutBytes
        stdout += text.length > remaining ? text.slice(0, remaining) : text
        stdoutBytes += Math.min(text.length, remaining)
      })
      child.stderr?.on('data', (chunk) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return
        const text = String(chunk)
        const remaining = MAX_STDERR_BYTES - stderrBytes
        stderr += text.length > remaining ? text.slice(0, remaining) : text
        stderrBytes += Math.min(text.length, remaining)
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone; the rejection below is still the answer.
        }
        finish(() => {
          reject(new DataError('docker_timeout', `docker ${args[0] ?? 'command'} timed out after ${timeout} ms`, {
            timeoutMs: timeout,
            command: args[0] ?? null,
          }))
        })
      }, timeout)
      child.on('error', (error) => {
        finish(() => {
          const code = isRecord(error) ? error.code : undefined
          if (code === 'ENOENT') {
            reject(new DataError('docker_unavailable', `the docker CLI was not found: ${target}`, { binary: target }))
            return
          }
          reject(new DataError('docker_failed', `could not run ${target}: ${messageOf(error)}`, { stderr: '' }))
        })
      })
      child.on('close', (code) => {
        finish(() => {
          if (code !== 0) {
            const detail = stderr.trim()
            const firstLine = (detail.split(/\r?\n/u)[0] ?? '').trim()
            const message = firstLine === ''
              ? `docker ${args[0] ?? 'command'} failed with exit code ${code === null ? 'unknown' : code}`
              : firstLine.slice(0, 500)
            reject(new DataError('docker_failed', message, { stderr: detail }))
            return
          }
          resolve({ stdout, stderr, code: code === null ? 0 : code })
        })
      })
    })
  }

  /**
   * Run one docker subcommand, resolving the executable first when the Host is
   * a GUI app whose PATH has no docker.
   *
   * A bare PATH name that fails with ENOENT is retried once with the first
   * existing GUI-app docker and that path is cached for later calls. An
   * absolute configured path is never second-guessed.
   *
   * @param {string[]} args - argv, passed to the child without a shell.
   * @param {number} [maxBytes] - stdout cap.
   * @param {number} [timeout] - deadline override (used by the version fallback).
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>} the output.
   * @throws {DataError} `docker_unavailable`, `docker_timeout`, `docker_failed`.
   */
  async function run(args, maxBytes = MAX_OUTPUT_BYTES, timeout = deadline) {
    try {
      return await runOnce(resolvedExecutable, args, maxBytes, timeout)
    } catch (failure) {
      if (!(failure instanceof DataError) || failure.code !== 'docker_unavailable') throw failure
      if (resolvedExecutable.includes('/')) throw failure
      const fallback = resolveGuiDocker()
      if (fallback === null) throw failure
      resolvedExecutable = fallback
      return runOnce(fallback, args, maxBytes, timeout)
    }
  }

  /**
   * Ask the CLI and the daemon for their versions. Never throws: the panel's
   * state endpoint calls this on every repaint and a dead daemon is a normal
   * answer there, not a crash.
   *
   * @returns {Promise<{ available: boolean, binary: string, clientVersion: string | null,
   *   serverVersion: string | null, error: string | null }>} the version report.
   */
  async function version() {
    try {
      const { stdout } = await run(['version', '--format', '{{json .}}'])
      const parsed = tryParseJson(stdout.trim())
      if (!isRecord(parsed)) {
        throw new DataError('docker_failed', 'docker version returned unreadable output', { stderr: '' })
      }
      const client = isRecord(parsed.Client) ? parsed.Client : {}
      const server = isRecord(parsed.Server) ? parsed.Server : {}
      return {
        available: true,
        binary: resolvedExecutable,
        clientVersion: textOrNull(client.Version),
        serverVersion: textOrNull(server.Version),
        error: null,
      }
    } catch (failure) {
      let clientVersion = null
      try {
        const { stdout } = await run(['--version'], MAX_OUTPUT_BYTES, Math.min(deadline, 5_000))
        const match = /version\s+([^\s,]+)/iu.exec(stdout)
        clientVersion = match === null ? null : match[1]
      } catch {
        // The CLI itself is unusable; the first failure is the useful one.
      }
      return {
        available: false,
        binary: resolvedExecutable,
        clientVersion,
        serverVersion: null,
        error: messageOf(failure),
      }
    }
  }

  /**
   * @returns {Promise<object[]>} every container (running and stopped) in the contract's shape.
   */
  async function listContainers() {
    const { stdout } = await run(['ps', '-a', '--no-trunc', '--format', '{{json .}}'])
    return parseJsonLines(stdout, 'ps').map(toContainer)
  }

  /**
   * @param {string} id - container id or name.
   * @returns {Promise<object>} the container detail.
   * @throws {DataError} `docker_invalid_id` before spawning, or a docker failure.
   */
  async function inspectContainer(id) {
    const containerId = assertContainerId(id)
    const { stdout } = await run(['inspect', containerId])
    const record = firstRecord(stdout)
    if (record === undefined) {
      throw new DataError('docker_failed', `docker inspect returned nothing for ${containerId}`, { stderr: '' })
    }
    return toContainerDetail(record)
  }

  /**
   * Read a container's log tail (stdout and stderr merged, bounded to 512 KiB).
   *
   * @param {string} id - container id or name.
   * @param {{ tail?: number }} [options] - tail length, default 200, capped at 5000.
   * @returns {Promise<{ id: string, name: string, logs: string }>} the log tail.
   * @throws {DataError} `docker_invalid_id` before spawning, or a docker failure.
   */
  async function logs(id, options = {}) {
    const containerId = assertContainerId(id)
    const input = isRecord(options) ? options : {}
    const requested = input.tail === undefined || input.tail === null ? DEFAULT_LOG_TAIL : Number(input.tail)
    const tail = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LOG_TAIL) : DEFAULT_LOG_TAIL
    const { stdout: nameOutput } = await run(['inspect', '--format', '{{.Name}}', containerId])
    const name = nameOutput.trim().replace(/^\//u, '')
    const { stdout, stderr } = await run(['logs', '--tail', String(tail), containerId], MAX_LOG_BYTES)
    return { id: containerId, name, logs: combineLogs(stdout, stderr) }
  }

  /**
   * @returns {Promise<object[]>} one live stats row per running container.
   */
  async function stats() {
    const { stdout } = await run(['stats', '--no-stream', '--format', '{{json .}}'])
    return parseStatsOutput(stdout).map(toStat)
  }

  /**
   * @returns {Promise<object[]>} every image in the contract's shape.
   */
  async function listImages() {
    // `--no-trunc` supplies the full id; the contract exposes both it and the
    // 12-character short form the panel prints.
    const { stdout } = await run(['images', '--no-trunc', '--format', '{{json .}}'])
    return parseJsonLines(stdout, 'images').map(toImage)
  }

  /**
   * Remove one image. Only reached from an explicit user request; `force`
   * mirrors `docker image rm -f`.
   *
   * @param {string} id - image id or `repository:tag`.
   * @param {{ force?: boolean }} [options] - removal options.
   * @returns {Promise<{ id: string, ok: true }>} the outcome.
   * @throws {DataError} `docker_invalid_image` before spawning, or a docker failure.
   */
  async function removeImage(id, options = {}) {
    const imageId = assertImageReference(id)
    const args = ['image', 'rm']
    if (isRecord(options) && options.force === true) args.push('-f')
    args.push(imageId)
    await run(args)
    return { id: imageId, ok: true }
  }

  /**
   * Inspect one image.
   *
   * @param {string} id - image id or `repository:tag`.
   * @returns {Promise<object>} the contract's DockerImageDetail shape.
   * @throws {DataError} `docker_invalid_image` before spawning, or a docker failure.
   */
  async function inspectImage(id) {
    const imageId = assertImageReference(id)
    const { stdout } = await run(['image', 'inspect', imageId])
    const record = firstRecord(stdout)
    if (record === undefined) {
      throw new DataError('docker_failed', `docker image inspect returned nothing for ${imageId}`, { stderr: '' })
    }
    return toImageDetail(record)
  }

  /**
   * Enrich one `docker volume ls` row through `docker volume inspect`.
   *
   * @param {object} volume - the row built from `docker volume ls`.
   * @returns {Promise<object | null>} the enriched volume, or null when inspect failed.
   */
  async function enrichVolumeRow(volume) {
    try {
      const { stdout } = await run(['volume', 'inspect', volume.name])
      const record = firstRecord(stdout)
      if (record === undefined) return null
      return {
        name: textValue(record.Name) === '' ? volume.name : textValue(record.Name),
        driver: textValue(record.Driver) === '' ? volume.driver : textValue(record.Driver),
        scope: textValue(record.Scope) === '' ? volume.scope : textValue(record.Scope),
        mountpoint: textOrNull(record.Mountpoint) ?? volume.mountpoint,
        created: textOrNull(record.CreatedAt) ?? volume.created,
        labels: parseLabelsObject(record.Labels),
      }
    } catch {
      // An inspect failure degrades the row instead of failing the whole listing.
      return null
    }
  }

  /**
   * @returns {Promise<object[]>} every volume in the contract's shape. A row
   *   whose listing lacks a mountpoint or labels is enriched with `volume inspect`.
   */
  async function listVolumes() {
    const { stdout } = await run(['volume', 'ls', '--format', '{{json .}}'])
    const records = parseJsonLines(stdout, 'volume ls')
    const volumes = records.map(toVolume)
    const pending = []
    records.forEach((record, index) => {
      const labelsKnown = typeof record.Labels === 'string' && record.Labels !== 'N/A'
      if (volumes[index].mountpoint === null || !labelsKnown) pending.push(index)
    })
    if (pending.length > 0) {
      await Promise.all(pending.map(async (index) => {
        const enriched = await enrichVolumeRow(volumes[index])
        if (enriched !== null) volumes[index] = enriched
      }))
    }
    return volumes
  }

  /**
   * Remove one volume. Only reached from an explicit user request.
   *
   * @param {string} name - volume name.
   * @param {{ force?: boolean }} [options] - removal options (`docker volume rm -f`).
   * @returns {Promise<{ name: string, ok: true }>} the outcome.
   * @throws {DataError} `docker_invalid_volume` before spawning, or a docker failure.
   */
  async function removeVolume(name, options = {}) {
    const volumeName = assertVolumeName(name)
    const args = ['volume', 'rm']
    if (isRecord(options) && options.force === true) args.push('-f')
    args.push(volumeName)
    await run(args)
    return { name: volumeName, ok: true }
  }

  /**
   * Inspect one volume.
   *
   * @param {string} name - volume name.
   * @returns {Promise<object>} the contract's DockerVolumeDetail shape.
   * @throws {DataError} `docker_invalid_volume` before spawning, or a docker failure.
   */
  async function inspectVolume(name) {
    const volumeName = assertVolumeName(name)
    const { stdout } = await run(['volume', 'inspect', volumeName])
    const record = firstRecord(stdout)
    if (record === undefined) {
      throw new DataError('docker_failed', `docker volume inspect returned nothing for ${volumeName}`, { stderr: '' })
    }
    return toVolumeDetail(record, volumeName)
  }

  /**
   * @returns {Promise<object[]>} every network in the contract's shape.
   */
  async function listNetworks() {
    const { stdout } = await run(['network', 'ls', '--no-trunc', '--format', '{{json .}}'])
    return parseJsonLines(stdout, 'network ls').map(toNetwork)
  }

  /**
   * Remove one network. Only reached from an explicit user request.
   *
   * @param {string} name - network name.
   * @returns {Promise<{ name: string, ok: true }>} the outcome.
   * @throws {DataError} `docker_invalid_network` before spawning, or a docker failure.
   */
  async function removeNetwork(name) {
    const networkName = assertNetworkName(name)
    await run(['network', 'rm', networkName])
    return { name: networkName, ok: true }
  }

  /**
   * Inspect one network.
   *
   * @param {string} name - network name.
   * @returns {Promise<object>} the contract's DockerNetworkDetail shape.
   * @throws {DataError} `docker_invalid_network` before spawning, or a docker failure.
   */
  async function inspectNetwork(name) {
    const networkName = assertNetworkName(name)
    const { stdout } = await run(['network', 'inspect', networkName])
    const record = firstRecord(stdout)
    if (record === undefined) {
      throw new DataError('docker_failed', `docker network inspect returned nothing for ${networkName}`, { stderr: '' })
    }
    return toNetworkDetail(record)
  }

  /**
   * @returns {Promise<object>} disk usage for images, containers, volumes and
   *   build cache, in the contract's DockerDiskUsage shape.
   */
  async function diskUsage() {
    const { stdout } = await run(['system', 'df', '--format', '{{json .}}'])
    return toDiskUsage(parseJsonLines(stdout, 'system df'))
  }

  /**
   * Start, stop, restart, pause, unpause or remove one container.
   *
   * @param {string} id - container id or name.
   * @param {string} action - one of {@link DOCKER_ACTIONS}.
   * @returns {Promise<{ id: string, action: string, ok: true }>} the outcome.
   * @throws {DataError} `docker_invalid_id`, `docker_invalid_action`, or a docker failure.
   */
  async function action(id, action) {
    const containerId = assertContainerId(id)
    const requested = typeof action === 'string' ? action.trim() : ''
    if (!DOCKER_ACTIONS.includes(requested)) {
      throw new DataError('docker_invalid_action', `unknown docker action ${JSON.stringify(action)}`, {
        action: typeof action === 'string' ? action : String(action),
        allowed: [...DOCKER_ACTIONS],
      })
    }
    const command = requested === 'remove' ? 'rm' : requested
    await run([command, containerId])
    return { id: containerId, action: requested, ok: true }
  }

  return {
    version,
    listContainers,
    inspectContainer,
    logs,
    stats,
    action,
    listImages,
    removeImage,
    listVolumes,
    removeVolume,
    listNetworks,
    removeNetwork,
    inspectImage,
    inspectVolume,
    inspectNetwork,
    diskUsage,
  }
}
