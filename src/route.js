/**
 * The exact Fetch route the panel posts to.
 *
 * ## Why an exact Fetch route and not a Connection RPC channel
 *
 * `ctx.connection.rpc.handle()` mounts each channel through
 * `owner.webServer.register(...)`, where `owner` is the Context that read the
 * service. Cordis hands a service method a shadowed Context whose service
 * resolution walks the *provider's* fiber chain, where `webServer` is not
 * visible, so a consumer plugin's call throws
 * `cannot get property "webServer" without inject` and the channel is never
 * mounted. `ctx.connection.fetch.register()` has no such dependency: it adds an
 * exact route to the `/api` channel Connection has already mounted, and the
 * browser reaches it with an ordinary same-origin authenticated `fetch`.
 *
 * The handler is harness-free — it receives the ops object and returns the
 * `{ok, value}` / `{ok, error}` envelope the panel unwraps — so the route is
 * unit-tested against a `Request` with no server running.
 *
 * `GET` answers the same bootstrap view as the `state` endpoint. It exists for
 * operators: `curl` against the route is the quickest way to see what the
 * plugin thinks its connections are (passwords stay redacted).
 *
 * @module dsh-long-data/src/route
 */

/** The exact path this plugin owns below the `/api` channel. */
export const API_PATH = '/api/dsh-long-data'

/** Largest request body the route accepts; a larger one is refused with 413. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Build the route object `ctx.connection.fetch.register` accepts.
 *
 * @param {object} deps - route dependencies.
 * @param {{ run: (endpoint: string, payload?: unknown) => Promise<object>, state: () => Promise<object> }} deps.ops - the operations.
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }} the route.
 */
export function createDataRoute({ ops }) {
  return {
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'GET') return Response.json(await ops.state())
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      const declared = Number(request.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return new Response('request body is too large', { status: 413 })
      }
      let text
      try {
        text = await request.text()
      } catch {
        return new Response('could not read the request body', { status: 400 })
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
        return new Response('request body is too large', { status: 413 })
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return new Response('body must be a JSON object', { status: 400 })
      }
      if (typeof body.endpoint !== 'string') {
        return new Response('body must carry a string "endpoint"', { status: 400 })
      }
      return Response.json(await ops.run(body.endpoint, body.payload ?? {}))
    },
  }
}

export default { API_PATH, MAX_BODY_BYTES, createDataRoute }
