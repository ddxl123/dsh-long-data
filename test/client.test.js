/**
 * Wiring and data-layer tests for the dsh-long-data browser half.
 *
 * The client bundle is not importable: it is a plain `window.__ModuleLoader__`
 * registration that expects Browser globals and a `react` module from the
 * shell's module table. These tests recreate exactly that much environment —
 * a fake loader, a fake `document` whose `head` records injected styles, and a
 * minimal React stand-in (never the real package) — then assert the contract
 * shape the Host half and the shell rely on:
 *
 *   - one lazy factory registered under the package id;
 *   - `factory(require)` requires nothing but `'react'` and returns
 *     `{ inject, apply }` with `inject` containing `slots` and `locale`;
 *   - `apply` injects the `main` panel under key `data`, the
 *     `sidebar.panellist` entry with id `data` and order 13, the zh/en
 *     dictionaries, and the single de-duplicated stylesheet;
 *   - the source obeys the hard constraints (no imports, no JSX, no
 *     `document.body`, no second package requirement, one API path);
 *   - the stylesheet keeps chrome on the contract theme tokens and the plugin
 *     class prefix;
 *   - the data layer posts `{endpoint, payload}` to `/api/dsh-long-data`,
 *     unwraps both envelope shapes, classifies unreachable vs refused,
 *     serializes posts, and drives the Docker/Redis/PostgreSQL/settings flows.
 *
 * Everything here runs with `node --test` and no dependencies.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { test } from 'node:test'

const CLIENT_PATH = fileURLToPath(new URL('../client/index.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

const NS = 'dsh-long-data'
const PANEL_ID = 'data'
const API_PATH = '/api/dsh-long-data'
const STYLE_ID = `${NS}/panel.css`
const PANEL_ORDER = 13

/**
 * A React stand-in good enough to materialize the factory and to inspect the
 * elements it builds. It intentionally does not render: the contract only
 * requires the registered components to be functions.
 *
 * @returns {object} the stub module.
 */
function createReactStub() {
  /** @type {Set<string>} */
  const createElementTypes = new Set()
  /** The hook context of the component currently being rendered, or null. */
  let context = null
  const stub = {
    createElement(type, props, ...children) {
      createElementTypes.add(typeof type === 'string' ? type : (type && type.name) || 'anonymous')
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) {
          for (const item of child) push(item)
        } else {
          flat.push(child)
        }
      }
      for (const child of children) push(child)
      return { type, props: props === null || props === undefined ? {} : props, children: flat }
    },
    useState(initial) {
      if (context === null) throw new Error('useState was called outside a render')
      const index = context.hookIndex++
      if (!(index in context.state)) context.state[index] = typeof initial === 'function' ? initial() : initial
      return [context.state[index], (next) => {
        context.state[index] = typeof next === 'function' ? next(context.state[index]) : next
      }]
    },
    useEffect(callback) {
      if (context !== null) context.effects.push(callback)
    },
    useRef(initial) {
      if (context === null) return { current: initial }
      const index = context.hookIndex++
      if (!(index in context.state)) context.state[index] = { current: initial }
      return context.state[index]
    },
    Fragment: Symbol.for('react.fragment'),
    __createElementTypes: createElementTypes,
  }

  /**
   * Render a tree of function components into plain element nodes. Effects are
   * deliberately not run: a render here is a pure inspection of the tree, and
   * running the panel's effects would fire network requests as a side effect.
   *
   * @param {any} node - an element returned by `createElement`.
   * @returns {any} the rendered node.
   */
  function renderNode(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderNode)
    if (typeof node.type === 'function') {
      const saved = context
      context = { hookIndex: 0, state: {}, effects: [] }
      const local = context
      const props = Object.assign({}, node.props)
      if (node.children.length === 1) props.children = node.children[0]
      else if (node.children.length > 1) props.children = node.children
      let output
      try {
        output = node.type(props)
      } finally {
        context = saved
      }
      void local
      return renderNode(output)
    }
    return { type: node.type, props: node.props, children: node.children.map(renderNode) }
  }

  /**
   * @param {Function} component - the registered panel component.
   * @param {object} props - its props.
   * @returns {object} the rendered tree.
   */
  stub.render = (component, props) => renderNode({ type: component, props, children: [] })
  return stub
}

/**
 * @param {any} node - a rendered node.
 * @param {(node: object) => boolean} predicate - the filter.
 * @returns {object[]} every matching element node, in tree order.
 */
function findAll(node, predicate) {
  const found = []
  const visit = (current) => {
    if (current === null || current === undefined || typeof current === 'string' || typeof current === 'number') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (predicate(current)) found.push(current)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return found
}

/**
 * @param {any} node - a rendered node.
 * @param {string} label - text to look for in a button's descendants.
 * @returns {object|undefined} the first matching button.
 */
function findButton(node, label) {
  return findAll(node, (current) => current.type === 'button' && treeText(current).includes(label))[0]
}

/**
 * @param {any} node - a rendered node.
 * @param {string} role - the ARIA role to look for.
 * @returns {object|undefined} the first matching element.
 */
function findRole(node, role) {
  return findAll(node, (current) => current.props !== undefined && current.props.role === role)[0]
}

/**
 * @param {any} node - a rendered node.
 * @returns {string} every text descendant, concatenated with spaces.
 */
function treeText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' ')
  return node.children.map(treeText).join(' ')
}

/**
 * A `document` stand-in. Only what the client actually touches is modelled:
 * `createElement('style')`, the `dataset`/`textContent` it writes, and the
 * `head` that records the appended node. `querySelector` returns null so the
 * stylesheet is injected once in these tests.
 *
 * @returns {object} the fake document, including the append log.
 */
function createDocumentStub() {
  const appended = []
  const head = {
    children: appended,
    appendChild(node) {
      appended.push(node)
      node.parentNode = head
      return node
    },
    removeChild(node) {
      const index = appended.indexOf(node)
      if (index >= 0) appended.splice(index, 1)
      return node
    },
  }
  return {
    head,
    appended,
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        textContent: '',
        style: {},
        children: [],
        parentNode: null,
        removed: false,
        appendChild(child) {
          this.children.push(child)
        },
        remove() {
          this.removed = true
          const parent = this.parentNode
          if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') parent.removeChild(this)
        },
      }
    },
    querySelector() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
}

/**
 * Evaluate the client bundle in a fresh VM context and materialize its factory.
 *
 * @param {{ fetch?: Function }} [options] - transport injected into the sandbox.
 * @returns {{ registrations: object[], factory: object, document: object, requireCalls: string[], React: object }} the loaded module.
 */
function loadClient(options) {
  const settings = options === undefined ? {} : options
  const registrations = []
  const document = createDocumentStub()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registrations.push(entry)
        },
      },
    },
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: settings.fetch,
    localStorage: settings.localStorage,
    navigator: settings.navigator,
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, displayErrors: true })

  assert.equal(registrations.length, 1, 'the module loader must receive exactly one registration')
  const registration = registrations[0]
  const requireCalls = []
  const React = createReactStub()
  const factory = registration.factory((name) => {
    requireCalls.push(name)
    if (name === 'react') return React
    throw new Error(`the client factory required an unexpected module: ${name}`)
  })
  return { registrations, factory, document, requireCalls, React }
}

/**
 * A fake Client root context that records every registration and runs each
 * `ctx.effect` callback eagerly, exactly as the real runtime does for setup.
 *
 * @returns {{ ctx: object, state: object }} the fake context and its recorder.
 */
function createApplyContext() {
  const state = {
    effects: [],
    locales: [],
    injects: [],
    slots: [],
  }
  const ctx = {
    effect(callback, label) {
      const cleanup = callback()
      state.effects.push({ label, cleanup: typeof cleanup === 'function' ? cleanup : () => {} })
      return cleanup
    },
    locale: {
      register(namespace, dictionaries) {
        state.locales.push({ namespace, dictionaries })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(ownerKey, install) {
        state.injects.push(ownerKey)
        return install()
      },
      register(options, component) {
        state.slots.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, state }
}

/**
 * Apply the module to a fresh fake context.
 *
 * @param {{ fetch?: Function }} [options] - transport injected into the sandbox.
 * @returns {{ load: object, ctx: object, state: object, client: object }} the applied module.
 */
function createStorageStub() {
  const data = new Map()
  return {
    data,
    getItem(key) {
      return data.has(String(key)) ? data.get(String(key)) : null
    },
    setItem(key, value) {
      data.set(String(key), String(value))
    },
    removeItem(key) {
      data.delete(String(key))
    },
  }
}

/**
 * A `navigator` stand-in with a working clipboard, so copy buttons can be
 * exercised without a browser.
 *
 * @returns {object} the stub, including the write log.
 */
function createNavigatorStub() {
  const writes = []
  return {
    writes,
    clipboard: {
      writeText(text) {
        writes.push(String(text))
        return Promise.resolve()
      },
    },
  }
}

function applyClient(options) {
  const load = loadClient(options)
  const applied = createApplyContext()
  load.factory.apply(applied.ctx)
  const main = applied.state.slots.find((slot) => slot.options.name === 'main')
  assert.ok(main, 'the main slot must be registered')
  const client = main.options.inject().client
  assert.ok(client, 'the main slot must inject the data client')
  return { load, ctx: applied.ctx, state: applied.state, client, React: load.React, panel: main.component }
}

/**
 * A successful Host envelope as a `fetch` Response stand-in.
 *
 * @param {any} value - the envelope's `value`.
 * @param {number} [status] - the HTTP status.
 * @returns {object} the response.
 */
function jsonResponse(value, status = 200) {
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    async json() {
      return ok ? { ok: true, value } : { ok: false, error: value }
    },
  }
}

/**
 * A refused-envelope response: HTTP 200 with `{ ok: false, error }`, exactly
 * the shape the Host contract uses for a localized failure code.
 *
 * @param {string} code - the failure code.
 * @param {string} [message] - the wire message.
 * @param {object} [details] - structured failure context.
 * @returns {object} the response.
 */
function hostErrorResponse(code, message = '', details = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: false, error: { code, message, details } }
    },
  }
}

/**
 * A `fetch` stand-in that records every request and answers through a handler.
 *
 * @param {(body: object, call: number) => any} handler - endpoint handler.
 * @returns {{ fetch: Function, calls: object[] }} the recorder.
 */
function hostRecorder(handler) {
  const calls = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    return handler(body, calls.length)
  }
  return { fetch, calls }
}

/**
 * The default redacted settings view the Host returns.
 *
 * @returns {object} the redacted settings.
 */
function redactedSettings() {
  return {
    docker: { binary: 'docker', timeoutMs: 20000 },
    redis: {
      mode: 'docker',
      container: '',
      host: '127.0.0.1',
      port: 6379,
      username: '',
      db: 0,
      tls: false,
      timeoutMs: 5000,
      hasPassword: true,
    },
    postgres: {
      mode: 'docker',
      container: '',
      host: '127.0.0.1',
      port: 5432,
      user: 'yida_postgres',
      database: 'yida',
      ssl: 'prefer',
      timeoutMs: 8000,
      hasPassword: true,
    },
  }
}

/**
 * The `state.targets` view: a running and a stopped Redis candidate plus one
 * running PostgreSQL container.
 *
 * @returns {object} the targets.
 */
function targetsValue() {
  return {
    redis: {
      candidates: [
        {
          name: 'yida_redis', image: 'redis:7.4-alpine', state: 'running', running: true,
          containerPort: '6379', hostPort: 56379, hasPassword: true, credentialsSource: 'container-env',
        },
        {
          name: 'old_redis', image: 'redis:6-alpine', state: 'exited', running: false,
          containerPort: '6379', hostPort: null, hasPassword: false, credentialsSource: 'none',
        },
      ],
      resolved: { mode: 'docker', container: 'yida_redis', host: '127.0.0.1', port: 56379, credentialsSource: 'container-env' },
      instances: [
        {
          container: 'yida_redis', image: 'redis:7.4-alpine', state: 'running', host: '127.0.0.1',
          port: 56379, containerPort: '6379', hasPublishedPort: true, hasPassword: true,
          credentialsSource: 'container-env',
        },
      ],
      error: null,
    },
    postgres: {
      candidates: [
        {
          name: 'yida_postgres', image: 'postgres:16', state: 'running', running: true,
          containerPort: '5432', hostPort: 55432, hasPassword: true, credentialsSource: 'container-env',
        },
      ],
      resolved: { mode: 'docker', container: 'yida_postgres', host: '127.0.0.1', port: 55432, credentialsSource: 'container-env' },
      instances: [
        {
          container: 'yida_postgres', image: 'postgres:16', state: 'running', host: '127.0.0.1',
          port: 55432, containerPort: '5432', hasPublishedPort: true, hasPassword: true,
          credentialsSource: 'container-env',
        },
      ],
      error: null,
    },
  }
}

/**
 * The `docker.diskUsage` value used by the sub-tab tests.
 *
 * @returns {object} the usage.
 */
function diskUsageValue() {
  return {
    images: { count: 2, active: 1, size: '1.2GB', sizeBytes: 1288490188, reclaimable: '640MB', reclaimableBytes: 671088640 },
    containers: { count: 3, active: 2, size: '12MB', sizeBytes: 12582912, reclaimable: '4MB', reclaimableBytes: 4194304 },
    volumes: { count: 1, active: 1, size: '8MB', sizeBytes: 8388608, reclaimable: '0B', reclaimableBytes: 0 },
    buildCache: { count: 5, active: 0, size: '256MB', sizeBytes: 268435456, reclaimable: '256MB', reclaimableBytes: 268435456 },
  }
}

/**
 * A `state` endpoint value with the Docker daemon available.
 *
 * @param {object} [docker] - overrides for the docker probe.
 * @returns {object} the state value.
 */
function stateValue(docker, targets) {
  return {
    version: '0.3.0',
    settings: redactedSettings(),
    docker: Object.assign({ available: true, binary: 'docker', version: '27.1.1', error: null }, docker === undefined ? {} : docker),
    targets: targets === undefined ? targetsValue() : targets,
  }
}

/**
 * A recorder that serves the bootstrap endpoints and an empty answer for
 * everything else.
 *
 * @returns {{ fetch: Function, calls: object[] }} the recorder.
 */
function bootstrapRecorder() {
  return hostRecorder((body) => {
    if (body.endpoint === 'state') return jsonResponse(stateValue())
    if (body.endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 1, version: '7.4.0' })
    if (body.endpoint === 'pg.version') {
      return jsonResponse({
        version: 'PostgreSQL 16.3 on x86_64-pc-linux-gnu',
        currentUser: 'yida_postgres',
        currentDatabase: 'yida',
      })
    }
    if (body.endpoint === 'docker.diskUsage') return jsonResponse({ usage: diskUsageValue() })
    return jsonResponse({})
  })
}

/** A running container row used by the v0.2 Docker tests. */
const CONTAINER_RUNNING = {
  id: 'aaaaaaaaaaaa', shortId: 'aaaaaaaaaaaa', name: 'web', image: 'nginx:latest',
  command: 'nginx -g daemon off;', state: 'running', status: 'Up 2 hours',
  ports: [{ host: '8080', container: '80', protocol: 'tcp', ip: '0.0.0.0' }],
  createdAt: '2026-10-01T00:00:00.000Z', runningFor: '2 hours',
  labels: { 'com.docker.compose.project': 'yida', 'com.docker.compose.service': 'web' },
}

/** An exited container row used by the v0.2 Docker tests. */
const CONTAINER_EXITED = {
  id: 'bbbbbbbbbbbb', shortId: 'bbbbbbbbbbbb', name: 'worker', image: 'busybox:latest',
  command: 'sh', state: 'exited', status: 'Exited (0) 5 minutes ago',
  ports: [], createdAt: '2026-10-01T00:00:00.000Z', runningFor: '5 minutes',
  labels: {},
}

/** An image row used by the v0.2 Docker tests. */
const IMAGE_ONE = {
  id: 'sha256:abc123def4567890', shortId: 'abc123def456', repoTags: ['nginx:latest'],
  repository: 'nginx', tag: 'latest', size: '142MB', sizeBytes: 148897792,
  created: '2026-10-01T00:00:00.000Z', createdSince: '3 weeks ago', containers: 1,
}

/** A volume row used by the v0.2 Docker tests. */
const VOLUME_ONE = {
  name: 'web-data', driver: 'local', scope: 'local',
  mountpoint: '/var/lib/docker/volumes/web-data/_data', created: null, labels: {},
}

/** A network row used by the v0.2 Docker tests. */
const NETWORK_ONE = {
  id: 'n1234567890abcdef', shortId: 'n1234567890a', name: 'app_default',
  driver: 'bridge', scope: 'local', internal: false, ipv6: false,
}

/**
 * A Host handler for the v0.2 Docker surface.
 *
 * @param {object} body - the request body.
 * @returns {object} the response.
 */
function dockerV2Handler(body) {
  const endpoint = body.endpoint
  if (endpoint === 'state') return jsonResponse(stateValue())
  if (endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 1, version: '7.4.0' })
  if (endpoint === 'pg.version') {
    return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
  }
  if (endpoint === 'docker.list') return jsonResponse({ containers: [CONTAINER_RUNNING, CONTAINER_EXITED], count: 2 })
  if (endpoint === 'docker.action') return jsonResponse({ id: body.payload.id, action: body.payload.action, ok: true })
  if (endpoint === 'docker.diskUsage') return jsonResponse({ usage: diskUsageValue() })
  if (endpoint === 'docker.images') return jsonResponse({ images: [IMAGE_ONE], count: 1 })
  if (endpoint === 'docker.imageRemove') return jsonResponse({ id: body.payload.id, ok: true })
  if (endpoint === 'docker.volumes') return jsonResponse({ volumes: [VOLUME_ONE], count: 1 })
  if (endpoint === 'docker.volumeRemove') return jsonResponse({ name: body.payload.name, ok: true })
  if (endpoint === 'docker.networks') return jsonResponse({ networks: [NETWORK_ONE], count: 1 })
  if (endpoint === 'docker.networkRemove') return jsonResponse({ name: body.payload.name, ok: true })
  if (endpoint === 'settings.save') return jsonResponse(redactedSettings())
  return jsonResponse({})
}

/** The `docker.relations` value used by the relations tests. */
function relationsValue() {
  return {
    summary: { containers: 3, running: 2, images: 2, volumes: 2, networks: 2, danglingImages: 1, unusedVolumes: 1 },
    containers: [
      {
        id: 'c1', name: 'web', state: 'running', image: 'nginx:latest', imageId: 'sha256:img1',
        role: 'website', project: 'yida', service: 'web', restartPolicy: 'unless-stopped',
        createdAt: '2026-10-01T00:00:00.000Z',
        ports: [{ host: '8080', container: '80', protocol: 'tcp', ip: '0.0.0.0' }],
        volumes: [
          { type: 'volume', name: 'web-data', source: '/var/lib/docker/volumes/web-data/_data', destination: '/usr/share/nginx/html', mode: 'rw', rw: true },
          { type: 'bind', name: null, source: '/srv/conf', destination: '/etc/nginx', mode: 'ro', rw: false },
        ],
        networks: [{ name: 'app_default', ipAddress: '172.18.0.2' }],
      },
      {
        id: 'c2', name: 'worker', state: 'exited', image: 'busybox:latest', imageId: 'sha256:img2',
        role: 'application', project: 'yida', service: 'worker', restartPolicy: null,
        createdAt: '2026-10-01T00:00:00.000Z', ports: [], volumes: [],
        networks: [{ name: 'app_default', ipAddress: null }],
      },
      {
        id: 'c3', name: 'db', state: 'running', image: 'postgres:16', imageId: null,
        role: 'database', project: null, service: null, restartPolicy: 'always',
        createdAt: '2026-10-01T00:00:00.000Z',
        ports: [{ host: '5432', container: '5432', protocol: 'tcp', ip: '0.0.0.0' }],
        volumes: [{ type: 'volume', name: 'pgdata', source: '/var/lib/docker/volumes/pgdata/_data', destination: '/var/lib/postgresql/data', mode: 'rw', rw: true }],
        networks: [{ name: 'backend', ipAddress: '172.19.0.3' }],
      },
    ],
    images: [
      { id: 'sha256:img1', shortId: 'img1', repoTags: ['nginx:latest'], size: '142MB', sizeBytes: 148897792, containers: ['web'] },
      { id: 'sha256:img2', shortId: 'img2', repoTags: [], size: '4MB', sizeBytes: 4194304, containers: ['worker'] },
    ],
    volumes: [
      { name: 'web-data', driver: 'local', scope: 'local', mountpoint: '/var/lib/docker/volumes/web-data/_data', anonymous: false, containers: ['web'] },
      { name: 'pgdata', driver: 'local', scope: 'local', mountpoint: '/var/lib/docker/volumes/pgdata/_data', anonymous: false, containers: ['db'] },
    ],
    networks: [
      { id: 'n1', name: 'app_default', driver: 'bridge', scope: 'local', internal: false, containers: ['web', 'worker'] },
      { id: 'n2', name: 'backend', driver: 'bridge', scope: 'local', internal: true, containers: ['db'] },
    ],
  }
}

/** PostgreSQL columns shared by the v0.3 fixtures. */
const PG_COLUMNS = [
  { name: 'id', dataType: 'int4', nullable: false, defaultValue: "nextval('users_id_seq')" },
  { name: 'email', dataType: 'text', nullable: false, defaultValue: null },
]

/** PostgreSQL indexes shared by the v0.3 fixtures. */
const PG_INDEXES = [
  { name: 'users_pkey', columns: ['id'], unique: true, primary: true },
  { name: 'users_email_idx', columns: ['email'], unique: false, primary: false },
]

/** PostgreSQL constraints shared by the v0.3 fixtures. */
const PG_CONSTRAINTS = [
  { name: 'users_pkey', type: 'primary key', definition: 'PRIMARY KEY (id)' },
  { name: 'users_email_check', type: 'check', definition: 'CHECK (email <> \'\')' },
]

/** A `pg.query` value for the SQL-editor tests. */
const PG_QUERY_RESULT = {
  database: 'yida',
  durationMs: 7,
  truncated: false,
  results: [{
    command: 'SELECT 2',
    columns: PG_COLUMNS,
    rows: [['1', 'alice@example.com'], ['2', null]],
    rowCount: 2,
  }],
}

/** Redis summary used by the v0.3 handler. */
const REDIS_SUMMARY = {
  version: '7.4.0', uptimeSeconds: 93784, connectedClients: 2, usedMemoryHuman: '1.25M',
  usedMemoryBytes: 1310720, totalKeys: 42, opsPerSec: 12, hitRate: 0.98, role: 'master',
}

/**
 * A complete v0.3 Host handler, falling back to the v0.2 Docker handler.
 *
 * @param {object} body - the request body.
 * @returns {object} the response.
 */
function v3Handler(body) {
  const endpoint = body.endpoint
  const payload = body.payload === undefined || body.payload === null ? {} : body.payload
  if (endpoint === 'overview') return jsonResponse(overviewValue())
  if (endpoint === 'dockerfiles.list') {
    return jsonResponse({ dockerfiles: DOCKERFILE_SUMMARIES, roots: DOCKERFILE_ROOTS, scan: DOCKERFILE_SCAN })
  }
  if (endpoint === 'dockerfiles.read') return jsonResponse(DOCKERFILE_READ)
  if (endpoint === 'docker.relations') return jsonResponse({ relations: relationsValue() })
  if (endpoint === 'docker.inspect') {
    return jsonResponse({
      container: Object.assign({}, CONTAINER_RUNNING, {
        env: [{ key: 'NODE_ENV', value: 'production' }],
        mounts: [{ source: '/srv/web', destination: '/html', mode: 'rw', rw: true }],
        networks: [{ name: 'bridge', ipAddress: '172.17.0.2' }],
        labels: { 'com.docker.compose.project': 'yida' },
        restartPolicy: 'unless-stopped',
        health: 'healthy', restartCount: 0, exitCode: 0, platform: 'linux/arm64',
        entrypoint: '/entry.sh', cmd: 'nginx -g daemon off;', logPath: '/var/lib/docker/log',
      }),
    })
  }
  if (endpoint === 'docker.stats') {
    return jsonResponse({
      stats: [
        {
          id: CONTAINER_RUNNING.id, name: 'web', cpuPercent: 12.5,
          memory: { usageBytes: 33554432, limitBytes: 268435456, percent: 12.5 },
          netIO: { rxBytes: 1, txBytes: 2 }, blockIO: { readBytes: 3, writeBytes: 4 }, pids: 5,
        },
        {
          id: CONTAINER_EXITED.id, name: 'worker', cpuPercent: null,
          memory: { usageBytes: 0, limitBytes: 0, percent: null },
          netIO: { rxBytes: 0, txBytes: 0 }, blockIO: { readBytes: 0, writeBytes: 0 }, pids: 0,
        },
      ],
    })
  }
  if (endpoint === 'docker.imageInspect') {
    return jsonResponse({
      image: {
        id: IMAGE_ONE.id, shortId: IMAGE_ONE.shortId, repoTags: IMAGE_ONE.repoTags,
        size: '142MB', sizeBytes: 148897792, created: '2026-10-01T00:00:00.000Z',
        architecture: 'arm64', os: 'linux', cmd: 'nginx -g daemon off;', entrypoint: '/entry.sh',
        env: [{ key: 'PATH', value: '/usr/bin' }], labels: { maintainer: 'nginx' },
        exposedPorts: ['80/tcp'], containers: 1,
      },
    })
  }
  if (endpoint === 'docker.volumeInspect') {
    return jsonResponse({
      volume: {
        name: VOLUME_ONE.name, driver: 'local', scope: 'local', mountpoint: VOLUME_ONE.mountpoint,
        created: '2026-10-01T00:00:00.000Z', labels: {}, options: { type: 'none' }, anonymous: false,
      },
    })
  }
  if (endpoint === 'docker.networkInspect') {
    return jsonResponse({
      network: {
        id: NETWORK_ONE.id, shortId: NETWORK_ONE.shortId, name: NETWORK_ONE.name,
        driver: 'bridge', scope: 'local', internal: false, ipv6: false, labels: {},
        subnets: [{ subnet: '172.18.0.0/16', gateway: '172.18.0.1' }],
        containers: [{ id: 'c1', name: 'web', ipv4Address: '172.18.0.2', ipv6Address: null }],
      },
    })
  }
  if (endpoint === 'redis.info') return jsonResponse({ summary: REDIS_SUMMARY, sections: {} })
  if (endpoint === 'redis.dbsize') return jsonResponse({ keys: 42 })
  if (endpoint === 'redis.clients') {
    return jsonResponse({
      clients: [{
        id: '1', addr: '127.0.0.1:5000', name: '', ageSeconds: 120, idleSeconds: 2,
        db: 0, command: 'client', user: 'default',
      }],
      count: 1,
    })
  }
  if (endpoint === 'redis.scan') return jsonResponse({ cursor: '0', keys: ['hash:1', 'list:1', 'set:1'], done: true })
  if (endpoint === 'redis.get') {
    const key = payload.key
    if (key === 'hash:1') return jsonResponse({ key, type: 'hash', ttl: -1, value: { role: 'admin' } })
    if (key === 'list:1') return jsonResponse({ key, type: 'list', ttl: 300, value: ['a', 'b'] })
    if (key === 'set:1') return jsonResponse({ key, type: 'set', ttl: -1, value: ['m1', 'm2'] })
    return jsonResponse({ key, type: 'string', ttl: -1, value: 'hello' })
  }
  if (endpoint === 'redis.memory') return jsonResponse({ key: payload.key, bytes: 1024, human: '1.0K' })
  if (endpoint === 'redis.rename') return jsonResponse({ key: payload.key, newKey: payload.newKey, renamed: true })
  if (endpoint === 'redis.expire') return jsonResponse({ key: payload.key, ttl: payload.ttlSeconds })
  if (endpoint === 'redis.persist') return jsonResponse({ key: payload.key, ttl: -1 })
  if (endpoint === 'redis.hashSet') return jsonResponse({ key: payload.key, field: payload.field, fieldCount: 2 })
  if (endpoint === 'redis.listPush') return jsonResponse({ key: payload.key, length: 3 })
  if (endpoint === 'redis.setAdd') return jsonResponse({ key: payload.key, length: 2 })
  if (endpoint === 'redis.setRemove') return jsonResponse({ key: payload.key, length: 1, removed: true })
  if (endpoint === 'pg.databases') {
    return jsonResponse({ databases: [{ name: 'yida', owner: 'yida_postgres', encoding: 'UTF8', size: '8 MB', sizeBytes: 8388608, connections: 2 }] })
  }
  if (endpoint === 'pg.tables') {
    return jsonResponse({
      database: payload.database === undefined ? 'yida' : payload.database,
      schema: null,
      tables: [{
        schema: 'public', name: 'users', kind: 'table', estimatedRows: 3,
        size: '16 MB', sizeBytes: 16777216, comment: 'demo table', columnCount: 2,
      }],
    })
  }
  if (endpoint === 'pg.tableDetail') {
    return jsonResponse({
      database: 'yida',
      schema: payload.schema,
      table: payload.table,
      size: '16 MB',
      estimatedRows: 3,
      comment: 'demo table',
      columns: PG_COLUMNS,
      indexes: PG_INDEXES,
      constraints: PG_CONSTRAINTS,
    })
  }
  if (endpoint === 'pg.activity') {
    return jsonResponse({
      sessions: [{
        pid: 123, user: 'yida_postgres', database: 'yida', state: 'active',
        client: '127.0.0.1:6000', applicationName: 'psql', backendStart: '2026-10-22T01:00:00Z',
        queryStart: '2026-10-22T01:00:01Z', querySeconds: 1.25, query: 'select 1', waitEvent: null,
      }],
    })
  }
  if (endpoint === 'pg.browse') {
    const limit = typeof payload.limit === 'number' ? payload.limit : 50
    const offset = typeof payload.offset === 'number' ? payload.offset : 0
    return jsonResponse({
      database: 'yida',
      schema: payload.schema,
      table: payload.table,
      columns: PG_COLUMNS,
      rows: [[String(offset + 1), 'alice@example.com'], [String(offset + 2), null]].slice(0, limit),
      rowCount: 2,
      totalRows: 120,
      limitedBy: 'limit',
    })
  }
  if (endpoint === 'pg.query') return jsonResponse(PG_QUERY_RESULT)
  return dockerV2Handler(body)
}

/** The `overview` endpoint value used by the v0.4 tests. */
function overviewValue() {
  return {
    generatedAt: '2026-10-22T05:00:00.000Z',
    docker: { available: true, version: '27.1.1', error: null },
    counts: {
      containers: 3, running: 2, stopped: 1, images: 2, volumes: 2, networks: 2,
      danglingImages: 1, unusedVolumes: 1,
    },
    disk: diskUsageValue(),
    containers: [
      {
        name: 'web', state: 'running', image: 'nginx:latest', role: 'website', project: 'yida',
        service: 'web', restartPolicy: 'unless-stopped',
        ports: [{ host: '8080', container: '80', protocol: 'tcp' }],
        volumes: 1, bindMounts: 1, networks: 1,
      },
      {
        name: 'worker', state: 'exited', image: 'busybox:latest', role: 'application', project: null,
        service: null, restartPolicy: null, ports: [], volumes: 0, bindMounts: 0, networks: 1,
      },
      {
        name: 'db', state: 'running', image: 'postgres:16', role: 'database', project: 'yida',
        service: 'db', restartPolicy: 'always',
        ports: [{ host: '5432', container: '5432', protocol: 'tcp' }],
        volumes: 1, bindMounts: 0, networks: 1,
      },
    ],
    projects: [{ name: 'yida', containers: 2, running: 2 }],
    services: {
      redis: {
        mode: 'docker', container: 'yida_redis', reachable: true, version: '7.4.0',
        instances: 1, ambiguous: false,
        summary: { keys: 42, memoryHuman: '1.25M', clients: 2 }, error: null,
      },
      postgres: {
        mode: 'docker', container: 'yida_postgres', reachable: true, version: '16.3',
        instances: 1, ambiguous: false,
        summary: { databases: 3, sessions: 5, currentDatabase: 'yida' }, error: null,
      },
    },
    dockerfiles: { count: 2, generatedAt: '2026-10-22T06:00:00.000Z' },
    insights: [
      { code: 'dockerfiles_found', level: 'info', params: { count: 2, names: ['Dockerfile', 'Dockerfile.build'] } },
      { code: 'stopped_containers', level: 'warn', params: { count: 1, names: ['worker'] } },
      { code: 'unused_volumes', level: 'info', params: { count: 1, names: ['pgdata'] } },
      { code: 'redis_ok', level: 'good', params: { container: 'yida_redis', version: '7.4.0' } },
      { code: 'disk_reclaimable', level: 'info', params: { bytes: 671088640, human: '640MB' } },
    ],
  }
}

/** Dockerfile summaries returned by `dockerfiles.list`. */
const DOCKERFILE_ROOTS = ['/srv/app', '/srv/api']
const DOCKERFILE_SCAN = {
  visitedFiles: 120,
  truncated: false,
  errors: [],
  generatedAt: '2026-10-22T06:00:00.000Z',
}
const DOCKERFILE_SUMMARIES = [
  {
    path: '/srv/app/Dockerfile', name: 'Dockerfile', relativePath: 'app/Dockerfile', root: '/srv',
    size: 512, modifiedAt: '2026-10-20T00:00:00.000Z', detectedBy: 'name',
    stageCount: 1, multiStage: false, baseImages: ['nginx:1.31.6'], finalBaseImage: 'nginx:1.31.6',
    exposedPorts: ['80', '443'], instructionCount: 6, healthcheck: true,
    command: 'nginx -g daemon off;', entrypoint: '/docker-entrypoint.sh', cmd: 'nginx -g daemon off;',
    envKeys: ['NODE_ENV', 'TZ'], volumes: ['/data'], contextPath: '/srv/app', suggestedTag: 'app:latest',
  },
  {
    path: '/srv/api/Dockerfile.build', name: 'Dockerfile.build', relativePath: 'api/Dockerfile.build', root: '/srv',
    size: 900, modifiedAt: '2026-10-20T00:00:00.000Z', detectedBy: 'name',
    stageCount: 2, multiStage: true, baseImages: ['golang:1.23', 'alpine:3.20'], finalBaseImage: 'alpine:3.20',
    exposedPorts: ['8080'], instructionCount: 9, healthcheck: false,
    command: '/app/server', entrypoint: '/app/server', cmd: null,
    envKeys: [], volumes: [], contextPath: '/srv/api', suggestedTag: 'api:latest',
  },
]

/** The `dockerfiles.read` value used by the viewer tests. */
const DOCKERFILE_READ = {
  path: '/srv/app/Dockerfile',
  name: 'Dockerfile',
  relativePath: 'app/Dockerfile',
  root: '/srv',
  size: 512,
  modifiedAt: '2026-10-20T00:00:00.000Z',
  content: 'FROM nginx:1.31.6\nCOPY . /usr/share/nginx/html\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n',
  truncated: false,
  parsed: {
    instructions: [
      { instruction: 'FROM', args: 'nginx:1.31.6', line: 1, explanationKey: 'from' },
      { instruction: 'COPY', args: '. /usr/share/nginx/html', line: 2, explanationKey: 'copy' },
      { instruction: 'EXPOSE', args: '80', line: 3, explanationKey: 'expose' },
      { instruction: 'CMD', args: '["nginx", "-g", "daemon off;"]', line: 4, explanationKey: 'cmd' },
    ],
    stages: [{ index: 0, baseImage: 'nginx:1.31.6', name: null, instructions: 4 }],
    warnings: [{ line: 2, message: 'COPY uses the whole build context' }],
    instructionCount: 4,
    stageCount: 1,
    multiStage: false,
    baseImages: ['nginx:1.31.6'],
    finalBaseImage: 'nginx:1.31.6',
    exposedPorts: ['80'],
    command: 'nginx -g daemon off;',
    healthcheck: false,
    envKeys: [],
    volumes: [],
  },
}

/** @param {number} ms - the delay. @returns {Promise<void>} resolves later. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for the serialized post chain to drain by yielding several macrotasks.
 *
 * @returns {Promise<void>} resolves after the queued requests settle.
 */
async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('registers exactly one lazy factory under the package id', () => {
  const { registrations } = loadClient()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, NS)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('factory requires only react and returns inject/apply', () => {
  const { factory, requireCalls } = loadClient()
  assert.deepEqual(requireCalls, ['react'], 'the factory must require react and nothing else')
  // `factory` lives in the VM realm, so normalize its array into this realm.
  assert.deepEqual([...factory.inject], ['slots', 'locale'])
  assert.equal(typeof factory.apply, 'function')
})

test('apply registers complete zh and en dictionaries', () => {
  const { state } = applyClient()
  assert.equal(state.locales.length, 1, 'the locale service is registered exactly once')
  const registration = state.locales[0]
  assert.equal(registration.namespace, NS)
  const { zh, en } = registration.dictionaries
  assert.equal(typeof zh, 'object')
  assert.equal(typeof en, 'object')

  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.ok(zhKeys.length > 150, `expected a full dictionary, got ${zhKeys.length} keys`)
  assert.deepEqual(zhKeys, enKeys, 'both languages must define the same keys')
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
    const zhParams = [...zh[key].matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).sort()
    const enParams = [...en[key].matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(zhParams, enParams, `placeholder mismatch for ${key}`)
  }

  const required = [
    'panel', 'title', 'subtitle', 'refresh', 'retry', 'close', 'loading',
    'tab.docker', 'tab.redis', 'tab.postgres', 'tabs.aria',
    'chip.docker', 'chip.redis', 'chip.postgres',
    'chip.status.ok', 'chip.status.down', 'chip.status.checking', 'chip.status.unknown', 'chip.aria',
    'settings.open', 'settings.close', 'settings.title', 'settings.subtitle',
    'settings.docker.binary', 'settings.redis.host', 'settings.redis.passwordStored',
    'settings.redis.passwordEmpty', 'settings.redis.db', 'settings.redis.tls',
    'settings.postgres.host', 'settings.postgres.user', 'settings.postgres.database',
    'settings.postgres.ssl', 'settings.postgres.ssl.disable', 'settings.postgres.ssl.prefer',
    'settings.postgres.ssl.require', 'settings.clearPassword', 'settings.save',
    'settings.saving', 'settings.saved', 'settings.saveHint', 'settings.test', 'settings.testing',
    'settings.testOk', 'settings.testFailed',
    'docker.filter', 'docker.count', 'docker.countFiltered', 'docker.autoRefresh',
    'docker.empty.title', 'docker.empty.hint', 'docker.filterEmpty.title', 'docker.filterEmpty.hint',
    'docker.unavailable.title', 'docker.unavailable.hint', 'docker.unavailable.action',
    'docker.state.running', 'docker.state.exited', 'docker.state.paused', 'docker.state.created',
    'docker.state.restarting', 'docker.state.dead', 'docker.state.other',
    'docker.action.start', 'docker.action.stop', 'docker.action.restart', 'docker.action.pause',
    'docker.action.unpause', 'docker.action.remove', 'docker.action.logs', 'docker.action.details',
    'docker.action.hideDetails', 'docker.busy', 'docker.portsNone',
    'docker.logs.title', 'docker.logs.tail', 'docker.logs.refresh', 'docker.logs.empty',
    'docker.detail.overview', 'docker.detail.env', 'docker.detail.mounts', 'docker.detail.networks',
    'docker.detail.empty', 'docker.detail.modeRw', 'docker.detail.modeRo',
    'docker.tab.containers', 'docker.tab.images', 'docker.tab.volumes', 'docker.tab.networks',
    'docker.subtabs.aria', 'docker.removing',
    'docker.disk.title', 'docker.disk.images', 'docker.disk.containers', 'docker.disk.volumes',
    'docker.disk.buildCache', 'docker.disk.count', 'docker.disk.reclaimable', 'docker.disk.loading',
    'docker.disk.none',
    'docker.images.count', 'docker.images.loading', 'docker.images.empty.title',
    'docker.images.empty.hint', 'docker.images.untagged', 'docker.images.containers',
    'docker.images.remove',
    'docker.volumes.count', 'docker.volumes.loading', 'docker.volumes.empty.title',
    'docker.volumes.empty.hint', 'docker.volumes.remove',
    'docker.networks.count', 'docker.networks.loading', 'docker.networks.empty.title',
    'docker.networks.empty.hint', 'docker.networks.remove', 'docker.networks.internal',
    'confirm.containerStop.title', 'confirm.containerStop.body', 'confirm.containerStop.action',
    'confirm.containerRestart.title', 'confirm.containerRestart.body', 'confirm.containerRestart.action',
    'confirm.containerPause.title', 'confirm.containerPause.body', 'confirm.containerPause.action',
    'confirm.containerRemove.title', 'confirm.containerRemove.body', 'confirm.containerRemove.action',
    'confirm.imageRemove.title', 'confirm.imageRemove.body', 'confirm.imageRemove.action',
    'confirm.volumeRemove.title', 'confirm.volumeRemove.body', 'confirm.volumeRemove.action',
    'confirm.networkRemove.title', 'confirm.networkRemove.body', 'confirm.networkRemove.action',
    'settings.mode', 'settings.mode.docker', 'settings.mode.manual',
    'settings.target.label', 'settings.target.auto', 'settings.target.stopped',
    'settings.target.noPortShort', 'settings.target.noPort', 'settings.target.noContainer',
    'settings.target.notFound', 'settings.target.dockerUnavailable', 'settings.target.error',
    'settings.target.resolved', 'settings.target.credentials',
    'settings.target.credentials.settings', 'settings.target.credentials.container-env',
    'settings.target.credentials.none', 'settings.target.candidates',
    'settings.target.noCandidates', 'settings.target.containerHint',
    'settings.target.overrideHint', 'settings.redis.passwordDockerHint',
    'settings.postgres.passwordDockerHint',
    'chip.ariaTarget', 'error.dockerInvalidTarget',
    // v0.5
    'docker.tab.dockerfiles', 'dockerfile.banner', 'dockerfile.count', 'dockerfile.roots',
    'dockerfile.rootsNone', 'dockerfile.scan', 'dockerfile.truncated', 'dockerfile.refresh',
    'dockerfile.loading', 'dockerfile.empty.title', 'dockerfile.empty.hint',
    'dockerfile.empty.sampleTitle', 'dockerfile.empty.sampleHint', 'dockerfile.empty.settingsHint',
    'dockerfile.card.base', 'dockerfile.card.baseRole', 'dockerfile.card.noneBase',
    'dockerfile.card.multiStage', 'dockerfile.card.instructions',
    'dockerfile.card.noPorts', 'dockerfile.card.command', 'dockerfile.card.healthcheck',
    'dockerfile.card.env', 'dockerfile.card.volumes', 'dockerfile.card.view',
    'dockerfile.card.copyBuild', 'dockerfile.card.copyPath', 'dockerfile.card.path',
    'dockerfile.port.label', 'dockerfile.port.website', 'dockerfile.port.secure',
    'dockerfile.port.database', 'dockerfile.port.cache', 'dockerfile.port.queue',
    'dockerfile.port.storage', 'dockerfile.port.application',
    'dockerfile.view.title', 'dockerfile.view.loading', 'dockerfile.view.annotated',
    'dockerfile.view.raw', 'dockerfile.view.line', 'dockerfile.view.truncated',
    'dockerfile.view.summary', 'dockerfile.view.stages', 'dockerfile.view.stageName',
    'dockerfile.view.baseImages', 'dockerfile.view.warnings', 'dockerfile.view.warning',
    'dockerfile.view.noWarnings', 'dockerfile.view.close',
    'dockerfile.explain.from', 'dockerfile.explain.run', 'dockerfile.explain.copy',
    'dockerfile.explain.add', 'dockerfile.explain.cmd', 'dockerfile.explain.entrypoint',
    'dockerfile.explain.expose', 'dockerfile.explain.env', 'dockerfile.explain.arg',
    'dockerfile.explain.workdir', 'dockerfile.explain.user', 'dockerfile.explain.volume',
    'dockerfile.explain.healthcheck', 'dockerfile.explain.label', 'dockerfile.explain.other',
    'settings.dockerfiles.title', 'settings.dockerfiles.roots',
    'settings.dockerfiles.rootsHint', 'settings.dockerfiles.maxDepth',
    'settings.dockerfiles.maxDepthHint',
    'overview.service.stat.docker.dockerfiles', 'insight.dockerfiles_found',
    'intent.dockerfiles_found',
    // v0.3
    'tab.relations', 'relations.title', 'relations.subtitle', 'relations.loading',
    'relations.empty.title', 'relations.empty.hint',
    'relations.summary.containers', 'relations.summary.images', 'relations.summary.volumes',
    'relations.summary.networks', 'relations.summary.danglingImages', 'relations.summary.unusedVolumes',
    'relations.summary.running',
    'relations.graph.title', 'relations.graph.legend.images', 'relations.graph.legend.containers',
    'relations.graph.legend.volumes', 'relations.graph.empty', 'relations.graph.networks',
    'relations.table.title', 'relations.table.container', 'relations.table.state',
    'relations.table.image', 'relations.table.volumes', 'relations.table.networks',
    'relations.table.ports', 'relations.table.empty',
    'relations.reverse.title', 'relations.reverse.kind', 'relations.reverse.resource',
    'relations.reverse.all', 'relations.reverse.images', 'relations.reverse.volumes',
    'relations.reverse.networks', 'relations.reverse.count', 'relations.reverse.empty',
    'chip.instances', 'chip.noRunning',
    'instance.bar', 'instance.auto', 'instance.choose', 'instance.saved', 'instance.runningCount',
    'error.ambiguousContainer', 'error.noRunningContainer', 'error.noContainer',
    'error.containerNotFound', 'error.noPublishedPort',
    'settings.target.runningCount', 'settings.target.ambiguous', 'settings.target.noRunning',
    'docker.stateFilter.aria', 'docker.stateFilter.all', 'docker.stateFilter.running',
    'docker.stateFilter.stopped', 'docker.stateFilter.paused',
    'docker.stats.cpu', 'docker.stats.memory', 'docker.filterResource',
    'docker.resourceCountFiltered',
    'docker.inspect.title', 'docker.inspect.loading', 'docker.inspect.close',
    'docker.inspect.containers', 'docker.inspect.exposedPorts', 'docker.inspect.architecture',
    'docker.inspect.os', 'docker.inspect.labels', 'docker.inspect.env',
    'docker.inspect.mountpoint', 'docker.inspect.options', 'docker.inspect.subnets',
    'docker.inspect.gateway', 'docker.inspect.attached', 'docker.inspect.ipv4',
    'docker.inspect.ipv6', 'docker.inspect.anonymous',
    'docker.images.inspect', 'docker.volumes.inspect', 'docker.networks.inspect',
    'redis.server.title', 'redis.server.dbsize', 'redis.server.clients',
    'redis.server.clientsCount', 'redis.server.loading',
    'redis.clients.id', 'redis.clients.addr', 'redis.clients.name', 'redis.clients.age',
    'redis.clients.idle', 'redis.clients.db', 'redis.clients.command', 'redis.clients.user',
    'redis.clients.empty',
    'redis.key.memory', 'redis.key.memory.loading', 'redis.key.rename',
    'redis.key.renamePlaceholder', 'redis.key.renameAction', 'redis.key.expire',
    'redis.key.expirePlaceholder', 'redis.key.expireAction', 'redis.key.persist',
    'redis.key.persistAction', 'redis.key.actions',
    'redis.key.notice.renamed', 'redis.key.notice.expired', 'redis.key.notice.persisted',
    'redis.editor.hash.title', 'redis.editor.hash.field', 'redis.editor.hash.value',
    'redis.editor.list.title', 'redis.editor.list.side', 'redis.editor.list.left',
    'redis.editor.list.right', 'redis.editor.set.title', 'redis.editor.set.member',
    'redis.editor.add', 'redis.editor.remove', 'redis.editor.submit',
    'redis.editor.notice.hashSet', 'redis.editor.notice.listPush',
    'redis.editor.notice.setAdd', 'redis.editor.notice.setRemove',
    'redis.editor.notice.setAbsent', 'redis.editor.unsupported',
    'confirm.redisRename.title', 'confirm.redisRename.body', 'confirm.redisRename.action',
    'confirm.redisExpire.title', 'confirm.redisExpire.body', 'confirm.redisExpire.action',
    'pg.activity.title', 'pg.activity.count', 'pg.activity.empty', 'pg.activity.pid',
    'pg.activity.user', 'pg.activity.database', 'pg.activity.state', 'pg.activity.client',
    'pg.activity.application', 'pg.activity.query', 'pg.activity.duration',
    'pg.activity.wait', 'pg.activity.loading', 'pg.tables.size',
    'pg.detail.columns', 'pg.detail.indexes', 'pg.detail.constraints', 'pg.detail.loading',
    'pg.detail.emptyIndexes', 'pg.detail.emptyConstraints', 'pg.detail.index.name',
    'pg.detail.index.columns', 'pg.detail.index.unique', 'pg.detail.index.primary',
    'pg.detail.constraint.name', 'pg.detail.constraint.type',
    'pg.detail.constraint.definition', 'pg.detail.comment', 'pg.detail.size',
    'pg.detail.estimated', 'pg.detail.tabs',
    'pg.browse.title', 'pg.browse.loading', 'pg.browse.page', 'pg.browse.total',
    'pg.browse.pageSize', 'pg.browse.prev', 'pg.browse.next', 'pg.browse.empty',
    'pg.browse.limited', 'pg.browse.csv', 'pg.browse.csvEmpty', 'pg.browse.csvDone',
    'pg.history.title', 'pg.history.empty', 'pg.history.restore', 'pg.history.restored',
    'redis.summary.version', 'redis.summary.uptime', 'redis.summary.clients', 'redis.summary.memory',
    'redis.summary.keys', 'redis.summary.ops', 'redis.summary.hitRate', 'redis.summary.none',
    'redis.browser.title', 'redis.browser.pattern', 'redis.browser.type', 'redis.browser.typeAny',
    'redis.browser.scan', 'redis.browser.loadMore', 'redis.browser.done', 'redis.browser.scanned',
    'redis.browser.empty.title', 'redis.browser.empty.hint', 'redis.browser.selectHint',
    'redis.key.title', 'redis.key.type', 'redis.key.ttl', 'redis.key.ttl.persistent',
    'redis.key.ttl.missing', 'redis.key.null', 'redis.key.items', 'redis.key.delete',
    'redis.delete.title', 'redis.delete.body', 'redis.delete.action',
    'redis.set.title', 'redis.set.key', 'redis.set.value', 'redis.set.ttl', 'redis.set.submit',
    'redis.set.saving', 'redis.set.success', 'redis.set.successTtl',
    'pg.status', 'pg.database', 'pg.tables', 'pg.tables.count', 'pg.tables.filter',
    'pg.tables.loading', 'pg.tables.empty.title', 'pg.tables.empty.hint',
    'pg.tables.emptyFilter.title', 'pg.tables.emptyFilter.hint',
    'pg.kind.table', 'pg.kind.view', 'pg.kind.materializedView', 'pg.kind.foreignTable',
    'pg.yes', 'pg.no', 'pg.columns.title', 'pg.columns.name', 'pg.columns.type',
    'pg.columns.nullable', 'pg.columns.default', 'pg.columns.empty', 'pg.columns.loading',
    'pg.preview', 'pg.preview.loading', 'pg.preview.title',
    'pg.query.title', 'pg.query.placeholder', 'pg.query.run', 'pg.query.running', 'pg.query.hint',
    'pg.query.empty', 'pg.query.failed', 'pg.query.sqlState', 'pg.query.detail',
    'pg.query.hintField', 'pg.query.position', 'pg.query.duration', 'pg.query.truncated',
    'pg.query.rows', 'pg.query.affected', 'pg.null',
    'error.unreachable', 'error.refused', 'error.dockerUnavailable', 'error.redisAuth',
    'error.pgAuth', 'error.invalidPayload',
    'confirm.cancel', 'confirm.cancelHint',
  ]
  for (const key of required) assert.ok(key in zh && key in en, `missing dictionary key: ${key}`)

  // The dictionaries are genuinely two languages, not copies.
  for (const key of ['title', 'subtitle', 'docker.filter', 'settings.save', 'pg.tables']) {
    assert.notEqual(zh[key], en[key], `${key} must differ between the languages`)
  }
  assert.match(zh.title, /[\u4e00-\u9fff]/)
})

test('apply injects the main panel and the sidebar entry with the contract ids', () => {
  const { state, client } = applyClient()
  assert.deepEqual(state.injects, ['main', 'sidebar.panellist'])

  const main = state.slots.find((slot) => slot.options.name === 'main')
  assert.ok(main, 'a main panel must be registered')
  assert.equal(main.options.key, PANEL_ID)
  assert.equal(main.options.locale, NS)
  assert.equal(typeof main.component, 'function', 'the main panel component must be a function')
  assert.equal(typeof main.options.inject, 'function', 'the main slot must inject the data client')
  assert.equal(main.options.inject().client, client)

  assert.equal(typeof client.getSnapshot, 'function')
  assert.equal(typeof client.subscribe, 'function')
  for (const method of [
    'bootstrap', 'refresh', 'selectTab', 'toggleSettings', 'loadDocker', 'dockerAction',
    'toggleLogs', 'loadLogs', 'toggleDetail', 'loadDetail', 'loadRedis', 'scanRedis',
    'scanMore', 'selectRedisKey', 'submitRedisSet', 'deleteRedisKey', 'loadPostgres',
    'selectDatabase', 'selectTable', 'previewTable', 'runPgQuery', 'saveSettings',
    'testConnection', 'startDockerPolling',
  ]) {
    assert.equal(typeof client[method], 'function', `the client must expose ${method}`)
  }

  const sidebar = state.slots.find((slot) => slot.options.name === 'sidebar.panellist')
  assert.ok(sidebar, 'a sidebar entry must be registered')
  assert.equal(sidebar.options.id, PANEL_ID)
  assert.equal(sidebar.options.order, PANEL_ORDER)
  assert.equal(sidebar.options.locale, NS)
  assert.equal(typeof sidebar.component, 'function', 'the rail icon must be a function')
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), 'panel', 'the rail label goes through the bound translator')
})

test('apply injects one stylesheet through ctx.effect and cleans it up', () => {
  const { state, load } = applyClient()
  const labels = state.effects.map((effect) => effect.label)
  assert.ok(labels.includes(`${NS}: dictionaries`), 'the dictionaries must be installed as an effect')
  assert.ok(labels.includes(`${NS}: styles`), 'the stylesheet must be installed as an effect')

  assert.equal(load.document.appended.length, 1, 'exactly one <style> must be appended')
  const tag = load.document.appended[0]
  assert.equal(tag.tagName, 'STYLE')
  assert.equal(tag.dataset.plugin, NS)
  assert.equal(tag.dataset.pluginCss, STYLE_ID)
  assert.ok(tag.textContent.includes('--dsw-alias-'), 'the stylesheet must use theme tokens')
  assert.ok(tag.textContent.includes('.dshDataPage'), 'the stylesheet must be namespaced')

  const stylesEffect = state.effects.find((effect) => effect.label === `${NS}: styles`)
  stylesEffect.cleanup()
  assert.equal(tag.removed, true, 'the effect cleanup must remove the injected style')
  assert.equal(load.document.appended.length, 0)
})

test('source obeys the hard client constraints', () => {
  assert.equal(CLIENT_SOURCE.includes('document.body'), false, 'never touch document.body')
  assert.equal(CLIENT_SOURCE.includes('document.write'), false, 'never write the document')
  assert.equal(CLIENT_SOURCE.includes('innerHTML'), false, 'no innerHTML writes')
  assert.equal(CLIENT_SOURCE.includes('@deepseek-ai'), false, 'no Harness Client package references')
  assert.equal(CLIENT_SOURCE.includes('react-dom'), false, 'the shell provides react only')
  assert.equal((CLIENT_SOURCE.match(/require\('/g) || []).length, 1, "only require('react') is allowed")
  assert.equal((CLIENT_SOURCE.match(/^\s*(import|export)\b/gm) || []).length, 0, 'no ESM syntax inside the bundle')
  assert.equal(/=>\s*<[A-Za-z]/.test(CLIENT_SOURCE), false, 'no JSX')
  assert.equal(CLIENT_SOURCE.includes('window.__ModuleLoader__.load('), true, 'the bundle registers through the module loader')
  assert.ok(CLIENT_SOURCE.includes(`id: '${NS}'`), 'the registration id is the package name')
  assert.ok(CLIENT_SOURCE.includes(`'${API_PATH}'`), 'the panel posts to the contract route')
  assert.ok(CLIENT_SOURCE.includes('API_PATH, {'), 'the route is reached through fetch')
  assert.ok(CLIENT_SOURCE.includes("method: 'POST'"), 'the panel posts rather than gets')
  assert.ok(CLIENT_SOURCE.includes("credentials: 'same-origin'"), 'the authenticated /api channel carries the session')
  assert.ok(CLIENT_SOURCE.includes('endpoint,'), 'the body carries the endpoint')
  assert.ok(CLIENT_SOURCE.includes('setInterval'), 'the Docker tab polls')
  assert.ok(CLIENT_SOURCE.includes('clearInterval'), 'the poll interval is cleaned up')
})

test('stylesheet keeps chrome on the contract theme tokens and the plugin prefix', () => {
  const match = CLIENT_SOURCE.match(/const css = `([\s\S]*?)`\n\n    \/\*\* The `<style>` element id/)
  assert.ok(match, 'the stylesheet template must be present')
  const css = match[1]

  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no literal hex colors in chrome styles')
  assert.equal(/\b(?:rgb|rgba|hsl|hsla)\(/.test(css), false, 'no raw color functions in chrome styles')

  const variables = [...new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((entry) => entry[1]))]
  assert.ok(variables.length > 10, 'the stylesheet must be theme-token driven')
  const allowed = [/^--dsw-alias-/, /^--dsw-radius-/, /^--dsw-elevation-/, /^--dsw-mask-/, /^--dsw-focus-ring-color$/]
  for (const name of variables) {
    assert.ok(allowed.some((pattern) => pattern.test(name)), `unexpected CSS variable in chrome styles: ${name}`)
  }

  const classes = [...new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((entry) => entry[1]))]
  assert.ok(classes.length > 100, `expected a complete stylesheet, got ${classes.length} classes`)
  for (const name of classes) {
    assert.ok(name.startsWith('dshData'), `CSS class must be prefixed with dshData: ${name}`)
  }

  assert.ok(css.includes('prefers-reduced-motion:reduce'), 'motion must respect prefers-reduced-motion')
  for (const selector of [
    '.dshDataPage',
    '.dshDataChip',
    '.dshDataTab',
    '.dshDataDockerRow',
    '.dshDataSubTab',
    '.dshDataTargetBox',
    '.dshDataRelSvg',
    '.dshDataInstanceBar',
    '.dshDataPill',
    '.dshDataChipLink',
    '.dshDataModal',
    '.dshDataEditor',
    '.dshDataDockerMetrics',
    '.dshDataHistoryList',
    '.dshDataBrowseBar',
    '.dshDataSeg',
    '.dshDataChipTarget',
    '.dshDataStatMeta',
    '.dshDataLogs',
    '.dshDataKeyList',
    '.dshDataValue',
    '.dshDataGrid',
    '.dshDataSettings',
    '.dshDataDialog',
  ]) {
    assert.ok(css.includes(selector), `the stylesheet must style ${selector}`)
  }
})

test('bootstrap reads state, adopts the redacted settings and probes both services', async () => {
  const recorder = bootstrapRecorder()
  const { client } = applyClient({ fetch: recorder.fetch })

  assert.equal(await client.bootstrap(), true)
  const snapshot = client.getSnapshot()
  assert.equal(snapshot.boot, 'ready')
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.version, '0.3.0')
  assert.equal(snapshot.dockerInfo.available, true)
  assert.equal(snapshot.connections.docker.status, 'ok')
  assert.equal(snapshot.connections.docker.detail, '27.1.1')
  assert.equal(snapshot.connections.redis.status, 'ok')
  assert.equal(snapshot.connections.redis.detail, '7.4.0')
  assert.equal(snapshot.connections.postgres.status, 'ok')
  assert.equal(snapshot.connections.postgres.detail, '16.3')
  assert.equal(snapshot.settings.postgres.database, 'yida')
  assert.equal(snapshot.settings.redis.hasPassword, true)
  // v0.2: Docker-container mode is the default and the targets come from state.
  assert.equal(snapshot.settings.redis.mode, 'docker')
  assert.equal(snapshot.settings.postgres.mode, 'docker')
  assert.equal(snapshot.targets.redis.candidates.length, 2)
  assert.equal(snapshot.targets.redis.candidates[0].name, 'yida_redis')
  assert.equal(snapshot.targets.redis.candidates[1].running, false)
  assert.equal(snapshot.targets.redis.resolved.port, 56379)
  assert.equal(snapshot.targets.postgres.resolved.container, 'yida_postgres')
  // The form starts from the redacted view; passwords are never pre-filled.
  assert.equal(snapshot.form.redis.host, '127.0.0.1')
  assert.equal(snapshot.form.redis.port, '6379')
  assert.equal(snapshot.form.redis.password, '')
  assert.equal(snapshot.form.redis.mode, 'docker')
  assert.equal(snapshot.form.redis.container, '')
  assert.equal(snapshot.form.postgres.mode, 'docker')
  assert.equal(snapshot.form.postgres.user, 'yida_postgres')
  assert.equal(snapshot.formDirty, false)

  // Every request is a POST of the contract body to the contract route.
  const first = recorder.calls[0]
  assert.equal(first.url, API_PATH)
  assert.equal(first.init.method, 'POST')
  assert.equal(first.init.credentials, 'same-origin')
  assert.equal(first.init.headers['content-type'], 'application/json')
  assert.equal(first.body.endpoint, 'state')
  assert.deepEqual(first.body.payload, {})
  const endpoints = recorder.calls.map((call) => call.body.endpoint)
  assert.deepEqual(endpoints.slice(0, 3), ['state', 'redis.ping', 'pg.version'])
})

test('failure classification separates an unreachable Host from a refused request', async () => {
  const down = applyClient({
    fetch: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:4310')
    },
  })
  assert.equal(await down.client.bootstrap(), false)
  let snapshot = down.client.getSnapshot()
  assert.equal(snapshot.boot, 'error')
  assert.equal(snapshot.error.code, 'data_unreachable')
  assert.match(snapshot.error.message, /ECONNREFUSED/)

  const refused = applyClient({ fetch: bootstrapRecorder().fetch })
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'docker.list') return hostErrorResponse('docker_unavailable', 'docker: command not found')
    if (body.endpoint === 'state') return jsonResponse(stateValue({ available: false, version: null, error: 'docker: command not found' }))
    if (body.endpoint === 'redis.ping') return hostErrorResponse('redis_auth_failed', 'WRONGPASS invalid username-password pair')
    if (body.endpoint === 'pg.version') return hostErrorResponse('pg_auth_failed', 'password authentication failed')
    return jsonResponse({})
  })
  void refused
  const blocked = applyClient({ fetch: recorder.fetch })
  await blocked.client.bootstrap()
  snapshot = blocked.client.getSnapshot()
  // A Host that answers and refuses is not an unreachable Host: the code and
  // the reason it named are carried through.
  assert.equal(snapshot.boot, 'ready')
  assert.equal(snapshot.connections.docker.status, 'down')
  assert.equal(snapshot.connections.redis.status, 'down')
  assert.equal(snapshot.connections.redis.detail, 'WRONGPASS invalid username-password pair')
  assert.equal(snapshot.connections.postgres.status, 'down')

  assert.equal(await blocked.client.loadDocker(), false)
  snapshot = blocked.client.getSnapshot()
  assert.equal(snapshot.docker.status, 'error')
  assert.equal(snapshot.docker.error.code, 'docker_unavailable')
  assert.equal(snapshot.docker.error.message, 'docker: command not found')
})

test('docker list, filter, actions, logs and details go through the Host', async () => {
  const containers = [
    {
      id: 'aaaa1111bbbb', shortId: 'aaaa1111', name: 'web', image: 'nginx:latest',
      command: 'nginx -g daemon off;', state: 'running', status: 'Up 2 hours (healthy)',
      ports: [{ host: '8080', container: '80', protocol: 'tcp', ip: '0.0.0.0' }],
      createdAt: '2026-10-01T00:00:00.000Z', runningFor: '2 hours',
    },
    {
      id: 'cccc2222dddd', shortId: 'cccc2222', name: 'worker', image: 'busybox:latest',
      command: 'sh', state: 'exited', status: 'Exited (0) 5 minutes ago',
      ports: [], createdAt: '2026-10-01T00:00:00.000Z', runningFor: '5 minutes',
    },
  ]
  const detail = Object.assign({}, containers[0], {
    env: [{ key: 'NODE_ENV', value: 'production' }],
    mounts: [{ source: '/srv/web', destination: '/usr/share/nginx/html', mode: 'rw', rw: true }],
    networks: [{ name: 'bridge', ipAddress: '172.17.0.2' }],
    health: 'healthy', restartCount: 0, exitCode: 0, platform: 'linux/arm64',
    entrypoint: '/docker-entrypoint.sh', cmd: 'nginx -g daemon off;', logPath: '/var/lib/docker/log',
  })
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'docker.list') return jsonResponse({ containers, count: containers.length })
    if (body.endpoint === 'docker.action') return jsonResponse({ id: body.payload.id, action: body.payload.action, ok: true })
    if (body.endpoint === 'docker.logs') return jsonResponse({ id: body.payload.id, name: 'web', logs: 'line one\nline two' })
    if (body.endpoint === 'docker.inspect') return jsonResponse({ container: detail })
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })

  assert.equal(await client.loadDocker(), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.status, 'ready')
  assert.equal(snapshot.docker.containers.length, 2)
  assert.equal(snapshot.connections.docker.status, 'ok')

  client.setDockerFilter('work')
  assert.equal(client.getSnapshot().docker.filter, 'work')

  assert.equal(await client.dockerAction('aaaa1111bbbb', 'restart'), true)
  const actionCall = recorder.calls.find((call) => call.body.endpoint === 'docker.action')
  assert.deepEqual(actionCall.body.payload, { id: 'aaaa1111bbbb', action: 'restart' })
  snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.busy, '')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'docker.list').length, 2, 'an action reloads the list')

  client.toggleLogs('aaaa1111bbbb', 'web')
  assert.equal(client.getSnapshot().docker.logs.status, 'loading')
  await client.loadLogs()
  snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.logs.status, 'ready')
  assert.equal(snapshot.docker.logs.text, 'line one\nline two')
  const logsCall = recorder.calls.find((call) => call.body.endpoint === 'docker.logs')
  assert.equal(logsCall.body.payload.id, 'aaaa1111bbbb')
  assert.equal(logsCall.body.payload.tail, 200)

  client.setLogTail(500)
  await client.loadLogs()
  const tailCall = recorder.calls.filter((call) => call.body.endpoint === 'docker.logs').at(-1)
  assert.equal(tailCall.body.payload.tail, 500)

  client.toggleDetail('aaaa1111bbbb', 'web')
  await client.loadDetail()
  snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.detail.status, 'ready')
  assert.equal(snapshot.docker.detail.container.env[0].key, 'NODE_ENV')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'docker.inspect').length, 1)

  client.toggleLogs('aaaa1111bbbb', 'web')
  assert.equal(client.getSnapshot().docker.logs.id, '', 'toggling the same drawer closes it')
  client.toggleDetail('aaaa1111bbbb', 'web')
  assert.equal(client.getSnapshot().docker.detail.id, '')
})

test('docker remove goes through the action endpoint and closes the drawers', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'docker.list') return jsonResponse({ containers: [{ id: 'zz', shortId: 'zz', name: 'gone', image: 'x', state: 'exited', status: 'Exited', ports: [] }], count: 1 })
    if (body.endpoint === 'docker.action') return jsonResponse({ id: body.payload.id, action: body.payload.action, ok: true })
    if (body.endpoint === 'docker.logs') return jsonResponse({ id: 'zz', name: 'gone', logs: 'bye' })
    if (body.endpoint === 'docker.inspect') return jsonResponse({ container: { id: 'zz', name: 'gone' } })
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.loadDocker()
  client.toggleLogs('zz', 'gone')
  await client.loadLogs()
  client.toggleDetail('zz', 'gone')
  await client.loadDetail()
  assert.equal(await client.dockerAction('zz', 'remove'), true)
  const removeCall = recorder.calls.find((call) => call.body.endpoint === 'docker.action')
  assert.deepEqual(removeCall.body.payload, { id: 'zz', action: 'remove' })
  const snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.logs.id, '', 'a removed container loses its logs drawer')
  assert.equal(snapshot.docker.detail.id, '', 'a removed container loses its details drawer')
})

test('redis overview, scan pagination, key inspection, write and delete work', async () => {
  const summary = {
    version: '7.4.0',
    uptimeSeconds: 93784,
    connectedClients: 3,
    usedMemoryHuman: '1.25M',
    usedMemoryBytes: 1310720,
    totalKeys: 42,
    opsPerSec: 12,
    hitRate: 0.9876,
    role: 'master',
  }
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'redis.info') return jsonResponse({ summary, sections: {} })
    if (body.endpoint === 'redis.scan') {
      if (body.payload.cursor === '0') return jsonResponse({ cursor: '12', keys: ['user:1', 'user:2'], done: false })
      return jsonResponse({ cursor: '0', keys: ['user:3'], done: true })
    }
    if (body.endpoint === 'redis.get') return jsonResponse({ key: body.payload.key, type: 'string', ttl: -1, value: 'hello' })
    if (body.endpoint === 'redis.set') return jsonResponse({ key: body.payload.key, ttl: 30 })
    if (body.endpoint === 'redis.del') return jsonResponse({ key: body.payload.key, deleted: 1 })
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })

  assert.equal(await client.loadRedis(), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.status, 'ready')
  assert.equal(snapshot.redis.summary.version, '7.4.0')
  assert.equal(snapshot.redis.summary.totalKeys, 42)
  assert.equal(snapshot.redis.scan.loaded, true)
  assert.deepEqual([...snapshot.redis.scan.keys], ['user:1', 'user:2'])
  assert.equal(snapshot.redis.scan.done, false)

  assert.equal(await client.scanMore(), true)
  snapshot = client.getSnapshot()
  assert.deepEqual([...snapshot.redis.scan.keys], ['user:1', 'user:2', 'user:3'])
  assert.equal(snapshot.redis.scan.done, true)
  assert.equal(snapshot.redis.scan.scanned, 3)

  client.setRedisScan('match', 'user:*')
  client.setRedisScan('type', 'string')
  await client.scanRedis()
  const scanCall = recorder.calls.filter((call) => call.body.endpoint === 'redis.scan').at(-1)
  assert.deepEqual(scanCall.body.payload, { cursor: '0', match: 'user:*', count: 100, type: 'string' })

  assert.equal(await client.selectRedisKey('user:1'), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.selected.detail.type, 'string')
  assert.equal(snapshot.redis.selected.detail.value, 'hello')
  assert.equal(snapshot.redis.selected.detail.ttl, -1)

  client.setRedisField('key', 'cache:token')
  client.setRedisField('value', 'abc')
  client.setRedisField('ttl', '30')
  assert.equal(await client.submitRedisSet(), true)
  const setCall = recorder.calls.find((call) => call.body.endpoint === 'redis.set')
  assert.deepEqual(setCall.body.payload, { key: 'cache:token', value: 'abc', ttlSeconds: 30 })
  snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.setting, false)
  assert.equal(snapshot.redis.setNotice.key, 'cache:token')

  // An empty TTL field means "no expiry": the key is omitted entirely.
  client.setRedisField('ttl', '')
  await client.submitRedisSet()
  const noTtlCall = recorder.calls.filter((call) => call.body.endpoint === 'redis.set').at(-1)
  assert.equal('ttlSeconds' in noTtlCall.body.payload, false)

  assert.equal(await client.deleteRedisKey('user:2'), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.scan.keys.includes('user:2'), false)
  assert.equal(snapshot.redis.deleting, false)
})

test('a failed redis write is reported and cleared by the next attempt', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'redis.set') {
      if (body.payload.value === 'bad') return hostErrorResponse('redis_command_failed', 'ERR wrong number of arguments')
      return jsonResponse({ key: body.payload.key, ttl: null })
    }
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  client.setRedisField('key', 'k')
  client.setRedisField('value', 'bad')
  assert.equal(await client.submitRedisSet(), false)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.setError.code, 'redis_command_failed')
  assert.equal(snapshot.redis.setting, false)

  client.setRedisField('value', 'good')
  assert.equal(client.getSnapshot().redis.setError, null, 'editing clears the previous failure')
  assert.equal(await client.submitRedisSet(), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.setError, null)
  assert.equal(snapshot.redis.setNotice.key, 'k')
})

test('postgres loads databases, tables, columns, preview and SQL through the contract payloads', async () => {
  const tables = [
    { schema: 'public', name: 'users', kind: 'table', estimatedRows: 3 },
    { schema: 'public', name: 'v_active', kind: 'view', estimatedRows: null },
  ]
  const columns = [
    { name: 'id', dataType: 'int4', nullable: false, defaultValue: "nextval('users_id_seq')" },
    { name: 'email', dataType: 'text', nullable: false, defaultValue: null },
  ]
  const result = {
    database: 'yida',
    durationMs: 4,
    truncated: false,
    results: [{ command: 'SELECT 2', columns: [{ name: 'id', dataType: 'int4' }, { name: 'email', dataType: 'text' }], rows: [['1', 'a@b.c'], ['2', null]], rowCount: 2 }],
  }
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'state') return jsonResponse(stateValue())
    if (body.endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 1, version: '7.4.0' })
    if (body.endpoint === 'pg.version') {
      return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
    }
    if (body.endpoint === 'pg.databases') {
      return jsonResponse({ databases: [{ name: 'yida', owner: 'yida_postgres', encoding: 'UTF8', size: '8 MB', sizeBytes: 8388608 }, { name: 'postgres', owner: 'postgres', encoding: 'UTF8', size: '8 MB', sizeBytes: 8388608 }] })
    }
    if (body.endpoint === 'pg.tables') {
      return jsonResponse({ database: body.payload.database === undefined ? 'yida' : body.payload.database, schema: null, tables })
    }
    if (body.endpoint === 'pg.tableDetail') {
      return jsonResponse({
        database: 'yida',
        schema: body.payload.schema,
        table: body.payload.table,
        size: '8 MB',
        estimatedRows: 3,
        comment: null,
        columns,
        indexes: [{ name: 'users_pkey', columns: ['id'], unique: true, primary: true }],
        constraints: [{ name: 'users_pkey', type: 'primary key', definition: 'PRIMARY KEY (id)' }],
      })
    }
    if (body.endpoint === 'pg.browse') {
      return jsonResponse({ database: 'yida', schema: body.payload.schema, table: body.payload.table, columns, rows: [['1', 'a@b.c']], rowCount: 1, totalRows: 1, limitedBy: null })
    }
    if (body.endpoint === 'pg.activity') return jsonResponse({ sessions: [] })
    if (body.endpoint === 'pg.query') return jsonResponse(result)
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()

  // The bootstrap probe already read pg.version, so opening the tab must reuse
  // it and only fetch databases + tables.
  assert.equal(await client.selectTab('postgres'), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.tab, 'postgres')
  assert.equal(snapshot.postgres.status, 'ready')
  assert.equal(snapshot.postgres.version.value.currentUser, 'yida_postgres')
  assert.equal(snapshot.postgres.database, 'yida')
  assert.equal(snapshot.postgres.tables.list.length, 2)
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'pg.version').length, 1)
  const tablesCall = recorder.calls.find((call) => call.body.endpoint === 'pg.tables')
  assert.equal(tablesCall.body.payload.database, 'yida')

  client.setPgFilter('v_')
  assert.equal(client.getSnapshot().postgres.filter, 'v_')

  assert.equal(await client.selectDatabase('postgres'), true)
  const dbTablesCall = recorder.calls.filter((call) => call.body.endpoint === 'pg.tables').at(-1)
  assert.equal(dbTablesCall.body.payload.database, 'postgres')

  assert.equal(await client.selectTable('public', 'users'), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.selected.schema, 'public')
  assert.equal(snapshot.postgres.selected.name, 'users')
  assert.equal(snapshot.postgres.selected.columns.list.length, 2)
  assert.equal(snapshot.postgres.selected.detail.value.size, '8 MB')
  const detailCall = recorder.calls.find((call) => call.body.endpoint === 'pg.tableDetail')
  assert.deepEqual(detailCall.body.payload, { schema: 'public', table: 'users', database: 'postgres' })

  assert.equal(await client.previewTable(), true)
  const previewCall = recorder.calls.filter((call) => call.body.endpoint === 'pg.query').at(-1)
  assert.equal(previewCall.body.payload.sql, 'select * from "public"."users" limit 100')
  assert.equal(previewCall.body.payload.maxRows, 100)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.selected.preview.result.results[0].rows.length, 2)

  client.setPgSql('select 1')
  assert.equal(await client.runPgQuery(), true)
  const queryCall = recorder.calls.filter((call) => call.body.endpoint === 'pg.query').at(-1)
  assert.equal(queryCall.body.payload.sql, 'select 1')
  assert.equal(queryCall.body.payload.maxRows, 200)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.query.status, 'ready')
  assert.equal(snapshot.postgres.query.result.durationMs, 4)
})

test('a SQL failure keeps the SQLSTATE and the statement available for a retry', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'pg.query') {
      return hostErrorResponse('pg_query_failed', 'syntax error at or near "selct"', { sqlState: '42601', position: '1' })
    }
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  client.setPgSql('selct 1')
  assert.equal(await client.runPgQuery(), false)
  const snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.query.status, 'error')
  assert.equal(snapshot.postgres.query.error.code, 'pg_query_failed')
  assert.equal(snapshot.postgres.query.error.details.sqlState, '42601')
  assert.equal(snapshot.postgres.sql, 'selct 1', 'the statement stays in the editor')
})

test('settings save keeps stored passwords when the field is left empty', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'state') return jsonResponse(stateValue())
    if (body.endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 1, version: '7.4.0' })
    if (body.endpoint === 'pg.version') {
      return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
    }
    if (body.endpoint === 'settings.save') {
      const settings = redactedSettings()
      if (body.payload.redis !== undefined) {
        settings.redis.host = body.payload.redis.host ?? settings.redis.host
        settings.redis.port = body.payload.redis.port ?? settings.redis.port
      }
      if (body.payload.postgres !== undefined && body.payload.postgres.password !== undefined) {
        settings.postgres.hasPassword = true
      }
      return jsonResponse(settings)
    }
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()

  client.setSettingsField('redis', 'host', '10.0.0.9')
  client.setSettingsField('redis', 'port', '6380')
  client.setSettingsField('docker', 'binary', '/usr/local/bin/docker')
  assert.equal(client.getSnapshot().formDirty, true)
  assert.equal(await client.saveSettings(), true)

  const saveCall = recorder.calls.find((call) => call.body.endpoint === 'settings.save')
  assert.ok(saveCall, 'the save must post settings.save')
  assert.equal(saveCall.body.payload.redis.host, '10.0.0.9')
  assert.equal(saveCall.body.payload.redis.port, 6380)
  assert.equal(saveCall.body.payload.docker.binary, '/usr/local/bin/docker')
  assert.equal('password' in saveCall.body.payload.redis, false, 'an empty password must not overwrite the stored one')
  assert.equal('password' in saveCall.body.payload.postgres, false)
  assert.equal('clearPassword' in saveCall.body.payload.redis, false)

  const snapshot = client.getSnapshot()
  assert.equal(snapshot.saving, false)
  assert.equal(snapshot.saveNotice, true)
  assert.equal(snapshot.formDirty, false)
  assert.equal(snapshot.settings.redis.hasPassword, true)
  assert.equal(snapshot.form.redis.password, '', 'the form does not retain the secret')
})

test('settings save sends typed passwords and an explicit clear', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'state') {
      // The save below clears the Redis password; the refreshed state reflects it.
      const settings = redactedSettings()
      settings.redis.hasPassword = false
      return jsonResponse({ version: '0.3.0', settings, docker: { available: true, binary: 'docker', version: '27.1.1', error: null }, targets: targetsValue() })
    }
    if (body.endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 1, version: '7.4.0' })
    if (body.endpoint === 'pg.version') {
      return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
    }
    if (body.endpoint === 'settings.save') {
      const settings = redactedSettings()
      settings.redis.hasPassword = false
      return jsonResponse(settings)
    }
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()

  client.setSettingsField('redis', 'password', 'localredis')
  client.setSettingsField('redis', 'clearPassword', true)
  await client.saveSettings()
  const saveCall = recorder.calls.find((call) => call.body.endpoint === 'settings.save')
  assert.equal(saveCall.body.payload.redis.password, 'localredis')
  assert.equal(saveCall.body.payload.redis.clearPassword, true)
  assert.equal(client.getSnapshot().settings.redis.hasPassword, false)
})

test('connection tests update the header chips and report their result', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'state') return jsonResponse(stateValue())
    if (body.endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 2, version: '7.4.0' })
    if (body.endpoint === 'pg.version') {
      return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
    }
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()

  assert.equal(await client.testConnection('redis'), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.test.service, 'redis')
  assert.equal(snapshot.test.status, 'ok')
  assert.match(snapshot.test.message, /7\.4\.0/)
  assert.equal(snapshot.connections.redis.status, 'ok')

  assert.equal(await client.testConnection('postgres'), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.test.service, 'postgres')
  assert.equal(snapshot.test.status, 'ok')
  assert.match(snapshot.test.message, /16\.3/)
  assert.equal(snapshot.connections.postgres.status, 'ok')

  const failing = hostRecorder((body) => {
    if (body.endpoint === 'redis.ping') return hostErrorResponse('redis_auth_failed', 'WRONGPASS')
    return jsonResponse({})
  })
  const failed = applyClient({ fetch: failing.fetch })
  assert.equal(await failed.client.testConnection('redis'), false)
  snapshot = failed.client.getSnapshot()
  assert.equal(snapshot.test.status, 'error')
  assert.equal(snapshot.test.error.code, 'redis_auth_failed')
  assert.equal(snapshot.connections.redis.status, 'down')
})

test('docker polling refreshes only while the Docker tab is visible and stops cleanly', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'docker.list') return jsonResponse({ containers: [], count: 0 })
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.selectTab('docker')

  const stop = client.startDockerPolling(10)
  assert.equal(typeof stop, 'function')
  await sleep(90)
  const pollingCalls = recorder.calls.filter((call) => call.body.endpoint === 'docker.list').length
  assert.ok(pollingCalls >= 2, `expected the poll to read the list repeatedly, got ${pollingCalls}`)
  stop()
  await sleep(60)
  const afterStop = recorder.calls.filter((call) => call.body.endpoint === 'docker.list').length
  assert.equal(afterStop, pollingCalls, 'stopping the poll must clear the interval')

  // The tick is scoped to the Docker tab: another tab means no container calls.
  await client.selectTab('redis')
  const before = recorder.calls.filter((call) => call.body.endpoint === 'docker.list').length
  const stopSecond = client.startDockerPolling(10)
  await sleep(70)
  const during = recorder.calls.filter((call) => call.body.endpoint === 'docker.list').length
  stopSecond()
  assert.equal(during, before, 'the Docker poll must stay idle while another tab is visible')
})

test('tab switching and the settings toggle remember where to return', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'docker.list') return jsonResponse({ containers: [], count: 0 })
    return jsonResponse({})
  })
  const { client } = applyClient({ fetch: recorder.fetch })
  assert.equal(client.getSnapshot().tab, 'overview', 'the panel opens on the overview page')

  void client.toggleSettings()
  assert.equal(client.getSnapshot().tab, 'settings')
  void client.toggleSettings()
  assert.equal(client.getSnapshot().tab, 'overview', 'closing settings returns to the previous tab')

  await client.selectTab('redis')
  assert.equal(client.getSnapshot().tab, 'redis')
  void client.toggleSettings()
  assert.equal(client.getSnapshot().lastTab, 'redis')
  void client.toggleSettings()
  assert.equal(client.getSnapshot().tab, 'redis')

  void client.openSettings()
  assert.equal(client.getSnapshot().tab, 'settings')
  assert.equal(await client.selectTab('nope'), false, 'an unknown tab is refused')
  assert.equal(client.getSnapshot().tab, 'settings')
})

test('subscribers are notified after every snapshot change and can unsubscribe', () => {
  const { client } = applyClient()
  let calls = 0
  const unsubscribe = client.subscribe(() => {
    calls += 1
  })
  client.setDockerFilter('web')
  assert.equal(calls, 1)
  assert.equal(client.getSnapshot().docker.filter, 'web')
  unsubscribe()
  client.setDockerFilter('db')
  assert.equal(calls, 1, 'an unsubscribed listener is not called')
})

test('container stop/restart/pause/remove ask for confirmation before the Host is called', async () => {
  const recorder = hostRecorder(dockerV2Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.loadDocker()
  const actionCalls = () => recorder.calls.filter((call) => call.body.endpoint === 'docker.action')

  for (const action of ['stop', 'restart', 'pause', 'remove']) {
    const before = actionCalls().length
    assert.equal(await client.requestContainerAction(CONTAINER_RUNNING.id, 'web', action), true)
    const confirm = client.getSnapshot().confirm
    assert.equal(confirm.kind, `container.${action}`)
    assert.equal(confirm.name, 'web')
    assert.equal(actionCalls().length, before, `no docker.action may be sent before confirming ${action}`)

    client.cancelConfirm()
    assert.equal(client.getSnapshot().confirm, null)
    assert.equal(actionCalls().length, before, 'a cancelled confirmation calls nothing')

    await client.requestContainerAction(CONTAINER_RUNNING.id, 'web', action)
    assert.equal(await client.acceptConfirm(), true)
    assert.equal(client.getSnapshot().confirm, null)
    assert.equal(actionCalls().length, before + 1)
    assert.deepEqual(actionCalls().at(-1).body.payload, { id: CONTAINER_RUNNING.id, action })
  }

  // start and unpause stay one-click actions.
  assert.equal(await client.dockerAction(CONTAINER_RUNNING.id, 'start'), true)
  assert.equal(client.getSnapshot().confirm, null)
  assert.deepEqual(actionCalls().at(-1).body.payload, { id: CONTAINER_RUNNING.id, action: 'start' })
})

test('image, volume and network removals confirm and post the documented payloads', async () => {
  const recorder = hostRecorder(dockerV2Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  const count = (endpoint) => recorder.calls.filter((call) => call.body.endpoint === endpoint).length
  await client.loadImages()
  await client.loadVolumes()
  await client.loadNetworks()
  await client.loadDiskUsage()
  const diskBefore = count('docker.diskUsage')

  client.requestImageRemove(IMAGE_ONE.id, 'nginx:latest')
  let confirm = client.getSnapshot().confirm
  assert.equal(confirm.kind, 'image.remove')
  assert.equal(confirm.id, IMAGE_ONE.id)
  assert.equal(confirm.name, 'nginx:latest')
  assert.equal(count('docker.imageRemove'), 0, 'the image is not removed before the dialog confirms')
  assert.equal(await client.acceptConfirm(), true)
  await flush()
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.imageRemove').body.payload, { id: IMAGE_ONE.id })
  assert.ok(count('docker.images') >= 2, 'a removed image reloads its list')
  assert.ok(count('docker.diskUsage') > diskBefore, 'a removal refreshes the disk summary')

  client.requestVolumeRemove(VOLUME_ONE.name)
  confirm = client.getSnapshot().confirm
  assert.equal(confirm.kind, 'volume.remove')
  assert.equal(confirm.name, VOLUME_ONE.name)
  assert.equal(count('docker.volumeRemove'), 0)
  assert.equal(await client.acceptConfirm(), true)
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.volumeRemove').body.payload, { name: VOLUME_ONE.name })

  client.requestNetworkRemove(NETWORK_ONE.name)
  confirm = client.getSnapshot().confirm
  assert.equal(confirm.kind, 'network.remove')
  assert.equal(confirm.name, NETWORK_ONE.name)
  assert.equal(count('docker.networkRemove'), 0)
  assert.equal(await client.acceptConfirm(), true)
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.networkRemove').body.payload, { name: NETWORK_ONE.name })
})

test('Docker sub-tabs load their own endpoints with disk usage, and the poll follows the visible sub-tab', async () => {
  const recorder = hostRecorder(dockerV2Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  const count = (endpoint) => recorder.calls.filter((call) => call.body.endpoint === endpoint).length

  assert.equal(await client.selectTab('docker'), true)
  await client.ensureTabLoaded('docker')
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.subTab, 'containers')
  assert.equal(count('docker.list'), 1)
  assert.equal(count('docker.diskUsage'), 1, 'the disk summary loads with the Docker tab')
  assert.equal(snapshot.docker.disk.usage.images.count, 2)
  assert.equal(snapshot.docker.disk.usage.images.size, '1.2GB')
  assert.equal(snapshot.docker.disk.usage.images.reclaimable, '640MB')

  assert.equal(await client.selectDockerTab('images'), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.subTab, 'images')
  assert.equal(snapshot.docker.images.list.length, 1)
  assert.equal(count('docker.images'), 1)

  assert.equal(await client.selectDockerTab('volumes'), true)
  assert.equal(client.getSnapshot().docker.volumes.list[0].mountpoint, VOLUME_ONE.mountpoint)
  assert.equal(count('docker.volumes'), 1)

  assert.equal(await client.selectDockerTab('networks'), true)
  assert.equal(client.getSnapshot().docker.networks.list[0].name, NETWORK_ONE.name)
  assert.equal(count('docker.networks'), 1)

  assert.equal(await client.selectDockerTab('nope'), false, 'an unknown sub-tab is refused')

  // The 5 s poll refreshes the visible sub-tab only, not the other lists and
  // not the (expensive) disk summary.
  await client.selectDockerTab('images')
  const imagesBefore = count('docker.images')
  const containersBefore = count('docker.list')
  const diskBefore = count('docker.diskUsage')
  const stop = client.startDockerPolling(10)
  await sleep(80)
  stop()
  const imagesAfter = count('docker.images')
  assert.ok(imagesAfter > imagesBefore, 'the poll refreshes the visible images list')
  assert.equal(count('docker.list'), containersBefore, 'the poll does not fetch the hidden containers list')
  assert.equal(count('docker.diskUsage'), diskBefore, 'the poll does not fetch disk usage')
  await sleep(40)
  assert.equal(count('docker.images'), imagesAfter, 'stopping the poll clears the interval')

  await client.selectDockerTab('containers')
  const containersAgain = count('docker.list')
  const stopSecond = client.startDockerPolling(10)
  await sleep(80)
  stopSecond()
  assert.ok(count('docker.list') > containersAgain, 'the poll follows the sub-tab back to containers')
})

test('settings save posts Docker-mode fields and refreshes the target view', async () => {
  const recorder = hostRecorder(dockerV2Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  assert.equal(client.getSnapshot().form.redis.mode, 'docker')
  assert.equal(client.getSnapshot().form.postgres.mode, 'docker')
  assert.equal(client.getSnapshot().targets.redis.resolved.container, 'yida_redis')

  client.setSettingsField('redis', 'container', 'yida_redis')
  client.setSettingsField('postgres', 'mode', 'manual')
  client.setSettingsField('postgres', 'host', '10.0.0.5')
  assert.equal(await client.saveSettings(), true)

  const saveCall = recorder.calls.find((call) => call.body.endpoint === 'settings.save')
  assert.ok(saveCall, 'the save must post settings.save')
  assert.equal(saveCall.body.payload.redis.mode, 'docker')
  assert.equal(saveCall.body.payload.redis.container, 'yida_redis')
  assert.equal(saveCall.body.payload.postgres.mode, 'manual')
  assert.equal(saveCall.body.payload.postgres.host, '10.0.0.5')

  // The save invalidates the Host's target cache, so a fresh `state` must
  // follow it and the panel must adopt the new target view.
  const saveIndex = recorder.calls.indexOf(saveCall)
  const after = recorder.calls.slice(saveIndex + 1).map((call) => call.body.endpoint)
  assert.ok(after.includes('state'), 'a save refreshes state after settings.save')
  assert.equal(client.getSnapshot().targets.redis.candidates.length, 2)
  assert.equal(client.getSnapshot().saveNotice, true)
})

test('header chips name the resolved Docker target and keep their status tone', async () => {
  const recorder = bootstrapRecorder()
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const chips = findAll(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dshDataChip'))
  assert.equal(chips.length, 3)

  const redisChip = chips.find((chip) => treeText(chip).includes('chip.redis'))
  assert.ok(redisChip, 'the Redis chip must render')
  assert.ok(treeText(redisChip).includes('yida_redis'), 'the chip names the resolved Redis container')
  assert.ok(redisChip.props.className.includes('dshDataChipOk'))
  assert.equal(redisChip.props['aria-label'], 'chip.ariaTarget')

  const pgChip = chips.find((chip) => treeText(chip).includes('chip.postgres'))
  assert.ok(treeText(pgChip).includes('yida_postgres'))
})

test('a resolved container that is not running tints its header chip warn', async () => {
  const targets = targetsValue()
  targets.redis.resolved = { mode: 'docker', container: 'old_redis', host: '127.0.0.1', port: 56379, credentialsSource: 'none' }
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'state') return jsonResponse(stateValue(undefined, targets))
    if (body.endpoint === 'redis.ping') return jsonResponse({ pong: true, latencyMs: 1, version: '7.4.0' })
    if (body.endpoint === 'pg.version') {
      return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
    }
    return jsonResponse({})
  })
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  const tree = React.render(panel, { client, t: (key) => key })
  const chips = findAll(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dshDataChip'))
  const redisChip = chips.find((chip) => treeText(chip).includes('chip.redis'))
  assert.ok(redisChip.props.className.includes('dshDataChipWarn'), 'a stopped resolved container tints the chip warn')
  assert.ok(treeText(redisChip).includes('old_redis'))
})

test('the settings view renders Docker-mode candidates, the resolved target and the mode switch', async () => {
  const recorder = bootstrapRecorder()
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  client.toggleSettings()
  // Keep the interpolation params in the tree so the test can see which
  // credential source / endpoint the view rendered.
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const tree = React.render(panel, { client, t })

  const select = findAll(tree, (node) => node.props !== undefined && node.props.id === `${NS}-setting-redis-container`)[0]
  assert.ok(select, 'the Redis container select must render in Docker mode')
  const options = select.children.filter((child) => child !== null && child !== undefined && child.type === 'option')
  assert.deepEqual(options.map((option) => option.props.value), ['', 'yida_redis', 'old_redis'])
  assert.equal(options[1].props.disabled, false, 'a running candidate is selectable')
  assert.equal(options[2].props.disabled, true, 'a stopped candidate is annotated and disabled')
  assert.ok(treeText(options[2]).includes('settings.target.stopped'))
  assert.ok(treeText(options[2]).includes('yida_redis') === false, 'the auto option is separate from the candidates')

  const text = treeText(tree)
  assert.ok(text.includes('settings.target.resolved'))
  assert.ok(text.includes('settings.target.credentials.container-env'))
  assert.ok(text.includes('settings.mode.docker'))
  assert.ok(text.includes('settings.redis.passwordDockerHint'))
  assert.ok(text.includes('settings.target.overrideHint'))
  // Host and port are hidden in Docker mode ...
  assert.equal(findAll(tree, (node) => node.props !== undefined && node.props.id === `${NS}-setting-redis-host`).length, 0)

  // ... and appear again in manual mode.
  client.setSettingsField('redis', 'mode', 'manual')
  const manual = React.render(panel, { client, t })
  assert.ok(findAll(manual, (node) => node.props !== undefined && node.props.id === `${NS}-setting-redis-host`).length > 0)
  assert.equal(findAll(manual, (node) => node.props !== undefined && node.props.id === `${NS}-setting-redis-container`).length, 0)
})

test('row buttons open the confirmation dialog and only its danger button calls the Host', async () => {
  const recorder = hostRecorder(dockerV2Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.loadDocker()
  await client.selectTab('docker')
  const t = (key) => key
  const actions = () => recorder.calls.filter((call) => call.body.endpoint === 'docker.action')

  let tree = React.render(panel, { client, t })
  const stopButton = findButton(tree, 'docker.action.stop')
  assert.ok(stopButton, 'the running container offers Stop')
  await stopButton.props.onClick()
  assert.equal(actions().length, 0, 'Stop must not call the Host before the dialog confirms')
  assert.equal(client.getSnapshot().confirm.kind, 'container.stop')

  tree = React.render(panel, { client, t })
  const dialog = findRole(tree, 'dialog')
  assert.ok(dialog, 'the ConfirmDialog must render for the pending stop')
  assert.ok(treeText(dialog).includes('confirm.containerStop.title'))
  const dialogButtons = findAll(dialog, (node) => node.type === 'button')
  assert.equal(dialogButtons.length, 2)
  assert.ok(treeText(dialogButtons[0]).includes('confirm.cancel'), 'Cancel is the first (focused) button')
  assert.ok(dialogButtons[1].props.className.includes('dshDataButtonDanger'), 'the confirm button is styled as danger')
  await dialogButtons[1].props.onClick()
  assert.equal(client.getSnapshot().confirm, null)
  assert.deepEqual(actions().at(-1).body.payload, { id: CONTAINER_RUNNING.id, action: 'stop' })

  // Start is a one-click action: no dialog, the Host is called directly.
  tree = React.render(panel, { client, t })
  const startButton = findButton(tree, 'docker.action.start')
  assert.ok(startButton, 'the exited container offers Start')
  await startButton.props.onClick()
  assert.equal(client.getSnapshot().confirm, null)
  assert.deepEqual(actions().at(-1).body.payload, { id: CONTAINER_EXITED.id, action: 'start' })
})

test('the Docker sub-tabs render counts, disk usage and resource rows with confirmed removal', async () => {
  const recorder = hostRecorder(dockerV2Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.selectTab('docker')
  await client.ensureTabLoaded('docker')
  await client.loadImages()
  await client.selectDockerTab('images')
  const t = (key) => key
  let tree = React.render(panel, { client, t })
  let text = treeText(tree)
  assert.ok(text.includes('docker.disk.title'))
  assert.ok(text.includes('docker.tab.containers') && text.includes('docker.tab.images'))
  assert.ok(text.includes('docker.tab.volumes') && text.includes('docker.tab.networks'))
  assert.ok(text.includes('docker.images.count'), 'the visible sub-tab count line renders')
  assert.ok(text.includes('nginx:latest'), 'the image repository:tag renders')

  const removeButton = findAll(tree, (node) => node.type === 'button' && node.props !== undefined && node.props['aria-label'] === 'docker.images.remove')[0]
  assert.ok(removeButton, 'the image row exposes its remove button')
  removeButton.props.onClick()
  assert.equal(client.getSnapshot().confirm.kind, 'image.remove')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'docker.imageRemove').length, 0)

  tree = React.render(panel, { client, t })
  const dialog = findRole(tree, 'dialog')
  assert.ok(dialog)
  assert.ok(treeText(dialog).includes('confirm.imageRemove.title'))
  const confirmButton = findAll(dialog, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dshDataButtonDanger'))[0]
  await confirmButton.props.onClick()
  await flush()
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.imageRemove').body.payload, { id: IMAGE_ONE.id })

  // The sub-tab bar switches lists through the store.
  const volumesTab = findAll(tree, (node) => node.type === 'button' && node.props !== undefined && node.props.role === 'tab' && treeText(node).includes('docker.tab.volumes'))[0]
  assert.ok(volumesTab, 'the volumes sub-tab button renders')
  await volumesTab.props.onClick()
  assert.equal(client.getSnapshot().docker.subTab, 'volumes')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'docker.volumes').length, 1)
})

test('the relations page loads docker.relations and drives the click-throughs', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  assert.equal(await client.selectTab('relations'), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.tab, 'relations')
  assert.equal(snapshot.relations.status, 'ready')
  const value = snapshot.relations.value
  assert.equal(value.summary.containers, 3)
  assert.equal(value.summary.running, 2)
  assert.equal(value.summary.danglingImages, 1)
  assert.equal(value.summary.unusedVolumes, 1)
  assert.equal(value.containers.length, 3)
  assert.equal(value.images.length, 2)
  assert.equal(value.volumes.length, 2)
  assert.equal(value.networks.length, 2)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'docker.relations'))

  // A container click opens the Docker tab and that container's details drawer.
  await client.openRelationContainer(value.containers[0])
  snapshot = client.getSnapshot()
  assert.equal(snapshot.tab, 'docker')
  assert.equal(snapshot.docker.detail.id, value.containers[0].id)

  // An image click opens the images sub-tab filtered to it.
  await client.openRelationResource('images', value.images[0].id)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.subTab, 'images')
  assert.equal(snapshot.docker.imageFilter, value.images[0].id)

  // Reverse-lookup state is store-owned.
  client.setRelationsFilter('volumes', value.volumes[0].name)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.relations.kind, 'volumes')
  assert.equal(snapshot.relations.id, value.volumes[0].name)
})

test('the relations page renders the summary, deterministic graph, table and reverse lookup', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.selectTab('relations')
  const t = (key) => key
  const tree = React.render(panel, { client, t })
  let text = treeText(tree)
  assert.ok(text.includes('relations.graph.title'))
  assert.ok(text.includes('relations.table.title'))
  assert.ok(text.includes('relations.reverse.title'))
  assert.ok(text.includes('relations.summary.running'))

  const svg = findAll(tree, (node) => node.type === 'svg' && typeof node.props.className === 'string' && node.props.className.includes('dshDataRelSvg'))[0]
  assert.ok(svg, 'the relation graph renders as an SVG')
  assert.ok(svg.props.width > 0 && svg.props.height > 0, 'the graph uses fixed geometry')
  const lines = findAll(svg, (node) => node.type === 'path' && typeof node.props.className === 'string' && node.props.className.indexOf('dshDataRelLine') === 0)
  assert.equal(lines.length, 4, 'one line per image and volume association')
  const nodes = findAll(svg, (node) => node.props !== undefined && node.props.role === 'button')
  assert.equal(nodes.length, 7, 'images + containers + volumes are all clickable nodes')
  const containerNode = nodes.find((node) => treeText(node).includes('web'))
  assert.ok(containerNode, 'the container node renders its name')
  assert.equal(typeof containerNode.props.onClick, 'function')
  await containerNode.props.onClick()
  assert.equal(client.getSnapshot().tab, 'docker')
  assert.equal(client.getSnapshot().docker.detail.id, 'c1')

  // Reverse lookup filter narrows the associated-container list.
  await client.selectTab('relations')
  client.setRelationsFilter('volumes', 'web-data')
  const filtered = React.render(panel, { client, t })
  const associated = findAll(filtered, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dshDataHistoryButton'))
  assert.equal(associated.length, 1)
  assert.ok(treeText(associated[0]).includes('web'))
})

test('multiple running instances are ambiguous until one is pinned or auto is restored', async () => {
  const targets = targetsValue()
  targets.redis.instances = [
    { container: 'redis_a', image: 'redis:7', state: 'running', host: '127.0.0.1', port: 56379, containerPort: '6379', hasPublishedPort: true, hasPassword: false, credentialsSource: 'none' },
    { container: 'redis_b', image: 'redis:7', state: 'running', host: '127.0.0.1', port: 56380, containerPort: '6379', hasPublishedPort: true, hasPassword: false, credentialsSource: 'none' },
  ]
  targets.redis.resolved = null
  targets.redis.error = {
    code: 'redis_ambiguous_container',
    message: '2 Redis containers are running; choose one',
    details: { candidates: [{ name: 'redis_a', image: 'redis:7', hostPort: 56379 }, { name: 'redis_b', image: 'redis:7', hostPort: 56380 }] },
  }
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'state') return jsonResponse(stateValue(undefined, targets))
    if (body.endpoint === 'redis.ping') {
      return hostErrorResponse('redis_ambiguous_container', '2 Redis containers are running; choose one', targets.redis.error.details)
    }
    if (body.endpoint === 'pg.version') {
      return jsonResponse({ version: 'PostgreSQL 16.3 on x86_64', currentUser: 'yida_postgres', currentDatabase: 'yida' })
    }
    if (body.endpoint === 'settings.save') {
      const settings = redactedSettings()
      settings.redis.container = body.payload.redis.container
      return jsonResponse(settings)
    }
    return v3Handler(body)
  })
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  await client.selectTab('redis')
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.targets.redis.resolved, null)
  assert.equal(snapshot.targets.redis.error.code, 'redis_ambiguous_container')
  assert.equal(snapshot.targets.redis.instances.length, 2)

  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('error.ambiguousContainer'), 'the ambiguity is localized')
  assert.ok(text.includes('instance.choose'), 'the tab asks the operator to choose')
  assert.ok(text.includes('redis_a') && text.includes('redis_b'), 'both running instances are offered')
  assert.ok(text.includes('instance.auto'), 'the auto option is offered')

  const chips = findAll(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dshDataChip'))
  const redisChip = chips.find((chip) => treeText(chip).includes('chip.redis'))
  assert.ok(redisChip.props.className.includes('dshDataChipWarn'), 'the chip warns instead of claiming a connection')
  assert.ok(treeText(redisChip).includes('chip.instances'))

  assert.equal(await client.selectInstance('redis', 'redis_a'), true)
  const saveCall = recorder.calls.find((call) => call.body.endpoint === 'settings.save')
  assert.deepEqual(saveCall.body.payload, { redis: { mode: 'docker', container: 'redis_a' } })
  assert.equal(client.getSnapshot().instanceSaving, '')
  assert.equal(client.getSnapshot().instanceError, null)
  const saveIndex = recorder.calls.indexOf(saveCall)
  assert.ok(recorder.calls.slice(saveIndex + 1).some((call) => call.body.endpoint === 'state'), 'the save refreshes state')
  assert.ok(recorder.calls.slice(saveIndex + 1).some((call) => call.body.endpoint === 'redis.info'), 'the tab reloads after the switch')
})

test('docker rows carry CPU and memory from one stats fetch, and the state filter narrows the list', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.loadDocker()
  await client.selectTab('docker')
  const snapshot = client.getSnapshot()
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'docker.stats').length, 1)
  assert.equal(snapshot.docker.statsById[CONTAINER_RUNNING.id].cpuPercent, 12.5)
  const t = (key) => key
  let tree = React.render(panel, { client, t })
  let text = treeText(tree)
  assert.ok(text.includes('12.5%'), 'the CPU column renders')
  assert.ok(text.includes('32 MiB / 256 MiB'), 'the memory column renders usage / limit')
  assert.ok(text.includes('docker.stateFilter.all'))
  const rows = () => findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshDataDockerItem'))
  assert.equal(rows().length, 2)

  client.setDockerStateFilter('stopped')
  tree = React.render(panel, { client, t })
  assert.equal(rows().length, 1)
  assert.ok(treeText(tree).includes('worker'))

  client.setDockerStateFilter('running')
  tree = React.render(panel, { client, t })
  assert.equal(rows().length, 1)
  assert.ok(treeText(tree).includes('web'))
})

test('image, volume and network details modals read the new inspect endpoints', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  const t = (key) => key
  assert.equal(await client.inspectResource('image', IMAGE_ONE.id, 'nginx:latest'), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.inspect.open, true)
  assert.equal(snapshot.docker.inspect.kind, 'image')
  assert.equal(snapshot.docker.inspect.value.architecture, 'arm64')
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.imageInspect').body.payload, { id: IMAGE_ONE.id })
  await client.selectTab('docker')
  let tree = React.render(panel, { client, t })
  let dialog = findRole(tree, 'dialog')
  assert.ok(dialog, 'the image modal renders')
  let text = treeText(dialog)
  assert.ok(text.includes('docker.images.inspect'))
  assert.ok(text.includes('docker.inspect.env'))
  assert.ok(text.includes('/usr/bin'))
  client.closeInspect()
  assert.equal(client.getSnapshot().docker.inspect.open, false)

  assert.equal(await client.inspectResource('volume', VOLUME_ONE.name, VOLUME_ONE.name), true)
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.volumeInspect').body.payload, { name: VOLUME_ONE.name })
  assert.equal(await client.inspectResource('network', NETWORK_ONE.name, NETWORK_ONE.name), true)
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'docker.networkInspect').body.payload, { name: NETWORK_ONE.name })
  tree = React.render(panel, { client, t })
  dialog = findRole(tree, 'dialog')
  text = treeText(dialog)
  assert.ok(text.includes('docker.networks.inspect'))
  assert.ok(text.includes('docker.inspect.subnets'))
  assert.ok(text.includes('172.18.0.0/16'))
})

test('redis server cards, key memory, editors and confirmed key actions use the v0.3 endpoints', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.loadRedis()
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.dbsize.keys, 42)
  assert.equal(snapshot.redis.clients.list.length, 1)
  assert.equal(snapshot.redis.clients.list[0].addr, '127.0.0.1:5000')
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'redis.dbsize'))
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'redis.clients'))

  await client.selectRedisKey('hash:1')
  snapshot = client.getSnapshot()
  assert.equal(snapshot.redis.selected.memory.data.human, '1.0K')
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'redis.memory'))
  assert.equal(snapshot.redis.editor.kind, 'hash')

  client.setRedisEditor('field', 'role')
  client.setRedisEditor('value', 'admin')
  assert.equal(await client.submitRedisEditor(), true)
  let call = recorder.calls.filter((entry) => entry.body.endpoint === 'redis.hashSet').at(-1)
  assert.deepEqual(call.body.payload, { key: 'hash:1', field: 'role', value: 'admin' })
  assert.equal(client.getSnapshot().redis.editor.notice.code, 'redis.editor.notice.hashSet')
  await flush()

  await client.selectRedisKey('list:1')
  client.setRedisEditor('value', 'new-item')
  client.setRedisEditor('side', 'left')
  assert.equal(await client.submitRedisEditor(), true)
  call = recorder.calls.filter((entry) => entry.body.endpoint === 'redis.listPush').at(-1)
  assert.deepEqual(call.body.payload, { key: 'list:1', value: 'new-item', side: 'left' })
  await flush()

  await client.selectRedisKey('set:1')
  client.setRedisEditor('member', 'm3')
  assert.equal(await client.submitRedisEditor(), true)
  assert.deepEqual(recorder.calls.filter((entry) => entry.body.endpoint === 'redis.setAdd').at(-1).body.payload, { key: 'set:1', member: 'm3' })
  await flush()
  client.setRedisEditor('member', 'm1')
  assert.equal(await client.removeRedisSetMember(), true)
  assert.deepEqual(recorder.calls.filter((entry) => entry.body.endpoint === 'redis.setRemove').at(-1).body.payload, { key: 'set:1', member: 'm1' })
  assert.equal(client.getSnapshot().redis.editor.notice.code, 'redis.editor.notice.setRemove')
  await flush()

  // Rename is confirmed before the Host call.
  await client.selectRedisKey('hash:1')
  client.setRedisRenameDraft('hash:2')
  assert.equal(await client.requestRedisRename(), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.confirm.kind, 'redis.rename')
  assert.equal(snapshot.confirm.newKey, 'hash:2')
  assert.equal(recorder.calls.filter((entry) => entry.body.endpoint === 'redis.rename').length, 0)
  assert.equal(await client.acceptConfirm(), true)
  assert.deepEqual(recorder.calls.find((entry) => entry.body.endpoint === 'redis.rename').body.payload, { key: 'hash:1', newKey: 'hash:2' })
  assert.equal(client.getSnapshot().redis.action.notice.code, 'redis.key.notice.renamed')
  await flush()

  // Expiry validates the TTL and is confirmed too.
  await client.selectRedisKey('list:1')
  client.setRedisExpireDraft('0')
  assert.equal(await client.requestRedisExpire(), false)
  assert.equal(client.getSnapshot().confirm, null)
  client.setRedisExpireDraft('600')
  assert.equal(await client.requestRedisExpire(), true)
  assert.equal(client.getSnapshot().confirm.kind, 'redis.expire')
  assert.equal(await client.acceptConfirm(), true)
  assert.deepEqual(recorder.calls.find((entry) => entry.body.endpoint === 'redis.expire').body.payload, { key: 'list:1', ttlSeconds: 600 })
  await flush()

  assert.equal(await client.persistRedisKey(), true)
  assert.deepEqual(recorder.calls.filter((entry) => entry.body.endpoint === 'redis.persist').at(-1).body.payload, { key: 'list:1' })
  assert.equal(client.getSnapshot().redis.action.notice.code, 'redis.key.notice.persisted')
})

test('the redis tab renders the server card, key actions and the type editor', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.loadRedis()
  await client.selectTab('redis')
  await client.selectRedisKey('hash:1')
  const t = (key) => key
  let text = treeText(React.render(panel, { client, t }))
  assert.ok(text.includes('redis.server.title'))
  assert.ok(text.includes('redis.server.dbsize'))
  assert.ok(text.includes('redis.clients.addr'))
  assert.ok(text.includes('redis.key.actions'))
  assert.ok(text.includes('redis.key.rename'))
  assert.ok(text.includes('redis.editor.hash.title'))

  await client.selectRedisKey('set:1')
  text = treeText(React.render(panel, { client, t }))
  assert.ok(text.includes('redis.editor.set.title'))
  assert.ok(text.includes('redis.editor.remove'))
})

test('postgres activity, table detail tabs, browse pagination, CSV and history work', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  await client.selectTab('postgres')
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.activity.list.length, 1)
  assert.equal(snapshot.postgres.activity.list[0].pid, 123)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'pg.activity'))

  assert.equal(await client.selectTable('public', 'users'), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.selected.detail.value.size, '16 MB')
  assert.equal(snapshot.postgres.selected.detail.value.indexes.length, 2)
  assert.equal(snapshot.postgres.selected.detail.value.constraints.length, 2)
  assert.deepEqual(recorder.calls.find((call) => call.body.endpoint === 'pg.tableDetail').body.payload,
    { schema: 'public', table: 'users', database: 'yida' })
  client.setTableDetailTab('indexes')
  assert.equal(client.getSnapshot().postgres.selected.detail.tab, 'indexes')

  await client.loadBrowse()
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.browse.rows.length, 2)
  assert.equal(snapshot.postgres.browse.totalRows, 120)
  assert.equal(snapshot.postgres.browse.limitedBy, 'limit')
  let browseCall = recorder.calls.filter((call) => call.body.endpoint === 'pg.browse').at(-1)
  assert.equal(browseCall.body.payload.orderBy, 'id', 'browse orders by the first column for stable paging')
  assert.equal(browseCall.body.payload.offset, 0)

  await client.browsePage(1)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.browse.page, 1)
  browseCall = recorder.calls.filter((call) => call.body.endpoint === 'pg.browse').at(-1)
  assert.equal(browseCall.body.payload.offset, 50)
  assert.equal(browseCall.body.payload.limit, 50)

  await client.setBrowsePageSize(25)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.browse.page, 0)
  assert.equal(snapshot.postgres.browse.pageSize, 25)
  browseCall = recorder.calls.filter((call) => call.body.endpoint === 'pg.browse').at(-1)
  assert.equal(browseCall.body.payload.limit, 25)

  const csv = client.resultCsv({ columns: snapshot.postgres.browse.columns, rows: snapshot.postgres.browse.rows })
  assert.equal(csv.split('\n')[0], 'id,email')
  assert.ok(csv.includes('alice@example.com'))
  assert.equal(client.downloadResult({ columns: [], rows: [] }), false, 'an empty grid is not exported')
  assert.equal(client.downloadResult(PG_QUERY_RESULT), false, 'the VM has no Blob/URL support')
  const queryCsv = client.resultCsv(PG_QUERY_RESULT)
  assert.ok(queryCsv.startsWith('id,email'), 'query result grids export too')

  client.setPgSql('select 1')
  assert.equal(await client.runPgQuery(), true)
  snapshot = client.getSnapshot()
  assert.equal(snapshot.postgres.queryHistory.length, 1)
  assert.equal(snapshot.postgres.queryHistory[0].sql, 'select 1')
  assert.equal(snapshot.postgres.queryHistory[0].rows, 2)
  client.restoreQuery('select 2')
  assert.equal(client.getSnapshot().postgres.sql, 'select 2')
})

test('the postgres tab renders the activity panel, detail tabs, browser and history', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch })
  await client.bootstrap()
  await client.selectTab('postgres')
  await client.selectTable('public', 'users')
  await client.loadBrowse()
  client.setPgSql('select 1')
  await client.runPgQuery()
  client.setTableDetailTab('constraints')
  const t = (key) => key
  const text = treeText(React.render(panel, { client, t }))
  assert.ok(text.includes('pg.activity.title'))
  assert.ok(text.includes('pg.activity.duration'))
  assert.ok(text.includes('pg.detail.constraints'))
  assert.ok(text.includes('pg.detail.constraint.definition'))
  assert.ok(text.includes('pg.browse.title'))
  assert.ok(text.includes('pg.browse.pageSize'))
  assert.ok(text.includes('pg.history.title'))
  assert.ok(text.includes('16 MB'))
})

test('the overview page renders status, service cards, insights and the quick start', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({
    fetch: recorder.fetch,
    localStorage: createStorageStub(),
    navigator: createNavigatorStub(),
  })
  await client.bootstrap()
  await client.selectTab('overview')
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.tab, 'overview')
  assert.equal(snapshot.overview.status, 'ready')
  assert.equal(snapshot.overview.value.counts.running, 2)
  assert.equal(snapshot.overview.value.services.redis.summary.keys, 42)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'overview'))

  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('overview.status.title'))
  assert.ok(text.includes('overview.status.attention'), 'warn insights produce the attention sentence')
  assert.ok(text.includes('overview.service.docker.what'))
  assert.ok(text.includes('overview.service.redis.what'))
  assert.ok(text.includes('overview.service.postgres.what'))
  assert.ok(text.includes('overview.service.stat.containers'))
  assert.ok(text.includes('relationship') === false)
  assert.ok(text.includes('insight.stopped_containers'))
  assert.ok(text.includes('insight.unused_volumes'))
  assert.ok(text.includes('overview.quick.title'))
  assert.ok(text.includes(client.startCommands.redis), 'the quick start shows a copyable Redis command')

  // An insight action jumps to the relevant tab.
  const action = findAll(tree, (node) => node.type === 'button' && treeText(node).includes('intent.stopped_containers'))[0]
  assert.ok(action, 'the stopped-containers insight has an action button')
  await action.props.onClick()
  assert.equal(client.getSnapshot().tab, 'docker')
})

test('the overview page degrades to the cached state when the endpoint fails', async () => {
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'overview') {
      return { ok: false, status: 500, async json() { return {} } }
    }
    return v3Handler(body)
  })
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.loadDocker()
  assert.equal(await client.loadOverview(), false)
  const snapshot = client.getSnapshot()
  assert.equal(snapshot.overview.value, null)
  assert.equal(snapshot.overview.error.code, 'data_unreachable')

  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('plain.error.unreachable'), 'the failure is explained in plain words')
  assert.ok(text.includes('plain.error.hint.unreachable'), 'the notice suggests what to do')
  assert.ok(text.includes('overview.service.docker.what'), 'the service cards fall back to the cached state')
  assert.ok(text.includes('overview.quick.title'))
})

test('the beginner/expert toggle persists and changes what is visible', async () => {
  const storage = createStorageStub()
  const first = applyClient({ fetch: hostRecorder(v3Handler).fetch, localStorage: storage, navigator: createNavigatorStub() })
  await first.client.bootstrap()
  assert.equal(first.client.getSnapshot().viewMode, 'beginner')
  const t = (key) => key

  let tree = first.React.render(first.panel, { client: first.client, t })
  assert.ok(treeText(tree).includes('plain.banner.overview'), 'beginner mode shows the plain banner')
  assert.ok(treeText(tree).includes('plain.view.beginner'), 'the header offers the beginner/expert toggle')
  assert.ok(treeText(tree).includes('plain.view.expert'))

  first.client.setViewMode('expert')
  assert.equal(storage.getItem('dsh-long-data:view-mode'), 'expert')
  tree = first.React.render(first.panel, { client: first.client, t })
  assert.equal(treeText(tree).includes('plain.banner.overview'), false, 'expert mode hides the banner')
  assert.equal(first.client.getSnapshot().viewMode, 'expert')

  // A fresh client reads the stored choice.
  const second = applyClient({ fetch: hostRecorder(v3Handler).fetch, localStorage: storage })
  assert.equal(second.client.getSnapshot().viewMode, 'expert')
  second.client.setViewMode('beginner')
  assert.equal(storage.getItem('dsh-long-data:view-mode'), 'beginner')
})

test('beginner mode collapses raw docker details while expert mode shows them', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.loadOverview()
  await client.loadDocker()
  await client.selectTab('docker')
  await client.toggleDetail(CONTAINER_RUNNING.id, 'web')
  await client.loadDetail()
  const t = (key) => key

  let tree = React.render(panel, { client, t })
  let rows = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshDataDockerRow'))
  let webRow = rows.find((row) => treeText(row).includes('web'))
  assert.ok(webRow)
  assert.equal(findAll(webRow, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshDataDockerId')).length, 0, 'beginner mode hides the raw id')
  assert.ok(treeText(webRow).includes('plain.role.website'), 'beginner mode names the role')
  assert.ok(treeText(webRow).includes('plain.state.running'), 'beginner mode uses a plain state')
  assert.ok(findAll(tree, (node) => node.type === 'details').length >= 1, 'raw details sit behind an expander')
  assert.ok(treeText(tree).includes('plain.advanced'))
  assert.ok(treeText(tree).includes('NODE_ENV'), 'the advanced content is still reachable')

  client.setViewMode('expert')
  tree = React.render(panel, { client, t })
  rows = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshDataDockerRow'))
  webRow = rows.find((row) => treeText(row).includes('web'))
  assert.ok(findAll(webRow, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshDataDockerId')).length > 0, 'expert mode shows the raw id')
  assert.equal(findAll(tree, (node) => node.type === 'details').length, 0, 'expert mode does not collapse the details')
  assert.ok(treeText(tree).includes('docker.detail.env'))
})

test('the help drawer explains terms and questions in plain language', async () => {
  const { client, React, panel } = applyClient({ fetch: hostRecorder(v3Handler).fetch, localStorage: createStorageStub() })
  client.toggleHelp()
  assert.equal(client.getSnapshot().helpOpen, true)
  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const dialog = findRole(tree, 'dialog')
  assert.ok(dialog, 'the help drawer renders as a dialog')
  const text = treeText(dialog)
  assert.ok(text.includes('plain.help.title'))
  assert.ok(text.includes('plain.help.concepts'))
  assert.ok(text.includes('plain.help.container'))
  assert.ok(text.includes('plain.help.container.desc'))
  assert.ok(text.includes('plain.help.redis.ttl.desc'))
  assert.ok(text.includes('plain.help.pg.sql.desc'))
  assert.ok(text.includes('plain.help.faq.stop.desc'))
  assert.ok(text.includes('plain.help.faq.unreachable.desc'))
  const close = findButton(dialog, 'plain.close')
  assert.ok(close)
  close.props.onClick()
  assert.equal(client.getSnapshot().helpOpen, false)
})

test('confirmations carry role-aware impact sentences in beginner mode only', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.loadOverview()
  await client.loadDocker()
  await client.selectTab('docker')
  const t = (key) => key

  assert.equal(await client.requestContainerAction(CONTAINER_RUNNING.id, 'web', 'stop', 'website'), true)
  let tree = React.render(panel, { client, t })
  let dialog = findRole(tree, 'dialog')
  assert.ok(dialog)
  assert.ok(treeText(dialog).includes('confirm.impact.stop.website'), 'the website impact is explained')
  assert.equal(recorder.calls.filter((call) => call.body.endpoint === 'docker.action').length, 0, 'nothing runs before confirming')

  client.cancelConfirm()
  client.setViewMode('expert')
  await client.requestContainerAction(CONTAINER_RUNNING.id, 'web', 'stop', 'website')
  tree = React.render(panel, { client, t })
  dialog = findRole(tree, 'dialog')
  assert.equal(treeText(dialog).includes('confirm.impact.stop.website'), false, 'expert mode keeps the plain dialog')

  client.cancelConfirm()
  client.setViewMode('beginner')
  client.requestRedisDelete('cache:token')
  tree = React.render(panel, { client, t })
  dialog = findRole(tree, 'dialog')
  assert.ok(treeText(dialog).includes('confirm.impact.redis.delete'))
})

test('redis beginner mode shows plain types and TTL and the write wizard saves data', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.loadRedis()
  await client.selectTab('redis')
  await client.selectRedisKey('hash:1')
  const t = (key) => key
  let tree = React.render(panel, { client, t })
  let text = treeText(tree)
  assert.ok(text.includes('plain.redisType.hash'), 'the key type is named in plain words')
  assert.ok(text.includes('plain.ttl.never'), 'the TTL is explained in plain words')
  assert.ok(text.includes('redis.wizard.open'), 'the write-data action is offered')

  client.openRedisWizard()
  client.setRedisWizard('type', 'hash')
  client.setRedisWizard('key', 'user:9')
  client.setRedisWizard('field', 'name')
  client.setRedisWizard('value', 'alice')
  tree = React.render(panel, { client, t })
  text = treeText(tree)
  assert.ok(text.includes('redis.wizard.title'))
  assert.ok(text.includes('redis.wizard.type.hash'))
  assert.equal(await client.submitRedisWizard(), true)
  const call = recorder.calls.filter((entry) => entry.body.endpoint === 'redis.hashSet').at(-1)
  assert.deepEqual(call.body.payload, { key: 'user:9', field: 'name', value: 'alice' })
  assert.equal(client.getSnapshot().redis.wizard.notice.key, 'user:9')
  await flush()

  client.setViewMode('expert')
  tree = React.render(panel, { client, t })
  assert.equal(treeText(tree).includes('plain.redisType.hash'), false, 'expert mode shows the raw type')
})

test('postgres templates fill the editor and beginner mode hides it behind advanced', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.selectTab('postgres')
  await client.selectTable('public', 'users')

  assert.equal(client.fillSqlTemplate('preview'), true)
  assert.equal(client.getSnapshot().postgres.sql, 'select * from "public"."users" limit 10')
  assert.equal(client.fillSqlTemplate('count'), true)
  assert.match(client.getSnapshot().postgres.sql, /count\(\*\)/)
  assert.equal(client.fillSqlTemplate('columns'), true)
  assert.ok(client.getSnapshot().postgres.sql.includes('information_schema.columns'))

  const t = (key) => key
  let tree = React.render(panel, { client, t })
  let text = treeText(tree)
  assert.ok(text.includes('pg.template.title'))
  assert.ok(text.includes('pg.template.preview'))
  assert.ok(text.includes('pg.template.count'))
  const details = findAll(tree, (node) => node.type === 'details')
  assert.ok(details.length >= 1, 'the SQL editor sits behind the advanced expander')
  assert.ok(treeText(details[0]).includes('plain.advancedSql'))
  assert.ok(findAll(details[0], (node) => node.type === 'textarea').length > 0, 'the editor is inside the expander')

  // Clicking a template fills and runs it in beginner mode.
  const before = recorder.calls.filter((call) => call.body.endpoint === 'pg.query').length
  const templateButton = findAll(tree, (node) => node.type === 'button' && treeText(node).includes('pg.template.count'))[0]
  assert.ok(templateButton)
  await templateButton.props.onClick()
  await flush()
  assert.match(client.getSnapshot().postgres.sql, /count\(\*\)/)
  assert.ok(recorder.calls.filter((call) => call.body.endpoint === 'pg.query').length > before)

  client.setViewMode('expert')
  tree = React.render(panel, { client, t })
  assert.equal(findAll(tree, (node) => node.type === 'details').length, 0, 'expert mode always shows the editor')
})

test('docker containers are grouped by compose project with role chips', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.loadOverview()
  await client.loadDocker()
  await client.selectTab('docker')
  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('docker.group.title'), 'the compose project heading renders')
  assert.ok(text.includes('docker.group.ungrouped'), 'containers without a project fall back to 未分组')
  assert.equal(findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('dshDataGroup')).length, 2)
  assert.ok(text.includes('plain.role.website'), 'the role chips render')
  const groupTitles = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshDataGroupTitle'))
  assert.ok(groupTitles.length >= 2)
})

test('copy buttons copy values and show transient feedback without throwing', async () => {
  const navigator = createNavigatorStub()
  const { client, React, panel } = applyClient({
    fetch: hostRecorder(v3Handler).fetch,
    localStorage: createStorageStub(),
    navigator,
  })
  await client.bootstrap()
  assert.equal(client.copyText(client.startCommands.redis, 'quick-redis'), true)
  assert.deepEqual(navigator.writes, [client.startCommands.redis])
  assert.equal(client.getSnapshot().copied.key, 'quick-redis')
  const t = (key) => key
  const tree = React.render(panel, { client, t })
  assert.ok(treeText(tree).includes('plain.copied'), 'the copied feedback shows')

  const noClipboard = applyClient({ fetch: hostRecorder(v3Handler).fetch, localStorage: createStorageStub() })
  assert.equal(noClipboard.client.copyText('x', 'k'), false, 'a missing clipboard never throws')
  assert.equal(noClipboard.client.getSnapshot().copied.key, '')
})

test('the dockerfiles sub-tab lists Dockerfiles with plain explanations', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({
    fetch: recorder.fetch,
    localStorage: createStorageStub(),
    navigator: createNavigatorStub(),
  })
  await client.bootstrap()
  await client.selectTab('docker')
  assert.equal(await client.selectDockerTab('dockerfiles'), true)
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.subTab, 'dockerfiles')
  assert.equal(snapshot.docker.dockerfiles.status, 'ready')
  assert.equal(snapshot.docker.dockerfiles.list.length, 2)
  assert.deepEqual([...snapshot.docker.dockerfiles.roots], DOCKERFILE_ROOTS)
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'dockerfiles.list'))

  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('dockerfile.banner'), 'the beginner banner explains what a Dockerfile is')
  assert.ok(text.includes('dockerfile.count'))
  assert.ok(text.includes('dockerfile.card.baseRole'), 'the base image is paired with a role word')
  assert.ok(text.includes('dockerfile.port.label'), 'ports carry plain meanings')
  assert.ok(text.includes('dockerfile.card.multiStage'), 'multi-stage builds are badged')
  assert.ok(text.includes('dockerfile.card.healthcheck'))
  assert.ok(text.includes('dockerfile.card.env'))
  assert.ok(text.includes('dockerfile.card.view'))
  assert.ok(text.includes('dockerfile.card.copyBuild'))
  assert.ok(text.includes('dockerfile.card.copyPath'))
})

test('the Dockerfile viewer annotates instructions in beginner mode and summarizes in expert mode', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.selectTab('docker')
  await client.selectDockerTab('dockerfiles')
  const summary = client.getSnapshot().docker.dockerfiles.list[0]
  assert.equal(await client.openDockerfile(summary), true)
  const readCall = recorder.calls.find((call) => call.body.endpoint === 'dockerfiles.read')
  assert.deepEqual(readCall.body.payload, { path: summary.path })
  let snapshot = client.getSnapshot()
  assert.equal(snapshot.docker.dockerfileView.open, true)
  assert.equal(snapshot.docker.dockerfileView.value.parsed.instructions.length, 4)

  const t = (key) => key
  let tree = React.render(panel, { client, t })
  let text = treeText(tree)
  assert.ok(text.includes('dockerfile.view.annotated'))
  assert.ok(text.includes('dockerfile.explain.from'))
  assert.ok(text.includes('dockerfile.explain.copy'))
  assert.ok(text.includes('dockerfile.explain.expose'))
  assert.ok(text.includes('dockerfile.explain.cmd'))
  assert.ok(text.includes('dockerfile.view.raw'))
  assert.ok(text.includes('FROM nginx:1.31.6'), 'the raw line is shown with its number')

  client.setViewMode('expert')
  tree = React.render(panel, { client, t })
  text = treeText(tree)
  assert.ok(text.includes('dockerfile.view.summary'))
  assert.ok(text.includes('dockerfile.view.stages'))
  assert.ok(text.includes('dockerfile.view.warnings'))
  assert.ok(text.includes('dockerfile.view.warning'), 'the warning line is rendered')
  assert.ok(text.includes('dockerfile.view.baseImages'))

  const closeButton = findButton(tree, 'dockerfile.view.close')
  assert.ok(closeButton)
  closeButton.props.onClick()
  assert.equal(client.getSnapshot().docker.dockerfileView.open, false)
})

test('Dockerfile cards copy the build command and path with feedback', async () => {
  const navigator = createNavigatorStub()
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({
    fetch: recorder.fetch,
    localStorage: createStorageStub(),
    navigator,
  })
  await client.bootstrap()
  await client.selectTab('docker')
  await client.selectDockerTab('dockerfiles')
  const t = (key) => key
  let tree = React.render(panel, { client, t })
  const buildButton = findAll(tree, (node) => node.type === 'button' && treeText(node).includes('dockerfile.card.copyBuild'))[0]
  assert.ok(buildButton)
  buildButton.props.onClick()
  assert.equal(navigator.writes[0], 'docker build -t app:latest /srv/app')
  assert.equal(client.getSnapshot().copied.key, 'dockerfile-build-/srv/app/Dockerfile')

  const pathButton = findAll(tree, (node) => node.type === 'button' && treeText(node).includes('dockerfile.card.copyPath'))[0]
  assert.ok(pathButton)
  pathButton.props.onClick()
  assert.equal(navigator.writes[1], '/srv/app/Dockerfile')

  tree = React.render(panel, { client, t })
  assert.ok(treeText(tree).includes('plain.copied'), 'the copied feedback shows')
})

test('the Dockerfiles empty state explains the concept, lists roots and offers a sample', async () => {
  const navigator = createNavigatorStub()
  const recorder = hostRecorder((body) => {
    if (body.endpoint === 'dockerfiles.list') {
      return jsonResponse({
        dockerfiles: [],
        roots: ['/srv'],
        scan: { visitedFiles: 3, truncated: false, errors: [], generatedAt: '2026-10-22T06:00:00.000Z' },
      })
    }
    return v3Handler(body)
  })
  const { client, React, panel } = applyClient({
    fetch: recorder.fetch,
    localStorage: createStorageStub(),
    navigator,
  })
  await client.bootstrap()
  await client.selectTab('docker')
  await client.selectDockerTab('dockerfiles')
  // Keep interpolation params visible so the scanned roots can be asserted.
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('dockerfile.empty.title'))
  assert.ok(text.includes('dockerfile.empty.hint'))
  assert.ok(text.includes('dockerfile.empty.sampleTitle'))
  assert.ok(text.includes('dockerfile.empty.sampleHint'))
  assert.ok(text.includes('dockerfile.empty.settingsHint'))
  assert.ok(text.includes('/srv'))
  assert.ok(text.includes('FROM nginx:alpine'), 'the sample Dockerfile is shown')

  const copyButton = findAll(tree, (node) => node.type === 'button' && treeText(node).includes('plain.copy'))[0]
  assert.ok(copyButton)
  copyButton.props.onClick()
  assert.ok(navigator.writes[0].includes('FROM nginx:alpine'), 'the sample can be copied')
})

test('the Dockerfiles settings section saves scan roots and depth only when changed', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  client.setSettingsField('dockerfiles', 'rootsText', '/srv/a\n\n  /srv/b  \n')
  client.setSettingsField('dockerfiles', 'maxDepth', '9')
  assert.equal(await client.saveSettings(), true)
  let saveCall = recorder.calls.filter((call) => call.body.endpoint === 'settings.save').at(-1)
  assert.deepEqual(saveCall.body.payload.dockerfiles, { roots: ['/srv/a', '/srv/b'], maxDepth: 9 })

  client.setSettingsField('redis', 'host', '10.0.0.2')
  assert.equal(await client.saveSettings(), true)
  saveCall = recorder.calls.filter((call) => call.body.endpoint === 'settings.save').at(-1)
  assert.equal('dockerfiles' in saveCall.body.payload, false, 'an unchanged dockerfiles group is not resent')

  const failing = hostRecorder((body) => {
    if (body.endpoint === 'settings.save') {
      return hostErrorResponse('invalid_payload', '"dockerfiles.roots" entry is not an absolute path: rel', { field: 'dockerfiles.roots' })
    }
    return v3Handler(body)
  })
  const blocked = applyClient({ fetch: failing.fetch, localStorage: createStorageStub() })
  await blocked.client.bootstrap()
  blocked.client.setSettingsField('dockerfiles', 'rootsText', 'relative/path')
  assert.equal(await blocked.client.saveSettings(), false)
  const snapshot = blocked.client.getSnapshot()
  assert.equal(snapshot.saveError.code, 'invalid_payload')
  assert.match(snapshot.saveError.message, /absolute path/)
})

test('the overview page counts Dockerfiles and jumps from the insight', async () => {
  const recorder = hostRecorder(v3Handler)
  const { client, React, panel } = applyClient({ fetch: recorder.fetch, localStorage: createStorageStub() })
  await client.bootstrap()
  await client.selectTab('overview')
  const t = (key) => key
  const tree = React.render(panel, { client, t })
  const text = treeText(tree)
  assert.ok(text.includes('overview.service.stat.docker.dockerfiles'), 'the Docker card shows the Dockerfile count')
  assert.ok(text.includes('insight.dockerfiles_found'))
  assert.ok(text.includes('intent.dockerfiles_found'))

  const jump = findAll(tree, (node) => node.type === 'button' && treeText(node).includes('intent.dockerfiles_found'))[0]
  assert.ok(jump)
  await jump.props.onClick()
  await flush()
  const snapshot = client.getSnapshot()
  assert.equal(snapshot.tab, 'docker')
  assert.equal(snapshot.docker.subTab, 'dockerfiles')
  assert.ok(recorder.calls.some((call) => call.body.endpoint === 'dockerfiles.list'))

  // A null dockerfiles section degrades without breaking the page.
  const nullRecorder = hostRecorder((body) => {
    if (body.endpoint === 'overview') {
      const value = overviewValue()
      value.dockerfiles = null
      value.insights = value.insights.filter((insight) => insight.code !== 'dockerfiles_found')
      return jsonResponse(value)
    }
    return v3Handler(body)
  })
  const second = applyClient({ fetch: nullRecorder.fetch, localStorage: createStorageStub() })
  await second.client.bootstrap()
  await second.client.selectTab('overview')
  assert.equal(second.client.getSnapshot().overview.value.dockerfiles, null)
  const nullTree = second.React.render(second.panel, { client: second.client, t })
  assert.equal(treeText(nullTree).includes('overview.service.stat.docker.dockerfiles'), false)
  assert.equal(treeText(nullTree).includes('insight.dockerfiles_found'), false)
  assert.ok(treeText(nullTree).includes('overview.service.docker.what'), 'the Docker card still renders')
})

