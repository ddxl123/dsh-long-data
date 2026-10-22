/**
 * Docker service tests.
 *
 * Two layers, matching the contract's rule that Docker failures are data:
 *
 *   - unit tests drive a fake `child_process.spawn` so every error path
 *     (`docker_unavailable`, `docker_timeout`, `docker_failed`,
 *     `docker_invalid_id`, `docker_invalid_action`, `docker_invalid_image`,
 *     `docker_invalid_volume`, `docker_invalid_network`) and every output parser
 *     is exercised without touching a container or a GUI-app install;
 *   - integration tests make read-only calls (containers, images, volumes,
 *     networks, disk usage, version) against the real CLI and skip cleanly when
 *     it is not reachable.
 *
 * Nothing in the integration block removes, starts, stops, restarts or prunes
 * anything: mutating calls are only ever spawned by the fake.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { test } from 'node:test'

import { DOCKER_ACTIONS, createDockerService } from '../src/docker.js'
import { DataError } from '../src/errors.js'

/** A full container id (64 hex characters). */
const FULL_ID = '0123456789abcdef'.repeat(4)
/** A second full container id. */
const OTHER_ID = 'fedcba9876543210'.repeat(4)

/**
 * Build a `child_process.spawn` stand-in.
 *
 * `respond(args, index)` returns an outcome: `{ stdout, stderr, code }` for a
 * normal exit, `{ error }` to emit a spawn error, or `{ hang: true }` to leave
 * the child running until the service kills it. Every child records its kill
 * signals and every spawn records its argv, so tests can assert both the
 * command line and the timeout cleanup.
 *
 * @param {(args: string[], index: number) => object} respond - per-spawn outcome.
 * @returns {{ spawnProcess: Function, calls: object[], children: object[] }} the fake and its records.
 */
function fakeSpawn(respond) {
  const calls = []
  const children = []
  const spawnProcess = (binary, args, options) => {
    calls.push({ binary, args, options })
    const outcome = respond(args, calls.length - 1) ?? {}
    const child = new EventEmitter()
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    stdout.setEncoding = () => {}
    stderr.setEncoding = () => {}
    child.stdout = stdout
    child.stderr = stderr
    child.signals = []
    child.kill = (signal) => {
      child.signals.push(signal ?? 'SIGTERM')
      return true
    }
    children.push(child)
    setImmediate(() => {
      if (outcome.hang === true) return
      if (outcome.error !== undefined) {
        child.emit('error', outcome.error)
        return
      }
      if (typeof outcome.stdout === 'string') stdout.emit('data', outcome.stdout)
      if (typeof outcome.stderr === 'string') stderr.emit('data', outcome.stderr)
      child.emit('close', outcome.code ?? 0)
    })
    return child
  }
  return { spawnProcess, calls, children }
}

/**
 * Match a rejection by `DataError` code.
 *
 * @param {string} code - expected code.
 * @returns {(error: unknown) => true} an assert.rejects predicate.
 */
function rejectsWith(code) {
  return (error) => {
    assert.ok(error instanceof DataError, `expected a DataError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  }
}

test('exposes the fixed action list', () => {
  assert.deepEqual([...DOCKER_ACTIONS], ['start', 'stop', 'restart', 'pause', 'unpause', 'remove'])
})

test('version() reports the client and server of a reachable daemon', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({
    stdout: '{"Client":{"Version":"29.3.0"},"Server":{"Version":"28.0.1"}}\n',
  }))
  const service = createDockerService({ binary: '/usr/local/bin/docker', spawnProcess })
  const result = await service.version()
  assert.deepEqual(result, {
    available: true,
    binary: '/usr/local/bin/docker',
    clientVersion: '29.3.0',
    serverVersion: '28.0.1',
    error: null,
  })
  assert.equal(calls[0].binary, '/usr/local/bin/docker')
  assert.deepEqual(calls[0].args, ['version', '--format', '{{json .}}'])
  assert.equal(calls[0].options.shell, undefined)
})

test('version() never throws when the daemon is down and falls back to the client version', async () => {
  const { spawnProcess, calls } = fakeSpawn((args) => {
    if (args[0] === 'version') {
      return {
        code: 1,
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      }
    }
    return { stdout: 'Docker version 29.3.0, build 5927d80\n' }
  })
  const service = createDockerService({ spawnProcess })
  const result = await service.version()
  assert.equal(result.available, false)
  assert.equal(result.binary, 'docker')
  assert.equal(result.clientVersion, '29.3.0')
  assert.equal(result.serverVersion, null)
  assert.match(result.error, /Cannot connect to the Docker daemon/u)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args, ['--version'])
})

test('version() never throws when the CLI is missing', async () => {
  const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const { spawnProcess } = fakeSpawn(() => ({ error: enoent }))
  const service = createDockerService({ spawnProcess })
  const result = await service.version()
  assert.equal(result.available, false)
  assert.equal(result.clientVersion, null)
  assert.equal(result.serverVersion, null)
  assert.match(result.error, /not found/u)
})

test('version() never throws when spawning throws synchronously', async () => {
  const service = createDockerService({
    timeoutMs: 100,
    spawnProcess: () => {
      throw new Error('spawn exploded')
    },
  })
  const result = await service.version()
  assert.equal(result.available, false)
  assert.match(result.error, /spawn exploded/u)
})

test('a missing binary is reported as docker_unavailable', async () => {
  const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const { spawnProcess } = fakeSpawn(() => ({ error: enoent }))
  const service = createDockerService({ spawnProcess })
  await assert.rejects(service.listContainers(), rejectsWith('docker_unavailable'))
})

test('a non-zero exit is reported as docker_failed with the trimmed stderr', async () => {
  const { spawnProcess } = fakeSpawn(() => ({ code: 1, stderr: '  Error: No such object: ghost  \n' }))
  const service = createDockerService({ spawnProcess })
  await assert.rejects(service.inspectContainer('ghost'), (error) => {
    assert.ok(error instanceof DataError)
    assert.equal(error.code, 'docker_failed')
    assert.equal(error.details.stderr, 'Error: No such object: ghost')
    assert.match(error.message, /No such object/u)
    return true
  })
})

test('a hung command is killed at the deadline and reported as docker_timeout', async () => {
  const { spawnProcess, children } = fakeSpawn(() => ({ hang: true }))
  const service = createDockerService({ spawnProcess, timeoutMs: 30 })
  await assert.rejects(service.listContainers(), (error) => {
    assert.ok(error instanceof DataError)
    assert.equal(error.code, 'docker_timeout')
    assert.equal(error.details.timeoutMs, 30)
    return true
  })
  assert.deepEqual(children[0].signals, ['SIGKILL'])
})

test('rejects ids that could be read as CLI options before spawning', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: '[]' }))
  const service = createDockerService({ spawnProcess })
  const invalid = ['--help', '-it', '', '   ', 'web container', 'web/container', 'a'.repeat(129), '_leading', '.hidden']
  for (const id of invalid) {
    await assert.rejects(service.inspectContainer(id), rejectsWith('docker_invalid_id'))
    await assert.rejects(service.logs(id), rejectsWith('docker_invalid_id'))
    await assert.rejects(service.action(id, 'start'), rejectsWith('docker_invalid_id'))
  }
  await assert.rejects(service.inspectContainer(123), rejectsWith('docker_invalid_id'))
  assert.equal(calls.length, 0, 'an invalid id must never reach spawn')
})

test('rejects unknown actions before spawning', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  await assert.rejects(service.action('web', 'destroy'), rejectsWith('docker_invalid_action'))
  await assert.rejects(service.action('web', 'rm'), rejectsWith('docker_invalid_action'))
  await assert.rejects(service.action('web', undefined), rejectsWith('docker_invalid_action'))
  assert.equal(calls.length, 0, 'an unknown action must never reach spawn')
})

test('maps every action to its docker command', async () => {
  for (const action of DOCKER_ACTIONS) {
    const { spawnProcess, calls } = fakeSpawn(() => ({}))
    const service = createDockerService({ spawnProcess })
    const result = await service.action('Web_Container.1', action)
    assert.deepEqual(result, { id: 'Web_Container.1', action, ok: true })
    assert.deepEqual(calls[0].args, [action === 'remove' ? 'rm' : action, 'Web_Container.1'])
    assert.equal(calls[0].options.shell, undefined)
  }
})

test('listContainers() maps docker ps rows to the exact contract shape', async () => {
  const rows = [
    {
      ID: FULL_ID,
      Names: 'web',
      Image: 'nginx:1.31.6',
      Command: '"/docker-entrypoint.sh nginx -g \'daemon off;\'"',
      CreatedAt: '2026-10-22 08:05:12 +0800 CST',
      RunningFor: 'About an hour ago',
      Ports: '0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp',
      State: 'running',
      Status: 'Up About an hour (healthy)',
      // Values may contain '='; a pair without '=' is malformed and ignored.
      Labels: 'com.docker.compose.project=yida_local,com.docker.compose.version=5.1.0,note=a=b,broken',
    },
    {
      ID: OTHER_ID,
      Names: 'worker',
      Image: 'postgres:latest',
      Command: '"docker-entrypoint.sh postgres"',
      CreatedAt: '2025-12-15 21:30:01 +0800 CST',
      RunningFor: '10 months ago',
      Ports: '6379/tcp',
      State: 'exited',
      Status: 'Exited (0) 10 days ago',
      // No Labels field at all: Docker omits it when there are no labels.
    },
  ]
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: rows.map((row) => JSON.stringify(row)).join('\n') }))
  const service = createDockerService({ spawnProcess })
  const containers = await service.listContainers()
  assert.deepEqual(containers, [
    {
      id: FULL_ID,
      shortId: FULL_ID.slice(0, 12),
      name: 'web',
      image: 'nginx:1.31.6',
      labels: {
        'com.docker.compose.project': 'yida_local',
        'com.docker.compose.version': '5.1.0',
        note: 'a=b',
      },
      command: "/docker-entrypoint.sh nginx -g 'daemon off;'",
      state: 'running',
      status: 'Up About an hour (healthy)',
      ports: [
        { host: '8080', container: '8080', protocol: 'tcp', ip: '0.0.0.0' },
        { host: '8080', container: '8080', protocol: 'tcp', ip: '::' },
      ],
      createdAt: '2026-10-22 08:05:12 +0800 CST',
      runningFor: 'About an hour ago',
    },
    {
      id: OTHER_ID,
      shortId: OTHER_ID.slice(0, 12),
      name: 'worker',
      image: 'postgres:latest',
      labels: {},
      command: 'docker-entrypoint.sh postgres',
      state: 'exited',
      status: 'Exited (0) 10 days ago',
      ports: [{ host: null, container: '6379', protocol: 'tcp', ip: null }],
      createdAt: '2025-12-15 21:30:01 +0800 CST',
      runningFor: '10 months ago',
    },
  ])
  assert.deepEqual(Object.keys(containers[0]).sort(), [
    'command', 'createdAt', 'id', 'image', 'labels', 'name', 'ports', 'runningFor', 'shortId', 'state', 'status',
  ].sort())
  assert.deepEqual(calls[0].args, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'])
  assert.equal(calls[0].options.shell, undefined)
})

test('listContainers() accepts a JSON array body and rejects unreadable output', async () => {
  const row = {
    ID: FULL_ID,
    Names: 'web',
    Image: 'nginx',
    Command: '',
    CreatedAt: '',
    RunningFor: '',
    Ports: '',
    State: 'running',
    Status: 'Up',
  }
  const arrayService = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify([row]) })).spawnProcess })
  assert.equal((await arrayService.listContainers()).length, 1)

  const brokenService = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: 'not json at all' })).spawnProcess })
  await assert.rejects(brokenService.listContainers(), rejectsWith('docker_failed'))
})

test('inspectContainer() maps an inspect document to the exact contract shape', async () => {
  const record = {
    Id: FULL_ID,
    Created: '2026-10-22T00:05:12.464679596Z',
    Name: '/web',
    Platform: 'linux',
    RestartCount: 2,
    LogPath: '/var/lib/docker/containers/x/x-json.log',
    // The top-level Image is the full sha256 the container was created from.
    Image: `sha256:${OTHER_ID}`,
    State: {
      Status: 'running',
      ExitCode: 0,
      StartedAt: '2026-10-22T00:05:12.854815346Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      Health: { Status: 'healthy' },
    },
    Config: {
      Image: 'nginx:1.31.6',
      Entrypoint: ['/docker-entrypoint.sh'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      Env: ['PATH=/usr/local/bin', 'REDISCLI_AUTH=secret', 'NO_EQUALS'],
      Labels: {
        'com.docker.compose.project': 'yida_local',
        'com.docker.compose.service': 'web',
        'com.example.flag': '',
      },
    },
    HostConfig: {
      PortBindings: { '6379/tcp': [{ HostIp: '0.0.0.0', HostPort: '56379' }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    },
    NetworkSettings: {
      Ports: {
        '6379/tcp': [
          { HostIp: '0.0.0.0', HostPort: '56379' },
          { HostIp: '::', HostPort: '56379' },
        ],
      },
      Networks: { yida_local_yida_network: { IPAddress: '172.19.0.3' } },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: 'redis_data',
        Source: '/var/lib/docker/volumes/redis_data/_data',
        Destination: '/data',
        Mode: 'rw',
        RW: true,
      },
      {
        Type: 'bind',
        Name: '',
        Source: '/host_mnt/tmp/redis.conf',
        Destination: '/usr/local/etc/redis/redis.conf',
        Mode: 'ro',
        RW: false,
      },
      { Type: 'tmpfs', Name: '', Source: '', Destination: '/cache', Mode: '', RW: true },
    ],
  }
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: JSON.stringify([record]) }))
  const service = createDockerService({ spawnProcess })
  const detail = await service.inspectContainer('web')
  assert.equal(detail.id, FULL_ID)
  assert.equal(detail.shortId, FULL_ID.slice(0, 12))
  assert.equal(detail.name, 'web')
  assert.equal(detail.image, 'nginx:1.31.6')
  assert.equal(detail.imageId, `sha256:${OTHER_ID}`)
  assert.equal(detail.command, '/docker-entrypoint.sh nginx -g daemon off;')
  assert.equal(detail.state, 'running')
  assert.match(detail.status, /^Up /u)
  assert.match(detail.status, /\(healthy\)$/u)
  assert.deepEqual(detail.ports, [
    { host: '56379', container: '6379', protocol: 'tcp', ip: '0.0.0.0' },
    { host: '56379', container: '6379', protocol: 'tcp', ip: '::' },
  ])
  assert.equal(detail.createdAt, '2026-10-22T00:05:12.464679596Z')
  assert.equal(typeof detail.runningFor, 'string')
  assert.equal(detail.startedAt, '2026-10-22T00:05:12.854815346Z')
  assert.equal(detail.finishedAt, null)
  assert.equal(detail.restartCount, 2)
  assert.equal(detail.restartPolicy, 'unless-stopped')
  assert.equal(detail.health, 'healthy')
  assert.equal(detail.exitCode, 0)
  assert.deepEqual(detail.labels, {
    'com.docker.compose.project': 'yida_local',
    'com.docker.compose.service': 'web',
    'com.example.flag': '',
  })
  assert.deepEqual(detail.env, [
    { key: 'PATH', value: '/usr/local/bin' },
    { key: 'REDISCLI_AUTH', value: 'secret' },
    { key: 'NO_EQUALS', value: '' },
  ])
  assert.deepEqual(detail.mounts, [
    {
      type: 'volume',
      name: 'redis_data',
      source: '/var/lib/docker/volumes/redis_data/_data',
      destination: '/data',
      mode: 'rw',
      rw: true,
    },
    {
      type: 'bind',
      name: '',
      source: '/host_mnt/tmp/redis.conf',
      destination: '/usr/local/etc/redis/redis.conf',
      mode: 'ro',
      rw: false,
    },
    { type: 'tmpfs', name: '', source: '', destination: '/cache', mode: '', rw: true },
  ])
  assert.deepEqual(detail.networks, [{ name: 'yida_local_yida_network', ipAddress: '172.19.0.3' }])
  assert.equal(detail.platform, 'linux')
  assert.equal(detail.entrypoint, '/docker-entrypoint.sh')
  assert.equal(detail.cmd, 'nginx -g daemon off;')
  assert.equal(detail.logPath, '/var/lib/docker/containers/x/x-json.log')
  assert.deepEqual(Object.keys(detail).sort(), [
    'id', 'shortId', 'name', 'image', 'imageId', 'command', 'state', 'status', 'ports', 'createdAt', 'runningFor',
    'startedAt', 'finishedAt', 'restartCount', 'restartPolicy', 'health', 'exitCode', 'labels', 'env', 'mounts',
    'networks', 'platform', 'entrypoint', 'cmd', 'logPath',
  ].sort())
  assert.deepEqual(calls[0].args, ['inspect', 'web'])
})

test('inspectContainer() omits logPath when inspect has none', async () => {
  const { spawnProcess } = fakeSpawn(() => ({
    stdout: JSON.stringify([{
      Id: FULL_ID,
      Name: '/x',
      State: { Status: 'exited', ExitCode: 3 },
      Config: {},
      // Docker writes Name: '' for the default "no restart policy".
      HostConfig: { RestartPolicy: { Name: '' } },
    }]),
  }))
  const service = createDockerService({ spawnProcess })
  const detail = await service.inspectContainer('x')
  assert.equal('logPath' in detail, false)
  assert.equal(detail.imageId, null)
  assert.deepEqual(detail.labels, {})
  assert.equal(detail.restartPolicy, null)
  assert.equal(detail.exitCode, 3)
  assert.equal(detail.health, null)
  assert.equal(detail.state, 'exited')
  assert.match(detail.status, /^Exited \(3\) /u)
})

test('inspectImage() maps docker image inspect to the exact contract shape', async () => {
  const record = {
    Id: `sha256:${FULL_ID}`,
    RepoTags: ['nginx:1.31.6', '<none>'],
    Size: 62_167_057,
    Created: '2026-10-06T01:20:04.446765524Z',
    Architecture: 'arm64',
    Os: 'linux',
    Containers: 2,
    Config: {
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: ['/docker-entrypoint.sh'],
      Env: ['PATH=/usr/local/bin', 'NODE_ENV=production'],
      Labels: { maintainer: 'NGINX Docker Maintainers' },
      ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
    },
  }
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: JSON.stringify([record]) }))
  const service = createDockerService({ spawnProcess })
  const image = await service.inspectImage('nginx:1.31.6')
  assert.deepEqual(image, {
    id: FULL_ID,
    shortId: FULL_ID.slice(0, 12),
    repoTags: ['nginx:1.31.6'],
    size: '62.17MB',
    sizeBytes: 62_167_057,
    created: '2026-10-06T01:20:04.446765524Z',
    architecture: 'arm64',
    os: 'linux',
    cmd: 'nginx -g daemon off;',
    entrypoint: '/docker-entrypoint.sh',
    env: [
      { key: 'PATH', value: '/usr/local/bin' },
      { key: 'NODE_ENV', value: 'production' },
    ],
    labels: { maintainer: 'NGINX Docker Maintainers' },
    exposedPorts: ['80/tcp', '443/tcp'],
    containers: 2,
  })
  assert.deepEqual(Object.keys(image).sort(), [
    'architecture', 'cmd', 'containers', 'created', 'entrypoint', 'env', 'exposedPorts',
    'id', 'labels', 'os', 'repoTags', 'shortId', 'size', 'sizeBytes',
  ].sort())
  assert.deepEqual(calls[0].args, ['image', 'inspect', 'nginx:1.31.6'])
})

test('inspectImage() handles a dangling image without tags or config', async () => {
  const record = {
    Id: `sha256:${OTHER_ID}`,
    RepoTags: null,
    Size: 28_700,
    Created: '2026-10-01T00:00:00Z',
    Config: {},
  }
  const service = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify([record]) })).spawnProcess })
  const image = await service.inspectImage(OTHER_ID)
  assert.deepEqual(image, {
    id: OTHER_ID,
    shortId: OTHER_ID.slice(0, 12),
    repoTags: [],
    size: '28.7kB',
    sizeBytes: 28_700,
    created: '2026-10-01T00:00:00Z',
    architecture: '',
    os: '',
    cmd: '',
    entrypoint: '',
    env: [],
    labels: {},
    exposedPorts: [],
    containers: null,
  })
})

test('inspectImage() validates the reference and surfaces docker failures', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  for (const id of ['--force', '', '   ', 'a b', 'x'.repeat(256), '_leading']) {
    await assert.rejects(service.inspectImage(id), rejectsWith('docker_invalid_image'))
  }
  assert.equal(calls.length, 0, 'an invalid image reference must never reach spawn')
  const missing = createDockerService({
    spawnProcess: fakeSpawn(() => ({ code: 1, stderr: 'Error: No such image: ghost:latest  \n' })).spawnProcess,
  })
  await assert.rejects(missing.inspectImage('ghost:latest'), (error) => {
    assert.ok(error instanceof DataError)
    assert.equal(error.code, 'docker_failed')
    assert.equal(error.details.stderr, 'Error: No such image: ghost:latest')
    return true
  })
})

test('inspectVolume() maps docker volume inspect to the exact contract shape', async () => {
  const record = {
    CreatedAt: '2026-10-22T04:15:41Z',
    Driver: 'local',
    Labels: { 'com.docker.compose.project': 'yida_local', 'com.docker.volume.anonymous': '' },
    Mountpoint: `/var/lib/docker/volumes/${FULL_ID}/_data`,
    Name: FULL_ID,
    Options: { type: 'none', device: 'tmpfs' },
    Scope: 'local',
  }
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: JSON.stringify([record]) }))
  const service = createDockerService({ spawnProcess })
  const volume = await service.inspectVolume(FULL_ID)
  assert.deepEqual(volume, {
    name: FULL_ID,
    driver: 'local',
    scope: 'local',
    mountpoint: `/var/lib/docker/volumes/${FULL_ID}/_data`,
    created: '2026-10-22T04:15:41Z',
    labels: { 'com.docker.compose.project': 'yida_local', 'com.docker.volume.anonymous': '' },
    options: { type: 'none', device: 'tmpfs' },
    anonymous: true,
  })
  assert.deepEqual(Object.keys(volume).sort(), [
    'anonymous', 'created', 'driver', 'labels', 'mountpoint', 'name', 'options', 'scope',
  ])
  assert.deepEqual(calls[0].args, ['volume', 'inspect', FULL_ID])
})

test('inspectVolume() reports a named volume as non-anonymous with empty options', async () => {
  const record = {
    CreatedAt: '2026-10-20T00:00:00Z',
    Driver: 'local',
    Labels: { 'com.docker.compose.volume': 'pg_data' },
    Mountpoint: '/var/lib/docker/volumes/yida_pg_data/_data',
    Name: 'yida_pg_data',
    Options: null,
    Scope: 'local',
  }
  const service = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify([record]) })).spawnProcess })
  const volume = await service.inspectVolume('yida_pg_data')
  assert.equal(volume.name, 'yida_pg_data')
  assert.equal(volume.anonymous, false)
  assert.deepEqual(volume.options, {})
  assert.deepEqual(volume.labels, { 'com.docker.compose.volume': 'pg_data' })
})

test('inspectVolume() validates the name and surfaces docker failures', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  for (const name of ['--force', '', '   ', 'a b', 'yida/volume', 'x'.repeat(256), '_leading']) {
    await assert.rejects(service.inspectVolume(name), rejectsWith('docker_invalid_volume'))
  }
  assert.equal(calls.length, 0, 'an invalid volume name must never reach spawn')
  const missing = createDockerService({
    spawnProcess: fakeSpawn(() => ({ code: 1, stderr: 'Error: No such volume: ghost\n' })).spawnProcess,
  })
  await assert.rejects(missing.inspectVolume('ghost'), rejectsWith('docker_failed'))
})

test('inspectNetwork() maps docker network inspect to the exact contract shape', async () => {
  const record = {
    Id: FULL_ID,
    Name: 'yida_local_default',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
    EnableIPv6: true,
    Labels: { 'com.docker.compose.project': 'yida_local' },
    IPAM: {
      Driver: 'default',
      Config: [
        { Subnet: '172.19.0.0/16', Gateway: '172.19.0.1' },
        { Subnet: 'fd00::/64', Gateway: '' },
      ],
    },
    Containers: {
      [OTHER_ID]: { Name: 'web', IPv4Address: '172.19.0.3/16', IPv6Address: 'fd00::3/64' },
    },
  }
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: JSON.stringify([record]) }))
  const service = createDockerService({ spawnProcess })
  const network = await service.inspectNetwork('yida_local_default')
  assert.deepEqual(network, {
    id: FULL_ID,
    shortId: FULL_ID.slice(0, 12),
    name: 'yida_local_default',
    driver: 'bridge',
    scope: 'local',
    internal: false,
    ipv6: true,
    labels: { 'com.docker.compose.project': 'yida_local' },
    subnets: [
      { subnet: '172.19.0.0/16', gateway: '172.19.0.1' },
      { subnet: 'fd00::/64', gateway: null },
    ],
    containers: [{ id: OTHER_ID, name: 'web', ipv4Address: '172.19.0.3/16', ipv6Address: 'fd00::3/64' }],
  })
  assert.deepEqual(Object.keys(network).sort(), [
    'containers', 'driver', 'id', 'internal', 'ipv6', 'labels', 'name', 'scope', 'shortId', 'subnets',
  ])
  assert.deepEqual(calls[0].args, ['network', 'inspect', 'yida_local_default'])
})

test('inspectNetwork() handles an empty IPAM and no attached containers', async () => {
  const record = {
    Id: OTHER_ID,
    Name: 'isolated',
    Driver: 'bridge',
    Scope: 'local',
    Internal: true,
    EnableIPv6: false,
    IPAM: { Config: null },
    Containers: null,
  }
  const service = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify([record]) })).spawnProcess })
  const network = await service.inspectNetwork('isolated')
  assert.deepEqual(network.subnets, [])
  assert.deepEqual(network.containers, [])
  assert.deepEqual(network.labels, {})
  assert.equal(network.internal, true)
  assert.equal(network.ipv6, false)
})

test('inspectNetwork() validates the name and surfaces docker failures', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  for (const name of ['--force', '', '   ', 'a b', 'yida/network', 'x'.repeat(256), '_leading']) {
    await assert.rejects(service.inspectNetwork(name), rejectsWith('docker_invalid_network'))
  }
  assert.equal(calls.length, 0, 'an invalid network name must never reach spawn')
  const missing = createDockerService({
    spawnProcess: fakeSpawn(() => ({ code: 1, stderr: 'Error: No such network: ghost\n' })).spawnProcess,
  })
  await assert.rejects(missing.inspectNetwork('ghost'), rejectsWith('docker_failed'))
})

test('logs() resolves the container name and merges stdout with stderr', async () => {
  const { spawnProcess, calls } = fakeSpawn((args) => {
    if (args[0] === 'inspect') return { stdout: '/web\n' }
    return { stdout: 'line one\nline two\n', stderr: 'stderr line\n' }
  })
  const service = createDockerService({ spawnProcess })
  const result = await service.logs('web', { tail: 2 })
  assert.deepEqual(result, {
    id: 'web',
    name: 'web',
    logs: 'line one\nline two\nstderr line\n',
  })
  assert.deepEqual(calls[0].args, ['inspect', '--format', '{{.Name}}', 'web'])
  assert.deepEqual(calls[1].args, ['logs', '--tail', '2', 'web'])
})

test('logs() defaults and clamps the tail', async () => {
  const { spawnProcess, calls } = fakeSpawn((args) => (args[0] === 'inspect' ? { stdout: '/web\n' } : { stdout: 'line\n' }))
  const service = createDockerService({ spawnProcess })
  await service.logs('web')
  await service.logs('web', { tail: 100000 })
  await service.logs('web', { tail: 0 })
  await service.logs('web', { tail: 2.5 })
  assert.deepEqual(calls[1].args, ['logs', '--tail', '200', 'web'])
  assert.deepEqual(calls[3].args, ['logs', '--tail', '5000', 'web'])
  assert.deepEqual(calls[5].args, ['logs', '--tail', '200', 'web'])
  assert.deepEqual(calls[7].args, ['logs', '--tail', '200', 'web'])
})

test('logs() bounds oversized output', async () => {
  const huge = 'x'.repeat(600 * 1024)
  const { spawnProcess } = fakeSpawn((args) => (args[0] === 'inspect' ? { stdout: '/web\n' } : { stdout: huge }))
  const service = createDockerService({ spawnProcess })
  const result = await service.logs('web')
  assert.ok(result.logs.length > 0)
  assert.ok(result.logs.length <= 512 * 1024, `logs must be bounded, got ${result.logs.length}`)
})

test('stats() parses one JSON object per line', async () => {
  const row = {
    BlockIO: '0B / 88MB',
    CPUPerc: '0.91%',
    Container: FULL_ID,
    ID: FULL_ID.slice(0, 12),
    MemPerc: '45.27%',
    MemUsage: '695.4MiB / 1.5GiB',
    Name: 'web',
    NetIO: '11.4MB / 11.2MB',
    PIDs: '101',
  }
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: JSON.stringify(row) + '\n' }))
  const service = createDockerService({ spawnProcess })
  const stats = await service.stats()
  assert.deepEqual(stats, [
    {
      id: FULL_ID,
      name: 'web',
      cpuPercent: 0.91,
      memory: {
        usageBytes: Math.round(695.4 * 1024 ** 2),
        limitBytes: Math.round(1.5 * 1024 ** 3),
        percent: 45.27,
      },
      netIO: { rxBytes: Math.round(11.4 * 1000 ** 2), txBytes: Math.round(11.2 * 1000 ** 2) },
      blockIO: { readBytes: 0, writeBytes: Math.round(88 * 1000 ** 2) },
      pids: 101,
    },
  ])
  assert.deepEqual(Object.keys(stats[0]).sort(), ['blockIO', 'cpuPercent', 'id', 'memory', 'name', 'netIO', 'pids'].sort())
  assert.deepEqual(calls[0].args, ['stats', '--no-stream', '--format', '{{json .}}'])
})

test('stats() accepts a JSON array body and concatenated objects', async () => {
  const row = {
    BlockIO: '0B / 0B',
    CPUPerc: '0.00%',
    Container: FULL_ID,
    ID: FULL_ID.slice(0, 12),
    MemPerc: '0.00%',
    MemUsage: '0B / 0B',
    Name: 'web',
    NetIO: '0B / 0B',
    PIDs: '0',
  }
  const arrayService = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify([row]) })).spawnProcess })
  const arrayStats = await arrayService.stats()
  assert.equal(arrayStats.length, 1)
  assert.equal(arrayStats[0].id, FULL_ID)
  assert.equal(arrayStats[0].pids, 0)

  const concatService = createDockerService({
    spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify(row) + JSON.stringify({ ...row, Name: 'other' }) })).spawnProcess,
  })
  const concatStats = await concatService.stats()
  assert.equal(concatStats.length, 2)
  assert.equal(concatStats[1].name, 'other')
})

test('stats() never treats an empty stream as an error', async () => {
  const service = createDockerService({ spawnProcess: fakeSpawn(() => ({ stdout: '' })).spawnProcess })
  assert.deepEqual(await service.stats(), [])
})

test('exposes the v0.2 image, volume, network and disk methods', () => {
  const service = createDockerService({ spawnProcess: fakeSpawn(() => ({})).spawnProcess })
  for (const method of [
    'listImages', 'removeImage', 'listVolumes', 'removeVolume', 'listNetworks', 'removeNetwork', 'diskUsage',
    'inspectImage', 'inspectVolume', 'inspectNetwork',
  ]) {
    assert.equal(typeof service[method], 'function', `${method} must be exposed`)
  }
})

test('listImages() maps docker images rows to the exact contract shape', async () => {
  const rows = [
    {
      Containers: '1',
      CreatedAt: '2026-10-21 23:57:57 +0800 CST',
      CreatedSince: '11 hours ago',
      ID: `sha256:${FULL_ID}`,
      Repository: 'nginx',
      Tag: '1.31.6',
      Size: '261MB',
    },
    {
      Containers: 'N/A',
      CreatedAt: '2026-10-02 09:18:59 +0800 CST',
      CreatedSince: '2 weeks ago',
      ID: `sha256:${OTHER_ID}`,
      Repository: '<none>',
      Tag: '<none>',
      Size: '0B',
    },
  ]
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: rows.map((row) => JSON.stringify(row)).join('\n') }))
  const service = createDockerService({ spawnProcess })
  const images = await service.listImages()
  assert.deepEqual(images, [
    {
      id: FULL_ID,
      shortId: FULL_ID.slice(0, 12),
      repoTags: ['nginx:1.31.6'],
      repository: 'nginx',
      tag: '1.31.6',
      size: '261MB',
      sizeBytes: 261_000_000,
      created: '2026-10-21 23:57:57 +0800 CST',
      createdSince: '11 hours ago',
      containers: 1,
    },
    {
      id: OTHER_ID,
      shortId: OTHER_ID.slice(0, 12),
      repoTags: [],
      repository: '',
      tag: '',
      size: '0B',
      sizeBytes: 0,
      created: '2026-10-02 09:18:59 +0800 CST',
      createdSince: '2 weeks ago',
      containers: null,
    },
  ])
  assert.deepEqual(Object.keys(images[0]).sort(), [
    'containers', 'created', 'createdSince', 'id', 'repoTags', 'repository', 'shortId', 'size', 'sizeBytes', 'tag',
  ].sort())
  assert.deepEqual(calls[0].args, ['images', '--no-trunc', '--format', '{{json .}}'])
})

test('removeImage() validates the reference and maps to docker image rm', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  assert.deepEqual(await service.removeImage('nginx:1.31.6'), { id: 'nginx:1.31.6', ok: true })
  assert.deepEqual(calls[0].args, ['image', 'rm', 'nginx:1.31.6'])
  assert.deepEqual(await service.removeImage(FULL_ID, { force: true }), { id: FULL_ID, ok: true })
  assert.deepEqual(calls[1].args, ['image', 'rm', '-f', FULL_ID])
  for (const id of ['--force', '-f', '', '   ', 'a b', 'bad;rm', 'x'.repeat(256), '_leading']) {
    await assert.rejects(service.removeImage(id), rejectsWith('docker_invalid_image'))
  }
  assert.equal(calls.length, 2, 'an invalid image reference must never reach spawn')
})

test('listVolumes() maps rows and enriches incomplete ones through volume inspect', async () => {
  const rows = [
    {
      Driver: 'local',
      Labels: 'com.docker.compose.project=yida_local,com.docker.compose.volume=redis_data',
      Mountpoint: '/var/lib/docker/volumes/redis_data/_data',
      Name: 'redis_data',
      Scope: 'local',
    },
    {
      Driver: 'local',
      Labels: 'N/A',
      Mountpoint: '',
      Name: 'old_data',
      Scope: 'local',
    },
  ]
  const inspected = [
    {
      CreatedAt: '2026-10-22T01:51:39Z',
      Driver: 'local',
      Labels: { 'com.docker.compose.project': 'yida_local' },
      Mountpoint: '/var/lib/docker/volumes/old_data/_data',
      Name: 'old_data',
      Scope: 'local',
    },
  ]
  const { spawnProcess, calls } = fakeSpawn((args) => {
    if (args[0] === 'volume' && args[1] === 'ls') return { stdout: rows.map((row) => JSON.stringify(row)).join('\n') }
    if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: JSON.stringify(inspected) }
    return { code: 1, stderr: `unexpected command ${args.join(' ')}` }
  })
  const service = createDockerService({ spawnProcess })
  const volumes = await service.listVolumes()
  assert.deepEqual(volumes, [
    {
      name: 'redis_data',
      driver: 'local',
      scope: 'local',
      mountpoint: '/var/lib/docker/volumes/redis_data/_data',
      created: null,
      labels: { 'com.docker.compose.project': 'yida_local', 'com.docker.compose.volume': 'redis_data' },
    },
    {
      name: 'old_data',
      driver: 'local',
      scope: 'local',
      mountpoint: '/var/lib/docker/volumes/old_data/_data',
      created: '2026-10-22T01:51:39Z',
      labels: { 'com.docker.compose.project': 'yida_local' },
    },
  ])
  assert.deepEqual(calls[0].args, ['volume', 'ls', '--format', '{{json .}}'])
  assert.deepEqual(calls[1].args, ['volume', 'inspect', 'old_data'])
  assert.equal(calls.length, 2, 'a complete row must not trigger an inspect')
  assert.deepEqual(Object.keys(volumes[0]).sort(), ['created', 'driver', 'labels', 'mountpoint', 'name', 'scope'])
})

test('listVolumes() keeps the listing row when volume inspect fails', async () => {
  const row = { Driver: 'local', Labels: 'N/A', Name: 'old_data', Scope: 'local' }
  const { spawnProcess } = fakeSpawn((args) => (args[1] === 'ls'
    ? { stdout: JSON.stringify(row) }
    : { code: 1, stderr: 'Error: No such volume: old_data' }))
  const service = createDockerService({ spawnProcess })
  const volumes = await service.listVolumes()
  assert.deepEqual(volumes, [
    { name: 'old_data', driver: 'local', scope: 'local', mountpoint: null, created: null, labels: {} },
  ])
})

test('removeVolume() validates the name and maps to docker volume rm', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  assert.deepEqual(await service.removeVolume('redis_data'), { name: 'redis_data', ok: true })
  assert.deepEqual(calls[0].args, ['volume', 'rm', 'redis_data'])
  assert.deepEqual(await service.removeVolume('redis_data', { force: true }), { name: 'redis_data', ok: true })
  assert.deepEqual(calls[1].args, ['volume', 'rm', '-f', 'redis_data'])
  for (const name of ['--force', '', '   ', 'a b', 'yida/redis', 'x'.repeat(256), '_leading']) {
    await assert.rejects(service.removeVolume(name), rejectsWith('docker_invalid_volume'))
  }
  assert.equal(calls.length, 2, 'an invalid volume name must never reach spawn')
})

test('listNetworks() maps docker network ls rows to the exact contract shape', async () => {
  const rows = [
    {
      CreatedAt: '2026-10-21 15:39:37 +0000 UTC',
      Driver: 'bridge',
      ID: FULL_ID,
      IPv4: 'true',
      IPv6: 'false',
      Internal: 'false',
      Labels: '',
      Name: 'bridge',
      Scope: 'local',
    },
    {
      CreatedAt: '2026-10-11 21:42:28 +0000 UTC',
      Driver: 'bridge',
      ID: OTHER_ID,
      IPv4: 'true',
      IPv6: 'true',
      Internal: 'true',
      Labels: '',
      Name: 'yida_isolated',
      Scope: 'local',
    },
  ]
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: rows.map((row) => JSON.stringify(row)).join('\n') }))
  const service = createDockerService({ spawnProcess })
  const networks = await service.listNetworks()
  assert.deepEqual(networks, [
    {
      id: FULL_ID,
      shortId: FULL_ID.slice(0, 12),
      name: 'bridge',
      driver: 'bridge',
      scope: 'local',
      internal: false,
      ipv6: false,
    },
    {
      id: OTHER_ID,
      shortId: OTHER_ID.slice(0, 12),
      name: 'yida_isolated',
      driver: 'bridge',
      scope: 'local',
      internal: true,
      ipv6: true,
    },
  ])
  assert.deepEqual(Object.keys(networks[0]).sort(), ['driver', 'id', 'internal', 'ipv6', 'name', 'scope', 'shortId'])
  assert.deepEqual(calls[0].args, ['network', 'ls', '--no-trunc', '--format', '{{json .}}'])
})

test('removeNetwork() validates the name and maps to docker network rm', async () => {
  const { spawnProcess, calls } = fakeSpawn(() => ({}))
  const service = createDockerService({ spawnProcess })
  assert.deepEqual(await service.removeNetwork('yida_isolated'), { name: 'yida_isolated', ok: true })
  assert.deepEqual(calls[0].args, ['network', 'rm', 'yida_isolated'])
  for (const name of ['--force', '', '   ', 'a b', 'yida/net', 'x'.repeat(256), '_leading']) {
    await assert.rejects(service.removeNetwork(name), rejectsWith('docker_invalid_network'))
  }
  assert.equal(calls.length, 1, 'an invalid network name must never reach spawn')
})

test('diskUsage() maps docker system df rows to the exact contract shape', async () => {
  const rows = [
    { Active: '7', Reclaimable: '11.92GB (83%)', Size: '14.26GB', TotalCount: '13', Type: 'Images' },
    { Active: '4', Reclaimable: '267.9MB (99%)', Size: '269MB', TotalCount: '6', Type: 'Containers' },
    { Active: '5', Reclaimable: '65.67MB (2%)', Size: '3.206GB', TotalCount: '6', Type: 'Local Volumes' },
    { Active: '0', Reclaimable: '15.35GB', Size: '16.93GB', TotalCount: '82', Type: 'Build Cache' },
  ]
  const { spawnProcess, calls } = fakeSpawn(() => ({ stdout: rows.map((row) => JSON.stringify(row)).join('\n') }))
  const service = createDockerService({ spawnProcess })
  const usage = await service.diskUsage()
  assert.deepEqual(usage, {
    images: {
      count: 13,
      active: 7,
      size: '14.26GB',
      sizeBytes: 14_260_000_000,
      reclaimable: '11.92GB (83%)',
      reclaimableBytes: 11_920_000_000,
    },
    containers: {
      count: 6,
      active: 4,
      size: '269MB',
      sizeBytes: 269_000_000,
      reclaimable: '267.9MB (99%)',
      reclaimableBytes: 267_900_000,
    },
    volumes: {
      count: 6,
      active: 5,
      size: '3.206GB',
      sizeBytes: 3_206_000_000,
      reclaimable: '65.67MB (2%)',
      reclaimableBytes: 65_670_000,
    },
    buildCache: {
      count: 82,
      active: 0,
      size: '16.93GB',
      sizeBytes: 16_930_000_000,
      reclaimable: '15.35GB',
      reclaimableBytes: 15_350_000_000,
    },
  })
  assert.deepEqual(Object.keys(usage).sort(), ['buildCache', 'containers', 'images', 'volumes'])
  assert.deepEqual(Object.keys(usage.images).sort(), [
    'active', 'count', 'reclaimable', 'reclaimableBytes', 'size', 'sizeBytes',
  ])
  assert.deepEqual(calls[0].args, ['system', 'df', '--format', '{{json .}}'])
})

test('diskUsage() keeps all four categories when system df omits some', async () => {
  const service = createDockerService({
    spawnProcess: fakeSpawn(() => ({
      stdout: JSON.stringify({ Active: '1', Reclaimable: '5MB', Size: '10MB', TotalCount: '2', Type: 'Images' }),
    })).spawnProcess,
  })
  const usage = await service.diskUsage()
  assert.deepEqual(usage.containers, { count: 0, active: null, size: '', sizeBytes: 0, reclaimable: '', reclaimableBytes: 0 })
  assert.deepEqual(usage.volumes, { count: 0, active: null, size: '', sizeBytes: 0, reclaimable: '', reclaimableBytes: 0 })
  assert.deepEqual(usage.buildCache, { count: 0, active: null, size: '', sizeBytes: 0, reclaimable: '', reclaimableBytes: 0 })
  assert.equal(usage.images.count, 2)
  assert.equal(usage.images.sizeBytes, 10_000_000)
})

test('a missing bare docker falls back to an installed GUI-app executable and caches it', async (t) => {
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    `${homedir()}/.docker/bin/docker`,
  ]
  const installed = candidates.find((candidate) => existsSync(candidate))
  if (installed === undefined) return t.skip('no GUI-app docker executable exists on this machine')
  const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const row = {
    ID: FULL_ID,
    Names: 'web',
    Image: 'nginx:latest',
    Command: '',
    CreatedAt: '',
    RunningFor: '',
    Ports: '',
    State: 'running',
    Status: 'Up',
  }
  const { spawnProcess, calls } = fakeSpawn((args, index) => (index === 0 ? { error: enoent } : { stdout: JSON.stringify(row) }))
  const service = createDockerService({ binary: 'docker-not-on-path', spawnProcess })
  const containers = await service.listContainers()
  assert.equal(containers.length, 1)
  assert.equal(calls[0].binary, 'docker-not-on-path')
  assert.equal(calls[1].binary, installed)
  assert.equal(calls[1].options.shell, undefined)
  await service.listContainers()
  assert.equal(calls[2].binary, installed, 'the resolved executable must be cached')
})

test('keeps docker_unavailable when no GUI-app docker works either', async () => {
  const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const { spawnProcess } = fakeSpawn(() => ({ error: enoent }))
  const service = createDockerService({ binary: 'docker-not-on-path', spawnProcess })
  await assert.rejects(service.listImages(), rejectsWith('docker_unavailable'))
})

test('an absolute binary path is never second-guessed', async () => {
  const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const { spawnProcess, calls } = fakeSpawn(() => ({ error: enoent }))
  const service = createDockerService({ binary: '/opt/nowhere/docker', spawnProcess })
  await assert.rejects(service.listContainers(), rejectsWith('docker_unavailable'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binary, '/opt/nowhere/docker')
})

/* ------------------------------------------------------------------ */
/* Integration: read-only against the real CLI, skipped when it is down */
/* ------------------------------------------------------------------ */

const dockerProbe = spawnSync('docker', ['version'], { encoding: 'utf8', timeout: 15_000 })
const dockerSkip = dockerProbe.error !== undefined || dockerProbe.status !== 0
  ? `docker CLI unavailable: ${(dockerProbe.error?.message ?? dockerProbe.stderr ?? 'unknown error').trim().split('\n')[0]}`
  : false

/**
 * Pick a container to exercise the single-container endpoints with, preferring
 * a running one. Nothing here assumes a particular stack is up.
 *
 * @param {object[]} containers - the listed containers.
 * @returns {object | undefined} the sample.
 */
function sampleContainer(containers) {
  return containers.find((container) => container.state === 'running') ?? containers[0]
}

test('integration: lists the real containers read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const containers = await service.listContainers()
  if (containers.length === 0) {
    t.skip('the daemon has no containers to list')
    return
  }
  for (const container of containers) {
    assert.match(container.id, /^[a-f0-9]{64}$/u)
    assert.equal(container.shortId, container.id.slice(0, 12))
    assert.ok(container.name.length > 0)
    assert.ok(Array.isArray(container.ports))
    assert.ok(container.labels !== null && typeof container.labels === 'object' && !Array.isArray(container.labels))
  }
  // Any container is a valid sample: this machine's stack may be restarting,
  // stopped, or different from the one the plugin was developed against.
  const sample = sampleContainer(containers)
  assert.ok(sample !== undefined)
  assert.equal(typeof sample.state, 'string')
  assert.ok(Array.isArray(sample.ports))
})

test('integration: inspects a real container', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const containers = await service.listContainers()
  const target = sampleContainer(containers)
  if (target === undefined) {
    t.skip('the daemon has no container to inspect')
    return
  }
  const detail = await service.inspectContainer(target.id)
  assert.equal(detail.name, target.name)
  assert.equal(typeof detail.state, 'string')
  assert.equal(detail.shortId, detail.id.slice(0, 12))
  assert.ok(detail.health === null || typeof detail.health === 'string')
  assert.ok(Array.isArray(detail.env))
  assert.ok(Array.isArray(detail.mounts))
  assert.ok(detail.mounts.every((mount) => typeof mount.type === 'string'
    && typeof mount.name === 'string'
    && typeof mount.source === 'string'
    && typeof mount.destination === 'string'
    && typeof mount.rw === 'boolean'))
  assert.ok(detail.imageId === null || /^sha256:[a-f0-9]{64}$/u.test(detail.imageId))
  assert.ok(detail.labels !== null && typeof detail.labels === 'object' && !Array.isArray(detail.labels))
  assert.ok(detail.restartPolicy === null || typeof detail.restartPolicy === 'string')
  assert.ok(Array.isArray(detail.networks))
  assert.equal(typeof detail.platform, 'string')
  assert.ok(Array.isArray(detail.ports))
  assert.equal(typeof detail.entrypoint, 'string')
  assert.equal(typeof detail.cmd, 'string')
})

test('integration: a container imageId resolves through inspectImage', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const containers = await service.listContainers()
  const target = sampleContainer(containers)
  if (target === undefined) {
    t.skip('the daemon has no container to inspect')
    return
  }
  const detail = await service.inspectContainer(target.id)
  if (detail.imageId === null) {
    t.skip('the container does not report an image id')
    return
  }
  const image = await service.inspectImage(detail.imageId)
  assert.equal(`sha256:${image.id}`, detail.imageId)
  assert.equal(image.shortId, image.id.slice(0, 12))
})

test('integration: reads a bounded log tail', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const containers = await service.listContainers()
  const target = sampleContainer(containers)
  if (target === undefined) {
    t.skip('the daemon has no container to read logs from')
    return
  }
  const result = await service.logs(target.id, { tail: 5 })
  assert.equal(result.id, target.id)
  assert.ok(result.name.length > 0)
  assert.equal(typeof result.logs, 'string')
  assert.ok(result.logs.length <= 512 * 1024)
  assert.ok(result.logs.split('\n').filter((line) => line !== '').length <= 5)
})

test('integration: reads one live stats snapshot', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const stats = await service.stats()
  assert.ok(Array.isArray(stats))
  if (stats.length === 0) {
    t.skip('no running container produces a stats row right now')
    return
  }
  for (const row of stats) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.name, 'string')
    assert.equal(typeof row.cpuPercent, 'number')
    assert.ok(Number.isFinite(row.memory.usageBytes))
    assert.ok(Number.isFinite(row.memory.limitBytes))
    assert.ok(Number.isFinite(row.netIO.rxBytes))
    assert.ok(Number.isInteger(row.pids))
  }
})

test('integration: lists the real images read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const images = await service.listImages()
  assert.ok(Array.isArray(images))
  if (images.length === 0) {
    t.skip('the daemon has no images')
    return
  }
  for (const image of images) {
    assert.match(image.id, /^[a-f0-9]{12,64}$/u)
    assert.equal(image.shortId, image.id.slice(0, 12))
    assert.ok(Array.isArray(image.repoTags))
    assert.equal(typeof image.repository, 'string')
    assert.equal(typeof image.tag, 'string')
    assert.equal(typeof image.size, 'string')
    assert.ok(Number.isFinite(image.sizeBytes) && image.sizeBytes >= 0)
    assert.equal(typeof image.created, 'string')
    assert.equal(typeof image.createdSince, 'string')
    assert.ok(image.containers === null || Number.isInteger(image.containers))
  }
})

test('integration: lists the real volumes read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const volumes = await service.listVolumes()
  assert.ok(Array.isArray(volumes))
  if (volumes.length === 0) {
    t.skip('the daemon has no volumes')
    return
  }
  for (const volume of volumes) {
    assert.ok(volume.name.length > 0)
    assert.equal(typeof volume.driver, 'string')
    assert.equal(typeof volume.scope, 'string')
    assert.ok(volume.mountpoint === null || typeof volume.mountpoint === 'string')
    assert.ok(volume.created === null || typeof volume.created === 'string')
    assert.ok(volume.labels !== null && typeof volume.labels === 'object' && !Array.isArray(volume.labels))
  }
})

test('integration: lists the real networks read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const networks = await service.listNetworks()
  assert.ok(Array.isArray(networks))
  if (networks.length === 0) {
    t.skip('the daemon has no networks')
    return
  }
  for (const network of networks) {
    assert.match(network.id, /^[a-f0-9]{12,64}$/u)
    assert.equal(network.shortId, network.id.slice(0, 12))
    assert.ok(network.name.length > 0)
    assert.equal(typeof network.driver, 'string')
    assert.equal(typeof network.scope, 'string')
    assert.equal(typeof network.internal, 'boolean')
    assert.equal(typeof network.ipv6, 'boolean')
  }
})

test('integration: inspects a real image read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const images = await service.listImages()
  if (images.length === 0) {
    t.skip('the daemon has no images')
    return
  }
  const sample = images.find((image) => image.repoTags.length > 0) ?? images[0]
  const image = await service.inspectImage(sample.id)
  assert.equal(image.id, sample.id)
  assert.equal(image.shortId, image.id.slice(0, 12))
  assert.ok(Array.isArray(image.repoTags))
  assert.equal(typeof image.size, 'string')
  assert.ok(Number.isFinite(image.sizeBytes) && image.sizeBytes > 0)
  assert.match(image.created, /\d{4}-\d{2}-\d{2}/u)
  assert.equal(typeof image.architecture, 'string')
  assert.equal(typeof image.os, 'string')
  assert.equal(typeof image.cmd, 'string')
  assert.equal(typeof image.entrypoint, 'string')
  assert.ok(Array.isArray(image.env))
  assert.ok(image.labels !== null && typeof image.labels === 'object' && !Array.isArray(image.labels))
  assert.ok(Array.isArray(image.exposedPorts))
  assert.ok(image.containers === null || Number.isInteger(image.containers))
  assert.deepEqual(Object.keys(image).sort(), [
    'architecture', 'cmd', 'containers', 'created', 'entrypoint', 'env', 'exposedPorts',
    'id', 'labels', 'os', 'repoTags', 'shortId', 'size', 'sizeBytes',
  ].sort())
})

test('integration: inspects a real volume read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const volumes = await service.listVolumes()
  if (volumes.length === 0) {
    t.skip('the daemon has no volumes')
    return
  }
  const sample = volumes[0]
  const volume = await service.inspectVolume(sample.name)
  assert.equal(volume.name, sample.name)
  assert.equal(typeof volume.driver, 'string')
  assert.equal(typeof volume.scope, 'string')
  assert.ok(volume.mountpoint === null || typeof volume.mountpoint === 'string')
  assert.ok(volume.created === null || typeof volume.created === 'string')
  assert.ok(volume.labels !== null && typeof volume.labels === 'object' && !Array.isArray(volume.labels))
  assert.ok(volume.options !== null && typeof volume.options === 'object' && !Array.isArray(volume.options))
  assert.equal(typeof volume.anonymous, 'boolean')
  assert.deepEqual(Object.keys(volume).sort(), [
    'anonymous', 'created', 'driver', 'labels', 'mountpoint', 'name', 'options', 'scope',
  ])
})

test('integration: inspects a real network read-only', { skip: dockerSkip }, async (t) => {
  const service = createDockerService()
  const networks = await service.listNetworks()
  const sample = networks.find((network) => network.name === 'bridge') ?? networks[0]
  if (sample === undefined) {
    t.skip('the daemon has no networks')
    return
  }
  const network = await service.inspectNetwork(sample.name)
  assert.equal(network.name, sample.name)
  assert.equal(network.id, sample.id)
  assert.equal(network.shortId, network.id.slice(0, 12))
  assert.equal(typeof network.driver, 'string')
  assert.equal(typeof network.scope, 'string')
  assert.equal(typeof network.internal, 'boolean')
  assert.equal(typeof network.ipv6, 'boolean')
  assert.ok(network.labels !== null && typeof network.labels === 'object' && !Array.isArray(network.labels))
  assert.ok(Array.isArray(network.subnets))
  for (const subnet of network.subnets) {
    assert.equal(typeof subnet.subnet, 'string')
    assert.ok(subnet.gateway === null || typeof subnet.gateway === 'string')
  }
  assert.ok(Array.isArray(network.containers))
  for (const attached of network.containers) {
    assert.equal(typeof attached.id, 'string')
    assert.equal(typeof attached.name, 'string')
    assert.ok(attached.ipv4Address === null || typeof attached.ipv4Address === 'string')
    assert.ok(attached.ipv6Address === null || typeof attached.ipv6Address === 'string')
  }
  assert.deepEqual(Object.keys(network).sort(), [
    'containers', 'driver', 'id', 'internal', 'ipv6', 'labels', 'name', 'scope', 'shortId', 'subnets',
  ])
})

test('integration: reads the real disk usage read-only', { skip: dockerSkip }, async () => {
  const service = createDockerService()
  const usage = await service.diskUsage()
  assert.deepEqual(Object.keys(usage).sort(), ['buildCache', 'containers', 'images', 'volumes'])
  for (const key of ['images', 'containers', 'volumes', 'buildCache']) {
    const row = usage[key]
    assert.equal(typeof row.count, 'number')
    assert.ok(row.active === null || Number.isInteger(row.active))
    assert.equal(typeof row.size, 'string')
    assert.ok(Number.isFinite(row.sizeBytes) && row.sizeBytes >= 0)
    assert.equal(typeof row.reclaimable, 'string')
    assert.ok(Number.isFinite(row.reclaimableBytes) && row.reclaimableBytes >= 0)
  }
})

test('integration: reports the real CLI and daemon versions', { skip: dockerSkip }, async () => {
  const service = createDockerService()
  const result = await service.version()
  assert.equal(result.available, true)
  assert.equal(result.error, null)
  assert.match(result.clientVersion, /^\d+\.\d+/u)
  assert.match(result.serverVersion, /^\d+\.\d+/u)
})
