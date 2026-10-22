/**
 * dsh-long-data — Host half.
 *
 * One instance owns the connection settings and the `/api/dsh-long-data`
 * endpoint, which is why the row is host-plane rather than preset-plane: every
 * browser window must see the same Docker daemon, Redis server and PostgreSQL
 * connection. The same row in an agent preset would give each session its own
 * copy of the settings file.
 *
 * This plugin is page-only: it registers no model-facing tool, prompt section or
 * context, so it never spends the model's context budget. Everything the panel
 * can do is reached through the authenticated `/api` route.
 *
 * ## Pieces
 *
 *   - `config.js` validates the composition row's config and derives the plugin
 *     state directory.
 *   - `settings.js` owns the durable connection document (mode 0600) and the
 *     redacted view the browser may see.
 *   - `docker.js`, `redis.js`, `postgres.js` speak to the three services with
 *     Node builtins only: the Docker CLI over `child_process`, Redis over an
 *     own RESP2 implementation, PostgreSQL over an own wire-protocol client.
 *     No third-party dependency is needed, so installing the bundle cannot fail
 *     on a native module or a registry.
 *   - `ops.js` implements every capability once; `route.js` exposes it to the
 *     browser.
 *
 * ## Failure posture
 *
 * Nothing in this module throws for a recoverable problem: an uncreatable state
 * directory and an unreadable settings document each produce a warning plus
 * degraded-but-working behavior. The one thing that fails loudly is the route
 * registration itself, because a panel that opens and errors on every request
 * would hide the fault behind a UI that looks fine.
 *
 * @module dsh-long-data/src/index
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { resolveConfig, settingsDefaultsFrom, stateDirectory } from './config.js'
import { describeError } from './errors.js'
import { createOps } from './ops.js'
import { API_PATH, createDataRoute } from './route.js'
import { SettingsStore } from './settings.js'

/** Stable Cordis plugin name; also the row id the bundle patch inserts. */
export const name = 'dsh-long-data'

/**
 * Register the plugin.
 *
 * @param {any} ctx - the loader-provided plugin context.
 * @param {unknown} rawConfig - the validated composition entry.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // A logger that refuses the line must not take the plugin down with it.
      console.warn(`[dsh-long-data] ${message}`)
    }
  }

  const directory = stateDirectory(ctx)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    warn(`could not create the state directory ${directory}: ${describeError(error)}`)
  }

  const settings = new SettingsStore({
    path: join(directory, config.settingsFile),
    defaults: settingsDefaultsFrom(config),
  }).load()
  for (const warning of settings.warnings) warn(warning)

  // The Dockerfile scanner looks at every workspace directory the Host knows about,
  // plus any extra roots saved in the settings. The registry is optional: a Host
  // without it simply scans the configured roots.
  const ops = createOps({
    settings,
    config,
    logger: ctx.logger,
    workspaceRoots: () => {
      try {
        const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
        if (!registry || typeof registry.list !== 'function') return []
        const workspaces = registry.list()
        return Array.isArray(workspaces)
          ? workspaces.map((workspace) => workspace?.path).filter((path) => typeof path === 'string')
          : []
      } catch {
        return []
      }
    },
  })

  // The browser half posts here. `connection.fetch` rather than
  // `connection.rpc.handle`, for the reason spelled out in src/route.js.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register(createDataRoute({ ops })),
      'dsh-long-data: api route',
    )
    connectionCtx.logger?.info?.(`data panel endpoint published on ${API_PATH}`)
  })
}

export default { name, apply }
