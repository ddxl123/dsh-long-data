/**
 * End-to-end HTTP test for the plugin's only public surface.
 *
 * The harness normally mounts `createDataRoute({ops})` on its `/api` channel;
 * this test replaces that mounting layer with a plain `node:http` server that
 * adapts `IncomingMessage` to a Fetch `Request` and writes the route's
 * `Response` back. Everything below the adapter is the real thing: the real
 * route, the real ops object, a temp settings document and the local `docker`
 * CLI talking to the live daemon.
 *
 * Docker-touching assertions are read-only (list + state) and skip cleanly when
 * `docker version` fails. No container is ever started, stopped, restarted,
 * paused or removed: the only action endpoint case sends an invalid payload,
 * which ops rejects before a service is built.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { resolveConfig, settingsDefaultsFrom } from '../src/config.js'
import { createOps } from '../src/ops.js'
import { API_PATH, MAX_BODY_BYTES, createDataRoute } from '../src/route.js'
import { SettingsStore } from '../src/settings.js'

/** A container this environment keeps running; only read from the list endpoint. */
const DOCKER_CONTAINER = 'yida_nginx'

/** Request headers the HTTP adapter drops because the Fetch layer regenerates them. */
const SKIPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive'])

/** The adapter's server, once `before` has started it. */
let server = null
/** Base URL of the adapter, e.g. `http://127.0.0.1:54321`. */
let baseUrl = ''
/** Temp directory holding the test settings document. */
let directory = ''
/** Every accepted socket, so `after` can close the server without waiting on keep-alive. */
const sockets = new Set()

/**
 * Buffer an IncomingMessage body.
 *
 * @param {import('node:http').IncomingMessage} request - the server request.
 * @returns {Promise<Buffer>} the raw body.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/**
 * Adapt one Node request to a Fetch Request and answer it from the route.
 *
 * @param {object} route - `createDataRoute({ops})`.
 * @param {import('node:http').IncomingMessage} request - the server request.
 * @param {import('node:http').ServerResponse} response - the server response.
 * @returns {Promise<void>} resolves once the response is written.
 */
async function handleRequest(route, request, response) {
  const body = await readBody(request)
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (SKIPPED_REQUEST_HEADERS.has(key)) continue
    if (Array.isArray(value)) headers.set(key, value.join(', '))
    else if (value !== undefined) headers.set(key, value)
  }
  const method = request.method ?? 'GET'
  const fetchRequest = new Request(`${baseUrl}${request.url ?? '/'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  })
  const fetchResponse = await route.fetch(fetchRequest)
  const responseHeaders = {}
  fetchResponse.headers.forEach((value, key) => {
    if (key === 'content-length' || key === 'connection') return
    responseHeaders[key] = value
  })
  response.writeHead(fetchResponse.status, responseHeaders)
  response.end(Buffer.from(await fetchResponse.arrayBuffer()))
}

/**
 * Fetch a path and decode its body.
 *
 * @param {string} path - URL path.
 * @param {RequestInit} [options] - fetch options.
 * @returns {Promise<{ status: number, body: any, text: string }>} the response snapshot.
 */
async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options)
  const text = await response.text()
  let body = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { status: response.status, body, text }
}

/**
 * POST one JSON envelope to the plugin route, the way the panel does.
 *
 * @param {object | string} payload - the envelope, or raw text.
 * @returns {Promise<{ status: number, body: any, text: string }>} the response snapshot.
 */
async function postJson(payload) {
  return requestJson(API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

/** Probe the daemon once, before the tests, so Docker cases can skip cleanly. */
const dockerProbe = spawnSync('docker', ['version'], { encoding: 'utf8', timeout: 15_000 })
const dockerAvailable = dockerProbe.error === undefined && dockerProbe.status === 0
const dockerSkip = dockerAvailable
  ? false
  : `docker CLI unavailable: ${(dockerProbe.error?.message ?? dockerProbe.stderr ?? 'unknown error').trim().split('\n')[0]}`

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-long-data-http-'))
  const config = resolveConfig(undefined)
  const settings = new SettingsStore({
    path: join(directory, 'settings.json'),
    // The real docker binary from the row defaults; redis/postgres stay at their
    // defaults because this test only exercises the Docker half of the panel.
    defaults: settingsDefaultsFrom(config),
  }).load()
  const ops = createOps({ settings, config, logger: { warn: () => {} } })
  const route = createDataRoute({ ops })
  server = createServer((request, response) => {
    handleRequest(route, request, response).catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(`adapter failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  // Fetch keeps connections alive; a plain close() would wait for them and make
  // `node --test` hang until the keep-alive timeout.
  if (server !== null) {
    server.closeAllConnections?.()
    await new Promise((resolve) => {
      server.close(() => resolve())
    })
    server = null
  }
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (directory !== '') {
    rmSync(directory, { recursive: true, force: true })
    directory = ''
  }
})

test('GET answers the bare bootstrap state over HTTP', async (t) => {
  const result = await requestJson(API_PATH)
  assert.equal(result.status, 200)
  // Documented asymmetry: GET returns the state *value* itself (the same view the
  // POST `state` endpoint wraps in an envelope), so curl users see it directly.
  const value = result.body
  assert.equal(typeof value.version, 'string')
  assert.equal(value.settings.docker.binary, 'docker')
  assert.equal(typeof value.settings.redis.hasPassword, 'boolean')
  assert.equal(Object.hasOwn(value.settings.redis, 'password'), false)
  assert.equal(Object.hasOwn(value.settings.postgres, 'password'), false)
  assert.equal(typeof value.docker.available, 'boolean')
  assert.equal(typeof value.targets, 'object')
  assert.equal(Array.isArray(value.targets.redis.candidates), true)
  assert.equal(Array.isArray(value.targets.postgres.candidates), true)
  assert.equal(Array.isArray(value.targets.redis.instances), true)
  assert.equal(Array.isArray(value.targets.postgres.instances), true)
  if (dockerAvailable) {
    assert.equal(value.docker.available, true)
    assert.equal(typeof value.docker.version, 'string')
  } else {
    t.diagnostic(`docker daemon not reachable: ${value.docker.error}`)
  }
})

test('POST {endpoint:"state"} returns the same envelope as GET', async () => {
  const posted = await postJson({ endpoint: 'state' })
  const fetched = await requestJson(API_PATH)
  assert.equal(posted.status, 200)
  assert.equal(posted.body.ok, true)
  assert.deepEqual(posted.body.value, fetched.body)
})

test('POST {endpoint:"docker.diskUsage"} returns the four disk rows', { skip: dockerSkip }, async () => {
  const result = await postJson({ endpoint: 'docker.diskUsage' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body.error))
  for (const key of ['images', 'containers', 'volumes', 'buildCache']) {
    assert.equal(typeof result.body.value.usage[key], 'object', key)
    assert.equal(typeof result.body.value.usage[key].count, 'number')
  }
})

test('POST {endpoint:"dockerfiles.list"} answers the scan envelope', async () => {
  const result = await postJson({ endpoint: 'dockerfiles.list', payload: {} })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body.error))
  assert.ok(Array.isArray(result.body.value.dockerfiles))
  assert.ok(Array.isArray(result.body.value.roots))
  assert.equal(typeof result.body.value.scan.visitedFiles, 'number')
  assert.ok(Array.isArray(result.body.value.scan.errors))
  assert.equal(typeof result.body.value.scan.generatedAt, 'string')
})

test('POST {endpoint:"dockerfiles.read"} refuses a path outside the scan', async () => {
  const result = await postJson({ endpoint: 'dockerfiles.read', payload: { path: '/etc/hosts' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'dockerfiles_not_found')
})

test('POST {endpoint:"overview"} returns the beginner health report', { skip: dockerSkip }, async () => {
  const result = await postJson({ endpoint: 'overview' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body.error))
  const value = result.body.value
  assert.equal(typeof value.generatedAt, 'string')
  assert.equal(typeof value.counts.containers, 'number')
  assert.ok(Array.isArray(value.containers))
  assert.ok(Array.isArray(value.projects))
  assert.ok(Array.isArray(value.insights))
  assert.equal(typeof value.services.redis, 'object')
  assert.equal(typeof value.services.postgres, 'object')
  assert.ok(value.dockerfiles === null || typeof value.dockerfiles === 'object')
})

test('POST {endpoint:"docker.relations"} returns the relation graph', { skip: dockerSkip }, async () => {
  const result = await postJson({ endpoint: 'docker.relations' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body.error))
  const relations = result.body.value.relations
  assert.equal(typeof relations.summary.containers, 'number')
  assert.equal(Array.isArray(relations.containers), true)
  assert.equal(Array.isArray(relations.images), true)
  assert.equal(Array.isArray(relations.volumes), true)
  assert.equal(Array.isArray(relations.networks), true)
})

test('POST {endpoint:"docker.imageInspect"} rejects option-like ids', { skip: dockerSkip }, async () => {
  const result = await postJson({ endpoint: 'docker.imageInspect', payload: { id: '--force' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.ok(['docker_invalid_image', 'invalid_payload'].includes(result.body.error.code), JSON.stringify(result.body.error))
})

test('POST {endpoint:"docker.list"} lists the real containers', { skip: dockerSkip }, async () => {
  const result = await postJson({ endpoint: 'docker.list' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body.error))
  const value = result.body.value
  assert.ok(Array.isArray(value.containers))
  assert.ok(value.containers.length > 0, 'this environment has containers to list')
  assert.equal(value.count, value.containers.length)
  const sample = value.containers.find((container) => container.name === DOCKER_CONTAINER) ?? value.containers[0]
  assert.equal(typeof sample.state, 'string')
  assert.equal(typeof sample.id, 'string')
  assert.ok(Array.isArray(sample.ports))
})

test('an unknown endpoint is a failure envelope, not an HTTP error', async () => {
  const result = await postJson({ endpoint: 'docker.explode' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'unknown_endpoint')
  assert.equal(result.body.error.details.endpoint, 'docker.explode')
})

test('docker.action without an id is rejected before any container is touched', async () => {
  const result = await postJson({ endpoint: 'docker.action', payload: { action: 'start' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'invalid_payload')
  assert.equal(result.body.error.details.field, 'id')
  assert.match(result.body.error.message, /"id"/u)
})

test('a non-JSON content type is refused with 415', async () => {
  const result = await requestJson(API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ endpoint: 'state' }),
  })
  assert.equal(result.status, 415)
  assert.match(result.text, /application\/json/u)
})

test('a malformed JSON body is refused with 400', async () => {
  const result = await postJson('{ nope')
  assert.equal(result.status, 400)
  assert.match(result.text, /JSON/u)
})

test('a body without a string endpoint is refused with 400', async () => {
  const result = await postJson({ payload: {} })
  assert.equal(result.status, 400)
  assert.match(result.text, /endpoint/u)
})

test('a large body under the declared cap is accepted and the reply stays small', async () => {
  assert.equal(MAX_BODY_BYTES, 2 * 1024 * 1024)
  const padding = 'x'.repeat(1024 * 1024)
  const result = await postJson({ endpoint: 'state', payload: { padding } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.ok(result.text.length < 4096, `the state reply must stay small, got ${result.text.length} bytes`)
})

test('an oversized body does not take the server down', async () => {
  const oversized = 'x'.repeat(MAX_BODY_BYTES + 1024 * 1024)
  const result = await postJson({ endpoint: 'state', payload: { padding: oversized } })
  // The route accepts or refuses the body; either way it must answer (not 5xx)
  // and must not echo the request payload back.
  assert.ok(result.status < 500, `unexpected status ${result.status}`)
  assert.ok(result.text.length < 4096, `the reply must stay small, got ${result.text.length} bytes`)
  const followUp = await postJson({ endpoint: 'state' })
  assert.equal(followUp.status, 200)
  assert.equal(followUp.body.ok, true)
})
