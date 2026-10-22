# dsh-long-data

[简体中文](README.zh.md) | English

[![test](https://img.shields.io/badge/tests-340-brightgreen)](https://github.com/ddxl123/dsh-long-data)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A DeepSeek Harness plugin that puts **Docker**, **Redis** and **PostgreSQL** on one panel,
written for people who have never used any of them: it opens on a plain-language **Overview**
that says what is running, what is healthy and what needs attention, explains every term in
a built-in glossary, and hides the raw technical detail behind an optional **expert mode**.
Under the friendly surface it still does the real work — browsing containers, images,
volumes and networks (with their logs), scanning and editing Redis keys, and running SQL
against PostgreSQL — without leaving the harness.

Redis and PostgreSQL are expected to run **inside Docker**: the plugin discovers their
containers, uses the host port each one publishes and the credentials already present in
the container environment, so no host installation of `redis`/`psql` is needed. When
several instances are running, all of them are listed and a switcher lets you pick the
one a tab works with — the plugin never silently guesses.

A dedicated **Relations** page shows which container runs which image, which volumes it
mounts and which networks it is attached to, with an association graph and reverse
lookups.

The plugin is **page-only**: it registers a sidebar entry and a panel, and nothing on the
model's tool surface. It therefore costs no context tokens; the browser reaches the Host
half through the authenticated `/api` channel.

## What you get

- **Overview (概览)** — the landing page, readable with zero Docker/Redis/PostgreSQL
  knowledge: one sentence of overall health, three service cards (Docker = "the box manager",
  Redis = "fast temporary data", PostgreSQL = "the database") with friendly status, plain
  stats and one guided action each; a "what needs your attention" list in plain sentences
  with jump buttons; and a 3-step quick-start checklist for a brand-new machine.
- **Beginner / expert mode** — beginner mode is the default: containers show what they are
  for (网站服务 / 数据库 / 缓存 / …), states read 运行正常 / 已停止, destructive dialogs
  explain what will break, raw IDs and env dumps stay collapsed, and the SQL editor lives
  under "高级（SQL）". Expert mode restores the full technical surface. The choice is
  remembered in the browser.
- **Help drawer (？)** — plain-language glossary for 基础概念 (Docker / container / image /
  volume / network / port), Redis (key / TTL) and PostgreSQL (database / table / column /
  SQL), plus answers to "what happens if I stop a container?", "what happens if I delete a
  volume?", "several services are running — which one do I pick?" and "the panel cannot
  connect — what now?".
- **Dockerfile recognition** — the Docker tab's 构建文件 sub-tab finds Dockerfiles in
  your project directories (every harness workspace, plus extra roots you add in
  settings), and explains each one in plain words: which base image it starts from (and
  what that image is for), which ports it opens, whether it is a multi-stage build, how
  the program starts, its environment variables / volumes / health check, and a per-line
  "what this instruction does" annotation in the viewer. One click copies the matching
  `docker build` command or the file path. Files whose name is not `Dockerfile` are also
  recognized when their content starts with `FROM` (e.g. `Containerfile`). The page is
  read-only; only files found by the scan can be opened.
- **Relations** — a page of its own: inventory summary (containers, running, images,
  volumes, networks, dangling images, unused volumes), an image → container → volume
  association graph with network badges, a container relation table (image chip, volume
  chips and bind paths, network chips, ports), and reverse lookups by image / volume /
  network. Clicking a container jumps to its Docker row; clicking a resource jumps to the
  matching Docker sub-tab.
- **Docker** — four sub-tabs plus a disk-usage summary:
  - *Containers*: state, image, ports, status, live CPU / memory columns and a state
    filter; start / stop / restart / pause / unpause; a logs drawer with a line-count
    selector; details with the environment (credential-looking values masked), mounts and
    networks.
  - *Images*: repository:tag, short id, size, creation time, inspect details, remove.
  - *Volumes*: name, driver, scope, mountpoint, inspect details, remove.
  - *Networks*: name, driver, scope, internal flag, inspect details (subnets, attached
    containers), remove.
  - *Disk usage*: images / containers / volumes / build-cache count, size and
    reclaimable space.
  - **Every disruptive action asks twice**: stop, restart, pause and remove (and image /
    volume / network removal) open a focus-trapped confirmation; start and unpause are
    one click. Container rows refresh on a five-second timer while the tab is open.
- **Redis** — the connection is resolved from a Redis container (auto-picked, or pinned
  by name): its published host port plus credentials from `REDISCLI_AUTH` /
  `REDIS_PASSWORD` when the settings do not name them. The tab shows connection summary
  (version, uptime, clients, memory, keys, ops/sec, hit rate); a cursor-based `SCAN`
  browser with pattern and type filters; a type-aware value viewer with TTL and memory
  usage (string, list, set, zset, hash, stream); a guided "write data" wizard (pick a type,
  fill the fields, save); rename keys, set an expiry, persist a key; hash-field /
  list-push / set-add / set-remove editors; delete a key behind a confirmation. Types are
  named in plain words (文本 / 列表 / 集合 / 哈希 / 有序集合 / 流) and TTL reads "永不过期 /
  还有 N 分钟". The server section also shows DB size and the connected clients table.
- **PostgreSQL** — same container discovery (`POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` from the container environment): server version and current role;
  database list and per-database table list; a table's columns and types; a preview of
  the first 100 rows; a table detail panel with columns / indexes / constraints and the
  table's size; a paginated data browser with page-size control; an activity panel of live
  sessions; and a SQL editor whose result grid shows column names, rows (with `NULL`
  styling), duration and whether the row cap truncated the result, with CSV download and
  a query history. SQL errors show the PostgreSQL `SQLSTATE`.

Connection settings are edited in the panel's gear view and saved on the Host half. Each
service has a **mode**: *Docker container* (default — pick the container or let the plugin
choose the first running one) or *manual address* (host/port for a service reached some
other way).

## Install

The package is a bundle: its `cordis.patch.yml` inserts one host-plane row. Install the
directory that contains this `package.json` with the plugin manager, or from a terminal:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-long-data
```

After installation the sidebar shows a **Data panel** entry (next to the Todo list and
other panel plugins). No restart is needed when the bundle activates through HMR;
replacing an already-installed copy of the package requires a harness restart so the
Host half reloads its module.

## Requirements

- The harness ships its own Node runtime; the plugin imports **only Node builtins**, so
  there is no dependency to install and no native module to build.
- The **Docker tab** needs the `docker` CLI available to the Host process. When `docker`
  is not on the GUI app's `PATH`, the plugin also probes `/usr/local/bin/docker`,
  `/opt/homebrew/bin/docker`, `/Applications/Docker.app/Contents/Resources/bin/docker`
  and `~/.docker/bin/docker`. An absolute path can be set in the settings view.
- **Redis and PostgreSQL run inside Docker containers.** Redis/PostgreSQL containers must
  publish their port to the host (`-p 56379:6379`, `-p 55432:5432`, …); the plugin dials
  that published port from the Host process. No host `redis-cli`/`psql` installation is
  needed. A container without a published port is reported with an actionable error.
- Credentials: when the settings leave the password/role/database empty, the plugin uses
  what the container image already carries (`REDISCLI_AUTH` / `REDIS_PASSWORD`,
  `REDIS_USERNAME`; `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB`). Non-empty
  settings win. Manual mode always uses the settings fields.
- **Several instances:** every running Redis/PostgreSQL container is discovered. With
  exactly one running and no container pinned, it is used automatically; with two or more
  the panel reports the choice explicitly and the tab's instance bar (or the settings
  container select) pins the one to use. `redis.container` / `postgres.container` pin the
  default across restarts.
- TLS: Redis supports a plain TLS connection; PostgreSQL supports `disable`, `prefer`
  (try TLS, fall back to plain) and `require` (fail if the server refuses TLS).

## Configuration

The row lives in the profile's `cordis.patch.yml` layer (or in the bundle's own patch as
defaults). Every value is optional; a saved connection from the panel takes precedence
over the row's defaults.

| Key | Default | Meaning |
|---|---|---|
| `settingsFile` | `settings.json` | Document inside the plugin state directory that holds saved connections. |
| `docker.binary` | `docker` | Docker CLI name or absolute path. |
| `docker.timeoutMs` | `20000` | Per-command timeout before the child is killed. |
| `redis.mode` | `docker` | `docker` (discover a Redis container) or `manual`. |
| `redis.container` | empty | Container name to pin; empty picks the first running Redis container. |
| `redis.host` / `redis.port` | `127.0.0.1` / `6379` | Manual-mode address. |
| `redis.username` / `redis.password` | empty | ACL user and password (override container env credentials). |
| `redis.db` | `0` | Database index selected after connecting. |
| `redis.tls` | `false` | Wrap the connection in TLS. |
| `redis.timeoutMs` | `5000` | Connect/command timeout. |
| `postgres.mode` | `docker` | `docker` (discover a PostgreSQL container) or `manual`. |
| `postgres.container` | empty | Container name to pin; empty picks the first running PostgreSQL container. |
| `postgres.host` / `postgres.port` | `127.0.0.1` / `5432` | Manual-mode address. |
| `postgres.user` / `postgres.password` | empty | Login role; empty uses the container's `POSTGRES_USER` (then `postgres`). |
| `postgres.database` | empty | Database; empty uses the container's `POSTGRES_DB` (then `postgres`). |
| `postgres.ssl` | `prefer` | `disable` \| `prefer` \| `require`. |
| `postgres.timeoutMs` | `8000` | Connect/query timeout. |
| `logTailDefault` | `200` | Default Docker log lines per request. |
| `maxQueryRows` | `500` | Row cap applied to one SQL result. |
| `maxKeyScan` | `5000` | Upper bound on one `SCAN` hint. |
| `dockerfiles.roots` | `[]` | Extra absolute directories to scan for Dockerfiles (workspace directories are scanned automatically). |
| `dockerfiles.maxDepth` | `6` | How deep below each root the Dockerfile scan walks. |

The state directory follows the harness home, so each profile keeps its own saved
connections: `<harness home>/dsh-long-data/settings.json`. It is written atomically with
mode `0600` because it may hold passwords.

## Security notes

- Passwords never cross to the browser: the `/api/dsh-long-data` route returns a
  redacted settings view (`hasPassword` instead of the secret) and discovered containers
  expose only `hasPassword` / `credentialsSource`. A save with an empty password field
  keeps the stored one; the explicit way to forget a password is the stored
  `clearPassword` flag, surfaced by the settings form.
- Docker-mode credentials read the selected container's environment on the Host, are used
  for that connection, and are not written to `settings.json` unless you type them into
  the form. They are visible to anyone who can run `docker inspect` on the machine.
- Docker container environment values whose key looks like a credential
  (`PASSWORD`, `SECRET`, `TOKEN`, `API_KEY`, `AUTH`, …) are replaced with `***` before
  they reach the panel.
- The connection settings are not a security boundary: the harness process can read the
  document and talks to your databases with the credentials you give it. Treat the panel
  as a local operator tool.
- Container ids that look like CLI flags are rejected before any `docker` process is
  spawned, and container lifecycle actions are restricted to a fixed list.
- Redis is accessed through explicit commands (PING/INFO/SCAN/TYPE/GET/SET/DEL); the
  panel does not offer arbitrary command execution. PostgreSQL's SQL editor does accept
  arbitrary SQL by design, including writes — use it on databases you mean to change.

## Development

```bash
cd dsh-long-data
node --check src/index.js && node --check client/index.js
node --test test/
```

The Host half is split so each protocol can be tested alone:

| File | Role |
|---|---|
| `src/index.js` | Cordis entry: config, settings store, route registration. |
| `src/config.js` | Row config validation, defaults, state directory. |
| `src/settings.js` | Durable connection document, redaction, validation. |
| `src/docker.js` | Docker CLI service over `child_process` (argv arrays, no shell). |
| `src/redis.js` | Dependency-free RESP2 client over `node:net`. |
| `src/postgres.js` | Dependency-free PostgreSQL wire-protocol client (SCRAM-SHA-256). |
| `src/targets.js` | Discovers Redis/PostgreSQL containers and resolves host port + container-env credentials for every instance. |
| `src/relations.js` | Joins containers to images, volumes and networks for the Relations page. |
| `src/roles.js` | Guesses what a container is for (website / database / cache / …) so the UI can explain it in plain words. |
| `src/dockerfiles.js` | Bounded Dockerfile scanner and dependency-free parser (stages, base images, ports, command, per-instruction facts). |
| `src/ops.js` | One implementation of every capability. |
| `src/route.js` | `/api/dsh-long-data` Fetch route. |
| `client/index.js` | Browser panel: `window.__ModuleLoader__` factory, React only. |

Integration tests use whatever services they find and skip cleanly when they are not
there:

- Docker: the local daemon. Read-only: existing containers, images, volumes and networks
  are never removed, stopped or pruned.
- Docker-mode Redis/PostgreSQL discovery is exercised against whatever Redis/PostgreSQL
  containers exist; no running container means the test skips.
- Manual-mode protocol round-trips default to `127.0.0.1:6379` (no password) and
  `127.0.0.1:5432` (user/database `postgres`, no password); point them somewhere else
  with `DSH_LONG_DATA_REDIS_HOST/PORT/PASSWORD` and
  `DSH_LONG_DATA_PG_HOST/PORT/USER/PASSWORD/DATABASE`. They skip when unreachable.

## License

[MIT](LICENSE)

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
