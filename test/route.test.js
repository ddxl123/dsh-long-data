/**
 * Tests for the Fetch route. They drive the route object directly with a
 * `Request` — the same way the browser does — and use a fake ops object, so no
 * server, no service and no connection is involved.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { API_PATH, MAX_BODY_BYTES, createDataRoute } from '../src/route.js'

/**
 * @param {object} [overrides] - ops overrides.
 * @returns {{ route: object, calls: Array<{endpoint: string, payload: any}> }} the route and its call log.
 */
function makeRoute(overrides = {}) {
  const calls = []
  const ops = {
    async run(endpoint, payload) {
      calls.push({ endpoint, payload })
      if (endpoint === 'boom') return { ok: false, error: { code: 'boom_failed', message: 'kaput', details: { at: 'now' } } }
      return { ok: true, value: { endpoint, payload } }
    },
    async state() {
      return { ok: true, value: { version: '0.1.0', settings: {}, docker: { available: true } } }
    },
    ...overrides,
  }
  return { route: createDataRoute({ ops }), calls }
}

/**
 * @param {string} body - raw request body.
 * @param {object} [headers] - extra headers.
 * @returns {Request} a POST request.
 */
function post(body, headers = {}) {
  return new Request(`http://localhost${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

test('the route declares the contract path and methods', () => {
  const { route } = makeRoute()
  assert.equal(route.path, '/api/dsh-long-data')
  assert.equal(API_PATH, '/api/dsh-long-data')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(MAX_BODY_BYTES, 2 * 1024 * 1024)
})

test('POST runs the named endpoint and returns the ok envelope', async () => {
  const { route, calls } = makeRoute()
  const response = await route.fetch(post(JSON.stringify({ endpoint: 'docker.list', payload: { a: 1 } })))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, value: { endpoint: 'docker.list', payload: { a: 1 } } })
  assert.deepEqual(calls, [{ endpoint: 'docker.list', payload: { a: 1 } }])
})

test('POST defaults a missing payload to an empty object', async () => {
  const { route, calls } = makeRoute()
  const response = await route.fetch(post(JSON.stringify({ endpoint: 'state' })))
  assert.deepEqual(await response.json(), { ok: true, value: { endpoint: 'state', payload: {} } })
  assert.deepEqual(calls[0], { endpoint: 'state', payload: {} })
})

test('POST passes a failure envelope through unchanged', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(post(JSON.stringify({ endpoint: 'boom' })))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'boom_failed', message: 'kaput', details: { at: 'now' } },
  })
})

test('GET answers the bootstrap state', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(new Request(`http://localhost${API_PATH}`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.value.version, '0.1.0')
})

test('a non-POST/GET method is refused with Allow', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(new Request(`http://localhost${API_PATH}`, { method: 'PUT' }))
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, POST')
})

test('a non-JSON content type is refused', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(post('endpoint=state', { 'content-type': 'text/plain' }))
  assert.equal(response.status, 415)
})

test('an oversized body is refused with 413', async () => {
  const { route } = makeRoute()
  const big = JSON.stringify({ endpoint: 'state', payload: { filler: 'x'.repeat(MAX_BODY_BYTES + 1024) } })
  const response = await route.fetch(post(big))
  assert.equal(response.status, 413)
  assert.match(await response.text(), /too large/)
})

test('a malformed JSON body is refused', async () => {
  const { route } = makeRoute()
  const response = await route.fetch(post('{ nope'))
  assert.equal(response.status, 400)
})

test('a non-object body is refused', async () => {
  const { route } = makeRoute()
  assert.equal((await route.fetch(post('[1,2,3]'))).status, 400)
  assert.equal((await route.fetch(post('"state"'))).status, 400)
})

test('a body without a string endpoint is refused', async () => {
  const { route } = makeRoute()
  const missing = await route.fetch(post(JSON.stringify({ payload: {} })))
  assert.equal(missing.status, 400)
  assert.match(await missing.text(), /endpoint/)
  const wrong = await route.fetch(post(JSON.stringify({ endpoint: 42 })))
  assert.equal(wrong.status, 400)
})

test('an ops throw becomes a 500 rather than an unhandled rejection', async () => {
  const { route } = makeRoute({
    async run() {
      throw new Error('unexpected')
    },
  })
  await assert.rejects(() => route.fetch(post(JSON.stringify({ endpoint: 'state' }))), /unexpected/)
})
