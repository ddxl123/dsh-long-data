/**
 * Tests for the container ↔ image / volume / network relation graph: the joins
 * against a fixture Docker inventory (no daemon needed) and a read-only live
 * consistency check when Docker is available.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { buildRelations, mountType, normalizeImageId } from '../src/relations.js'

/** @returns {object} a fake docker service with one container per relation case. */
function fakeDocker() {
  return {
    async listContainers() {
      return [
        {
          id: 'c1', name: 'web', image: 'nginx:1.31', state: 'running',
          ports: [{ host: '8080', container: '80', protocol: 'tcp', ip: '0.0.0.0' }],
        },
        {
          id: 'c2', name: 'db', image: 'postgres:18', state: 'exited',
          ports: [],
        },
        {
          id: 'c3', name: 'ghost', image: 'redis:7', state: 'running',
          ports: [],
        },
      ]
    },
    async inspectContainer(id) {
      if (id === 'c1') {
        return {
          id: 'c1',
          imageId: 'sha256:' + 'a'.repeat(64),
          mounts: [
            { type: 'volume', name: 'web-data', source: 'web-data', destination: '/data', mode: 'rw', rw: true },
            { type: 'bind', name: '', source: '/host/conf', destination: '/etc/nginx', mode: 'ro', rw: false },
          ],
          networks: [{ name: 'bridge', ipAddress: '172.17.0.2' }, { name: 'appnet', ipAddress: '10.0.0.2' }],
        }
      }
      if (id === 'c2') {
        return {
          id: 'c2',
          imageId: 'sha256:' + 'b'.repeat(64),
          mounts: [
            { type: 'volume', name: 'pg-data', source: 'pg-data', destination: '/var/lib/postgresql/data', mode: 'rw', rw: true },
          ],
          networks: [{ name: 'appnet', ipAddress: '10.0.0.3' }],
        }
      }
      throw new Error('no such container')
    },
    async listImages() {
      return [
        { id: 'a'.repeat(64), shortId: 'a'.repeat(12), repoTags: ['nginx:1.31'], size: '12MB', sizeBytes: 12582912 },
        { id: 'b'.repeat(64), shortId: 'b'.repeat(12), repoTags: ['postgres:18'], size: '400MB', sizeBytes: 419430400 },
        { id: 'd'.repeat(64), shortId: 'd'.repeat(12), repoTags: [], size: '1MB', sizeBytes: 1048576 },
      ]
    },
    async listVolumes() {
      return [
        { name: 'web-data', driver: 'local', scope: 'local', mountpoint: '/var/lib/docker/volumes/web-data/_data', created: null, labels: {} },
        { name: 'pg-data', driver: 'local', scope: 'local', mountpoint: '/var/lib/docker/volumes/pg-data/_data', created: null, labels: {} },
        { name: 'lonely', driver: 'local', scope: 'local', mountpoint: null, created: null, labels: {} },
        { name: 'f'.repeat(64), driver: 'local', scope: 'local', mountpoint: null, created: null, labels: { 'com.docker.volume.anonymous': '' } },
      ]
    },
    async listNetworks() {
      return [
        { id: 'n1', shortId: 'n1', name: 'bridge', driver: 'bridge', scope: 'local', internal: false, ipv6: false },
        { id: 'n2', shortId: 'n2', name: 'appnet', driver: 'bridge', scope: 'local', internal: true, ipv6: false },
      ]
    },
  }
}

test('normalizeImageId strips the algorithm prefix and accepts short ids', () => {
  assert.equal(normalizeImageId('sha256:' + 'a'.repeat(64)), 'a'.repeat(64))
  assert.equal(normalizeImageId('A'.repeat(12)), 'a'.repeat(12))
  assert.equal(normalizeImageId('nginx:1.31'), '')
  assert.equal(normalizeImageId(undefined), '')
})

test('mountType recognizes volume, bind and tmpfs, with a path heuristic fallback', () => {
  assert.equal(mountType({ type: 'volume' }), 'volume')
  assert.equal(mountType({ type: 'bind' }), 'bind')
  assert.equal(mountType({ type: 'tmpfs' }), 'tmpfs')
  assert.equal(mountType({ source: '/host/path' }), 'bind')
  assert.equal(mountType({ source: 'named-volume' }), 'volume')
  assert.equal(mountType(null), 'other')
})

test('buildRelations joins containers to images, volumes and networks', async () => {
  const relations = await buildRelations(fakeDocker())

  assert.deepEqual(relations.summary, {
    containers: 3,
    running: 2,
    images: 3,
    volumes: 4,
    networks: 2,
    danglingImages: 1,
    unusedVolumes: 2,
  })

  const web = relations.containers.find((container) => container.name === 'web')
  assert.equal(web.imageId, 'a'.repeat(64))
  assert.equal(web.role, 'website')
  assert.equal(web.project, null)
  const databaseRow = relations.containers.find((container) => container.name === 'db')
  assert.equal(databaseRow.role, 'database')
  const cacheRow = relations.containers.find((container) => container.name === 'ghost')
  assert.equal(cacheRow.role, 'cache')
  assert.deepEqual(web.networks.map((network) => network.name), ['bridge', 'appnet'])
  assert.deepEqual(web.volumes[0], {
    type: 'volume', name: 'web-data', source: 'web-data', destination: '/data', mode: 'rw', rw: true,
  })
  assert.equal(web.volumes[1].type, 'bind')
  assert.equal(web.volumes[1].name, null)
  assert.deepEqual(web.ports, [{ host: '8080', container: '80', protocol: 'tcp', ip: '0.0.0.0' }])

  const ghost = relations.containers.find((container) => container.name === 'ghost')
  assert.equal(ghost.imageId, null)
  assert.deepEqual(ghost.volumes, [])
  assert.deepEqual(ghost.networks, [])

  const nginx = relations.images.find((image) => image.repoTags.includes('nginx:1.31'))
  assert.deepEqual(nginx.containers, ['web'])
  const postgres = relations.images.find((image) => image.repoTags.includes('postgres:18'))
  assert.deepEqual(postgres.containers, ['db'])
  const dangling = relations.images.find((image) => image.repoTags.length === 0)
  assert.deepEqual(dangling.containers, [])

  const webData = relations.volumes.find((volume) => volume.name === 'web-data')
  assert.deepEqual(webData.containers, ['web'])
  const lonely = relations.volumes.find((volume) => volume.name === 'lonely')
  assert.deepEqual(lonely.containers, [])
  const anonymous = relations.volumes.find((volume) => volume.name === 'f'.repeat(64))
  assert.equal(anonymous.anonymous, true)

  const appnet = relations.networks.find((network) => network.name === 'appnet')
  assert.deepEqual(appnet.containers, ['db', 'web'])
  assert.equal(appnet.internal, true)
  const bridge = relations.networks.find((network) => network.name === 'bridge')
  assert.deepEqual(bridge.containers, ['web'])
})

test('buildRelations contains no environment values or credentials', async () => {
  const docker = fakeDocker()
  docker.inspectContainer = async () => ({
    imageId: null,
    mounts: [],
    networks: [],
    env: [{ key: 'POSTGRES_PASSWORD', value: 'super-secret' }],
  })
  const relations = await buildRelations(docker)
  const serialized = JSON.stringify(relations)
  assert.equal(serialized.includes('super-secret'), false)
  assert.equal(serialized.includes('POSTGRES_PASSWORD'), false)
})

/* ------------------------------------------------------------------ */
/* Integration: read-only against the real daemon, skipped when down   */
/* ------------------------------------------------------------------ */

const probe = spawnSync('docker', ['version'], { encoding: 'utf8', timeout: 15_000 })
const dockerSkip = probe.error !== undefined || probe.status !== 0
  ? `docker CLI unavailable: ${(probe.error?.message ?? probe.stderr ?? 'unknown').trim().split('\n')[0]}`
  : false

test('live: the relation graph is internally consistent with docker ps', { skip: dockerSkip }, async () => {
  const { createDockerService } = await import('../src/docker.js')
  const service = createDockerService()
  const [relations, containers] = await Promise.all([buildRelations(service), service.listContainers()])

  assert.equal(relations.summary.containers, containers.length)
  assert.equal(relations.containers.length, containers.length)
  assert.equal(relations.summary.running, containers.filter((container) => container.state === 'running').length)
  assert.equal(relations.summary.images, relations.images.length)
  assert.equal(relations.summary.volumes, relations.volumes.length)
  assert.equal(relations.summary.networks, relations.networks.length)

  const names = new Set(relations.containers.map((container) => container.name))
  for (const image of relations.images) {
    for (const name of image.containers) assert.equal(names.has(name), true, `image ${image.shortId} references ${name}`)
  }
  for (const volume of relations.volumes) {
    for (const name of volume.containers) assert.equal(names.has(name), true, `volume ${volume.name} references ${name}`)
  }
  for (const network of relations.networks) {
    for (const name of network.containers) assert.equal(names.has(name), true, `network ${network.name} references ${name}`)
  }
  // Every running container's networks appear in the network inventory.
  const networkNames = new Set(relations.networks.map((network) => network.name))
  for (const container of relations.containers.filter((row) => row.state === 'running')) {
    for (const network of container.networks) assert.equal(networkNames.has(network.name), true, network.name)
  }
})
