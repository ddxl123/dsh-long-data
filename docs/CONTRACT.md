# dsh-long-data — build contract (internal, v0.2)

`dsh-long-data` is a DeepSeek Harness **bundle** with a Host half and a browser half.
It controls and inspects **Docker**, **Redis**, and **PostgreSQL** from one panel.

**Scope decision (user): page-only.** The plugin is used as a panel plugin and must NOT
register any model-facing tool, prompt section or injected context — it must not spend
the model's context budget. Do not add `ctx.tools.register`, `systemPrompt` sections or
agent contexts anywhere in this package.

**v0.2 requirements from the user:**

1. Stop / restart / pause / delete (and every other destructive or disruptive action)
   asks for a second confirmation in the panel.
2. Redis and PostgreSQL are expected to run **inside Docker containers**, not as host
   installations (this machine has none). The plugin must discover Redis/PostgreSQL
   containers, resolve the published host port, and use credentials from the container
   environment when the settings do not provide them. Manual host/port mode stays
   available as a fallback.
3. The Docker page must also cover images, volumes, networks and disk usage — not only
   containers.

## Identity constants

| Constant | Value |
|---|---|
| package / bundle name | `dsh-long-data` |
| panel id (`main` slot key, `sidebar.panellist` id) | `data` |
| locale namespace | `dsh-long-data` |
| panel API path | `/api/dsh-long-data` |
| state directory | `<harness home>/dsh-long-data` |

## Shared error module — `src/errors.js` (Lead-owned, unchanged)

```js
export class DataError extends Error { constructor(code, message, details = {}) }
export function describeError(error)
export function isDataError(error)
```

## Settings shape (v0.2)

```jsonc
{
  "docker": { "binary": "docker", "timeoutMs": 20000 },
  "redis": {
    "mode": "docker",          // "docker" | "manual"  (default "docker")
    "container": "",           // container name; "" = auto-pick a Redis container
    "host": "127.0.0.1", "port": 6379,
    "username": "", "password": "", "db": 0, "tls": false, "timeoutMs": 5000
  },
  "postgres": {
    "mode": "docker",          // "docker" | "manual"
    "container": "",           // container name; "" = auto-pick a PostgreSQL container
    "host": "127.0.0.1", "port": 5432,
    "user": "postgres", "password": "", "database": "postgres",
    "ssl": "prefer", "timeoutMs": 8000
  }
}
```

Redacted browser view adds `mode`, `container`, `hasPassword`, never the secret.

## Docker-mode target resolution (Lead-owned `src/targets.js`)

`resolveServiceConnection(service, settings, dockerService, candidates?)` → `{ connection, target }`
where `service` is `redis` | `postgres`, and:

- Docker discovery classifies containers by image name (`/redis/i`, `/postgres|postgis/i`).
- Candidate containers report `{ name, image, state, running, containerPort, hostPort,
  hasPassword, credentialsSource }` **without secrets**.
- Chosen container: `settings.container` when set (missing → `*_container_not_found`),
  else the first running candidate, else the first candidate, else `*_no_container`.
- Published port for container port `6379` / `5432`; none → `*_no_published_port`.
- Connection host = `127.0.0.1` when the published HostIp is `0.0.0.0`/`::`/empty.
- Credentials: settings value wins per field; otherwise container env
  (`REDISCLI_AUTH` / `REDIS_PASSWORD`, `REDIS_USERNAME`; `POSTGRES_PASSWORD`,
  `POSTGRES_USER`, `POSTGRES_DB`). `credentialsSource` is `settings` | `container-env` | `none`.
- Manual mode uses `settings.host/port/...` as-is.
- Docker unavailable while in docker mode → `*_docker_unavailable`.
- Candidate listing is cached by the ops layer for a few seconds; `settings.save`
  invalidates the cache.

## Ops envelope (Host, Lead-owned)

`POST /api/dsh-long-data` body `{"endpoint": string, "payload": object}` →
`{"ok": true, "value": any}` or `{"ok": false, "error": {"code","message","details"}}`.
Requests over 2 MiB → HTTP 413; wrong content type 415; malformed JSON 400.

| endpoint | payload | value |
|---|---|---|
| `state` | — | `{version, settings, docker:{available,binary,version,error}, targets:{redis,postgres}}` |
| `settings.save` | partial settings (incl. `mode`, `container`) | redacted settings view |
| `docker.list` | — | `{containers, count}` |
| `docker.inspect` | `{id}` | `{container}` (env credential values masked `***`) |
| `docker.logs` | `{id, tail?}` | `{id, name, logs}` |
| `docker.stats` | — | `{stats}` |
| `docker.action` | `{id, action}` action ∈ start\|stop\|restart\|pause\|unpause\|remove | `{id, action, ok:true}` |
| `docker.images` | — | `{images, count}` |
| `docker.imageRemove` | `{id, force?}` | `{id, ok:true}` |
| `docker.volumes` | — | `{volumes, count}` |
| `docker.volumeRemove` | `{name, force?}` | `{name, ok:true}` |
| `docker.networks` | — | `{networks, count}` |
| `docker.networkRemove` | `{name}` | `{name, ok:true}` |
| `docker.diskUsage` | — | `{usage}` |
| `redis.ping` / `info` / `scan` / `get` / `set` / `del` | as v0.1 | as v0.1 |
| `pg.version` / `databases` / `tables` / `columns` / `query` | as v0.1 | as v0.1 |

Redis/PostgreSQL endpoints resolve their connection through `src/targets.js`, so docker
mode changes which host/port/credentials are used without touching the protocol modules.

`targets` in `state`:

```ts
type Targets = {
  [service in 'redis' | 'postgres']: {
    candidates: {
      name: string; image: string; state: string; running: boolean;
      containerPort: string; hostPort: number | null; hasPassword: boolean;
      credentialsSource: 'container-env' | 'none';
    }[];
    resolved: {
      mode: 'docker' | 'manual'; container: string | null; host: string; port: number;
      credentialsSource: 'settings' | 'container-env' | 'none';
    } | null;
    error: { code: string; message: string } | null;
  };
}
```

## `src/docker.js` additions (owner: svc-docker)

Keep every v0.1 method and shape, and add:

```js
export const DOCKER_ACTIONS = ['start','stop','restart','pause','unpause','remove'] // unchanged
// createDockerService({ binary, timeoutMs, spawnProcess }) also exposes:
//   listImages()                          -> DockerImage[]
//   removeImage(id, {force=false})        -> { id, ok: true }
//   listVolumes()                         -> DockerVolume[]
//   removeVolume(name, {force=false})     -> { name, ok: true }
//   listNetworks()                        -> DockerNetwork[]
//   removeNetwork(name)                   -> { name, ok: true }
//   diskUsage()                           -> DockerDiskUsage
```

```ts
type DockerImage = {
  id: string; shortId: string; repoTags: string[]; repository: string; tag: string;
  size: string; sizeBytes: number; created: string; createdSince: string;
  containers: number | null;
}
type DockerVolume = {
  name: string; driver: string; scope: string;
  mountpoint: string | null; created: string | null; labels: Record<string, string>;
}
type DockerNetwork = {
  id: string; shortId: string; name: string; driver: string; scope: string;
  internal: boolean; ipv6: boolean;
}
type DockerDiskUsage = {
  images: DiskRow; containers: DiskRow; volumes: DiskRow; buildCache: DiskRow;
}
type DiskRow = { count: number; active: number | null; size: string; sizeBytes: number;
                 reclaimable: string; reclaimableBytes: number }
```

Implementation notes:

- `docker images --format '{{json .}}'`, `docker volume ls --format '{{json .}}'`
  (fall back to `docker volume inspect` per name when the row lacks Mountpoint),
  `docker network ls --format '{{json .}}'`, `docker system df --format '{{json .}}'`.
- `docker image rm`, `docker volume rm`, `docker network rm`; `force` adds `-f`.
- Every target argument is validated before spawning (no leading `-`, conservative
  allowed characters: image refs `/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,254}$/`; volume and
  network names `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/`). Error codes
  `docker_invalid_image`, `docker_invalid_volume`, `docker_invalid_network`.
- **Executable resolution**: the Host process may be a GUI app whose PATH lacks
  `/usr/local/bin`. When `binary` has no path separator and an ENOENT happens, retry
  once with the first existing candidate: `/usr/local/bin/docker`,
  `/opt/homebrew/bin/docker`, `/Applications/Docker.app/Contents/Resources/bin/docker`,
  then `~/.docker/bin/docker`; cache the resolved executable for later calls, and keep
  reporting `docker_unavailable` if none works. Unit-test this with an injected spawn.
- Keep the tests resilient to this machine's containers being restarted: assert shapes
  and presence, prefer a running candidate, skip cleanly when the CLI is absent; never
  remove/stop/prune anything that exists.

## Browser half — `client/index.js` (owner: client-ui)

Keep the v0.1 registration exactly (`main` key `data`, `sidebar.panellist` id `data`,
locale `dsh-long-data`, `inject: () => ({ client })`, zh + en dictionaries, one
stylesheet, React only, no imports/JSX/`document.body`).

### v0.2 additions

1. **Second confirmation for every destructive/disruptive action.**
   - Container `stop`, `restart`, `pause`, `remove` must open the existing
     `ConfirmDialog` (title names the container and the action; body explains the
     effect; confirm button uses danger styling). `start` and `unpause` stay one click.
   - Image remove, volume remove and network remove each open a confirmation too.
   - The dialog must keep the v0.1 quality: focus goes to Cancel, Tab is trapped,
     Escape / backdrop cancels, focus returns to the trigger.
2. **Docker sub-tabs** inside the Docker tab: 容器 / 镜像 / 数据卷 / 网络
   (`containers`, `images`, `volumes`, `networks`). Each has: count line, refresh,
   filter where useful, loading/empty/error states, per-row actions.
   - Disk usage summary above the sub-tabs (`docker.diskUsage`): images / containers /
     volumes / build cache with count + size + reclaimable, refreshed with the tab.
   - Images: repository:tag (or `<none>`), short id, size, created; remove (confirm).
   - Volumes: name, driver, scope, mountpoint (truncated, title tooltip); remove (confirm).
   - Networks: name, driver, scope, internal badge; remove (confirm).
   - Docker auto-refresh (5 s) applies to the visible Docker sub-tab; logs/detail drawers
     behave as before.
3. **Settings: Docker-container mode for Redis/PostgreSQL.**
   - Per service, a mode control: `Docker 容器` (default) vs `手动地址`.
   - Docker mode: a container `<select>` populated from `state.targets.<service>.candidates`
     (label: name · image · published port; disabled/annotated when not running) plus an
     empty = 自动选择 option. Host/port inputs are hidden or disabled in docker mode;
     show the resolved endpoint + credential source from `state.targets.<service>.resolved`
     (e.g. "yida_redis · 127.0.0.1:56379 · 凭据：容器环境变量") and the resolution error
     if any.
   - Manual mode: the v0.1 host/port/user/password/db/ssl fields.
   - Password fields keep the v0.1 contract (empty = keep stored; explicit clear); add
     the hint that an empty password in Docker mode falls back to the container's
     environment variables (`REDISCLI_AUTH` / `REDIS_PASSWORD`, `POSTGRES_PASSWORD`).
   - Save invalidates/refreshes `state` so candidates and resolved endpoints update.
4. Header chips show the resolved target: `Redis · yida_redis` / `PostgreSQL ·
   yida_postgres` when in docker mode (fallback to the manual host:port), with the
   container state reflected in the chip tone.
5. New locale keys for all added text, zh and en key-identical.

## Coding conventions

- Plain ESM `.js`, 2-space indent, single quotes, no semicolons (match sibling plugins).
- JSDoc on exported functions; module-level header comment explaining the piece.
- No `console.log` in Host code (use the injected logger); browser half may `console.warn`.
- Tests: `node --test test/`, `node:assert/strict`, no dependencies.
- Run `node --check <file>` on every JS file you write.

---

# v0.3 additions (user request)

Three requirements:

1. **A new page that shows the association graph** — which container uses which image,
   which volumes it mounts, which networks it is attached to — not just flat lists.
2. **Several Redis / PostgreSQL containers may be running at once.** All of them must be
   discovered and presented (per-instance status + a switcher), and auto mode must never
   silently pick "the first" when more than one is running: it reports an ambiguity and
   the panel asks the operator to choose.
3. **Make every feature richer**, within the page-only constraint (still no agent tools).

## v0.3 target resolution (`src/targets.js`, Lead-owned)

Selection rules for `mode: docker` (unchanged when a container is pinned):

- `settings.container` set → that candidate; not found → `<service>_container_not_found`.
- no pin, **zero running** candidates → `<service>_no_running_container` (details list the
  stopped candidates) / `<service>_no_container` when none exist at all.
- no pin, **exactly one running** candidate → that candidate.
- no pin, **two or more running** candidates → `<service>_ambiguous_container` with
  `details.candidates = [{name, image, hostPort}]`; the panel must show a selector and
  never connect to an arbitrary one.

New helper `resolveInstances(service, settings, candidates)` returns every **running**
candidate with its resolved endpoint (used by `state.targets.<service>.instances`):

```ts
type Instance = {
  container: string; image: string; state: string;
  host: string; port: number | null; containerPort: string;
  hasPublishedPort: boolean; hasPassword: boolean;
  credentialsSource: 'settings' | 'container-env' | 'none';
}
```

`state.targets.<service>` gains `instances: Instance[]`; `resolved` stays the selected
instance (null when pinned missing / ambiguous / no running container), `error` carries
the code above.

## New relations module (`src/relations.js`, Lead-owned)

`buildRelations(dockerService)` → graph of the local Docker inventory. One `ps`, one
inspect per container that matters, plus images / volumes / networks lists.

```ts
type Relations = {
  summary: {
    containers: number; running: number; images: number; volumes: number; networks: number;
    danglingImages: number; unusedVolumes: number;
  };
  containers: {
    id: string; name: string; state: string; image: string; imageId: string | null;
    createdAt: string; ports: Port[];
    volumes: { type: 'volume'|'bind'|'tmpfs'|string; name: string | null; source: string;
               destination: string; mode: string; rw: boolean }[];
    networks: { name: string; ipAddress: string | null }[];
  }[];
  images: { id: string; shortId: string; repoTags: string[]; size: string; sizeBytes: number;
            containers: string[] }[];
  volumes: { name: string; driver: string; scope: string; mountpoint: string | null;
             anonymous: boolean; containers: string[] }[];
  networks: { id: string; name: string; driver: string; scope: string; internal: boolean;
              containers: string[] }[];
}
```

Cached in ops for a few seconds; invalidated by `settings.save` and Docker mutations.

## v0.3 ops endpoints (additions only)

| endpoint | payload | value |
|---|---|---|
| `docker.relations` | — | `{relations}` |
| `docker.imageInspect` | `{id}` | `{image}` |
| `docker.volumeInspect` | `{name}` | `{volume}` |
| `docker.networkInspect` | `{name}` | `{network}` |
| `redis.clients` | — | `{clients: RedisClientInfo[], count}` |
| `redis.dbsize` | — | `{keys}` |
| `redis.memory` | `{key}` | `{key, bytes, human}` |
| `redis.rename` | `{key, newKey}` | `{key, newKey, renamed: true}` |
| `redis.expire` | `{key, ttlSeconds}` (1..31536000) | `{key, ttl}` |
| `redis.persist` | `{key}` | `{key, ttl: -1}` |
| `redis.hashSet` | `{key, field, value}` | `{key, field, fieldCount}` |
| `redis.listPush` | `{key, value, side: 'left'\|'right'}` | `{key, length}` |
| `redis.setAdd` | `{key, member}` | `{key, length}` |
| `redis.setRemove` | `{key, member}` | `{key, length, removed}` |
| `pg.activity` | `{database?}` | `{sessions: PgSession[]}` |
| `pg.tableDetail` | `{database?, schema, table}` | `{database, schema, table, size, estimatedRows, comment, columns, indexes, constraints}` |
| `pg.browse` | `{database?, schema, table, limit, offset, orderBy?, descending?, withCount?}` | `{database, schema, table, columns, rows, rowCount, totalRows, limitedBy}` |

Docker inspect methods are additions on `createDockerService`:

```js
// inspectContainer detail gains: imageId: string | null (full sha256 of the image)
//   inspectImage(id)          -> DockerImageDetail
//   inspectVolume(name)       -> DockerVolumeDetail
//   inspectNetwork(name)      -> DockerNetworkDetail
```

```ts
type DockerImageDetail = {
  id: string; shortId: string; repoTags: string[]; size: string; sizeBytes: number;
  created: string; architecture: string; os: string; cmd: string; entrypoint: string;
  env: { key: string; value: string }[]; labels: Record<string, string>;
  exposedPorts: string[]; containers: number | null;
}
type DockerVolumeDetail = {
  name: string; driver: string; scope: string; mountpoint: string | null;
  created: string | null; labels: Record<string, string>; options: Record<string, string>;
  anonymous: boolean;
}
type DockerNetworkDetail = {
  id: string; shortId: string; name: string; driver: string; scope: string;
  internal: boolean; ipv6: boolean; labels: Record<string, string>;
  subnets: { subnet: string; gateway: string | null }[];
  containers: { id: string; name: string; ipv4Address: string | null; ipv6Address: string | null }[];
}
```

Redis additions on `src/redis.js` (protocol module; exact shapes):

```js
export async function redisClients(connection)            // -> { clients: [{id, addr, name, ageSeconds, idleSeconds, db, command, user}], count }
export async function redisDbSize(connection)             // -> { keys }
export async function redisMemoryUsage(connection, key)   // -> { key, bytes, human }
export async function redisRename(connection, key, newKey)    // -> { key, newKey, renamed: true }
export async function redisExpire(connection, key, ttlSeconds)// -> { key, ttl }
export async function redisPersist(connection, key)       // -> { key, ttl: -1 }
export async function redisHashSet(connection, { key, field, value })   // -> { key, field, fieldCount }
export async function redisListPush(connection, { key, value, side })   // -> { key, length }
export async function redisSetAdd(connection, { key, member })          // -> { key, length }
export async function redisSetRemove(connection, { key, member })       // -> { key, length, removed }
```

PostgreSQL additions on `src/postgres.js`:

```js
export async function pgActivity(connection)                       // -> PgSession[]
export async function pgTableDetail(connection, { schema, table }) // -> { size, estimatedRows, comment, columns, indexes, constraints }
export async function pgBrowse(connection, { schema, table, limit, offset, orderBy, descending, withCount }) // -> { columns, rows, rowCount, totalRows, limitedBy }
// pgTables() rows gain: sizeBytes, size, comment, columnCount
// pgDatabases() rows gain: connections (active sessions on that database)
```

```ts
type PgSession = { pid: number; user: string | null; database: string | null; state: string | null;
  client: string | null; applicationName: string | null; backendStart: string | null;
  queryStart: string | null; querySeconds: number | null; query: string | null; waitEvent: string | null }
```

`pgBrowse` must quote identifiers itself (never interpolate raw text), accept only
`orderBy` values that are actual columns of the table, clamp `limit` to 1..500 and
`offset` to >= 0; `limitedBy` is `'limit'` when more rows were skipped. This is read-only.

## v0.3 browser half (client-ui)

Keep the v0.1/v0.2 registration (`main` key `data`, `sidebar.panellist` id `data`,
locale `dsh-long-data`, `inject: () => ({ client })`, zh + en dictionaries, one
stylesheet, React only, no imports/JSX/`document.body`).

### 1. New top-level page: 关联 (Relations)

A fourth top-level tab beside Docker / Redis / PostgreSQL (`relations`). It renders
`docker.relations`:

- Summary strip: containers (running/all), images, volumes, networks, dangling images,
  unused volumes.
- **Relation graph**: a compact, deterministically laid-out SVG with three columns —
  images (left) → containers (middle) → volumes (right) — plus a network badge under each
  container; one line per association, token-colored. Fixed row/column geometry so it
  aligns without measuring the DOM. Horizontally scrollable when wide.
- **Container relation table**: one row per container with state, image chip, volume chips
  (named volumes; bind mounts shown as truncated paths), network chips, ports. Clicking a
  container switches to the Docker tab and opens that container's details; clicking an
  image / volume / network switches to the matching Docker sub-tab and filters to it.
- **Reverse lookups**: a resource filter (all / image / volume / network) with a selector
  and a list of the containers associated with the chosen resource.
- Loading / empty / error states, refresh button, counts.

### 2. Multiple running instances

- Chips: when several instances are running and none is pinned, show
  `Redis · N 个运行中` (warn tone) and never claim a connection.
- Redis/PostgreSQL tabs show an instance bar: every running instance as a selectable
  chip (container name + host:port) plus an `自动` option; choosing one saves
  `{ mode: 'docker', container: name }` through `settings.save`, then reloads the tab.
  For an ambiguous selection the tab explains the choice instead of connecting.
- Settings: candidate select lists every candidate (running first, state annotated;
  stopped ones disabled), shows running count, and the resolved endpoint / credential
  source / resolution error as before.
- Error codes localized: `*_ambiguous_container`, `*_no_running_container`,
  `*_no_container`, `*_container_not_found`, `*_no_published_port`,
  `*_docker_unavailable`.

### 3. Richer existing pages

Docker:
- container rows gain live CPU / memory columns (single `docker.stats` fetch with the
  list) and a state filter (all / running / stopped / paused);
- images / volumes / networks get a details modal driven by the new inspect endpoints;
- disk usage card as in v0.2.

Redis:
- server section gains DB size and a clients table (`redis.clients`);
- key detail gains memory usage (`redis.memory`), rename, set-expiry (confirm) and
  persist actions;
- type-specific editors: hash field set, list push left/right, set add/remove, all with
  inline success/error notices.

PostgreSQL:
- activity panel (`pg.activity`) with sessions table;
- tables list shows size / estimated rows;
- table detail panel with 列 / 索引 / 约束 tabs (`pg.tableDetail`);
- data browser with pagination (`pg.browse`, page size selectable) and CSV download of the
  current result grid; query history (last 10, click to restore the statement).

Every disruptive action keeps the v0.2 confirmation contract (stop/restart/pause/remove,
image/volume/network remove, key delete, new: expire TTL and Redis rename are confirmed
when they can lose data — rename confirmed because the old key disappears).

Locale zh/en key-identical; only `--dsw-*` tokens; class prefix `dshData`; tests extended
with the new page, instance bar, new endpoints and new editors.

---

# v0.4 additions (user request: beginner-friendly, semantic, richer)

The panel is for someone who has **never heard of Docker, Redis or PostgreSQL**. It must
explain what everything is in plain language, lead the user to the right action, and make
irreversible actions understandable. Power features stay, but behind an **expert mode**.

Three themes: **richer** (overview/health report, role semantics, project grouping,
guided actions), **semantic** (what a container/volume/service *means*, what stopping it
*does*), **plain language** (beginner mode + help/glossary + friendly errors).

## Host: semantic role classification (`src/roles.js`, Lead-owned, new)

Deterministic inference from an image name, container name, labels and ports:

```js
export const ROLES = ['website', 'application', 'database', 'cache', 'queue', 'storage', 'monitoring', 'other']
export function classifyRole({ image, name, ports, labels }) -> 'website' | 'application' | 'database' | 'cache' | 'queue' | 'storage' | 'monitoring' | 'other'
export function composeProject(labels) -> { project: string|null, service: string|null } // from com.docker.compose.* labels
export function roleOfImage(image) -> string
```

Mapping rules (case-insensitive, tolerant of registry paths/versions):
nginx/httpd/caddy/traefik/envoy/haproxy/apache → `website`; postgres/mysql/mariadb/mongo/
clickhouse/sqlite/tidb/cockroach → `database`; redis/keydb/valkey/memcached → `cache`;
rabbitmq/kafka/nats/activemq/pulsar → `queue`; minio/cephfs/seaweedfs → `storage`;
prometheus/grafana/jaeger/zipkin/elk/loki → `monitoring`; anything with an exposed 80/443
port and no earlier match → `website`; other images with a port → `application`; else
`other`. The role is a hint for language and impact text, never a claim of correctness.

## Host: `docker.js` additions (owner: svc-docker)

- `listContainers()` rows gain `labels: Record<string,string>` parsed from the
  `docker ps --format '{{json .}}'` `Labels` field (`"k=v,k2=v2"` → object; empty → `{}`).
- `inspectContainer(id)` detail gains `labels: Record<string,string>` (from
  `Config.Labels`) and `restartPolicy: string|null` (from `HostConfig.RestartPolicy.Name`).
- Nothing else changes; validation/timeouts/fallback untouched. Tests: parsers + live.

## Host: `overview` endpoint (Lead-owned, new)

One call the overview page can render without joining anything itself. It is cached for a
few seconds and never throws: each section reports its own error.

`POST /api/dsh-long-data {endpoint:"overview"}` → value:

```ts
type Overview = {
  generatedAt: string;
  docker: { available: boolean; version: string | null; error: string | null };
  counts: { containers: number; running: number; stopped: number; images: number;
            volumes: number; networks: number; danglingImages: number; unusedVolumes: number };
  disk: DockerDiskUsage | null;
  containers: {
    name: string; state: string; image: string; role: string; project: string | null;
    service: string | null; restartPolicy: string | null;
    ports: { host: string | null; container: string; protocol: string }[];
    volumes: number; bindMounts: number; networks: number;
  }[];
  projects: { name: string; containers: number; running: number }[]; // compose project groups
  services: {
    redis: ServiceHealth;
    postgres: ServiceHealth;
  };
  insights: Insight[];
};

type ServiceHealth = {
  mode: 'docker' | 'manual';
  container: string | null;
  reachable: boolean;
  version: string | null;
  instances: number;          // running instances discovered (docker mode)
  ambiguous: boolean;
  summary: Record<string, unknown>; // redis: {keys,memoryHuman,clients}; postgres: {databases,sessions,currentDatabase}
  error: { code: string; message: string } | null;
};

type Insight = { code: string; level: 'good' | 'info' | 'warn' | 'danger'; params: Record<string, unknown> };
```

Canonical insight codes the client must localize (add more only with both locales):

- `docker_unavailable` (danger, `{}`)
- `no_containers` (info, `{}`)
- `stopped_containers` (warn, `{count, names[]}`)
- `restarting_containers` (warn, `{count, names[]}`)
- `unused_volumes` (info, `{count, names[]}`)
- `dangling_images` (info, `{count}`)
- `disk_reclaimable` (info, `{bytes, human}`) — only when reclaimable > 0
- `redis_ok` (good, `{container, version}`)
- `redis_ambiguous` (warn, `{count, names[]}`)
- `redis_no_container` (info, `{}`)
- `redis_no_running` (warn, `{names[]}`)
- `redis_unreachable` (danger, `{container, message}`)
- `postgres_ok` / `postgres_ambiguous` / `postgres_no_container` / `postgres_no_running` /
  `postgres_unreachable` (same shapes as redis)

`overview` probes Redis with `redisPing` + `redisInfo` (for keys/memory/clients) and
PostgreSQL with `pgVersion` + `pgDatabases` (count), using the resolved target; any failure
becomes the structured `error`/insight instead of a thrown request. Secrets never appear.

## Host: relations rows gain `role`

`buildRelations()` puts each container's `classifyRole(...)` result on its row as `role`
(the rest of the shape is unchanged).

## Browser half v0.4 (client-ui) — beginner-first redesign

Keep the registration, one stylesheet, React-only, zh+en key-identical dictionaries.

### Tabs and modes

Order: **概览 (overview) / Docker / Redis / PostgreSQL / 关联 (relations)**. The panel opens
on 概览. A header control switches **新手模式 (beginner, default) / 专家模式 (expert)**;
the choice persists in `localStorage` (`dsh-long-data:view-mode`). Beginner mode is the
default for a reason: it must be understandable with **zero** Docker/Redis/PostgreSQL
knowledge.

### 1. 概览 page (new, the landing page)

- **整体状态 card**: one plain sentence derived from `overview.insights` (e.g. "整体正常。
  有 2 个已停止的容器需要你留意。") plus counts of good/info/warn/danger insights.
- **三张服务卡**: Docker ("容器管家：负责运行各种软件的盒子"), Redis ("高速缓存：让应用更快的
  临时数据"), PostgreSQL ("数据库：长期保存业务数据"). Each card: plain description, friendly
  status pill (正常 / 未运行 / 连不上 / 有多个实例), 1–3 plain stats (e.g. "4 个程序在运行",
  "123 条缓存数据", "3 个数据库"), and a primary guided action (刷新 / 打开设置 / 选择实例 /
  复制启动命令).
- **需要你注意 (insights)**: every insight rendered as a friendly sentence with level icon
  and an action button that jumps to the relevant tab/settings (e.g. stopped containers →
  Docker tab; unused volumes → relations; redis_no_container → Redis tab empty state;
  redis_ambiguous → choice).
- **快速开始 (3 steps)**: a static onboarding checklist for absolute beginners
  (① 确认 Docker 在运行 ② 启动 Redis/PostgreSQL（可为没有容器的人一键复制命令）
  ③ 回到概览查看状态), with copy buttons and "已完成/未完成" derived from the overview.

### 2. Beginner language everywhere

- Every tab gets a one-line "这是什么" show-all banner (zh/en).
- Plain nouns: 容器=正在运行的程序盒子; 镜像=安装包; 数据卷=数据存放文件夹; 网络=程序之间的
  连线; 端口=对外入口; Redis 键=缓存数据条目; TTL=多久后自动清除; 表=数据表格; SQL=查询语言.
- Friendly states: 运行正常 / 已停止 / 已暂停 / 正在重启 / 已创建 / 出错了; never bare
  `running`/`exited` in beginner mode.
- Role chips for containers: 网站服务 / 应用服务 / 数据库 / 缓存 / 消息队列 / 存储 / 监控 / 其他.
- Impact sentences in confirmations: e.g. stopping a website-role container explains
  "停止后，网站将无法访问，直到重新启动它"; deleting a volume explains "里面的数据会永久丢失".
- Errors: every known error code maps to a plain sentence plus "你可以这样做" hint
  (keep the raw message on a second line, expert mode only).
- Empty states guide the next step and offer copyable `docker run` commands for Redis /
  PostgreSQL; beginner mode hides raw IDs, environment dumps, mount sources, labels and the
  SQL editor behind "技术细节（高级）" expanders (still reachable, never destructive).

### 3. Expert mode

Shows everything v0.3 showed: raw IDs, env, mounts, labels, SQL editor always open, full
tables, JSON-ish values, exact error text. Mode changes presentation only — no feature is
lost in either mode.

### 4. Richer interactions

- Docker: group containers by compose project (`overview.projects`/labels) with a plain
  "项目" heading; role chip + impact text; search + state filter; stats columns.
- Redis: "写入数据" wizard (choose type → fields → save) using the v0.3 editors; plain type
  names (文本 / 列表 / 集合 / 哈希 / 有序集合 / 流); TTL as "永不过期 / 还有 N 分钟".
- PostgreSQL: table browse is the primary beginner flow (database → table → data, with
  分页 + CSV); SQL editor has **模板按钮** (查看前 10 行 / 统计行数 / 查看有哪些列) filling the
  statement for the selected table; the editor itself is behind an "高级（SQL）" section in
  beginner mode.
- Help drawer (header "?"): 基础概念 (Docker/容器/镜像/数据卷/网络/端口), Redis (Redis/键/
  TTL), PostgreSQL (数据库/表/列/SQL), 常见问题 (停止容器会怎样 / 删除数据卷会怎样 /
  多个同名服务怎么选 / 面板连不上怎么办), each a one-sentence plain explanation.
- Copy buttons for useful values (container name, published address, suggested commands)
  with a transient "已复制" feedback; no clipboard failure may throw.

### 5. Tests

Extend `test/client.test.js`: overview tab renders insights/service cards and their action
buttons; beginner↔expert toggle changes what is visible and persists; help drawer content;
plain-language states/roles/impact confirmations; Redis type names + wizard; PostgreSQL
templates/advanced collapse; every new locale key exists in both dictionaries; hard source
constraints unchanged. `node --check` + `node --test test/client.test.js` twice.

---

# v0.5 addition: Dockerfile recognition

The panel must find **Dockerfiles** in the user's project directories, parse them, and
explain them in the same plain language as the rest of the beginner mode (what image it
builds, which base image it starts from, which ports it opens, how the program starts, and
what every instruction means).

## Host: `src/dockerfiles.js` (owner: svc-docker)

Dependency-free module over `node:fs/promises` and `node:path`. No YAML/compose parsing.

```js
export const DEFAULT_SCAN = Object.freeze({
  maxDepth: 6,          // directory levels below each root
  maxFiles: 4000,       // visited regular files before the walk stops early
  maxDockerfiles: 100,  // recognized files returned
  maxBytes: 1048576,    // largest Dockerfile parsed in full
  ignoreDirs: [...],    // node_modules,.git,.svn,.hg,dist,build,out,target,.next,.nuxt,
                        // .cache,.venv,venv,__pycache__,.idea,.vscode,coverage,vendor,
                        // .dsh,Library,site-packages,Pods,DerivedData
})

// Walk every root (absolute directory paths), skip ignored directories and symlinked
// directories, and return the recognized files, bounded by the limits above.
export async function scanDockerfiles({ roots, maxDepth, maxFiles, maxDockerfiles, maxBytes, ignoreDirs, signal } = {})
// -> {
//   roots: string[],
//   files: { path, relativePath, root, name, size, modifiedAt, detectedBy }[],  // detectedBy: 'name' | 'content'
//   visitedFiles: number,
//   truncated: boolean,          // any limit was hit
//   errors: { root: string, message: string }[]
// }

// Parse one Dockerfile's text. Pure and synchronous; never throws.
export function parseDockerfile(content) -> {
  instructions: { instruction: string, args: string, line: number, explanationKey: string }[],
  stages: {
    index: number, baseImage: string|null, name: string|null, instructions: number,
    exposedPorts: string[], workdir: string|null, user: string|null,
    entrypoint: string|null, cmd: string|null, volumes: string[],
    envKeys: string[], argNames: string[], labelKeys: string[],
    healthcheck: boolean, copyCount: number, addCount: number, runCount: number
  }[],
  parserDirectives: string[],
  instructionCount: number, stageCount: number, multiStage: boolean,
  baseImages: string[], finalBaseImage: string|null,
  exposedPorts: string[], workdir: string|null, user: string|null,
  entrypoint: string|null, cmd: string|null, command: string|null,
  volumes: string[], envKeys: string[], env: { key: string, value: string|null }[],
  argNames: string[], labelKeys: string[], healthcheck: boolean,
  copyCount: number, runCount: number,
  warnings: { line: number, message: string }[]
}

// Read a recognized file, bounded.
export async function readDockerfileText(filePath, maxBytes = 262144)
// -> { path, content, size, truncated }

// Cheap content probe used for non-standard file names (e.g. Containerfile).
export function looksLikeDockerfile(text) -> boolean
```

Parsing rules: line continuations (`\` at end), `#` comments (top `# key=value` lines are
`parserDirectives`), case-insensitive instructions normalized to upper case, `FROM image
[AS name]` (skip `--platform=...` flags), `EXPOSE` port list (strip `/tcp|/udp`), `ENV
key value` and `ENV key=value k2=v2`, `ARG name[=default]`, `VOLUME` JSON array or word
list, `HEALTHCHECK` flag, `COPY/ADD/RUN` counts, `COPY --from=` keeps the count. The final
stage's values populate the top-level summary fields; `command` is `ENTRYPOINT + CMD`
joined with a space when both exist. An empty/unknown document produces `warnings`, never
an exception.

Recognition: a regular file whose base name matches `/^Dockerfile(\..+)?$/i` or
`/\.dockerfile$/i` or is `Containerfile`, or whose first 16 KiB satisfy
`looksLikeDockerfile` (`/^\s*FROM\s+\S+/mi`) when the name has no extension — bounded by
`maxBytes`/`maxDockerfiles`. Unreadable entries are skipped silently; unreadable roots are
reported in `errors`.

## Host: settings + ops (Lead-owned)

Settings gain a fourth group: `dockerfiles: { roots: string[], maxDepth: number }`
(defaults `{ roots: [], maxDepth: 6 }`). `roots` are extra absolute directories to scan;
they are validated (absolute, non-empty, ≤ 20 entries) and returned by the redacted view.
The scan roots actually used are the distinct union of:

1. every workspace directory from the Host `workspaceRegistry` service
   (`workspaceRegistry.list().map(w => w.path)`), when available, and
2. `settings.dockerfiles.roots`.

New endpoints:

| endpoint | payload | value |
|---|---|---|
| `dockerfiles.list` | `{}` | `{ dockerfiles: DockerfileSummary[], roots: string[], scan: { visitedFiles, truncated, errors, generatedAt } }` |
| `dockerfiles.read` | `{ path }` | `{ path, name, relativePath, root, size, modifiedAt, content, truncated, parsed }` |

```ts
type DockerfileSummary = {
  path: string; name: string; relativePath: string; root: string;
  size: number; modifiedAt: string; detectedBy: 'name' | 'content';
  stageCount: number; multiStage: boolean; baseImages: string[]; finalBaseImage: string | null;
  exposedPorts: string[]; instructionCount: number; healthcheck: boolean;
  command: string | null; entrypoint: string | null; cmd: string | null;
  envKeys: string[]; volumes: string[];
  contextPath: string;          // dirname(path), for `docker build ... <context>`
  suggestedTag: string;         // lowercase directory basename, sanitized, `:latest`
}
```

`dockerfiles.read` resolves `path` only inside the current scan result (exact match), so
the route cannot read arbitrary files. Scans are cached for ~10 seconds and invalidated by
`settings.save`; `dockerfiles.list` accepts `refresh: true` to bypass the cache.

## Host: overview integration (Lead-owned)

`overview` gains `dockerfiles: { count: number, generatedAt: string } | null` and a
`dockerfiles_found` insight (`level: 'info'`, `params: { count, names[] }`) when at least one
Dockerfile is found; a failed scan leaves `dockerfiles: null` without failing the overview.

## Browser half (client-ui)

- Docker gains a fifth sub-tab **构建文件 (Dockerfile)**:
  - plain-language banner ("Dockerfile 是制作镜像的菜谱…");
  - scan roots line, refresh button, counts;
  - one card per Dockerfile: name + relative directory; base image with the role word
    ("基础镜像：nginx:1.31.6（网站服务器）"); exposed ports with plain meaning ("端口 80：
    网站访问入口"); 多阶段构建 badge; instruction count; file size; CMD/ENTRYPOINT preview;
    healthcheck / env / volume counts; buttons 查看内容 / 复制构建命令 / 复制路径;
  - viewer modal: raw content with line numbers plus, in beginner mode, each instruction
    annotated with a one-line plain explanation (FROM 基础镜像 / RUN 构建时执行的命令 /
    COPY 复制文件 / CMD 启动命令 / EXPOSE 开放端口 / ENV 环境变量 / WORKDIR 工作目录 /
    VOLUME 数据存放位置 / USER 运行身份 / HEALTHCHECK 健康检查 / ARG 构建参数 / LABEL
    说明标签 / 其他); expert mode shows the raw content and the parsed summary;
  - empty state explains what a Dockerfile is, lists where it looked, and offers a copyable
    sample Dockerfile plus a hint that scan roots can be added in settings;
  - copy-to-clipboard for the build command with transient 已复制 feedback.
- Settings view gains 构建文件 section: extra scan roots (one absolute path per line) and
  scan depth.
- Overview: Docker card shows the Dockerfile count and the `dockerfiles_found` insight
  renders like the others, with a jump button to the Dockerfile sub-tab.
- All new strings in zh+en, key-identical; registration/hard constraints unchanged.
