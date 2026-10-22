/**
 * Plain-language roles for containers.
 *
 * The panel is meant to be usable by someone who has never heard of Docker. A raw
 * image name (`docker.m.daocloud.io/library/postgres:18.6`) means nothing to
 * them; "数据库" does. This module makes one deterministic guess from the image,
 * the container name, its compose labels and the ports it exposes, and returns a
 * stable role key. The dictionary lives in the browser half, so the guess carries
 * no user-facing text of its own.
 *
 * A role is a hint, not a taxonomy: it decides which plain-language explanation
 * and impact sentence the UI shows, and nothing depends on it being perfect.
 *
 * @module dsh-long-data/src/roles
 */

/** The role keys the browser half knows how to name. Order is stable. */
export const ROLES = Object.freeze(['website', 'application', 'database', 'cache', 'queue', 'storage', 'monitoring', 'other'])

/** Known images per role, matched against the registry-stripped lowercase image slug. */
const IMAGE_RULES = Object.freeze([
  ['database', /(^|[/])(postgres|postgresql|postgis|mysql|mariadb|mongo|mongodb|clickhouse|sqlite|tidb|cockroach|cockroachdb|oracle|mssql|sqlserver|cassandra|neo4j|influxdb|timescaledb)([:@-]|$)/],
  ['cache', /(^|[/])(redis|redis-stack|keydb|valkey|memcached|dragonfly|hazelcast)([:@-]|$)/],
  ['queue', /(^|[/])(rabbitmq|kafka|zookeeper|nats|activemq|pulsar|redpanda|emqx)([:@-]|$)/],
  ['storage', /(^|[/])(minio|ceph|cephfs|seaweedfs|swift|nfs|s3|glusterfs)([:@-]|$)/],
  ['monitoring', /(^|[/])(prometheus|grafana|jaeger|zipkin|elasticsearch|kibana|logstash|loki|tempo|otel|datadog|zabbix|netdata|uptime-kuma)([:@-]|$)/],
  ['website', /(^|[/])(nginx|httpd|apache|caddy|traefik|envoy|haproxy|lighttpd|tomcat|jetty|ghost|wordpress)([:@-]|$)/],
  ['application', /(^|[/])(node|python|golang|java|openjdk|dotnet|php|ruby|rust|spring|gunicorn|uwsgi|deno|bun)([:@-]|$)/],
])

/** Ports that usually mean "a website is served here". */
const WEB_PORTS = new Set(['80', '443', '8000', '8080', '8443', '3000', '5173', '4200'])

/** Ports that usually mean "this is a database / cache / message broker". */
const SERVICE_PORTS = Object.freeze({
  '5432': 'database',
  '3306': 'database',
  '27017': 'database',
  '1433': 'database',
  '1521': 'database',
  '6379': 'cache',
  '11211': 'cache',
  '5672': 'queue',
  '9092': 'queue',
  '4222': 'queue',
  '9000': 'storage',
})

/**
 * @param {unknown} value - a candidate.
 * @returns {value is Record<string, any>} whether it is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The registry-stripped image slug, e.g. `docker.io/library/redis:7` → `redis:7`.
 *
 * @param {unknown} image - the image reference.
 * @returns {string} the lowercase slug without a registry host.
 */
export function imageSlug(image) {
  if (typeof image !== 'string') return ''
  const withoutDigest = image.split('@', 1)[0]
  const parts = withoutDigest.split('/')
  return (parts.length > 1 ? parts[parts.length - 1] : withoutDigest).toLowerCase()
}

/**
 * Guess a role from the image name alone.
 *
 * @param {unknown} image - the image reference.
 * @returns {string|null} a role key, or null when the image is unrecognized.
 */
export function roleOfImage(image) {
  const slug = imageSlug(image)
  if (slug === '') return null
  for (const [role, pattern] of IMAGE_RULES) {
    if (pattern.test(slug)) return role
  }
  return null
}

/**
 * @param {unknown} value - a Docker `ps` Labels field (already parsed) or inspect labels.
 * @returns {string[]} the compose-related hints found there.
 */
function labelHints(labels) {
  if (!isRecord(labels)) return []
  const project = typeof labels['com.docker.compose.project'] === 'string' ? labels['com.docker.compose.project'] : ''
  const service = typeof labels['com.docker.compose.service'] === 'string' ? labels['com.docker.compose.service'] : ''
  const image = typeof labels['com.docker.compose.image'] === 'string' ? labels['com.docker.compose.image'] : ''
  return [project, service, image].filter((value) => value !== '')
}

/**
 * Classify one container into a role the browser can explain in plain language.
 *
 * @param {object} input - container facts.
 * @param {unknown} input.image - image reference.
 * @param {string} [input.name] - container name.
 * @param {{ host?: string|null, container: string, protocol?: string }[]} [input.ports] - published ports.
 * @param {Record<string, string>} [input.labels] - container labels.
 * @returns {string} one of {@link ROLES}.
 */
export function classifyRole({ image, name, ports, labels } = {}) {
  const fromImage = roleOfImage(image)
  if (fromImage !== null) return fromImage

  const hints = `${typeof name === 'string' ? name : ''} ${labelHints(labels).join(' ')}`.toLowerCase()
  if (/(postgres|mysql|mongo|database|(^|[-_])db([-_]|$))/.test(hints)) return 'database'
  if (/(redis|memcached|cache)/.test(hints)) return 'cache'
  if (/(rabbit|kafka|queue|broker)/.test(hints)) return 'queue'
  if (/(nginx|web|frontend|site|http)/.test(hints)) return 'website'
  if (/(minio|storage|volume)/.test(hints)) return 'storage'
  if (/(worker|api|server|backend|app|service)/.test(hints)) return 'application'

  const containerPorts = new Set(
    (Array.isArray(ports) ? ports : [])
      .map((port) => (isRecord(port) ? String(port.container) : ''))
      .filter((port) => port !== ''),
  )
  for (const port of containerPorts) {
    const role = SERVICE_PORTS[port]
    if (role !== undefined) return role
  }
  for (const port of containerPorts) {
    if (WEB_PORTS.has(port)) return 'website'
  }
  if (containerPorts.size > 0) return 'application'
  return 'other'
}

/**
 * The compose project a container belongs to, when it was started by Compose.
 *
 * @param {unknown} labels - container labels.
 * @returns {{ project: string|null, service: string|null }} the compose identity.
 */
export function composeProject(labels) {
  if (!isRecord(labels)) return { project: null, service: null }
  const project = labels['com.docker.compose.project']
  const service = labels['com.docker.compose.service']
  return {
    project: typeof project === 'string' && project !== '' ? project : null,
    service: typeof service === 'string' && service !== '' ? service : null,
  }
}

export default { ROLES, classifyRole, composeProject, roleOfImage, imageSlug }
