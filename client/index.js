/**
 * dsh-long-data — browser half.
 *
 * ## What it registers
 *
 * Two contributions, both global, so the panel is reachable from the rail from
 * anywhere in the shell:
 *
 *   - `sidebar.panellist` — the icon in the left rail. The sidebar renders one
 *     row per entry and calls `layout.selectPanel(entry.options.id)`, so the
 *     entry's `id` is the panel id and no click handler of ours is involved.
 *   - `main` (keyed by the same id) — the page itself, rendered while this
 *     panel is the active one. The slot injects a single {@link createDataClient}
 *     instance, whose snapshot is the one source of truth for every tab.
 *
 * ## Why one page instead of three panels
 *
 * Docker, Redis and PostgreSQL are three views over the same operational
 * question ("is my local stack healthy?"), so they share a header with one
 * connection chip each and one refresh action. The tab bar is local state; the
 * rail entry stays a single target.
 *
 * ## Where the data lives
 *
 * Nowhere in this file. The panel is a view over the Host half's operations:
 * every read and write posts `{endpoint, payload}` to
 * `/api/dsh-long-data` on Connection's authenticated `/api` channel (the
 * browser's own cookie carries the session) and unwraps the
 * `{ok, value}` / `{ok, error}` envelope. Passwords never come back: the
 * settings view reduces each one to `hasPassword`, and a save with an empty
 * password keeps the stored one.
 *
 * ## Failure posture
 *
 * A failure that means the Host could not be reached at all is classified
 * differently from a failure the Host answered with, because only the second
 * carries a reason the user can act on. Both render as a notice with a retry,
 * and a failed refresh keeps the rows already on screen instead of blanking the
 * page. Docker is the only tab that polls (every 5 s, only while visible), and
 * the interval is torn down when the tab changes or the page unmounts.
 *
 * ## Why it is a hand-written bundle
 *
 * Client halves are loaded by the web module loader
 * (`window.__ModuleLoader__`) as prebuilt CJS-table bundles rather than through
 * Node resolution, so this file registers one factory instead of exporting ESM.
 * Everything — CSS injection included — lives inside the factory closure,
 * because executing the bundle only *registers* it; the body runs when the
 * module is first materialized. `react` is a platform seed word the shell
 * always installs, so requiring it needs no build step and no dependency of our
 * own. No other Harness Client package is imported: a plain-JS plugin has no
 * type check, and a throwing component blanks its slot entry. The controls are
 * written here and styled from the host's theme tokens.
 *
 * @module dsh-long-data/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-long-data',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** This package's name: the locale namespace and the slot ids' owner. */
    const NS = 'dsh-long-data'
    /** The panel id, shared by the rail entry and the `main` slot key. */
    const PANEL_ID = 'data'
    /** The exact Fetch route the Host half publishes for this panel. */
    const API_PATH = '/api/dsh-long-data'
    /**
     * The failure code this half raises when the Host cannot be reached at all,
     * as opposed to answering and refusing the request. Only the first is an
     * error about the connection; the second carries a reason the user can act
     * on, and calling it "cannot reach the Host" would be wrong.
     */
    const UNREACHABLE = 'data_unreachable'
    /** The top-level tabs, in render order: the beginner landing page first. */
    const TABS = ['overview', 'docker', 'redis', 'postgres', 'relations']
    /** localStorage key for the beginner/expert choice. */
    const VIEW_MODE_KEY = 'dsh-long-data:view-mode'
    /** Container roles, as produced by the Host's role inference. */
    const ROLE_KEYS = ['website', 'application', 'database', 'cache', 'queue', 'storage', 'monitoring', 'other']
    /** Suggested start commands offered to absolute beginners. */
    const START_COMMANDS = {
      redis: 'docker run -d --name redis -p 6379:6379 redis:7',
      postgres: 'docker run -d --name postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16',
    }
    /** How long the "copied" feedback stays visible. */
    const COPY_FEEDBACK_MS = 1500
    /** Known Dockerfile instructions and the dictionary suffix explaining them. */
    const DOCKERFILE_EXPLAIN_KEYS = ['from', 'run', 'copy', 'add', 'cmd', 'entrypoint', 'expose', 'env', 'arg', 'workdir', 'user', 'volume', 'healthcheck', 'label']
    /** A tiny sample Dockerfile offered to beginners when nothing was found. */
    const SAMPLE_DOCKERFILE = 'FROM nginx:alpine\nCOPY ./site /usr/share/nginx/html\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n'
    /** The Docker sub-tabs, in render order. */
    const DOCKER_SUBTABS = ['containers', 'images', 'volumes', 'networks', 'dockerfiles']
    /** The `docker system df` categories, in render order. */
    const DISK_CATEGORIES = ['images', 'containers', 'volumes', 'buildCache']
    /** The list endpoint for each resource sub-tab, used after a removal. */
    const RESOURCE_LIST_ENDPOINTS = { images: 'docker.images', volumes: 'docker.volumes', networks: 'docker.networks' }
    /** The Docker state filter presets. */
    const DOCKER_STATE_FILTERS = ['all', 'running', 'stopped', 'paused']
    /** Page sizes offered by the PostgreSQL data browser. */
    const PG_PAGE_SIZES = [25, 50, 100, 200]
    /** How many statements the PostgreSQL query history keeps. */
    const MAX_QUERY_HISTORY = 10
    /**
     * How often the Docker tab re-reads the container list while it is visible.
     * The list is cheap (`docker ps`) and container state changes are exactly
     * what the page is for, so a short poll is worth it — but only for the
     * visible tab, and never while the page is hidden.
     */
    const DOCKER_POLL_MS = 5000
    /** The log tail sizes offered by the drawer. */
    const LOG_TAIL_OPTIONS = [100, 200, 500, 1000, 2000]
    /** The tail size used when a drawer is opened for a container. */
    const DEFAULT_LOG_TAIL = 200
    /** How many keys one SCAN round asks for. */
    const REDIS_SCAN_COUNT = 100
    /** The Redis types the browser can filter by. */
    const REDIS_TYPES = ['string', 'list', 'set', 'zset', 'hash', 'stream']
    /** The display cap for the SQL editor: roomy, but bounded. */
    const PG_QUERY_MAX_ROWS = 200
    /** How many rows the table preview asks for. */
    const PG_PREVIEW_ROWS = 100
    /** Longest Redis value rendered before the rest is cut off with a note. */
    const MAX_VALUE_CHARS = 8000

    const zh = {
      'panel': '数据面板',
      'title': '数据面板',
      'subtitle': 'Docker、Redis 与 PostgreSQL 的一站式管理',
      'refresh': '刷新',
      'refreshBusy': '正在刷新…',
      'loading': '正在载入…',
      'retry': '重试',
      'close': '关闭',
      'tab.overview': '概览',
      'tab.docker': 'Docker',
      'tab.redis': 'Redis',
      'tab.postgres': 'PostgreSQL',
      'tabs.aria': '服务切换',
      'chip.docker': 'Docker',
      'chip.redis': 'Redis',
      'chip.postgres': 'PostgreSQL',
      'chip.status.ok': '已连接',
      'chip.status.down': '连接失败',
      'chip.status.checking': '正在检查',
      'chip.status.unknown': '未检查',
      'chip.aria': '{service}：{status}',
      'chip.ariaTarget': '{service} · {target}：{status}',
      'settings.open': '连接设置',
      'settings.close': '返回面板',
      'settings.title': '连接设置',
      'settings.subtitle': '连接信息保存在 Host 半端，密码不会回传到浏览器。',
      'settings.docker.title': 'Docker',
      'settings.docker.binary': '可执行文件',
      'settings.docker.binaryHint': '默认使用 PATH 中的 docker，也可填写可执行文件的绝对路径。',
      'settings.redis.title': 'Redis',
      'settings.redis.host': '主机',
      'settings.redis.port': '端口',
      'settings.redis.username': '用户名',
      'settings.redis.password': '密码',
      'settings.redis.passwordStored': '已保存密码，留空保持不变',
      'settings.redis.passwordEmpty': '没有保存密码',
      'settings.redis.db': '数据库编号',
      'settings.redis.tls': '使用 TLS',
      'settings.postgres.title': 'PostgreSQL',
      'settings.postgres.host': '主机',
      'settings.postgres.port': '端口',
      'settings.postgres.user': '用户',
      'settings.postgres.password': '密码',
      'settings.postgres.passwordStored': '已保存密码，留空保持不变',
      'settings.postgres.passwordEmpty': '没有保存密码',
      'settings.postgres.database': '数据库',
      'settings.postgres.ssl': 'SSL 模式',
      'settings.postgres.ssl.disable': '禁用',
      'settings.postgres.ssl.prefer': '优先',
      'settings.postgres.ssl.require': '必须',
      'settings.mode': '连接方式',
      'settings.mode.docker': 'Docker 容器',
      'settings.mode.manual': '手动地址',
      'settings.target.label': '容器',
      'settings.target.auto': '自动选择（第一个运行中的容器）',
      'settings.target.stopped': '未运行',
      'settings.target.noPortShort': '无端口',
      'settings.target.noPort': '容器没有把端口发布到主机。',
      'settings.target.noContainer': '没有发现 {service} 容器。',
      'settings.target.notFound': '在 Docker 中找不到容器“{container}”。',
      'settings.target.dockerUnavailable': 'Docker 不可用，无法解析容器。',
      'settings.target.error': '目标解析失败',
      'settings.target.resolved': '解析结果：{endpoint}',
      'settings.target.credentials': '凭据来源：{source}',
      'settings.target.credentials.settings': '设置中的值',
      'settings.target.credentials.container-env': '容器环境变量',
      'settings.target.credentials.none': '无',
      'settings.target.candidates': '发现 {count} 个候选容器',
      'settings.target.noCandidates': '没有发现匹配的容器，确认它以 Redis/PostgreSQL 镜像运行。',
      'settings.target.containerHint': '留空表示自动选择第一个运行中的容器。',
      'settings.target.overrideHint': 'Docker 模式下这些凭据作为覆盖值，留空则使用容器环境变量。',
      'settings.redis.passwordDockerHint': '留空则使用容器环境变量中的凭据（REDISCLI_AUTH / REDIS_PASSWORD）。',
      'settings.postgres.passwordDockerHint': '留空则使用容器环境变量中的凭据（POSTGRES_PASSWORD）。',
      'settings.clearPassword': '清除已保存的密码',
      'settings.save': '保存',
      'settings.saving': '正在保存…',
      'settings.saved': '连接设置已保存',
      'settings.saveHint': '密码留空表示沿用已保存的密码。',
      'settings.test': '测试连接',
      'settings.testing': '正在测试…',
      'settings.testOk': '连接成功：{detail}',
      'settings.testFailed': '连接失败：{message}',
      'docker.tab.containers': '容器',
      'docker.tab.images': '镜像',
      'docker.tab.volumes': '数据卷',
      'docker.tab.networks': '网络',
      'docker.tab.dockerfiles': '构建文件',
      'docker.subtabs.aria': 'Docker 资源',
      'docker.disk.title': '磁盘占用',
      'docker.disk.images': '镜像',
      'docker.disk.containers': '容器',
      'docker.disk.volumes': '数据卷',
      'docker.disk.buildCache': '构建缓存',
      'docker.disk.count': '{count} 个',
      'docker.disk.reclaimable': '可回收 {size}',
      'docker.disk.loading': '正在读取磁盘占用…',
      'docker.disk.none': '—',
      'docker.images.count': '{count} 个镜像',
      'docker.images.loading': '正在读取镜像…',
      'docker.images.empty.title': '没有镜像',
      'docker.images.empty.hint': '这台主机上还没有 Docker 镜像。',
      'docker.images.untagged': '<none>',
      'docker.images.containers': '{count} 个容器',
      'docker.images.remove': '删除镜像',
      'docker.volumes.count': '{count} 个数据卷',
      'docker.volumes.loading': '正在读取数据卷…',
      'docker.volumes.empty.title': '没有数据卷',
      'docker.volumes.empty.hint': '这台主机上还没有 Docker 数据卷。',
      'docker.volumes.remove': '删除数据卷',
      'docker.networks.count': '{count} 个网络',
      'docker.networks.loading': '正在读取网络…',
      'docker.networks.empty.title': '没有网络',
      'docker.networks.empty.hint': '这台主机上还没有可显示的 Docker 网络。',
      'docker.networks.remove': '删除网络',
      'docker.networks.internal': '内部',
      'docker.removing': '正在删除…',
      'docker.filter': '过滤容器',
      'docker.filterResource': '过滤资源',
      'docker.resourceCountFiltered': '{shown}/{total}',
      'docker.count': '共 {count} 个容器',
      'docker.countFiltered': '{shown}/{total} 个容器',
      'docker.autoRefresh': '每 5 秒自动刷新',
      'docker.loading': '正在读取容器列表…',
      'docker.empty.title': '没有容器',
      'docker.empty.hint': '这台主机上还没有 Docker 容器。',
      'docker.filterEmpty.title': '没有匹配的容器',
      'docker.filterEmpty.hint': '换一个过滤词试试。',
      'docker.unavailable.title': 'Docker 不可用',
      'docker.unavailable.hint': '确认 Docker 已安装并在 PATH 中，或在连接设置里填写可执行文件路径。',
      'docker.unavailable.action': '打开设置',
      'docker.state.running': '运行中',
      'docker.state.exited': '已停止',
      'docker.state.paused': '已暂停',
      'docker.state.created': '已创建',
      'docker.state.restarting': '重启中',
      'docker.state.dead': '已失效',
      'docker.state.other': '其他状态',
      'docker.action.start': '启动',
      'docker.action.stop': '停止',
      'docker.action.restart': '重启',
      'docker.action.pause': '暂停',
      'docker.action.unpause': '恢复',
      'docker.action.remove': '删除容器',
      'docker.action.logs': '日志',
      'docker.action.details': '详情',
      'docker.action.hideDetails': '收起详情',
      'docker.busy': '正在执行…',
      'docker.portsNone': '无端口映射',
      'docker.logs.title': '容器日志',
      'docker.logs.tail': '行数',
      'docker.logs.refresh': '刷新日志',
      'docker.logs.loading': '正在读取日志…',
      'docker.logs.empty': '没有日志输出。',
      'docker.detail.loading': '正在读取容器详情…',
      'docker.detail.overview': '概况',
      'docker.detail.env': '环境变量',
      'docker.detail.mounts': '挂载',
      'docker.detail.networks': '网络',
      'docker.detail.empty': '无',
      'docker.detail.modeRw': '读写',
      'docker.detail.modeRo': '只读',
      'docker.detail.health': '健康检查',
      'docker.detail.restartCount': '重启次数',
      'docker.detail.exitCode': '退出码',
      'docker.detail.startedAt': '启动时间',
      'docker.detail.finishedAt': '结束时间',
      'docker.detail.platform': '平台',
      'docker.detail.entrypoint': '入口',
      'docker.detail.cmd': '命令',
      'docker.detail.logPath': '日志路径',
      'docker.detail.createdAt': '创建时间',
      'confirm.containerStop.title': '停止容器“{name}”？',
      'confirm.containerStop.body': '容器内的进程会收到停止信号，之后可以用“启动”恢复。',
      'confirm.containerStop.action': '停止容器',
      'confirm.containerRestart.title': '重启容器“{name}”？',
      'confirm.containerRestart.body': '容器会被停止并立即重新启动，期间服务短暂不可用。',
      'confirm.containerRestart.action': '重启容器',
      'confirm.containerPause.title': '暂停容器“{name}”？',
      'confirm.containerPause.body': '容器内的进程会被冻结，直到你恢复它。',
      'confirm.containerPause.action': '暂停容器',
      'confirm.containerRemove.title': '删除容器“{name}”？',
      'confirm.containerRemove.body': '容器会被删除，此操作无法撤销。',
      'confirm.containerRemove.action': '删除容器',
      'confirm.imageRemove.title': '删除镜像“{name}”？',
      'confirm.imageRemove.body': '镜像会被删除；仍在使用它的容器会阻止这次删除。',
      'confirm.imageRemove.action': '删除镜像',
      'confirm.volumeRemove.title': '删除数据卷“{name}”？',
      'confirm.volumeRemove.body': '数据卷及其中的数据会被永久删除，此操作无法撤销。',
      'confirm.volumeRemove.action': '删除数据卷',
      'confirm.networkRemove.title': '删除网络“{name}”？',
      'confirm.networkRemove.body': '网络会被删除；仍连接它的容器会阻止这次删除。',
      'confirm.networkRemove.action': '删除网络',
      'redis.summary.version': '版本',
      'redis.summary.uptime': '运行时长',
      'redis.summary.clients': '客户端',
      'redis.summary.memory': '已用内存',
      'redis.summary.keys': '键总数',
      'redis.summary.ops': '每秒操作',
      'redis.summary.hitRate': '命中率',
      'redis.summary.none': '—',
      'redis.percent': '{percent}%',
      'redis.uptime.days': '{days} 天 {hours} 小时',
      'redis.uptime.hours': '{hours} 小时 {minutes} 分',
      'redis.uptime.minutes': '{minutes} 分 {seconds} 秒',
      'redis.uptime.seconds': '{seconds} 秒',
      'redis.browser.title': '键浏览',
      'redis.browser.pattern': '匹配模式',
      'redis.browser.patternPlaceholder': '例如 user:*',
      'redis.browser.type': '类型',
      'redis.browser.typeAny': '全部类型',
      'redis.browser.scan': '扫描',
      'redis.browser.loading': '正在扫描…',
      'redis.browser.loadMore': '加载更多',
      'redis.browser.done': '已扫描全部匹配的键。',
      'redis.browser.scanned': '已列出 {count} 个键',
      'redis.browser.empty.title': '没有匹配的键',
      'redis.browser.empty.hint': '调整匹配模式或类型后重新扫描。',
      'redis.browser.selectHint': '在左侧选择一个键查看内容。',
      'redis.key.title': '键内容',
      'redis.key.loading': '正在读取键…',
      'redis.key.type': '类型',
      'redis.key.ttl': '过期时间',
      'redis.key.ttl.persistent': '永不过期',
      'redis.key.ttl.missing': '键不存在',
      'redis.key.ttl.seconds': '{seconds} 秒',
      'redis.key.null': '空值',
      'redis.key.truncated': '内容过长，仅显示前 {limit} 个字符。',
      'redis.key.items': '{count} 项',
      'redis.key.score': '分数',
      'redis.key.delete': '删除键',
      'redis.delete.title': '删除这个键？',
      'redis.delete.body': '键“{key}”将被永久删除，此操作无法撤销。',
      'redis.delete.action': '删除键',
      'redis.set.title': '写入字符串',
      'redis.set.key': '键',
      'redis.set.keyPlaceholder': '例如 cache:token',
      'redis.set.value': '值',
      'redis.set.ttl': '过期秒数',
      'redis.set.ttlPlaceholder': '留空表示永不过期',
      'redis.set.submit': '写入',
      'redis.set.saving': '正在写入…',
      'redis.set.success': '已写入“{key}”。',
      'redis.set.successTtl': '已写入“{key}”，{seconds} 秒后过期。',
      'pg.status': 'PostgreSQL {version} · {user}@{database}',
      'pg.database': '数据库',
      'pg.tables': '表',
      'pg.tables.count': '{count} 个对象',
      'pg.tables.filter': '过滤表',
      'pg.tables.loading': '正在读取表…',
      'pg.tables.empty.title': '没有表',
      'pg.tables.empty.hint': '这个数据库里没有可显示的表或视图。',
      'pg.tables.emptyFilter.title': '没有匹配的表',
      'pg.tables.emptyFilter.hint': '换一个过滤词试试。',
      'pg.tables.rows': '{count} 行',
      'pg.kind.table': '表',
      'pg.kind.view': '视图',
      'pg.kind.materializedView': '物化视图',
      'pg.kind.foreignTable': '外部表',
      'pg.yes': '是',
      'pg.no': '否',
      'pg.columns.title': '列',
      'pg.columns.name': '列名',
      'pg.columns.type': '类型',
      'pg.columns.nullable': '可空',
      'pg.columns.default': '默认值',
      'pg.columns.empty': '还没有选择表。',
      'pg.columns.loading': '正在读取列…',
      'pg.preview': '预览 100 行',
      'pg.preview.loading': '正在读取预览…',
      'pg.preview.title': '预览',
      'pg.query.title': 'SQL 查询',
      'pg.query.placeholder': 'SELECT * FROM ...',
      'pg.query.run': '执行',
      'pg.query.running': '正在执行…',
      'pg.query.hint': 'Ctrl+Enter 执行查询',
      'pg.query.empty': '执行一条查询后，结果会显示在这里。',
      'pg.query.failed': '查询失败',
      'pg.query.sqlState': 'SQLSTATE {state}',
      'pg.query.detail': '详细信息：{detail}',
      'pg.query.hintField': '建议：{hint}',
      'pg.query.position': '位置：{position}',
      'pg.query.duration': '耗时 {ms} 毫秒',
      'pg.query.truncated': '结果已截断，只显示前 {rows} 行。',
      'pg.query.rows': '{count} 行',
      'pg.query.affected': '{count} 行受影响',
      'pg.null': 'NULL',
      'error.unreachable': '无法访问 Host 半端：{message}',
      'error.refused': '请求失败：{message}',
      'error.dockerUnavailable': 'Docker 不可用：{message}',
      'error.dockerTimeout': 'Docker 操作超时：{message}',
      'error.redisUnreachable': '无法连接 Redis：{message}',
      'error.redisAuth': 'Redis 认证失败：{message}',
      'error.redisTimeout': 'Redis 操作超时：{message}',
      'error.pgUnreachable': '无法连接 PostgreSQL：{message}',
      'error.pgAuth': 'PostgreSQL 认证失败：{message}',
      'error.pgTimeout': 'PostgreSQL 操作超时：{message}',
      'error.pgSsl': 'PostgreSQL SSL 握手失败：{message}',
      'error.invalidPayload': '请求参数无效：{message}',
      'error.dockerInvalidTarget': 'Docker 资源名称无效：{message}',
      'confirm.cancel': '取消',
      'tab.relations': '关联',
      'relations.title': '关联关系',
      'relations.subtitle': '镜像、容器、数据卷与网络的对应关系',
      'relations.loading': '正在读取关联关系…',
      'relations.empty.title': '没有可显示的资源',
      'relations.empty.hint': '主机上还没有容器、镜像或数据卷。',
      'relations.summary.containers': '容器',
      'relations.summary.images': '镜像',
      'relations.summary.volumes': '数据卷',
      'relations.summary.networks': '网络',
      'relations.summary.danglingImages': '悬空镜像',
      'relations.summary.unusedVolumes': '未使用数据卷',
      'relations.summary.running': '运行中 {running}/{total}',
      'relations.graph.title': '关系图',
      'relations.graph.legend.images': '镜像',
      'relations.graph.legend.containers': '容器',
      'relations.graph.legend.volumes': '数据卷',
      'relations.graph.empty': '没有可绘制的关联。',
      'relations.graph.networks': '网络',
      'relations.table.title': '容器关联',
      'relations.table.container': '容器',
      'relations.table.state': '状态',
      'relations.table.image': '镜像',
      'relations.table.volumes': '数据卷',
      'relations.table.networks': '网络',
      'relations.table.ports': '端口',
      'relations.table.empty': '没有容器。',
      'relations.reverse.title': '反向查找',
      'relations.reverse.kind': '资源类型',
      'relations.reverse.resource': '资源',
      'relations.reverse.all': '全部资源',
      'relations.reverse.images': '镜像',
      'relations.reverse.volumes': '数据卷',
      'relations.reverse.networks': '网络',
      'relations.reverse.count': '{count} 个关联容器',
      'relations.reverse.empty': '没有容器关联到这个资源。',
      'chip.instances': '{count} 个运行中',
      'chip.noRunning': '无运行实例',
      'instance.bar': '实例',
      'instance.auto': '自动',
      'instance.choose': '请选择一个实例',
      'instance.saved': '已切换实例',
      'instance.runningCount': '{count} 个运行中',
      'error.ambiguousContainer': '{count} 个容器同时在运行，请先选择一个实例。',
      'error.noRunningContainer': '没有运行中的容器，请启动一个或切换为手动地址。',
      'error.noContainer': '没有发现匹配的容器。',
      'error.containerNotFound': '找不到指定的容器。',
      'error.noPublishedPort': '容器没有把端口发布到主机。',
      'settings.target.runningCount': '{count} 个运行中',
      'settings.target.ambiguous': '有 {count} 个容器同时在运行，请选择一个容器。',
      'settings.target.noRunning': '没有运行中的容器，请先启动一个。',
      'docker.stateFilter.aria': '状态过滤',
      'docker.stateFilter.all': '全部',
      'docker.stateFilter.running': '运行中',
      'docker.stateFilter.stopped': '已停止',
      'docker.stateFilter.paused': '已暂停',
      'docker.stats.cpu': 'CPU',
      'docker.stats.memory': '内存',
      'docker.stats.none': '—',
      'docker.inspect.title': '详情',
      'docker.inspect.loading': '正在读取详情…',
      'docker.inspect.close': '关闭',
      'docker.inspect.containers': '使用它的容器',
      'docker.inspect.exposedPorts': '暴露端口',
      'docker.inspect.architecture': '架构',
      'docker.inspect.os': '系统',
      'docker.inspect.labels': '标签',
      'docker.inspect.env': '环境变量',
      'docker.inspect.mountpoint': '挂载点',
      'docker.inspect.options': '选项',
      'docker.inspect.subnets': '子网',
      'docker.inspect.gateway': '网关',
      'docker.inspect.attached': '连接容器',
      'docker.inspect.ipv4': 'IPv4',
      'docker.inspect.ipv6': 'IPv6',
      'docker.inspect.anonymous': '匿名卷',
      'docker.images.inspect': '查看镜像详情',
      'docker.volumes.inspect': '查看数据卷详情',
      'docker.networks.inspect': '查看网络详情',
      'redis.server.title': '服务端',
      'redis.server.dbsize': '当前库键数',
      'redis.server.clients': '客户端连接',
      'redis.server.clientsCount': '{count} 个连接',
      'redis.server.loading': '正在读取服务端信息…',
      'redis.clients.id': 'ID',
      'redis.clients.addr': '地址',
      'redis.clients.name': '名称',
      'redis.clients.age': '连接时长',
      'redis.clients.idle': '空闲',
      'redis.clients.db': '库',
      'redis.clients.command': '当前命令',
      'redis.clients.user': '用户',
      'redis.clients.empty': '没有客户端连接。',
      'redis.key.memory': '内存占用',
      'redis.key.memory.loading': '正在读取内存…',
      'redis.key.rename': '重命名',
      'redis.key.renamePlaceholder': '新键名',
      'redis.key.renameAction': '重命名',
      'redis.key.expire': '设置过期',
      'redis.key.expirePlaceholder': '秒数',
      'redis.key.expireAction': '设置',
      'redis.key.persist': '永久保存',
      'redis.key.persistAction': '移除过期时间',
      'redis.key.actions': '键操作',
      'redis.key.notice.renamed': '已重命名为“{key}”。',
      'redis.key.notice.expired': '已设置过期时间 {seconds} 秒。',
      'redis.key.notice.persisted': '已移除过期时间。',
      'redis.editor.hash.title': '写入哈希字段',
      'redis.editor.hash.field': '字段',
      'redis.editor.hash.value': '值',
      'redis.editor.list.title': '推入列表',
      'redis.editor.list.side': '方向',
      'redis.editor.list.left': '从左侧（LPUSH）',
      'redis.editor.list.right': '从右侧（RPUSH）',
      'redis.editor.set.title': '集合成员',
      'redis.editor.set.member': '成员',
      'redis.editor.add': '添加',
      'redis.editor.remove': '移除',
      'redis.editor.submit': '写入',
      'redis.editor.notice.hashSet': '已写入字段“{field}”（共 {count} 个字段）。',
      'redis.editor.notice.listPush': '已推入，当前长度 {length}。',
      'redis.editor.notice.setAdd': '已添加，当前 {length} 个成员。',
      'redis.editor.notice.setRemove': '已移除，当前 {length} 个成员。',
      'redis.editor.notice.setAbsent': '成员不存在（当前 {length} 个成员）。',
      'redis.editor.unsupported': '该类型不支持在这里编辑。',
      'confirm.redisRename.title': '重命名键“{key}”？',
      'confirm.redisRename.body': '键会立即改名为“{newKey}”，旧键名随即消失。',
      'confirm.redisRename.action': '重命名',
      'confirm.redisExpire.title': '给键“{key}”设置过期？',
      'confirm.redisExpire.body': '{seconds} 秒后键及其内容会被自动删除。',
      'confirm.redisExpire.action': '设置过期',
      'pg.activity.title': '活动会话',
      'pg.activity.count': '{count} 个会话',
      'pg.activity.empty': '没有活动会话。',
      'pg.activity.pid': 'PID',
      'pg.activity.user': '用户',
      'pg.activity.database': '数据库',
      'pg.activity.state': '状态',
      'pg.activity.client': '客户端',
      'pg.activity.application': '应用',
      'pg.activity.query': '查询',
      'pg.activity.duration': '耗时',
      'pg.activity.wait': '等待事件',
      'pg.activity.loading': '正在读取会话…',
      'pg.tables.size': '大小',
      'pg.detail.columns': '列',
      'pg.detail.indexes': '索引',
      'pg.detail.constraints': '约束',
      'pg.detail.loading': '正在读取表详情…',
      'pg.detail.emptyIndexes': '没有索引。',
      'pg.detail.emptyConstraints': '没有约束。',
      'pg.detail.index.name': '索引',
      'pg.detail.index.columns': '列',
      'pg.detail.index.unique': '唯一',
      'pg.detail.index.primary': '主键',
      'pg.detail.constraint.name': '约束',
      'pg.detail.constraint.type': '类型',
      'pg.detail.constraint.definition': '定义',
      'pg.detail.comment': '注释',
      'pg.detail.size': '大小',
      'pg.detail.estimated': '估算行数',
      'pg.detail.tabs': '表详情',
      'pg.browse.title': '数据浏览',
      'pg.browse.loading': '正在读取数据…',
      'pg.browse.page': '第 {page} 页',
      'pg.browse.total': '共 {count} 行',
      'pg.browse.pageSize': '每页',
      'pg.browse.prev': '上一页',
      'pg.browse.next': '下一页',
      'pg.browse.empty': '没有数据。',
      'pg.browse.limited': '仅显示前 {count} 行。',
      'pg.browse.csv': '下载 CSV',
      'pg.browse.csvEmpty': '没有可导出的数据。',
      'pg.browse.csvDone': '已开始下载。',
      'pg.history.title': '查询历史',
      'pg.history.empty': '还没有执行过查询。',
      'pg.history.restore': '恢复这条语句',
      'pg.history.restored': '已恢复到编辑器。',
      'plain.banner.overview': '这一页用大白话告诉你：本机的程序、缓存和数据库现在怎么样了。',
      'plain.banner.docker': '容器就是正在运行的程序盒子；镜像像安装包，数据卷是放数据的文件夹。',
      'plain.banner.redis': 'Redis 是内存里的高速缓存，用来让程序更快。',
      'plain.banner.postgres': 'PostgreSQL 是长期保存业务数据的数据库，用表格存数据。',
      'plain.banner.relations': '这里画出程序、安装包、数据文件夹和网络之间的对应关系。',
      'plain.advanced': '技术细节（高级）',
      'plain.advancedSql': '高级（SQL）',
      'plain.state.running': '运行正常',
      'plain.state.exited': '已停止',
      'plain.state.paused': '已暂停',
      'plain.state.restarting': '正在重启',
      'plain.state.created': '已创建',
      'plain.state.dead': '出错了',
      'plain.state.other': '状态未知',
      'plain.role.website': '网站服务',
      'plain.role.application': '应用服务',
      'plain.role.database': '数据库',
      'plain.role.cache': '缓存',
      'plain.role.queue': '消息队列',
      'plain.role.storage': '存储',
      'plain.role.monitoring': '监控',
      'plain.role.other': '其他',
      'plain.redisType.string': '文本',
      'plain.redisType.list': '列表',
      'plain.redisType.set': '集合',
      'plain.redisType.zset': '有序集合',
      'plain.redisType.hash': '哈希',
      'plain.redisType.stream': '流',
      'plain.ttl': '有效期',
      'plain.ttl.never': '永不过期',
      'plain.ttl.missing': '数据已不存在',
      'plain.ttl.minutes': '还有 {minutes} 分钟',
      'plain.ttl.seconds': '还有 {seconds} 秒',
      'plain.copy': '复制',
      'plain.copied': '已复制',
      'plain.copyCommand': '复制命令',
      'plain.learnMore': '了解这些词',
      'plain.hintPrefix': '你可以这样做：',
      'plain.close': '知道了',
      'plain.view.beginner': '新手模式',
      'plain.view.expert': '专家模式',
      'plain.view.aria': '显示模式',
      'plain.help': '帮助',
      'plain.help.title': '帮助与名词解释',
      'plain.help.concepts': '基础概念',
      'plain.help.redis': 'Redis',
      'plain.help.postgres': 'PostgreSQL',
      'plain.help.faq': '常见问题',
      'plain.help.docker': 'Docker',
      'plain.help.container': '容器',
      'plain.help.image': '镜像',
      'plain.help.volume': '数据卷',
      'plain.help.network': '网络',
      'plain.help.port': '端口',
      'plain.help.redis.what': 'Redis',
      'plain.help.redis.key': '键',
      'plain.help.redis.ttl': 'TTL（有效期）',
      'plain.help.pg.database': '数据库',
      'plain.help.pg.table': '表',
      'plain.help.pg.column': '列',
      'plain.help.pg.sql': 'SQL',
      'plain.help.faq.stop': '停止容器会怎样？',
      'plain.help.faq.removeVolume': '删除数据卷会怎样？',
      'plain.help.faq.multi': '有多个同名服务时怎么选？',
      'plain.help.faq.unreachable': '面板连不上怎么办？',
      'plain.help.docker.desc': '管理容器、镜像、数据卷和网络的工具。',
      'plain.help.container.desc': '正在运行的一个程序盒子，可以启动、停止和删除。',
      'plain.help.image.desc': '程序的安装包，创建容器时使用它。',
      'plain.help.volume.desc': '专门用来存放数据的文件夹，删除前要想清楚。',
      'plain.help.network.desc': '让不同程序互相连线的通道。',
      'plain.help.port.desc': '程序对外的入口号码，通过它访问服务。',
      'plain.help.redis.what.desc': '把常用数据放在内存里的缓存，读取很快。',
      'plain.help.redis.key.desc': '缓存里的一条数据，用名字（键）找到它。',
      'plain.help.redis.ttl.desc': '数据多久后自动清除；永不过期就是一直保留。',
      'plain.help.pg.database.desc': '存放一组相关表的空间，比如业务库。',
      'plain.help.pg.table.desc': '像电子表格一样按行和列保存数据。',
      'plain.help.pg.column.desc': '表格里的一列，表示一种属性，比如邮箱。',
      'plain.help.pg.sql.desc': '向数据库提问的语言，比如“给我看前 10 行”。',
      'plain.help.faq.stop.desc': '依赖它的功能会暂时不可用，重新启动就能恢复。',
      'plain.help.faq.removeVolume.desc': '数据卷里的数据会永久丢失，无法找回。',
      'plain.help.faq.multi.desc': '选择你要使用的那一个，面板不会替你乱猜。',
      'plain.help.faq.unreachable.desc': '先确认服务在运行，再点刷新或到设置里检查连接。',
      'overview.title': '概览',
      'overview.subtitle': '先看这里，了解本机服务的整体状态',
      'overview.loading': '正在检查本机服务…',
      'overview.status.title': '整体状态',
      'overview.status.good': '整体正常，没有需要你处理的事情。',
      'overview.status.attention': '整体基本正常，但有 {count} 件事情需要你留意。',
      'overview.status.danger': '有 {count} 件事情需要你处理。',
      'overview.status.counts.good': '{count} 项正常',
      'overview.status.counts.info': '{count} 项提示',
      'overview.status.counts.warn': '{count} 项留意',
      'overview.status.counts.danger': '{count} 项问题',
      'overview.status.updated': '更新于 {time}',
      'overview.service.docker': 'Docker',
      'overview.service.redis': 'Redis',
      'overview.service.postgres': 'PostgreSQL',
      'overview.service.docker.what': '容器管家：负责运行各种软件的盒子',
      'overview.service.redis.what': '高速缓存：让应用变快的临时数据',
      'overview.service.postgres.what': '数据库：长期保存业务数据',
      'overview.service.status.ok': '正常',
      'overview.service.status.down': '连不上',
      'overview.service.status.stopped': '没在运行',
      'overview.service.status.ambiguous': '有多个实例',
      'overview.service.status.none': '没发现',
      'overview.service.status.unknown': '未知',
      'overview.service.stat.containers': '{running} 个程序在运行（共 {total} 个）',
      'overview.service.stat.redis.keys': '{count} 条缓存数据',
      'overview.service.stat.redis.memory': '缓存占用 {memory}',
      'overview.service.stat.redis.clients': '{count} 个程序正在使用',
      'overview.service.stat.pg.databases': '{count} 个数据库',
      'overview.service.stat.pg.sessions': '{count} 个连接',
      'overview.service.stat.pg.database': '当前数据库 {name}',
      'overview.service.stat.docker.images': '{count} 个安装包（镜像）',
      'overview.service.stat.docker.volumes': '{count} 个数据文件夹',
      'overview.service.stat.unknown': '暂时没有更多信息',
      'overview.service.action.refresh': '刷新状态',
      'overview.service.action.settings': '检查连接设置',
      'overview.service.action.choose': '选择要用的实例',
      'overview.service.action.copyStart': '复制启动命令',
      'overview.service.action.openDocker': '打开 Docker',
      'overview.service.action.openRedis': '打开 Redis',
      'overview.service.action.openPostgres': '打开 PostgreSQL',
      'overview.insights.title': '需要你注意',
      'overview.insights.empty': '没有需要你注意的事情。',
      'overview.quick.title': '快速开始',
      'overview.quick.hint': '第一次使用？按这三步来。',
      'overview.quick.step1': '确认 Docker 正在运行',
      'overview.quick.step1.desc': 'Docker 是运行其他程序的底座。',
      'overview.quick.step1.done': '已就绪',
      'overview.quick.step1.todo': '未就绪',
      'overview.quick.step2': '启动 Redis 或 PostgreSQL（可选）',
      'overview.quick.step2.desc': '没有容器时可以复制下面的命令，在终端里粘贴执行。',
      'overview.quick.step2.done': '已有 {count} 个运行中的服务容器',
      'overview.quick.step2.todo': '还没有运行中的 Redis / PostgreSQL 容器',
      'overview.quick.step3': '回到这里查看状态',
      'overview.quick.step3.desc': '看到“整体正常”就可以开始用了。',
      'overview.quick.copyRedis': '复制 Redis 启动命令',
      'overview.quick.copyPostgres': '复制 PostgreSQL 启动命令',
      'overview.insight.action.docker': '去 Docker 看看',
      'overview.insight.action.relations': '去关联看看',
      'overview.insight.action.redis': '去 Redis 看看',
      'overview.insight.action.postgres': '去 PostgreSQL 看看',
      'overview.insight.action.settings': '打开设置',
      'overview.insight.action.choose': '选择实例',
      'overview.insight.action.refresh': '刷新',
      'insight.docker_unavailable': 'Docker 没有运行或找不到，容器类功能暂时不可用。',
      'insight.unknown': '有一条新的提示（{code}）。',
      'insight.no_containers': '还没有任何容器，可以在快速开始里复制命令启动一个。',
      'insight.stopped_containers': '有 {count} 个容器已停止：{names}。',
      'insight.restarting_containers': '有 {count} 个容器正在重启：{names}。',
      'insight.unused_volumes': '有 {count} 个数据卷没人使用：{names}。',
      'insight.dangling_images': '有 {count} 个悬空镜像占用空间。',
      'insight.disk_reclaimable': '可以回收约 {human} 的磁盘空间。',
      'insight.redis_ok': 'Redis 运行正常（版本 {version}）。',
      'insight.redis_ambiguous': '有 {count} 个 Redis 容器同时在运行：{names}，请选择一个。',
      'insight.redis_no_container': '没有发现 Redis 容器，可以复制快速开始里的命令启动一个。',
      'insight.redis_no_running': 'Redis 容器没有在运行：{names}。',
      'insight.redis_unreachable': '连不上 Redis（{container}）：{message}',
      'insight.postgres_ok': 'PostgreSQL 运行正常（版本 {version}）。',
      'insight.postgres_ambiguous': '有 {count} 个 PostgreSQL 容器同时在运行：{names}，请选择一个。',
      'insight.postgres_no_container': '没有发现 PostgreSQL 容器，可以复制快速开始里的命令启动一个。',
      'insight.postgres_no_running': 'PostgreSQL 容器没有在运行：{names}。',
      'insight.postgres_unreachable': '连不上 PostgreSQL（{container}）：{message}',
      'intent.docker_unavailable': '打开设置',
      'intent.no_containers': '去 Docker 看看',
      'intent.stopped_containers': '去 Docker 看看',
      'intent.restarting_containers': '去 Docker 看看',
      'intent.unused_volumes': '去关联看看',
      'intent.dangling_images': '去 Docker 看看',
      'intent.disk_reclaimable': '去 Docker 看看',
      'intent.redis_ok': '去 Redis 看看',
      'intent.redis_ambiguous': '选择实例',
      'intent.redis_no_container': '去 Redis 看看',
      'intent.redis_no_running': '去 Redis 看看',
      'intent.redis_unreachable': '去 Redis 看看',
      'intent.postgres_ok': '去 PostgreSQL 看看',
      'intent.postgres_ambiguous': '选择实例',
      'intent.postgres_no_container': '去 PostgreSQL 看看',
      'intent.postgres_no_running': '去 PostgreSQL 看看',
      'intent.postgres_unreachable': '去 PostgreSQL 看看',
      'confirm.impact.stop.website': '停止后，网站将无法访问，直到重新启动它。',
      'confirm.impact.stop.database': '依赖它的程序将无法保存或读取数据。',
      'confirm.impact.stop.cache': '程序会变慢，但已保存的数据不会丢失。',
      'confirm.impact.stop.queue': '待处理的任务会推迟，直到它恢复。',
      'confirm.impact.stop.other': '依赖它的功能会暂时不可用。',
      'confirm.impact.restart.website': '重启期间网站会短暂无法访问。',
      'confirm.impact.restart.other': '重启期间服务会短暂中断。',
      'confirm.impact.pause.website': '暂停后网站不再响应，直到你恢复它。',
      'confirm.impact.pause.other': '暂停后服务不再响应，直到你恢复它。',
      'confirm.impact.container.remove': '容器会被删除；数据卷里的数据不会跟着删除。',
      'confirm.impact.image.remove': '删除后需要重新下载才能再次使用这个安装包。',
      'confirm.impact.volume.remove': '里面的数据会永久丢失，无法找回。',
      'confirm.impact.network.remove': '连在这个网络上的程序会失去互通。',
      'confirm.impact.redis.delete': '这条缓存数据会被永久删除。',
      'confirm.impact.redis.rename': '用旧名字的程序会找不到它。',
      'confirm.impact.redis.expire': '到期后这条缓存数据会被自动删除。',
      'plain.error.unreachable': '面板暂时连不上本机服务。',
      'plain.error.hint.unreachable': '确认服务正在运行，然后点“重试”；一直不行就去设置里检查连接。',
      'plain.error.dockerUnavailable': 'Docker 没有运行或没有安装。',
      'plain.error.hint.dockerUnavailable': '打开 Docker 应用，等它启动后点“重试”。',
      'plain.error.auth': '账号或密码不对，连不上服务。',
      'plain.error.hint.auth': '打开设置，检查用户名和密码后重试。',
      'plain.error.timeout': '服务响应太慢，这次操作超时了。',
      'plain.error.hint.timeout': '稍后重试；如果一直超时，检查服务是否繁忙。',
      'plain.error.noContainer': '没有找到对应的容器。',
      'plain.error.hint.noContainer': '在 Docker 页面启动或创建一个容器，或到设置里切换为手动地址。',
      'plain.error.ambiguous': '有多个同类服务在运行，需要先选一个。',
      'plain.error.hint.ambiguous': '在这个页面顶部的实例栏里选择一个。',
      'plain.error.noPort': '容器没有把访问入口开放给本机。',
      'plain.error.hint.noPort': '重新创建容器时加上端口映射，例如 -p 6379:6379。',
      'plain.error.invalid': '输入的内容不符合要求。',
      'plain.error.hint.invalid': '检查填写的名称、数字等格式后重试。',
      'plain.error.generic': '操作没有成功。',
      'plain.error.hint.generic': '稍后重试；如果一直失败，可以打开帮助看看常见问题。',
      'docker.group.ungrouped': '未分组',
      'docker.group.title': '项目：{project}',
      'docker.group.count': '{count} 个容器',
      'redis.wizard.open': '写入数据',
      'redis.wizard.title': '写入数据',
      'redis.wizard.step.type': '选择要写入的数据类型',
      'redis.wizard.step.fields': '填写内容',
      'redis.wizard.type.string': '文本',
      'redis.wizard.type.hash': '哈希（字段 → 值）',
      'redis.wizard.type.list': '列表（按顺序追加）',
      'redis.wizard.type.set': '集合（不允许重复）',
      'redis.wizard.key': '数据名（键）',
      'redis.wizard.field': '字段名',
      'redis.wizard.value': '内容',
      'redis.wizard.member': '成员',
      'redis.wizard.ttl': '多久后自动清除（秒，可留空）',
      'redis.wizard.save': '保存',
      'redis.wizard.saving': '正在保存…',
      'redis.wizard.cancel': '取消',
      'redis.wizard.notice': '已保存到 {key}。',
      'redis.wizard.error': '保存失败，请检查内容后重试。',
      'redis.wizard.keyRequired': '请先填写数据名。',
      'redis.wizard.fieldRequired': '请填写字段名和内容。',
      'redis.wizard.memberRequired': '请填写成员内容。',
      'pg.template.title': '快捷查询',
      'pg.template.preview': '查看前 10 行',
      'pg.template.count': '统计行数',
      'pg.template.columns': '查看有哪些列',
      'pg.template.hint': '先选一张表，再点模板。',
      'pg.browse.beginnerHint': '先选数据库，再选表，就能看到数据。',
      'relations.legend.beginner': '圆角方框是程序，左边是安装包，右边是数据文件夹，线表示它们的关系。',
      'dockerfile.banner': 'Dockerfile 是制作镜像的“菜谱”：它写明从哪个基础镜像开始、复制哪些文件、怎么启动程序。',
      'dockerfile.count': '共 {count} 个 Dockerfile',
      'dockerfile.roots': '扫描位置：{roots}',
      'dockerfile.rootsNone': '没有可扫描的工作区目录',
      'dockerfile.scan': '检查了 {files} 个文件',
      'dockerfile.truncated': '文件太多，本次扫描提前结束。',
      'dockerfile.refresh': '重新扫描',
      'dockerfile.loading': '正在查找 Dockerfile…',
      'dockerfile.empty.title': '没有找到 Dockerfile',
      'dockerfile.empty.hint': 'Dockerfile 是制作镜像的菜谱。面板在这些位置找过：{roots}',
      'dockerfile.empty.sampleTitle': '一个最小的例子',
      'dockerfile.empty.sampleHint': '把上面的内容保存为 Dockerfile，放在项目目录里，再点“重新扫描”。',
      'dockerfile.empty.settingsHint': '想扫描其他目录？到设置里的“构建文件”添加扫描位置。',
      'dockerfile.card.base': '基础镜像：{image}',
      'dockerfile.card.baseRole': '基础镜像：{image}（{role}）',
      'dockerfile.card.noneBase': '没有写基础镜像',
      'dockerfile.card.multiStage': '多阶段构建（{count} 个阶段）',
      'dockerfile.card.instructions': '{count} 条指令',
      'dockerfile.card.noPorts': '没有开放端口',
      'dockerfile.card.command': '启动命令',
      'dockerfile.card.healthcheck': '健康检查',
      'dockerfile.card.env': '{count} 个环境变量',
      'dockerfile.card.volumes': '{count} 个数据目录',
      'dockerfile.card.view': '查看内容',
      'dockerfile.card.copyBuild': '复制构建命令',
      'dockerfile.card.copyPath': '复制路径',
      'dockerfile.card.path': '位置：{path}',
      'dockerfile.port.label': '端口 {port}：{meaning}',
      'dockerfile.port.website': '网站访问入口',
      'dockerfile.port.secure': '加密网站入口',
      'dockerfile.port.database': '数据库入口',
      'dockerfile.port.cache': '缓存入口',
      'dockerfile.port.queue': '消息队列入口',
      'dockerfile.port.storage': '文件存储入口',
      'dockerfile.port.application': '服务入口',
      'dockerfile.view.title': 'Dockerfile 内容',
      'dockerfile.view.loading': '正在读取内容…',
      'dockerfile.view.annotated': '逐条解释',
      'dockerfile.view.raw': '原始内容（带行号）',
      'dockerfile.view.line': '第 {line} 行',
      'dockerfile.view.truncated': '文件较大，只显示了前面的内容。',
      'dockerfile.view.summary': '解析摘要',
      'dockerfile.view.stages': '构建阶段',
      'dockerfile.view.stageName': '阶段 {index}：{base}',
      'dockerfile.view.baseImages': '用到的基础镜像',
      'dockerfile.view.warnings': '需要留意',
      'dockerfile.view.warning': '第 {line} 行：{message}',
      'dockerfile.view.noWarnings': '没有发现问题。',
      'dockerfile.view.close': '关闭',
      'dockerfile.explain.from': '基础镜像：程序从哪来',
      'dockerfile.explain.run': '构建时执行的命令',
      'dockerfile.explain.copy': '复制文件到镜像里',
      'dockerfile.explain.add': '添加文件（也可以解压）',
      'dockerfile.explain.cmd': '启动时执行的命令',
      'dockerfile.explain.entrypoint': '入口程序',
      'dockerfile.explain.expose': '开放端口',
      'dockerfile.explain.env': '环境变量',
      'dockerfile.explain.arg': '构建参数',
      'dockerfile.explain.workdir': '工作目录',
      'dockerfile.explain.user': '运行身份',
      'dockerfile.explain.volume': '数据存放位置',
      'dockerfile.explain.healthcheck': '健康检查',
      'dockerfile.explain.label': '说明标签',
      'dockerfile.explain.other': '其他设置',
      'settings.dockerfiles.title': '构建文件',
      'settings.dockerfiles.roots': '额外扫描位置',
      'settings.dockerfiles.rootsHint': '每行一个绝对路径。面板会自动扫描工作区，这里可以补充其他目录（最多 20 个）。',
      'settings.dockerfiles.maxDepth': '扫描深度',
      'settings.dockerfiles.maxDepthHint': '1~12 层，默认 6。',
      'overview.service.stat.docker.dockerfiles': '{count} 个 Dockerfile',
      'insight.dockerfiles_found': '在项目里找到 {count} 个 Dockerfile：{names}。',
      'intent.dockerfiles_found': '去构建文件看看',
      'confirm.cancelHint': '按 Esc 取消',
    }
    const en = {
      'panel': 'Data',
      'title': 'Data panel',
      'subtitle': 'Docker, Redis and PostgreSQL in one place',
      'refresh': 'Refresh',
      'refreshBusy': 'Refreshing…',
      'loading': 'Loading…',
      'retry': 'Retry',
      'close': 'Close',
      'tab.overview': 'Overview',
      'tab.docker': 'Docker',
      'tab.redis': 'Redis',
      'tab.postgres': 'PostgreSQL',
      'tabs.aria': 'Service tabs',
      'chip.docker': 'Docker',
      'chip.redis': 'Redis',
      'chip.postgres': 'PostgreSQL',
      'chip.status.ok': 'connected',
      'chip.status.down': 'unreachable',
      'chip.status.checking': 'checking',
      'chip.status.unknown': 'not checked',
      'chip.aria': '{service}: {status}',
      'chip.ariaTarget': '{service} · {target}: {status}',
      'settings.open': 'Connection settings',
      'settings.close': 'Back to the panel',
      'settings.title': 'Connection settings',
      'settings.subtitle': 'Connections live on the Host half; passwords are never sent back to the browser.',
      'settings.docker.title': 'Docker',
      'settings.docker.binary': 'Binary',
      'settings.docker.binaryHint': 'Uses docker from PATH by default; an absolute path works too.',
      'settings.redis.title': 'Redis',
      'settings.redis.host': 'Host',
      'settings.redis.port': 'Port',
      'settings.redis.username': 'Username',
      'settings.redis.password': 'Password',
      'settings.redis.passwordStored': 'A password is stored — leave empty to keep it',
      'settings.redis.passwordEmpty': 'No password stored',
      'settings.redis.db': 'Database',
      'settings.redis.tls': 'Use TLS',
      'settings.postgres.title': 'PostgreSQL',
      'settings.postgres.host': 'Host',
      'settings.postgres.port': 'Port',
      'settings.postgres.user': 'User',
      'settings.postgres.password': 'Password',
      'settings.postgres.passwordStored': 'A password is stored — leave empty to keep it',
      'settings.postgres.passwordEmpty': 'No password stored',
      'settings.postgres.database': 'Database',
      'settings.postgres.ssl': 'SSL mode',
      'settings.postgres.ssl.disable': 'disable',
      'settings.postgres.ssl.prefer': 'prefer',
      'settings.postgres.ssl.require': 'require',
      'settings.mode': 'Connection mode',
      'settings.mode.docker': 'Docker container',
      'settings.mode.manual': 'Manual address',
      'settings.target.label': 'Container',
      'settings.target.auto': 'Auto-select (first running container)',
      'settings.target.stopped': 'not running',
      'settings.target.noPortShort': 'no port',
      'settings.target.noPort': 'The container does not publish its port to the host.',
      'settings.target.noContainer': 'No {service} container was found.',
      'settings.target.notFound': 'Container “{container}” was not found in Docker.',
      'settings.target.dockerUnavailable': 'Docker is unavailable, so the container cannot be resolved.',
      'settings.target.error': 'Could not resolve the target',
      'settings.target.resolved': 'Resolved: {endpoint}',
      'settings.target.credentials': 'Credentials: {source}',
      'settings.target.credentials.settings': 'from settings',
      'settings.target.credentials.container-env': 'container environment',
      'settings.target.credentials.none': 'none',
      'settings.target.candidates': '{count} candidate containers found',
      'settings.target.noCandidates': 'No matching container found; make sure it runs from a Redis/PostgreSQL image.',
      'settings.target.containerHint': 'Leave it empty to auto-select the first running container.',
      'settings.target.overrideHint': 'In Docker mode these credentials act as overrides; leave them empty to use the container environment.',
      'settings.redis.passwordDockerHint': 'Empty uses the container environment credentials (REDISCLI_AUTH / REDIS_PASSWORD).',
      'settings.postgres.passwordDockerHint': 'Empty uses the container environment credential (POSTGRES_PASSWORD).',
      'settings.clearPassword': 'Clear the stored password',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.saved': 'Connection settings saved',
      'settings.saveHint': 'An empty password keeps the stored one.',
      'settings.test': 'Test connection',
      'settings.testing': 'Testing…',
      'settings.testOk': 'Connected: {detail}',
      'settings.testFailed': 'Connection failed: {message}',
      'docker.tab.containers': 'Containers',
      'docker.tab.images': 'Images',
      'docker.tab.volumes': 'Volumes',
      'docker.tab.networks': 'Networks',
      'docker.tab.dockerfiles': 'Dockerfiles',
      'docker.subtabs.aria': 'Docker resources',
      'docker.disk.title': 'Disk usage',
      'docker.disk.images': 'Images',
      'docker.disk.containers': 'Containers',
      'docker.disk.volumes': 'Volumes',
      'docker.disk.buildCache': 'Build cache',
      'docker.disk.count': '{count}',
      'docker.disk.reclaimable': '{size} reclaimable',
      'docker.disk.loading': 'Loading disk usage…',
      'docker.disk.none': '—',
      'docker.images.count': '{count} images',
      'docker.images.loading': 'Loading images…',
      'docker.images.empty.title': 'No images',
      'docker.images.empty.hint': 'This host has no Docker images yet.',
      'docker.images.untagged': '<none>',
      'docker.images.containers': '{count} containers',
      'docker.images.remove': 'Remove image',
      'docker.volumes.count': '{count} volumes',
      'docker.volumes.loading': 'Loading volumes…',
      'docker.volumes.empty.title': 'No volumes',
      'docker.volumes.empty.hint': 'This host has no Docker volumes yet.',
      'docker.volumes.remove': 'Remove volume',
      'docker.networks.count': '{count} networks',
      'docker.networks.loading': 'Loading networks…',
      'docker.networks.empty.title': 'No networks',
      'docker.networks.empty.hint': 'This host has no Docker networks to show.',
      'docker.networks.remove': 'Remove network',
      'docker.networks.internal': 'internal',
      'docker.removing': 'Removing…',
      'docker.filter': 'Filter containers',
      'docker.filterResource': 'Filter resources',
      'docker.resourceCountFiltered': '{shown}/{total}',
      'docker.count': '{count} containers',
      'docker.countFiltered': '{shown} of {total} containers',
      'docker.autoRefresh': 'Refreshes every 5s',
      'docker.loading': 'Loading containers…',
      'docker.empty.title': 'No containers',
      'docker.empty.hint': 'This host has no Docker containers yet.',
      'docker.filterEmpty.title': 'No matching containers',
      'docker.filterEmpty.hint': 'Try a different filter.',
      'docker.unavailable.title': 'Docker is not available',
      'docker.unavailable.hint': 'Make sure Docker is installed and on PATH, or set the binary path in the connection settings.',
      'docker.unavailable.action': 'Open settings',
      'docker.state.running': 'running',
      'docker.state.exited': 'exited',
      'docker.state.paused': 'paused',
      'docker.state.created': 'created',
      'docker.state.restarting': 'restarting',
      'docker.state.dead': 'dead',
      'docker.state.other': 'other',
      'docker.action.start': 'Start',
      'docker.action.stop': 'Stop',
      'docker.action.restart': 'Restart',
      'docker.action.pause': 'Pause',
      'docker.action.unpause': 'Unpause',
      'docker.action.remove': 'Remove container',
      'docker.action.logs': 'Logs',
      'docker.action.details': 'Details',
      'docker.action.hideDetails': 'Hide details',
      'docker.busy': 'Working…',
      'docker.portsNone': 'No published ports',
      'docker.logs.title': 'Container logs',
      'docker.logs.tail': 'Lines',
      'docker.logs.refresh': 'Refresh logs',
      'docker.logs.loading': 'Loading logs…',
      'docker.logs.empty': 'No log output.',
      'docker.detail.loading': 'Loading container details…',
      'docker.detail.overview': 'Overview',
      'docker.detail.env': 'Environment',
      'docker.detail.mounts': 'Mounts',
      'docker.detail.networks': 'Networks',
      'docker.detail.empty': 'None',
      'docker.detail.modeRw': 'read-write',
      'docker.detail.modeRo': 'read-only',
      'docker.detail.health': 'Health',
      'docker.detail.restartCount': 'Restarts',
      'docker.detail.exitCode': 'Exit code',
      'docker.detail.startedAt': 'Started',
      'docker.detail.finishedAt': 'Finished',
      'docker.detail.platform': 'Platform',
      'docker.detail.entrypoint': 'Entrypoint',
      'docker.detail.cmd': 'Command',
      'docker.detail.logPath': 'Log path',
      'docker.detail.createdAt': 'Created',
      'confirm.containerStop.title': 'Stop container “{name}”?',
      'confirm.containerStop.body': 'The container processes receive a stop signal; you can start it again afterwards.',
      'confirm.containerStop.action': 'Stop container',
      'confirm.containerRestart.title': 'Restart container “{name}”?',
      'confirm.containerRestart.body': 'The container stops and starts again right away, so its service is briefly unavailable.',
      'confirm.containerRestart.action': 'Restart container',
      'confirm.containerPause.title': 'Pause container “{name}”?',
      'confirm.containerPause.body': 'The container processes are frozen until you unpause it.',
      'confirm.containerPause.action': 'Pause container',
      'confirm.containerRemove.title': 'Remove container “{name}”?',
      'confirm.containerRemove.body': 'The container will be removed. This cannot be undone.',
      'confirm.containerRemove.action': 'Remove container',
      'confirm.imageRemove.title': 'Remove image “{name}”?',
      'confirm.imageRemove.body': 'The image will be removed; containers still using it will block the removal.',
      'confirm.imageRemove.action': 'Remove image',
      'confirm.volumeRemove.title': 'Remove volume “{name}”?',
      'confirm.volumeRemove.body': 'The volume and the data in it will be permanently deleted. This cannot be undone.',
      'confirm.volumeRemove.action': 'Remove volume',
      'confirm.networkRemove.title': 'Remove network “{name}”?',
      'confirm.networkRemove.body': 'The network will be removed; containers still attached to it will block the removal.',
      'confirm.networkRemove.action': 'Remove network',
      'redis.summary.version': 'Version',
      'redis.summary.uptime': 'Uptime',
      'redis.summary.clients': 'Clients',
      'redis.summary.memory': 'Memory',
      'redis.summary.keys': 'Keys',
      'redis.summary.ops': 'Ops/sec',
      'redis.summary.hitRate': 'Hit rate',
      'redis.summary.none': '—',
      'redis.percent': '{percent}%',
      'redis.uptime.days': '{days}d {hours}h',
      'redis.uptime.hours': '{hours}h {minutes}m',
      'redis.uptime.minutes': '{minutes}m {seconds}s',
      'redis.uptime.seconds': '{seconds}s',
      'redis.browser.title': 'Keys',
      'redis.browser.pattern': 'Pattern',
      'redis.browser.patternPlaceholder': 'e.g. user:*',
      'redis.browser.type': 'Type',
      'redis.browser.typeAny': 'Any type',
      'redis.browser.scan': 'Scan',
      'redis.browser.loading': 'Scanning…',
      'redis.browser.loadMore': 'Load more',
      'redis.browser.done': 'All matching keys scanned.',
      'redis.browser.scanned': '{count} keys listed',
      'redis.browser.empty.title': 'No matching keys',
      'redis.browser.empty.hint': 'Adjust the pattern or type and scan again.',
      'redis.browser.selectHint': 'Select a key to inspect its value.',
      'redis.key.title': 'Key value',
      'redis.key.loading': 'Loading key…',
      'redis.key.type': 'Type',
      'redis.key.ttl': 'TTL',
      'redis.key.ttl.persistent': 'No expiry',
      'redis.key.ttl.missing': 'Key does not exist',
      'redis.key.ttl.seconds': '{seconds}s',
      'redis.key.null': 'Empty value',
      'redis.key.truncated': 'The value is long; showing the first {limit} characters.',
      'redis.key.items': '{count} items',
      'redis.key.score': 'Score',
      'redis.key.delete': 'Delete key',
      'redis.delete.title': 'Delete this key?',
      'redis.delete.body': 'Key “{key}” will be permanently deleted. This cannot be undone.',
      'redis.delete.action': 'Delete key',
      'redis.set.title': 'Set a string',
      'redis.set.key': 'Key',
      'redis.set.keyPlaceholder': 'e.g. cache:token',
      'redis.set.value': 'Value',
      'redis.set.ttl': 'TTL (seconds)',
      'redis.set.ttlPlaceholder': 'Empty means no expiry',
      'redis.set.submit': 'Set',
      'redis.set.saving': 'Setting…',
      'redis.set.success': 'Saved “{key}”.',
      'redis.set.successTtl': 'Saved “{key}”; it expires in {seconds}s.',
      'pg.status': 'PostgreSQL {version} · {user}@{database}',
      'pg.database': 'Database',
      'pg.tables': 'Tables',
      'pg.tables.count': '{count} objects',
      'pg.tables.filter': 'Filter tables',
      'pg.tables.loading': 'Loading tables…',
      'pg.tables.empty.title': 'No tables',
      'pg.tables.empty.hint': 'This database has no tables or views to show.',
      'pg.tables.emptyFilter.title': 'No matching tables',
      'pg.tables.emptyFilter.hint': 'Try a different filter.',
      'pg.tables.rows': '{count} rows',
      'pg.kind.table': 'table',
      'pg.kind.view': 'view',
      'pg.kind.materializedView': 'materialized view',
      'pg.kind.foreignTable': 'foreign table',
      'pg.yes': 'yes',
      'pg.no': 'no',
      'pg.columns.title': 'Columns',
      'pg.columns.name': 'Name',
      'pg.columns.type': 'Type',
      'pg.columns.nullable': 'Nullable',
      'pg.columns.default': 'Default',
      'pg.columns.empty': 'No table selected.',
      'pg.columns.loading': 'Loading columns…',
      'pg.preview': 'Preview 100 rows',
      'pg.preview.loading': 'Loading preview…',
      'pg.preview.title': 'Preview',
      'pg.query.title': 'SQL query',
      'pg.query.placeholder': 'SELECT * FROM ...',
      'pg.query.run': 'Run',
      'pg.query.running': 'Running…',
      'pg.query.hint': 'Press Ctrl+Enter to run',
      'pg.query.empty': 'Results appear here after you run a query.',
      'pg.query.failed': 'Query failed',
      'pg.query.sqlState': 'SQLSTATE {state}',
      'pg.query.detail': 'Detail: {detail}',
      'pg.query.hintField': 'Hint: {hint}',
      'pg.query.position': 'Position: {position}',
      'pg.query.duration': '{ms} ms',
      'pg.query.truncated': 'The result was truncated to the first {rows} rows.',
      'pg.query.rows': '{count} rows',
      'pg.query.affected': '{count} rows affected',
      'pg.null': 'NULL',
      'error.unreachable': 'Cannot reach the Host half: {message}',
      'error.refused': 'The request failed: {message}',
      'error.dockerUnavailable': 'Docker is unavailable: {message}',
      'error.dockerTimeout': 'The Docker operation timed out: {message}',
      'error.redisUnreachable': 'Cannot connect to Redis: {message}',
      'error.redisAuth': 'Redis authentication failed: {message}',
      'error.redisTimeout': 'The Redis operation timed out: {message}',
      'error.pgUnreachable': 'Cannot connect to PostgreSQL: {message}',
      'error.pgAuth': 'PostgreSQL authentication failed: {message}',
      'error.pgTimeout': 'The PostgreSQL operation timed out: {message}',
      'error.pgSsl': 'The PostgreSQL SSL handshake failed: {message}',
      'error.invalidPayload': 'Invalid request: {message}',
      'error.dockerInvalidTarget': 'Invalid Docker resource name: {message}',
      'confirm.cancel': 'Cancel',
      'tab.relations': 'Relations',
      'relations.title': 'Relations',
      'relations.subtitle': 'How images, containers, volumes and networks connect',
      'relations.loading': 'Loading relations…',
      'relations.empty.title': 'No resources to show',
      'relations.empty.hint': 'This host has no containers, images or volumes yet.',
      'relations.summary.containers': 'Containers',
      'relations.summary.images': 'Images',
      'relations.summary.volumes': 'Volumes',
      'relations.summary.networks': 'Networks',
      'relations.summary.danglingImages': 'Dangling images',
      'relations.summary.unusedVolumes': 'Unused volumes',
      'relations.summary.running': '{running}/{total} running',
      'relations.graph.title': 'Relation graph',
      'relations.graph.legend.images': 'Images',
      'relations.graph.legend.containers': 'Containers',
      'relations.graph.legend.volumes': 'Volumes',
      'relations.graph.empty': 'Nothing to draw.',
      'relations.graph.networks': 'Networks',
      'relations.table.title': 'Container relations',
      'relations.table.container': 'Container',
      'relations.table.state': 'State',
      'relations.table.image': 'Image',
      'relations.table.volumes': 'Volumes',
      'relations.table.networks': 'Networks',
      'relations.table.ports': 'Ports',
      'relations.table.empty': 'No containers.',
      'relations.reverse.title': 'Reverse lookup',
      'relations.reverse.kind': 'Resource kind',
      'relations.reverse.resource': 'Resource',
      'relations.reverse.all': 'All resources',
      'relations.reverse.images': 'Images',
      'relations.reverse.volumes': 'Volumes',
      'relations.reverse.networks': 'Networks',
      'relations.reverse.count': '{count} containers',
      'relations.reverse.empty': 'No container uses this resource.',
      'chip.instances': '{count} running',
      'chip.noRunning': 'none running',
      'instance.bar': 'Instances',
      'instance.auto': 'Auto',
      'instance.choose': 'Choose an instance',
      'instance.saved': 'Instance switched',
      'instance.runningCount': '{count} running',
      'error.ambiguousContainer': '{count} containers are running; choose one first.',
      'error.noRunningContainer': 'No running container; start one or switch to a manual address.',
      'error.noContainer': 'No matching container was found.',
      'error.containerNotFound': 'The selected container was not found.',
      'error.noPublishedPort': 'The container does not publish a port to the host.',
      'settings.target.runningCount': '{count} running',
      'settings.target.ambiguous': '{count} containers are running; pick one.',
      'settings.target.noRunning': 'No running container; start one first.',
      'docker.stateFilter.aria': 'State filter',
      'docker.stateFilter.all': 'All',
      'docker.stateFilter.running': 'Running',
      'docker.stateFilter.stopped': 'Stopped',
      'docker.stateFilter.paused': 'Paused',
      'docker.stats.cpu': 'CPU',
      'docker.stats.memory': 'Memory',
      'docker.stats.none': '—',
      'docker.inspect.title': 'Details',
      'docker.inspect.loading': 'Loading details…',
      'docker.inspect.close': 'Close',
      'docker.inspect.containers': 'Used by containers',
      'docker.inspect.exposedPorts': 'Exposed ports',
      'docker.inspect.architecture': 'Architecture',
      'docker.inspect.os': 'OS',
      'docker.inspect.labels': 'Labels',
      'docker.inspect.env': 'Environment',
      'docker.inspect.mountpoint': 'Mountpoint',
      'docker.inspect.options': 'Options',
      'docker.inspect.subnets': 'Subnets',
      'docker.inspect.gateway': 'Gateway',
      'docker.inspect.attached': 'Attached containers',
      'docker.inspect.ipv4': 'IPv4',
      'docker.inspect.ipv6': 'IPv6',
      'docker.inspect.anonymous': 'anonymous volume',
      'docker.images.inspect': 'Image details',
      'docker.volumes.inspect': 'Volume details',
      'docker.networks.inspect': 'Network details',
      'redis.server.title': 'Server',
      'redis.server.dbsize': 'Keys in DB',
      'redis.server.clients': 'Client connections',
      'redis.server.clientsCount': '{count} connections',
      'redis.server.loading': 'Loading server info…',
      'redis.clients.id': 'ID',
      'redis.clients.addr': 'Address',
      'redis.clients.name': 'Name',
      'redis.clients.age': 'Age',
      'redis.clients.idle': 'Idle',
      'redis.clients.db': 'DB',
      'redis.clients.command': 'Command',
      'redis.clients.user': 'User',
      'redis.clients.empty': 'No client connections.',
      'redis.key.memory': 'Memory',
      'redis.key.memory.loading': 'Loading memory…',
      'redis.key.rename': 'Rename',
      'redis.key.renamePlaceholder': 'New key name',
      'redis.key.renameAction': 'Rename',
      'redis.key.expire': 'Set expiry',
      'redis.key.expirePlaceholder': 'Seconds',
      'redis.key.expireAction': 'Set',
      'redis.key.persist': 'Persist',
      'redis.key.persistAction': 'Remove expiry',
      'redis.key.actions': 'Key actions',
      'redis.key.notice.renamed': 'Renamed to “{key}”.',
      'redis.key.notice.expired': 'Expires in {seconds}s.',
      'redis.key.notice.persisted': 'Expiry removed.',
      'redis.editor.hash.title': 'Set a hash field',
      'redis.editor.hash.field': 'Field',
      'redis.editor.hash.value': 'Value',
      'redis.editor.list.title': 'Push to list',
      'redis.editor.list.side': 'Side',
      'redis.editor.list.left': 'Left (LPUSH)',
      'redis.editor.list.right': 'Right (RPUSH)',
      'redis.editor.set.title': 'Set members',
      'redis.editor.set.member': 'Member',
      'redis.editor.add': 'Add',
      'redis.editor.remove': 'Remove',
      'redis.editor.submit': 'Write',
      'redis.editor.notice.hashSet': 'Field “{field}” set ({count} fields).',
      'redis.editor.notice.listPush': 'Pushed; the list now has {length} items.',
      'redis.editor.notice.setAdd': 'Added; {length} members.',
      'redis.editor.notice.setRemove': 'Removed; {length} members.',
      'redis.editor.notice.setAbsent': 'The member was not present ({length} members).',
      'redis.editor.unsupported': 'This type cannot be edited here.',
      'confirm.redisRename.title': 'Rename key “{key}”?',
      'confirm.redisRename.body': 'The key becomes “{newKey}” immediately; the old name disappears.',
      'confirm.redisRename.action': 'Rename',
      'confirm.redisExpire.title': 'Expire key “{key}”?',
      'confirm.redisExpire.body': 'The key and its value are deleted automatically after {seconds} seconds.',
      'confirm.redisExpire.action': 'Set expiry',
      'pg.activity.title': 'Activity',
      'pg.activity.count': '{count} sessions',
      'pg.activity.empty': 'No active sessions.',
      'pg.activity.pid': 'PID',
      'pg.activity.user': 'User',
      'pg.activity.database': 'Database',
      'pg.activity.state': 'State',
      'pg.activity.client': 'Client',
      'pg.activity.application': 'Application',
      'pg.activity.query': 'Query',
      'pg.activity.duration': 'Duration',
      'pg.activity.wait': 'Wait event',
      'pg.activity.loading': 'Loading sessions…',
      'pg.tables.size': 'Size',
      'pg.detail.columns': 'Columns',
      'pg.detail.indexes': 'Indexes',
      'pg.detail.constraints': 'Constraints',
      'pg.detail.loading': 'Loading table details…',
      'pg.detail.emptyIndexes': 'No indexes.',
      'pg.detail.emptyConstraints': 'No constraints.',
      'pg.detail.index.name': 'Index',
      'pg.detail.index.columns': 'Columns',
      'pg.detail.index.unique': 'Unique',
      'pg.detail.index.primary': 'Primary',
      'pg.detail.constraint.name': 'Constraint',
      'pg.detail.constraint.type': 'Type',
      'pg.detail.constraint.definition': 'Definition',
      'pg.detail.comment': 'Comment',
      'pg.detail.size': 'Size',
      'pg.detail.estimated': 'Estimated rows',
      'pg.detail.tabs': 'Table details',
      'pg.browse.title': 'Data browser',
      'pg.browse.loading': 'Loading rows…',
      'pg.browse.page': 'Page {page}',
      'pg.browse.total': '{count} rows total',
      'pg.browse.pageSize': 'Per page',
      'pg.browse.prev': 'Previous',
      'pg.browse.next': 'Next',
      'pg.browse.empty': 'No rows.',
      'pg.browse.limited': 'Showing the first {count} rows.',
      'pg.browse.csv': 'Download CSV',
      'pg.browse.csvEmpty': 'Nothing to export.',
      'pg.browse.csvDone': 'Download started.',
      'pg.history.title': 'Query history',
      'pg.history.empty': 'No queries run yet.',
      'pg.history.restore': 'Restore this statement',
      'pg.history.restored': 'Restored to the editor.',
      'plain.banner.overview': 'This page explains in plain words how the apps, cache and database on this machine are doing.',
      'plain.banner.docker': 'Containers are running program boxes; images are like installers, and volumes are data folders.',
      'plain.banner.redis': 'Redis is an in-memory cache that makes apps faster.',
      'plain.banner.postgres': 'PostgreSQL is a database that keeps business data long-term in tables.',
      'plain.banner.relations': 'This page draws how programs, installers, data folders and networks connect.',
      'plain.advanced': 'Technical details (advanced)',
      'plain.advancedSql': 'Advanced (SQL)',
      'plain.state.running': 'Running',
      'plain.state.exited': 'Stopped',
      'plain.state.paused': 'Paused',
      'plain.state.restarting': 'Restarting',
      'plain.state.created': 'Created',
      'plain.state.dead': 'Failed',
      'plain.state.other': 'Unknown',
      'plain.role.website': 'Website',
      'plain.role.application': 'Application',
      'plain.role.database': 'Database',
      'plain.role.cache': 'Cache',
      'plain.role.queue': 'Message queue',
      'plain.role.storage': 'Storage',
      'plain.role.monitoring': 'Monitoring',
      'plain.role.other': 'Other',
      'plain.redisType.string': 'Text',
      'plain.redisType.list': 'List',
      'plain.redisType.set': 'Set',
      'plain.redisType.zset': 'Sorted set',
      'plain.redisType.hash': 'Hash',
      'plain.redisType.stream': 'Stream',
      'plain.ttl': 'Expires',
      'plain.ttl.never': 'Never expires',
      'plain.ttl.missing': 'No longer exists',
      'plain.ttl.minutes': '{minutes} minutes left',
      'plain.ttl.seconds': '{seconds} seconds left',
      'plain.copy': 'Copy',
      'plain.copied': 'Copied',
      'plain.copyCommand': 'Copy command',
      'plain.learnMore': 'Learn the words',
      'plain.hintPrefix': 'What you can do: ',
      'plain.close': 'Got it',
      'plain.view.beginner': 'Beginner',
      'plain.view.expert': 'Expert',
      'plain.view.aria': 'Display mode',
      'plain.help': 'Help',
      'plain.help.title': 'Help and glossary',
      'plain.help.concepts': 'Basics',
      'plain.help.redis': 'Redis',
      'plain.help.postgres': 'PostgreSQL',
      'plain.help.faq': 'Common questions',
      'plain.help.docker': 'Docker',
      'plain.help.container': 'Container',
      'plain.help.image': 'Image',
      'plain.help.volume': 'Data volume',
      'plain.help.network': 'Network',
      'plain.help.port': 'Port',
      'plain.help.redis.what': 'Redis',
      'plain.help.redis.key': 'Key',
      'plain.help.redis.ttl': 'TTL (expiry)',
      'plain.help.pg.database': 'Database',
      'plain.help.pg.table': 'Table',
      'plain.help.pg.column': 'Column',
      'plain.help.pg.sql': 'SQL',
      'plain.help.faq.stop': 'What happens when I stop a container?',
      'plain.help.faq.removeVolume': 'What happens when I delete a volume?',
      'plain.help.faq.multi': 'Which container should I choose when several run?',
      'plain.help.faq.unreachable': 'What if the panel cannot connect?',
      'plain.help.docker.desc': 'The tool that manages containers, images, volumes and networks.',
      'plain.help.container.desc': 'A running program box you can start, stop or remove.',
      'plain.help.image.desc': 'The installer for a program; containers are created from it.',
      'plain.help.volume.desc': 'A folder made to hold data; think twice before deleting it.',
      'plain.help.network.desc': 'A channel that lets programs talk to each other.',
      'plain.help.port.desc': 'The number that opens a program to the outside.',
      'plain.help.redis.what.desc': 'A cache that keeps frequently used data in memory for fast reads.',
      'plain.help.redis.key.desc': 'One entry in the cache, found by its name (key).',
      'plain.help.redis.ttl.desc': 'How soon the data is cleared automatically; no expiry means it stays.',
      'plain.help.pg.database.desc': 'A space holding a set of related tables, e.g. a business database.',
      'plain.help.pg.table.desc': 'Stores data in rows and columns, like a spreadsheet.',
      'plain.help.pg.column.desc': 'One column in a table, e.g. email.',
      'plain.help.pg.sql.desc': 'The language for asking the database questions, e.g. “show me 10 rows”.',
      'plain.help.faq.stop.desc': 'Anything using it stops working until you start it again.',
      'plain.help.faq.removeVolume.desc': 'The data in the volume is gone for good.',
      'plain.help.faq.multi.desc': 'Pick the one you want; the panel will not guess for you.',
      'plain.help.faq.unreachable.desc': 'Make sure the service is running, then refresh or check the connection in settings.',
      'overview.title': 'Overview',
      'overview.subtitle': 'Start here for the overall state of this machine',
      'overview.loading': 'Checking the services on this machine…',
      'overview.status.title': 'Overall status',
      'overview.status.good': 'Everything looks fine; nothing needs your attention.',
      'overview.status.attention': 'Mostly fine, but {count} things need your attention.',
      'overview.status.danger': '{count} things need you to take action.',
      'overview.status.counts.good': '{count} fine',
      'overview.status.counts.info': '{count} notes',
      'overview.status.counts.warn': '{count} to watch',
      'overview.status.counts.danger': '{count} problems',
      'overview.status.updated': 'Updated {time}',
      'overview.service.docker': 'Docker',
      'overview.service.redis': 'Redis',
      'overview.service.postgres': 'PostgreSQL',
      'overview.service.docker.what': 'The container manager: boxes that run your software',
      'overview.service.redis.what': 'A fast cache: temporary data that makes apps quicker',
      'overview.service.postgres.what': 'The database: long-term storage for business data',
      'overview.service.status.ok': 'OK',
      'overview.service.status.down': 'Cannot connect',
      'overview.service.status.stopped': 'Not running',
      'overview.service.status.ambiguous': 'Several instances',
      'overview.service.status.none': 'Not found',
      'overview.service.status.unknown': 'Unknown',
      'overview.service.stat.containers': '{running} of {total} programs running',
      'overview.service.stat.redis.keys': '{count} cached entries',
      'overview.service.stat.redis.memory': 'Cache uses {memory}',
      'overview.service.stat.redis.clients': '{count} programs connected',
      'overview.service.stat.pg.databases': '{count} databases',
      'overview.service.stat.pg.sessions': '{count} connections',
      'overview.service.stat.pg.database': 'Current database {name}',
      'overview.service.stat.docker.images': '{count} installers (images)',
      'overview.service.stat.docker.volumes': '{count} data folders',
      'overview.service.stat.unknown': 'No further details yet',
      'overview.service.action.refresh': 'Refresh status',
      'overview.service.action.settings': 'Check connection settings',
      'overview.service.action.choose': 'Choose an instance',
      'overview.service.action.copyStart': 'Copy start command',
      'overview.service.action.openDocker': 'Open Docker',
      'overview.service.action.openRedis': 'Open Redis',
      'overview.service.action.openPostgres': 'Open PostgreSQL',
      'overview.insights.title': 'Needs your attention',
      'overview.insights.empty': 'Nothing needs your attention.',
      'overview.quick.title': 'Quick start',
      'overview.quick.hint': 'First time here? Follow these three steps.',
      'overview.quick.step1': 'Make sure Docker is running',
      'overview.quick.step1.desc': 'Docker is the base that runs the other programs.',
      'overview.quick.step1.done': 'Ready',
      'overview.quick.step1.todo': 'Not ready',
      'overview.quick.step2': 'Start Redis or PostgreSQL (optional)',
      'overview.quick.step2.desc': 'If you have no containers yet, copy a command below and run it in a terminal.',
      'overview.quick.step2.done': '{count} service containers running',
      'overview.quick.step2.todo': 'No running Redis / PostgreSQL container yet',
      'overview.quick.step3': 'Come back here to check the status',
      'overview.quick.step3.desc': 'When you see “all good”, you can start using it.',
      'overview.quick.copyRedis': 'Copy the Redis start command',
      'overview.quick.copyPostgres': 'Copy the PostgreSQL start command',
      'overview.insight.action.docker': 'Open Docker',
      'overview.insight.action.relations': 'Open relations',
      'overview.insight.action.redis': 'Open Redis',
      'overview.insight.action.postgres': 'Open PostgreSQL',
      'overview.insight.action.settings': 'Open settings',
      'overview.insight.action.choose': 'Choose an instance',
      'overview.insight.action.refresh': 'Refresh',
      'insight.docker_unavailable': 'Docker is not running or was not found, so container features are unavailable.',
      'insight.unknown': 'There is a new note ({code}).',
      'insight.no_containers': 'There are no containers yet; copy a start command from Quick start.',
      'insight.stopped_containers': '{count} containers are stopped: {names}.',
      'insight.restarting_containers': '{count} containers are restarting: {names}.',
      'insight.unused_volumes': '{count} volumes are unused: {names}.',
      'insight.dangling_images': '{count} dangling images take up space.',
      'insight.disk_reclaimable': 'About {human} of disk space can be reclaimed.',
      'insight.redis_ok': 'Redis is healthy (version {version}).',
      'insight.redis_ambiguous': '{count} Redis containers are running ({names}); choose one.',
      'insight.redis_no_container': 'No Redis container found; copy a Quick start command to start one.',
      'insight.redis_no_running': 'The Redis container is not running: {names}.',
      'insight.redis_unreachable': 'Cannot reach Redis ({container}): {message}',
      'insight.postgres_ok': 'PostgreSQL is healthy (version {version}).',
      'insight.postgres_ambiguous': '{count} PostgreSQL containers are running ({names}); choose one.',
      'insight.postgres_no_container': 'No PostgreSQL container found; copy a Quick start command to start one.',
      'insight.postgres_no_running': 'The PostgreSQL container is not running: {names}.',
      'insight.postgres_unreachable': 'Cannot reach PostgreSQL ({container}): {message}',
      'intent.docker_unavailable': 'Open settings',
      'intent.no_containers': 'Open Docker',
      'intent.stopped_containers': 'Open Docker',
      'intent.restarting_containers': 'Open Docker',
      'intent.unused_volumes': 'Open relations',
      'intent.dangling_images': 'Open Docker',
      'intent.disk_reclaimable': 'Open Docker',
      'intent.redis_ok': 'Open Redis',
      'intent.redis_ambiguous': 'Choose an instance',
      'intent.redis_no_container': 'Open Redis',
      'intent.redis_no_running': 'Open Redis',
      'intent.redis_unreachable': 'Open Redis',
      'intent.postgres_ok': 'Open PostgreSQL',
      'intent.postgres_ambiguous': 'Choose an instance',
      'intent.postgres_no_container': 'Open PostgreSQL',
      'intent.postgres_no_running': 'Open PostgreSQL',
      'intent.postgres_unreachable': 'Open PostgreSQL',
      'confirm.impact.stop.website': 'The website will be unreachable until you start it again.',
      'confirm.impact.stop.database': 'Apps that use it cannot read or save data.',
      'confirm.impact.stop.cache': 'Apps get slower, but saved data is not lost.',
      'confirm.impact.stop.queue': 'Pending jobs wait until it is back.',
      'confirm.impact.stop.other': 'Features that rely on it are temporarily unavailable.',
      'confirm.impact.restart.website': 'The website is briefly unreachable while it restarts.',
      'confirm.impact.restart.other': 'The service is briefly interrupted while it restarts.',
      'confirm.impact.pause.website': 'The website stops responding until you unpause it.',
      'confirm.impact.pause.other': 'The service stops responding until you unpause it.',
      'confirm.impact.container.remove': 'The container is removed; data in volumes is not.',
      'confirm.impact.image.remove': 'You will need to download it again to use it.',
      'confirm.impact.volume.remove': 'The data inside is lost for good.',
      'confirm.impact.network.remove': 'Programs on this network lose their connection to each other.',
      'confirm.impact.redis.delete': 'This cached entry is deleted for good.',
      'confirm.impact.redis.rename': 'Apps using the old name will not find it.',
      'confirm.impact.redis.expire': 'The entry is deleted automatically when it expires.',
      'plain.error.unreachable': 'The panel cannot reach the local service right now.',
      'plain.error.hint.unreachable': 'Make sure the service is running and press Retry; if it keeps failing, check the connection in settings.',
      'plain.error.dockerUnavailable': 'Docker is not running or is not installed.',
      'plain.error.hint.dockerUnavailable': 'Start the Docker app, wait for it, then press Retry.',
      'plain.error.auth': 'The username or password is wrong, so the service cannot be reached.',
      'plain.error.hint.auth': 'Open settings, check the username and password, then retry.',
      'plain.error.timeout': 'The service took too long to respond.',
      'plain.error.hint.timeout': 'Try again later; if it keeps timing out, check whether the service is busy.',
      'plain.error.noContainer': 'No matching container was found.',
      'plain.error.hint.noContainer': 'Start or create a container on the Docker page, or switch to a manual address in settings.',
      'plain.error.ambiguous': 'Several services of this kind are running; choose one first.',
      'plain.error.hint.ambiguous': 'Pick one in the instance bar at the top of this page.',
      'plain.error.noPort': 'The container does not open a port to this machine.',
      'plain.error.hint.noPort': 'Recreate the container with a published port, e.g. -p 6379:6379.',
      'plain.error.invalid': 'Some input is not valid.',
      'plain.error.hint.invalid': 'Check the names and numbers you entered, then retry.',
      'plain.error.generic': 'The action did not succeed.',
      'plain.error.hint.generic': 'Retry later; if it keeps failing, open Help for common questions.',
      'docker.group.ungrouped': 'Ungrouped',
      'docker.group.title': 'Project: {project}',
      'docker.group.count': '{count} containers',
      'redis.wizard.open': 'Write data',
      'redis.wizard.title': 'Write data',
      'redis.wizard.step.type': 'Choose the kind of data',
      'redis.wizard.step.fields': 'Fill in the fields',
      'redis.wizard.type.string': 'Text',
      'redis.wizard.type.hash': 'Hash (field → value)',
      'redis.wizard.type.list': 'List (append in order)',
      'redis.wizard.type.set': 'Set (no duplicates)',
      'redis.wizard.key': 'Data name (key)',
      'redis.wizard.field': 'Field name',
      'redis.wizard.value': 'Value',
      'redis.wizard.member': 'Member',
      'redis.wizard.ttl': 'Clear after (seconds, optional)',
      'redis.wizard.save': 'Save',
      'redis.wizard.saving': 'Saving…',
      'redis.wizard.cancel': 'Cancel',
      'redis.wizard.notice': 'Saved to {key}.',
      'redis.wizard.error': 'Could not save; check the fields and try again.',
      'redis.wizard.keyRequired': 'Enter a data name first.',
      'redis.wizard.fieldRequired': 'Enter a field name and a value.',
      'redis.wizard.memberRequired': 'Enter a member.',
      'pg.template.title': 'Quick queries',
      'pg.template.preview': 'Show the first 10 rows',
      'pg.template.count': 'Count the rows',
      'pg.template.columns': 'List the columns',
      'pg.template.hint': 'Choose a table first, then pick a template.',
      'pg.browse.beginnerHint': 'Pick a database, then a table, to see the data.',
      'relations.legend.beginner': 'Rounded boxes are programs; installers are on the left, data folders on the right, and lines show how they connect.',
      'dockerfile.banner': 'A Dockerfile is the recipe for building an image: which base image to start from, which files to copy in, and how to start the program.',
      'dockerfile.count': '{count} Dockerfiles',
      'dockerfile.roots': 'Scanning: {roots}',
      'dockerfile.rootsNone': 'No workspace directory to scan',
      'dockerfile.scan': '{files} files checked',
      'dockerfile.truncated': 'There were too many files, so this scan stopped early.',
      'dockerfile.refresh': 'Scan again',
      'dockerfile.loading': 'Looking for Dockerfiles…',
      'dockerfile.empty.title': 'No Dockerfile found',
      'dockerfile.empty.hint': 'A Dockerfile is the recipe for building an image. The panel looked in: {roots}',
      'dockerfile.empty.sampleTitle': 'A minimal example',
      'dockerfile.empty.sampleHint': 'Save the content above as a file named Dockerfile in a project folder, then press “Scan again”.',
      'dockerfile.empty.settingsHint': 'Want to scan other folders? Add scan locations under “Dockerfiles” in settings.',
      'dockerfile.card.base': 'Base image: {image}',
      'dockerfile.card.baseRole': 'Base image: {image} ({role})',
      'dockerfile.card.noneBase': 'No base image declared',
      'dockerfile.card.multiStage': 'Multi-stage build ({count} stages)',
      'dockerfile.card.instructions': '{count} instructions',
      'dockerfile.card.noPorts': 'No exposed ports',
      'dockerfile.card.command': 'Start command',
      'dockerfile.card.healthcheck': 'Health check',
      'dockerfile.card.env': '{count} environment variables',
      'dockerfile.card.volumes': '{count} data folders',
      'dockerfile.card.view': 'View content',
      'dockerfile.card.copyBuild': 'Copy build command',
      'dockerfile.card.copyPath': 'Copy path',
      'dockerfile.card.path': 'Location: {path}',
      'dockerfile.port.label': 'Port {port}: {meaning}',
      'dockerfile.port.website': 'website entry',
      'dockerfile.port.secure': 'secure website entry',
      'dockerfile.port.database': 'database entry',
      'dockerfile.port.cache': 'cache entry',
      'dockerfile.port.queue': 'message queue entry',
      'dockerfile.port.storage': 'file storage entry',
      'dockerfile.port.application': 'service entry',
      'dockerfile.view.title': 'Dockerfile content',
      'dockerfile.view.loading': 'Reading content…',
      'dockerfile.view.annotated': 'Instruction by instruction',
      'dockerfile.view.raw': 'Raw content (with line numbers)',
      'dockerfile.view.line': 'Line {line}',
      'dockerfile.view.truncated': 'The file is large; only the beginning is shown.',
      'dockerfile.view.summary': 'Parsed summary',
      'dockerfile.view.stages': 'Build stages',
      'dockerfile.view.stageName': 'Stage {index}: {base}',
      'dockerfile.view.baseImages': 'Base images used',
      'dockerfile.view.warnings': 'Things to check',
      'dockerfile.view.warning': 'Line {line}: {message}',
      'dockerfile.view.noWarnings': 'Nothing looks wrong.',
      'dockerfile.view.close': 'Close',
      'dockerfile.explain.from': 'Base image: where the program comes from',
      'dockerfile.explain.run': 'Command run while building',
      'dockerfile.explain.copy': 'Copy files into the image',
      'dockerfile.explain.add': 'Add files (can also unpack)',
      'dockerfile.explain.cmd': 'Command run at startup',
      'dockerfile.explain.entrypoint': 'Entry program',
      'dockerfile.explain.expose': 'Open a port',
      'dockerfile.explain.env': 'Environment variable',
      'dockerfile.explain.arg': 'Build argument',
      'dockerfile.explain.workdir': 'Working directory',
      'dockerfile.explain.user': 'Run as user',
      'dockerfile.explain.volume': 'Where data is stored',
      'dockerfile.explain.healthcheck': 'Health check',
      'dockerfile.explain.label': 'Description label',
      'dockerfile.explain.other': 'Other setting',
      'settings.dockerfiles.title': 'Dockerfiles',
      'settings.dockerfiles.roots': 'Extra scan locations',
      'settings.dockerfiles.rootsHint': 'One absolute path per line. Workspaces are scanned automatically; add other folders here (up to 20).',
      'settings.dockerfiles.maxDepth': 'Scan depth',
      'settings.dockerfiles.maxDepthHint': '1–12 levels, default 6.',
      'overview.service.stat.docker.dockerfiles': '{count} Dockerfiles',
      'insight.dockerfiles_found': 'Found {count} Dockerfiles in the project: {names}.',
      'intent.dockerfiles_found': 'Open Dockerfiles',
      'confirm.cancelHint': 'Press Esc to cancel',
    }

    /**
     * The panel's stylesheet.
     *
     * Follows the shell's own design language rather than inventing one: the
     * Schedule page's page/scroll/content geometry, pill tabs, flat
     * hover-tinted rows, the shared input/button/notice patterns, card surfaces
     * for grouped data, and the shell modal's mask + elevated panel for
     * confirmations. Every chrome color is a `--dsw-*` theme token, so light and
     * dark themes both follow the shell; the only literal colors are none.
     * Motion is 150–200 ms and disabled under `prefers-reduced-motion`.
     */
    const css = `
.dshDataPage{width:100%;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;overflow:hidden}
.dshDataScroll{scrollbar-gutter:stable;flex:1;min-height:0;overflow:auto}
.dshDataContent{width:100%;max-width:1080px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.dshDataHeading{display:flex;align-items:flex-start;gap:14px;margin:0 0 14px;padding-top:28px;flex-wrap:wrap}
.dshDataHeadingMain{display:flex;align-items:center;gap:14px;flex:1 1 320px;min-width:0}
.dshDataBrandMark{width:42px;height:42px;flex:none;display:grid;place-items:center;color:var(--dsw-alias-state-business-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshDataHeadingText{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshDataHeadingText h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dshDataSubtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataHeadingRight{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
.dshDataChips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dshDataChip{display:inline-flex;align-items:center;gap:6px;height:26px;flex:none;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.dshDataChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataChipDot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshDataChipOk .dshDataChipDot{background:var(--dsw-alias-state-success-primary)}
.dshDataChipChecking .dshDataChipDot{background:var(--dsw-alias-state-warn-primary)}
.dshDataChipDown .dshDataChipDot{background:var(--dsw-alias-state-error-primary)}
.dshDataChipDown{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.dshDataChipLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataChipTarget{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshDataChipWarn .dshDataChipDot{background:var(--dsw-alias-state-warn-primary)}
.dshDataRefresh{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s,opacity .15s}
.dshDataRefresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataRefresh:disabled{cursor:not-allowed;opacity:.6}
.dshDataRefreshBusy svg{animation:dshDataSpin .9s linear infinite}
.dshDataTabsRow{display:flex;align-items:center;gap:8px;margin:0 0 18px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding-bottom:6px;flex-wrap:wrap}
.dshDataTabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-width:0;flex:1 1 auto}
.dshDataTab{display:inline-flex;align-items:center;gap:6px;height:30px;flex:none;padding:0 12px;border:0;border-radius:15px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;transition:background .15s,color .15s}
.dshDataTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataTabActive,.dshDataTabActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.dshDataGear{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;margin-left:auto;padding:0;border:0;border-radius:15px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s}
.dshDataGear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataGearActive,.dshDataGearActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}
.dshDataTabPanel{min-width:0;animation:dshDataFadeIn .18s ease-in-out}
.dshDataTabBody{display:flex;flex-direction:column;gap:14px;animation:dshDataFadeIn .18s ease-in-out}
.dshDataSplit{display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:12px;align-items:start}
.dshDataButton{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;flex:none;padding:0 13px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .15s,border-color .15s,color .15s,opacity .15s}
.dshDataButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshDataButton:disabled{cursor:not-allowed;opacity:.4}
.dshDataButtonCompact{height:28px;padding:0 10px;border-radius:14px;font-size:12px;line-height:18px}
.dshDataButtonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dshDataButtonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshDataButtonOutline{border:.5px solid var(--dsw-alias-border-l3)}
.dshDataButtonOutline:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dshDataButtonDanger{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshDataButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshDataIconButton{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s,opacity .15s}
.dshDataIconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataIconButton:disabled{cursor:not-allowed;opacity:.35}
.dshDataIconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshDataIcon{display:block}
.dshDataHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataHintWarn{color:var(--dsw-alias-state-error-primary)}
.dshDataMuted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshDataMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.dshDataSrOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.dshDataBadge{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;white-space:nowrap}
.dshDataBadgeWarn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}
.dshDataNotice{display:flex;align-items:flex-start;flex-wrap:wrap;gap:9px;margin:0;padding:11px 13px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dshDataNoticeText{flex:1;min-width:0;margin:0;overflow-wrap:anywhere}
.dshDataNoticeError{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.dshDataNoticeIcon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.dshDataNoticeError .dshDataNoticeIcon{color:var(--dsw-alias-state-error-primary)}
.dshDataNoticeInfo{border-color:var(--dsw-alias-state-warn-secondary)}
.dshDataNoticeInfo .dshDataNoticeIcon{color:var(--dsw-alias-state-warn-primary)}
.dshDataNoticeBody{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dshDataNoticeDetail{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataNotice .dshDataButton{margin-left:auto}
.dshDataCard{display:flex;flex-direction:column;min-width:0;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshDataCardHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.dshDataCardTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.dshDataCardMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshDataCardHint{margin:0;flex:1;min-width:140px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataCardActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.dshDataToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dshDataToolbarMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshDataDockerBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dshDataDockerBarActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.dshDataSubTabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-width:0}
.dshDataSubTab{display:inline-flex;align-items:center;gap:6px;height:26px;flex:none;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:13px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.dshDataSubTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataSubTabActive,.dshDataSubTabActive:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.dshDataResourceMount{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px}
.dshDataInlineField{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshDataToolbarStatus{flex:1 1 240px;min-width:0;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataInput{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;font:inherit;font-size:13px;line-height:20px}
.dshDataInput::placeholder{color:var(--dsw-alias-label-caption)}
.dshDataInput:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshDataInputMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dshDataSelect{box-sizing:border-box;height:32px;max-width:100%;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dshDataSelect:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshDataTextarea{box-sizing:border-box;width:100%;min-height:84px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;resize:vertical;font:inherit;font-size:13px;line-height:20px}
.dshDataTextarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshDataTextareaMono,.dshDataTextareaMono:focus{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:19px}
.dshDataField{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshDataFieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshDataFieldHint{margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px}
.dshDataFieldGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 12px;margin:0 0 10px}
.dshDataCheck{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.dshDataCheck input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dshDataStats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.dshDataStat{min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshDataStatLabel{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshDataStatValue{margin:2px 0 0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dshDataStatMeta{margin:2px 0 0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataDockerList{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dshDataDockerItem{display:flex;flex-direction:column;min-width:0;animation:dshDataRowIn .18s ease-in-out}
.dshDataDockerRow{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:12px;transition:background .15s}
.dshDataDockerRow:hover,.dshDataDockerRow:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.dshDataDot{width:8px;height:8px;flex:none;margin-top:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshDataDotOk{background:var(--dsw-alias-state-success-primary)}
.dshDataDotWarn{background:var(--dsw-alias-state-warn-primary)}
.dshDataDotDown{background:var(--dsw-alias-state-error-primary)}
.dshDataDockerMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dshDataDockerTitleLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshDataDockerName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dshDataDockerId{color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataDockerMeta{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataDockerImage{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
.dshDataDockerStatus{font-variant-numeric:tabular-nums}
.dshDataDockerPorts{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px}
.dshDataDockerActions{display:flex;align-items:center;gap:2px;flex-wrap:wrap;flex:none;max-width:56%;justify-content:flex-end}
.dshDataBusy{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataDrawer{margin:2px 0 8px 30px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);animation:dshDataFadeIn .18s ease-in-out}
.dshDataDrawerHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.dshDataDrawerTitle{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshDataDrawerActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.dshDataLogs{margin:0;max-height:300px;overflow:auto;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.dshDataDetailGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.dshDataDetailSection{min-width:0}
.dshDataDetailTitle{margin:0 0 6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;letter-spacing:.02em;text-transform:uppercase}
.dshDataKvList{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dshDataKvRow{display:flex;align-items:baseline;gap:10px;min-width:0;font-size:12px;line-height:18px;padding:2px 0}
.dshDataKvKey{flex:none;max-width:44%;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataKvValue{min-width:0;flex:1;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataKvValueMuted{color:var(--dsw-alias-label-caption);font-style:italic}
.dshDataPre{margin:0;max-height:220px;overflow:auto;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.dshDataToolbar .dshDataInput{flex:1 1 180px;max-width:320px}
.dshDataCard > .dshDataInput{width:100%;margin:0 0 8px}
.dshDataScanBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px}
.dshDataScanBar .dshDataInput{flex:1 1 140px;min-width:120px}
.dshDataKeyList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;max-height:420px;overflow:auto}
.dshDataKeyButton{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:13px;line-height:19px;cursor:pointer;transition:background .15s,color .15s}
.dshDataKeyButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshDataKeyButtonActive,.dshDataKeyButtonActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}
.dshDataKeyName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.dshDataRedisDetail{display:flex;flex-direction:column;gap:10px;min-width:0}
.dshDataKeyHeader{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;min-width:0}
.dshDataKeyHeaderName{margin:0;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:500;line-height:20px}
.dshDataKeyHeaderMeta{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshDataValue{margin:0;max-height:300px;overflow:auto;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.dshDataValueList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;max-height:300px;overflow:auto}
.dshDataValueItem{display:flex;align-items:baseline;gap:8px;min-width:0;padding:3px 6px;border-radius:6px;font-size:12px;line-height:18px}
.dshDataValueIndex{flex:none;min-width:26px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.dshDataValueText{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataSetForm{display:flex;flex-direction:column;gap:10px}
.dshDataSetGrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,180px);gap:10px;align-items:start}
.dshDataSetNotice{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.dshDataTableList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;max-height:360px;overflow:auto}
.dshDataTableButton{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;cursor:pointer;transition:background .15s,color .15s}
.dshDataTableButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshDataTableButtonActive,.dshDataTableButtonActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}
.dshDataTableName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:19px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataTableMeta{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
.dshDataGridWrap{min-width:0;overflow:auto;max-height:360px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshDataGrid{border-collapse:separate;border-spacing:0;width:100%;min-width:max-content;font-size:12px;line-height:18px}
.dshDataTh{position:sticky;top:0;z-index:1;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);text-align:left;font-weight:500;white-space:nowrap}
.dshDataThName{display:block;font-size:12px;line-height:17px}
.dshDataThType{display:block;color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataTd{max-width:360px;padding:5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataTdMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataNull{color:var(--dsw-alias-label-caption);font-style:italic;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataResult{display:flex;flex-direction:column;gap:10px;min-width:0}
.dshDataResultMeta{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;margin:0}
.dshDataResultSet{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshDataResultHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshDataSqlBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.dshDataSqlError{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 9px;align-items:start}
.dshDataSqlError .dshDataNoticeIcon{margin-top:2px}
.dshDataSqlError .dshDataNoticeBody{grid-column:2}
.dshDataSqlError .dshDataButton{grid-column:2;justify-self:start;margin:6px 0 0}
.dshDataSqlState{margin:0;color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.dshDataSettings{display:flex;flex-direction:column;gap:14px}
.dshDataSettingsHead{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dshDataSettingsHeadText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:200px}
.dshDataSettingsActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.dshDataSettingsSection{display:flex;flex-direction:column;gap:10px}
.dshDataSettingsSectionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshDataSettingsSectionTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.dshDataSettingsMode{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.dshDataSettingsModeLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataSeg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.dshDataSegButton{display:inline-flex;align-items:center;height:24px;padding:0 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s,color .15s}
.dshDataSegButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataSegButtonActive,.dshDataSegButtonActive:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:var(--dsw-elevation-soft)}
.dshDataTargetBox{display:flex;flex-direction:column;gap:2px;margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshDataTargetLine{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataTargetLineMono{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataTargetMeta{margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.dshDataTargetError{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataTargetSelect{box-sizing:border-box;width:100%;max-width:none}
.dshDataTestRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.dshDataTestOk{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataTestFail{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataLoading{display:flex;flex-direction:column;gap:8px}
.dshDataSkeleton{height:58px;border-radius:12px;background:var(--dsw-alias-bg-skeleton);animation:dshDataPulse 2s cubic-bezier(.36,0,.64,1) infinite}
.dshDataSpinner{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);animation:dshDataSpin .8s linear infinite}
.dshDataEmpty{display:flex;flex-direction:column;align-items:center;margin:0;padding:36px 20px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);text-align:center;animation:dshDataFadeIn .18s ease-in-out}
.dshDataEmptyArt{display:grid;place-items:center;width:52px;height:52px;margin-bottom:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-caption)}
.dshDataEmptyTitle{margin:0 0 6px;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}
.dshDataEmptyHint{margin:0;max-width:420px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshDataOverlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.dshDataBackdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);-webkit-backdrop-filter:var(--dsw-mask-blur);animation:dshDataFadeIn .2s ease-in-out}
.dshDataDialog{position:relative;z-index:1;width:min(380px,100%);padding:24px;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dshDataDialogIn .2s ease-in-out}
.dshDataDialogTitle{margin:0 0 8px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dshDataDialogBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;overflow-wrap:anywhere}
.dshDataDialogHint{margin:10px 0 0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.dshDataDialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.dshDataDialogActions .dshDataButton{min-width:72px}
.dshDataInstanceBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshDataInstanceLabel{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
.dshDataInstanceChip{display:inline-flex;align-items:center;gap:6px;height:26px;flex:none;max-width:100%;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s,border-color .15s,color .15s,opacity .15s}
.dshDataInstanceChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataInstanceChip:disabled{cursor:not-allowed;opacity:.5}
.dshDataInstanceChipActive,.dshDataInstanceChipActive:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);font-weight:500}
.dshDataInstanceName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px}
.dshDataInstanceAddr{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshDataStateFilters{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
.dshDataPill{display:inline-flex;align-items:center;height:24px;flex:none;padding:0 10px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s,color .15s}
.dshDataPill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataPillActive,.dshDataPillActive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.dshDataDockerMetric{flex:none;min-width:64px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshDataDockerMetrics{display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex:none;padding-top:2px}
.dshDataDockerMetricLabel{color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;margin-right:2px}
.dshDataRelGraphWrap{min-width:0;overflow-x:auto;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshDataRelSvg{display:block}
.dshDataRelNodeGroup{cursor:pointer;outline:none}
.dshDataRelNode{fill:var(--dsw-alias-bg-base);stroke:var(--dsw-alias-border-l2);stroke-width:1}
.dshDataRelNodeImage{stroke:var(--dsw-alias-state-business-primary)}
.dshDataRelNodeContainer{stroke:var(--dsw-alias-state-business-primary)}
.dshDataRelNodeVolume{stroke:var(--dsw-alias-state-success-primary)}
.dshDataRelNodeText{fill:var(--dsw-alias-label-primary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataRelNodeSub{fill:var(--dsw-alias-label-caption);font-size:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataRelNetText{fill:var(--dsw-alias-label-tertiary);font-size:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataRelLineImage{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1;opacity:.45}
.dshDataRelLineVolume{fill:none;stroke:var(--dsw-alias-state-success-primary);stroke-width:1;opacity:.45}
.dshDataRelLegend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 8px}
.dshDataLegendItem{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshDataLegendDot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshDataLegendImage{background:var(--dsw-alias-state-business-primary)}
.dshDataLegendContainer{background:var(--dsw-alias-state-business-primary)}
.dshDataLegendVolume{background:var(--dsw-alias-state-success-primary)}
.dshDataChipLink{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:20px;padding:0 7px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:17px;cursor:pointer;transition:background .15s,color .15s}
.dshDataChipLink:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataChipLinkText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataLinkButton{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left;overflow-wrap:anywhere}
.dshDataLinkButton:hover{text-decoration:underline}
.dshDataModal{position:relative;z-index:1;display:flex;flex-direction:column;width:min(780px,100%);max-height:min(84vh,780px);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dshDataDialogIn .2s ease-in-out}
.dshDataModalHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px 20px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshDataModalTitle{margin:0;min-width:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataModalMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshDataModalActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.dshDataModalBody{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:auto;padding:12px 20px 20px}
.dshDataModalSection{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshDataEditor{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshDataEditorRow{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.dshDataEditorRow .dshDataField{flex:1 1 140px;min-width:120px}
.dshDataNoticeOk{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataEditorNotice{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataKeyMetaRow{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataKeyActions{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dshDataKeyActions .dshDataField{flex:1 1 130px;min-width:110px}
.dshDataBrowseBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.dshDataBrowseMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshDataHistoryList{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;max-height:220px;overflow:auto}
.dshDataHistoryButton{display:flex;align-items:baseline;gap:8px;width:100%;padding:5px 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;transition:background .15s}
.dshDataHistoryButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshDataHistorySql{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.dshDataHistoryMeta{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshDataActivityQuery{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataRelChips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.dshDataRelPath{color:var(--dsw-alias-label-caption);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.dshDataGraphEmpty{padding:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}
.dshDataHeaderTools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshDataModeToggle{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshDataModeButton{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:17px;cursor:pointer;transition:background .15s,color .15s}
.dshDataModeButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataModeButtonActive,.dshDataModeButtonActive:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:var(--dsw-elevation-soft)}
.dshDataHelpButton{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background .15s,color .15s}
.dshDataHelpButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataPlainBanner{display:flex;align-items:flex-start;gap:8px;margin:0;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshDataPlainBannerIcon{flex:none;margin-top:1px;color:var(--dsw-alias-state-business-primary)}
.dshDataPlainBannerText{flex:1;min-width:0;margin:0;overflow-wrap:anywhere}
.dshDataRoleChip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:17px;white-space:nowrap}
.dshDataGroup{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshDataGroupHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataGroupTitle{color:var(--dsw-alias-label-primary);font-weight:500}
.dshDataGroupCount{color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshDataCopyButton{display:inline-flex;align-items:center;gap:5px;height:24px;flex:none;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:17px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.dshDataCopyButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDataCopied{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshDataCommandRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshDataCommand{min-width:0;flex:1 1 220px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.dshDataOverview{display:flex;flex-direction:column;gap:14px}
.dshDataOverviewStatus{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;padding:16px 18px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshDataOverviewStatusMain{display:flex;flex-direction:column;gap:4px;flex:1;min-width:220px}
.dshDataOverviewStatusTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.dshDataOverviewStatusSentence{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.dshDataOverviewCounts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshDataCountPill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dshDataCountGood{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-success-primary)}
.dshDataCountInfo{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshDataCountWarn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}
.dshDataCountDanger{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshDataServiceGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.dshDataServiceCard{display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dshDataServiceHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshDataServiceTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}
.dshDataServiceWhat{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:1 1 100%}
.dshDataServiceStats{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshDataServiceActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:6px}
.dshDataInsightList{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dshDataInsight{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap;padding:9px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshDataInsightIcon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.dshDataInsightText{flex:1;min-width:0;margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshDataInsight .dshDataButton{margin-left:auto}
.dshDataInsightGood .dshDataInsightIcon{color:var(--dsw-alias-state-success-primary)}
.dshDataInsightWarn{border-color:var(--dsw-alias-state-warn-secondary)}
.dshDataInsightWarn .dshDataInsightIcon{color:var(--dsw-alias-state-warn-primary)}
.dshDataInsightDanger{border-color:var(--dsw-alias-state-error-secondary)}
.dshDataInsightDanger .dshDataInsightIcon{color:var(--dsw-alias-state-error-primary)}
.dshDataQuickList{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}
.dshDataQuickStep{display:flex;align-items:flex-start;gap:10px}
.dshDataQuickIndex{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:50%;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:12px;font-weight:500}
.dshDataQuickBody{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dshDataQuickTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.dshDataQuickDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshDataQuickState{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dshDataQuickDone{color:var(--dsw-alias-state-success-primary)}
.dshDataHelpSection{display:flex;flex-direction:column;gap:6px}
.dshDataHelpList{display:flex;flex-direction:column;gap:7px;margin:0;padding:0;list-style:none}
.dshDataHelpTerm{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.dshDataHelpItem{display:flex;flex-direction:column;gap:1px}
.dshDataHelpDesc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshDataDialogImpact{color:var(--dsw-alias-state-warn-primary)}
.dshDataDockerGroups{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshDataDetails{margin:0;padding:2px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshDataDetails>summary{padding:6px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;outline:none}
.dshDataDetails[open]>summary{color:var(--dsw-alias-label-primary)}
.dshDataDetailsBody{padding:2px 0 8px}
.dshDataWizard{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshDataWizardSteps{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshDataWizardStep{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshDataWizardStepActive{color:var(--dsw-alias-label-primary);font-weight:500}
.dshDataWizardGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 10px}
.dshDataTemplateBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 8px}
.dshDataServicePill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dshDataServicePillOk{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-success-primary)}
.dshDataServicePillWarn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}
.dshDataServicePillDown{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshDataDockerfileCard{gap:8px;min-width:0}
.dshDataDockerfileList{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;min-width:0}
.dshDataDockerfileHead{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.dshDataDockerfileHeadText{display:flex;flex-direction:column;gap:1px;flex:1 1 180px;min-width:0}
.dshDataDockerfileTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataDockerfileMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataDockerfileChips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end;flex:none;max-width:100%}
.dshDataDockerfileBase{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataDockerfilePorts{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:0}
.dshDataDockerfileCommand{display:flex;align-items:baseline;gap:4px;min-width:0;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshDataDockerfileCommand code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dshDataDockerfilePath{margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshDataDockerfileActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:6px}
.dshDataDockerfileRoots{flex:1 1 260px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDataDockerfileSample{margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.dshDataCodeList{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none;max-height:420px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshDataCodeRow{display:flex;align-items:flex-start;gap:10px;padding:2px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.dshDataCodeRow:last-child{border-bottom:0}
.dshDataCodeLine{flex:none;min-width:34px;color:var(--dsw-alias-label-caption);text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;user-select:none}
.dshDataCodeText{min-width:0;flex:1 1 220px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dshDataCodeNote{flex:1 1 160px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshDataSummaryList{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dshDataSummaryRow{margin:0;padding:2px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataWarningRow{margin:0;padding:2px 0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshDataPage :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshDataInput:focus-visible,.dshDataSelect:focus-visible,.dshDataTextarea:focus-visible,.dshDataKeyButton:focus-visible,.dshDataTableButton:focus-visible{outline:none}
@keyframes dshDataSpin{to{transform:rotate(360deg)}}
@keyframes dshDataFadeIn{from{opacity:0}to{opacity:1}}
@keyframes dshDataRowIn{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
@keyframes dshDataDialogIn{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes dshDataPulse{0%,100%{opacity:1}50%{opacity:.55}}
@media (hover:none){.dshDataDockerActions{max-width:100%}}
@media (max-width:880px){.dshDataSplit{grid-template-columns:minmax(0,1fr)}.dshDataDockerBarActions{margin-left:0}.dshDataSettingsMode{margin-left:0}.dshDataContent{padding:0 20px 32px}.dshDataHeading{padding-top:20px}.dshDataDockerActions{max-width:100%;justify-content:flex-start}.dshDataToolbarMeta{margin-left:0}.dshDataSetGrid{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.dshDataPage *{animation:none!important;transition:none!important}}
`

    /** The `<style>` element id, so a second materialization cannot double-inject. */
    const STYLE_ID = `${NS}/panel.css`

    /**
     * Inject the stylesheet once. Called inside an effect, so unloading the
     * plugin removes what it added.
     *
     * @returns {() => void} the cleanup.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /**
     * @param {unknown} value - a candidate.
     * @returns {value is Record<string, any>} whether it is a plain object.
     */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * @param {unknown} value - a candidate.
     * @param {string} fallback - used unless the value is a non-empty string.
     * @returns {string} the string.
     */
    function textOf(value, fallback) {
      return typeof value === 'string' && value !== '' ? value : fallback
    }

    /**
     * @param {unknown} value - a candidate.
     * @param {number} fallback - used unless the value is an integer.
     * @returns {number} the integer.
     */
    function integerOf(value, fallback) {
      return typeof value === 'number' && Number.isInteger(value) ? value : fallback
    }

    /**
     * The label key for a container state, so the row can say "running" instead
     * of a raw docker token.
     *
     * @param {string} state - the docker state.
     * @returns {string} the dictionary key.
     */
    function stateLabelKey(state) {
      switch (state) {
        case 'running': return 'docker.state.running'
        case 'exited': return 'docker.state.exited'
        case 'paused': return 'docker.state.paused'
        case 'created': return 'docker.state.created'
        case 'restarting': return 'docker.state.restarting'
        case 'dead': return 'docker.state.dead'
        default: return 'docker.state.other'
      }
    }

    /**
     * @param {string} state - the docker state.
     * @returns {string} the dot tone suffix used by CSS.
     */
    function stateTone(state) {
      if (state === 'running') return 'Ok'
      if (state === 'paused' || state === 'restarting' || state === 'created') return 'Warn'
      if (state === 'exited' || state === 'dead') return 'Down'
      return 'Idle'
    }

    /**
     * Format a container's published ports as one line of text.
     *
     * @param {unknown} ports - the container's ports array.
     * @param {(key: string) => string} t - the translator.
     * @returns {string} e.g. "8080:80/tcp · 127.0.0.1:5432:5432/tcp".
     */
    function formatPorts(ports, t) {
      if (!Array.isArray(ports) || ports.length === 0) return t('docker.portsNone')
      const parts = []
      for (const port of ports) {
        if (!isRecord(port)) continue
        const containerPort = typeof port.container === 'string'
          ? port.container
          : port.container === undefined || port.container === null ? '' : String(port.container)
        if (containerPort === '') continue
        const protocol = typeof port.protocol === 'string' && port.protocol !== '' ? port.protocol : 'tcp'
        const host = typeof port.host === 'string' && port.host !== '' ? port.host : null
        const ip = typeof port.ip === 'string' && port.ip !== '' && port.ip !== '0.0.0.0' && port.ip !== '::' ? port.ip : null
        const prefix = ip === null ? '' : `${ip}:`
        parts.push(host === null ? `${prefix}${containerPort}/${protocol}` : `${prefix}${host}:${containerPort}/${protocol}`)
      }
      return parts.length === 0 ? t('docker.portsNone') : parts.join(' · ')
    }

    /**
     * @param {number} totalSeconds - uptime in seconds.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} a compact localized uptime.
     */
    function formatUptime(totalSeconds, t) {
      const seconds = typeof totalSeconds === 'number' && Number.isFinite(totalSeconds)
        ? Math.max(0, Math.floor(totalSeconds))
        : 0
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const rest = seconds % 60
      if (days > 0) return t('redis.uptime.days', { days, hours })
      if (hours > 0) return t('redis.uptime.hours', { hours, minutes })
      if (minutes > 0) return t('redis.uptime.minutes', { minutes, seconds: rest })
      return t('redis.uptime.seconds', { seconds: rest })
    }

    /** @param {number} bytes - a byte count. @returns {string} a compact size. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let value = bytes
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      const digits = value >= 10 || index === 0 ? 0 : 1
      return `${value.toFixed(digits)} ${units[index]}`
    }

    /**
     * Redis reports the hit rate as a ratio in some versions and a percentage
     * in others; anything at or below 1 is treated as a ratio.
     *
     * @param {number} value - the reported hit rate.
     * @returns {string} the percentage with one decimal.
     */
    function formatHitRate(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
      return (number <= 1 ? number * 100 : number).toFixed(1)
    }

    /**
     * @param {unknown} ttl - the TTL Redis reported.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} the localized TTL.
     */
    function formatTtl(ttl, t) {
      if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return t('redis.key.ttl.missing')
      if (ttl === -1) return t('redis.key.ttl.persistent')
      if (ttl < -1) return t('redis.key.ttl.missing')
      return t('redis.key.ttl.seconds', { seconds: ttl })
    }

    /**
     * @param {string} version - a `SELECT version()` line.
     * @returns {string} just the version number, or the input when unknown.
     */
    function shortPgVersion(version) {
      if (typeof version !== 'string' || version.trim() === '') return ''
      const match = version.match(/PostgreSQL\s+([0-9][0-9A-Za-z.]*)/i)
      if (match !== null) return match[1]
      const first = version.trim().split(/\s+/)[0]
      return first === undefined ? version : first
    }

    /**
     * @param {string} name - an SQL identifier.
     * @returns {string} the identifier quoted for the simple Query protocol.
     */
    function quoteIdent(name) {
      return `"${String(name).replace(/"/g, '""')}"`
    }

    /**
     * @param {unknown} kind - a PgTable kind.
     * @returns {string} the dictionary key describing it.
     */
    function tableKindKey(kind) {
      if (kind === 'view') return 'pg.kind.view'
      if (kind === 'materialized view') return 'pg.kind.materializedView'
      if (kind === 'foreign table') return 'pg.kind.foreignTable'
      return 'pg.kind.table'
    }

    /**
     * Flatten and shorten a value for a confirmation sentence.
     *
     * @param {string} value - the text to shorten.
     * @param {number} [limit] - the character budget.
     * @returns {string} a single-line snippet.
     */
    function snippet(value, limit = 60) {
      const flattened = String(value).replace(/\s+/g, ' ').trim()
      return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened
    }

    /**
     * The redacted settings view, repaired to the shape the form expects.
     *
     * @param {unknown} raw - the Host's redacted settings.
     * @returns {object} the normalized view.
     */
    function settingsView(raw) {
      const source = isRecord(raw) ? raw : {}
      const docker = isRecord(source.docker) ? source.docker : {}
      const redis = isRecord(source.redis) ? source.redis : {}
      const postgres = isRecord(source.postgres) ? source.postgres : {}
      const dockerfiles = isRecord(source.dockerfiles) ? source.dockerfiles : {}
      const ssl = ['disable', 'prefer', 'require'].indexOf(postgres.ssl) >= 0 ? postgres.ssl : 'prefer'
      return {
        docker: { binary: textOf(docker.binary, 'docker') },
        redis: {
          mode: redis.mode === 'manual' ? 'manual' : 'docker',
          container: typeof redis.container === 'string' ? redis.container : '',
          host: textOf(redis.host, '127.0.0.1'),
          port: integerOf(redis.port, 6379),
          username: typeof redis.username === 'string' ? redis.username : '',
          db: integerOf(redis.db, 0),
          tls: redis.tls === true,
          hasPassword: redis.hasPassword === true,
        },
        dockerfiles: {
          roots: stringListOf(dockerfiles.roots),
          maxDepth: integerOf(dockerfiles.maxDepth, 6),
        },
        postgres: {
          mode: postgres.mode === 'manual' ? 'manual' : 'docker',
          container: typeof postgres.container === 'string' ? postgres.container : '',
          host: textOf(postgres.host, '127.0.0.1'),
          port: integerOf(postgres.port, 5432),
          user: typeof postgres.user === 'string' ? postgres.user : '',
          database: typeof postgres.database === 'string' ? postgres.database : '',
          ssl,
          hasPassword: postgres.hasPassword === true,
        },
      }
    }

    /**
     * The editable form for a redacted settings view. Passwords start empty:
     * that is how "keep the stored password" is expressed on save.
     *
     * @param {unknown} settings - the redacted settings view.
     * @returns {object} the form state.
     */
    function settingForm(settings) {
      const view = settingsView(settings)
      return {
        docker: { binary: view.docker.binary },
        redis: {
          mode: view.redis.mode,
          container: view.redis.container,
          host: view.redis.host,
          port: String(view.redis.port),
          username: view.redis.username,
          password: '',
          db: String(view.redis.db),
          tls: view.redis.tls,
          clearPassword: false,
        },
        dockerfiles: {
          rootsText: view.dockerfiles.roots.join('\n'),
          maxDepth: String(view.dockerfiles.maxDepth),
        },
        postgres: {
          mode: view.postgres.mode,
          container: view.postgres.container,
          host: view.postgres.host,
          port: String(view.postgres.port),
          user: view.postgres.user,
          password: '',
          database: view.postgres.database,
          ssl: view.postgres.ssl,
          clearPassword: false,
        },
      }
    }

    /**
     * @param {unknown} raw - a redis.info summary.
     * @returns {object} the normalized summary.
     */
    function normalizeRedisSummary(raw) {
      const source = isRecord(raw) ? raw : {}
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
      return {
        version: typeof source.version === 'string' ? source.version : null,
        uptimeSeconds: number(source.uptimeSeconds),
        connectedClients: number(source.connectedClients),
        usedMemoryHuman: typeof source.usedMemoryHuman === 'string' ? source.usedMemoryHuman : null,
        usedMemoryBytes: number(source.usedMemoryBytes),
        totalKeys: number(source.totalKeys) === null ? 0 : number(source.totalKeys),
        opsPerSec: number(source.opsPerSec),
        hitRate: number(source.hitRate),
        role: typeof source.role === 'string' ? source.role : null,
      }
    }

    /**
     * @param {unknown} raw - a redis.scan keys value.
     * @returns {string[]} the key names, ignoring malformed entries.
     */
    function normalizeKeys(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (const entry of raw) {
        if (typeof entry === 'string') out.push(entry)
        else if (isRecord(entry) && typeof entry.key === 'string') out.push(entry.key)
      }
      return out
    }

    /**
     * @param {unknown} value - any value.
     * @returns {string} a JSON rendering that cannot throw.
     */
    function safeJson(value) {
      try {
        return JSON.stringify(value, null, 2)
      } catch {
        return String(value)
      }
    }

    /**
     * The dictionary key for a failure code, so a known code reads as a
     * sentence instead of raw wire text.
     *
     * @param {string} code - the failure code.
     * @returns {string} the dictionary key.
     */
    function errorMessageKey(code) {
      switch (code) {
        case UNREACHABLE: return 'error.unreachable'
        case 'docker_unavailable': return 'error.dockerUnavailable'
        case 'docker_timeout': return 'error.dockerTimeout'
        case 'redis_unreachable': return 'error.redisUnreachable'
        case 'redis_auth_required': return 'error.redisAuth'
        case 'redis_auth_failed': return 'error.redisAuth'
        case 'redis_timeout': return 'error.redisTimeout'
        case 'pg_unreachable': return 'error.pgUnreachable'
        case 'pg_auth_required': return 'error.pgAuth'
        case 'pg_auth_failed': return 'error.pgAuth'
        case 'pg_timeout': return 'error.pgTimeout'
        case 'pg_ssl_failed': return 'error.pgSsl'
        case 'invalid_payload': return 'error.invalidPayload'
        case 'docker_invalid_image':
        case 'docker_invalid_volume':
        case 'docker_invalid_network': return 'error.dockerInvalidTarget'
        default: {
          if (typeof code === 'string') {
            if (code.endsWith('_ambiguous_container')) return 'error.ambiguousContainer'
            if (code.endsWith('_no_running_container')) return 'error.noRunningContainer'
            if (code.endsWith('_no_container')) return 'error.noContainer'
            if (code.endsWith('_container_not_found')) return 'error.containerNotFound'
            if (code.endsWith('_no_published_port')) return 'error.noPublishedPort'
            if (code.endsWith('_docker_unavailable')) return 'error.dockerUnavailable'
          }
          return 'error.refused'
        }
      }
    }

    /** @returns {object} an empty Redis "write data" wizard state. */
    function emptyWizard() {
      return {
        open: false,
        type: 'string',
        key: '',
        field: '',
        value: '',
        member: '',
        ttl: '',
        status: 'idle',
        error: null,
        notice: null,
      }
    }

    /** @returns {object} an empty overview state. */
    function emptyOverview() {
      return { status: 'idle', value: null, error: null, refreshing: false }
    }

    /** @returns {object} an empty resource-inspect modal state. */
    function emptyInspect() {
      return { open: false, kind: '', id: '', name: '', status: 'idle', value: null, error: null }
    }

    /** @returns {object} an empty Redis type editor. */
    function emptyRedisEditor(kind) {
      return {
        kind: typeof kind === 'string' ? kind : '',
        field: '',
        value: '',
        member: '',
        side: 'right',
        status: 'idle',
        error: null,
        notice: null,
      }
    }

    /** @returns {object} an empty key-action state. */
    function emptyKeyAction() {
      return { status: 'idle', notice: null, error: null }
    }

    /** @returns {object} an empty PostgreSQL browse state. */
    function emptyBrowse() {
      return {
        status: 'idle',
        columns: [],
        rows: [],
        page: 0,
        pageSize: 50,
        totalRows: null,
        limitedBy: null,
        error: null,
      }
    }

    /** @returns {object} an empty table-detail state. */
    function emptyTableDetail() {
      return { status: 'idle', value: null, error: null, tab: 'columns' }
    }

    /** @returns {object} an empty logs-drawer state. */
    function emptyLogs(tail) {
      return { id: '', name: '', status: 'idle', tail, text: '', error: null }
    }

    /** @returns {object} an empty details-drawer state. */
    function emptyDetail() {
      return { id: '', name: '', status: 'idle', container: null, error: null }
    }

    /** @returns {object} an empty Redis key-selection state. */
    function emptySelectedKey() {
      return {
        key: '',
        status: 'idle',
        detail: null,
        error: null,
        memory: { status: 'idle', data: null, error: null },
      }
    }

    /** @returns {object} an empty PostgreSQL table-selection state. */
    function emptySelectedTable() {
      return {
        schema: '',
        name: '',
        columns: { status: 'idle', list: [], error: null },
        detail: emptyTableDetail(),
        preview: { status: 'idle', result: null, error: null },
      }
    }

    /**
     * @param {unknown} value - a candidate role.
     * @returns {string} a known role key.
     */
    function roleKeyOf(value) {
      return typeof value === 'string' && ROLE_KEYS.indexOf(value) >= 0 ? value : 'other'
    }

    /**
     * A lightweight role hint for a base image, mirroring the Host's role words
     * so a Dockerfile card can say "nginx:1.31.6（网站服务器）" without a round-trip.
     *
     * @param {string} image - the base image reference.
     * @returns {string} a role key.
     */
    function dockerfileRoleOf(image) {
      const slug = String(image === undefined || image === null ? '' : image)
        .split('@')[0]
        .split('/')
        .pop()
        .toLowerCase()
      if (slug === '') return 'other'
      if (/(^|[:@-])(postgres|postgresql|postgis|mysql|mariadb|mongo|mongodb|clickhouse|sqlite|tidb|cockroach|oracle|mssql)([:@-]|$)/.test(slug)) return 'database'
      if (/(^|[:@-])(redis|redis-stack|keydb|valkey|memcached|dragonfly)([:@-]|$)/.test(slug)) return 'cache'
      if (/(^|[:@-])(rabbitmq|kafka|zookeeper|nats|activemq|pulsar|redpanda)([:@-]|$)/.test(slug)) return 'queue'
      if (/(^|[:@-])(minio|ceph|cephfs|seaweedfs|nfs|glusterfs)([:@-]|$)/.test(slug)) return 'storage'
      if (/(^|[:@-])(prometheus|grafana|jaeger|zipkin|elasticsearch|kibana|logstash|loki|tempo|netdata)([:@-]|$)/.test(slug)) return 'monitoring'
      if (/(^|[:@-])(nginx|httpd|apache|caddy|traefik|envoy|haproxy|lighttpd|tomcat|jetty|ghost|wordpress)([:@-]|$)/.test(slug)) return 'website'
      if (/(^|[:@-])(node|python|golang|java|openjdk|dotnet|php|ruby|rust|spring|gunicorn|uwsgi|deno|bun)([:@-]|$)/.test(slug)) return 'application'
      return 'other'
    }

    /**
     * @param {string} port - an exposed port number.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} a plain meaning for that port.
     */
    function dockerfilePortMeaning(port, t) {
      const known = String(port)
      if (known === '80' || known === '8080' || known === '3000' || known === '5173' || known === '4200' || known === '8000') return t('dockerfile.port.website')
      if (known === '443' || known === '8443') return t('dockerfile.port.secure')
      if (known === '5432' || known === '3306' || known === '27017' || known === '1433') return t('dockerfile.port.database')
      if (known === '6379' || known === '11211') return t('dockerfile.port.cache')
      if (known === '5672' || known === '9092' || known === '4222') return t('dockerfile.port.queue')
      if (known === '9000') return t('dockerfile.port.storage')
      return t('dockerfile.port.application')
    }

    /**
     * @param {object} instruction - a parsed instruction.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} the plain-language explanation for one instruction.
     */
    function dockerfileExplanation(instruction, t) {
      const source = isRecord(instruction) ? instruction : {}
      const hostKey = typeof source.explanationKey === 'string' ? source.explanationKey.toLowerCase() : ''
      const instructionKey = typeof source.instruction === 'string' ? source.instruction.toLowerCase() : ''
      const key = DOCKERFILE_EXPLAIN_KEYS.indexOf(hostKey) >= 0
        ? hostKey
        : DOCKERFILE_EXPLAIN_KEYS.indexOf(instructionKey) >= 0 ? instructionKey : 'other'
      return t(`dockerfile.explain.${key}`)
    }

    /**
     * Shell-quote one build-context argument.
     *
     * @param {string} value - the path.
     * @returns {string} the argument, quoted when it contains spaces.
     */
    function shellArgument(value) {
      const text = String(value === undefined || value === null ? '' : value)
      return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
    }

    /**
     * @param {object} summary - a DockerfileSummary.
     * @returns {string} the `docker build` command for it.
     */
    function dockerfileBuildCommand(summary) {
      const tag = textOf(summary.suggestedTag, 'image:latest')
      const context = textOf(summary.contextPath, textOf(summary.root, '.'))
      return `docker build -t ${shellArgument(tag)} ${shellArgument(context)}`
    }

    /**
     * Repair the `dockerfiles.list` value.
     *
     * @param {unknown} raw - the Host value.
     * @returns {{ dockerfiles: object[], roots: string[], scan: object|null }} the normalized list.
     */
    function normalizeDockerfiles(raw) {
      const source = isRecord(raw) ? raw : {}
      const list = Array.isArray(source.dockerfiles) ? source.dockerfiles.filter(isRecord).map((file) => ({
        path: textOf(file.path, ''),
        name: textOf(file.name, 'Dockerfile'),
        relativePath: textOf(file.relativePath, ''),
        root: textOf(file.root, ''),
        size: integerOf(file.size, 0),
        modifiedAt: textOf(file.modifiedAt, ''),
        detectedBy: file.detectedBy === 'content' ? 'content' : 'name',
        stageCount: integerOf(file.stageCount, 0),
        multiStage: file.multiStage === true,
        baseImages: stringListOf(file.baseImages),
        finalBaseImage: typeof file.finalBaseImage === 'string' ? file.finalBaseImage : null,
        exposedPorts: stringListOf(file.exposedPorts),
        instructionCount: integerOf(file.instructionCount, 0),
        healthcheck: file.healthcheck === true,
        command: typeof file.command === 'string' ? file.command : null,
        entrypoint: typeof file.entrypoint === 'string' ? file.entrypoint : null,
        cmd: typeof file.cmd === 'string' ? file.cmd : null,
        envKeys: stringListOf(file.envKeys),
        volumes: stringListOf(file.volumes),
        contextPath: textOf(file.contextPath, ''),
        suggestedTag: textOf(file.suggestedTag, ''),
      })) : []
      const scanSource = isRecord(source.scan) ? source.scan : null
      return {
        dockerfiles: list,
        roots: stringListOf(source.roots),
        scan: scanSource === null ? null : {
          visitedFiles: integerOf(scanSource.visitedFiles, 0),
          truncated: scanSource.truncated === true,
          errors: Array.isArray(scanSource.errors) ? scanSource.errors.filter(isRecord).map((error) => ({
            root: textOf(error.root, ''),
            message: textOf(error.message, ''),
          })) : [],
          generatedAt: textOf(scanSource.generatedAt, ''),
        },
      }
    }

    /**
     * Repair the `dockerfiles.read` value.
     *
     * @param {unknown} raw - the Host value.
     * @returns {object|null} the normalized detail, or null when unusable.
     */
    function normalizeDockerfileDetail(raw) {
      if (!isRecord(raw)) return null
      const parsed = isRecord(raw.parsed) ? raw.parsed : {}
      const instructions = Array.isArray(parsed.instructions) ? parsed.instructions.filter(isRecord).map((entry) => ({
        instruction: textOf(entry.instruction, ''),
        args: textOf(entry.args, ''),
        line: integerOf(entry.line, 1),
        explanationKey: textOf(entry.explanationKey, ''),
      })) : []
      const stages = Array.isArray(parsed.stages) ? parsed.stages.filter(isRecord).map((stage) => ({
        index: integerOf(stage.index, 0),
        baseImage: typeof stage.baseImage === 'string' ? stage.baseImage : null,
        name: typeof stage.name === 'string' ? stage.name : null,
        instructions: integerOf(stage.instructions, 0),
      })) : []
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(isRecord).map((warning) => ({
        line: integerOf(warning.line, 0),
        message: textOf(warning.message, ''),
      })) : []
      return {
        path: textOf(raw.path, ''),
        name: textOf(raw.name, 'Dockerfile'),
        relativePath: textOf(raw.relativePath, ''),
        root: textOf(raw.root, ''),
        size: integerOf(raw.size, 0),
        modifiedAt: textOf(raw.modifiedAt, ''),
        content: typeof raw.content === 'string' ? raw.content : '',
        truncated: raw.truncated === true,
        parsed: {
          instructions,
          stages,
          warnings,
          instructionCount: integerOf(parsed.instructionCount, instructions.length),
          stageCount: integerOf(parsed.stageCount, stages.length),
          multiStage: parsed.multiStage === true,
          baseImages: stringListOf(parsed.baseImages),
          finalBaseImage: typeof parsed.finalBaseImage === 'string' ? parsed.finalBaseImage : null,
          exposedPorts: stringListOf(parsed.exposedPorts),
          command: typeof parsed.command === 'string' ? parsed.command : null,
          healthcheck: parsed.healthcheck === true,
          envKeys: stringListOf(parsed.envKeys),
          volumes: stringListOf(parsed.volumes),
        },
      }
    }

    /**
     * @param {string} state - a container state.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} a plain-language state label.
     */
    function plainStateLabel(state, t) {
      const known = ['running', 'exited', 'paused', 'restarting', 'created', 'dead']
      return known.indexOf(state) >= 0 ? t(`plain.state.${state}`) : t('plain.state.other')
    }

    /**
     * @param {string} type - a Redis type.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} a plain-language type name.
     */
    function plainRedisType(type, t) {
      const known = ['string', 'list', 'set', 'zset', 'hash', 'stream']
      return known.indexOf(type) >= 0 ? t(`plain.redisType.${type}`) : type
    }

    /**
     * @param {number|string} ttl - the TTL Redis reported.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} "never expires" / "N minutes left" / "missing".
     */
    function plainTtl(ttl, t) {
      if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return t('plain.ttl.missing')
      if (ttl === -1) return t('plain.ttl.never')
      if (ttl < -1) return t('plain.ttl.missing')
      if (ttl >= 60) return t('plain.ttl.minutes', { minutes: Math.ceil(ttl / 60) })
      return t('plain.ttl.seconds', { seconds: ttl })
    }

    /**
     * Map a machine failure code to the plain-language sentence and its hint.
     *
     * @param {string} code - the failure code.
     * @returns {{ message: string, hint: string }} dictionary keys.
     */
    function friendlyErrorKeys(code) {
      const value = typeof code === 'string' ? code : ''
      let group = 'generic'
      if (value === UNREACHABLE) group = 'unreachable'
      else if (value === 'docker_unavailable') group = 'dockerUnavailable'
      else if (/_auth(_|$)|auth_required|auth_failed/.test(value)) group = 'auth'
      else if (value.endsWith('_timeout') || value === 'timeout') group = 'timeout'
      else if (/_ambiguous_container$/.test(value)) group = 'ambiguous'
      else if (/_no_container$|_container_not_found$|_no_running_container$/.test(value)) group = 'noContainer'
      else if (/_no_published_port$/.test(value)) group = 'noPort'
      else if (value === 'invalid_payload') group = 'invalid'
      return { message: `plain.error.${group}`, hint: `plain.error.hint.${group}` }
    }

    /**
     * @param {string} code - an insight code.
     * @param {object} params - the insight params.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} the plain sentence.
     */
    function insightSentence(code, params, t) {
      const knownCodes = [
        'docker_unavailable', 'no_containers', 'stopped_containers', 'restarting_containers',
        'unused_volumes', 'dangling_images', 'disk_reclaimable',
        'redis_ok', 'redis_ambiguous', 'redis_no_container', 'redis_no_running', 'redis_unreachable',
        'postgres_ok', 'postgres_ambiguous', 'postgres_no_container', 'postgres_no_running', 'postgres_unreachable',
        'dockerfiles_found',
      ]
      if (knownCodes.indexOf(code) < 0) {
        return t('insight.unknown', { code: String(code === undefined || code === null ? '' : code) })
      }
      const source = isRecord(params) ? params : {}
      const names = Array.isArray(source.names)
        ? source.names.filter((name) => typeof name === 'string').join('、')
        : ''
      const merged = Object.assign({}, source, { names, human: textOf(source.human, '0 B') })
      return t(`insight.${code}`, merged)
    }

    /**
     * @param {string} code - an insight code.
     * @returns {string} the tab/settings action target, or '' when unknown.
     */
    function insightActionTarget(code) {
      if (typeof code !== 'string') return ''
      if (code === 'docker_unavailable') return 'settings'
      if (code.indexOf('redis_') === 0) return code === 'redis_ambiguous' ? 'redis' : 'redis'
      if (code.indexOf('postgres_') === 0) return code === 'postgres_ambiguous' ? 'postgres' : 'postgres'
      if (code === 'unused_volumes') return 'relations'
      if (code === 'no_containers' || code === 'stopped_containers' || code === 'restarting_containers') return 'docker'
      if (code === 'dangling_images' || code === 'disk_reclaimable') return 'docker'
      if (code === 'dockerfiles_found') return 'dockerfiles'
      return ''
    }

    /**
     * Normalize the `overview` endpoint value.
     *
     * @param {unknown} raw - the Host value.
     * @returns {object|null} the normalized overview, or null when unusable.
     */
    function normalizeOverview(raw) {
      if (!isRecord(raw)) return null
      const counts = isRecord(raw.counts) ? raw.counts : {}
      const docker = isRecord(raw.docker) ? raw.docker : {}
      const count = (value) => integerOf(value, 0)
      const service = (source) => {
        const value = isRecord(source) ? source : {}
        const error = isRecord(value.error)
          ? { code: textOf(value.error.code, ''), message: textOf(value.error.message, '') }
          : null
        return {
          mode: value.mode === 'manual' ? 'manual' : 'docker',
          container: typeof value.container === 'string' ? value.container : null,
          reachable: value.reachable === true,
          version: typeof value.version === 'string' ? value.version : null,
          instances: count(value.instances),
          ambiguous: value.ambiguous === true,
          summary: isRecord(value.summary) ? value.summary : {},
          error,
        }
      }
      const containers = Array.isArray(raw.containers)
        ? raw.containers.filter(isRecord).map((container) => ({
            name: textOf(container.name, ''),
            state: textOf(container.state, ''),
            image: textOf(container.image, ''),
            role: roleKeyOf(container.role),
            project: typeof container.project === 'string' ? container.project : null,
            service: typeof container.service === 'string' ? container.service : null,
            restartPolicy: typeof container.restartPolicy === 'string' ? container.restartPolicy : null,
            ports: Array.isArray(container.ports) ? container.ports.filter(isRecord).map((port) => ({
              host: typeof port.host === 'string' ? port.host : null,
              container: textOf(port.container, ''),
              protocol: textOf(port.protocol, 'tcp'),
            })) : [],
            volumes: count(container.volumes),
            bindMounts: count(container.bindMounts),
            networks: count(container.networks),
          }))
        : []
      const projects = Array.isArray(raw.projects)
        ? raw.projects.filter(isRecord).map((project) => ({
            name: textOf(project.name, ''),
            containers: count(project.containers),
            running: count(project.running),
          }))
        : []
      const insights = Array.isArray(raw.insights)
        ? raw.insights.filter(isRecord).map((insight) => ({
            code: textOf(insight.code, ''),
            level: ['good', 'info', 'warn', 'danger'].indexOf(insight.level) >= 0 ? insight.level : 'info',
            params: isRecord(insight.params) ? insight.params : {},
          }))
        : []
      const servicesSource = isRecord(raw.services) ? raw.services : {}
      const dockerfiles = isRecord(raw.dockerfiles)
        ? { count: count(raw.dockerfiles.count), generatedAt: textOf(raw.dockerfiles.generatedAt, '') }
        : null
      return {
        generatedAt: textOf(raw.generatedAt, ''),
        dockerfiles,
        docker: {
          available: docker.available === true,
          version: typeof docker.version === 'string' ? docker.version : null,
          error: typeof docker.error === 'string' ? docker.error : null,
        },
        counts: {
          containers: count(counts.containers),
          running: count(counts.running),
          stopped: count(counts.stopped),
          images: count(counts.images),
          volumes: count(counts.volumes),
          networks: count(counts.networks),
          danglingImages: count(counts.danglingImages),
          unusedVolumes: count(counts.unusedVolumes),
        },
        disk: isRecord(raw.disk) ? raw.disk : null,
        containers,
        projects,
        services: { redis: service(servicesSource.redis), postgres: service(servicesSource.postgres) },
        insights,
      }
    }

    /**
     * @param {unknown} container - a Docker container row.
     * @returns {Record<string, string>} its labels, parsed from an object or the
     *   `docker ps` "k=v,k2=v2" string.
     */
    function labelsRecordOf(container) {
      const labels = isRecord(container) ? container.labels : null
      if (isRecord(labels)) {
        const out = {}
        for (const [key, value] of Object.entries(labels)) out[key] = String(value)
        return out
      }
      if (typeof labels === 'string' && labels !== '' && labels !== 'N/A') {
        const out = {}
        for (const entry of labels.split(',')) {
          const index = entry.indexOf('=')
          if (index > 0) out[entry.slice(0, index).trim()] = entry.slice(index + 1)
        }
        return out
      }
      return {}
    }

    /**
     * @param {unknown} container - a Docker container row.
     * @returns {string|null} its compose project name.
     */
    function composeProjectOf(container) {
      const project = labelsRecordOf(container)['com.docker.compose.project']
      return typeof project === 'string' && project !== '' ? project : null
    }

    /**
     * The semantic role of one container, from the overview or relations cache.
     *
     * @param {object} snapshot - the panel snapshot.
     * @param {string} name - the container name.
     * @returns {string} a role key ('' when unknown).
     */
    function roleForContainer(snapshot, name) {
      const overview = snapshot.overview.value
      if (overview !== null) {
        const row = overview.containers.find((container) => container.name === name)
        if (row !== undefined) return row.role
      }
      const relations = snapshot.relations.value
      if (relations !== null) {
        const row = relations.containers.find((container) => container.name === name)
        if (row !== undefined) return roleKeyOf(row.role)
      }
      return ''
    }

    /**
     * @param {string} kind - a confirmation kind (`container.stop`, ...).
     * @param {string} role - the container role.
     * @returns {string} the impact-sentence dictionary key.
     */
    function impactKeyFor(kind, role) {
      const value = typeof kind === 'string' ? kind : ''
      const known = roleKeyOf(role)
      if (value === 'container.stop') {
        return ['website', 'database', 'cache', 'queue'].indexOf(known) >= 0
          ? `confirm.impact.stop.${known}`
          : 'confirm.impact.stop.other'
      }
      if (value === 'container.restart') {
        return known === 'website' ? 'confirm.impact.restart.website' : 'confirm.impact.restart.other'
      }
      if (value === 'container.pause') {
        return known === 'website' ? 'confirm.impact.pause.website' : 'confirm.impact.pause.other'
      }
      if (value === 'container.remove') return 'confirm.impact.container.remove'
      if (value === 'image.remove') return 'confirm.impact.image.remove'
      if (value === 'volume.remove') return 'confirm.impact.volume.remove'
      if (value === 'network.remove') return 'confirm.impact.network.remove'
      if (value === 'redis.delete') return 'confirm.impact.redis.delete'
      if (value === 'redis.rename') return 'confirm.impact.redis.rename'
      if (value === 'redis.expire') return 'confirm.impact.redis.expire'
      return ''
    }

    /**
     * @param {string} schema - the schema.
     * @param {string} table - the table.
     * @param {string} kind - preview | count | columns.
     * @returns {string} an SQL statement for the quick-query templates.
     */
    function templateSql(schema, table, kind) {
      const relation = `${quoteIdent(schema === '' ? 'public' : schema)}.${quoteIdent(table)}`
      if (kind === 'count') return `select count(*) as row_count from ${relation}`
      if (kind === 'columns') {
        const literal = (value) => `'${String(value).replace(/'/g, "''")}'`
        return `select column_name, data_type, is_nullable\nfrom information_schema.columns\nwhere table_schema = ${literal(schema === '' ? 'public' : schema)}\n  and table_name = ${literal(table)}\norder by ordinal_position`
      }
      return `select * from ${relation} limit 10`
    }

    /**
     * Copy text to the clipboard without ever throwing.
     *
     * @param {string} text - the text to copy.
     * @returns {boolean} whether the clipboard API accepted it.
     */
    function copyTextToClipboard(text) {
      try {
        if (typeof navigator === 'undefined' || navigator === null) return false
        const clipboard = navigator.clipboard
        if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') return false
        const result = clipboard.writeText(String(text))
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(() => undefined, () => undefined)
        }
        return true
      } catch {
        return false
      }
    }

    /**
     * @returns {'beginner'|'expert'} the stored display mode.
     */
    function readStoredViewMode() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return 'beginner'
        return localStorage.getItem(VIEW_MODE_KEY) === 'expert' ? 'expert' : 'beginner'
      } catch {
        return 'beginner'
      }
    }

    /**
     * @param {string} mode - beginner | expert.
     * @returns {void}
     */
    function storeViewMode(mode) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(VIEW_MODE_KEY, mode === 'expert' ? 'expert' : 'beginner')
      } catch {
        // A blocked storage must never take the panel down.
      }
    }

    /**
     * @param {unknown} raw - a candidate string list.
     * @returns {string[]} only the strings.
     */
    function stringListOf(raw) {
      return Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string') : []
    }

    /** @returns {object} an empty relations state. */
    function emptyRelations() {
      return { status: 'idle', value: null, error: null, refreshing: false, kind: 'all', id: '' }
    }

    /**
     * Repair a `docker.relations` payload.
     *
     * @param {unknown} raw - the Host value.
     * @returns {object} the normalized graph.
     */
    function normalizeRelations(raw) {
      const source = isRecord(raw) ? raw : {}
      const summary = isRecord(source.summary) ? source.summary : {}
      return {
        summary: {
          containers: integerOf(summary.containers, 0),
          running: integerOf(summary.running, 0),
          images: integerOf(summary.images, 0),
          volumes: integerOf(summary.volumes, 0),
          networks: integerOf(summary.networks, 0),
          danglingImages: integerOf(summary.danglingImages, 0),
          unusedVolumes: integerOf(summary.unusedVolumes, 0),
        },
        containers: Array.isArray(source.containers)
          ? source.containers.filter(isRecord).map((container) => ({
              id: textOf(container.id, ''),
              name: textOf(container.name, textOf(container.id, '')),
              state: textOf(container.state, ''),
              image: textOf(container.image, ''),
              imageId: typeof container.imageId === 'string' ? container.imageId : null,
              createdAt: textOf(container.createdAt, ''),
              ports: Array.isArray(container.ports)
                ? container.ports.filter(isRecord).map((port) => ({
                    host: textOf(port.host, ''),
                    container: textOf(port.container, ''),
                    protocol: textOf(port.protocol, 'tcp'),
                    ip: textOf(port.ip, ''),
                  }))
                : [],
              volumes: Array.isArray(container.volumes)
                ? container.volumes.filter(isRecord).map((volume) => ({
                    type: textOf(volume.type, 'volume'),
                    name: typeof volume.name === 'string' && volume.name !== '' ? volume.name : null,
                    source: textOf(volume.source, ''),
                    destination: textOf(volume.destination, ''),
                    mode: textOf(volume.mode, ''),
                    rw: volume.rw === true,
                  }))
                : [],
              networks: Array.isArray(container.networks)
                ? container.networks.filter(isRecord).map((network) => ({
                    name: textOf(network.name, ''),
                    ipAddress: typeof network.ipAddress === 'string' ? network.ipAddress : null,
                  }))
                : [],
            }))
          : [],
        images: Array.isArray(source.images)
          ? source.images.filter(isRecord).map((image) => ({
              id: textOf(image.id, ''),
              shortId: textOf(image.shortId, ''),
              repoTags: stringListOf(image.repoTags),
              size: textOf(image.size, ''),
              sizeBytes: integerOf(image.sizeBytes, 0),
              containers: stringListOf(image.containers),
            }))
          : [],
        volumes: Array.isArray(source.volumes)
          ? source.volumes.filter(isRecord).map((volume) => ({
              name: textOf(volume.name, ''),
              driver: textOf(volume.driver, ''),
              scope: textOf(volume.scope, ''),
              mountpoint: typeof volume.mountpoint === 'string' ? volume.mountpoint : null,
              anonymous: volume.anonymous === true,
              containers: stringListOf(volume.containers),
            }))
          : [],
        networks: Array.isArray(source.networks)
          ? source.networks.filter(isRecord).map((network) => ({
              id: textOf(network.id, ''),
              name: textOf(network.name, ''),
              driver: textOf(network.driver, ''),
              scope: textOf(network.scope, ''),
              internal: network.internal === true,
              containers: stringListOf(network.containers),
            }))
          : [],
      }
    }

    /**
     * @param {object} image - a relations image.
     * @returns {string} its best display label.
     */
    function imageLabelOf(image) {
      const tags = Array.isArray(image.repoTags) ? image.repoTags.filter((tag) => tag !== '') : []
      return tags.length > 0 ? tags[0] : textOf(image.shortId, textOf(image.id, ''))
    }

    /**
     * @param {string} text - a label.
     * @param {number} max - maximum characters.
     * @returns {string} the label, shortened with an ellipsis.
     */
    function truncateLabel(text, max) {
      const value = String(text === undefined || text === null ? '' : text)
      return value.length > max ? `${value.slice(0, max - 1)}…` : value
    }

    /**
     * Find the image row a container belongs to.
     *
     * @param {object} relations - the normalized graph.
     * @param {object} container - one relations container.
     * @returns {object|null} the matching image row.
     */
    function relationImageOf(relations, container) {
      const id = container.imageId
      if (typeof id === 'string' && id !== '') {
        const byId = relations.images.find((image) => image.id === id)
        if (byId !== undefined) return byId
      }
      const byTag = relations.images.find((image) => image.repoTags.indexOf(container.image) >= 0)
      return byTag === undefined ? null : byTag
    }

    /**
     * Containers associated with one resource (reverse lookup).
     *
     * @param {object} relations - the normalized graph.
     * @param {string} kind - all | images | volumes | networks.
     * @param {string} id - the resource id or name.
     * @returns {object[]} the matching containers.
     */
    function relationContainers(relations, kind, id) {
      if (kind === 'all' || id === '') return relations.containers
      if (kind === 'images') {
        const image = relations.images.find((entry) => entry.id === id || entry.shortId === id)
        if (image === undefined) return []
        return relations.containers.filter((container) => {
          const own = relationImageOf(relations, container)
          return (own !== null && (own.id === image.id || own.shortId === image.shortId)) ||
            image.containers.indexOf(container.name) >= 0
        })
      }
      if (kind === 'volumes') {
        const volume = relations.volumes.find((entry) => entry.name === id)
        return relations.containers.filter((container) => {
          if (container.volumes.some((mount) => mount.type === 'volume' && mount.name === id)) return true
          return volume !== undefined && volume.containers.indexOf(container.name) >= 0
        })
      }
      if (kind === 'networks') {
        const network = relations.networks.find((entry) => entry.id === id || entry.name === id)
        return relations.containers.filter((container) => {
          if (container.networks.some((entry) => entry.name === id)) return true
          return network !== undefined && network.containers.indexOf(container.name) >= 0
        })
      }
      return []
    }

    /**
     * Pick the tabular result out of a `pg.query` value or a `pg.browse` value.
     *
     * @param {unknown} payload - a query result, a browse result, or a raw result set.
     * @returns {{ columns: object[], rows: unknown[][] }} the grid.
     */
    function resultGridOf(payload) {
      if (!isRecord(payload)) return { columns: [], rows: [] }
      if (Array.isArray(payload.results)) {
        const first = payload.results.find(isRecord)
        if (first === undefined) return { columns: [], rows: [] }
        return {
          columns: Array.isArray(first.columns) ? first.columns.filter(isRecord) : [],
          rows: Array.isArray(first.rows) ? first.rows : [],
        }
      }
      return {
        columns: Array.isArray(payload.columns) ? payload.columns.filter(isRecord) : [],
        rows: Array.isArray(payload.rows) ? payload.rows : [],
      }
    }

    /**
     * @param {string} value - one CSV cell.
     * @returns {string} quoted when needed.
     */
    function csvCell(value) {
      if (value === null || value === undefined) return ''
      const text = String(value)
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }

    /**
     * Render a result grid as CSV.
     *
     * @param {unknown} payload - a query, browse or result-set value.
     * @returns {string} the CSV document, empty when there is no tabular data.
     */
    function resultCsv(payload) {
      const grid = resultGridOf(payload)
      if (grid.columns.length === 0) return ''
      const lines = [grid.columns.map((column) => csvCell(textOf(column.name, ''))).join(',')]
      for (const row of grid.rows) {
        const cells = Array.isArray(row) ? row : [row]
        lines.push(grid.columns.map((column, index) => csvCell(cells[index])).join(','))
      }
      return `${lines.join('\n')}\n`
    }

    /**
     * @param {object|null} resolved - a resolved target.
     * @returns {string} the endpoint line shown in the settings view.
     */
    /** @returns {object} an empty resolved-target state for one service. */
    function emptyTarget() {
      return { candidates: [], instances: [], resolved: null, error: null }
    }

    /**
     * Repair one `state.targets.<service>` view.
     *
     * @param {unknown} raw - the Host's target view.
     * @returns {object} the normalized view.
     */
    function normalizeTarget(raw) {
      const source = isRecord(raw) ? raw : {}
      const candidate = (entry) => ({
        name: textOf(entry.name, ''),
        image: textOf(entry.image, ''),
        state: textOf(entry.state, ''),
        running: entry.running === true,
        containerPort: textOf(entry.containerPort, ''),
        hostPort: typeof entry.hostPort === 'number' ? entry.hostPort : null,
        hasPassword: entry.hasPassword === true,
        credentialsSource: entry.credentialsSource === 'container-env' ? 'container-env' : 'none',
      })
      const candidates = Array.isArray(source.candidates)
        ? source.candidates.filter(isRecord).map(candidate)
        : []
      // Running instances first, then by name, so the settings picker is stable.
      candidates.sort((left, right) => {
        if (left.running !== right.running) return left.running ? -1 : 1
        return left.name.localeCompare(right.name)
      })
      const instances = Array.isArray(source.instances)
        ? source.instances.filter(isRecord).map((entry) => ({
            container: textOf(entry.container, ''),
            image: textOf(entry.image, ''),
            state: textOf(entry.state, ''),
            host: textOf(entry.host, ''),
            port: typeof entry.port === 'number' ? entry.port : null,
            containerPort: textOf(entry.containerPort, ''),
            hasPublishedPort: entry.hasPublishedPort === true,
            hasPassword: entry.hasPassword === true,
            credentialsSource: typeof entry.credentialsSource === 'string' ? entry.credentialsSource : 'none',
          }))
        : []
      const resolved = isRecord(source.resolved)
        ? {
            mode: source.resolved.mode === 'manual' ? 'manual' : 'docker',
            container: typeof source.resolved.container === 'string' ? source.resolved.container : null,
            host: textOf(source.resolved.host, ''),
            port: integerOf(source.resolved.port, 0),
            credentialsSource: typeof source.resolved.credentialsSource === 'string' ? source.resolved.credentialsSource : 'none',
          }
        : null
      const error = isRecord(source.error)
        ? {
            code: textOf(source.error.code, ''),
            message: textOf(source.error.message, ''),
            details: isRecord(source.error.details) ? source.error.details : {},
          }
        : null
      return { candidates, instances, resolved, error }
    }

    /**
     * @param {unknown} raw - the `state.targets` view.
     * @returns {{ redis: object, postgres: object }} both normalized service views.
     */
    function normalizeTargets(raw) {
      const source = isRecord(raw) ? raw : {}
      return {
        redis: source.redis === undefined ? emptyTarget() : normalizeTarget(source.redis),
        postgres: source.postgres === undefined ? emptyTarget() : normalizeTarget(source.postgres),
      }
    }

    /**
     * The dictionary key for a target-resolution failure, chosen by the
     * service-scoped suffix the Host uses (`redis_no_container`, …).
     *
     * @param {string} code - the failure code.
     * @returns {string|null} the dictionary key, or null when unknown.
     */
    function targetErrorKey(code) {
      if (typeof code !== 'string') return null
      if (code.endsWith('_ambiguous_container')) return 'settings.target.ambiguous'
      if (code.endsWith('_no_running_container')) return 'settings.target.noRunning'
      if (code.endsWith('_no_container')) return 'settings.target.noContainer'
      if (code.endsWith('_container_not_found')) return 'settings.target.notFound'
      if (code.endsWith('_no_published_port')) return 'settings.target.noPort'
      if (code.endsWith('_docker_unavailable')) return 'settings.target.dockerUnavailable'
      return null
    }

    /**
     * How many target-resolution failures are "no instance to use" warnings
     * (as opposed to a broken Docker daemon).
     *
     * @param {string} code - the failure code.
     * @returns {boolean} whether the code is an instance-selection problem.
     */
    function isInstanceError(code) {
      return typeof code === 'string' && /_(ambiguous_container|no_running_container|no_container)$/.test(code)
    }

    /**
     * @param {object} error - a `state.targets.<service>.error`.
     * @returns {number} how many containers the error mentions, when known.
     */
    function targetErrorCount(error) {
      if (!isRecord(error)) return 0
      const candidates = isRecord(error.details) && Array.isArray(error.details.candidates)
        ? error.details.candidates.filter(isRecord)
        : []
      return candidates.length
    }

    /**
     * @param {string} source - the Host's `credentialsSource` value.
     * @returns {string} the dictionary key describing it.
     */
    function credentialsSourceKey(source) {
      if (source === 'settings') return 'settings.target.credentials.settings'
      if (source === 'container-env') return 'settings.target.credentials.container-env'
      return 'settings.target.credentials.none'
    }

    /**
     * @param {object|null} resolved - a resolved target.
     * @returns {string} the full endpoint line shown in the settings view.
     */
    function targetEndpoint(resolved) {
      if (resolved === null || resolved === undefined) return ''
      const address = `${resolved.host}:${resolved.port}`
      if (resolved.mode !== 'docker') return address
      const container = typeof resolved.container === 'string' ? resolved.container : ''
      return container === '' ? address : `${container} · ${address}`
    }

    /**
     * @param {object|null} resolved - a resolved target.
     * @returns {string} the short target label a header chip can afford: the
     *   container name in Docker mode, the address in manual mode.
     */
    function targetLabel(resolved) {
      if (resolved === null || resolved === undefined) return ''
      const address = `${resolved.host}:${resolved.port}`
      if (resolved.mode !== 'docker') return address
      const container = typeof resolved.container === 'string' ? resolved.container : ''
      return container === '' ? address : container
    }

    /**
     * The panel's data layer: one authoritative snapshot and one serialized
     * POST pipeline.
     *
     * Every read and write goes through {@link post}, whose promise chain is
     * serialized so two actions can never land out of order (a stop followed by
     * a start must not arrive reversed). Each section keeps its own in-flight
     * guard, so a poll landing while a manual refresh is running joins the
     * running request instead of stacking another one. Nothing here throws to
     * the caller: failures are classified and stored in the snapshot for the
     * view to present, which keeps the panel mounted and lets the retry button
     * simply call the same method again.
     *
     * @returns {object} the client.
     */
    function createDataClient() {
      /** @type {Set<() => void>} */
      const listeners = new Set()
      let snapshot = {
        boot: 'loading',
        refreshing: false,
        error: null,
        version: '',
        settings: null,
        form: settingForm(null),
        formDirty: false,
        formDockerfilesDirty: false,
        saving: false,
        saveError: null,
        saveNotice: false,
        test: { service: '', status: 'idle', message: '', error: null },
        connections: {
          docker: { status: 'unknown', detail: '' },
          redis: { status: 'unknown', detail: '' },
          postgres: { status: 'unknown', detail: '' },
        },
        dockerInfo: null,
        targets: normalizeTargets(null),
        relations: emptyRelations(),
        overview: emptyOverview(),
        viewMode: readStoredViewMode(),
        helpOpen: false,
        copied: { key: '', at: 0 },
        instanceSaving: '',
        instanceError: null,
        confirm: null,
        tab: 'overview',
        lastTab: 'overview',
        docker: {
          status: 'idle',
          subTab: 'containers',
          containers: [],
          error: null,
          actionError: null,
          refreshing: false,
          filter: '',
          busy: '',
          logs: emptyLogs(DEFAULT_LOG_TAIL),
          detail: emptyDetail(),
          stateFilter: 'all',
          dockerfiles: { status: 'idle', list: [], roots: [], scan: null, error: null, refreshing: false },
          dockerfileView: { open: false, path: '', status: 'idle', value: null, error: null },
          imageFilter: '',
          volumeFilter: '',
          networkFilter: '',
          statsById: {},
          statsError: null,
          inspect: emptyInspect(),
          disk: { status: 'idle', usage: null, error: null, refreshing: false },
          images: { status: 'idle', list: [], error: null, actionError: null, removing: '', refreshing: false },
          volumes: { status: 'idle', list: [], error: null, actionError: null, removing: '', refreshing: false },
          networks: { status: 'idle', list: [], error: null, actionError: null, removing: '', refreshing: false },
        },
        redis: {
          status: 'idle',
          summary: null,
          error: null,
          refreshing: false,
          dbsize: { status: 'idle', keys: null, error: null },
          clients: { status: 'idle', list: [], error: null, refreshing: false },
          editor: emptyRedisEditor(''),
          renameDraft: '',
          expireDraft: '',
          action: emptyKeyAction(),
          scan: {
            match: '*',
            type: '',
            cursor: '0',
            keys: [],
            done: false,
            loaded: false,
            loading: false,
            error: null,
            scanned: 0,
          },
          selected: emptySelectedKey(),
          deleting: false,
          deleteError: null,
          setForm: { key: '', value: '', ttl: '' },
          setting: false,
          setError: null,
          setNotice: null,
          wizard: emptyWizard(),
        },
        postgres: {
          status: 'idle',
          error: null,
          refreshing: false,
          version: { status: 'idle', value: null, error: null },
          databases: [],
          databasesError: null,
          database: '',
          tables: { status: 'idle', list: [], error: null },
          filter: '',
          selected: emptySelectedTable(),
          browse: emptyBrowse(),
          activity: { status: 'idle', list: [], error: null, refreshing: false },
          sql: '',
          query: { status: 'idle', result: null, error: null },
          queryHistory: [],
        },
      }
      /** Serializes posts so two fast actions cannot land out of order. */
      let chain = Promise.resolve()
      let bootRequest = null
      let dockerRequest = null
      let logsRequest = null
      let detailRequest = null
      let redisInfoRequest = null
      let scanRequest = null
      let keyRequest = null
      let postgresRequest = null
      let pgTablesRequest = null
      let columnsRequest = null
      let previewRequest = null
      let queryRequest = null
      let diskRequest = null
      let dockerfilesRequest = null
      let dockerfileReadRequest = null
      let relationsRequest = null
      let overviewRequest = null
      let copyTimer = null
      let inspectRequest = null
      let dbsizeRequest = null
      let clientsRequest = null
      let memoryRequest = null
      let activityRequest = null
      let tableDetailRequest = null
      let browseRequest = null
      /** @type {{ images: Promise<any>|null, volumes: Promise<any>|null, networks: Promise<any>|null }} */
      const resourceRequests = { images: null, volumes: null, networks: null }

      /** @param {object} patch - snapshot fields to replace. @returns {void} */
      function publish(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.warn(`[${NS}] a panel subscriber threw:`, error)
          }
        }
      }

      /**
       * @param {string} name - top-level snapshot section.
       * @param {object} part - fields to merge into it.
       * @returns {void}
       */
      function patchSection(name, part) {
        publish({ [name]: Object.assign({}, snapshot[name], part) })
      }

      /** @param {object} part - docker fields. @returns {void} */
      function patchDocker(part) {
        patchSection('docker', part)
      }

      /** @param {object} part - redis fields. @returns {void} */
      function patchRedis(part) {
        patchSection('redis', part)
      }

      /** @param {object} part - postgres fields. @returns {void} */
      function patchPostgres(part) {
        patchSection('postgres', part)
      }

      /** @param {object} part - redis.scan fields. @returns {void} */
      function patchScan(part) {
        patchRedis({ scan: Object.assign({}, snapshot.redis.scan, part) })
      }

      /** @param {object} part - postgres.tables fields. @returns {void} */
      function patchTables(part) {
        patchPostgres({ tables: Object.assign({}, snapshot.postgres.tables, part) })
      }

      /**
       * @param {string} section - postgres.selected sub-section name.
       * @param {object} part - fields to merge.
       * @returns {void}
       */
      function patchSelected(section, part) {
        patchPostgres({
          selected: Object.assign({}, snapshot.postgres.selected, {
            [section]: Object.assign({}, snapshot.postgres.selected[section], part),
          }),
        })
      }

      /**
       * @param {string} service - docker | redis | postgres.
       * @param {object} part - status/detail fields.
       * @returns {void}
       */
      function setConnection(service, part) {
        publish({
          connections: Object.assign({}, snapshot.connections, {
            [service]: Object.assign({}, snapshot.connections[service], part),
          }),
        })
      }

      /**
       * A failure that means the Host could not be reached at all: no fetch, a
       * refused connection, a non-2xx status, or a body that is not the
       * envelope.
       *
       * @param {string} message - what went wrong on the wire.
       * @param {object} [details] - transport context.
       * @returns {Error} the classified failure.
       */
      function unreachable(message, details) {
        const error = new Error(message)
        error.code = UNREACHABLE
        error.details = details === undefined ? {} : details
        return error
      }

      /**
       * A failure that means the Host answered and refused the request.
       *
       * @param {unknown} reason - the envelope's `error` member.
       * @returns {Error} the classified failure.
       */
      function refused(reason) {
        const source = isRecord(reason) ? reason : {}
        const error = new Error(typeof source.message === 'string' && source.message !== ''
          ? source.message
          : 'the Host refused the request')
        error.code = typeof source.code === 'string' ? source.code : 'data_failed'
        error.details = isRecord(source.details) ? source.details : {}
        return error
      }

      /**
       * Reduce a thrown value to the snapshot's error shape.
       *
       * @param {unknown} error - the thrown value.
       * @returns {{ code: string, message: string, details: object }} the failure.
       */
      function describeFailure(error) {
        return {
          code: isRecord(error) && typeof error.code === 'string' ? error.code : UNREACHABLE,
          message: error instanceof Error ? error.message : String(error),
          details: isRecord(error) && isRecord(error.details) ? error.details : {},
        }
      }

      /**
       * The raw transport, with no queueing: send one endpoint, unwrap the
       * envelope, or throw a classified failure.
       *
       * @param {string} endpoint - the operation name.
       * @param {unknown} payload - its arguments.
       * @returns {Promise<any>} the operation value.
       */
      async function transport(endpoint, payload) {
        const doFetch = globalThis.fetch
        if (typeof doFetch !== 'function') throw unreachable('this page cannot reach the host')
        let response
        try {
          response = await doFetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload: payload === undefined ? {} : payload }),
            credentials: 'same-origin',
          })
        } catch (error) {
          throw unreachable(error instanceof Error ? error.message : String(error))
        }
        if (!response.ok) {
          throw unreachable(response.status === 404
            ? 'the Host half is not published on this page (HTTP 404)'
            : `HTTP ${response.status}`, { http: response.status })
        }
        let result
        try {
          result = await response.json()
        } catch {
          throw unreachable('the Host answered with a body that is not JSON')
        }
        if (!isRecord(result) || result.ok !== true) {
          throw refused(isRecord(result) ? result.error : null)
        }
        return result.value
      }

      /**
       * Post one endpoint through the serialized pipeline.
       *
       * @param {string} endpoint - the operation name.
       * @param {unknown} payload - its arguments.
       * @returns {Promise<any>} the operation value.
       */
      function post(endpoint, payload) {
        const run = () => transport(endpoint, payload)
        const result = chain.then(run, run)
        chain = result.then(() => undefined, () => undefined)
        return result
      }

      /**
       * Read the bootstrap view (`state`): version, redacted settings and the
       * Docker probe. Then probe Redis and PostgreSQL for the header chips.
       * Never throws; a failure is published for the notice.
       *
       * @returns {Promise<boolean>} whether the Host answered.
       */
      function bootstrap() {
        if (bootRequest !== null) return bootRequest
        const first = snapshot.boot !== 'ready'
        publish({ boot: first ? 'loading' : snapshot.boot, error: null })
        const run = (async () => {
          let answered = false
          try {
            const value = await post('state', {})
            const source = isRecord(value) ? value : {}
            const settings = settingsView(source.settings)
            const dockerInfo = isRecord(source.docker) ? source.docker : null
            publish({
              boot: 'ready',
              version: typeof source.version === 'string' ? source.version : '',
              settings,
              dockerInfo,
              targets: normalizeTargets(source.targets),
              error: null,
              ...(snapshot.formDirty ? {} : { form: settingForm(settings) }),
            })
            setConnection('docker', dockerInfo !== null && dockerInfo.available === true
              ? { status: 'ok', detail: typeof dockerInfo.version === 'string' ? dockerInfo.version : '' }
              : {
                  status: 'down',
                  detail: dockerInfo !== null && typeof dockerInfo.error === 'string' ? dockerInfo.error : '',
                })
            answered = true
          } catch (error) {
            publish({ boot: first ? 'error' : snapshot.boot, error: describeFailure(error) })
          }
          await probeServices()
          return answered
        })()
        bootRequest = run.then((value) => {
          bootRequest = null
          return value
        }, (error) => {
          bootRequest = null
          throw error
        })
        return bootRequest
      }

      /**
       * Probe Redis and PostgreSQL for the header chips. Failures are expected
       * until the connections are configured, so they only tint a chip.
       *
       * @returns {Promise<void>} resolves when both probes settled.
       */
      function probeServices() {
        setConnection('redis', { status: 'checking' })
        setConnection('postgres', { status: 'checking' })
        const redisProbe = post('redis.ping', {}).then((value) => {
          const source = isRecord(value) ? value : {}
          const detail = typeof source.version === 'string' ? source.version : snapshot.connections.redis.detail
          setConnection('redis', { status: 'ok', detail })
          return true
        }).catch((error) => {
          setConnection('redis', { status: 'down', detail: describeFailure(error).message })
          return false
        })
        const postgresProbe = post('pg.version', {}).then((value) => {
          const source = isRecord(value) ? value : {}
          setConnection('postgres', { status: 'ok', detail: shortPgVersion(source.version) })
          patchPostgres({ version: { status: 'ready', value: source, error: null } })
          return true
        }).catch((error) => {
          setConnection('postgres', { status: 'down', detail: describeFailure(error).message })
          return false
        })
        return Promise.all([redisProbe, postgresProbe]).then(() => undefined)
      }

      /**
       * Reload the visible tab's primary data.
       *
       * @returns {Promise<boolean>} whether it is current.
       */
      function reloadTab() {
        if (snapshot.tab === 'docker') {
          return Promise.all([loadDiskUsage(), loadVisibleDockerList({ silent: true })])
            .then((results) => results.every((result) => result !== false))
        }
        if (snapshot.tab === 'redis') return loadRedis()
        if (snapshot.tab === 'postgres') {
          return Promise.all([loadPostgres({ force: true }), loadActivity()])
            .then((results) => results.every((result) => result !== false))
        }
        if (snapshot.tab === 'relations') return loadRelations()
        if (snapshot.tab === 'overview') return loadOverview()
        return Promise.resolve(true)
      }

      /**
       * The header refresh: bootstrap view + chips + the visible tab. Keeps the
       * current rows on screen while it runs.
       *
       * @returns {Promise<boolean>} whether everything settled cleanly.
       */
      function refresh() {
        if (snapshot.refreshing) return Promise.resolve(false)
        publish({ refreshing: true })
        const finish = (ok) => {
          publish({ refreshing: false })
          return ok
        }
        return bootstrap().then((ok) => reloadTab().then((reloaded) => finish(ok && reloaded !== false), () => finish(false)), () => finish(false))
      }

      /**
       * Read the container list. A silent refresh is what the poll and the
       * post-action reload use: it keeps the rows on screen and only flips the
       * small busy indicator.
       *
       * @param {{ silent?: boolean }} [options] - refresh options.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function loadDocker(options) {
        const settings = options === undefined ? {} : options
        if (dockerRequest !== null) return dockerRequest
        const silent = settings.silent === true
        const hasRows = snapshot.docker.containers.length > 0
        patchDocker(silent && hasRows
          ? { refreshing: true, error: null }
          : { status: 'loading', refreshing: false, error: null })
        const run = post('docker.list', {}).then(async (value) => {
          const source = isRecord(value) ? value : {}
          const containers = Array.isArray(source.containers) ? source.containers : []
          // One `docker stats --no-stream` per list refresh feeds the CPU and
          // memory columns; a stats failure never fails the list itself.
          let statsById = snapshot.docker.statsById
          let statsError = null
          try {
            const statsValue = await post('docker.stats', {})
            const statsSource = isRecord(statsValue) ? statsValue : {}
            const stats = Array.isArray(statsSource.stats) ? statsSource.stats.filter(isRecord) : []
            const byId = {}
            for (const stat of stats) {
              const id = textOf(stat.id, '')
              if (id === '') continue
              const memory = isRecord(stat.memory) ? stat.memory : {}
              byId[id] = {
                id,
                name: textOf(stat.name, ''),
                cpuPercent: typeof stat.cpuPercent === 'number' ? stat.cpuPercent : null,
                memory: {
                  usageBytes: integerOf(memory.usageBytes, 0),
                  limitBytes: integerOf(memory.limitBytes, 0),
                  percent: typeof memory.percent === 'number' ? memory.percent : null,
                },
              }
            }
            statsById = byId
          } catch (error) {
            statsError = describeFailure(error)
          }
          patchDocker({ status: 'ready', containers, error: null, refreshing: false, statsById, statsError })
          if (snapshot.connections.docker.status !== 'ok') {
            const info = snapshot.dockerInfo
            setConnection('docker', {
              status: 'ok',
              detail: info !== null && typeof info.version === 'string' ? info.version : '',
            })
          }
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          patchDocker({ status: hasRows ? 'ready' : 'error', refreshing: false, error: failure })
          if (failure.code === 'docker_unavailable') setConnection('docker', { status: 'down', detail: failure.message })
          return false
        }).then((result) => {
          dockerRequest = null
          return result
        }, (error) => {
          dockerRequest = null
          throw error
        })
        dockerRequest = run
        return run
      }

      /**
       * @param {string} id - the container id.
       * @param {string} action - a DOCKER_ACTIONS member.
       * @returns {Promise<boolean>} whether the action was accepted.
       */
      function dockerAction(id, action) {
        if (snapshot.docker.busy !== '') return Promise.resolve(false)
        patchDocker({ busy: `${id}:${action}`, actionError: null })
        return post('docker.action', { id, action }).then(() => {
          patchDocker({ busy: '' })
          if (action === 'remove') {
            if (snapshot.docker.logs.id === id) patchDocker({ logs: emptyLogs(snapshot.docker.logs.tail) })
            if (snapshot.docker.detail.id === id) patchDocker({ detail: emptyDetail() })
            void loadDiskUsage()
          }
          void loadDocker({ silent: true })
          return true
        }).catch((error) => {
          patchDocker({ busy: '', actionError: describeFailure(error) })
          return false
        })
      }

      /**
       * Read one Docker resource list (images, volumes or networks).
       *
       * @param {string} name - the snapshot section: images | volumes | networks.
       * @param {string} endpoint - the Host endpoint.
       * @param {{ silent?: boolean }} [options] - refresh options.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function loadResourceList(name, endpoint, options) {
        const settings = options === undefined ? {} : options
        if (resourceRequests[name] !== null) return resourceRequests[name]
        const section = snapshot.docker[name]
        const silent = settings.silent === true
        const hasRows = section.list.length > 0
        patchDocker({
          [name]: Object.assign({}, section, silent && hasRows
            ? { refreshing: true, error: null }
            : { status: 'loading', refreshing: false, error: null }),
        })
        const run = post(endpoint, {}).then((value) => {
          const source = isRecord(value) ? value : {}
          const list = Array.isArray(source[name]) ? source[name] : []
          patchDocker({
            [name]: { status: 'ready', list, error: null, actionError: null, removing: '', refreshing: false },
          })
          return true
        }).catch((error) => {
          patchDocker({
            [name]: Object.assign({}, snapshot.docker[name], {
              status: hasRows ? 'ready' : 'error',
              error: describeFailure(error),
              refreshing: false,
            }),
          })
          return false
        }).then((result) => {
          resourceRequests[name] = null
          return result
        }, (error) => {
          resourceRequests[name] = null
          throw error
        })
        resourceRequests[name] = run
        return run
      }

      /** @param {{ silent?: boolean }} [options] - refresh options. @returns {Promise<boolean>} whether the images are current. */
      function loadImages(options) {
        return loadResourceList('images', 'docker.images', options)
      }

      /** @param {{ silent?: boolean }} [options] - refresh options. @returns {Promise<boolean>} whether the volumes are current. */
      function loadVolumes(options) {
        return loadResourceList('volumes', 'docker.volumes', options)
      }

      /** @param {{ silent?: boolean }} [options] - refresh options. @returns {Promise<boolean>} whether the networks are current. */
      function loadNetworks(options) {
        return loadResourceList('networks', 'docker.networks', options)
      }

      /**
       * Read the `docker system df` summary that sits above the sub-tabs.
       *
       * @returns {Promise<boolean>} whether the summary is current.
       */
      function loadDiskUsage() {
        if (diskRequest !== null) return diskRequest
        const disk = snapshot.docker.disk
        patchDocker({
          disk: Object.assign({}, disk, {
            status: disk.usage === null ? 'loading' : 'ready',
            refreshing: disk.usage !== null,
            error: null,
          }),
        })
        const run = post('docker.diskUsage', {}).then((value) => {
          const usage = isRecord(value) && isRecord(value.usage) ? value.usage : null
          if (usage === null) {
            const failure = new Error('the Host returned no disk usage')
            failure.code = 'data_failed'
            failure.details = {}
            throw failure
          }
          patchDocker({ disk: { status: 'ready', usage, error: null, refreshing: false } })
          return true
        }).catch((error) => {
          const current = snapshot.docker.disk
          patchDocker({
            disk: Object.assign({}, current, {
              status: current.usage === null ? 'error' : 'ready',
              error: describeFailure(error),
              refreshing: false,
            }),
          })
          return false
        }).then((result) => {
          diskRequest = null
          return result
        }, (error) => {
          diskRequest = null
          throw error
        })
        diskRequest = run
        return run
      }

      /**
       * Scan for Dockerfiles under the workspaces and the configured extra roots.
       *
       * @param {{ refresh?: boolean }} [options] - `refresh` bypasses the Host cache.
       * @returns {Promise<boolean>} whether the list is current.
       */
      function loadDockerfiles(options) {
        const settings = options === undefined ? {} : options
        if (dockerfilesRequest !== null) return dockerfilesRequest
        const previous = snapshot.docker.dockerfiles
        const hasValue = previous.status === 'ready'
        patchDocker({
          dockerfiles: Object.assign({}, previous, hasValue
            ? { refreshing: true, error: null }
            : { status: 'loading', refreshing: false, error: null }),
        })
        const payload = settings.refresh === true ? { refresh: true } : {}
        const run = post('dockerfiles.list', payload).then((value) => {
          const normalized = normalizeDockerfiles(value)
          patchDocker({
            dockerfiles: {
              status: 'ready',
              list: normalized.dockerfiles,
              roots: normalized.roots,
              scan: normalized.scan,
              error: null,
              refreshing: false,
            },
          })
          return true
        }).catch((error) => {
          patchDocker({
            dockerfiles: Object.assign({}, snapshot.docker.dockerfiles, {
              status: previous.status === 'ready' ? 'ready' : 'error',
              refreshing: false,
              error: describeFailure(error),
            }),
          })
          return false
        }).then((result) => {
          dockerfilesRequest = null
          return result
        }, (error) => {
          dockerfilesRequest = null
          throw error
        })
        dockerfilesRequest = run
        return run
      }

      /**
       * Read one Dockerfile's content and parsed summary for the viewer.
       *
       * @param {string} [path] - the file path; defaults to the open one.
       * @returns {Promise<boolean>} whether the content is current.
       */
      function loadDockerfile(path) {
        const target = textOf(path, snapshot.docker.dockerfileView.path)
        if (target === '') return Promise.resolve(false)
        if (dockerfileReadRequest !== null) return dockerfileReadRequest
        const view = snapshot.docker.dockerfileView
        patchDocker({ dockerfileView: Object.assign({}, view, { path: target, status: 'loading', error: null }) })
        const run = post('dockerfiles.read', { path: target }).then((value) => {
          const detail = normalizeDockerfileDetail(value)
          if (detail === null) {
            const failure = new Error('the Host returned no Dockerfile content')
            failure.code = 'data_failed'
            failure.details = {}
            throw failure
          }
          patchDocker({ dockerfileView: { open: true, path: target, status: 'ready', value: detail, error: null } })
          return true
        }).catch((error) => {
          patchDocker({
            dockerfileView: Object.assign({}, snapshot.docker.dockerfileView, {
              status: 'error',
              value: null,
              error: describeFailure(error),
            }),
          })
          return false
        }).then((result) => {
          dockerfileReadRequest = null
          return result
        }, (error) => {
          dockerfileReadRequest = null
          throw error
        })
        dockerfileReadRequest = run
        return run
      }

      /**
       * @param {object|string} file - a DockerfileSummary or its path.
       * @returns {Promise<boolean>} whether the content loaded.
       */
      function openDockerfile(file) {
        const path = isRecord(file) ? textOf(file.path, '') : textOf(file, '')
        if (path === '') return Promise.resolve(false)
        patchDocker({ dockerfileView: { open: true, path, status: 'loading', value: null, error: null } })
        return loadDockerfile(path)
      }

      /** @returns {void} */
      function closeDockerfile() {
        patchDocker({ dockerfileView: { open: false, path: '', status: 'idle', value: null, error: null } })
      }

      /**
       * Make sure one Docker sub-tab has data; idempotent for the panel effect.
       *
       * @param {string} subTab - a DOCKER_SUBTABS member.
       * @returns {Promise<boolean>} whether its data is loaded.
       */
      function ensureDockerSubTabLoaded(subTab) {
        if (subTab === 'dockerfiles') return snapshot.docker.dockerfiles.status === 'idle' ? loadDockerfiles() : Promise.resolve(true)
        if (subTab === 'images') return snapshot.docker.images.status === 'idle' ? loadImages() : Promise.resolve(true)
        if (subTab === 'volumes') return snapshot.docker.volumes.status === 'idle' ? loadVolumes() : Promise.resolve(true)
        if (subTab === 'networks') return snapshot.docker.networks.status === 'idle' ? loadNetworks() : Promise.resolve(true)
        return snapshot.docker.status === 'idle' ? loadDocker() : Promise.resolve(true)
      }

      /**
       * Select a Docker sub-tab and load its list on first visit.
       *
       * @param {string} subTab - a DOCKER_SUBTABS member.
       * @returns {Promise<boolean>} whether the sub-tab's data is loaded.
       */
      function selectDockerTab(subTab) {
        if (DOCKER_SUBTABS.indexOf(subTab) < 0) return Promise.resolve(false)
        if (snapshot.docker.subTab !== subTab) patchDocker({ subTab })
        return ensureDockerSubTabLoaded(subTab)
      }

      /**
       * @param {{ silent?: boolean }} [options] - refresh options.
       * @returns {Promise<boolean>} whether the visible Docker list is current.
       */
      function loadVisibleDockerList(options) {
        if (snapshot.docker.subTab === 'dockerfiles') return loadDockerfiles({ refresh: true })
        if (snapshot.docker.subTab === 'images') return loadImages(options)
        if (snapshot.docker.subTab === 'volumes') return loadVolumes(options)
        if (snapshot.docker.subTab === 'networks') return loadNetworks(options)
        return loadDocker(options)
      }

      /** @returns {Promise<boolean>} whether the visible Docker list was refreshed. */
      function refreshDockerSubTab() {
        return loadVisibleDockerList({ silent: true })
      }

      /**
       * Remove one Docker resource, then refresh its list and the disk summary.
       *
       * @param {string} name - the snapshot section: images | volumes | networks.
       * @param {string} endpoint - the Host endpoint.
       * @param {object} payload - its arguments.
       * @param {string} busyKey - the identifier shown as busy.
       * @returns {Promise<boolean>} whether the removal succeeded.
       */
      function removeResource(name, endpoint, payload, busyKey) {
        const section = snapshot.docker[name]
        if (section.removing !== '') return Promise.resolve(false)
        patchDocker({ [name]: Object.assign({}, section, { removing: busyKey, actionError: null }) })
        return post(endpoint, payload).then(() => {
          patchDocker({ [name]: Object.assign({}, snapshot.docker[name], { removing: '', actionError: null }) })
          return Promise.all([
            loadResourceList(name, RESOURCE_LIST_ENDPOINTS[name], { silent: true }),
            loadDiskUsage(),
          ]).then(() => true)
        }).catch((error) => {
          patchDocker({
            [name]: Object.assign({}, snapshot.docker[name], {
              removing: '',
              actionError: describeFailure(error),
            }),
          })
          return false
        })
      }

      /** @param {string} id - the image reference. @returns {Promise<boolean>} whether it was removed. */
      function removeImage(id) {
        if (typeof id !== 'string' || id === '') return Promise.resolve(false)
        return removeResource('images', 'docker.imageRemove', { id }, id)
      }

      /** @param {string} name - the volume name. @returns {Promise<boolean>} whether it was removed. */
      function removeVolume(name) {
        if (typeof name !== 'string' || name === '') return Promise.resolve(false)
        return removeResource('volumes', 'docker.volumeRemove', { name }, name)
      }

      /** @param {string} name - the network name. @returns {Promise<boolean>} whether it was removed. */
      function removeNetwork(name) {
        if (typeof name !== 'string' || name === '') return Promise.resolve(false)
        return removeResource('networks', 'docker.networkRemove', { name }, name)
      }

      /** Container actions that the panel asks about before calling the Host. */
      const CONFIRMABLE_CONTAINER_ACTIONS = ['stop', 'restart', 'pause', 'remove']

      /**
       * Queue one destructive action for the confirmation dialog.
       *
       * @param {string} kind - the dialog kind.
       * @param {object} target - the target description.
       * @returns {void}
       */
      function requestConfirm(kind, target) {
        publish({ confirm: Object.assign({ kind }, target) })
      }

      /**
       * Ask for confirmation before stopping, restarting, pausing or removing a
       * container. `start` and `unpause` are safe one-click actions and never
       * reach this method.
       *
       * @param {string} id - the container id.
       * @param {string} name - the container name shown in the dialog.
       * @param {string} action - stop | restart | pause | remove.
       * @returns {Promise<boolean>} whether a confirmation was requested.
       */
      function requestContainerAction(id, name, action, role) {
        if (CONFIRMABLE_CONTAINER_ACTIONS.indexOf(action) < 0) return Promise.resolve(false)
        requestConfirm(`container.${action}`, { id, name: textOf(name, id), action, role: roleKeyOf(role) })
        return Promise.resolve(true)
      }

      /**
       * @param {string} id - the image reference.
       * @param {string} [name] - the label shown in the dialog.
       * @returns {void}
       */
      function requestImageRemove(id, name) {
        requestConfirm('image.remove', { id, name: textOf(name, id) })
      }

      /** @param {string} name - the volume name. @returns {void} */
      function requestVolumeRemove(name) {
        requestConfirm('volume.remove', { name })
      }

      /** @param {string} name - the network name. @returns {void} */
      function requestNetworkRemove(name) {
        requestConfirm('network.remove', { name })
      }

      /** @param {string} key - the Redis key. @returns {void} */
      function requestRedisDelete(key) {
        requestConfirm('redis.delete', { key })
      }

      /** Drop the pending confirmation without calling the Host. @returns {void} */
      function cancelConfirm() {
        if (snapshot.confirm !== null) publish({ confirm: null })
      }

      /**
       * Run the action the confirmation dialog was opened for.
       *
       * @returns {Promise<boolean>} whether the action succeeded.
       */
      function acceptConfirm() {
        const request = snapshot.confirm
        if (request === null) return Promise.resolve(false)
        publish({ confirm: null })
        if (request.kind === 'image.remove') return removeImage(request.id)
        if (request.kind === 'volume.remove') return removeVolume(request.name)
        if (request.kind === 'network.remove') return removeNetwork(request.name)
        if (request.kind === 'redis.delete') return deleteRedisKey(request.key)
        if (request.kind === 'redis.rename') return renameRedisKey(request.key, request.newKey)
        if (request.kind === 'redis.expire') return expireRedisKey(request.key, request.ttlSeconds)
        if (typeof request.kind === 'string' && request.kind.indexOf('container.') === 0) {
          const action = typeof request.action === 'string' ? request.action : request.kind.slice('container.'.length)
          return dockerAction(request.id, action)
        }
        return Promise.resolve(false)
      }

      /** @param {string} value - the filter text. @returns {void} */
      function setDockerFilter(value) {
        patchDocker({ filter: value })
      }

      /** @param {string} value - an all/running/stopped/paused preset. @returns {void} */
      function setDockerStateFilter(value) {
        patchDocker({ stateFilter: DOCKER_STATE_FILTERS.indexOf(value) >= 0 ? value : 'all' })
      }

      /**
       * @param {string} kind - images | volumes | networks.
       * @param {string} value - the filter text ('' clears it).
       * @returns {void}
       */
      function setDockerResourceFilter(kind, value) {
        const text = textOf(value, '')
        if (kind === 'images') patchDocker({ imageFilter: text })
        else if (kind === 'volumes') patchDocker({ volumeFilter: text })
        else if (kind === 'networks') patchDocker({ networkFilter: text })
      }

      // -----------------------------------------------------------------
      // Overview page, display mode, help and copy feedback
      // -----------------------------------------------------------------

      /**
       * Read the beginner overview report.
       *
       * @param {{ force?: boolean }} [options] - reload options.
       * @returns {Promise<boolean>} whether the overview is current.
       */
      function loadOverview(options) {
        void options
        if (overviewRequest !== null) return overviewRequest
        const hasValue = snapshot.overview.value !== null
        publish({
          overview: Object.assign({}, snapshot.overview, hasValue
            ? { refreshing: true, error: null }
            : { status: 'loading', error: null, refreshing: false }),
        })
        const run = post('overview', {}).then((value) => {
          const overview = normalizeOverview(value)
          if (overview === null) {
            const failure = new Error('the Host returned no overview')
            failure.code = 'data_failed'
            failure.details = {}
            throw failure
          }
          publish({ overview: { status: 'ready', value: overview, error: null, refreshing: false } })
          return true
        }).catch((error) => {
          const current = snapshot.overview
          publish({
            overview: Object.assign({}, current, {
              status: current.value === null ? 'error' : 'ready',
              error: describeFailure(error),
              refreshing: false,
            }),
          })
          return false
        }).then((result) => {
          overviewRequest = null
          return result
        }, (error) => {
          overviewRequest = null
          throw error
        })
        overviewRequest = run
        return run
      }

      /**
       * @param {string} mode - beginner | expert.
       * @returns {void}
       */
      function setViewMode(mode) {
        const next = mode === 'expert' ? 'expert' : 'beginner'
        storeViewMode(next)
        if (snapshot.viewMode !== next) publish({ viewMode: next })
      }

      /** @returns {void} */
      function toggleHelp() {
        publish({ helpOpen: !snapshot.helpOpen })
      }

      /** @returns {void} */
      function closeHelp() {
        if (snapshot.helpOpen) publish({ helpOpen: false })
      }

      /**
       * Copy a value to the clipboard and flash the "copied" feedback.
       *
       * @param {string} text - the text to copy.
       * @param {string} key - a stable feedback key.
       * @returns {boolean} whether the clipboard accepted it.
       */
      function copyText(text, key) {
        const accepted = copyTextToClipboard(text)
        if (!accepted) return false
        if (copyTimer !== null) {
          clearTimeout(copyTimer)
          copyTimer = null
        }
        publish({ copied: { key: textOf(key, ''), at: Date.now() } })
        copyTimer = setTimeout(() => {
          copyTimer = null
          publish({ copied: { key: '', at: 0 } })
        }, COPY_FEEDBACK_MS)
        if (copyTimer !== null && typeof copyTimer === 'object' && typeof copyTimer.unref === 'function') copyTimer.unref()
        return true
      }

      /** @returns {void} */
      function openRedisWizard() {
        patchRedis({ wizard: Object.assign({}, emptyWizard(), { open: true }) })
      }

      /** @returns {void} */
      function closeRedisWizard() {
        patchRedis({ wizard: emptyWizard() })
      }

      /**
       * @param {string} field - type | key | field | value | member | ttl.
       * @param {string} value - the new value.
       * @returns {void}
       */
      function setRedisWizard(field, value) {
        if (['type', 'key', 'field', 'value', 'member', 'ttl'].indexOf(field) < 0) return
        patchRedis({
          wizard: Object.assign({}, snapshot.redis.wizard, {
            [field]: value,
            status: 'idle',
            error: null,
            notice: null,
          }),
        })
      }

      /**
       * Save the wizard's data through the matching Redis command.
       *
       * @returns {Promise<boolean>} whether the write succeeded.
       */
      function submitRedisWizard() {
        const wizard = snapshot.redis.wizard
        if (!wizard.open || wizard.status === 'running') return Promise.resolve(false)
        const key = wizard.key.trim()
        if (key === '') {
          patchRedis({
            wizard: Object.assign({}, wizard, {
              error: { code: 'invalid_payload', message: '', details: { hint: 'key' } },
              notice: null,
            }),
          })
          return Promise.resolve(false)
        }
        let endpoint
        let payload
        const type = ['string', 'hash', 'list', 'set'].indexOf(wizard.type) >= 0 ? wizard.type : 'string'
        if (type === 'string') {
          endpoint = 'redis.set'
          payload = { key, value: wizard.value }
          if (wizard.ttl.trim() !== '') {
            const ttl = Number(wizard.ttl)
            if (!Number.isInteger(ttl) || ttl < 0) {
              patchRedis({
                wizard: Object.assign({}, wizard, {
                  error: { code: 'invalid_payload', message: '', details: { hint: 'ttl' } },
                  notice: null,
                }),
              })
              return Promise.resolve(false)
            }
            payload.ttlSeconds = ttl
          }
        } else if (type === 'hash') {
          if (wizard.field.trim() === '') {
            patchRedis({
              wizard: Object.assign({}, wizard, {
                error: { code: 'invalid_payload', message: '', details: { hint: 'field' } },
                notice: null,
              }),
            })
            return Promise.resolve(false)
          }
          endpoint = 'redis.hashSet'
          payload = { key, field: wizard.field, value: wizard.value }
        } else if (type === 'list') {
          endpoint = 'redis.listPush'
          payload = { key, value: wizard.value, side: 'right' }
        } else {
          if (wizard.member.trim() === '') {
            patchRedis({
              wizard: Object.assign({}, wizard, {
                error: { code: 'invalid_payload', message: '', details: { hint: 'member' } },
                notice: null,
              }),
            })
            return Promise.resolve(false)
          }
          endpoint = 'redis.setAdd'
          payload = { key, member: wizard.member }
        }
        patchRedis({ wizard: Object.assign({}, wizard, { status: 'running', error: null, notice: null }) })
        return post(endpoint, payload).then(() => {
          patchRedis({
            wizard: Object.assign({}, snapshot.redis.wizard, {
              status: 'idle',
              error: null,
              notice: { key },
            }),
          })
          void scanRedis()
          return true
        }).catch((error) => {
          patchRedis({
            wizard: Object.assign({}, snapshot.redis.wizard, {
              status: 'idle',
              error: describeFailure(error),
              notice: null,
            }),
          })
          return false
        })
      }

      /**
       * Fill the SQL editor with a quick-query template for the selected table.
       *
       * @param {string} kind - preview | count | columns.
       * @returns {boolean} whether a template was filled.
       */
      function fillSqlTemplate(kind) {
        const selected = snapshot.postgres.selected
        if (selected.name === '') return false
        patchPostgres({ sql: templateSql(selected.schema, selected.name, kind) })
        return true
      }

      // -----------------------------------------------------------------
      // Relations page
      // -----------------------------------------------------------------

      /**
       * Read the Docker association graph.
       *
       * @param {{ force?: boolean }} [options] - reload options.
       * @returns {Promise<boolean>} whether the graph is current.
       */
      function loadRelations(options) {
        void options
        if (relationsRequest !== null) return relationsRequest
        const hasValue = snapshot.relations.value !== null
        publish({
          relations: Object.assign({}, snapshot.relations, hasValue
            ? { refreshing: true, error: null }
            : { status: 'loading', error: null, refreshing: false }),
        })
        const run = post('docker.relations', {}).then((value) => {
          const source = isRecord(value) ? value : {}
          const relations = normalizeRelations(source.relations === undefined ? source : source.relations)
          publish({
            relations: Object.assign({}, snapshot.relations, {
              status: 'ready',
              value: relations,
              error: null,
              refreshing: false,
            }),
          })
          return true
        }).catch((error) => {
          publish({
            relations: Object.assign({}, snapshot.relations, {
              status: snapshot.relations.value === null ? 'error' : 'ready',
              error: describeFailure(error),
              refreshing: false,
            }),
          })
          return false
        }).then((result) => {
          relationsRequest = null
          return result
        }, (error) => {
          relationsRequest = null
          throw error
        })
        relationsRequest = run
        return run
      }

      /**
       * @param {string} kind - all | images | volumes | networks.
       * @param {string} id - the chosen resource id/name ('' clears it).
       * @returns {void}
       */
      function setRelationsFilter(kind, id) {
        const nextKind = ['all', 'images', 'volumes', 'networks'].indexOf(kind) >= 0 ? kind : 'all'
        publish({
          relations: Object.assign({}, snapshot.relations, {
            kind: nextKind,
            id: nextKind === 'all' ? '' : textOf(id, ''),
          }),
        })
      }

      /**
       * Click-through from the relations page into the Docker tab.
       *
       * @param {object} container - the relations container row.
       * @returns {Promise<boolean>} resolves after the tab switch.
       */
      function openRelationContainer(container) {
        const id = isRecord(container) ? textOf(container.id, '') : ''
        const name = isRecord(container) ? textOf(container.name, id) : id
        return selectTab('docker').then(() => {
          void selectDockerTab('containers')
          if (id !== '') toggleDetail(id, name)
          return true
        })
      }

      /**
       * @param {string} kind - images | volumes | networks.
       * @param {string} id - the resource id/name to filter the sub-tab to.
       * @returns {Promise<boolean>} resolves after the tab switch.
       */
      function openRelationResource(kind, id) {
        const subTab = kind === 'images' || kind === 'volumes' || kind === 'networks' ? kind : 'containers'
        return selectTab('docker').then(() => {
          void selectDockerTab(subTab)
          if (subTab !== 'containers') setDockerResourceFilter(subTab, textOf(id, ''))
          return true
        })
      }

      // -----------------------------------------------------------------
      // Resource inspect modals
      // -----------------------------------------------------------------

      /**
       * Read the details of the modal currently open (image / volume / network).
       *
       * @returns {Promise<boolean>} whether the details are current.
       */
      function loadInspect() {
        const inspect = snapshot.docker.inspect
        if (!inspect.open || inspect.id === '') return Promise.resolve(false)
        if (inspectRequest !== null) return inspectRequest
        const endpoint = inspect.kind === 'image'
          ? 'docker.imageInspect'
          : inspect.kind === 'volume' ? 'docker.volumeInspect' : 'docker.networkInspect'
        const payload = inspect.kind === 'image' ? { id: inspect.id } : { name: inspect.id }
        const field = inspect.kind === 'image' ? 'image' : inspect.kind === 'volume' ? 'volume' : 'network'
        patchDocker({ inspect: Object.assign({}, inspect, { status: 'loading', error: null }) })
        const run = post(endpoint, payload).then((value) => {
          const source = isRecord(value) ? value : {}
          const detail = isRecord(source[field]) ? source[field] : null
          if (detail === null) {
            const failure = new Error('the Host returned no details')
            failure.code = 'data_failed'
            failure.details = {}
            throw failure
          }
          patchDocker({
            inspect: Object.assign({}, snapshot.docker.inspect, { status: 'ready', value: detail, error: null }),
          })
          return true
        }).catch((error) => {
          patchDocker({
            inspect: Object.assign({}, snapshot.docker.inspect, { status: 'error', value: null, error: describeFailure(error) }),
          })
          return false
        }).then((result) => {
          inspectRequest = null
          return result
        }, (error) => {
          inspectRequest = null
          throw error
        })
        inspectRequest = run
        return run
      }

      /**
       * Open the details modal for one image, volume or network.
       *
       * @param {string} kind - image | volume | network.
       * @param {string} id - the id or name.
       * @param {string} [name] - the label shown in the modal title.
       * @returns {Promise<boolean>} whether the details loaded.
       */
      function inspectResource(kind, id, name) {
        const target = textOf(id, '')
        if (target === '' || ['image', 'volume', 'network'].indexOf(kind) < 0) return Promise.resolve(false)
        patchDocker({
          inspect: { open: true, kind, id: target, name: textOf(name, target), status: 'loading', value: null, error: null },
        })
        return loadInspect()
      }

      /** @returns {void} */
      function closeInspect() {
        patchDocker({ inspect: emptyInspect() })
      }

      // -----------------------------------------------------------------
      // Multiple running instances
      // -----------------------------------------------------------------

      /**
       * Reload a service's tab from scratch after its target changed.
       *
       * @param {string} service - redis | postgres.
       * @returns {Promise<void>} resolves when the reload settled.
       */
      async function resetServiceData(service) {
        if (service === 'redis') {
          patchRedis({
            status: 'idle',
            summary: null,
            error: null,
            refreshing: false,
            dbsize: { status: 'idle', keys: null, error: null },
            clients: { status: 'idle', list: [], error: null, refreshing: false },
            scan: { match: '*', type: '', cursor: '0', keys: [], done: false, loaded: false, loading: false, error: null, scanned: 0 },
            selected: emptySelectedKey(),
            editor: emptyRedisEditor(''),
            renameDraft: '',
            expireDraft: '',
            action: emptyKeyAction(),
            deleteError: null,
          })
          await loadRedis()
          return
        }
        if (service === 'postgres') {
          patchPostgres({
            status: 'idle',
            error: null,
            refreshing: false,
            version: { status: 'idle', value: null, error: null },
            databases: [],
            databasesError: null,
            database: '',
            tables: { status: 'idle', list: [], error: null },
            selected: emptySelectedTable(),
            browse: emptyBrowse(),
            activity: { status: 'idle', list: [], error: null, refreshing: false },
            query: { status: 'idle', result: null, error: null },
          })
          await Promise.all([loadPostgres(), loadActivity()])
        }
      }

      /**
       * Pin one running instance (or return to auto mode) by saving
       * `{mode:'docker', container}` and reloading the service tab.
       *
       * @param {string} service - redis | postgres.
       * @param {string} container - the container name, '' for auto.
       * @returns {Promise<boolean>} whether the switch succeeded.
       */
      function selectInstance(service, container) {
        if (service !== 'redis' && service !== 'postgres') return Promise.resolve(false)
        if (snapshot.instanceSaving !== '') return Promise.resolve(false)
        const value = textOf(container, '')
        publish({ instanceSaving: service, instanceError: null })
        const payload = {}
        payload[service] = { mode: 'docker', container: value }
        return post('settings.save', payload).then(async (saved) => {
          const settings = settingsView(saved)
          publish({
            instanceSaving: '',
            instanceError: null,
            settings,
            ...(snapshot.formDirty ? {} : { form: settingForm(settings) }),
          })
          await bootstrap()
          await resetServiceData(service)
          return true
        }).catch((error) => {
          publish({ instanceSaving: '', instanceError: describeFailure(error) })
          return false
        })
      }


      /**
       * Open the logs drawer for a container (or close it when it is already
       * open for that container).
       *
       * @param {string} id - the container id.
       * @param {string} name - the container name for the drawer title.
       * @returns {void}
       */
      function toggleLogs(id, name) {
        if (snapshot.docker.logs.id === id) {
          patchDocker({ logs: emptyLogs(snapshot.docker.logs.tail) })
          return
        }
        patchDocker({
          logs: {
            id,
            name,
            status: 'loading',
            tail: snapshot.docker.logs.tail,
            text: '',
            error: null,
          },
        })
        void loadLogs()
      }

      /** @returns {void} */
      function closeLogs() {
        patchDocker({ logs: emptyLogs(snapshot.docker.logs.tail) })
      }

      /**
       * @param {number|string} tail - one of LOG_TAIL_OPTIONS.
       * @returns {void}
       */
      function setLogTail(tail) {
        const number = Number(tail)
        const next = LOG_TAIL_OPTIONS.indexOf(number) >= 0 ? number : DEFAULT_LOG_TAIL
        patchDocker({ logs: Object.assign({}, snapshot.docker.logs, { tail: next }) })
        if (snapshot.docker.logs.id !== '') void loadLogs()
      }

      /**
       * Read the open drawer's logs.
       *
       * @returns {Promise<boolean>} whether the log text is current.
       */
      function loadLogs() {
        const logs = snapshot.docker.logs
        if (logs.id === '') return Promise.resolve(false)
        if (logsRequest !== null) return logsRequest
        const id = logs.id
        patchDocker({ logs: Object.assign({}, logs, { status: 'loading', error: null }) })
        const run = post('docker.logs', { id, tail: logs.tail }).then((value) => {
          if (snapshot.docker.logs.id !== id) return false
          const source = isRecord(value) ? value : {}
          const text = typeof source.logs === 'string' ? source.logs : ''
          patchDocker({
            logs: Object.assign({}, snapshot.docker.logs, { status: 'ready', text, error: null }),
          })
          return true
        }).catch((error) => {
          if (snapshot.docker.logs.id !== id) return false
          patchDocker({
            logs: Object.assign({}, snapshot.docker.logs, { status: 'error', error: describeFailure(error) }),
          })
          return false
        }).then((result) => {
          logsRequest = null
          return result
        }, (error) => {
          logsRequest = null
          throw error
        })
        logsRequest = run
        return run
      }

      /**
       * Open the details drawer for a container, or close it.
       *
       * @param {string} id - the container id.
       * @param {string} name - the container name.
       * @returns {void}
       */
      function toggleDetail(id, name) {
        if (snapshot.docker.detail.id === id) {
          patchDocker({ detail: emptyDetail() })
          return
        }
        patchDocker({ detail: { id, name, status: 'loading', container: null, error: null } })
        void loadDetail()
      }

      /** @returns {void} */
      function closeDetail() {
        patchDocker({ detail: emptyDetail() })
      }

      /**
       * Read the open drawer's container details.
       *
       * @returns {Promise<boolean>} whether the details are current.
       */
      function loadDetail() {
        const detail = snapshot.docker.detail
        if (detail.id === '') return Promise.resolve(false)
        if (detailRequest !== null) return detailRequest
        const id = detail.id
        patchDocker({ detail: Object.assign({}, detail, { status: 'loading', error: null }) })
        const run = post('docker.inspect', { id }).then((value) => {
          if (snapshot.docker.detail.id !== id) return false
          const source = isRecord(value) ? value : {}
          const container = isRecord(source.container) ? source.container : null
          patchDocker({
            detail: Object.assign({}, snapshot.docker.detail, { status: 'ready', container, error: null }),
          })
          return true
        }).catch((error) => {
          if (snapshot.docker.detail.id !== id) return false
          patchDocker({
            detail: Object.assign({}, snapshot.docker.detail, { status: 'error', error: describeFailure(error) }),
          })
          return false
        }).then((result) => {
          detailRequest = null
          return result
        }, (error) => {
          detailRequest = null
          throw error
        })
        detailRequest = run
        return run
      }

      /**
       * Read the Redis overview. A failed refresh keeps the last summary.
       *
       * @returns {Promise<boolean>} whether the overview is current.
       */
      function loadRedis() {
        if (redisInfoRequest !== null) return redisInfoRequest
        const first = snapshot.redis.summary === null
        patchRedis(first
          ? { status: 'loading', error: null, refreshing: false }
          : { refreshing: true, error: null })
        const run = (async () => {
          try {
            const value = await post('redis.info', {})
            const source = isRecord(value) ? value : {}
            const summary = normalizeRedisSummary(source.summary)
            patchRedis({ status: 'ready', summary, error: null, refreshing: false })
            setConnection('redis', { status: 'ok', detail: summary.version === null ? '' : summary.version })
            const jobs = [loadRedisServer()]
            if (!snapshot.redis.scan.loaded) jobs.push(scanRedis())
            await Promise.all(jobs)
            return true
          } catch (error) {
            const failure = describeFailure(error)
            patchRedis({
              status: snapshot.redis.summary === null ? 'error' : 'ready',
              refreshing: false,
              error: failure,
            })
            if (failure.code !== 'invalid_payload') {
              setConnection('redis', { status: 'down', detail: failure.message })
            }
            return false
          }
        })()
        redisInfoRequest = run.then((value) => {
          redisInfoRequest = null
          return value
        }, (error) => {
          redisInfoRequest = null
          throw error
        })
        return redisInfoRequest
      }

      /**
       * Reset the SCAN browsing with the current pattern and type filters.
       *
       * @returns {Promise<boolean>} whether the first page was read.
       */
      function scanRedis() {
        if (scanRequest !== null) return scanRequest
        patchScan({ loading: true, error: null, cursor: '0', keys: [], scanned: 0, done: false, loaded: true })
        return requestScan('0')
      }

      /**
       * Ask the server for the next SCAN page.
       *
       * @returns {Promise<boolean>} whether the page was read.
       */
      function scanMore() {
        if (scanRequest !== null) return scanRequest
        const scan = snapshot.redis.scan
        if (scan.done || scan.loading) return Promise.resolve(false)
        patchScan({ loading: true, error: null })
        return requestScan(scan.cursor)
      }

      /**
       * @param {string} cursor - the SCAN cursor to continue from.
       * @returns {Promise<boolean>} whether the page was read.
       */
      function requestScan(cursor) {
        const scan = snapshot.redis.scan
        const payload = {
          cursor,
          match: scan.match.trim() === '' ? '*' : scan.match.trim(),
          count: REDIS_SCAN_COUNT,
        }
        if (scan.type !== '') payload.type = scan.type
        const run = post('redis.scan', payload).then((value) => {
          const source = isRecord(value) ? value : {}
          const rawKeys = normalizeKeys(source.keys)
          const nextCursor = source.cursor === undefined || source.cursor === null ? '0' : String(source.cursor)
          const done = source.done === true || nextCursor === '0'
          let keys
          if (cursor === '0') {
            keys = rawKeys
          } else {
            const seen = new Set(snapshot.redis.scan.keys)
            keys = snapshot.redis.scan.keys.slice()
            for (const key of rawKeys) {
              if (!seen.has(key)) {
                seen.add(key)
                keys.push(key)
              }
            }
          }
          patchScan({ loading: false, error: null, keys, cursor: nextCursor, done, scanned: keys.length })
          if (snapshot.connections.redis.status !== 'ok') {
            setConnection('redis', { status: 'ok', detail: snapshot.connections.redis.detail })
          }
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          patchScan({ loading: false, error: failure })
          if (failure.code !== 'invalid_payload') {
            setConnection('redis', { status: 'down', detail: failure.message })
          }
          return false
        }).then((result) => {
          scanRequest = null
          return result
        }, (error) => {
          scanRequest = null
          throw error
        })
        scanRequest = run
        return run
      }

      /**
       * @param {string} field - match | type.
       * @param {string} value - the new value.
       * @returns {void}
       */
      function setRedisScan(field, value) {
        if (field !== 'match' && field !== 'type') return
        patchScan({ [field]: value })
      }

      /**
       * Read one Redis key's type, TTL and value.
       *
       * @param {string} key - the key name.
       * @returns {Promise<boolean>} whether the value is current.
       */
      function selectRedisKey(key) {
        if (typeof key !== 'string' || key === '') return Promise.resolve(false)
        if (keyRequest !== null) return keyRequest
        patchRedis({
          selected: {
            key,
            status: 'loading',
            detail: null,
            error: null,
            memory: { status: 'loading', data: null, error: null },
          },
        })
        const run = post('redis.get', { key }).then(async (value) => {
          if (snapshot.redis.selected.key !== key) return false
          const source = isRecord(value) ? value : {}
          const detail = {
            key: textOf(source.key, key),
            type: typeof source.type === 'string' ? source.type : '',
            ttl: typeof source.ttl === 'number' ? source.ttl : null,
            value: source.value === undefined ? null : source.value,
          }
          patchRedis({
            selected: Object.assign({}, snapshot.redis.selected, {
              key,
              status: 'ready',
              detail,
              error: null,
              memory: { status: 'loading', data: null, error: null },
            }),
            editor: emptyRedisEditor(typeof source.type === 'string' ? source.type : ''),
            renameDraft: '',
            expireDraft: '',
          })
          await loadKeyMemory(key)
          return true
        }).catch((error) => {
          if (snapshot.redis.selected.key !== key) return false
          patchRedis({
            selected: {
              key,
              status: 'error',
              detail: null,
              error: describeFailure(error),
              memory: { status: 'idle', data: null, error: null },
            },
          })
          return false
        }).then((result) => {
          keyRequest = null
          return result
        }, (error) => {
          keyRequest = null
          throw error
        })
        keyRequest = run
        return run
      }

      /**
       * @param {string} field - key | value | ttl.
       * @param {string} value - the new field value.
       * @returns {void}
       */
      function setRedisField(field, value) {
        if (field !== 'key' && field !== 'value' && field !== 'ttl') return
        patchRedis({
          setForm: Object.assign({}, snapshot.redis.setForm, { [field]: value }),
          setError: null,
          setNotice: null,
        })
      }

      /**
       * Write the set-string form with `redis.set`. An empty TTL means no
       * expiry; the Host validates the rest.
       *
       * @returns {Promise<boolean>} whether the key was written.
       */
      function submitRedisSet() {
        if (snapshot.redis.setting) return Promise.resolve(false)
        const form = snapshot.redis.setForm
        const key = form.key.trim()
        if (key === '') return Promise.resolve(false)
        const payload = { key, value: form.value }
        if (form.ttl.trim() !== '') {
          const ttlSeconds = Number(form.ttl)
          if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
            patchRedis({
              setError: { code: 'invalid_payload', message: 'TTL must be a non-negative integer', details: { field: 'ttlSeconds' } },
            })
            return Promise.resolve(false)
          }
          payload.ttlSeconds = ttlSeconds
        }
        patchRedis({ setting: true, setError: null, setNotice: null })
        return post('redis.set', payload).then((value) => {
          const source = isRecord(value) ? value : {}
          const ttl = typeof source.ttl === 'number' ? source.ttl : (payload.ttlSeconds === undefined ? null : payload.ttlSeconds)
          patchRedis({
            setting: false,
            setError: null,
            setNotice: { key: textOf(source.key, key), ttl },
          })
          if (snapshot.redis.selected.key === key) void selectRedisKey(key)
          return true
        }).catch((error) => {
          patchRedis({ setting: false, setError: describeFailure(error) })
          return false
        })
      }

      /**
       * Delete a key after the panel's confirmation dialog.
       *
       * @param {string} key - the key name.
       * @returns {Promise<boolean>} whether the key was deleted.
       */
      function deleteRedisKey(key) {
        if (typeof key !== 'string' || key === '') return Promise.resolve(false)
        if (snapshot.redis.deleting) return Promise.resolve(false)
        patchRedis({ deleting: true, deleteError: null })
        return post('redis.del', { key }).then(() => {
          patchScan({ keys: snapshot.redis.scan.keys.filter((entry) => entry !== key), scanned: Math.max(0, snapshot.redis.scan.keys.length - 1) })
          patchRedis({
            deleting: false,
            deleteError: null,
            selected: snapshot.redis.selected.key === key ? emptySelectedKey() : snapshot.redis.selected,
          })
          return true
        }).catch((error) => {
          patchRedis({ deleting: false, deleteError: describeFailure(error) })
          return false
        })
      }

      // -----------------------------------------------------------------
      // Redis server section and key editors
      // -----------------------------------------------------------------

      /** @returns {Promise<boolean>} whether the server cards were refreshed. */
      function loadRedisServer() {
        return Promise.all([requestDbSize(), requestClients()]).then(() => true)
      }

      /** @returns {Promise<boolean>} whether the DB size is current. */
      function requestDbSize() {
        if (dbsizeRequest !== null) return dbsizeRequest
        const previous = snapshot.redis.dbsize
        patchRedis({ dbsize: { status: previous.keys === null ? 'loading' : 'ready', keys: previous.keys, error: null } })
        const run = post('redis.dbsize', {}).then((value) => {
          const source = isRecord(value) ? value : {}
          patchRedis({ dbsize: { status: 'ready', keys: integerOf(source.keys, 0), error: null } })
          return true
        }).catch((error) => {
          patchRedis({ dbsize: { status: 'error', keys: null, error: describeFailure(error) } })
          return false
        }).then((result) => {
          dbsizeRequest = null
          return result
        }, (error) => {
          dbsizeRequest = null
          throw error
        })
        dbsizeRequest = run
        return run
      }

      /** @returns {Promise<boolean>} whether the client table is current. */
      function requestClients() {
        if (clientsRequest !== null) return clientsRequest
        const previous = snapshot.redis.clients
        patchRedis({
          clients: Object.assign({}, previous, previous.list.length === 0
            ? { status: 'loading', error: null, refreshing: false }
            : { refreshing: true, error: null }),
        })
        const run = post('redis.clients', {}).then((value) => {
          const source = isRecord(value) ? value : {}
          const list = Array.isArray(source.clients) ? source.clients.filter(isRecord).map((client) => ({
            id: textOf(client.id, ''),
            addr: textOf(client.addr, ''),
            name: textOf(client.name, ''),
            ageSeconds: integerOf(client.ageSeconds, 0),
            idleSeconds: integerOf(client.idleSeconds, 0),
            db: integerOf(client.db, 0),
            command: textOf(client.command, ''),
            user: textOf(client.user, ''),
          })) : []
          patchRedis({ clients: { status: 'ready', list, error: null, refreshing: false } })
          return true
        }).catch((error) => {
          patchRedis({ clients: Object.assign({}, snapshot.redis.clients, { status: 'error', error: describeFailure(error), refreshing: false }) })
          return false
        }).then((result) => {
          clientsRequest = null
          return result
        }, (error) => {
          clientsRequest = null
          throw error
        })
        clientsRequest = run
        return run
      }

      /** @returns {Promise<boolean>} whether the server cards were refreshed. */
      function refreshRedisServer() {
        return Promise.all([requestDbSize(), requestClients()]).then(() => true)
      }

      /**
       * Read the memory footprint of one key.
       *
       * @param {string} [key] - the key; defaults to the selected one.
       * @returns {Promise<boolean>} whether the value is current.
       */
      function loadKeyMemory(key) {
        const target = textOf(key, snapshot.redis.selected.key)
        if (target === '') return Promise.resolve(false)
        if (memoryRequest !== null) return memoryRequest
        const run = post('redis.memory', { key: target }).then((value) => {
          if (snapshot.redis.selected.key !== target) return false
          const source = isRecord(value) ? value : {}
          patchRedis({
            selected: Object.assign({}, snapshot.redis.selected, {
              memory: {
                status: 'ready',
                data: { bytes: integerOf(source.bytes, 0), human: textOf(source.human, formatBytes(integerOf(source.bytes, 0))) },
                error: null,
              },
            }),
          })
          return true
        }).catch((error) => {
          if (snapshot.redis.selected.key !== target) return false
          patchRedis({
            selected: Object.assign({}, snapshot.redis.selected, {
              memory: { status: 'error', data: null, error: describeFailure(error) },
            }),
          })
          return false
        }).then((result) => {
          memoryRequest = null
          return result
        }, (error) => {
          memoryRequest = null
          throw error
        })
        memoryRequest = run
        return run
      }

      /**
       * @param {string} field - field | value | member | side.
       * @param {string} value - the new value.
       * @returns {void}
       */
      function setRedisEditor(field, value) {
        if (['field', 'value', 'member', 'side'].indexOf(field) < 0) return
        patchRedis({
          editor: Object.assign({}, snapshot.redis.editor, {
            [field]: value,
            status: 'idle',
            error: null,
            notice: null,
          }),
        })
      }

      /**
       * Write the type-specific editor for the selected key.
       *
       * @returns {Promise<boolean>} whether the write succeeded.
       */
      function submitRedisEditor() {
        const selected = snapshot.redis.selected
        const detail = selected.detail
        if (detail === null || selected.status !== 'ready') return Promise.resolve(false)
        const type = detail.type
        const editor = snapshot.redis.editor
        const key = selected.key
        let endpoint
        let payload
        let notice
        if (type === 'hash') {
          if (editor.field.trim() === '') return Promise.resolve(false)
          endpoint = 'redis.hashSet'
          payload = { key, field: editor.field, value: editor.value }
        } else if (type === 'list') {
          endpoint = 'redis.listPush'
          payload = { key, value: editor.value, side: editor.side === 'left' ? 'left' : 'right' }
        } else if (type === 'set') {
          if (editor.member.trim() === '') return Promise.resolve(false)
          endpoint = 'redis.setAdd'
          payload = { key, member: editor.member }
        } else {
          return Promise.resolve(false)
        }
        patchRedis({ editor: Object.assign({}, editor, { status: 'running', error: null, notice: null }) })
        return post(endpoint, payload).then((value) => {
          const source = isRecord(value) ? value : {}
          if (type === 'hash') {
            notice = { code: 'redis.editor.notice.hashSet', params: { field: editor.field, count: integerOf(source.fieldCount, 0) } }
          } else if (type === 'list') {
            notice = { code: 'redis.editor.notice.listPush', params: { length: integerOf(source.length, 0) } }
          } else {
            notice = { code: 'redis.editor.notice.setAdd', params: { length: integerOf(source.length, 0) } }
          }
          patchRedis({
            editor: Object.assign({}, snapshot.redis.editor, { status: 'idle', error: null, notice }),
          })
          void selectRedisKey(key)
          return true
        }).catch((error) => {
          patchRedis({
            editor: Object.assign({}, snapshot.redis.editor, { status: 'idle', error: describeFailure(error), notice: null }),
          })
          return false
        })
      }

      /**
       * Remove one member from a Redis set through the editor's member field.
       *
       * @returns {Promise<boolean>} whether the command succeeded.
       */
      function removeRedisSetMember() {
        const selected = snapshot.redis.selected
        if (selected.detail === null || selected.detail.type !== 'set') return Promise.resolve(false)
        const editor = snapshot.redis.editor
        const member = editor.member.trim()
        if (member === '') return Promise.resolve(false)
        patchRedis({ editor: Object.assign({}, editor, { status: 'running', error: null, notice: null }) })
        return post('redis.setRemove', { key: selected.key, member }).then((value) => {
          const source = isRecord(value) ? value : {}
          const removed = source.removed === true
          const notice = removed
            ? { code: 'redis.editor.notice.setRemove', params: { length: integerOf(source.length, 0) } }
            : { code: 'redis.editor.notice.setAbsent', params: { length: integerOf(source.length, 0) } }
          patchRedis({ editor: Object.assign({}, snapshot.redis.editor, { status: 'idle', error: null, notice }) })
          void selectRedisKey(selected.key)
          return true
        }).catch((error) => {
          patchRedis({
            editor: Object.assign({}, snapshot.redis.editor, { status: 'idle', error: describeFailure(error), notice: null }),
          })
          return false
        })
      }

      /** @param {string} value - the rename draft. @returns {void} */
      function setRedisRenameDraft(value) {
        patchRedis({ renameDraft: value, action: Object.assign({}, snapshot.redis.action, { error: null, notice: null }) })
      }

      /** @param {string} value - the expire-TTL draft. @returns {void} */
      function setRedisExpireDraft(value) {
        patchRedis({ expireDraft: value, action: Object.assign({}, snapshot.redis.action, { error: null, notice: null }) })
      }

      /** @returns {Promise<boolean>} whether a rename confirmation was requested. */
      function requestRedisRename() {
        const key = snapshot.redis.selected.key
        const newKey = snapshot.redis.renameDraft.trim()
        if (key === '' || newKey === '' || newKey === key) return Promise.resolve(false)
        requestConfirm('redis.rename', { key, newKey })
        return Promise.resolve(true)
      }

      /** @returns {Promise<boolean>} whether an expire confirmation was requested. */
      function requestRedisExpire() {
        const key = snapshot.redis.selected.key
        const ttlSeconds = Number(snapshot.redis.expireDraft)
        if (key === '' || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 31536000) {
          return Promise.resolve(false)
        }
        requestConfirm('redis.expire', { key, ttlSeconds })
        return Promise.resolve(true)
      }

      /**
       * @param {string} key - the old name.
       * @param {string} newKey - the new name.
       * @returns {Promise<boolean>} whether the rename succeeded.
       */
      function renameRedisKey(key, newKey) {
        if (key === '' || newKey === '') return Promise.resolve(false)
        patchRedis({ action: { status: 'running', notice: null, error: null } })
        return post('redis.rename', { key, newKey }).then(() => {
          patchRedis({
            renameDraft: '',
            action: { status: 'idle', notice: { code: 'redis.key.notice.renamed', params: { key: newKey } }, error: null },
          })
          patchScan({ keys: snapshot.redis.scan.keys.map((entry) => (entry === key ? newKey : entry)) })
          if (snapshot.redis.selected.key === key) {
            patchRedis({ selected: Object.assign({}, emptySelectedKey(), { key: newKey }) })
            void selectRedisKey(newKey)
          }
          return true
        }).catch((error) => {
          patchRedis({ action: { status: 'idle', notice: null, error: describeFailure(error) } })
          return false
        })
      }

      /**
       * @param {string} key - the key.
       * @param {number} ttlSeconds - the TTL, 1..31536000.
       * @returns {Promise<boolean>} whether the expire succeeded.
       */
      function expireRedisKey(key, ttlSeconds) {
        if (key === '') return Promise.resolve(false)
        patchRedis({ action: { status: 'running', notice: null, error: null } })
        return post('redis.expire', { key, ttlSeconds }).then(() => {
          patchRedis({
            expireDraft: '',
            action: { status: 'idle', notice: { code: 'redis.key.notice.expired', params: { seconds: ttlSeconds } }, error: null },
          })
          void selectRedisKey(key)
          return true
        }).catch((error) => {
          patchRedis({ action: { status: 'idle', notice: null, error: describeFailure(error) } })
          return false
        })
      }

      /** @returns {Promise<boolean>} whether the TTL was removed. */
      function persistRedisKey() {
        const key = snapshot.redis.selected.key
        if (key === '') return Promise.resolve(false)
        patchRedis({ action: { status: 'running', notice: null, error: null } })
        return post('redis.persist', { key }).then(() => {
          patchRedis({ action: { status: 'idle', notice: { code: 'redis.key.notice.persisted', params: {} }, error: null } })
          void selectRedisKey(key)
          return true
        }).catch((error) => {
          patchRedis({ action: { status: 'idle', notice: null, error: describeFailure(error) } })
          return false
        })
      }

      /**
       * The payload for a PostgreSQL call: the selected database, omitted when
       * the panel is still on the configured default.
       *
       * @param {object} [extra] - additional payload fields.
       * @returns {object} the payload.
       */
      function pgPayload(extra) {
        const payload = extra === undefined ? {} : Object.assign({}, extra)
        if (snapshot.postgres.database !== '') payload.database = snapshot.postgres.database
        return payload
      }

      /**
       * Read the PostgreSQL tab: identity, databases, then the table list. The
       * version probe from bootstrap is reused for the first paint so opening
       * the tab costs one connection, not two.
       *
       * @param {{ force?: boolean }} [options] - reload options.
       * @returns {Promise<boolean>} whether the tab is current.
       */
      function loadPostgres(options) {
        const settings = options === undefined ? {} : options
        if (postgresRequest !== null) return postgresRequest
        const force = settings.force === true
        const first = snapshot.postgres.status !== 'ready'
        patchPostgres(first
          ? { status: 'loading', error: null, refreshing: false }
          : { refreshing: true, error: null })
        const run = (async () => {
          try {
            let versionValue = !force && snapshot.postgres.version.status === 'ready'
              ? snapshot.postgres.version.value
              : null
            if (versionValue === null) {
              versionValue = await post('pg.version', pgPayload({}))
              patchPostgres({ version: { status: 'ready', value: versionValue, error: null } })
              setConnection('postgres', { status: 'ok', detail: shortPgVersion(versionValue === null || versionValue === undefined ? '' : versionValue.version) })
            }
            if (snapshot.postgres.databases.length === 0) {
              try {
                const value = await post('pg.databases', {})
                const source = isRecord(value) ? value : {}
                const databases = Array.isArray(source.databases) ? source.databases : []
                patchPostgres({ databases, databasesError: null })
              } catch (error) {
                patchPostgres({ databasesError: describeFailure(error) })
              }
            }
            if (snapshot.postgres.database === '') {
              const source = isRecord(versionValue) ? versionValue : {}
              const configured = snapshot.settings === null ? null : snapshot.settings.postgres.database
              const candidate = typeof source.currentDatabase === 'string' && source.currentDatabase !== ''
                ? source.currentDatabase
                : configured
              if (typeof candidate === 'string' && candidate !== '') patchPostgres({ database: candidate })
            }
            await loadPgTables(snapshot.postgres.database)
            patchPostgres({ status: 'ready', error: null, refreshing: false })
            return true
          } catch (error) {
            const failure = describeFailure(error)
            patchPostgres({
              status: snapshot.postgres.tables.status === 'ready' ? 'ready' : 'error',
              error: failure,
              refreshing: false,
              version: snapshot.postgres.version.status === 'ready'
                ? snapshot.postgres.version
                : { status: 'error', value: null, error: failure },
            })
            if (failure.code !== 'invalid_payload') {
              setConnection('postgres', { status: 'down', detail: failure.message })
            }
            return false
          }
        })()
        postgresRequest = run.then((value) => {
          postgresRequest = null
          return value
        }, (error) => {
          postgresRequest = null
          throw error
        })
        return postgresRequest
      }

      /**
       * @param {string} database - the selected database.
       * @returns {Promise<boolean>} whether the table list is current.
       */
      function loadPgTables(database) {
        if (pgTablesRequest !== null) return pgTablesRequest
        patchTables({ status: 'loading', error: null })
        const payload = {}
        if (typeof database === 'string' && database !== '') payload.database = database
        const run = post('pg.tables', payload).then((value) => {
          const source = isRecord(value) ? value : {}
          const list = Array.isArray(source.tables) ? source.tables : []
          patchTables({ status: 'ready', list, error: null })
          const selected = snapshot.postgres.selected
          if (selected.name !== '' && !list.some((table) => isRecord(table) && table.schema === selected.schema && table.name === selected.name)) {
            patchPostgres({ selected: emptySelectedTable() })
          }
          return true
        }).catch((error) => {
          patchTables({ status: 'error', error: describeFailure(error) })
          return false
        }).then((result) => {
          pgTablesRequest = null
          return result
        }, (error) => {
          pgTablesRequest = null
          throw error
        })
        pgTablesRequest = run
        return run
      }

      /**
       * @param {string} database - the new database selection.
       * @returns {Promise<boolean>} whether the tables were reloaded.
       */
      function selectDatabase(database) {
        if (typeof database !== 'string' || database === snapshot.postgres.database) return Promise.resolve(true)
        patchPostgres({ database, selected: emptySelectedTable(), query: { status: 'idle', result: null, error: null } })
        return loadPgTables(database)
      }

      /** @param {string} value - the table filter. @returns {void} */
      function setPgFilter(value) {
        patchPostgres({ filter: value })
      }

      /**
       * Read one table's columns.
       *
       * @param {string} schema - the schema name.
       * @param {string} name - the table name.
       * @returns {Promise<boolean>} whether the columns are current.
       */
      function selectTable(schema, name) {
        if (typeof schema !== 'string' || typeof name !== 'string' || name === '') return Promise.resolve(false)
        if (tableDetailRequest !== null) return tableDetailRequest
        patchPostgres({
          selected: Object.assign({}, emptySelectedTable(), {
            schema,
            name,
            columns: { status: 'loading', list: [], error: null },
            detail: { status: 'loading', value: null, error: null, tab: snapshot.postgres.selected.detail.tab },
          }),
          browse: emptyBrowse(),
        })
        const run = post('pg.tableDetail', pgPayload({ schema, table: name })).then((value) => {
          const current = snapshot.postgres.selected
          if (current.schema !== schema || current.name !== name) return false
          const source = isRecord(value) ? value : {}
          const columns = Array.isArray(source.columns) ? source.columns.filter(isRecord) : []
          const detail = {
            size: textOf(source.size, ''),
            estimatedRows: typeof source.estimatedRows === 'number' ? source.estimatedRows : null,
            comment: typeof source.comment === 'string' ? source.comment : null,
            columns,
            indexes: Array.isArray(source.indexes) ? source.indexes.filter(isRecord) : [],
            constraints: Array.isArray(source.constraints) ? source.constraints.filter(isRecord) : [],
          }
          patchPostgres({
            selected: Object.assign({}, snapshot.postgres.selected, {
              columns: { status: 'ready', list: columns, error: null },
              detail: { status: 'ready', value: detail, error: null, tab: snapshot.postgres.selected.detail.tab },
            }),
          })
          void loadBrowse({ reset: true })
          return true
        }).catch((error) => {
          const current = snapshot.postgres.selected
          if (current.schema !== schema || current.name !== name) return false
          const failure = describeFailure(error)
          patchPostgres({
            selected: Object.assign({}, snapshot.postgres.selected, {
              columns: { status: 'error', list: [], error: failure },
              detail: { status: 'error', value: null, error: failure, tab: snapshot.postgres.selected.detail.tab },
            }),
          })
          return false
        }).then((result) => {
          tableDetailRequest = null
          return result
        }, (error) => {
          tableDetailRequest = null
          throw error
        })
        tableDetailRequest = run
        return run
      }

      /**
       * Read the PostgreSQL session activity for the visible database.
       *
       * @returns {Promise<boolean>} whether the activity is current.
       */
      function loadActivity() {
        if (activityRequest !== null) return activityRequest
        const previous = snapshot.postgres.activity
        patchPostgres({
          activity: Object.assign({}, previous, previous.list.length === 0
            ? { status: 'loading', error: null, refreshing: false }
            : { refreshing: true, error: null }),
        })
        const payload = {}
        if (snapshot.postgres.database !== '') payload.database = snapshot.postgres.database
        const run = post('pg.activity', payload).then((value) => {
          const source = isRecord(value) ? value : {}
          const list = Array.isArray(source.sessions) ? source.sessions.filter(isRecord) : []
          patchPostgres({ activity: { status: 'ready', list, error: null, refreshing: false } })
          return true
        }).catch((error) => {
          patchPostgres({
            activity: Object.assign({}, snapshot.postgres.activity, {
              status: 'error',
              error: describeFailure(error),
              refreshing: false,
            }),
          })
          return false
        }).then((result) => {
          activityRequest = null
          return result
        }, (error) => {
          activityRequest = null
          throw error
        })
        activityRequest = run
        return run
      }

      /**
       * @param {string} tab - columns | indexes | constraints.
       * @returns {void}
       */
      function setTableDetailTab(tab) {
        if (['columns', 'indexes', 'constraints'].indexOf(tab) < 0) return
        patchPostgres({
          selected: Object.assign({}, snapshot.postgres.selected, {
            detail: Object.assign({}, snapshot.postgres.selected.detail, { tab }),
          }),
        })
      }

      /**
       * The `pg.browse` payload for one page, ordering by the first column so
       * paging is deterministic.
       *
       * @param {number} page - zero-based page.
       * @param {number} pageSize - rows per page.
       * @returns {object} the payload.
       */
      function browsePayload(page, pageSize) {
        const selected = snapshot.postgres.selected
        const payload = pgPayload({
          schema: selected.schema,
          table: selected.name,
          limit: pageSize,
          offset: page * pageSize,
          withCount: true,
        })
        const detail = selected.detail.value
        const columns = isRecord(detail) && Array.isArray(detail.columns) ? detail.columns : []
        const first = columns.find((column) => isRecord(column) && typeof column.name === 'string' && column.name !== '')
        if (first !== undefined) {
          payload.orderBy = first.name
          payload.descending = false
        }
        return payload
      }

      /**
       * Read one page of the selected table through `pg.browse`.
       *
       * @param {{ reset?: boolean, page?: number, pageSize?: number }} [options] - paging options.
       * @returns {Promise<boolean>} whether the page is current.
       */
      function loadBrowse(options) {
        const settings = options === undefined ? {} : options
        if (snapshot.postgres.selected.name === '') return Promise.resolve(false)
        if (browseRequest !== null) return browseRequest
        const previous = snapshot.postgres.browse
        const page = settings.reset === true ? 0 : integerOf(settings.page, previous.page)
        const pageSize = integerOf(settings.pageSize, previous.pageSize)
        const payload = browsePayload(page, pageSize)
        patchPostgres({ browse: Object.assign({}, previous, { status: 'loading', error: null, page, pageSize }) })
        const run = post('pg.browse', payload).then((value) => {
          const source = isRecord(value) ? value : {}
          patchPostgres({
            browse: {
              status: 'ready',
              columns: Array.isArray(source.columns) ? source.columns.filter(isRecord) : [],
              rows: Array.isArray(source.rows) ? source.rows : [],
              page,
              pageSize,
              totalRows: typeof source.totalRows === 'number' ? source.totalRows : null,
              limitedBy: typeof source.limitedBy === 'string' ? source.limitedBy : null,
              error: null,
            },
          })
          return true
        }).catch((error) => {
          patchPostgres({
            browse: Object.assign({}, snapshot.postgres.browse, { status: 'error', error: describeFailure(error) }),
          })
          return false
        }).then((result) => {
          browseRequest = null
          return result
        }, (error) => {
          browseRequest = null
          throw error
        })
        browseRequest = run
        return run
      }

      /**
       * @param {number|string} size - one of PG_PAGE_SIZES.
       * @returns {Promise<boolean>} whether the first page of the new size is loaded.
       */
      function setBrowsePageSize(size) {
        const value = Number(size)
        const pageSize = PG_PAGE_SIZES.indexOf(value) >= 0 ? value : 50
        return loadBrowse({ page: 0, pageSize })
      }

      /**
       * @param {number} delta - -1 for previous, 1 for next.
       * @returns {Promise<boolean>} whether the page loaded.
       */
      function browsePage(delta) {
        const previous = snapshot.postgres.browse
        const next = Math.max(0, previous.page + integerOf(delta, 0))
        if (next === previous.page) return Promise.resolve(false)
        return loadBrowse({ page: next })
      }

      /**
       * @param {unknown} payload - a query, browse or result-set value.
       * @returns {string} its CSV rendering.
       */
      function resultCsvOf(payload) {
        return resultCsv(payload)
      }

      /**
       * Download a result grid as CSV. A no-op (returns false) in environments
       * without Blob / URL support, so the panel never throws.
       *
       * @param {unknown} payload - a query, browse or result-set value.
       * @returns {boolean} whether a download started.
       */
      function downloadResult(payload) {
        const csv = resultCsv(payload)
        if (csv === '') return false
        if (typeof document === 'undefined' || typeof Blob !== 'function' || typeof URL === 'undefined' ||
          typeof URL.createObjectURL !== 'function') return false
        const selected = snapshot.postgres.selected
        const name = selected.name === '' ? 'result' : `${selected.schema}.${selected.name}`
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        try {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `long-data-${name}.csv`
          if (typeof anchor.click === 'function') anchor.click()
        } finally {
          URL.revokeObjectURL(url)
        }
        return true
      }

      /**
       * Put a previous statement back in the editor.
       *
       * @param {string} sql - the statement.
       * @returns {void}
       */
      function restoreQuery(sql) {
        patchPostgres({ sql: textOf(sql, '') })
      }

      /**
       * Read the first 100 rows of the selected table.
       *
       * @returns {Promise<boolean>} whether the preview is current.
       */
      function previewTable() {
        const selected = snapshot.postgres.selected
        if (selected.name === '' || previewRequest !== null) return Promise.resolve(previewRequest === null ? false : previewRequest)
        const sql = `select * from ${quoteIdent(selected.schema)}.${quoteIdent(selected.name)} limit ${PG_PREVIEW_ROWS}`
        patchSelected('preview', { status: 'loading', result: null, error: null })
        const run = post('pg.query', pgPayload({ sql, maxRows: PG_PREVIEW_ROWS })).then((value) => {
          const current = snapshot.postgres.selected
          if (current.schema !== selected.schema || current.name !== selected.name) return false
          patchSelected('preview', { status: 'ready', result: isRecord(value) ? value : null, error: null })
          return true
        }).catch((error) => {
          const current = snapshot.postgres.selected
          if (current.schema !== selected.schema || current.name !== selected.name) return false
          patchSelected('preview', { status: 'error', result: null, error: describeFailure(error) })
          return false
        }).then((result) => {
          previewRequest = null
          return result
        }, (error) => {
          previewRequest = null
          throw error
        })
        previewRequest = run
        return run
      }

      /** @param {string} value - the SQL editor text. @returns {void} */
      function setPgSql(value) {
        patchPostgres({ sql: value })
      }

      /**
       * Run the SQL editor's statement.
       *
       * @returns {Promise<boolean>} whether the statement succeeded.
       */
      function runPgQuery() {
        if (queryRequest !== null) return queryRequest
        const sql = snapshot.postgres.sql.trim()
        if (sql === '') return Promise.resolve(false)
        patchPostgres({ query: { status: 'running', result: snapshot.postgres.query.result, error: null } })
        const run = post('pg.query', pgPayload({ sql, maxRows: PG_QUERY_MAX_ROWS })).then((value) => {
          const source = isRecord(value) ? value : {}
          const firstSet = Array.isArray(source.results) ? source.results.find(isRecord) : undefined
          const rows = firstSet !== undefined && Array.isArray(firstSet.rows) ? firstSet.rows.length : 0
          const entry = {
            sql,
            at: Date.now(),
            durationMs: integerOf(source.durationMs, 0),
            rows,
          }
          const history = [entry].concat(snapshot.postgres.queryHistory).slice(0, MAX_QUERY_HISTORY)
          patchPostgres({ query: { status: 'ready', result: isRecord(value) ? value : null, error: null }, queryHistory: history })
          return true
        }).catch((error) => {
          patchPostgres({ query: { status: 'error', result: null, error: describeFailure(error) } })
          return false
        }).then((result) => {
          queryRequest = null
          return result
        }, (error) => {
          queryRequest = null
          throw error
        })
        queryRequest = run
        return run
      }

      /**
       * @param {string} service - docker | redis | postgres.
       * @param {string} field - the form field.
       * @param {any} value - the new value.
       * @returns {void}
       */
      function setSettingsField(service, field, value) {
        if (!isRecord(snapshot.form[service])) return
        publish({
          form: Object.assign({}, snapshot.form, {
            [service]: Object.assign({}, snapshot.form[service], { [field]: value }),
          }),
          formDirty: true,
          ...(service === 'dockerfiles' ? { formDockerfilesDirty: true } : {}),
          saveError: null,
          saveNotice: false,
        })
      }

      /**
       * Save the settings form. Passwords are only sent when typed, so an empty
       * field means "keep the stored password"; a checked clear box deletes it.
       *
       * @returns {Promise<boolean>} whether the save was accepted.
       */
      function saveSettings() {
        if (snapshot.saving) return Promise.resolve(false)
        const form = snapshot.form
        const payload = {
          docker: { binary: form.docker.binary.trim() },
          redis: {
            mode: form.redis.mode === 'manual' ? 'manual' : 'docker',
            container: form.redis.container,
            host: form.redis.host.trim(),
            port: Number(form.redis.port),
            username: form.redis.username,
            db: Number(form.redis.db),
            tls: form.redis.tls === true,
          },
          postgres: {
            mode: form.postgres.mode === 'manual' ? 'manual' : 'docker',
            container: form.postgres.container,
            host: form.postgres.host.trim(),
            port: Number(form.postgres.port),
            user: form.postgres.user.trim(),
            database: form.postgres.database.trim(),
            ssl: form.postgres.ssl,
          },
        }
        if (form.redis.password !== '') payload.redis.password = form.redis.password
        if (form.redis.clearPassword === true) payload.redis.clearPassword = true
        if (form.postgres.password !== '') payload.postgres.password = form.postgres.password
        if (form.postgres.clearPassword === true) payload.postgres.clearPassword = true
        if (snapshot.formDockerfilesDirty) {
          payload.dockerfiles = {
            roots: form.dockerfiles.rootsText
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line !== ''),
            maxDepth: Number(form.dockerfiles.maxDepth),
          }
        }
        publish({ saving: true, saveError: null, saveNotice: false })
        return post('settings.save', payload).then(async (value) => {
          const settings = settingsView(value)
          publish({
            saving: false,
            settings,
            form: settingForm(settings),
            formDirty: false,
            formDockerfilesDirty: false,
            saveError: null,
            saveNotice: true,
          })
          // A save invalidates the Host's caches: refresh `state` for the
          // targets and rescan Dockerfiles so the new roots take effect.
          await bootstrap()
          if (snapshot.docker.dockerfiles.status === 'ready') void loadDockerfiles({ refresh: true })
          if (snapshot.overview.value !== null) void loadOverview()
          return true
        }).catch((error) => {
          publish({ saving: false, saveError: describeFailure(error) })
          return false
        })
      }

      /**
       * Test one connection from the settings page. Docker is probed through
       * `state` (the only endpoint that reports its availability); Redis and
       * PostgreSQL answer with their identity, which doubles as a latency check.
       *
       * @param {string} service - docker | redis | postgres.
       * @returns {Promise<boolean>} whether the test succeeded.
       */
      function testConnection(service) {
        if (snapshot.test.status === 'running') return Promise.resolve(false)
        publish({ test: { service, status: 'running', message: '', error: null } })
        const endpoint = service === 'docker' ? 'state' : service === 'redis' ? 'redis.ping' : 'pg.version'
        return post(endpoint, {}).then((value) => {
          const source = isRecord(value) ? value : {}
          if (service === 'docker') {
            const info = isRecord(source.docker) ? source.docker : null
            publish({
              dockerInfo: info,
              targets: normalizeTargets(source.targets),
              ...(snapshot.formDirty ? {} : { settings: settingsView(source.settings), form: settingForm(source.settings) }),
            })
            if (info !== null && info.available === true) {
              const detail = typeof info.version === 'string' ? info.version : textOf(info.binary, '')
              setConnection('docker', { status: 'ok', detail })
              publish({ test: { service, status: 'ok', message: detail, error: null } })
              return true
            }
            const message = info !== null && typeof info.error === 'string' ? info.error : ''
            setConnection('docker', { status: 'down', detail: message })
            publish({
              test: {
                service,
                status: 'error',
                message: '',
                error: { code: 'docker_unavailable', message, details: {} },
              },
            })
            return false
          }
          if (service === 'redis') {
            const version = typeof source.version === 'string' ? source.version : ''
            const latency = typeof source.latencyMs === 'number' ? `${source.latencyMs} ms` : ''
            const detail = [version, latency].filter((part) => part !== '').join(' · ')
            setConnection('redis', { status: 'ok', detail: version })
            publish({ test: { service, status: 'ok', message: detail, error: null } })
            return true
          }
          const version = shortPgVersion(source.version)
          const user = typeof source.currentUser === 'string' ? source.currentUser : ''
          const database = typeof source.currentDatabase === 'string' ? source.currentDatabase : ''
          const detail = `${version} · ${user}@${database}`
          setConnection('postgres', { status: 'ok', detail: version })
          patchPostgres({ version: { status: 'ready', value: source, error: null } })
          publish({ test: { service, status: 'ok', message: detail, error: null } })
          return true
        }).catch((error) => {
          const failure = describeFailure(error)
          if (service === 'docker') setConnection('docker', { status: 'down', detail: failure.message })
          else if (service === 'redis') setConnection('redis', { status: 'down', detail: failure.message })
          else setConnection('postgres', { status: 'down', detail: failure.message })
          publish({ test: { service, status: 'error', message: '', error: failure } })
          return false
        })
      }

      /**
       * Select a tab and make sure its primary data is loaded.
       *
       * @param {string} tab - a TABS member, or settings.
       * @returns {Promise<boolean>} whether the tab's data is loaded.
       */
      function selectTab(tab) {
        if (TABS.indexOf(tab) < 0 && tab !== 'settings') return Promise.resolve(false)
        if (snapshot.tab !== tab) {
          publish(tab === 'settings'
            ? { lastTab: snapshot.tab === 'settings' ? snapshot.lastTab : snapshot.tab, tab }
            : { tab })
        }
        return ensureTabLoaded(tab)
      }

      /**
       * Load the tab's data when it has never been read. Idempotent, so the
       * panel may call it from an effect on every render.
       *
       * @param {string} tab - a TABS member.
       * @returns {Promise<boolean>} whether the tab's data is loaded.
       */
      function ensureTabLoaded(tab) {
        // The overview carries the semantic roles the other tabs show as chips,
        // so opening a service tab also warms it up when it was never loaded.
        const overviewJob = tab !== 'overview' && tab !== 'settings' && snapshot.overview.status === 'idle'
          ? loadOverview()
          : null
        if (tab === 'docker') {
          const jobs = []
          if (snapshot.docker.status === 'idle') jobs.push(loadDocker())
          if (snapshot.docker.disk.status === 'idle') jobs.push(loadDiskUsage())
          jobs.push(ensureDockerSubTabLoaded(snapshot.docker.subTab))
          if (overviewJob !== null) jobs.push(overviewJob)
          return Promise.all(jobs).then(() => true)
        }
        if (tab === 'redis') {
          const jobs = []
          if (snapshot.redis.status === 'idle') jobs.push(loadRedis())
          if (overviewJob !== null) jobs.push(overviewJob)
          return Promise.all(jobs).then(() => true)
        }
        if (tab === 'postgres') {
          const jobs = []
          if (snapshot.postgres.status === 'idle') jobs.push(loadPostgres())
          if (snapshot.postgres.activity.status === 'idle') jobs.push(loadActivity())
          if (overviewJob !== null) jobs.push(overviewJob)
          return Promise.all(jobs).then(() => true)
        }
        if (tab === 'relations') {
          const jobs = []
          if (snapshot.relations.status === 'idle') jobs.push(loadRelations())
          if (overviewJob !== null) jobs.push(overviewJob)
          return Promise.all(jobs).then(() => true)
        }
        if (tab === 'overview' && snapshot.overview.status === 'idle') return loadOverview()
        return Promise.resolve(true)
      }

      /** Toggle the settings view, remembering the tab to return to. @returns {void} */
      function toggleSettings() {
        if (snapshot.tab === 'settings') {
          publish({ tab: snapshot.lastTab === 'settings' ? 'docker' : snapshot.lastTab })
          return
        }
        publish({ lastTab: snapshot.tab, tab: 'settings' })
      }

      /** Open the settings view from a notice. @returns {void} */
      function openSettings() {
        if (snapshot.tab !== 'settings') publish({ lastTab: snapshot.tab, tab: 'settings' })
      }

      /**
       * Poll the container list while the Docker tab is visible.
       *
       * The returned stop function is the effect cleanup: the panel effect runs
       * per tab, so switching tabs or unmounting tears the interval down. The
       * tick also skips when another Docker read is already in flight and when
       * the page is hidden, so a background window costs nothing.
       *
       * @param {number} [intervalMs] - the poll period.
       * @returns {() => void} the stop function.
       */
      function startDockerPolling(intervalMs) {
        const period = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
          ? intervalMs
          : DOCKER_POLL_MS
        let stopped = false
        const timer = setInterval(() => {
          if (stopped || snapshot.tab !== 'docker') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          const info = snapshot.dockerInfo
          if (info !== null && info !== undefined && info.available === false) return
          if (snapshot.docker.subTab === 'dockerfiles') return
          void loadVisibleDockerList({ silent: true })
        }, period)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }

      return {
        /** @returns {object} the current snapshot. */
        getSnapshot: () => snapshot,
        /**
         * @param {() => void} listener - called after every change.
         * @returns {() => void} the unsubscribe.
         */
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        bootstrap,
        refresh,
        selectTab,
        ensureTabLoaded,
        toggleSettings,
        openSettings,
        loadDocker,
        dockerAction,
        setDockerStateFilter,
        setDockerResourceFilter,
        selectDockerTab,
        ensureDockerSubTabLoaded,
        loadDiskUsage,
        loadDockerfiles,
        openDockerfile,
        loadDockerfile,
        closeDockerfile,
        loadImages,
        loadVolumes,
        loadNetworks,
        refreshDockerSubTab,
        removeImage,
        removeVolume,
        removeNetwork,
        requestContainerAction,
        requestImageRemove,
        requestVolumeRemove,
        requestNetworkRemove,
        requestRedisDelete,
        requestRedisRename,
        requestRedisExpire,
        renameRedisKey,
        expireRedisKey,
        persistRedisKey,
        setRedisRenameDraft,
        setRedisExpireDraft,
        loadRedisServer,
        refreshRedisServer,
        loadKeyMemory,
        setRedisEditor,
        submitRedisEditor,
        removeRedisSetMember,
        cancelConfirm,
        acceptConfirm,
        loadOverview,
        startCommands: Object.assign({}, START_COMMANDS),
        setViewMode,
        toggleHelp,
        closeHelp,
        copyText,
        openRedisWizard,
        closeRedisWizard,
        setRedisWizard,
        submitRedisWizard,
        fillSqlTemplate,
        loadRelations,
        setRelationsFilter,
        openRelationContainer,
        openRelationResource,
        selectInstance,
        inspectResource,
        loadInspect,
        closeInspect,
        loadActivity,
        setTableDetailTab,
        loadBrowse,
        setBrowsePageSize,
        browsePage,
        resultCsv: resultCsvOf,
        downloadResult,
        restoreQuery,
        setDockerFilter,
        toggleLogs,
        closeLogs,
        setLogTail,
        loadLogs,
        toggleDetail,
        closeDetail,
        loadDetail,
        loadRedis,
        scanRedis,
        scanMore,
        setRedisScan,
        selectRedisKey,
        setRedisField,
        submitRedisSet,
        deleteRedisKey,
        loadPostgres,
        selectDatabase,
        setPgFilter,
        selectTable,
        previewTable,
        setPgSql,
        runPgQuery,
        setSettingsField,
        saveSettings,
        testConnection,
        startDockerPolling,
      }
    }

    /**
     * Subscribe a component to the client.
     *
     * @param {object} client - the panel's data layer.
     * @returns {object} the current snapshot.
     */
    function useSnapshot(client) {
      const [snapshot, setSnapshot] = React.useState(() => client.getSnapshot())
      React.useEffect(() => client.subscribe(() => setSnapshot(client.getSnapshot())), [client])
      return snapshot
    }

    /**
     * The one failure notice used everywhere. Beginner mode explains the
     * failure in plain words plus a "what you can do" hint; expert mode keeps
     * the raw Host message and code path.
     *
     * @param {object} props - notice props.
     * @returns {object|null} the notice element, or null without a failure.
     */
    function ErrorNotice({ error, t, onRetry, retryLabel, mode }) {
      if (error === null || error === undefined) return null
      const retry = onRetry === undefined || onRetry === null
        ? null
        : h('button', {
            key: 'retry',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: onRetry,
          }, retryLabel === undefined ? t('retry') : retryLabel)
      if (mode !== 'expert') {
        const keys = friendlyErrorKeys(error.code)
        return h('div', { className: 'dshDataNotice dshDataNoticeError', role: 'alert' }, [
          h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, alertGlyph()),
          h('div', { key: 'body', className: 'dshDataNoticeBody' }, [
            h('p', { key: 'text', className: 'dshDataNoticeText' }, t(keys.message)),
            h('p', { key: 'hint', className: 'dshDataNoticeDetail' }, `${t('plain.hintPrefix')}${t(keys.hint)}`),
          ]),
          retry,
        ])
      }
      const message = typeof error.message === 'string' ? error.message : ''
      return h('div', { className: 'dshDataNotice dshDataNoticeError', role: 'alert' }, [
        h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, alertGlyph()),
        h('p', { key: 'text', className: 'dshDataNoticeText' }, t(errorMessageKey(error.code), { message })),
        retry,
      ])
    }

    /**
     * One header chip: the service, its resolved target (or the running-instance
     * count when several are ambiguous) and the probe result as the tone.
     *
     * @param {object} props - chip props.
     * @returns {object} the connection status chip.
     */
    function ConnectionChip({ service, connection, t, onSelect, target, mode }) {
      const status = connection.status === undefined ? 'unknown' : connection.status
      const serviceLabel = t(`chip.${service}`)
      const statusLabel = t(`chip.status.${status}`)
      const targetState = target === undefined ? null : target
      const instances = targetState !== null && Array.isArray(targetState.instances) ? targetState.instances : []
      const resolved = targetState !== null && isRecord(targetState.resolved) ? targetState.resolved : null
      const failure = targetState === null ? null : targetState.error
      let targetText = ''
      if (resolved !== null) targetText = targetLabel(resolved)
      else if (mode === 'docker' && instances.length > 1) targetText = t('chip.instances', { count: instances.length })
      else if (mode === 'docker' && instances.length === 1) targetText = instances[0].container
      else if (mode === 'docker' && failure !== null) targetText = t('chip.noRunning')
      let tone = status
      if (mode === 'docker' && failure !== null) {
        tone = 'warn'
      } else if (tone !== 'down') {
        if (instances.length > 1 && resolved === null) tone = 'warn'
        else if (resolved !== null && resolved.mode === 'docker' && targetState !== null) {
          const container = typeof resolved.container === 'string' ? resolved.container : ''
          const candidate = targetState.candidates.find((entry) => entry.name === container)
          if (candidate !== undefined && candidate.running !== true) tone = 'warn'
        }
      }
      const toneClass = tone === 'ok' ? 'Ok' : tone === 'down' ? 'Down' : tone === 'warn' ? 'Warn' : tone === 'checking' ? 'Checking' : 'Unknown'
      const aria = targetText === ''
        ? t('chip.aria', { service: serviceLabel, status: statusLabel })
        : t('chip.ariaTarget', { service: serviceLabel, target: targetText, status: statusLabel })
      return h('button', {
        type: 'button',
        className: `dshDataChip dshDataChip${toneClass}`,
        title: connection.detail === '' ? aria : `${aria} · ${connection.detail}`,
        'aria-label': aria,
        onClick: onSelect,
      }, [
        h('span', { key: 'dot', className: 'dshDataChipDot', 'aria-hidden': true }),
        h('span', { key: 'label', className: 'dshDataChipLabel' }, serviceLabel),
        targetText === '' ? null : h('span', { key: 'target', className: 'dshDataChipTarget' }, ` · ${targetText}`),
      ])
    }

    /**
     * A labelled form control, with an optional hint under it.
     *
     * @param {object} props - field props.
     * @returns {object} the field element.
     */
    function FormField({ id, label, hint, children }) {
      return h('div', { className: 'dshDataField' }, [
        h('label', { key: 'label', className: 'dshDataFieldLabel', htmlFor: id }, label),
        children,
        hint === undefined || hint === null
          ? null
          : h('span', { key: 'hint', className: 'dshDataFieldHint' }, hint),
      ])
    }

    /**
     * @param {object} props - chip props.
     * @returns {object|null} the semantic role chip.
     */
    function RoleChip({ role, t }) {
      if (typeof role !== 'string' || role === '') return null
      return h('span', { className: 'dshDataRoleChip' }, t(`plain.role.${roleKeyOf(role)}`))
    }

    /**
     * @param {object} props - banner props.
     * @returns {object} the one-line "what is this" banner.
     */
    function PlainBanner({ tab, t }) {
      return h('div', { className: 'dshDataPlainBanner' }, [
        h('span', { key: 'icon', className: 'dshDataPlainBannerIcon', 'aria-hidden': true }, infoGlyph()),
        h('p', { key: 'text', className: 'dshDataPlainBannerText' }, t(`plain.banner.${tab}`)),
      ])
    }

    /**
     * A copy button with transient "copied" feedback.
     *
     * @param {object} props - copy props.
     * @returns {object} the button.
     */
    function CopyButton({ client, snapshot, t, text, copyKey, label }) {
      const copied = snapshot.copied.key !== '' && snapshot.copied.key === copyKey
      const caption = label === undefined ? t('plain.copy') : label
      return h('button', {
        type: 'button',
        className: copied ? 'dshDataCopyButton dshDataCopied' : 'dshDataCopyButton',
        title: caption,
        'aria-label': caption,
        onClick: () => { client.copyText(text, copyKey) },
      }, [
        copied ? checkGlyph() : copyGlyph(),
        copied ? t('plain.copied') : caption,
      ])
    }

    /**
     * A native `<details>` block for beginner-mode technical content. The
     * children stay in the tree (and reachable), just collapsed by default.
     *
     * @param {object} props - block props.
     * @returns {object} the details element.
     */
    function DetailsBlock({ t, summary, children, open }) {
      return h('details', { className: 'dshDataDetails', open: open === true ? true : undefined }, [
        h('summary', { key: 'summary' }, summary === undefined ? t('plain.advanced') : summary),
        h('div', { key: 'body', className: 'dshDataDetailsBody' }, children),
      ])
    }

    /**
     * @param {object} props - toggle props.
     * @returns {object} the beginner/expert segmented control.
     */
    function ModeToggle({ client, t, mode }) {
      return h('div', {
        className: 'dshDataModeToggle',
        role: 'group',
        'aria-label': t('plain.view.aria'),
      }, ['beginner', 'expert'].map((value) => h('button', {
        key: value,
        type: 'button',
        className: mode === value ? 'dshDataModeButton dshDataModeButtonActive' : 'dshDataModeButton',
        'aria-pressed': mode === value,
        onClick: () => client.setViewMode(value),
      }, t(`plain.view.${value}`))))
    }

    /**
     * The help / glossary drawer.
     *
     * @param {object} props - drawer props.
     * @returns {object|null} the drawer overlay.
     */
    function HelpDrawer({ client, snapshot, t }) {
      const open = snapshot.helpOpen
      const closeRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        if (closeRef.current !== null) closeRef.current.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            client.closeHelp()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [open, client])
      if (!open) return null
      const sections = [
        {
          key: 'concepts',
          title: 'plain.help.concepts',
          items: [
            ['plain.help.docker', 'plain.help.docker.desc'],
            ['plain.help.container', 'plain.help.container.desc'],
            ['plain.help.image', 'plain.help.image.desc'],
            ['plain.help.volume', 'plain.help.volume.desc'],
            ['plain.help.network', 'plain.help.network.desc'],
            ['plain.help.port', 'plain.help.port.desc'],
          ],
        },
        {
          key: 'redis',
          title: 'plain.help.redis',
          items: [
            ['plain.help.redis.what', 'plain.help.redis.what.desc'],
            ['plain.help.redis.key', 'plain.help.redis.key.desc'],
            ['plain.help.redis.ttl', 'plain.help.redis.ttl.desc'],
          ],
        },
        {
          key: 'postgres',
          title: 'plain.help.postgres',
          items: [
            ['plain.help.pg.database', 'plain.help.pg.database.desc'],
            ['plain.help.pg.table', 'plain.help.pg.table.desc'],
            ['plain.help.pg.column', 'plain.help.pg.column.desc'],
            ['plain.help.pg.sql', 'plain.help.pg.sql.desc'],
          ],
        },
        {
          key: 'faq',
          title: 'plain.help.faq',
          items: [
            ['plain.help.faq.stop', 'plain.help.faq.stop.desc'],
            ['plain.help.faq.removeVolume', 'plain.help.faq.removeVolume.desc'],
            ['plain.help.faq.multi', 'plain.help.faq.multi.desc'],
            ['plain.help.faq.unreachable', 'plain.help.faq.unreachable.desc'],
          ],
        },
      ]
      return h('div', {
        className: 'dshDataOverlay',
        onClick: (event) => {
          if (event.target === event.currentTarget) client.closeHelp()
        },
      }, [
        h('div', { key: 'backdrop', className: 'dshDataBackdrop', onClick: () => client.closeHelp(), 'aria-hidden': true }),
        h('div', {
          key: 'drawer',
          ref: dialogRef,
          className: 'dshDataModal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': `${NS}-help-title`,
        }, [
          h('div', { key: 'head', className: 'dshDataModalHead' }, [
            h('h2', { key: 'title', id: `${NS}-help-title`, className: 'dshDataModalTitle' }, t('plain.help.title')),
            h('div', { key: 'actions', className: 'dshDataModalActions' }, h('button', {
              key: 'close',
              ref: closeRef,
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact',
              onClick: () => client.closeHelp(),
            }, t('plain.close'))),
          ]),
          h('div', { key: 'body', className: 'dshDataModalBody' }, sections.map((section) => h('section', {
            key: section.key,
            className: 'dshDataHelpSection',
          }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t(section.title)),
            h('ul', { key: 'items', className: 'dshDataHelpList' }, section.items.map(([term, desc]) => h('li', {
              key: term,
              className: 'dshDataHelpItem',
            }, [
              h('p', { key: 'term', className: 'dshDataHelpTerm' }, t(term)),
              h('p', { key: 'desc', className: 'dshDataHelpDesc' }, t(desc)),
            ]))),
          ]))),
        ]),
      ])
    }

    /**
     * @param {object} overview - the overview value.
     * @returns {{level: string, sentenceKey: string, problems: number, warnings: number}} status.
     */
    function overviewStatus(overview) {
      const danger = overview.insights.filter((insight) => insight.level === 'danger').length
      const warn = overview.insights.filter((insight) => insight.level === 'warn').length
      if (danger > 0) return { level: 'danger', count: danger }
      if (warn > 0) return { level: 'warn', count: warn }
      return { level: 'good', count: 0 }
    }

    /**
     * @param {object} snapshot - the panel snapshot.
     * @returns {object} an overview-shaped fallback built from the v0.3 state.
     */
    function fallbackOverview(snapshot) {
      const info = snapshot.dockerInfo
      const containers = snapshot.docker.containers
      const running = containers.filter((container) => isRecord(container) && container.state === 'running').length
      const stopCount = containers.filter((container) => isRecord(container) && (container.state === 'exited' || container.state === 'created' || container.state === 'dead')).length
      const serviceHealth = (service) => {
        const target = snapshot.targets[service]
        const instances = target === undefined ? 0 : target.instances.length
        const failure = target === undefined ? null : target.error
        const connection = snapshot.connections[service]
        return {
          mode: snapshot.settings === null ? 'docker' : snapshot.settings[service].mode,
          container: target !== undefined && target.resolved !== null && typeof target.resolved.container === 'string' ? target.resolved.container : null,
          reachable: connection.status === 'ok',
          version: connection.status === 'ok' ? textOf(connection.detail, '') : null,
          instances,
          ambiguous: failure !== null && typeof failure.code === 'string' && failure.code.endsWith('_ambiguous_container'),
          summary: {},
          error: failure === null ? null : { code: failure.code, message: failure.message },
        }
      }
      return {
        generatedAt: '',
        docker: {
          available: info !== null && info !== undefined && info.available === true,
          version: info !== null && info !== undefined && typeof info.version === 'string' ? info.version : null,
          error: info !== null && info !== undefined && typeof info.error === 'string' ? info.error : null,
        },
        counts: {
          containers: containers.length,
          running,
          stopped: stopCount,
          images: snapshot.docker.images.list.length,
          volumes: snapshot.docker.volumes.list.length,
          networks: snapshot.docker.networks.list.length,
          danglingImages: 0,
          unusedVolumes: 0,
        },
        disk: snapshot.docker.disk.usage,
        containers: [],
        projects: [],
        services: { redis: serviceHealth('redis'), postgres: serviceHealth('postgres') },
        insights: [],
        dockerfiles: snapshot.docker.dockerfiles.status === 'ready'
          ? {
              count: snapshot.docker.dockerfiles.list.length,
              generatedAt: snapshot.docker.dockerfiles.scan === null ? '' : snapshot.docker.dockerfiles.scan.generatedAt,
            }
          : null,
      }
    }

    /**
     * @param {object} service - a ServiceHealth view.
     * @returns {{key: string, tone: string}} plain status.
     */
    function serviceStatusOf(service) {
      if (service.ambiguous) return { key: 'overview.service.status.ambiguous', tone: 'Warn' }
      if (service.reachable) return { key: 'overview.service.status.ok', tone: 'Ok' }
      if (service.instances === 0) return { key: 'overview.service.status.none', tone: '' }
      if (service.error !== null) return { key: 'overview.service.status.stopped', tone: 'Warn' }
      return { key: 'overview.service.status.unknown', tone: '' }
    }

    /**
     * One plain service card on the overview page.
     *
     * @param {object} props - card props.
     * @returns {object} the card.
     */
    function OverviewServiceCard({ kind, overview, snapshot, client, t, service }) {
      const beginner = snapshot.viewMode === 'beginner'
      const status = serviceStatusOf(service)
      const stats = []
      if (kind === 'docker') {
        stats.push(t('overview.service.stat.containers', { running: overview.counts.running, total: overview.counts.containers }))
        stats.push(t('overview.service.stat.docker.images', { count: overview.counts.images }))
        stats.push(t('overview.service.stat.docker.volumes', { count: overview.counts.volumes }))
        if (overview.dockerfiles !== null) {
          stats.push(t('overview.service.stat.docker.dockerfiles', { count: overview.dockerfiles.count }))
        }
      } else {
        const summary = service.summary
        if (kind === 'redis') {
          if (summary.keys !== undefined) stats.push(t('overview.service.stat.redis.keys', { count: String(summary.keys) }))
          if (summary.memoryHuman !== undefined) stats.push(t('overview.service.stat.redis.memory', { memory: String(summary.memoryHuman) }))
          if (summary.clients !== undefined) stats.push(t('overview.service.stat.redis.clients', { count: String(summary.clients) }))
        } else {
          if (summary.databases !== undefined) stats.push(t('overview.service.stat.pg.databases', { count: String(summary.databases) }))
          if (summary.sessions !== undefined) stats.push(t('overview.service.stat.pg.sessions', { count: String(summary.sessions) }))
          if (summary.currentDatabase !== undefined) stats.push(t('overview.service.stat.pg.database', { name: String(summary.currentDatabase) }))
        }
        if (stats.length === 0) stats.push(t('overview.service.stat.unknown'))
      }
      const actions = []
      if (kind === 'docker') {
        if (overview.docker.available) {
          actions.push(h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: () => { void client.refresh() },
          }, t('overview.service.action.refresh')))
        } else {
          actions.push(h('button', {
            key: 'settings',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact dshDataButtonOutline',
            onClick: () => client.openSettings(),
          }, t('overview.service.action.settings')))
        }
        actions.push(h('button', {
          key: 'open',
          type: 'button',
          className: 'dshDataButton dshDataButtonCompact dshDataButtonOutline',
          onClick: () => { void client.selectTab('docker') },
        }, t('overview.service.action.openDocker')))
      } else {
        if (service.ambiguous || (service.instances > 1)) {
          actions.push(h('button', {
            key: 'choose',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: () => { void client.selectTab(kind) },
          }, t('overview.service.action.choose')))
        } else if (!service.reachable && service.instances === 0) {
          actions.push(h(CopyButton, {
            key: 'copy',
            client,
            snapshot,
            t,
            text: kind === 'redis' ? START_COMMANDS.redis : START_COMMANDS.postgres,
            copyKey: `overview-start-${kind}`,
            label: t('overview.service.action.copyStart'),
          }))
        } else {
          actions.push(h('button', {
            key: 'open',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: () => { void client.selectTab(kind) },
          }, kind === 'redis' ? t('overview.service.action.openRedis') : t('overview.service.action.openPostgres')))
        }
        if (beginner && !service.reachable) {
          actions.push(h('button', {
            key: 'settings',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact dshDataButtonOutline',
            onClick: () => client.openSettings(),
          }, t('overview.service.action.settings')))
        }
      }
      return h('section', { className: 'dshDataServiceCard' }, [
        h('div', { key: 'head', className: 'dshDataServiceHead' }, [
          h('h3', { key: 'title', className: 'dshDataServiceTitle' }, t(`overview.service.${kind}`)),
          h('span', { key: 'status', className: `dshDataServicePill dshDataServicePill${status.tone}` }, t(status.key)),
        ]),
        h('p', { key: 'what', className: 'dshDataServiceWhat' }, t(`overview.service.${kind}.what`)),
        h('ul', { key: 'stats', className: 'dshDataServiceStats' }, stats.map((line, index) => h('li', { key: index }, line))),
        h('div', { key: 'actions', className: 'dshDataServiceActions' }, actions),
      ])
    }

    /**
     * The 概览 landing page.
     *
     * @param {object} props - tab props.
     * @returns {object} the overview tab.
     */
    function OverviewTab({ client, snapshot, t }) {
      const overviewState = snapshot.overview
      const value = overviewState.value === null ? fallbackOverview(snapshot) : overviewState.value
      const beginner = snapshot.viewMode === 'beginner'
      const status = overviewStatus(value)
      const children = [
        h('div', { key: 'toolbar', className: 'dshDataToolbar' }, [
          h('p', { key: 'hint', className: 'dshDataHint' }, t('overview.subtitle')),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
            disabled: overviewState.refreshing,
            onClick: () => { void client.loadOverview() },
          }, [refreshGlyph(), t('refresh')]),
        ]),
      ]
      if (overviewState.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          mode: snapshot.viewMode,
          error: overviewState.error,
          t,
          onRetry: () => { void client.loadOverview() },
        }))
      }
      if (overviewState.value === null && overviewState.status === 'loading') {
        children.push(h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
          h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('overview.loading')),
          ...[0, 1, 2].map((index) => h('div', { key: index, className: 'dshDataSkeleton' })),
        ]))
      }
      const counts = [
        ['Good', 'overview.status.counts.good', value.insights.filter((insight) => insight.level === 'good').length],
        ['Info', 'overview.status.counts.info', value.insights.filter((insight) => insight.level === 'info').length],
        ['Warn', 'overview.status.counts.warn', value.insights.filter((insight) => insight.level === 'warn').length],
        ['Danger', 'overview.status.counts.danger', value.insights.filter((insight) => insight.level === 'danger').length],
      ].filter(([, , count]) => count > 0)
      children.push(h('section', { key: 'overall', className: 'dshDataOverviewStatus' }, [
        h('div', { key: 'main', className: 'dshDataOverviewStatusMain' }, [
          h('h2', { key: 'title', className: 'dshDataOverviewStatusTitle' }, t('overview.status.title')),
          h('p', { key: 'sentence', className: 'dshDataOverviewStatusSentence' }, status.level === 'good'
            ? t('overview.status.good')
            : status.level === 'danger'
              ? t('overview.status.danger', { count: status.count })
              : t('overview.status.attention', { count: status.count })),
          counts.length === 0
            ? null
            : h('div', { key: 'counts', className: 'dshDataOverviewCounts' }, counts.map(([tone, key, count]) => h('span', {
                key,
                className: `dshDataCountPill dshDataCount${tone}`,
              }, t(key, { count })))),
          value.generatedAt === ''
            ? null
            : h('p', { key: 'updated', className: 'dshDataHint' }, t('overview.status.updated', { time: value.generatedAt })),
        ]),
      ]))
      children.push(h('div', { key: 'services', className: 'dshDataServiceGrid' }, [
        h(OverviewServiceCard, { key: 'docker', kind: 'docker', overview: value, snapshot, client, t, service: { ambiguous: false, reachable: value.docker.available, instances: value.docker.available ? 1 : 0, error: value.docker.error === null ? null : { code: 'docker_unavailable', message: value.docker.error }, summary: {} } }),
        h(OverviewServiceCard, { key: 'redis', kind: 'redis', overview: value, snapshot, client, t, service: value.services.redis }),
        h(OverviewServiceCard, { key: 'postgres', kind: 'postgres', overview: value, snapshot, client, t, service: value.services.postgres }),
      ]))
      const insights = value.insights
      children.push(h('section', { key: 'insights', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('overview.insights.title')),
          h('span', { key: 'count', className: 'dshDataCardMeta' }, String(insights.length)),
        ]),
        insights.length === 0
          ? h('p', { key: 'empty', className: 'dshDataHint' }, t('overview.insights.empty'))
          : h('ul', { key: 'list', className: 'dshDataInsightList' }, insights.map((insight, index) => {
              const target = insightActionTarget(insight.code)
              const tone = insight.level === 'good' ? 'Good' : insight.level === 'warn' ? 'Warn' : insight.level === 'danger' ? 'Danger' : ''
              return h('li', { key: `${insight.code}-${index}`, className: `dshDataInsight${tone === '' ? '' : ` dshDataInsight${tone}`}` }, [
                h('span', { key: 'icon', className: 'dshDataInsightIcon', 'aria-hidden': true },
                  insight.level === 'danger' ? alertGlyph() : infoGlyph()),
                h('p', { key: 'text', className: 'dshDataInsightText' }, insightSentence(insight.code, insight.params, t)),
                target === ''
                  ? null
                  : h('button', {
                      key: 'action',
                      type: 'button',
                      className: 'dshDataButton dshDataButtonCompact',
                      onClick: () => {
                        if (target === 'settings') {
                          client.openSettings()
                          return undefined
                        }
                        if (target === 'dockerfiles') {
                          return client.selectTab('docker').then(() => client.selectDockerTab('dockerfiles'))
                        }
                        return client.selectTab(target)
                      },
                    }, t(`intent.${insight.code}`)),
              ])
            })),
      ]))
      const serviceContainers = value.containers.filter((container) => container.role === 'database' || container.role === 'cache')
      const runningServices = serviceContainers.filter((container) => container.state === 'running').length
      const step3Done = status.level !== 'danger'
      children.push(h('section', { key: 'quick', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('overview.quick.title')),
          h('p', { key: 'hint', className: 'dshDataCardHint' }, t('overview.quick.hint')),
        ]),
        h('ol', { key: 'list', className: 'dshDataQuickList' }, [
          h('li', { key: 'step1', className: 'dshDataQuickStep' }, [
            h('span', { key: 'index', className: 'dshDataQuickIndex', 'aria-hidden': true }, '1'),
            h('div', { key: 'body', className: 'dshDataQuickBody' }, [
              h('p', { key: 'title', className: 'dshDataQuickTitle' }, t('overview.quick.step1')),
              h('p', { key: 'desc', className: 'dshDataQuickDesc' }, t('overview.quick.step1.desc')),
              h('p', {
                key: 'state',
                className: value.docker.available ? 'dshDataQuickState dshDataQuickDone' : 'dshDataQuickState',
              }, value.docker.available ? t('overview.quick.step1.done') : t('overview.quick.step1.todo')),
            ]),
          ]),
          h('li', { key: 'step2', className: 'dshDataQuickStep' }, [
            h('span', { key: 'index', className: 'dshDataQuickIndex', 'aria-hidden': true }, '2'),
            h('div', { key: 'body', className: 'dshDataQuickBody' }, [
              h('p', { key: 'title', className: 'dshDataQuickTitle' }, t('overview.quick.step2')),
              h('p', { key: 'desc', className: 'dshDataQuickDesc' }, t('overview.quick.step2.desc')),
              h('p', {
                key: 'state',
                className: runningServices > 0 ? 'dshDataQuickState dshDataQuickDone' : 'dshDataQuickState',
              }, runningServices > 0
                ? t('overview.quick.step2.done', { count: runningServices })
                : t('overview.quick.step2.todo')),
              h('div', { key: 'commands', className: 'dshDataCommandRow' }, [
                h('code', { key: 'redis', className: 'dshDataCommand' }, START_COMMANDS.redis),
                h(CopyButton, { key: 'redis-copy', client, snapshot, t, text: START_COMMANDS.redis, copyKey: 'quick-redis', label: t('overview.quick.copyRedis') }),
              ]),
              h('div', { key: 'commands-pg', className: 'dshDataCommandRow' }, [
                h('code', { key: 'pg', className: 'dshDataCommand' }, START_COMMANDS.postgres),
                h(CopyButton, { key: 'pg-copy', client, snapshot, t, text: START_COMMANDS.postgres, copyKey: 'quick-postgres', label: t('overview.quick.copyPostgres') }),
              ]),
            ]),
          ]),
          h('li', { key: 'step3', className: 'dshDataQuickStep' }, [
            h('span', { key: 'index', className: 'dshDataQuickIndex', 'aria-hidden': true }, '3'),
            h('div', { key: 'body', className: 'dshDataQuickBody' }, [
              h('p', { key: 'title', className: 'dshDataQuickTitle' }, t('overview.quick.step3')),
              h('p', { key: 'desc', className: 'dshDataQuickDesc' }, t('overview.quick.step3.desc')),
              h('p', {
                key: 'state',
                className: step3Done ? 'dshDataQuickState dshDataQuickDone' : 'dshDataQuickState',
              }, step3Done ? t('overview.quick.step1.done') : t('overview.quick.step1.todo')),
            ]),
          ]),
        ]),
      ]))
      if (!beginner && overviewState.value !== null) {
        children.push(h(DetailsBlock, { key: 'raw', t, summary: t('plain.advanced'), open: true },
          h('pre', { className: 'dshDataValue' }, safeJson({
            counts: value.counts,
            services: value.services,
            insights: value.insights,
          }))))
      }
      return h('div', { className: 'dshDataTabBody dshDataOverview' }, children)
    }

    /**
     * The Redis "write data" wizard.
     *
     * @param {object} props - wizard props.
     * @returns {object|null} the wizard card.
     */
    function RedisWriteWizard({ client, snapshot, t }) {
      const wizard = snapshot.redis.wizard
      if (!wizard.open) return null
      const type = ['string', 'hash', 'list', 'set'].indexOf(wizard.type) >= 0 ? wizard.type : 'string'
      const errors = wizard.error === null ? null : h(ErrorNotice, { mode: snapshot.viewMode,
        key: 'error',
        mode: snapshot.viewMode,
        error: wizard.error,
        t,
      })
      const fields = []
      fields.push(h(FormField, {
        key: 'key',
        id: `${NS}-wizard-key`,
        label: t('redis.wizard.key'),
      }, h('input', {
        id: `${NS}-wizard-key`,
        className: 'dshDataInput dshDataInputMono',
        type: 'text',
        value: wizard.key,
        onChange: (event) => client.setRedisWizard('key', event.target.value),
      })))
      if (type === 'hash') {
        fields.push(h(FormField, {
          key: 'field',
          id: `${NS}-wizard-field`,
          label: t('redis.wizard.field'),
        }, h('input', {
          id: `${NS}-wizard-field`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: wizard.field,
          onChange: (event) => client.setRedisWizard('field', event.target.value),
        })))
        fields.push(h(FormField, {
          key: 'value',
          id: `${NS}-wizard-value`,
          label: t('redis.wizard.value'),
        }, h('input', {
          id: `${NS}-wizard-value`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: wizard.value,
          onChange: (event) => client.setRedisWizard('value', event.target.value),
        })))
      } else if (type === 'list') {
        fields.push(h(FormField, {
          key: 'value',
          id: `${NS}-wizard-list-value`,
          label: t('redis.wizard.value'),
        }, h('input', {
          id: `${NS}-wizard-list-value`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: wizard.value,
          onChange: (event) => client.setRedisWizard('value', event.target.value),
        })))
      } else if (type === 'set') {
        fields.push(h(FormField, {
          key: 'member',
          id: `${NS}-wizard-member`,
          label: t('redis.wizard.member'),
        }, h('input', {
          id: `${NS}-wizard-member`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: wizard.member,
          onChange: (event) => client.setRedisWizard('member', event.target.value),
        })))
      } else {
        fields.push(h(FormField, {
          key: 'value',
          id: `${NS}-wizard-string-value`,
          label: t('redis.wizard.value'),
        }, h('input', {
          id: `${NS}-wizard-string-value`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: wizard.value,
          onChange: (event) => client.setRedisWizard('value', event.target.value),
        })))
        fields.push(h(FormField, {
          key: 'ttl',
          id: `${NS}-wizard-ttl`,
          label: t('redis.wizard.ttl'),
        }, h('input', {
          id: `${NS}-wizard-ttl`,
          className: 'dshDataInput',
          type: 'number',
          min: '0',
          value: wizard.ttl,
          onChange: (event) => client.setRedisWizard('ttl', event.target.value),
        })))
      }
      return h('section', { className: 'dshDataWizard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h3', { key: 'title', className: 'dshDataCardTitle' }, t('redis.wizard.title')),
          h('div', { key: 'steps', className: 'dshDataWizardSteps' }, [
            h('span', { key: 'step1', className: 'dshDataWizardStep dshDataWizardStepActive' }, `1 · ${t('redis.wizard.step.type')}`),
            h('span', { key: 'step2', className: 'dshDataWizardStep dshDataWizardStepActive' }, `2 · ${t('redis.wizard.step.fields')}`),
          ]),
        ]),
        h('div', { key: 'type', className: 'dshDataToolbar' }, [
          h('label', { key: 'label', className: 'dshDataInlineField' }, [
            h('span', { key: 'text' }, t('redis.wizard.step.type')),
            h('select', {
              key: 'select',
              className: 'dshDataSelect',
              value: type,
              'aria-label': t('redis.wizard.step.type'),
              onChange: (event) => client.setRedisWizard('type', event.target.value),
            }, ['string', 'hash', 'list', 'set'].map((value) => h('option', {
              key: value,
              value,
            }, t(`redis.wizard.type.${value}`)))),
          ]),
        ]),
        h('div', { key: 'fields', className: 'dshDataWizardGrid' }, fields),
        errors,
        h('div', { key: 'actions', className: 'dshDataTestRow' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
            disabled: wizard.status === 'running' || wizard.key.trim() === '',
            onClick: () => { void client.submitRedisWizard() },
          }, wizard.status === 'running' ? t('redis.wizard.saving') : t('redis.wizard.save')),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: () => client.closeRedisWizard(),
          }, t('redis.wizard.cancel')),
          wizard.notice === null
            ? null
            : h('p', { key: 'notice', className: 'dshDataNoticeOk', role: 'status' },
                t('redis.wizard.notice', { key: wizard.notice.key })),
        ]),
      ])
    }

    /** The copy for every action that asks for a second confirmation. */
    const CONFIRM_SPECS = {
      'container.stop': { title: 'confirm.containerStop.title', body: 'confirm.containerStop.body', action: 'confirm.containerStop.action' },
      'container.restart': { title: 'confirm.containerRestart.title', body: 'confirm.containerRestart.body', action: 'confirm.containerRestart.action' },
      'container.pause': { title: 'confirm.containerPause.title', body: 'confirm.containerPause.body', action: 'confirm.containerPause.action' },
      'container.remove': { title: 'confirm.containerRemove.title', body: 'confirm.containerRemove.body', action: 'confirm.containerRemove.action' },
      'image.remove': { title: 'confirm.imageRemove.title', body: 'confirm.imageRemove.body', action: 'confirm.imageRemove.action' },
      'volume.remove': { title: 'confirm.volumeRemove.title', body: 'confirm.volumeRemove.body', action: 'confirm.volumeRemove.action' },
      'network.remove': { title: 'confirm.networkRemove.title', body: 'confirm.networkRemove.body', action: 'confirm.networkRemove.action' },
      'redis.delete': { title: 'redis.delete.title', body: 'redis.delete.body', action: 'redis.delete.action' },
      'redis.rename': { title: 'confirm.redisRename.title', body: 'confirm.redisRename.body', action: 'confirm.redisRename.action' },
      'redis.expire': { title: 'confirm.redisExpire.title', body: 'confirm.redisExpire.body', action: 'confirm.redisExpire.action' },
    }

    /**
     * The two-mode connection switch for one service: Docker container
     * (default) or a manual host/port.
     *
     * @param {object} props - switch props.
     * @returns {object} the segmented control.
     */
    function ModeSwitch({ service, value, t, onChange }) {
      return h('div', { className: 'dshDataSettingsMode' }, [
        h('span', { key: 'label', className: 'dshDataSettingsModeLabel' }, t('settings.mode')),
        h('div', {
          key: 'seg',
          className: 'dshDataSeg',
          role: 'group',
          'aria-label': `${t('settings.mode')} · ${t(`settings.${service}.title`)}`,
        }, ['docker', 'manual'].map((mode) => h('button', {
          key: mode,
          type: 'button',
          className: value === mode ? 'dshDataSegButton dshDataSegButtonActive' : 'dshDataSegButton',
          'aria-pressed': value === mode,
          onClick: () => onChange(mode),
        }, t(`settings.mode.${mode}`)))),
      ])
    }

    /**
     * @param {object} target - the service's target view from `state.targets`.
     * @param {string} value - the selected container name ('' = auto).
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {object[]} the container `<option>` elements.
     */
    function targetOptions(target, value, t) {
      const candidates = target === null || target === undefined ? [] : target.candidates
      const options = [h('option', { key: 'auto', value: '' }, t('settings.target.auto'))]
      for (const candidate of candidates) {
        const port = candidate.hostPort === null ? t('settings.target.noPortShort') : `:${candidate.hostPort}`
        options.push(h('option', {
          key: candidate.name,
          value: candidate.name,
          disabled: candidate.running !== true,
        }, `${candidate.name} · ${candidate.image} · ${port}${candidate.running ? '' : ` · ${t('settings.target.stopped')}`}`))
      }
      const missing = typeof value === 'string' && value !== '' && !candidates.some((candidate) => candidate.name === value)
      if (missing) {
        options.push(h('option', { key: 'missing', value }, `${value} · ${t('settings.target.notFound', { container: value })}`))
      }
      return options
    }

    /**
     * The resolved endpoint + credential source box, with the resolution error
     * (including the ambiguous-instance hint) and the candidate/running counts.
     *
     * @param {object} props - summary props.
     * @returns {object} the summary element.
     */
    function TargetSummary({ service, target, t }) {
      const targetState = target === undefined ? null : target
      const instances = targetState === null ? [] : targetState.instances
      const lines = []
      if (targetState !== null && isRecord(targetState.resolved)) {
        const resolved = targetState.resolved
        lines.push(h('p', { key: 'resolved', className: 'dshDataTargetLine dshDataTargetLineMono' },
          t('settings.target.resolved', { endpoint: targetEndpoint(resolved) })))
        lines.push(h('p', { key: 'credentials', className: 'dshDataTargetMeta' },
          t('settings.target.credentials', { source: t(credentialsSourceKey(resolved.credentialsSource)) })))
      }
      if (targetState !== null && targetState.error !== null) {
        const failure = targetState.error
        const key = targetErrorKey(failure.code)
        const details = isRecord(failure.details) ? failure.details : {}
        const candidates = Array.isArray(details.candidates) ? details.candidates.filter(isRecord) : []
        lines.push(h('p', { key: 'error', className: 'dshDataTargetError', role: 'status' }, key === null
          ? t('settings.target.error')
          : t(key, {
              service: t(`chip.${service}`),
              container: textOf(details.container, ''),
              message: failure.message,
              count: candidates.length,
            })))
        if (candidates.length > 0) {
          lines.push(h('p', { key: 'names', className: 'dshDataTargetMeta dshDataMono' },
            candidates.map((candidate) => textOf(candidate.name, '')).join(' · ')))
        }
        if (failure.message !== '') lines.push(h('p', { key: 'message', className: 'dshDataTargetMeta' }, failure.message))
      }
      const all = targetState === null ? [] : targetState.candidates
      lines.push(h('p', { key: 'candidates', className: 'dshDataTargetMeta' }, all.length === 0
        ? t('settings.target.noCandidates')
        : `${t('settings.target.candidates', { count: all.length })} · ${t('settings.target.runningCount', { count: instances.length })}`))
      return h('div', { className: 'dshDataTargetBox' }, lines)
    }

    /**
     * The `docker system df` summary above the Docker sub-tabs.
     *
     * @param {object} props - summary props.
     * @returns {object} the disk-usage card.
     */
    function DockerDiskUsage({ snapshot, client, t }) {
      const disk = snapshot.docker.disk
      const children = [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('docker.disk.title')),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            disabled: disk.refreshing,
            onClick: () => { void client.loadDiskUsage() },
          }, [refreshGlyph(), t('refresh')]),
        ]),
      ]
      if (disk.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: disk.error,
          t,
          onRetry: () => { void client.loadDiskUsage() },
        }))
      }
      if (isRecord(disk.usage)) {
        const usage = disk.usage
        children.push(h('div', { key: 'stats', className: 'dshDataStats' }, DISK_CATEGORIES.map((category) => {
          const row = isRecord(usage[category]) ? usage[category] : {}
          const size = textOf(row.size, '')
          const reclaimable = textOf(row.reclaimable, '')
          return h('div', { key: category, className: 'dshDataStat' }, [
            h('p', { key: 'label', className: 'dshDataStatLabel' }, t(`docker.disk.${category}`)),
            h('p', { key: 'value', className: 'dshDataStatValue', title: size }, size === '' ? t('docker.disk.none') : size),
            h('p', { key: 'meta', className: 'dshDataStatMeta' }, [
              t('docker.disk.count', { count: integerOf(row.count, 0) }),
              ' · ',
              t('docker.disk.reclaimable', { size: reclaimable === '' ? t('docker.disk.none') : reclaimable }),
            ]),
          ])
        })))
      } else if (disk.status === 'loading') {
        children.push(h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
          h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('docker.disk.loading')),
          h('div', { key: '0', className: 'dshDataSkeleton' }),
        ]))
      }
      return h('section', { className: 'dshDataCard' }, children)
    }

    /**
     * One image row. Removing is confirmed by the panel dialog.
     *
     * @param {object} props - row props.
     * @returns {object} the row element.
     */
    function DockerImageRow({ image, snapshot, client, t }) {
      const record = isRecord(image) ? image : {}
      const id = textOf(record.id, textOf(record.shortId, ''))
      const repoTags = Array.isArray(record.repoTags) ? record.repoTags.filter((tag) => typeof tag === 'string' && tag !== '') : []
      const label = repoTags.length === 0 ? t('docker.images.untagged') : repoTags.join(', ')
      const section = snapshot.docker.images
      const removing = section.removing !== '' && section.removing === id
      const meta = []
      const short = textOf(record.shortId, id.length > 12 ? id.slice(0, 12) : id)
      if (short !== '' && snapshot.viewMode !== 'beginner') meta.push(h('span', { key: 'id', className: 'dshDataDockerId' }, short))
      if (typeof record.size === 'string' && record.size !== '') meta.push(h('span', { key: 'size' }, record.size))
      const created = textOf(record.createdSince, textOf(record.created, ''))
      if (created !== '') meta.push(h('span', { key: 'created' }, created))
      if (typeof record.containers === 'number') meta.push(h('span', { key: 'used' }, t('docker.images.containers', { count: record.containers })))
      return h('li', { className: 'dshDataDockerItem' }, h('div', { className: 'dshDataDockerRow' }, [
        h('div', { key: 'main', className: 'dshDataDockerMain' }, [
          h('div', { key: 'title', className: 'dshDataDockerTitleLine' },
            h('span', { key: 'name', className: 'dshDataDockerName', title: label }, label)),
          h('div', { key: 'meta', className: 'dshDataDockerMeta' }, meta),
        ]),
        h('div', { key: 'actions', className: 'dshDataDockerActions' }, [
          removing ? h('span', { key: 'busy', className: 'dshDataBusy' }, [
            h('span', { key: 'spinner', className: 'dshDataSpinner', 'aria-hidden': true }),
            t('docker.removing'),
          ]) : null,
          h('button', {
            key: 'inspect',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            title: t('docker.images.inspect'),
            'aria-label': t('docker.images.inspect'),
            onClick: () => { void client.inspectResource('image', id, label) },
          }, t('docker.inspect.title')),
          h('button', {
            key: 'remove',
            type: 'button',
            className: 'dshDataIconButton dshDataIconButtonDanger',
            title: t('docker.images.remove'),
            'aria-label': t('docker.images.remove'),
            disabled: removing,
            onClick: () => client.requestImageRemove(id, label),
          }, trashGlyph()),
        ]),
      ]))
    }

    /**
     * One volume row.
     *
     * @param {object} props - row props.
     * @returns {object} the row element.
     */
    function DockerVolumeRow({ volume, snapshot, client, t }) {
      const record = isRecord(volume) ? volume : {}
      const name = textOf(record.name, '')
      const section = snapshot.docker.volumes
      const removing = section.removing !== '' && section.removing === name
      const meta = []
      if (record.driver !== '') meta.push(h('span', { key: 'driver', className: 'dshDataBadge' }, String(record.driver)))
      if (record.scope !== '') meta.push(h('span', { key: 'scope', className: 'dshDataBadge' }, String(record.scope)))
      const mountpoint = textOf(record.mountpoint, '')
      if (mountpoint !== '') meta.push(h('span', { key: 'mount', className: 'dshDataResourceMount', title: mountpoint }, mountpoint))
      return h('li', { className: 'dshDataDockerItem' }, h('div', { className: 'dshDataDockerRow' }, [
        h('div', { key: 'main', className: 'dshDataDockerMain' }, [
          h('div', { key: 'title', className: 'dshDataDockerTitleLine' },
            h('span', { key: 'name', className: 'dshDataDockerName', title: name }, name)),
          h('div', { key: 'meta', className: 'dshDataDockerMeta' }, meta),
        ]),
        h('div', { key: 'actions', className: 'dshDataDockerActions' }, [
          removing ? h('span', { key: 'busy', className: 'dshDataBusy' }, [
            h('span', { key: 'spinner', className: 'dshDataSpinner', 'aria-hidden': true }),
            t('docker.removing'),
          ]) : null,
          h('button', {
            key: 'inspect',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            title: t('docker.volumes.inspect'),
            'aria-label': t('docker.volumes.inspect'),
            onClick: () => { void client.inspectResource('volume', name, name) },
          }, t('docker.inspect.title')),
          h('button', {
            key: 'remove',
            type: 'button',
            className: 'dshDataIconButton dshDataIconButtonDanger',
            title: t('docker.volumes.remove'),
            'aria-label': t('docker.volumes.remove'),
            disabled: removing,
            onClick: () => client.requestVolumeRemove(name),
          }, trashGlyph()),
        ]),
      ]))
    }

    /**
     * One network row.
     *
     * @param {object} props - row props.
     * @returns {object} the row element.
     */
    function DockerNetworkRow({ network, snapshot, client, t }) {
      const record = isRecord(network) ? network : {}
      const name = textOf(record.name, '')
      const section = snapshot.docker.networks
      const removing = section.removing !== '' && section.removing === name
      const meta = []
      if (record.driver !== '') meta.push(h('span', { key: 'driver', className: 'dshDataBadge' }, String(record.driver)))
      if (record.scope !== '') meta.push(h('span', { key: 'scope', className: 'dshDataBadge' }, String(record.scope)))
      if (record.internal === true) meta.push(h('span', { key: 'internal', className: 'dshDataBadge dshDataBadgeWarn' }, t('docker.networks.internal')))
      const short = textOf(record.shortId, '')
      if (short !== '' && snapshot.viewMode !== 'beginner') meta.push(h('span', { key: 'id', className: 'dshDataDockerId' }, short))
      return h('li', { className: 'dshDataDockerItem' }, h('div', { className: 'dshDataDockerRow' }, [
        h('div', { key: 'main', className: 'dshDataDockerMain' }, [
          h('div', { key: 'title', className: 'dshDataDockerTitleLine' },
            h('span', { key: 'name', className: 'dshDataDockerName', title: name }, name)),
          h('div', { key: 'meta', className: 'dshDataDockerMeta' }, meta),
        ]),
        h('div', { key: 'actions', className: 'dshDataDockerActions' }, [
          removing ? h('span', { key: 'busy', className: 'dshDataBusy' }, [
            h('span', { key: 'spinner', className: 'dshDataSpinner', 'aria-hidden': true }),
            t('docker.removing'),
          ]) : null,
          h('button', {
            key: 'inspect',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            title: t('docker.networks.inspect'),
            'aria-label': t('docker.networks.inspect'),
            onClick: () => { void client.inspectResource('network', name, name) },
          }, t('docker.inspect.title')),
          h('button', {
            key: 'remove',
            type: 'button',
            className: 'dshDataIconButton dshDataIconButtonDanger',
            title: t('docker.networks.remove'),
            'aria-label': t('docker.networks.remove'),
            disabled: removing,
            onClick: () => client.requestNetworkRemove(name),
          }, trashGlyph()),
        ]),
      ]))
    }

    /**
     * One Dockerfile card: what it builds, where it is, and what it does.
     *
     * @param {object} props - card props.
     * @returns {object} the card.
     */
    function DockerfileCard({ summary, snapshot, client, t }) {
      const beginner = snapshot.viewMode === 'beginner'
      const build = dockerfileBuildCommand(summary)
      const ports = Array.isArray(summary.exposedPorts) ? summary.exposedPorts : []
      const base = summary.finalBaseImage
      const baseText = base === null || base === ''
        ? t('dockerfile.card.noneBase')
        : beginner
          ? t('dockerfile.card.baseRole', { image: base, role: t(`plain.role.${dockerfileRoleOf(base)}`) })
          : t('dockerfile.card.base', { image: base })
      const command = textOf(summary.command, textOf(summary.entrypoint, textOf(summary.cmd, '')))
      const chips = []
      chips.push(h('span', { key: 'instructions', className: 'dshDataBadge' }, t('dockerfile.card.instructions', { count: summary.instructionCount })))
      if (summary.multiStage) {
        chips.push(h('span', { key: 'stages', className: 'dshDataBadge dshDataBadgeWarn' }, t('dockerfile.card.multiStage', { count: summary.stageCount })))
      }
      if (summary.healthcheck) chips.push(h('span', { key: 'health', className: 'dshDataBadge' }, t('dockerfile.card.healthcheck')))
      if (summary.envKeys.length > 0) chips.push(h('span', { key: 'env', className: 'dshDataBadge' }, t('dockerfile.card.env', { count: summary.envKeys.length })))
      if (summary.volumes.length > 0) chips.push(h('span', { key: 'volumes', className: 'dshDataBadge' }, t('dockerfile.card.volumes', { count: summary.volumes.length })))
      const portsNode = ports.length === 0
        ? h('p', { key: 'ports', className: 'dshDataHint' }, t('dockerfile.card.noPorts'))
        : h('div', { key: 'ports', className: 'dshDataDockerfilePorts' }, ports.map((port) => h('span', {
            key: port,
            className: 'dshDataCountPill dshDataCountInfo',
          }, t('dockerfile.port.label', { port, meaning: dockerfilePortMeaning(port, t) }))))
      return h('section', { className: 'dshDataCard dshDataDockerfileCard' }, [
        h('div', { key: 'head', className: 'dshDataDockerfileHead' }, [
          h('div', { key: 'text', className: 'dshDataDockerfileHeadText' }, [
            h('h3', { key: 'name', className: 'dshDataDockerfileTitle', title: summary.path }, summary.name),
            h('p', { key: 'dir', className: 'dshDataDockerfileMeta', title: summary.relativePath }, summary.relativePath),
          ]),
          h('div', { key: 'badges', className: 'dshDataDockerfileChips' }, [
            ...chips,
            h('span', { key: 'size', className: 'dshDataMuted' }, formatBytes(summary.size)),
          ]),
        ]),
        h('p', { key: 'base', className: 'dshDataDockerfileBase' }, baseText),
        portsNode,
        command === '' ? null : h('div', { key: 'command', className: 'dshDataDockerfileCommand' }, [
          h('span', { key: 'label', className: 'dshDataMuted' }, `${t('dockerfile.card.command')}: `),
          h('code', { key: 'code', className: 'dshDataMono', title: command }, truncateLabel(command, 120)),
        ]),
        h('p', { key: 'path', className: 'dshDataDockerfilePath', title: summary.path },
          t('dockerfile.card.path', { path: beginner ? summary.relativePath : summary.path })),
        h('div', { key: 'actions', className: 'dshDataDockerfileActions' }, [
          h('button', {
            key: 'view',
            type: 'button',
            className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
            onClick: () => { void client.openDockerfile(summary) },
          }, t('dockerfile.card.view')),
          h(CopyButton, {
            key: 'build',
            client,
            snapshot,
            t,
            text: build,
            copyKey: `dockerfile-build-${summary.path}`,
            label: t('dockerfile.card.copyBuild'),
          }),
          h(CopyButton, {
            key: 'path-copy',
            client,
            snapshot,
            t,
            text: summary.path,
            copyKey: `dockerfile-path-${summary.path}`,
            label: t('dockerfile.card.copyPath'),
          }),
        ]),
      ])
    }

    /**
     * The annotated Dockerfile viewer modal.
     *
     * @param {object} props - viewer props.
     * @returns {object|null} the modal overlay.
     */
    function DockerfileViewer({ client, snapshot, t }) {
      const view = snapshot.docker.dockerfileView
      const closeRef = React.useRef(null)
      React.useEffect(() => {
        if (!view.open || typeof document === 'undefined') return undefined
        if (closeRef.current !== null && typeof closeRef.current.focus === 'function') closeRef.current.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            client.closeDockerfile()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [view.open, client])
      if (!view.open) return null
      const beginner = snapshot.viewMode === 'beginner'
      const detail = isRecord(view.value) ? view.value : null
      const body = []
      if (view.status === 'loading') {
        body.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('dockerfile.view.loading')))
      } else if (view.error !== null) {
        body.push(h(ErrorNotice, {
          key: 'error',
          mode: snapshot.viewMode,
          error: view.error,
          t,
          onRetry: () => { void client.loadDockerfile() },
        }))
      } else if (detail !== null) {
        const lines = detail.content.split('\n')
        const rawList = h('ol', { key: 'raw', className: 'dshDataCodeList' }, lines.map((line, index) => h('li', {
          key: index,
          className: 'dshDataCodeRow',
        }, [
          h('span', { key: 'line', className: 'dshDataCodeLine' }, String(index + 1)),
          h('code', { key: 'text', className: 'dshDataCodeText' }, line === '' ? ' ' : line),
        ])))
        if (beginner) {
          const instructions = detail.parsed.instructions
          body.push(h('section', { key: 'annotated', className: 'dshDataModalSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('dockerfile.view.annotated')),
            instructions.length === 0
              ? h('p', { key: 'empty', className: 'dshDataHint' }, t('dockerfile.view.noWarnings'))
              : h('ol', { key: 'list', className: 'dshDataCodeList' }, instructions.map((entry, index) => h('li', {
                  key: `${entry.line}-${index}`,
                  className: 'dshDataCodeRow',
                }, [
                  h('span', { key: 'line', className: 'dshDataCodeLine', title: t('dockerfile.view.line', { line: entry.line }) }, String(entry.line)),
                  h('code', { key: 'text', className: 'dshDataCodeText' }, `${entry.instruction} ${entry.args}`.trim()),
                  h('span', { key: 'note', className: 'dshDataCodeNote' }, dockerfileExplanation(entry, t)),
                ]))),
          ]))
          body.push(h(DetailsBlock, { key: 'raw-details', t, summary: t('dockerfile.view.raw') }, rawList))
          if (detail.truncated) body.push(h('p', { key: 'truncated', className: 'dshDataHint' }, t('dockerfile.view.truncated')))
        } else {
          body.push(h('section', { key: 'summary', className: 'dshDataModalSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('dockerfile.view.summary')),
            h('p', { key: 'bases', className: 'dshDataTargetLine dshDataTargetLineMono' },
              `${t('dockerfile.view.baseImages')}: ${detail.parsed.baseImages.join(' · ')}`),
            h('h4', { key: 'stages-title', className: 'dshDataDetailTitle' }, t('dockerfile.view.stages')),
            h('ul', { key: 'stages', className: 'dshDataSummaryList' }, detail.parsed.stages.map((stage, index) => h('li', {
              key: index,
              className: 'dshDataSummaryRow',
            }, t('dockerfile.view.stageName', {
              index: stage.index,
              base: textOf(stage.baseImage, t('dockerfile.card.noneBase')),
            })))),
            h('h4', { key: 'warnings-title', className: 'dshDataDetailTitle' }, t('dockerfile.view.warnings')),
            detail.parsed.warnings.length === 0
              ? h('p', { key: 'no-warnings', className: 'dshDataHint' }, t('dockerfile.view.noWarnings'))
              : h('ul', { key: 'warnings', className: 'dshDataSummaryList' }, detail.parsed.warnings.map((warning, index) => h('li', {
                  key: index,
                  className: 'dshDataWarningRow',
                }, t('dockerfile.view.warning', { line: warning.line, message: warning.message })))),
          ]))
          body.push(h('section', { key: 'raw', className: 'dshDataModalSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('dockerfile.view.raw')),
            rawList,
            detail.truncated ? h('p', { key: 'truncated', className: 'dshDataHint' }, t('dockerfile.view.truncated')) : null,
          ]))
        }
      }
      return h('div', {
        className: 'dshDataOverlay',
        onClick: (event) => {
          if (event.target === event.currentTarget) client.closeDockerfile()
        },
      }, [
        h('div', { key: 'backdrop', className: 'dshDataBackdrop', onClick: () => client.closeDockerfile(), 'aria-hidden': true }),
        h('div', {
          key: 'modal',
          className: 'dshDataModal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': `${NS}-dockerfile-title`,
        }, [
          h('div', { key: 'head', className: 'dshDataModalHead' }, [
            h('h2', { key: 'title', id: `${NS}-dockerfile-title`, className: 'dshDataModalTitle' },
              `${t('dockerfile.view.title')} · ${textOf(view.path.split('/').pop(), 'Dockerfile')}`),
            detail === null ? null : h('p', { key: 'meta', className: 'dshDataModalMeta' },
              `${detail.relativePath} · ${formatBytes(detail.size)}`),
            h('div', { key: 'actions', className: 'dshDataModalActions' }, [
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'dshDataButton dshDataButtonCompact',
                onClick: () => { void client.loadDockerfile() },
              }, t('refresh')),
              h('button', {
                key: 'close',
                ref: closeRef,
                type: 'button',
                className: 'dshDataButton dshDataButtonCompact',
                onClick: () => client.closeDockerfile(),
              }, t('dockerfile.view.close')),
            ]),
          ]),
          h('div', { key: 'body', className: 'dshDataModalBody' }, body),
        ]),
      ])
    }

    /**
     * The 构建文件 Docker sub-tab.
     *
     * @param {object} props - tab props.
     * @returns {object} the tab element.
     */
    function DockerfilesTab({ client, snapshot, t }) {
      const state = snapshot.docker.dockerfiles
      const beginner = snapshot.viewMode === 'beginner'
      const children = []
      if (beginner) {
        children.push(h('div', { key: 'banner', className: 'dshDataPlainBanner' }, [
          h('span', { key: 'icon', className: 'dshDataPlainBannerIcon', 'aria-hidden': true }, infoGlyph()),
          h('p', { key: 'text', className: 'dshDataPlainBannerText' }, t('dockerfile.banner')),
        ]))
      }
      const rootsText = state.roots.length === 0 ? t('dockerfile.rootsNone') : t('dockerfile.roots', { roots: state.roots.join(' · ') })
      children.push(h('div', { key: 'toolbar', className: 'dshDataToolbar' }, [
        h('p', { key: 'roots', className: 'dshDataHint dshDataDockerfileRoots', title: state.roots.join('\n') }, rootsText),
        h('span', { key: 'meta', className: 'dshDataToolbarMeta' }, state.scan === null
          ? ''
          : `${t('dockerfile.scan', { files: state.scan.visitedFiles })} · ${t('dockerfile.count', { count: state.list.length })}`),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: state.refreshing,
          onClick: () => { void client.loadDockerfiles({ refresh: true }) },
        }, [refreshGlyph(), t('dockerfile.refresh')]),
      ]))
      if (state.error !== null) {
        children.push(h(ErrorNotice, {
          key: 'error',
          mode: snapshot.viewMode,
          error: state.error,
          t,
          onRetry: () => { void client.loadDockerfiles({ refresh: true }) },
        }))
      }
      if (state.scan !== null && state.scan.truncated) {
        children.push(h('div', { key: 'truncated', className: 'dshDataNotice dshDataNoticeInfo', role: 'status' }, [
          h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, infoGlyph()),
          h('p', { key: 'text', className: 'dshDataNoticeText' }, t('dockerfile.truncated')),
        ]))
      }
      if (state.scan !== null && state.scan.errors.length > 0) {
        children.push(h('div', { key: 'root-errors', className: 'dshDataNotice dshDataNoticeInfo', role: 'status' }, [
          h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, alertGlyph()),
          h('div', { key: 'body', className: 'dshDataNoticeBody' }, state.scan.errors.map((error, index) => h('p', {
            key: index,
            className: 'dshDataNoticeDetail dshDataMono',
          }, `${error.root}: ${error.message}`))),
        ]))
      }
      if (state.status === 'loading' && state.list.length === 0) {
        children.push(h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
          h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('dockerfile.loading')),
          ...[0, 1, 2].map((index) => h('div', { key: index, className: 'dshDataSkeleton' })),
        ]))
      } else if (state.list.length === 0) {
        children.push(h('section', { key: 'empty', className: 'dshDataCard' }, [
          h('div', { key: 'head', className: 'dshDataCardHead' }, [
            h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('dockerfile.empty.title')),
          ]),
          h('p', { key: 'hint', className: 'dshDataHint' }, t('dockerfile.empty.hint', {
            roots: state.roots.length === 0 ? t('dockerfile.rootsNone') : state.roots.join(' · '),
          })),
          h('h4', { key: 'sample-title', className: 'dshDataDetailTitle' }, t('dockerfile.empty.sampleTitle')),
          h('pre', { key: 'sample', className: 'dshDataDockerfileSample' }, SAMPLE_DOCKERFILE),
          h('div', { key: 'sample-actions', className: 'dshDataTestRow' }, h(CopyButton, {
            key: 'copy-sample',
            client,
            snapshot,
            t,
            text: SAMPLE_DOCKERFILE,
            copyKey: 'dockerfile-sample',
          })),
          h('p', { key: 'sample-hint', className: 'dshDataHint' }, t('dockerfile.empty.sampleHint')),
          h('div', { key: 'settings', className: 'dshDataTestRow' }, [
            h('p', { key: 'text', className: 'dshDataHint' }, t('dockerfile.empty.settingsHint')),
            h('button', {
              key: 'open',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact dshDataButtonOutline',
              onClick: () => client.openSettings(),
            }, t('settings.open')),
          ]),
        ]))
      } else {
        children.push(h('div', { key: 'cards', className: 'dshDataDockerfileList' }, state.list.map((summary) => h(DockerfileCard, {
          key: summary.path,
          summary,
          snapshot,
          client,
          t,
        }))))
      }
      children.push(h(DockerfileViewer, { key: 'viewer', client, snapshot, t }))
      return h('div', { className: 'dshDataTabBody' }, children)
    }

    /**
     * The instance switcher shown at the top of the Redis and PostgreSQL tabs.
     *
     * @param {object} props - bar props.
     * @returns {object|null} the bar, or null in manual mode.
     */
    function InstanceBar({ client, snapshot, t, service }) {
      const target = snapshot.targets[service]
      const settings = snapshot.settings === null ? null : snapshot.settings[service]
      const mode = settings === null ? 'docker' : settings.mode
      if (mode !== 'docker') return null
      const instances = target === undefined ? [] : target.instances
      const failure = target === undefined ? null : target.error
      const pinned = settings === null || typeof settings.container !== 'string' ? '' : settings.container
      const busy = snapshot.instanceSaving === service
      const parts = []
      const chips = [h('button', {
        key: 'auto',
        type: 'button',
        className: pinned === '' ? 'dshDataInstanceChip dshDataInstanceChipActive' : 'dshDataInstanceChip',
        'aria-pressed': pinned === '',
        disabled: busy,
        onClick: () => client.selectInstance(service, ''),
      }, t('instance.auto'))]
      for (const instance of instances) {
        const address = instance.port === null ? t('settings.target.noPortShort') : `${instance.host}:${instance.port}`
        chips.push(h('button', {
          key: instance.container,
          type: 'button',
          className: pinned === instance.container ? 'dshDataInstanceChip dshDataInstanceChipActive' : 'dshDataInstanceChip',
          'aria-pressed': pinned === instance.container,
          disabled: busy || instance.hasPublishedPort !== true,
          title: instance.hasPublishedPort === true ? `${instance.image} · ${address}` : t('error.noPublishedPort'),
          onClick: () => client.selectInstance(service, instance.container),
        }, [
          h('span', { key: 'name', className: 'dshDataInstanceName' }, instance.container),
          h('span', { key: 'addr', className: 'dshDataInstanceAddr' }, ` · ${address}`),
        ]))
      }
      parts.push(h('div', { key: 'bar', className: 'dshDataInstanceBar' }, [
        h('p', { key: 'label', className: 'dshDataInstanceLabel' }, t('instance.bar')),
        ...chips,
        busy
          ? h('span', { key: 'busy', className: 'dshDataBusy' }, [
              h('span', { key: 'spinner', className: 'dshDataSpinner', 'aria-hidden': true }),
              t('loading'),
            ])
          : null,
      ]))
      if (failure !== null) {
        const key = errorMessageKey(failure.code)
        const count = targetErrorCount(failure)
        parts.push(h('div', { key: 'error', className: 'dshDataNotice dshDataNoticeInfo', role: 'status' }, [
          h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, alertGlyph()),
          h('div', { key: 'body', className: 'dshDataNoticeBody' }, [
            h('p', { key: 'text', className: 'dshDataNoticeText' }, t(key, { message: failure.message, count })),
            isInstanceError(failure.code)
              ? h('p', { key: 'hint', className: 'dshDataNoticeDetail' }, t('instance.choose'))
              : null,
          ]),
        ]))
      }
      return h('div', { className: 'dshDataTabBody' }, parts)
    }

    /**
     * The details modal for an image, volume or network. Beginner mode keeps
     * raw ids and the technical sections behind the advanced expander.
     *
     * @param {object} props - modal props.
     * @returns {object|null} the modal overlay.
     */
    function DockerInspectModal({ snapshot, client, t }) {
      const inspect = snapshot.docker.inspect
      if (!inspect.open) return null
      const beginner = snapshot.viewMode === 'beginner'
      const titleKey = inspect.kind === 'image'
        ? 'docker.images.inspect'
        : inspect.kind === 'volume' ? 'docker.volumes.inspect' : 'docker.networks.inspect'
      const kvList = (rows) => h('ul', { className: 'dshDataKvList' }, rows.map(([label, value], index) => h('li', {
        key: index,
        className: 'dshDataKvRow',
      }, [
        h('span', { key: 'key', className: 'dshDataKvKey' }, label),
        h('span', { key: 'value', className: 'dshDataKvValue', title: String(value) }, String(value)),
      ])))
      const sections = []
      if (inspect.status === 'loading') {
        sections.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('docker.inspect.loading')))
      } else if (inspect.error !== null) {
        sections.push(h(ErrorNotice, { mode: snapshot.viewMode, key: 'error', error: inspect.error, t, onRetry: () => { void client.loadInspect() } }))
      } else if (isRecord(inspect.value)) {
        const value = inspect.value
        if (inspect.kind === 'image') {
          sections.push(h('section', { key: 'overview', className: 'dshDataModalSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.detail.overview')),
            kvList([
              ...(beginner ? [] : [['ID', textOf(value.shortId, textOf(value.id, ''))]]),
              [t('docker.inspect.architecture'), textOf(value.architecture, '')],
              [t('docker.inspect.os'), textOf(value.os, '')],
              [t('docker.detail.createdAt'), textOf(value.created, '')],
              [t('docker.inspect.containers'), String(integerOf(value.containers, 0))],
            ]),
            h('h4', { key: 'c1', className: 'dshDataDetailTitle' }, t('docker.detail.cmd')),
            h('pre', { key: 'cmd', className: 'dshDataPre' }, textOf(value.cmd, t('docker.detail.empty'))),
            h('h4', { key: 'c2', className: 'dshDataDetailTitle' }, t('docker.detail.entrypoint')),
            h('pre', { key: 'entry', className: 'dshDataPre' }, textOf(value.entrypoint, t('docker.detail.empty'))),
          ]))
          const env = Array.isArray(value.env) ? value.env.filter(isRecord) : []
          if (env.length > 0) {
            sections.push(h('section', { key: 'env', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.env')),
              kvList(env.map((entry) => [textOf(entry.key, ''), textOf(entry.value, '')])),
            ]))
          }
          const labels = isRecord(value.labels) ? Object.entries(value.labels) : []
          if (labels.length > 0) {
            sections.push(h('section', { key: 'labels', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.labels')),
              kvList(labels.map(([label, entryValue]) => [label, String(entryValue)])),
            ]))
          }
          const ports = Array.isArray(value.exposedPorts) ? value.exposedPorts : []
          if (ports.length > 0) {
            sections.push(h('section', { key: 'ports', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.exposedPorts')),
              h('p', { key: 'list', className: 'dshDataMuted dshDataMono' }, ports.join(' · ')),
            ]))
          }
        } else if (inspect.kind === 'volume') {
          sections.push(h('section', { key: 'fields', className: 'dshDataModalSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.detail.overview')),
            kvList([
              ['Driver', textOf(value.driver, '')],
              ['Scope', textOf(value.scope, '')],
              ...(beginner ? [] : [[t('docker.inspect.mountpoint'), textOf(value.mountpoint, t('docker.detail.empty'))]]),
              [t('docker.detail.createdAt'), textOf(value.created, t('docker.detail.empty'))],
              [t('docker.inspect.anonymous'), value.anonymous === true ? t('pg.yes') : t('pg.no')],
            ]),
          ]))
          const options = isRecord(value.options) ? Object.entries(value.options) : []
          if (options.length > 0) {
            sections.push(h('section', { key: 'options', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.options')),
              kvList(options.map(([name, entryValue]) => [name, String(entryValue)])),
            ]))
          }
          const labels = isRecord(value.labels) ? Object.entries(value.labels) : []
          if (labels.length > 0) {
            sections.push(h('section', { key: 'labels', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.labels')),
              kvList(labels.map(([label, entryValue]) => [label, String(entryValue)])),
            ]))
          }
        } else {
          sections.push(h('section', { key: 'overview', className: 'dshDataModalSection' }, kvList([
            ...(beginner ? [] : [['ID', textOf(value.shortId, textOf(value.id, ''))]]),
            ['Driver', textOf(value.driver, '')],
            ['Scope', textOf(value.scope, '')],
            [t('docker.networks.internal'), value.internal === true ? t('pg.yes') : t('pg.no')],
            ['IPv6', value.ipv6 === true ? t('pg.yes') : t('pg.no')],
          ])))
          const subnets = Array.isArray(value.subnets) ? value.subnets.filter(isRecord) : []
          if (subnets.length > 0) {
            sections.push(h('section', { key: 'subnets', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.subnets')),
              kvList(subnets.map((subnet) => [textOf(subnet.subnet, ''), textOf(subnet.gateway, t('docker.detail.empty'))])),
            ]))
          }
          const attached = Array.isArray(value.containers) ? value.containers.filter(isRecord) : []
          if (attached.length > 0) {
            sections.push(h('section', { key: 'attached', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.attached')),
              kvList(attached.map((entry) => [textOf(entry.name, ''), textOf(entry.ipv4Address, textOf(entry.ipv6Address, ''))])),
            ]))
          }
          const labels = isRecord(value.labels) ? Object.entries(value.labels) : []
          if (labels.length > 0) {
            sections.push(h('section', { key: 'labels', className: 'dshDataModalSection' }, [
              h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.labels')),
              kvList(labels.map(([label, entryValue]) => [label, String(entryValue)])),
            ]))
          }
        }
      }
      const body = beginner && sections.length > 1
        ? [sections[0], h(DetailsBlock, { key: 'advanced', t, summary: t('plain.advanced') }, sections.slice(1))]
        : sections
      return h('div', {
        className: 'dshDataOverlay',
        onClick: (event) => {
          if (event.target === event.currentTarget) client.closeInspect()
        },
      }, [
        h('div', { key: 'backdrop', className: 'dshDataBackdrop', onClick: () => client.closeInspect(), 'aria-hidden': true }),
        h('div', {
          key: 'modal',
          className: 'dshDataModal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': `${NS}-inspect-title`,
        }, [
          h('div', { key: 'head', className: 'dshDataModalHead' }, [
            h('h2', { key: 'title', id: `${NS}-inspect-title`, className: 'dshDataModalTitle' }, `${t(titleKey)} · ${inspect.name}`),
            isRecord(inspect.value) && typeof inspect.value.size === 'string' && inspect.value.size !== ''
              ? h('p', { key: 'meta', className: 'dshDataModalMeta' }, inspect.value.size)
              : null,
            h('div', { key: 'actions', className: 'dshDataModalActions' }, [
              h('button', { key: 'refresh', type: 'button', className: 'dshDataButton dshDataButtonCompact', onClick: () => { void client.loadInspect() } }, t('refresh')),
              h('button', { key: 'close', type: 'button', className: 'dshDataButton dshDataButtonCompact', onClick: () => client.closeInspect() }, t('docker.inspect.close')),
            ]),
          ]),
          h('div', { key: 'body', className: 'dshDataModalBody' }, body),
        ]),
      ])
    }

    /** Fixed geometry of the relation graph, so it never needs DOM measurement. */
    const REL_NODE_W = 190
    const REL_NODE_H = 30
    const REL_ROW_H = 46
    const REL_COL_GAP = 96
    const REL_PAD = 16

    /**
     * The deterministic three-column relation graph: images → containers →
     * volumes, with a network badge under every container.
     *
     * @param {object} props - graph props.
     * @returns {object} the SVG.
     */
    function RelationGraph({ relations, client, t }) {
      const images = relations.images
      const containers = relations.containers
      const volumes = relations.volumes
      const rows = Math.max(images.length, containers.length, volumes.length, 1)
      const width = REL_PAD + 2 * (REL_NODE_W + REL_COL_GAP) + REL_NODE_W + REL_PAD
      const height = REL_PAD + 28 + rows * REL_ROW_H + 8
      const colX = [REL_PAD, REL_PAD + REL_NODE_W + REL_COL_GAP, REL_PAD + 2 * (REL_NODE_W + REL_COL_GAP)]
      const nodeY = (index) => REL_PAD + 24 + index * REL_ROW_H
      const imageRows = new Map()
      images.forEach((image, index) => {
        imageRows.set(image.id, index)
        imageRows.set(image.shortId, index)
      })
      const volumeRows = new Map()
      volumes.forEach((volume, index) => volumeRows.set(volume.name, index))
      const pieces = []
      const headers = [
        [t('relations.graph.legend.images'), colX[0]],
        [t('relations.graph.legend.containers'), colX[1]],
        [t('relations.graph.legend.volumes'), colX[2]],
      ]
      headers.forEach(([label, x], index) => {
        pieces.push(h('text', { key: `head-${index}`, className: 'dshDataRelNetText', x, y: REL_PAD + 10 }, label))
      })
      containers.forEach((container, row) => {
        const y2 = nodeY(row) + REL_NODE_H / 2
        const image = relationImageOf(relations, container)
        if (image !== null) {
          const imageRow = imageRows.get(image.id) !== undefined ? imageRows.get(image.id) : imageRows.get(image.shortId)
          if (imageRow !== undefined) {
            const y1 = nodeY(imageRow) + REL_NODE_H / 2
            const mid = (colX[0] + REL_NODE_W + colX[1]) / 2
            pieces.push(h('path', {
              key: `image-line-${row}`,
              className: 'dshDataRelLineImage',
              d: `M ${colX[0] + REL_NODE_W} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${colX[1]} ${y2}`,
            }))
          }
        }
        for (const mount of container.volumes) {
          if (mount.type !== 'volume' || mount.name === null) continue
          const volumeRow = volumeRows.get(mount.name)
          if (volumeRow === undefined) continue
          const yv = nodeY(volumeRow) + REL_NODE_H / 2
          const midVolume = (colX[1] + REL_NODE_W + colX[2]) / 2
          pieces.push(h('path', {
            key: `volume-line-${row}-${mount.name}`,
            className: 'dshDataRelLineVolume',
            d: `M ${colX[1] + REL_NODE_W} ${y2} C ${midVolume} ${y2}, ${midVolume} ${yv}, ${colX[2]} ${yv}`,
          }))
        }
      })
      const node = (key, x, y, label, sub, nodeClass, onClick) => h('g', {
        key,
        className: 'dshDataRelNodeGroup',
        role: 'button',
        tabIndex: 0,
        onClick,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        },
      }, [
        h('rect', { key: 'rect', className: `dshDataRelNode ${nodeClass}`, x, y, width: REL_NODE_W, height: REL_NODE_H, rx: 8 }),
        h('text', { key: 'label', className: 'dshDataRelNodeText', x: x + 10, y: y + (sub === '' ? 19 : 14) }, truncateLabel(label, 26)),
        sub === '' ? null : h('text', { key: 'sub', className: 'dshDataRelNodeSub', x: x + 10, y: y + 24 }, truncateLabel(sub, 30)),
      ])
      images.forEach((image, index) => {
        pieces.push(node(`image-${index}`, colX[0], nodeY(index), imageLabelOf(image), textOf(image.size, ''),
          'dshDataRelNodeImage', () => client.openRelationResource('images', image.id)))
      })
      containers.forEach((container, index) => {
        const y = nodeY(index)
        pieces.push(node(`container-${index}`, colX[1], y, container.name, container.image,
          'dshDataRelNodeContainer', () => client.openRelationContainer(container)))
        const networks = container.networks.map((network) => network.name).filter((name) => name !== '')
        if (networks.length > 0) {
          pieces.push(h('text', {
            key: `network-${index}`,
            className: 'dshDataRelNetText',
            x: colX[1],
            y: y + REL_NODE_H + 13,
          }, truncateLabel(`${t('relations.graph.networks')}: ${networks.join(' · ')}`, 34)))
        }
      })
      volumes.forEach((volume, index) => {
        pieces.push(node(`volume-${index}`, colX[2], nodeY(index), volume.name, textOf(volume.driver, ''),
          'dshDataRelNodeVolume', () => client.openRelationResource('volumes', volume.name)))
      })
      return h('svg', {
        className: 'dshDataRelSvg',
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': t('relations.graph.title'),
      }, pieces)
    }

    /**
     * @param {object} props - summary props.
     * @returns {object} the relations summary strip.
     */
    function RelationsSummary({ relations, t }) {
      const summary = relations.summary
      const cards = [
        { key: 'containers', value: `${summary.running}/${summary.containers}`, meta: t('relations.summary.running', { running: summary.running, total: summary.containers }) },
        { key: 'images', value: String(summary.images), meta: `${t('relations.summary.danglingImages')} ${summary.danglingImages}` },
        { key: 'volumes', value: String(summary.volumes), meta: `${t('relations.summary.unusedVolumes')} ${summary.unusedVolumes}` },
        { key: 'networks', value: String(summary.networks), meta: '' },
      ]
      return h('div', { className: 'dshDataStats' }, cards.map((card) => h('div', {
        key: card.key,
        className: 'dshDataStat',
      }, [
        h('p', { key: 'label', className: 'dshDataStatLabel' }, t(`relations.summary.${card.key}`)),
        h('p', { key: 'value', className: 'dshDataStatValue' }, card.value),
        card.meta === '' ? null : h('p', { key: 'meta', className: 'dshDataStatMeta' }, card.meta),
      ])))
    }

    /**
     * @param {object} props - table props.
     * @returns {object} the container relation table.
     */
    function RelationsTable({ relations, client, snapshot, t }) {
      const beginner = snapshot.viewMode === 'beginner'
      const head = h('thead', { key: 'head' }, h('tr', {}, [
        t('relations.table.container'),
        t('relations.table.state'),
        t('relations.table.image'),
        t('relations.table.volumes'),
        t('relations.table.networks'),
        t('relations.table.ports'),
      ].map((label, index) => h('th', { key: index, className: 'dshDataTh', scope: 'col' }, label))))
      const rows = relations.containers.map((container) => {
        const image = relationImageOf(relations, container)
        const volumeChips = container.volumes.map((mount, index) => {
          if (mount.type === 'volume' && mount.name !== null) {
            return h('button', {
              key: index,
              type: 'button',
              className: 'dshDataChipLink',
              title: mount.destination,
              onClick: () => client.openRelationResource('volumes', mount.name),
            }, h('span', { key: 'text', className: 'dshDataChipLinkText' }, mount.name))
          }
          return beginner
            ? null
            : h('span', {
                key: index,
                className: 'dshDataRelPath',
                title: `${mount.source} → ${mount.destination}`,
              }, truncateLabel(`${mount.source} → ${mount.destination}`, 40))
        })
        const networkChips = container.networks.map((network, index) => h('button', {
          key: index,
          type: 'button',
          className: 'dshDataChipLink',
          title: textOf(network.ipAddress, ''),
          onClick: () => client.openRelationResource('networks', network.name),
        }, h('span', { key: 'text', className: 'dshDataChipLinkText' }, network.name)))
        return h('tr', { key: textOf(container.id, container.name) }, [
          h('td', { key: 'name', className: 'dshDataTd' }, h('button', {
            type: 'button',
            className: 'dshDataLinkButton',
            onClick: () => client.openRelationContainer(container),
          }, container.name)),
          h('td', { key: 'state', className: 'dshDataTd' }, [
            h('span', { key: 'badge', className: 'dshDataBadge' }, beginner ? plainStateLabel(container.state, t) : t(stateLabelKey(container.state))),
            h(RoleChip, { key: 'role', role: container.role, t }),
          ]),
          h('td', { key: 'image', className: 'dshDataTd' }, image === null
            ? h('span', { className: 'dshDataMuted' }, container.image)
            : h('button', {
                type: 'button',
                className: 'dshDataChipLink',
                title: container.image,
                onClick: () => client.openRelationResource('images', image.id),
              }, h('span', { key: 'text', className: 'dshDataChipLinkText' }, imageLabelOf(image)))),
          h('td', { key: 'volumes', className: 'dshDataTd' },
            h('div', { className: 'dshDataRelChips' }, volumeChips.filter(Boolean).length === 0
              ? h('span', { className: 'dshDataMuted' }, '—')
              : volumeChips.filter(Boolean))),
          h('td', { key: 'networks', className: 'dshDataTd' },
            h('div', { className: 'dshDataRelChips' }, networkChips.length === 0
              ? h('span', { className: 'dshDataMuted' }, '—')
              : networkChips)),
          h('td', { key: 'ports', className: 'dshDataTd dshDataTdMono' }, formatPorts(container.ports, t)),
        ])
      })
      return h('section', { className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('relations.table.title')),
          h('span', { key: 'count', className: 'dshDataCardMeta' }, String(relations.containers.length)),
        ]),
        relations.containers.length === 0
          ? h('p', { key: 'empty', className: 'dshDataHint' }, t('relations.table.empty'))
          : h('div', { key: 'wrap', className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
              head,
              h('tbody', { key: 'body' }, rows),
            ])),
      ])
    }

    /**
     * @param {object} props - reverse lookup props.
     * @returns {object} the reverse-lookup card.
     */
    function RelationsReverse({ relations, client, snapshot, t }) {
      const kind = snapshot.relations.kind
      const storedId = snapshot.relations.id
      const resources = kind === 'images'
        ? relations.images.map((image) => ({ id: image.id, label: imageLabelOf(image) }))
        : kind === 'volumes'
          ? relations.volumes.map((volume) => ({ id: volume.name, label: volume.name }))
          : kind === 'networks'
            ? relations.networks.map((network) => ({ id: network.id, label: network.name }))
            : []
      const id = resources.some((resource) => resource.id === storedId) ? storedId : ''
      const associated = relationContainers(relations, kind, id)
      const kindOptions = ['all', 'images', 'volumes', 'networks']
      return h('section', { className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('relations.reverse.title')),
          h('div', { key: 'controls', className: 'dshDataCardActions' }, [
            h('select', {
              key: 'kind',
              className: 'dshDataSelect',
              value: kind,
              'aria-label': t('relations.reverse.kind'),
              onChange: (event) => client.setRelationsFilter(event.target.value, ''),
            }, kindOptions.map((option) => h('option', { key: option, value: option }, t(`relations.reverse.${option}`)))),
            h('select', {
              key: 'resource',
              className: 'dshDataSelect',
              value: id,
              disabled: kind === 'all',
              'aria-label': t('relations.reverse.resource'),
              onChange: (event) => client.setRelationsFilter(kind, event.target.value),
            }, [h('option', { key: 'none', value: '' }, t('relations.reverse.resource')),
              ...resources.map((resource) => h('option', { key: resource.id, value: resource.id }, resource.label))]),
            h('span', { key: 'count', className: 'dshDataCardMeta' }, t('relations.reverse.count', { count: associated.length })),
          ]),
        ]),
        associated.length === 0
          ? h('p', { key: 'empty', className: 'dshDataHint' }, t('relations.reverse.empty'))
          : h('ul', { key: 'list', className: 'dshDataHistoryList' }, associated.map((container) => h('li', {
              key: textOf(container.id, container.name),
            }, h('button', {
              type: 'button',
              className: 'dshDataHistoryButton',
              onClick: () => client.openRelationContainer(container),
            }, [
              h('span', { key: 'name', className: 'dshDataLinkButton' }, container.name),
              h('span', { key: 'state', className: 'dshDataHistoryMeta' }, t(stateLabelKey(container.state))),
              h('span', { key: 'image', className: 'dshDataHistoryMeta' }, container.image),
            ])))),
      ])
    }

    /**
     * The 关联 page: summary, graph, container table and reverse lookup.
     *
     * @param {object} props - tab props.
     * @returns {object} the tab element.
     */
    function RelationsTab({ client, snapshot, t }) {
      const relations = snapshot.relations
      const value = relations.value
      const children = []
      children.push(h('div', { key: 'toolbar', className: 'dshDataToolbar' }, [
        h('p', { key: 'hint', className: 'dshDataHint' }, t('relations.subtitle')),
        h('span', { key: 'meta', className: 'dshDataToolbarMeta' }, value === null
          ? t('loading')
          : `${t('relations.summary.containers')} ${value.summary.containers}`),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: relations.refreshing,
          onClick: () => { void client.loadRelations() },
        }, [refreshGlyph(), t('refresh')]),
      ]))
      if (relations.error !== null) {
        children.push(h(ErrorNotice, {
          mode: snapshot.viewMode,
          key: 'error',
          error: relations.error,
          t,
          onRetry: () => { void client.loadRelations() },
        }))
      }
      if (value === null) {
        children.push(h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
          h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('relations.loading')),
          ...[0, 1, 2].map((index) => h('div', { key: index, className: 'dshDataSkeleton' })),
        ]))
      } else if (value.summary.containers === 0 && value.summary.images === 0 && value.summary.volumes === 0) {
        children.push(h('div', { key: 'empty', className: 'dshDataEmpty' }, [
          h('div', { key: 'art', className: 'dshDataEmptyArt', 'aria-hidden': true }, h(DataIcon, { size: 24 })),
          h('p', { key: 'title', className: 'dshDataEmptyTitle' }, t('relations.empty.title')),
          h('p', { key: 'hint', className: 'dshDataEmptyHint' }, t('relations.empty.hint')),
        ]))
      } else {
        children.push(h(RelationsSummary, { key: 'summary', relations: value, t }))
        const legend = [
          ['relations.graph.legend.images', 'dshDataLegendImage'],
          ['relations.graph.legend.containers', 'dshDataLegendContainer'],
          ['relations.graph.legend.volumes', 'dshDataLegendVolume'],
        ]
        children.push(h('section', { key: 'graph', className: 'dshDataCard' }, [
          h('div', { key: 'head', className: 'dshDataCardHead' }, [
            h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('relations.graph.title')),
            h('div', { key: 'legend', className: 'dshDataRelLegend' }, legend.map(([key, dotClass]) => h('span', {
              key,
              className: 'dshDataLegendItem',
            }, [
              h('span', { key: 'dot', className: `dshDataLegendDot ${dotClass}`, 'aria-hidden': true }),
              t(key),
            ]))),
          ]),
          snapshot.viewMode === 'beginner'
            ? h('p', { key: 'plain-legend', className: 'dshDataHint' }, t('relations.legend.beginner'))
            : null,
          h('div', { key: 'wrap', className: 'dshDataRelGraphWrap' }, h(RelationGraph, { relations: value, client, t })),
        ]))
        children.push(h(RelationsTable, { key: 'table', relations: value, client, snapshot, t }))
        children.push(h(RelationsReverse, { key: 'reverse', relations: value, client, snapshot, t }))
      }
      return h('div', { className: 'dshDataTabBody' }, children)
    }

    /**
     * The second confirmation for a destructive action.
     *
     * Focus moves to *Cancel*, so a stray Enter dismisses instead of deleting;
     * Tab is trapped inside the dialog, Escape and a backdrop click cancel, and
     * the control that opened it gets focus back.
     *
     * @param {object} props - dialog props.
     * @returns {object} the dialog element.
     */
    function ConfirmDialog({ request, t, onCancel, onConfirm, mode }) {
      const cancelRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      /** The latest cancel callback, so the keyboard listener registers once. */
      const cancelHandler = React.useRef(onCancel)
      cancelHandler.current = onCancel

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const previous = document.activeElement
        if (cancelRef.current !== null) cancelRef.current.focus()
        const trap = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancelHandler.current()
            return
          }
          if (event.key !== 'Tab') return
          const root = dialogRef.current
          if (root === null) return
          const focusable = [...root.querySelectorAll('button:not([disabled])')]
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (event.shiftKey) {
            if (active === first || !root.contains(active)) {
              event.preventDefault()
              last.focus()
            }
          } else if (active === last || !root.contains(active)) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', trap, true)
        return () => {
          document.removeEventListener('keydown', trap, true)
          if (previous !== null && previous !== undefined && previous.isConnected) previous.focus()
        }
      }, [])

      const spec = CONFIRM_SPECS[request.kind] === undefined ? CONFIRM_SPECS['container.remove'] : CONFIRM_SPECS[request.kind]
      const rawName = typeof request.name === 'string'
        ? request.name
        : typeof request.key === 'string' ? request.key : ''
      const params = {
        name: snippet(rawName),
        key: snippet(rawName),
        newKey: typeof request.newKey === 'string' ? snippet(request.newKey) : '',
        seconds: request.ttlSeconds === undefined || request.ttlSeconds === null ? '' : String(request.ttlSeconds),
      }
      const title = t(spec.title, params)
      const body = t(spec.body, params)
      const action = t(spec.action)
      const impactKey = impactKeyFor(request.kind, request.role)
      const impact = impactKey === '' ? '' : t(impactKey, params)

      return h('div', {
        className: 'dshDataOverlay',
        onClick: (event) => {
          if (event.target === event.currentTarget) onCancel()
        },
      }, [
        h('div', { key: 'backdrop', className: 'dshDataBackdrop', onClick: onCancel, 'aria-hidden': true }),
        h('div', {
          key: 'dialog',
          ref: dialogRef,
          className: 'dshDataDialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-data-confirm-title',
          'aria-describedby': 'dsh-data-confirm-desc',
        }, [
          h('h2', { key: 'title', id: 'dsh-data-confirm-title', className: 'dshDataDialogTitle' }, title),
          h('p', { key: 'body', id: 'dsh-data-confirm-desc', className: 'dshDataDialogBody' }, body),
          impact === '' || mode === 'expert'
            ? null
            : h('p', { key: 'impact', className: 'dshDataDialogBody dshDataDialogImpact' }, impact),
          h('p', { key: 'hint', className: 'dshDataDialogHint' }, t('confirm.cancelHint')),
          h('div', { key: 'actions', className: 'dshDataDialogActions' }, [
            h('button', {
              key: 'cancel',
              ref: cancelRef,
              type: 'button',
              className: 'dshDataButton dshDataButtonOutline',
              onClick: onCancel,
            }, t('confirm.cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dshDataButton dshDataButtonDanger',
              onClick: onConfirm,
            }, action),
          ]),
        ]),
      ])
    }

    /**
     * The Docker tab: disk usage, four resource sub-tabs, stats columns and the
     * state filter. The sub-tab lives in the store, so the 5 s poll follows the
     * visible list.
     *
     * @param {object} props - tab props.
     * @returns {object} the tab element.
     */
    function DockerTab({ client, snapshot, t }) {
      const docker = snapshot.docker
      const info = snapshot.dockerInfo
      const missing = info !== null && info !== undefined && info.available === false
      const subTab = docker.subTab
      const query = docker.filter.trim().toLowerCase()
      const stateFilter = docker.stateFilter
      const matchesState = (container) => {
        const state = isRecord(container) && typeof container.state === 'string' ? container.state : ''
        if (stateFilter === 'running') return state === 'running'
        if (stateFilter === 'paused') return state === 'paused'
        if (stateFilter === 'stopped') return state !== 'running' && state !== 'paused'
        return true
      }
      const containers = docker.containers.filter((container) => {
        if (!matchesState(container)) return false
        if (query === '') return true
        if (!isRecord(container)) return false
        const fields = [container.name, container.image, container.status, container.state, container.id, container.shortId]
        return fields.some((field) => typeof field === 'string' && field.toLowerCase().indexOf(query) >= 0)
      })
      const imageQuery = docker.imageFilter.trim().toLowerCase()
      const images = docker.images.list.filter((image) => {
        if (!isRecord(image)) return false
        if (imageQuery === '') return true
        return stringListOf(image.repoTags).some((tag) => tag.toLowerCase().indexOf(imageQuery) >= 0) ||
          textOf(image.shortId, '').toLowerCase().indexOf(imageQuery) >= 0 ||
          textOf(image.id, '').toLowerCase().indexOf(imageQuery) >= 0
      })
      const volumeQuery = docker.volumeFilter.trim().toLowerCase()
      const volumes = docker.volumes.list.filter((volume) => {
        if (!isRecord(volume)) return false
        if (volumeQuery === '') return true
        return [volume.name, volume.driver, volume.scope, volume.mountpoint]
          .some((field) => typeof field === 'string' && field.toLowerCase().indexOf(volumeQuery) >= 0)
      })
      const networkQuery = docker.networkFilter.trim().toLowerCase()
      const networks = docker.networks.list.filter((network) => {
        if (!isRecord(network)) return false
        if (networkQuery === '') return true
        return [network.name, network.driver, network.scope, network.id]
          .some((field) => typeof field === 'string' && field.toLowerCase().indexOf(networkQuery) >= 0)
      })
      const rawCounts = {
        containers: docker.containers.length,
        images: docker.images.list.length,
        volumes: docker.volumes.list.length,
        networks: docker.networks.list.length,
        dockerfiles: docker.dockerfiles.list.length,
      }
      const shownCounts = {
        containers: containers.length,
        images: images.length,
        volumes: volumes.length,
        networks: networks.length,
        dockerfiles: docker.dockerfiles.list.length,
      }
      let countText
      if (subTab === 'containers') {
        countText = docker.filter.trim() === '' && stateFilter === 'all'
          ? t('docker.count', { count: rawCounts.containers })
          : t('docker.countFiltered', { shown: shownCounts.containers, total: rawCounts.containers })
      } else if (subTab === 'dockerfiles') {
        countText = t('dockerfile.count', { count: rawCounts.dockerfiles })
      } else {
        const labelKey = subTab === 'images'
          ? 'docker.images.count'
          : subTab === 'volumes' ? 'docker.volumes.count' : 'docker.networks.count'
        countText = shownCounts[subTab] === rawCounts[subTab]
          ? t(labelKey, { count: rawCounts[subTab] })
          : t('docker.resourceCountFiltered', { shown: shownCounts[subTab], total: rawCounts[subTab] })
      }
      const children = []
      if (missing) {
        const reason = info !== null && info !== undefined && typeof info.error === 'string' && info.error !== ''
          ? info.error
          : ''
        children.push(h('div', { key: 'missing', className: 'dshDataNotice dshDataNoticeInfo', role: 'status' }, [
          h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, alertGlyph()),
          h('div', { key: 'body', className: 'dshDataNoticeBody' }, [
            h('p', { key: 'title', className: 'dshDataNoticeText' }, t('docker.unavailable.title')),
            h('p', { key: 'hint', className: 'dshDataNoticeDetail' }, t('docker.unavailable.hint')),
            reason === '' ? null : h('p', { key: 'reason', className: 'dshDataNoticeDetail dshDataMono' }, reason),
          ]),
          h('button', {
            key: 'retry',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: () => { void client.refresh() },
          }, t('retry')),
          h('button', {
            key: 'settings',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            onClick: () => client.openSettings(),
          }, t('docker.unavailable.action')),
        ]))
      }
      if (!missing) children.push(h(DockerDiskUsage, { key: 'disk', snapshot, client, t }))
      children.push(h('div', { key: 'bar', className: 'dshDataDockerBar' }, [
        h('div', {
          key: 'tabs',
          className: 'dshDataSubTabs',
          role: 'tablist',
          'aria-label': t('docker.subtabs.aria'),
          onKeyDown: (event) => {
            const index = DOCKER_SUBTABS.indexOf(subTab)
            let next = -1
            if (event.key === 'ArrowRight') next = (index + 1) % DOCKER_SUBTABS.length
            else if (event.key === 'ArrowLeft') next = (index - 1 + DOCKER_SUBTABS.length) % DOCKER_SUBTABS.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = DOCKER_SUBTABS.length - 1
            if (next < 0) return
            event.preventDefault()
            void client.selectDockerTab(DOCKER_SUBTABS[next])
          },
        }, DOCKER_SUBTABS.map((id) => h('button', {
          key: id,
          type: 'button',
          role: 'tab',
          id: `${NS}-docker-tab-${id}`,
          'aria-selected': subTab === id,
          'aria-controls': `${NS}-docker-panel-${id}`,
          tabIndex: subTab === id ? 0 : -1,
          className: subTab === id ? 'dshDataSubTab dshDataSubTabActive' : 'dshDataSubTab',
          onClick: () => { void client.selectDockerTab(id) },
        }, t(`docker.tab.${id}`)))),
        h('div', { key: 'actions', className: 'dshDataDockerBarActions' }, [
          h('span', { key: 'count', className: 'dshDataToolbarMeta' }, countText),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
            disabled: docker.refreshing,
            onClick: () => { void client.refreshDockerSubTab() },
          }, [refreshGlyph(), t('refresh')]),
          h('span', { key: 'auto', className: 'dshDataHint' }, t('docker.autoRefresh')),
        ]),
      ]))
      if (subTab === 'containers') {
        children.push(h('div', { key: 'filter', className: 'dshDataToolbar' }, [
          h('input', {
            key: 'input',
            className: 'dshDataInput',
            type: 'search',
            value: docker.filter,
            placeholder: t('docker.filter'),
            'aria-label': t('docker.filter'),
            onChange: (event) => client.setDockerFilter(event.target.value),
          }),
          h('div', { key: 'states', className: 'dshDataStateFilters', role: 'group', 'aria-label': t('docker.stateFilter.aria') },
            DOCKER_STATE_FILTERS.map((value) => h('button', {
              key: value,
              type: 'button',
              className: value === stateFilter ? 'dshDataPill dshDataPillActive' : 'dshDataPill',
              'aria-pressed': value === stateFilter,
              onClick: () => client.setDockerStateFilter(value),
            }, t(`docker.stateFilter.${value}`)))),
        ]))
        if (docker.error !== null && !(missing && docker.error.code === 'docker_unavailable')) {
          children.push(h(ErrorNotice, { mode: snapshot.viewMode,
            key: 'error',
            error: docker.error,
            t,
            onRetry: () => { void client.loadDocker() },
          }))
        }
        if (docker.actionError !== null) {
          children.push(h(ErrorNotice, { mode: snapshot.viewMode, key: 'action-error', error: docker.actionError, t }))
        }
        if (!missing) {
          if (docker.status === 'loading' && docker.containers.length === 0) {
            children.push(h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
              h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('docker.loading')),
              ...[0, 1, 2].map((index) => h('div', { key: index, className: 'dshDataSkeleton' })),
            ]))
          } else if (containers.length === 0) {
            const filteredEmpty = docker.containers.length > 0
            children.push(h('div', { key: 'empty', className: 'dshDataEmpty' }, [
              h('div', { key: 'art', className: 'dshDataEmptyArt', 'aria-hidden': true }, h(DataIcon, { size: 24 })),
              h('p', { key: 'title', className: 'dshDataEmptyTitle' }, t(filteredEmpty ? 'docker.filterEmpty.title' : 'docker.empty.title')),
              h('p', { key: 'hint', className: 'dshDataEmptyHint' }, t(filteredEmpty ? 'docker.filterEmpty.hint' : 'docker.empty.hint')),
            ]))
          } else {
            const byProject = new Map()
            for (const container of containers) {
              const project = composeProjectOf(container)
              const key = project === null ? '' : project
              if (!byProject.has(key)) byProject.set(key, [])
              byProject.get(key).push(container)
            }
            const projectNames = [...byProject.keys()].filter((name) => name !== '').sort((left, right) => left.localeCompare(right))
            if (byProject.has('')) projectNames.push('')
            const grouped = projectNames.map((project) => ({ project, list: byProject.get(project) }))
            children.push(h('div', { key: 'groups', className: 'dshDataDockerGroups' },
              grouped.map((group) => {
                const list = h('ul', { key: 'list', className: 'dshDataDockerList' }, group.list.map((container, index) => h(DockerRow, {
                  key: isRecord(container) && typeof container.id === 'string' ? container.id : `container-${index}`,
                  container: isRecord(container) ? container : {},
                  snapshot,
                  client,
                  t,
                })))
                if (grouped.length === 1 && group.project === '') return list
                return h('section', { key: group.project === '' ? '__ungrouped' : group.project, className: 'dshDataGroup' }, [
                  h('div', { key: 'head', className: 'dshDataGroupHead' }, [
                    h('span', { key: 'title', className: 'dshDataGroupTitle' }, group.project === ''
                      ? t('docker.group.ungrouped')
                      : t('docker.group.title', { project: group.project })),
                    h('span', { key: 'count', className: 'dshDataGroupCount' }, t('docker.group.count', { count: group.list.length })),
                  ]),
                  h('div', { key: 'body' }, list),
                ])
              })))
          }
        }
      } else if (subTab === 'dockerfiles') {
        children.push(h(DockerfilesTab, { key: 'dockerfiles', client, snapshot, t }))
      } else {
        const section = docker[subTab]
        const reload = () => {
          if (subTab === 'images') return client.loadImages()
          if (subTab === 'volumes') return client.loadVolumes()
          return client.loadNetworks()
        }
        const filterValue = subTab === 'images'
          ? docker.imageFilter
          : subTab === 'volumes' ? docker.volumeFilter : docker.networkFilter
        children.push(h('div', { key: 'filter', className: 'dshDataToolbar' }, h('input', {
          key: 'input',
          className: 'dshDataInput',
          type: 'search',
          value: filterValue,
          placeholder: t('docker.filterResource'),
          'aria-label': t('docker.filterResource'),
          onChange: (event) => client.setDockerResourceFilter(subTab, event.target.value),
        })))
        if (section.error !== null) {
          children.push(h(ErrorNotice, { mode: snapshot.viewMode,
            key: 'error',
            error: section.error,
            t,
            onRetry: () => { void reload() },
          }))
        }
        if (section.actionError !== null) {
          children.push(h(ErrorNotice, { mode: snapshot.viewMode, key: 'action-error', error: section.actionError, t }))
        }
        const shown = shownCounts[subTab]
        const raw = rawCounts[subTab]
        if (section.status === 'loading' && raw === 0) {
          children.push(h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
            h('span', { key: 'sr', className: 'dshDataSrOnly' }, t(`docker.${subTab}.loading`)),
            ...[0, 1, 2].map((index) => h('div', { key: index, className: 'dshDataSkeleton' })),
          ]))
        } else if (shown === 0) {
          const filteredEmpty = raw > 0
          children.push(h('div', { key: 'empty', className: 'dshDataEmpty' }, [
            h('div', { key: 'art', className: 'dshDataEmptyArt', 'aria-hidden': true }, h(DataIcon, { size: 24 })),
            h('p', { key: 'title', className: 'dshDataEmptyTitle' }, t(filteredEmpty ? 'docker.filterEmpty.title' : `docker.${subTab}.empty.title`)),
            h('p', { key: 'hint', className: 'dshDataEmptyHint' }, t(filteredEmpty ? 'docker.filterEmpty.hint' : `docker.${subTab}.empty.hint`)),
          ]))
        } else if (subTab === 'images') {
          children.push(h('ul', { key: 'list', className: 'dshDataDockerList' }, images.map((image, index) => h(DockerImageRow, {
            key: textOf(isRecord(image) ? image.id : '', `image-${index}`),
            image,
            snapshot,
            client,
            t,
          }))))
        } else if (subTab === 'volumes') {
          children.push(h('ul', { key: 'list', className: 'dshDataDockerList' }, volumes.map((volume, index) => h(DockerVolumeRow, {
            key: textOf(isRecord(volume) ? volume.name : '', `volume-${index}`),
            volume,
            snapshot,
            client,
            t,
          }))))
        } else {
          children.push(h('ul', { key: 'list', className: 'dshDataDockerList' }, networks.map((network, index) => h(DockerNetworkRow, {
            key: textOf(isRecord(network) ? network.name : '', `network-${index}`),
            network,
            snapshot,
            client,
            t,
          }))))
        }
      }
      children.push(h(DockerInspectModal, { key: 'inspect', snapshot, client, t }))
      return h('div', { className: 'dshDataTabBody' }, children)
    }

    /**
     * One container row, with its logs/details drawers nested underneath.
     *
     * @param {object} props - row props.
     * @returns {object} the row element.
     */
    function DockerRow({ container, snapshot, client, t }) {
      const docker = snapshot.docker
      const id = typeof container.id === 'string' && container.id !== ''
        ? container.id
        : textOf(container.shortId, '')
      const name = textOf(container.name, textOf(container.shortId, id))
      const state = typeof container.state === 'string' ? container.state : ''
      const busy = docker.busy !== '' && docker.busy.indexOf(`${id}:`) === 0
      const logsOpen = docker.logs.id === id
      const detailOpen = docker.detail.id === id
      const short = textOf(container.shortId, id.length > 12 ? id.slice(0, 12) : id)
      const beginner = snapshot.viewMode === 'beginner'
      const role = roleForContainer(snapshot, name)
      const stateText = beginner ? plainStateLabel(state, t) : t(stateLabelKey(state))
      const statsById = docker.statsById
      const stat = isRecord(statsById) && isRecord(statsById[id]) ? statsById[id] : null
      const cpuText = stat !== null && typeof stat.cpuPercent === 'number' ? `${stat.cpuPercent.toFixed(1)}%` : t('docker.stats.none')
      let memoryText = t('docker.stats.none')
      if (stat !== null && isRecord(stat.memory)) {
        if (stat.memory.limitBytes > 0) {
          memoryText = `${formatBytes(stat.memory.usageBytes)} / ${formatBytes(stat.memory.limitBytes)}`
        } else if (stat.memory.usageBytes > 0) {
          memoryText = formatBytes(stat.memory.usageBytes)
        }
      }
      const actions = []
      // Start and unpause are safe, reversible one-click actions; stop,
      // restart, pause and remove go through the confirmation dialog.
      const pushDirect = (action, label) => {
        actions.push(h('button', {
          key: action,
          type: 'button',
          className: 'dshDataButton dshDataButtonCompact',
          disabled: busy,
          onClick: () => client.dockerAction(id, action),
        }, label))
      }
      const pushConfirmed = (action, label) => {
        actions.push(h('button', {
          key: action,
          type: 'button',
          className: 'dshDataButton dshDataButtonCompact',
          disabled: busy,
          onClick: () => client.requestContainerAction(id, name, action, role),
        }, label))
      }
      if (state === 'running') {
        pushConfirmed('stop', t('docker.action.stop'))
        pushConfirmed('restart', t('docker.action.restart'))
        pushConfirmed('pause', t('docker.action.pause'))
      } else if (state === 'paused') {
        pushDirect('unpause', t('docker.action.unpause'))
        pushConfirmed('stop', t('docker.action.stop'))
        pushConfirmed('restart', t('docker.action.restart'))
      } else {
        pushDirect('start', t('docker.action.start'))
      }
      actions.push(h('button', {
        key: 'logs',
        type: 'button',
        className: 'dshDataButton dshDataButtonCompact',
        'aria-expanded': logsOpen,
        onClick: () => client.toggleLogs(id, name),
      }, t('docker.action.logs')))
      actions.push(h('button', {
        key: 'detail',
        type: 'button',
        className: 'dshDataButton dshDataButtonCompact',
        'aria-expanded': detailOpen,
        onClick: () => client.toggleDetail(id, name),
      }, t(detailOpen ? 'docker.action.hideDetails' : 'docker.action.details')))
      actions.push(h('button', {
        key: 'remove',
        type: 'button',
        className: 'dshDataIconButton dshDataIconButtonDanger',
        title: t('docker.action.remove'),
        'aria-label': t('docker.action.remove'),
        disabled: busy,
        onClick: () => client.requestContainerAction(id, name, 'remove', role),
      }, trashGlyph()))
      return h('li', { className: 'dshDataDockerItem', 'aria-busy': busy }, [
        h('div', { key: 'row', className: 'dshDataDockerRow' }, [
          h('span', {
            key: 'dot',
            className: `dshDataDot dshDataDot${stateTone(state)}`,
            title: stateText,
            'aria-hidden': true,
          }),
          h('div', { key: 'main', className: 'dshDataDockerMain' }, [
            h('div', { key: 'title', className: 'dshDataDockerTitleLine' }, [
              h('span', { key: 'name', className: 'dshDataDockerName', title: name }, name),
              beginner ? null : h('span', { key: 'id', className: 'dshDataDockerId' }, short),
              h(RoleChip, { key: 'role', role, t }),
              h('span', { key: 'state', className: 'dshDataBadge' }, stateText),
            ]),
            h('div', { key: 'meta', className: 'dshDataDockerMeta' }, [
              h('span', { key: 'image', className: 'dshDataDockerImage', title: textOf(container.image, '') }, textOf(container.image, '')),
              h('span', { key: 'status', className: 'dshDataDockerStatus' }, textOf(container.status, '')),
              h('span', { key: 'ports', className: 'dshDataDockerPorts' }, formatPorts(container.ports, t)),
            ]),
          ]),
          h('div', { key: 'metrics', className: 'dshDataDockerMetrics' }, [
            h('span', { key: 'cpu', className: 'dshDataDockerMetric' }, [
              h('span', { key: 'label', className: 'dshDataDockerMetricLabel' }, t('docker.stats.cpu')),
              cpuText,
            ]),
            h('span', { key: 'mem', className: 'dshDataDockerMetric', title: memoryText }, [
              h('span', { key: 'label', className: 'dshDataDockerMetricLabel' }, t('docker.stats.memory')),
              memoryText,
            ]),
          ]),
          h('div', { key: 'actions', className: 'dshDataDockerActions' }, [
            busy ? h('span', { key: 'busy', className: 'dshDataBusy' }, [
              h('span', { key: 'spinner', className: 'dshDataSpinner', 'aria-hidden': true }),
              t('docker.busy'),
            ]) : null,
            ...actions,
          ]),
        ]),
        logsOpen ? h(DockerLogsDrawer, { key: 'logs', snapshot, client, t }) : null,
        detailOpen ? h(DockerDetail, { key: 'detail', snapshot, client, t }) : null,
      ])
    }

    /**
     * @param {object} props - drawer props.
     * @returns {object} the logs drawer.
     */
    function DockerLogsDrawer({ snapshot, client, t }) {
      const logs = snapshot.docker.logs
      const body = []
      if (logs.status === 'loading') {
        body.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('docker.logs.loading')))
      } else if (logs.status === 'error') {
        body.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: logs.error,
          t,
          onRetry: () => { void client.loadLogs() },
        }))
      } else if (logs.text === '') {
        body.push(h('p', { key: 'empty', className: 'dshDataHint' }, t('docker.logs.empty')))
      } else {
        body.push(h('pre', { key: 'logs', className: 'dshDataLogs', tabIndex: 0 }, logs.text))
      }
      return h('div', { className: 'dshDataDrawer' }, [
        h('div', { key: 'head', className: 'dshDataDrawerHead' }, [
          h('h3', { key: 'title', className: 'dshDataDrawerTitle' }, `${t('docker.logs.title')} · ${logs.name}`),
          h('div', { key: 'actions', className: 'dshDataDrawerActions' }, [
            h('label', { key: 'tail', className: 'dshDataInlineField' }, [
              h('span', { key: 'label' }, t('docker.logs.tail')),
              h('select', {
                key: 'select',
                className: 'dshDataSelect',
                value: String(logs.tail),
                'aria-label': t('docker.logs.tail'),
                onChange: (event) => client.setLogTail(Number(event.target.value)),
              }, LOG_TAIL_OPTIONS.map((size) => h('option', { key: size, value: String(size) }, String(size)))),
            ]),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact',
              onClick: () => { void client.loadLogs() },
            }, t('docker.logs.refresh')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact',
              onClick: () => client.closeLogs(),
            }, t('close')),
          ]),
        ]),
        ...body,
      ])
    }

    /**
     * @param {object} props - drawer props.
     * @returns {object} the details drawer.
     */
    function DockerDetail({ snapshot, client, t }) {
      const detail = snapshot.docker.detail
      const children = [
        h('div', { key: 'head', className: 'dshDataDrawerHead' }, [
          h('h3', { key: 'title', className: 'dshDataDrawerTitle' }, `${t('docker.action.details')} · ${detail.name}`),
          h('div', { key: 'actions', className: 'dshDataDrawerActions' }, [
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact',
              onClick: () => { void client.loadDetail() },
            }, t('refresh')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact',
              onClick: () => client.closeDetail(),
            }, t('close')),
          ]),
        ]),
      ]
      if (detail.status === 'loading') {
        children.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('docker.detail.loading')))
      } else if (detail.status === 'error') {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: detail.error,
          t,
          onRetry: () => { void client.loadDetail() },
        }))
      } else if (isRecord(detail.container)) {
        const container = detail.container
        const beginner = snapshot.viewMode === 'beginner'
        const kv = (label, value) => (value === null || value === undefined || value === ''
          ? h('li', { key: label, className: 'dshDataKvRow' }, [
              h('span', { key: 'key', className: 'dshDataKvKey' }, label),
              h('span', { key: 'value', className: 'dshDataKvValue dshDataKvValueMuted' }, t('docker.detail.empty')),
            ])
          : h('li', { key: label, className: 'dshDataKvRow' }, [
              h('span', { key: 'key', className: 'dshDataKvKey' }, label),
              h('span', { key: 'value', className: 'dshDataKvValue', title: String(value) }, String(value)),
            ]))
        const overview = [
          beginner ? null : kv('ID', textOf(container.id, '')),
          kv(t('docker.detail.health'), container.health),
          kv(t('docker.detail.restartCount'), container.restartCount),
          kv('Restart policy', textOf(container.restartPolicy, '')),
          kv(t('docker.detail.exitCode'), container.exitCode),
          kv(t('docker.detail.startedAt'), container.startedAt),
          kv(t('docker.detail.finishedAt'), container.finishedAt),
          kv(t('docker.detail.platform'), container.platform),
          kv(t('docker.detail.createdAt'), container.createdAt),
          kv(t('docker.detail.logPath'), container.logPath),
        ]
        const env = Array.isArray(container.env) ? container.env : []
        const mounts = Array.isArray(container.mounts) ? container.mounts : []
        const networks = Array.isArray(container.networks) ? container.networks : []
        const labels = isRecord(container.labels) ? Object.entries(container.labels) : []
        const overviewRows = overview.filter((row) => row !== null)
        const grid = h('div', { key: 'grid', className: 'dshDataDetailGrid' }, [
          h('section', { key: 'overview', className: 'dshDataDetailSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.detail.overview')),
            h('ul', { key: 'list', className: 'dshDataKvList' }, overviewRows),
            h('h4', { key: 'entry-title', className: 'dshDataDetailTitle' }, t('docker.detail.entrypoint')),
            h('pre', { key: 'entrypoint', className: 'dshDataPre' }, textOf(container.entrypoint, t('docker.detail.empty'))),
            h('h4', { key: 'cmd-title', className: 'dshDataDetailTitle' }, t('docker.detail.cmd')),
            h('pre', { key: 'cmd', className: 'dshDataPre' }, textOf(container.cmd, t('docker.detail.empty'))),
          ]),
          h('section', { key: 'env', className: 'dshDataDetailSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.detail.env')),
            env.length === 0
              ? h('p', { key: 'empty', className: 'dshDataHint' }, t('docker.detail.empty'))
              : h('ul', { key: 'list', className: 'dshDataKvList' }, env.map((entry, index) => h('li', {
                  key: isRecord(entry) && typeof entry.key === 'string' ? entry.key : index,
                  className: 'dshDataKvRow',
                }, [
                  h('span', { key: 'key', className: 'dshDataKvKey', title: isRecord(entry) ? String(entry.key) : '' }, isRecord(entry) ? String(entry.key) : ''),
                  h('span', { key: 'value', className: 'dshDataKvValue' }, isRecord(entry) ? String(entry.value) : ''),
                ]))),
          ]),
          h('section', { key: 'mounts', className: 'dshDataDetailSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.detail.mounts')),
            mounts.length === 0
              ? h('p', { key: 'empty', className: 'dshDataHint' }, t('docker.detail.empty'))
              : h('ul', { key: 'list', className: 'dshDataKvList' }, mounts.map((mount, index) => h('li', {
                  key: index,
                  className: 'dshDataKvRow',
                }, [
                  h('span', { key: 'key', className: 'dshDataKvKey', title: isRecord(mount) ? String(mount.source) : '' }, isRecord(mount) ? String(mount.destination) : ''),
                  h('span', { key: 'value', className: 'dshDataKvValue' }, isRecord(mount)
                    ? `${String(mount.source)} · ${t(mount.rw === true ? 'docker.detail.modeRw' : 'docker.detail.modeRo')}`
                    : ''),
                ]))),
          ]),
          h('section', { key: 'networks', className: 'dshDataDetailSection' }, [
            h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.detail.networks')),
            networks.length === 0
              ? h('p', { key: 'empty', className: 'dshDataHint' }, t('docker.detail.empty'))
              : h('ul', { key: 'list', className: 'dshDataKvList' }, networks.map((network, index) => h('li', {
                  key: index,
                  className: 'dshDataKvRow',
                }, [
                  h('span', { key: 'key', className: 'dshDataKvKey' }, isRecord(network) ? String(network.name) : ''),
                  h('span', { key: 'value', className: 'dshDataKvValue' }, isRecord(network) && typeof network.ipAddress === 'string' ? network.ipAddress : '—'),
                ]))),
          ]),
          labels.length === 0
            ? null
            : h('section', { key: 'labels', className: 'dshDataDetailSection' }, [
                h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('docker.inspect.labels')),
                h('ul', { key: 'list', className: 'dshDataKvList' }, labels.map(([label, value]) => h('li', {
                  key: label,
                  className: 'dshDataKvRow',
                }, [
                  h('span', { key: 'key', className: 'dshDataKvKey', title: label }, label),
                  h('span', { key: 'value', className: 'dshDataKvValue' }, String(value)),
                ]))),
              ]),
        ])
        if (beginner) {
          const stateText = plainStateLabel(textOf(container.state, ''), t)
          children.push(h('p', { key: 'plain-summary', className: 'dshDataHint' },
            `${stateText} · ${textOf(container.image, '')}${typeof container.status === 'string' ? ` · ${container.status}` : ''}`))
          children.push(h(DetailsBlock, { key: 'advanced', t, summary: t('plain.advanced') }, grid))
        } else {
          children.push(grid)
        }
      }
      return h('div', { className: 'dshDataDrawer' }, children)
    }

    /**
     * @param {object} props - summary props.
     * @returns {object} the Redis summary cards.
     */
    function RedisSummary({ summary, t }) {
      const none = t('redis.summary.none')
      const memory = summary.usedMemoryHuman !== null
        ? summary.usedMemoryHuman
        : typeof summary.usedMemoryBytes === 'number' ? formatBytes(summary.usedMemoryBytes) : none
      const cards = [
        ['version', summary.version === null ? none : summary.version],
        ['uptime', summary.uptimeSeconds === null ? none : formatUptime(summary.uptimeSeconds, t)],
        ['clients', summary.connectedClients === null ? none : String(summary.connectedClients)],
        ['memory', memory],
        ['keys', String(summary.totalKeys)],
        ['ops', summary.opsPerSec === null ? none : String(summary.opsPerSec)],
        ['hitRate', summary.hitRate === null ? none : t('redis.percent', { percent: formatHitRate(summary.hitRate) })],
      ]
      return h('div', { className: 'dshDataStats' }, cards.map(([name, value]) => h('div', {
        key: name,
        className: 'dshDataStat',
      }, [
        h('p', { key: 'label', className: 'dshDataStatLabel' }, t(`redis.summary.${name}`)),
        h('p', { key: 'value', className: 'dshDataStatValue', title: value }, value),
      ])))
    }

    /**
     * Render one Redis value by its type.
     *
     * @param {object} props - value props.
     * @returns {object} the value element.
     */
    function RedisValueView({ detail, t }) {
      const type = typeof detail.type === 'string' ? detail.type : ''
      const value = detail.value
      if (value === null || value === undefined) {
        return h('p', { className: 'dshDataHint' }, t('redis.key.null'))
      }
      if (type === 'string') {
        const text = String(value)
        const cut = text.length > MAX_VALUE_CHARS
        return h('div', {}, [
          h('pre', { key: 'value', className: 'dshDataValue' }, cut ? text.slice(0, MAX_VALUE_CHARS) : text),
          cut ? h('p', { key: 'note', className: 'dshDataHint' }, t('redis.key.truncated', { limit: MAX_VALUE_CHARS })) : null,
        ])
      }
      if (type === 'list' || type === 'set') {
        const items = Array.isArray(value) ? value : []
        return h('div', {}, [
          h('ol', { key: 'list', className: 'dshDataValueList' }, items.map((item, index) => h('li', {
            key: index,
            className: 'dshDataValueItem',
          }, [
            h('span', { key: 'index', className: 'dshDataValueIndex' }, String(index + 1)),
            h('code', { key: 'value', className: 'dshDataValueText' }, String(item)),
          ]))),
          h('p', { key: 'count', className: 'dshDataHint' }, t('redis.key.items', { count: items.length })),
        ])
      }
      if (type === 'zset') {
        const items = Array.isArray(value) ? value : []
        return h('div', {}, [
          h('ul', { key: 'list', className: 'dshDataValueList' }, items.map((item, index) => h('li', {
            key: index,
            className: 'dshDataValueItem',
          }, [
            h('code', { key: 'member', className: 'dshDataValueText' }, isRecord(item) ? String(item.member) : String(item)),
            h('span', { key: 'score', className: 'dshDataValueIndex' }, isRecord(item)
              ? `${t('redis.key.score')} ${String(item.score)}`
              : ''),
          ]))),
          h('p', { key: 'count', className: 'dshDataHint' }, t('redis.key.items', { count: items.length })),
        ])
      }
      if (type === 'hash') {
        const entries = isRecord(value) ? Object.keys(value).map((field) => [field, value[field]]) : []
        return h('div', {}, [
          h('ul', { key: 'list', className: 'dshDataKvList' }, entries.map(([field, entryValue]) => h('li', {
            key: field,
            className: 'dshDataKvRow',
          }, [
            h('span', { key: 'field', className: 'dshDataKvKey' }, field),
            h('span', { key: 'value', className: 'dshDataKvValue' }, String(entryValue)),
          ]))),
          h('p', { key: 'count', className: 'dshDataHint' }, t('redis.key.items', { count: entries.length })),
        ])
      }
      if (type === 'stream') {
        const entries = Array.isArray(value) ? value : []
        return h('div', {}, [
          h('ul', { key: 'list', className: 'dshDataValueList' }, entries.map((entry, index) => h('li', {
            key: index,
            className: 'dshDataValueItem',
          }, [
            h('code', { key: 'id', className: 'dshDataValueText' }, isRecord(entry) ? String(entry.id) : String(entry)),
            h('span', { key: 'fields', className: 'dshDataHint' }, isRecord(entry) ? safeJson(entry.fields) : ''),
          ]))),
          h('p', { key: 'count', className: 'dshDataHint' }, t('redis.key.items', { count: entries.length })),
        ])
      }
      return h('pre', { className: 'dshDataValue' }, safeJson(value))
    }

    /**
     * The Redis server card: DB size and the client connection table.
     *
     * @param {object} props - section props.
     * @returns {object} the server section.
     */
    function RedisServerSection({ client, snapshot, t }) {
      const redis = snapshot.redis
      const dbsize = redis.dbsize
      const clients = redis.clients
      const children = [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('redis.server.title')),
          h('span', { key: 'meta', className: 'dshDataCardMeta' }, clients.status === 'ready'
            ? t('redis.server.clientsCount', { count: clients.list.length })
            : ''),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            disabled: dbsize.status === 'loading' || clients.refreshing,
            onClick: () => { void client.refreshRedisServer() },
          }, [refreshGlyph(), t('refresh')]),
        ]),
        h('div', { key: 'stats', className: 'dshDataStats' }, [
          h('div', { key: 'db', className: 'dshDataStat' }, [
            h('p', { key: 'label', className: 'dshDataStatLabel' }, t('redis.server.dbsize')),
            h('p', { key: 'value', className: 'dshDataStatValue' }, dbsize.keys === null
              ? (dbsize.status === 'loading' ? t('loading') : t('docker.stats.none'))
              : String(dbsize.keys)),
          ]),
          h('div', { key: 'clients', className: 'dshDataStat' }, [
            h('p', { key: 'label', className: 'dshDataStatLabel' }, t('redis.server.clients')),
            h('p', { key: 'value', className: 'dshDataStatValue' }, clients.status === 'ready'
              ? String(clients.list.length)
              : (clients.status === 'loading' ? t('loading') : t('docker.stats.none'))),
          ]),
        ]),
      ]
      if (dbsize.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'dbsize-error',
          error: dbsize.error,
          t,
          onRetry: () => { void client.refreshRedisServer() },
        }))
      }
      if (clients.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'clients-error',
          error: clients.error,
          t,
          onRetry: () => { void client.refreshRedisServer() },
        }))
      }
      if (clients.status === 'loading' && clients.list.length === 0) {
        children.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('redis.server.loading')))
      } else if (clients.list.length === 0) {
        children.push(h('p', { key: 'empty', className: 'dshDataHint' }, t('redis.clients.empty')))
      } else {
        const columns = [
          ['id', t('redis.clients.id')],
          ['addr', t('redis.clients.addr')],
          ['name', t('redis.clients.name')],
          ['ageSeconds', t('redis.clients.age')],
          ['idleSeconds', t('redis.clients.idle')],
          ['db', t('redis.clients.db')],
          ['command', t('redis.clients.command')],
          ['user', t('redis.clients.user')],
        ]
        const clientsTable = h('div', { key: 'table', className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
          h('thead', { key: 'head' }, h('tr', {}, columns.map(([, label], index) => h('th', {
            key: index,
            className: 'dshDataTh',
            scope: 'col',
          }, label)))),
          h('tbody', { key: 'body' }, clients.list.map((client) => h('tr', { key: `${client.id}-${client.addr}` },
            columns.map(([field, label], index) => {
              let value
              if (field === 'ageSeconds' || field === 'idleSeconds') value = formatUptime(client[field], t)
              else value = client[field]
              return h('td', {
                key: index,
                className: field === 'command' && index > 0 ? 'dshDataTd dshDataTdMono' : 'dshDataTd',
                title: field === 'command' ? String(value) : undefined,
              }, String(value === undefined || value === null || value === '' ? '—' : value))
            })))),
        ]))
        children.push(snapshot.viewMode === 'beginner'
          ? h(DetailsBlock, { key: 'clients-advanced', t, summary: t('plain.advanced') }, clientsTable)
          : clientsTable)
      }
      return h('section', { className: 'dshDataCard' }, children)
    }

    /**
     * The key-action strip: memory, rename, expiry and persist, with the
     * confirmation-backed rename/expire requests.
     *
     * @param {object} props - action props.
     * @returns {object|null} the actions block.
     */
    function RedisKeyActions({ client, snapshot, t }) {
      const redis = snapshot.redis
      const selected = redis.selected
      const action = redis.action
      const detail = selected.detail
      if (detail === null) return null
      const memory = selected.memory
      const memoryText = memory.status === 'ready' && memory.data !== null
        ? memory.data.human
        : memory.status === 'loading' ? t('redis.key.memory.loading') : t('docker.stats.none')
      const renameDraft = redis.renameDraft
      const expireDraft = redis.expireDraft
      const expireValue = Number(expireDraft)
      const expireValid = Number.isInteger(expireValue) && expireValue >= 1 && expireValue <= 31536000
      const busy = action.status === 'running'
      const children = [
        h('div', { key: 'meta', className: 'dshDataKeyMetaRow' }, [
          h('span', { key: 'memory' }, `${t('redis.key.memory')}: ${memoryText}`),
          h('span', { key: 'ttl' }, `${t('plain.ttl')}: ${snapshot.viewMode === 'beginner' ? plainTtl(detail.ttl, t) : formatTtl(detail.ttl, t)}`),
        ]),
      ]
      if (action.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode, key: 'action-error', error: action.error, t }))
      }
      if (action.notice !== null) {
        children.push(h('p', { key: 'notice', className: 'dshDataNoticeOk', role: 'status' },
          t(action.notice.code, action.notice.params)))
      }
      children.push(h('div', { key: 'forms', className: 'dshDataKeyActions' }, [
        h(FormField, {
          key: 'rename-field',
          id: `${NS}-redis-rename`,
          label: t('redis.key.rename'),
        }, h('input', {
          id: `${NS}-redis-rename`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: renameDraft,
          placeholder: t('redis.key.renamePlaceholder'),
          onChange: (event) => client.setRedisRenameDraft(event.target.value),
        })),
        h('button', {
          key: 'rename',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: busy || renameDraft.trim() === '' || renameDraft.trim() === selected.key,
          onClick: () => { void client.requestRedisRename() },
        }, t('redis.key.renameAction')),
        h(FormField, {
          key: 'expire-field',
          id: `${NS}-redis-expire`,
          label: t('redis.key.expire'),
        }, h('input', {
          id: `${NS}-redis-expire`,
          className: 'dshDataInput',
          type: 'number',
          min: '1',
          value: expireDraft,
          placeholder: t('redis.key.expirePlaceholder'),
          onChange: (event) => client.setRedisExpireDraft(event.target.value),
        })),
        h('button', {
          key: 'expire',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: busy || !expireValid,
          onClick: () => { void client.requestRedisExpire() },
        }, t('redis.key.expireAction')),
        h('button', {
          key: 'persist',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: busy || detail.ttl === -1,
          onClick: () => { void client.persistRedisKey() },
        }, t('redis.key.persistAction')),
      ]))
      return h('div', { className: 'dshDataEditor' }, [
        h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t('redis.key.actions')),
        ...children,
      ])
    }

    /**
     * The type-specific write editor: hash field, list push, or set add/remove.
     *
     * @param {object} props - editor props.
     * @returns {object|null} the editor block.
     */
    function RedisTypeEditor({ client, snapshot, t }) {
      const redis = snapshot.redis
      const detail = redis.selected.detail
      const editor = redis.editor
      if (detail === null) return null
      const type = detail.type
      if (type !== 'hash' && type !== 'list' && type !== 'set') return null
      const titleKey = type === 'hash'
        ? 'redis.editor.hash.title'
        : type === 'list' ? 'redis.editor.list.title' : 'redis.editor.set.title'
      const fields = []
      if (type === 'hash') {
        fields.push(h(FormField, {
          key: 'field',
          id: `${NS}-redis-editor-field`,
          label: t('redis.editor.hash.field'),
        }, h('input', {
          id: `${NS}-redis-editor-field`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: editor.field,
          onChange: (event) => client.setRedisEditor('field', event.target.value),
        })))
        fields.push(h(FormField, {
          key: 'value',
          id: `${NS}-redis-editor-value`,
          label: t('redis.editor.hash.value'),
        }, h('input', {
          id: `${NS}-redis-editor-value`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: editor.value,
          onChange: (event) => client.setRedisEditor('value', event.target.value),
        })))
      } else if (type === 'list') {
        fields.push(h(FormField, {
          key: 'value',
          id: `${NS}-redis-editor-list-value`,
          label: t('redis.set.value'),
        }, h('input', {
          id: `${NS}-redis-editor-list-value`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: editor.value,
          onChange: (event) => client.setRedisEditor('value', event.target.value),
        })))
        fields.push(h(FormField, {
          key: 'side',
          id: `${NS}-redis-editor-side`,
          label: t('redis.editor.list.side'),
        }, h('select', {
          id: `${NS}-redis-editor-side`,
          className: 'dshDataSelect',
          value: editor.side,
          onChange: (event) => client.setRedisEditor('side', event.target.value),
        }, [
          h('option', { key: 'right', value: 'right' }, t('redis.editor.list.right')),
          h('option', { key: 'left', value: 'left' }, t('redis.editor.list.left')),
        ])))
      } else {
        fields.push(h(FormField, {
          key: 'member',
          id: `${NS}-redis-editor-member`,
          label: t('redis.editor.set.member'),
        }, h('input', {
          id: `${NS}-redis-editor-member`,
          className: 'dshDataInput dshDataInputMono',
          type: 'text',
          value: editor.member,
          onChange: (event) => client.setRedisEditor('member', event.target.value),
        })))
      }
      const running = editor.status === 'running'
      const actions = type === 'set'
        ? [
            h('button', {
              key: 'add',
              type: 'button',
              className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
              disabled: running || editor.member.trim() === '',
              onClick: () => { void client.submitRedisEditor() },
            }, t('redis.editor.add')),
            h('button', {
              key: 'remove',
              type: 'button',
              className: 'dshDataButton dshDataButtonDanger dshDataButtonCompact',
              disabled: running || editor.member.trim() === '',
              onClick: () => { void client.removeRedisSetMember() },
            }, t('redis.editor.remove')),
          ]
        : [
            h('button', {
              key: 'submit',
              type: 'button',
              className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
              disabled: running || (type === 'hash' && editor.field.trim() === ''),
              onClick: () => { void client.submitRedisEditor() },
            }, t('redis.editor.submit')),
          ]
      return h('div', { className: 'dshDataEditor' }, [
        h('h4', { key: 'title', className: 'dshDataDetailTitle' }, t(titleKey)),
        h('div', { key: 'fields', className: 'dshDataEditorRow' }, fields),
        h('div', { key: 'actions', className: 'dshDataEditorRow' }, actions),
        editor.error !== null
          ? h(ErrorNotice, { mode: snapshot.viewMode, key: 'error', error: editor.error, t })
          : null,
        editor.notice !== null
          ? h('p', { key: 'notice', className: 'dshDataEditorNotice', role: 'status' },
              t(editor.notice.code, editor.notice.params))
          : null,
      ])
    }

    /**
     * The Redis tab: overview cards, SCAN browser, key inspector and set form.
     *
     * @param {object} props - tab props.
     * @returns {object} the tab element.
     */
    function RedisTab({ client, snapshot, t }) {
      const redis = snapshot.redis
      const scan = redis.scan
      const selected = redis.selected
      const children = [h(InstanceBar, { key: 'instances', client, snapshot, t, service: 'redis' })]
      if (redis.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: redis.error,
          t,
          onRetry: () => { void client.loadRedis() },
        }))
      }
      if (redis.summary !== null) {
        children.push(h(RedisSummary, { key: 'summary', summary: redis.summary, t }))
      } else if (redis.status === 'loading') {
        children.push(h('div', { key: 'summary-loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
          h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('loading')),
          h('div', { key: '0', className: 'dshDataSkeleton' }),
        ]))
      }
      children.push(h(RedisServerSection, { key: 'server', client, snapshot, t }))
      const browser = h('section', { key: 'browser', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('redis.browser.title')),
          h('span', { key: 'meta', className: 'dshDataCardMeta' }, scan.loaded ? t('redis.browser.scanned', { count: scan.keys.length }) : ''),
          h('div', { key: 'actions', className: 'dshDataCardActions' }, h('button', {
            key: 'write',
            type: 'button',
            className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
            onClick: () => client.openRedisWizard(),
          }, t('redis.wizard.open'))),
        ]),
        h('form', {
          key: 'scan',
          className: 'dshDataScanBar',
          onSubmit: (event) => {
            event.preventDefault()
            void client.scanRedis()
          },
        }, [
          h('input', {
            key: 'match',
            className: 'dshDataInput',
            type: 'search',
            value: scan.match,
            placeholder: t('redis.browser.patternPlaceholder'),
            'aria-label': t('redis.browser.pattern'),
            onChange: (event) => client.setRedisScan('match', event.target.value),
          }),
          h('select', {
            key: 'type',
            className: 'dshDataSelect',
            value: scan.type,
            'aria-label': t('redis.browser.type'),
            onChange: (event) => client.setRedisScan('type', event.target.value),
          }, [
            h('option', { key: 'any', value: '' }, t('redis.browser.typeAny')),
            ...REDIS_TYPES.map((type) => h('option', { key: type, value: type },
              snapshot.viewMode === 'beginner' ? plainRedisType(type, t) : type)),
          ]),
          h('button', {
            key: 'submit',
            type: 'submit',
            className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
            disabled: scan.loading,
          }, scan.loading ? t('redis.browser.loading') : t('redis.browser.scan')),
        ]),
        scan.error === null ? null : h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'scan-error',
          error: scan.error,
          t,
          onRetry: () => { void client.scanRedis() },
        }),
        !scan.loaded && (scan.loading || redis.status === 'loading' || redis.status === 'idle')
          ? h('div', { key: 'loading', className: 'dshDataLoading', 'aria-busy': 'true' }, [
              h('span', { key: 'sr', className: 'dshDataSrOnly' }, t('redis.browser.loading')),
              h('div', { key: '0', className: 'dshDataSkeleton' }),
              h('div', { key: '1', className: 'dshDataSkeleton' }),
            ])
          : scan.loaded && scan.keys.length === 0
            ? h('div', { key: 'empty', className: 'dshDataEmpty' }, [
                h('p', { key: 'title', className: 'dshDataEmptyTitle' }, t('redis.browser.empty.title')),
                h('p', { key: 'hint', className: 'dshDataEmptyHint' }, t('redis.browser.empty.hint')),
                snapshot.viewMode === 'beginner'
                  ? h('div', { key: 'command', className: 'dshDataCommandRow' }, [
                      h('code', { key: 'text', className: 'dshDataCommand' }, START_COMMANDS.redis),
                      h(CopyButton, { key: 'copy', client, snapshot, t, text: START_COMMANDS.redis, copyKey: 'redis-empty-start' }),
                    ])
                  : null,
              ])
            : h('ul', { key: 'keys', className: 'dshDataKeyList' }, scan.keys.map((key) => h('li', { key }, h('button', {
              type: 'button',
              className: selected.key === key ? 'dshDataKeyButton dshDataKeyButtonActive' : 'dshDataKeyButton',
              'aria-pressed': selected.key === key,
              title: key,
                onClick: () => { void client.selectRedisKey(key) },
              }, h('span', { className: 'dshDataKeyName' }, key))))),
        scan.done
          ? (scan.loaded ? h('p', { key: 'done', className: 'dshDataHint' }, t('redis.browser.done')) : null)
          : h('button', {
              key: 'more',
              type: 'button',
              className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
              disabled: scan.loading,
              onClick: () => { void client.scanMore() },
            }, scan.loading ? t('redis.browser.loading') : t('redis.browser.loadMore')),
      ])
      const detailChildren = []
      if (selected.key === '') {
        detailChildren.push(h('div', { key: 'hint', className: 'dshDataEmpty' }, [
          h('p', { key: 'title', className: 'dshDataEmptyTitle' }, t('redis.browser.selectHint')),
        ]))
      } else {
        detailChildren.push(h('div', { key: 'header', className: 'dshDataKeyHeader' }, [
          h('h3', { key: 'name', className: 'dshDataKeyHeaderName' }, selected.key),
          h('div', { key: 'meta', className: 'dshDataKeyHeaderMeta' }, [
            selected.detail === null ? null : h('span', { key: 'type', className: 'dshDataBadge' },
              `${t('redis.key.type')}: ${snapshot.viewMode === 'beginner' ? plainRedisType(selected.detail.type, t) : selected.detail.type}`),
            selected.detail === null ? null : h('span', { key: 'ttl', className: 'dshDataMuted' },
              `${t('plain.ttl')}: ${snapshot.viewMode === 'beginner' ? plainTtl(selected.detail.ttl, t) : formatTtl(selected.detail.ttl, t)}`),
            h('button', {
              key: 'delete',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact dshDataButtonDanger',
              disabled: redis.deleting,
              onClick: () => client.requestRedisDelete(selected.key),
            }, t('redis.key.delete')),
          ]),
        ]))
        if (selected.error !== null) {
          detailChildren.push(h(ErrorNotice, { mode: snapshot.viewMode,
            key: 'error',
            error: selected.error,
            t,
            onRetry: () => { void client.selectRedisKey(selected.key) },
          }))
        }
        if (redis.deleteError !== null) {
          detailChildren.push(h(ErrorNotice, { mode: snapshot.viewMode, key: 'delete-error', error: redis.deleteError, t }))
        }
        if (selected.status === 'loading') {
          detailChildren.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('redis.key.loading')))
        } else if (selected.status === 'ready' && selected.detail !== null) {
          detailChildren.push(h(RedisValueView, { key: 'value', detail: selected.detail, t }))
          detailChildren.push(h(RedisKeyActions, { key: 'actions', client, snapshot, t }))
          detailChildren.push(h(RedisTypeEditor, { key: 'editor', client, snapshot, t }))
        }
      }
      const detail = h('section', { key: 'detail', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('redis.key.title')),
        ]),
        h('div', { key: 'body', className: 'dshDataRedisDetail' }, detailChildren),
      ])
      children.push(h('div', { key: 'cols', className: 'dshDataSplit' }, [browser, detail]))
      children.push(h(RedisWriteWizard, { key: 'wizard', client, snapshot, t }))
      const setForm = h(RedisSetForm, { key: 'set', client, snapshot, t })
      children.push(snapshot.viewMode === 'beginner'
        ? h(DetailsBlock, { key: 'set-advanced', t, summary: t('plain.advanced') }, setForm)
        : setForm)
      return h('div', { className: 'dshDataTabBody' }, children)
    }

    /**
     * @param {object} props - form props.
     * @returns {object} the set-string card.
     */
    function RedisSetForm({ client, snapshot, t }) {
      const redis = snapshot.redis
      const form = redis.setForm
      const notice = redis.setNotice
      return h('section', { className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('redis.set.title')),
          h('p', { key: 'hint', className: 'dshDataCardHint' }, t('redis.set.ttlPlaceholder')),
        ]),
        h('form', {
          key: 'form',
          className: 'dshDataSetForm',
          onSubmit: (event) => {
            event.preventDefault()
            void client.submitRedisSet()
          },
        }, [
          h('div', { key: 'grid', className: 'dshDataSetGrid' }, [
            h(FormField, {
              key: 'key',
              id: `${NS}-redis-set-key`,
              label: t('redis.set.key'),
            }, h('input', {
              id: `${NS}-redis-set-key`,
              className: 'dshDataInput dshDataInputMono',
              type: 'text',
              value: form.key,
              placeholder: t('redis.set.keyPlaceholder'),
              onChange: (event) => client.setRedisField('key', event.target.value),
            })),
            h(FormField, {
              key: 'ttl',
              id: `${NS}-redis-set-ttl`,
              label: t('redis.set.ttl'),
            }, h('input', {
              id: `${NS}-redis-set-ttl`,
              className: 'dshDataInput',
              type: 'number',
              min: '0',
              value: form.ttl,
              placeholder: t('redis.set.ttlPlaceholder'),
              onChange: (event) => client.setRedisField('ttl', event.target.value),
            })),
          ]),
          h(FormField, {
            key: 'value',
            id: `${NS}-redis-set-value`,
            label: t('redis.set.value'),
          }, h('textarea', {
            id: `${NS}-redis-set-value`,
            className: 'dshDataTextarea dshDataTextareaMono',
            rows: 3,
            value: form.value,
            onChange: (event) => client.setRedisField('value', event.target.value),
          })),
          h('div', { key: 'actions', className: 'dshDataTestRow' }, [
            h('button', {
              key: 'submit',
              type: 'submit',
              className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
              disabled: redis.setting || form.key.trim() === '',
            }, redis.setting ? t('redis.set.saving') : t('redis.set.submit')),
            notice === null ? null : h('p', { key: 'notice', className: 'dshDataSetNotice', role: 'status' },
              notice.ttl === null || notice.ttl === undefined
                ? t('redis.set.success', { key: notice.key })
                : t('redis.set.successTtl', { key: notice.key, seconds: notice.ttl })),
          ]),
          redis.setError === null ? null : h(ErrorNotice, { mode: snapshot.viewMode, key: 'error', error: redis.setError, t }),
        ]),
      ])
    }

    /**
     * A result grid for one PostgreSQL result set.
     *
     * @param {object} props - grid props.
     * @returns {object|null} the grid element.
     */
    function PgResultGrid({ result, t }) {
      if (!isRecord(result)) return null
      const columns = Array.isArray(result.columns) ? result.columns : []
      const rows = Array.isArray(result.rows) ? result.rows : []
      if (columns.length === 0) {
        return h('p', { className: 'dshDataHint' }, t('pg.query.affected', { count: integerOf(result.rowCount, rows.length) }))
      }
      return h('div', { className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
        h('thead', { key: 'head' }, h('tr', {}, columns.map((column, index) => h('th', {
          key: index,
          className: 'dshDataTh',
          scope: 'col',
        }, [
          h('span', { key: 'name', className: 'dshDataThName' }, isRecord(column) ? String(column.name) : ''),
          h('span', { key: 'type', className: 'dshDataThType' }, isRecord(column) ? String(column.dataType) : ''),
        ])))),
        h('tbody', { key: 'body' }, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
          columns.map((column, columnIndex) => {
            const cell = Array.isArray(row) ? row[columnIndex] : undefined
            if (cell === null || cell === undefined) {
              return h('td', { key: columnIndex, className: 'dshDataTd' },
                h('span', { className: 'dshDataNull' }, t('pg.null')))
            }
            return h('td', {
              key: columnIndex,
              className: 'dshDataTd dshDataTdMono',
              title: String(cell),
            }, String(cell))
          })))),
      ]))
    }

    /**
     * Render every result set of a pg.query answer plus the duration note.
     *
     * @param {object} props - result props.
     * @returns {object|null} the result list.
     */
    function PgResultList({ result, t }) {
      if (!isRecord(result)) return null
      const sets = Array.isArray(result.results) ? result.results : []
      const durationMs = integerOf(result.durationMs, 0)
      let totalRows = 0
      for (const set of sets) totalRows += isRecord(set) && Array.isArray(set.rows) ? set.rows.length : 0
      return h('div', { className: 'dshDataResult' }, [
        h('div', { key: 'meta', className: 'dshDataResultMeta' }, [
          h('span', { key: 'duration', className: 'dshDataMuted' }, t('pg.query.duration', { ms: durationMs })),
          result.truncated === true
            ? h('span', { key: 'truncated', className: 'dshDataBadge dshDataBadgeWarn' }, t('pg.query.truncated', { rows: totalRows }))
            : null,
        ]),
        sets.length === 0
          ? h('p', { key: 'empty', className: 'dshDataHint' }, t('pg.query.empty'))
          : sets.map((set, index) => h('div', { key: index, className: 'dshDataResultSet' }, [
              h('div', { key: 'head', className: 'dshDataResultHead' }, [
                isRecord(set) && typeof set.command === 'string' && set.command !== ''
                  ? h('span', { key: 'command', className: 'dshDataBadge' }, set.command)
                  : null,
                h('span', { key: 'rows', className: 'dshDataMuted' }, t('pg.query.rows', {
                  count: isRecord(set) && Array.isArray(set.rows) ? set.rows.length : 0,
                })),
              ]),
              h(PgResultGrid, { key: 'grid', result: set, t }),
            ])),
      ])
    }

    /**
     * The PostgreSQL error notice, including the SQLSTATE block.
     *
     * @param {object} props - notice props.
     * @returns {object} the notice.
     */
    function SqlErrorNotice({ error, t, onRetry }) {
      const details = isRecord(error.details) ? error.details : {}
      const lines = [
        h('p', { key: 'message', className: 'dshDataNoticeText' },
          `${t('pg.query.failed')} — ${typeof error.message === 'string' ? error.message : ''}`),
      ]
      if (typeof details.sqlState === 'string' && details.sqlState !== '') {
        lines.push(h('p', { key: 'state', className: 'dshDataSqlState' }, t('pg.query.sqlState', { state: details.sqlState })))
      }
      if (typeof details.detail === 'string' && details.detail !== '') {
        lines.push(h('p', { key: 'detail', className: 'dshDataNoticeDetail' }, t('pg.query.detail', { detail: details.detail })))
      }
      if (typeof details.hint === 'string' && details.hint !== '') {
        lines.push(h('p', { key: 'hint', className: 'dshDataNoticeDetail' }, t('pg.query.hintField', { hint: details.hint })))
      }
      if (details.position !== undefined && details.position !== null) {
        lines.push(h('p', { key: 'position', className: 'dshDataNoticeDetail' }, t('pg.query.position', { position: String(details.position) })))
      }
      return h('div', { className: 'dshDataNotice dshDataNoticeError dshDataSqlError', role: 'alert' }, [
        h('span', { key: 'icon', className: 'dshDataNoticeIcon', 'aria-hidden': true }, alertGlyph()),
        h('div', { key: 'body', className: 'dshDataNoticeBody' }, lines),
        onRetry === undefined || onRetry === null
          ? null
          : h('button', {
              key: 'retry',
              type: 'button',
              className: 'dshDataButton dshDataButtonCompact',
              onClick: onRetry,
            }, t('retry')),
      ])
    }

    /**
     * The membership-preserving table list.
     *
     * @param {object} props - list props.
     * @returns {object} the list element.
     */
    function PgColumnsTable({ columns, t }) {
      const list = Array.isArray(columns) ? columns : []
      return h('div', { className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
        h('thead', { key: 'head' }, h('tr', {}, [
          h('th', { key: 'name', className: 'dshDataTh', scope: 'col' }, t('pg.columns.name')),
          h('th', { key: 'type', className: 'dshDataTh', scope: 'col' }, t('pg.columns.type')),
          h('th', { key: 'nullable', className: 'dshDataTh', scope: 'col' }, t('pg.columns.nullable')),
          h('th', { key: 'default', className: 'dshDataTh', scope: 'col' }, t('pg.columns.default')),
        ])),
        h('tbody', { key: 'body' }, list.map((column, index) => {
          const item = isRecord(column) ? column : {}
          return h('tr', { key: index }, [
            h('td', { key: 'name', className: 'dshDataTd dshDataTdMono' }, String(item.name)),
            h('td', { key: 'type', className: 'dshDataTd dshDataTdMono' }, String(item.dataType)),
            h('td', { key: 'nullable', className: 'dshDataTd' }, item.nullable === true ? t('pg.yes') : t('pg.no')),
            h('td', { key: 'default', className: 'dshDataTd dshDataTdMono' },
              item.defaultValue === null || item.defaultValue === undefined
                ? h('span', { className: 'dshDataNull' }, '—')
                : String(item.defaultValue)),
          ])
        })),
      ]))
    }

    /**
     * The session activity panel.
     *
     * @param {object} props - panel props.
     * @returns {object} the activity card.
     */
    function PgActivity({ client, snapshot, t }) {
      const activity = snapshot.postgres.activity
      const columns = [
        ['pid', t('pg.activity.pid')],
        ['user', t('pg.activity.user')],
        ['database', t('pg.activity.database')],
        ['state', t('pg.activity.state')],
        ['client', t('pg.activity.client')],
        ['applicationName', t('pg.activity.application')],
        ['query', t('pg.activity.query')],
        ['querySeconds', t('pg.activity.duration')],
        ['waitEvent', t('pg.activity.wait')],
      ]
      const children = [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('pg.activity.title')),
          h('span', { key: 'meta', className: 'dshDataCardMeta' }, t('pg.activity.count', { count: activity.list.length })),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            disabled: activity.refreshing,
            onClick: () => { void client.loadActivity() },
          }, [refreshGlyph(), t('refresh')]),
        ]),
      ]
      if (activity.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: activity.error,
          t,
          onRetry: () => { void client.loadActivity() },
        }))
      }
      if (activity.status === 'loading' && activity.list.length === 0) {
        children.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('pg.activity.loading')))
      } else if (activity.list.length === 0) {
        children.push(h('p', { key: 'empty', className: 'dshDataHint' }, t('pg.activity.empty')))
      } else {
        children.push(h('div', { key: 'table', className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
          h('thead', { key: 'head' }, h('tr', {}, columns.map(([, label], index) => h('th', {
            key: index,
            className: 'dshDataTh',
            scope: 'col',
          }, label)))),
          h('tbody', { key: 'body' }, activity.list.map((session, rowIndex) => h('tr', { key: `${textOf(session.pid, '')}-${rowIndex}` },
            columns.map(([field, label], index) => {
              let value = session[field]
              if (field === 'querySeconds') {
                value = typeof value === 'number' ? t('pg.query.duration', { ms: Math.round(value * 1000) }) : '—'
              } else if (field === 'query') {
                value = value === null || value === undefined || value === '' ? '—' : truncateLabel(String(value), 80)
              } else {
                value = value === null || value === undefined || value === '' ? '—' : String(value)
              }
              return h('td', {
                key: index,
                className: field === 'query' ? 'dshDataTd dshDataActivityQuery' : 'dshDataTd',
                title: field === 'query' && session.query ? String(session.query) : undefined,
              }, value)
            })))),
        ])))
      }
      return h('section', { className: 'dshDataCard' }, children)
    }

    /**
     * @param {object} props - table props.
     * @returns {object} the index table.
     */
    function PgIndexesTable({ indexes, t }) {
      const list = Array.isArray(indexes) ? indexes.filter(isRecord) : []
      if (list.length === 0) return h('p', { className: 'dshDataHint' }, t('pg.detail.emptyIndexes'))
      const columnsText = (index) => (Array.isArray(index.columns)
        ? index.columns.map((column) => (isRecord(column) ? textOf(column.name, '') : String(column))).join(', ')
        : textOf(index.columns, textOf(index.definition, '')))
      return h('div', { className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
        h('thead', { key: 'head' }, h('tr', {}, [
          h('th', { key: 'name', className: 'dshDataTh', scope: 'col' }, t('pg.detail.index.name')),
          h('th', { key: 'columns', className: 'dshDataTh', scope: 'col' }, t('pg.detail.index.columns')),
          h('th', { key: 'unique', className: 'dshDataTh', scope: 'col' }, t('pg.detail.index.unique')),
          h('th', { key: 'primary', className: 'dshDataTh', scope: 'col' }, t('pg.detail.index.primary')),
        ])),
        h('tbody', { key: 'body' }, list.map((index, rowIndex) => h('tr', { key: rowIndex }, [
          h('td', { key: 'name', className: 'dshDataTd dshDataTdMono' }, textOf(index.name, '—')),
          h('td', { key: 'columns', className: 'dshDataTd dshDataTdMono', title: columnsText(index) }, columnsText(index)),
          h('td', { key: 'unique', className: 'dshDataTd' }, index.unique === true ? t('pg.yes') : t('pg.no')),
          h('td', { key: 'primary', className: 'dshDataTd' }, index.primary === true ? t('pg.yes') : t('pg.no')),
        ]))),
      ]))
    }

    /**
     * @param {object} props - table props.
     * @returns {object} the constraint table.
     */
    function PgConstraintsTable({ constraints, t }) {
      const list = Array.isArray(constraints) ? constraints.filter(isRecord) : []
      if (list.length === 0) return h('p', { className: 'dshDataHint' }, t('pg.detail.emptyConstraints'))
      const definitionOf = (constraint) => {
        if (typeof constraint.definition === 'string' && constraint.definition !== '') return constraint.definition
        if (Array.isArray(constraint.columns)) {
          return constraint.columns.map((column) => (isRecord(column) ? textOf(column.name, '') : String(column))).join(', ')
        }
        return '—'
      }
      return h('div', { className: 'dshDataGridWrap' }, h('table', { className: 'dshDataGrid' }, [
        h('thead', { key: 'head' }, h('tr', {}, [
          h('th', { key: 'name', className: 'dshDataTh', scope: 'col' }, t('pg.detail.constraint.name')),
          h('th', { key: 'type', className: 'dshDataTh', scope: 'col' }, t('pg.detail.constraint.type')),
          h('th', { key: 'definition', className: 'dshDataTh', scope: 'col' }, t('pg.detail.constraint.definition')),
        ])),
        h('tbody', { key: 'body' }, list.map((constraint, rowIndex) => {
          const definition = definitionOf(constraint)
          return h('tr', { key: rowIndex }, [
            h('td', { key: 'name', className: 'dshDataTd dshDataTdMono' }, textOf(constraint.name, '—')),
            h('td', { key: 'type', className: 'dshDataTd' }, textOf(constraint.type, textOf(constraint.constraintType, '—'))),
            h('td', { key: 'definition', className: 'dshDataTd dshDataTdMono', title: definition }, truncateLabel(definition, 80)),
          ])
        })),
      ]))
    }

    /**
     * The paginated data browser for the selected table.
     *
     * @param {object} props - browser props.
     * @returns {object} the browse card.
     */
    function PgBrowse({ client, snapshot, t }) {
      const pg = snapshot.postgres
      const browse = pg.browse
      const selected = pg.selected
      const totalPages = browse.totalRows === null ? null : Math.max(1, Math.ceil(browse.totalRows / browse.pageSize))
      const hasNext = totalPages === null ? browse.rows.length === browse.pageSize : browse.page + 1 < totalPages
      const canExport = browse.columns.length > 0 && browse.rows.length > 0
      const children = [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('pg.browse.title')),
          h('p', { key: 'hint', className: 'dshDataCardHint' },
            browse.limitedBy === 'limit' ? t('pg.browse.limited', { count: browse.rows.length }) : ''),
          h('div', { key: 'actions', className: 'dshDataCardActions' }, [
            h('label', { key: 'size', className: 'dshDataInlineField' }, [
              h('span', { key: 'label' }, t('pg.browse.pageSize')),
              h('select', {
                key: 'select',
                className: 'dshDataSelect',
                value: String(browse.pageSize),
                'aria-label': t('pg.browse.pageSize'),
                onChange: (event) => { void client.setBrowsePageSize(event.target.value) },
              }, PG_PAGE_SIZES.map((size) => h('option', { key: size, value: String(size) }, String(size)))),
            ]),
            h('button', {
              key: 'csv',
              type: 'button',
              className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
              disabled: !canExport,
              onClick: () => { client.downloadResult({ columns: browse.columns, rows: browse.rows }) },
            }, t('pg.browse.csv')),
          ]),
        ]),
      ]
      if (selected.name === '') {
        children.push(h('p', { key: 'empty', className: 'dshDataHint' },
          snapshot.viewMode === 'beginner' ? t('pg.browse.beginnerHint') : t('pg.columns.empty')))
      } else if (browse.error !== null) {
        children.push(h(SqlErrorNotice, {
          key: 'error',
          error: browse.error,
          t,
          onRetry: () => { void client.loadBrowse() },
        }))
      } else if (browse.status === 'loading' && browse.rows.length === 0) {
        children.push(h('p', { key: 'loading', className: 'dshDataHint' }, t('pg.browse.loading')))
      } else if (browse.rows.length === 0) {
        children.push(h('p', { key: 'empty', className: 'dshDataHint' }, t('pg.browse.empty')))
      } else {
        children.push(h('div', { key: 'bar', className: 'dshDataBrowseBar' }, [
          h('button', {
            key: 'prev',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            disabled: browse.page <= 0 || browse.status === 'loading',
            onClick: () => { void client.browsePage(-1) },
          }, t('pg.browse.prev')),
          h('button', {
            key: 'next',
            type: 'button',
            className: 'dshDataButton dshDataButtonCompact',
            disabled: !hasNext || browse.status === 'loading',
            onClick: () => { void client.browsePage(1) },
          }, t('pg.browse.next')),
          h('span', { key: 'page', className: 'dshDataMuted' }, t('pg.browse.page', { page: browse.page + 1 })),
          h('span', { key: 'total', className: 'dshDataBrowseMeta' }, browse.totalRows === null
            ? t('pg.query.rows', { count: browse.rows.length })
            : t('pg.browse.total', { count: browse.totalRows })),
        ]))
        children.push(h(PgResultGrid, { key: 'grid', result: { columns: browse.columns, rows: browse.rows }, t }))
      }
      return h('section', { className: 'dshDataCard' }, children)
    }

    /**
     * The last ten executed statements, restorable to the editor.
     *
     * @param {object} props - history props.
     * @returns {object} the history card.
     */
    function PgHistory({ client, snapshot, t }) {
      const history = snapshot.postgres.queryHistory
      return h('section', { className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('pg.history.title')),
          h('span', { key: 'count', className: 'dshDataCardMeta' }, String(history.length)),
        ]),
        history.length === 0
          ? h('p', { key: 'empty', className: 'dshDataHint' }, t('pg.history.empty'))
          : h('ul', { key: 'list', className: 'dshDataHistoryList' }, history.map((entry, index) => h('li', {
              key: `${entry.at}-${index}`,
            }, h('button', {
              type: 'button',
              className: 'dshDataHistoryButton',
              title: t('pg.history.restore'),
              onClick: () => client.restoreQuery(entry.sql),
            }, [
              h('span', { key: 'sql', className: 'dshDataHistorySql' }, entry.sql),
              h('span', { key: 'meta', className: 'dshDataHistoryMeta' },
                `${t('pg.query.rows', { count: entry.rows })} · ${t('pg.query.duration', { ms: entry.durationMs })}`),
            ])))),
      ])
    }

    function PostgresTab({ client, snapshot, t }) {
      const pg = snapshot.postgres
      const version = isRecord(pg.version.value) ? pg.version.value : null
      const selected = pg.selected
      const detail = selected.detail
      const detailValue = isRecord(detail.value) ? detail.value : null
      const detailTab = detail.tab
      const filter = pg.filter.trim().toLowerCase()
      const tables = pg.tables.list.filter((table) => {
        if (!isRecord(table)) return false
        if (filter === '') return true
        const name = typeof table.name === 'string' ? table.name.toLowerCase() : ''
        const schema = typeof table.schema === 'string' ? table.schema.toLowerCase() : ''
        return name.indexOf(filter) >= 0 || schema.indexOf(filter) >= 0
      })
      const names = pg.databases
        .map((database) => (isRecord(database) && typeof database.name === 'string' ? database.name : ''))
        .filter((name) => name !== '')
      let database = pg.database
      if (database === '' && version !== null && typeof version.currentDatabase === 'string') database = version.currentDatabase
      if (database !== '' && names.indexOf(database) < 0) names.unshift(database)
      const children = [h(InstanceBar, { key: 'instances', client, snapshot, t, service: 'postgres' })]
      children.push(h('div', { key: 'toolbar', className: 'dshDataToolbar' }, [
        h('span', { key: 'status', className: 'dshDataToolbarStatus' }, version === null
          ? t('loading')
          : t('pg.status', {
              version: shortPgVersion(version.version),
              user: textOf(version.currentUser, ''),
              database: textOf(version.currentDatabase, ''),
            })),
        h('label', { key: 'database', className: 'dshDataInlineField' }, [
          h('span', { key: 'label' }, t('pg.database')),
          h('select', {
            key: 'select',
            className: 'dshDataSelect',
            value: database,
            'aria-label': t('pg.database'),
            onChange: (event) => { void client.selectDatabase(event.target.value) },
          }, names.map((name) => h('option', { key: name, value: name }, name))),
        ]),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: pg.refreshing,
          onClick: () => { void client.loadPostgres({ force: true }) },
        }, [refreshGlyph(), t('refresh')]),
      ]))
      if (pg.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: pg.error,
          t,
          onRetry: () => { void client.loadPostgres({ force: true }) },
        }))
      }
      children.push(h(PgActivity, { key: 'activity', client, snapshot, t }))
      const tableCard = h('section', { key: 'tables', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('pg.tables')),
          h('span', { key: 'count', className: 'dshDataCardMeta' }, t('pg.tables.count', { count: tables.length })),
        ]),
        h('input', {
          key: 'filter',
          className: 'dshDataInput',
          type: 'search',
          value: pg.filter,
          placeholder: t('pg.tables.filter'),
          'aria-label': t('pg.tables.filter'),
          onChange: (event) => client.setPgFilter(event.target.value),
        }),
        pg.tables.status === 'loading' && pg.tables.list.length === 0
          ? h('p', { key: 'loading', className: 'dshDataHint' }, t('pg.tables.loading'))
          : pg.tables.error !== null
            ? h(ErrorNotice, { mode: snapshot.viewMode,
                key: 'error',
                error: pg.tables.error,
                t,
                onRetry: () => { void client.loadPostgres({ force: true }) },
              })
            : tables.length === 0
              ? h('div', { key: 'empty', className: 'dshDataEmpty' }, [
                  h('p', { key: 'title', className: 'dshDataEmptyTitle' }, t(pg.tables.list.length > 0 ? 'pg.tables.emptyFilter.title' : 'pg.tables.empty.title')),
                  h('p', { key: 'hint', className: 'dshDataEmptyHint' }, t(pg.tables.list.length > 0 ? 'pg.tables.emptyFilter.hint' : 'pg.tables.empty.hint')),
                  snapshot.viewMode === 'beginner' && pg.tables.list.length === 0
                    ? h('div', { key: 'command', className: 'dshDataCommandRow' }, [
                        h('code', { key: 'text', className: 'dshDataCommand' }, START_COMMANDS.postgres),
                        h(CopyButton, { key: 'copy', client, snapshot, t, text: START_COMMANDS.postgres, copyKey: 'pg-empty-start' }),
                      ])
                    : null,
                ])
              : h('ul', { key: 'list', className: 'dshDataTableList' }, tables.map((table, index) => {
                  const item = isRecord(table) ? table : {}
                  const active = selected.schema === item.schema && selected.name === item.name
                  return h('li', { key: `${String(item.schema)}.${String(item.name)}.${index}` }, h('button', {
                    type: 'button',
                    className: active ? 'dshDataTableButton dshDataTableButtonActive' : 'dshDataTableButton',
                    'aria-pressed': active,
                    onClick: () => { void client.selectTable(String(item.schema), String(item.name)) },
                  }, [
                    h('span', { key: 'name', className: 'dshDataTableName' }, String(item.name)),
                    h('span', { key: 'meta', className: 'dshDataTableMeta' }, [
                      h('span', { key: 'kind', className: 'dshDataBadge' }, t(tableKindKey(item.kind))),
                      typeof item.size === 'string' && item.size !== ''
                        ? h('span', { key: 'size', className: 'dshDataMuted' }, item.size)
                        : null,
                      typeof item.estimatedRows === 'number'
                        ? h('span', { key: 'rows', className: 'dshDataMuted' }, t('pg.tables.rows', { count: item.estimatedRows }))
                        : null,
                    ]),
                  ]))
                })),
      ])
      const detailTabs = [
        ['columns', 'pg.detail.columns'],
        ['indexes', 'pg.detail.indexes'],
        ['constraints', 'pg.detail.constraints'],
      ]
      let detailBody
      if (selected.name === '') {
        detailBody = h('p', { key: 'empty', className: 'dshDataHint' }, t('pg.columns.empty'))
      } else if (detail.status === 'loading') {
        detailBody = h('p', { key: 'loading', className: 'dshDataHint' }, t('pg.detail.loading'))
      } else if (detail.error !== null) {
        detailBody = h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'error',
          error: detail.error,
          t,
          onRetry: () => { void client.selectTable(selected.schema, selected.name) },
        })
      } else if (detailValue !== null) {
        const meta = []
        if (detailValue.size !== '') meta.push(`${t('pg.detail.size')}: ${detailValue.size}`)
        if (detailValue.estimatedRows !== null) meta.push(`${t('pg.detail.estimated')}: ${detailValue.estimatedRows}`)
        if (detailValue.comment !== null && detailValue.comment !== '') meta.push(`${t('pg.detail.comment')}: ${detailValue.comment}`)
        detailBody = h('div', { key: 'detail', className: 'dshDataTabBody' }, [
          h('div', { key: 'tabs', className: 'dshDataSubTabs', role: 'tablist', 'aria-label': t('pg.detail.tabs') }, detailTabs.map(([value, key]) => h('button', {
            key: value,
            type: 'button',
            role: 'tab',
            'aria-selected': detailTab === value,
            className: detailTab === value ? 'dshDataSubTab dshDataSubTabActive' : 'dshDataSubTab',
            onClick: () => client.setTableDetailTab(value),
          }, t(key)))),
          meta.length === 0 ? null : h('p', { key: 'meta', className: 'dshDataMuted' }, meta.join(' · ')),
          detailTab === 'indexes'
            ? h(PgIndexesTable, { key: 'indexes', indexes: detailValue.indexes, t })
            : detailTab === 'constraints'
              ? h(PgConstraintsTable, { key: 'constraints', constraints: detailValue.constraints, t })
              : h(PgColumnsTable, { key: 'columns', columns: detailValue.columns, t }),
        ])
      }
      const detailCard = h('section', { key: 'detail-card', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' },
            selected.name === '' ? t('pg.detail.tabs') : `${String(selected.schema)}.${String(selected.name)}`),
          h('span', { key: 'meta', className: 'dshDataCardMeta' }, detailValue === null ? '' : (detailValue.size || '')),
        ]),
        detailBody,
      ])
      children.push(h('div', { key: 'cols', className: 'dshDataSplit' }, [tableCard, detailCard]))
      children.push(h(PgBrowse, { key: 'browse', client, snapshot, t }))
      const query = pg.query
      children.push(h('section', { key: 'query', className: 'dshDataCard' }, [
        h('div', { key: 'head', className: 'dshDataCardHead' }, [
          h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('pg.query.title')),
          h('p', { key: 'hint', className: 'dshDataCardHint' }, t('pg.query.hint')),
          h('div', { key: 'actions', className: 'dshDataCardActions' }, [
            h('button', {
              key: 'csv',
              type: 'button',
              className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
              disabled: query.result === null,
              onClick: () => { client.downloadResult(query.result) },
            }, t('pg.browse.csv')),
            h('button', {
              key: 'run',
              type: 'button',
              className: 'dshDataButton dshDataButtonPrimary dshDataButtonCompact',
              disabled: query.status === 'running' || pg.sql.trim() === '',
              onClick: () => { void client.runPgQuery() },
            }, query.status === 'running' ? t('pg.query.running') : t('pg.query.run')),
          ]),
        ]),
        h('div', { key: 'templates', className: 'dshDataTemplateBar' }, [
          h('span', { key: 'label', className: 'dshDataMuted' }, t('pg.template.title')),
          ...['preview', 'count', 'columns'].map((kind) => h('button', {
            key: kind,
            type: 'button',
            className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
            disabled: selected.name === '',
            title: t('pg.template.hint'),
            onClick: () => {
              const filled = client.fillSqlTemplate(kind)
              if (filled && snapshot.viewMode === 'beginner') void client.runPgQuery()
            },
          }, t(`pg.template.${kind}`))),
        ]),
        (() => {
          const editor = h('textarea', {
            key: 'sql',
            className: 'dshDataTextarea dshDataTextareaMono',
            rows: 6,
            value: pg.sql,
            placeholder: t('pg.query.placeholder'),
            'aria-label': t('pg.query.title'),
            onChange: (event) => client.setPgSql(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void client.runPgQuery()
              }
            },
          })
          return snapshot.viewMode === 'beginner'
            ? h(DetailsBlock, { key: 'sql-advanced', t, summary: t('plain.advancedSql') }, editor)
            : editor
        })(),
        query.error !== null
          ? h(SqlErrorNotice, {
              key: 'error',
              error: query.error,
              t,
              onRetry: () => { void client.runPgQuery() },
            })
          : query.result !== null
            ? h(PgResultList, { key: 'result', result: query.result, t })
            : h('p', { key: 'empty', className: 'dshDataHint' }, t('pg.query.empty')),
      ]))
      children.push(h(PgHistory, { key: 'history', client, snapshot, t }))
      return h('div', { className: 'dshDataTabBody' }, children)
    }

    /**
     * @param {object} props - test-row props.
     * @returns {object} the test button and its result line.
     */
    function TestRow({ client, snapshot, t, service }) {
      const test = snapshot.test
      const running = test.status === 'running' && test.service === service
      const show = test.service === service && (test.status === 'ok' || test.status === 'error')
      return h('div', { className: 'dshDataTestRow' }, [
        h('button', {
          key: 'button',
          type: 'button',
          className: 'dshDataButton dshDataButtonOutline dshDataButtonCompact',
          disabled: test.status === 'running',
          onClick: () => { void client.testConnection(service) },
        }, running ? t('settings.testing') : t('settings.test')),
        show && test.status === 'ok'
          ? h('p', { key: 'ok', className: 'dshDataTestOk', role: 'status' },
              t('settings.testOk', { detail: test.message }))
          : null,
        show && test.status === 'error'
          ? h('p', { key: 'fail', className: 'dshDataTestFail', role: 'status' },
              t('settings.testFailed', { message: test.error === null ? '' : test.error.message }))
          : null,
      ])
    }

    /**
     * The settings view behind the gear button.
     *
     * Redis and PostgreSQL default to Docker-container mode: the panel picks a
     * discovered container and shows the endpoint and credential source the
     * Host resolved. Manual host/port mode keeps the v0.1 fields.
     *
     * @param {object} props - view props.
     * @returns {object} the settings view.
     */
    function SettingsView({ client, snapshot, t }) {
      const form = snapshot.form
      const settings = snapshot.settings
      if (settings === null) {
        return h('div', { className: 'dshDataTabBody' }, [
          snapshot.error === null
            ? h('p', { key: 'loading', className: 'dshDataHint' }, t('loading'))
            : h(ErrorNotice, { mode: snapshot.viewMode,
                key: 'error',
                error: snapshot.error,
                t,
                onRetry: () => { void client.bootstrap() },
              }),
        ])
      }
      const modeOf = (service) => (form[service].mode === 'manual' ? 'manual' : 'docker')
      const redisMode = modeOf('redis')
      const pgMode = modeOf('postgres')
      const field = (service, name, label, control, hint) => h(FormField, {
        key: `${service}-${name}`,
        id: `${NS}-setting-${service}-${name}`,
        label,
        hint,
      }, control)
      const input = (service, name, type, value, placeholder, onChange) => h('input', {
        id: `${NS}-setting-${service}-${name}`,
        className: 'dshDataInput',
        type,
        value,
        placeholder,
        onChange: (event) => onChange(event.target.value),
      })
      const set = (service, name) => (value) => client.setSettingsField(service, name, value)
      const redisPassword = input('redis', 'password', 'password', form.redis.password,
        settings.redis.hasPassword ? t('settings.redis.passwordStored') : t('settings.redis.passwordEmpty'),
        set('redis', 'password'))
      const pgPassword = input('postgres', 'password', 'password', form.postgres.password,
        settings.postgres.hasPassword ? t('settings.postgres.passwordStored') : t('settings.postgres.passwordEmpty'),
        set('postgres', 'password'))
      const dockerSection = h('section', { key: 'docker', className: 'dshDataCard dshDataSettingsSection' }, [
        h('div', { key: 'head', className: 'dshDataSettingsSectionHead' }, [
          h('h2', { key: 'title', className: 'dshDataSettingsSectionTitle' }, t('settings.docker.title')),
        ]),
        h('div', { key: 'grid', className: 'dshDataFieldGrid' }, [
          field('docker', 'binary', t('settings.docker.binary'), input('docker', 'binary', 'text',
            form.docker.binary, '', set('docker', 'binary'))),
        ]),
        h('p', { key: 'hint', className: 'dshDataHint' }, t('settings.docker.binaryHint')),
        h(TestRow, { key: 'test', client, snapshot, t, service: 'docker' }),
      ])
      const dockerfilesSection = h('section', { key: 'dockerfiles', className: 'dshDataCard dshDataSettingsSection' }, [
        h('div', { key: 'head', className: 'dshDataSettingsSectionHead' }, [
          h('h2', { key: 'title', className: 'dshDataSettingsSectionTitle' }, t('settings.dockerfiles.title')),
        ]),
        h('div', { key: 'grid', className: 'dshDataFieldGrid' }, [
          field('dockerfiles', 'rootsText', t('settings.dockerfiles.roots'), h('textarea', {
            id: `${NS}-setting-dockerfiles-rootsText`,
            className: 'dshDataTextarea dshDataTextareaMono',
            rows: 4,
            value: form.dockerfiles.rootsText,
            placeholder: '/Users/me/projects',
            onChange: (event) => client.setSettingsField('dockerfiles', 'rootsText', event.target.value),
          }), t('settings.dockerfiles.rootsHint')),
          field('dockerfiles', 'maxDepth', t('settings.dockerfiles.maxDepth'), input('dockerfiles', 'maxDepth', 'number',
            form.dockerfiles.maxDepth, '', set('dockerfiles', 'maxDepth')), t('settings.dockerfiles.maxDepthHint')),
        ]),
      ])
      const redisSection = h('section', { key: 'redis', className: 'dshDataCard dshDataSettingsSection' }, [
        h('div', { key: 'head', className: 'dshDataSettingsSectionHead' }, [
          h('h2', { key: 'title', className: 'dshDataSettingsSectionTitle' }, t('settings.redis.title')),
          h(ModeSwitch, {
            key: 'mode',
            service: 'redis',
            value: redisMode,
            t,
            onChange: (mode) => client.setSettingsField('redis', 'mode', mode),
          }),
        ]),
        ...(redisMode === 'docker'
          ? [
              h('div', { key: 'docker-fields', className: 'dshDataFieldGrid' }, [
                field('redis', 'container', t('settings.target.label'), h('select', {
                  id: `${NS}-setting-redis-container`,
                  className: 'dshDataSelect dshDataTargetSelect',
                  value: form.redis.container,
                  onChange: (event) => client.setSettingsField('redis', 'container', event.target.value),
                }, targetOptions(snapshot.targets.redis, form.redis.container, t)), t('settings.target.containerHint')),
              ]),
              h(TargetSummary, { key: 'target', service: 'redis', target: snapshot.targets.redis, t }),
              h('p', { key: 'override-hint', className: 'dshDataHint' }, t('settings.target.overrideHint')),
            ]
          : [
              h('div', { key: 'manual-fields', className: 'dshDataFieldGrid' }, [
                field('redis', 'host', t('settings.redis.host'), input('redis', 'host', 'text',
                  form.redis.host, '', set('redis', 'host'))),
                field('redis', 'port', t('settings.redis.port'), input('redis', 'port', 'number',
                  form.redis.port, '', set('redis', 'port'))),
              ]),
            ]),
        h('div', { key: 'grid', className: 'dshDataFieldGrid' }, [
          field('redis', 'username', t('settings.redis.username'), input('redis', 'username', 'text',
            form.redis.username, '', set('redis', 'username'))),
          field('redis', 'password', t('settings.redis.password'), redisPassword,
            redisMode === 'docker' ? t('settings.redis.passwordDockerHint') : undefined),
          field('redis', 'db', t('settings.redis.db'), input('redis', 'db', 'number',
            form.redis.db, '', set('redis', 'db'))),
        ]),
        h('div', { key: 'checks', className: 'dshDataFieldGrid' }, [
          h('label', { key: 'tls', className: 'dshDataCheck' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: form.redis.tls,
              onChange: (event) => client.setSettingsField('redis', 'tls', event.target.checked),
            }),
            h('span', { key: 'label' }, t('settings.redis.tls')),
          ]),
          settings.redis.hasPassword
            ? h('label', { key: 'clear', className: 'dshDataCheck' }, [
                h('input', {
                  key: 'input',
                  type: 'checkbox',
                  checked: form.redis.clearPassword,
                  onChange: (event) => client.setSettingsField('redis', 'clearPassword', event.target.checked),
                }),
                h('span', { key: 'label' }, t('settings.clearPassword')),
              ])
            : null,
        ]),
        h(TestRow, { key: 'test', client, snapshot, t, service: 'redis' }),
      ])
      const pgSection = h('section', { key: 'postgres', className: 'dshDataCard dshDataSettingsSection' }, [
        h('div', { key: 'head', className: 'dshDataSettingsSectionHead' }, [
          h('h2', { key: 'title', className: 'dshDataSettingsSectionTitle' }, t('settings.postgres.title')),
          h(ModeSwitch, {
            key: 'mode',
            service: 'postgres',
            value: pgMode,
            t,
            onChange: (mode) => client.setSettingsField('postgres', 'mode', mode),
          }),
        ]),
        ...(pgMode === 'docker'
          ? [
              h('div', { key: 'docker-fields', className: 'dshDataFieldGrid' }, [
                field('postgres', 'container', t('settings.target.label'), h('select', {
                  id: `${NS}-setting-postgres-container`,
                  className: 'dshDataSelect dshDataTargetSelect',
                  value: form.postgres.container,
                  onChange: (event) => client.setSettingsField('postgres', 'container', event.target.value),
                }, targetOptions(snapshot.targets.postgres, form.postgres.container, t)), t('settings.target.containerHint')),
              ]),
              h(TargetSummary, { key: 'target', service: 'postgres', target: snapshot.targets.postgres, t }),
              h('p', { key: 'override-hint', className: 'dshDataHint' }, t('settings.target.overrideHint')),
            ]
          : [
              h('div', { key: 'manual-fields', className: 'dshDataFieldGrid' }, [
                field('postgres', 'host', t('settings.postgres.host'), input('postgres', 'host', 'text',
                  form.postgres.host, '', set('postgres', 'host'))),
                field('postgres', 'port', t('settings.postgres.port'), input('postgres', 'port', 'number',
                  form.postgres.port, '', set('postgres', 'port'))),
              ]),
            ]),
        h('div', { key: 'grid', className: 'dshDataFieldGrid' }, [
          field('postgres', 'user', t('settings.postgres.user'), input('postgres', 'user', 'text',
            form.postgres.user, 'postgres', set('postgres', 'user'))),
          field('postgres', 'password', t('settings.postgres.password'), pgPassword,
            pgMode === 'docker' ? t('settings.postgres.passwordDockerHint') : undefined),
          field('postgres', 'database', t('settings.postgres.database'), input('postgres', 'database', 'text',
            form.postgres.database, 'postgres', set('postgres', 'database'))),
          h(FormField, {
            key: 'postgres-ssl',
            id: `${NS}-setting-postgres-ssl`,
            label: t('settings.postgres.ssl'),
          }, h('select', {
            id: `${NS}-setting-postgres-ssl`,
            className: 'dshDataSelect',
            value: form.postgres.ssl,
            onChange: (event) => client.setSettingsField('postgres', 'ssl', event.target.value),
          }, ['disable', 'prefer', 'require'].map((mode) => h('option', {
            key: mode,
            value: mode,
          }, t(`settings.postgres.ssl.${mode}`))))),
        ]),
        h('div', { key: 'checks', className: 'dshDataFieldGrid' }, [
          settings.postgres.hasPassword
            ? h('label', { key: 'clear', className: 'dshDataCheck' }, [
                h('input', {
                  key: 'input',
                  type: 'checkbox',
                  checked: form.postgres.clearPassword,
                  onChange: (event) => client.setSettingsField('postgres', 'clearPassword', event.target.checked),
                }),
                h('span', { key: 'label' }, t('settings.clearPassword')),
              ])
            : null,
        ]),
        h(TestRow, { key: 'test', client, snapshot, t, service: 'postgres' }),
      ])
      return h('div', { className: 'dshDataTabBody dshDataSettings' }, [
        h('div', { key: 'head', className: 'dshDataSettingsHead' }, [
          h('div', { key: 'text', className: 'dshDataSettingsHeadText' }, [
            h('h2', { key: 'title', className: 'dshDataCardTitle' }, t('settings.title')),
            h('p', { key: 'subtitle', className: 'dshDataCardHint' }, t('settings.subtitle')),
          ]),
          h('div', { key: 'actions', className: 'dshDataSettingsActions' }, [
            snapshot.saveNotice
              ? h('p', { key: 'saved', className: 'dshDataTestOk', role: 'status' }, t('settings.saved'))
              : null,
            h('button', {
              key: 'save',
              type: 'button',
              className: 'dshDataButton dshDataButtonPrimary',
              disabled: snapshot.saving,
              onClick: () => { void client.saveSettings() },
            }, snapshot.saving ? t('settings.saving') : t('settings.save')),
          ]),
        ]),
        h('p', { key: 'hint', className: 'dshDataHint' }, t('settings.saveHint')),
        snapshot.saveError === null
          ? null
          : h(ErrorNotice, { mode: snapshot.viewMode, key: 'error', error: snapshot.saveError, t }),
        dockerSection,
        dockerfilesSection,
        redisSection,
        pgSection,
      ])
    }

    /**
     * The panel page. Rendered by the `main` slot while this panel is active.
     *
     * @param {object} props - slot props: the injected client plus the bound translator.
     * @returns {object} the page element.
     */
    function DataPanel({ client, t }) {
      const snapshot = useSnapshot(client)
      const tab = snapshot.tab
      /** The pending destructive action, or null. Nothing is deleted while it is set. */
      const confirm = snapshot.confirm
      const tabRefs = React.useRef({})

      React.useEffect(() => {
        void client.bootstrap()
      }, [client])

      React.useEffect(() => {
        void client.ensureTabLoaded(tab)
      }, [client, tab])

      // Docker is the only polling tab: container state is what the page is
      // for, and the interval is torn down when the tab changes or the page
      // unmounts because the effect cleanup runs.
      React.useEffect(() => {
        if (tab !== 'docker') return undefined
        return client.startDockerPolling(DOCKER_POLL_MS)
      }, [client, tab])

      const onTabsKeyDown = (event) => {
        const index = TABS.indexOf(tab)
        let next = -1
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = TABS.length - 1
        if (next < 0) return
        event.preventDefault()
        const id = TABS[next]
        void client.selectTab(id)
        const node = tabRefs.current[id]
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }
      const tabButtons = TABS.map((id) => {
        const active = tab === id
        return h('button', {
          key: id,
          ref: (node) => {
            tabRefs.current[id] = node
          },
          type: 'button',
          role: 'tab',
          id: `${NS}-tab-${id}`,
          'aria-selected': active,
          'aria-controls': `${NS}-panel-${id}`,
          tabIndex: active || (TABS.indexOf(tab) < 0 && id === TABS[0]) ? 0 : -1,
          className: active ? 'dshDataTab dshDataTabActive' : 'dshDataTab',
          onClick: () => { void client.selectTab(id) },
        }, t(`tab.${id}`))
      })
      const chips = ['docker', 'redis', 'postgres'].map((service) => h(ConnectionChip, {
        key: service,
        service,
        connection: snapshot.connections[service],
        target: service === 'docker' ? null : snapshot.targets[service],
        mode: snapshot.settings === null ? 'docker' : snapshot.settings[service].mode,
        t,
        onSelect: () => { void client.selectTab(service) },
      }))
      const heading = h('header', { key: 'heading', className: 'dshDataHeading' }, [
        h('div', { key: 'main', className: 'dshDataHeadingMain' }, [
          h('span', { key: 'mark', className: 'dshDataBrandMark', 'aria-hidden': true }, h(DataIcon, { size: 22 })),
          h('div', { key: 'text', className: 'dshDataHeadingText' }, [
            h('h1', { key: 'title' }, t('title')),
            h('p', { key: 'subtitle', className: 'dshDataSubtitle' }, t('subtitle')),
          ]),
        ]),
        h('div', { key: 'right', className: 'dshDataHeadingRight' }, [
          h('div', { key: 'chips', className: 'dshDataChips' }, chips),
          h('div', { key: 'tools', className: 'dshDataHeaderTools' }, [
            h(ModeToggle, { key: 'mode', client, t, mode: snapshot.viewMode }),
            h('button', {
              key: 'help',
              type: 'button',
              className: 'dshDataHelpButton',
              title: t('plain.help'),
              'aria-label': t('plain.help'),
              'aria-pressed': snapshot.helpOpen,
              onClick: () => client.toggleHelp(),
            }, '?'),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: snapshot.refreshing ? 'dshDataRefresh dshDataRefreshBusy' : 'dshDataRefresh',
              title: snapshot.refreshing ? t('refreshBusy') : t('refresh'),
              'aria-label': snapshot.refreshing ? t('refreshBusy') : t('refresh'),
              'aria-busy': snapshot.refreshing,
              disabled: snapshot.refreshing,
              onClick: () => { void client.refresh() },
            }, refreshGlyph()),
          ]),
        ]),
      ])
      const tabsRow = h('div', { key: 'tabs', className: 'dshDataTabsRow' }, [
        h('div', {
          key: 'tablist',
          className: 'dshDataTabs',
          role: 'tablist',
          'aria-label': t('tabs.aria'),
          onKeyDown: onTabsKeyDown,
        }, tabButtons),
        h('button', {
          key: 'gear',
          type: 'button',
          className: tab === 'settings' ? 'dshDataGear dshDataGearActive' : 'dshDataGear',
          title: tab === 'settings' ? t('settings.close') : t('settings.open'),
          'aria-label': tab === 'settings' ? t('settings.close') : t('settings.open'),
          'aria-pressed': tab === 'settings',
          onClick: () => client.toggleSettings(),
        }, gearGlyph()),
      ])
      const children = [heading, tabsRow]
      if (snapshot.viewMode === 'beginner' && tab !== 'settings') {
        children.push(h(PlainBanner, { key: 'plain-banner', tab, t }))
      }
      if (snapshot.error !== null) {
        children.push(h(ErrorNotice, { mode: snapshot.viewMode,
          key: 'boot-error',
          error: snapshot.error,
          t,
          onRetry: () => { void client.bootstrap() },
        }))
      }
      if (tab === 'overview') {
        children.push(h('section', {
          key: 'panel-overview',
          id: `${NS}-panel-overview`,
          role: 'tabpanel',
          'aria-labelledby': `${NS}-tab-overview`,
          className: 'dshDataTabPanel',
        }, h(OverviewTab, { client, snapshot, t })))
      } else if (tab === 'docker') {
        children.push(h('section', {
          key: 'panel-docker',
          id: `${NS}-panel-docker`,
          role: 'tabpanel',
          'aria-labelledby': `${NS}-tab-docker`,
          className: 'dshDataTabPanel',
        }, h(DockerTab, { client, snapshot, t })))
      } else if (tab === 'redis') {
        children.push(h('section', {
          key: 'panel-redis',
          id: `${NS}-panel-redis`,
          role: 'tabpanel',
          'aria-labelledby': `${NS}-tab-redis`,
          className: 'dshDataTabPanel',
        }, h(RedisTab, { client, snapshot, t })))
      } else if (tab === 'postgres') {
        children.push(h('section', {
          key: 'panel-postgres',
          id: `${NS}-panel-postgres`,
          role: 'tabpanel',
          'aria-labelledby': `${NS}-tab-postgres`,
          className: 'dshDataTabPanel',
        }, h(PostgresTab, { client, snapshot, t })))
      } else if (tab === 'relations') {
        children.push(h('section', {
          key: 'panel-relations',
          id: `${NS}-panel-relations`,
          role: 'tabpanel',
          'aria-labelledby': `${NS}-tab-relations`,
          className: 'dshDataTabPanel',
        }, h(RelationsTab, { client, snapshot, t })))
      } else {
        children.push(h('section', {
          key: 'panel-settings',
          id: `${NS}-panel-settings`,
          role: 'region',
          'aria-label': t('settings.title'),
          className: 'dshDataTabPanel',
        }, h(SettingsView, { client, snapshot, t })))
      }
      const page = [h('div', { key: 'scroll', className: 'dshDataScroll' }, [
        h('div', { key: 'content', className: 'dshDataContent' }, children),
      ])]
      if (confirm !== null) {
        page.push(h(ConfirmDialog, {
          key: 'confirm',
          request: confirm,
          t,
          mode: snapshot.viewMode,
          onCancel: () => client.cancelConfirm(),
          onConfirm: () => client.acceptConfirm(),
        }))
      }
      page.push(h(HelpDrawer, { key: 'help', client, snapshot, t }))
      return h('section', { className: 'dshDataPage', 'aria-label': t('title'), 'data-testid': 'data-page' }, page)
    }

    /**
     * The rail glyph: the classic database cylinder. The sidebar sizes it and
     * colors it through the row's own state, so this draws in `currentColor`.
     *
     * @param {object} props - slot props, including `size`.
     * @returns {object} the icon element.
     */
    function DataIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        className: 'dshDataIcon',
        width: edge,
        height: edge,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, [
        h('ellipse', { key: 'top', cx: 10, cy: 5, rx: 6.4, ry: 2.5 }),
        h('path', { key: 'left', d: 'M3.6 5 V15' }),
        h('path', { key: 'right', d: 'M16.4 5 V15' }),
        h('path', { key: 'bottom', d: 'M3.6 15 A6.4 2.5 0 0 0 16.4 15' }),
        h('path', { key: 'middle', d: 'M3.6 10 A6.4 2.5 0 0 0 16.4 10' }),
      ])
    }

    /** @returns {object} a refresh glyph for the header action. */
    function refreshGlyph() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, [
        h('path', { key: 'arc', d: 'M16.4 10 A6.4 6.4 0 1 1 14.5 5.6' }),
        h('path', { key: 'arrow', d: 'M14.2 2.6 V6.2 H10.6' }),
      ])
    }

    /**
     * @returns {object} a sliders glyph for the settings view: two rails with a
     * knob each, the shell's own visual language for "settings" (a gear drawn
     * with short spokes reads as a sun at 16px).
     */
    function gearGlyph() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, [
        h('path', { key: 'rail-1', d: 'M3.2 6.6 H16.8' }),
        h('circle', { key: 'knob-1', cx: 7.6, cy: 6.6, r: 2 }),
        h('path', { key: 'rail-2', d: 'M3.2 13.4 H16.8' }),
        h('circle', { key: 'knob-2', cx: 12.4, cy: 13.4, r: 2 }),
      ])
    }

    /** @returns {object} a trash glyph for a destructive action. */
    function trashGlyph() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        'aria-hidden': true, focusable: false,
      }, [
        h('path', { key: 'lid', d: 'M4 6 H16' }),
        h('path', { key: 'body', d: 'M6.5 6 V15.5 H13.5 V6' }),
        h('path', { key: 'handle', d: 'M8.2 6 V4.2 H11.8 V6' }),
      ])
    }

    /** @returns {object} an info glyph for plain-language hints. */
    function infoGlyph() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, [
        h('circle', { key: 'ring', cx: 10, cy: 10, r: 7.2 }),
        h('path', { key: 'bar', d: 'M10 9 V13.6' }),
        h('path', { key: 'dot', d: 'M10 6.4 V6.6' }),
      ])
    }

    /** @returns {object} a copy glyph for copy buttons. */
    function copyGlyph() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, [
        h('rect', { key: 'back', x: 7, y: 7, width: 9, height: 9, rx: 2 }),
        h('path', { key: 'front', d: 'M13 7 V5.5 A1.5 1.5 0 0 0 11.5 4 H5.5 A1.5 1.5 0 0 0 4 5.5 V11.5 A1.5 1.5 0 0 0 5.5 13 H7' }),
      ])
    }

    /** @returns {object} a check glyph for copied feedback. */
    function checkGlyph() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, [h('path', { key: 'check', d: 'M4 10.5 L8 14.5 L16 5.5' })])
    }

    /** @returns {object} a warning glyph for a notice. */
    function alertGlyph() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, [
        h('path', { key: 'ring', d: 'M10 2.9 L17.3 16.1 H2.7 Z' }),
        h('path', { key: 'bar', d: 'M10 7.4 V11' }),
        h('path', { key: 'dot', d: 'M10 13.4 V13.6' }),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the panel, its rail entry and the locale services.
       *
       * @param {any} ctx - the Client root context.
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
        ctx.effect(() => installStyles(), `${NS}: styles`)
        const t = ctx.locale.bind(NS)
        const client = createDataClient()

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ client }),
        }, DataPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 13,
          locale: NS,
          label: () => t('panel'),
        }, DataIcon))
      },
    }
  },
})
