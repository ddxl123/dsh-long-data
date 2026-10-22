# dsh-long-data 数据面板

[English](README.md) | 中文

[![test](https://img.shields.io/badge/tests-340-brightgreen)](https://github.com/ddxl123/dsh-long-data)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

一个 DeepSeek Harness 插件：把 **Docker**、**Redis**、**PostgreSQL** 放进同一个面板，并且
**为完全不懂这些技术的人设计** —— 打开就是白话的**概览页**：哪些东西在跑、是否正常、有什么
需要留意；所有术语都能在**帮助词典**里查到白话解释；原始技术细节收在可选的**专家模式**里。
在友好的表面之下，它依然能浏览容器 / 镜像 / 数据卷 / 网络及其日志、扫描并编辑 Redis 键、
对 PostgreSQL 执行 SQL，全程不用离开 Harness。

Redis 与 PostgreSQL 默认**运行在 Docker 容器中**：插件自动发现对应容器，使用容器发布的
主机端口以及容器环境变量里已有的凭据，本机无需安装 `redis-cli` / `psql`。同一服务有多个
运行中容器时，插件会把它们全部列出并提供切换器，绝不会静默只取“第一个”。

新增独立的**关联**页面：标明容器运行哪个镜像、挂载了哪些数据卷、接入了哪些网络，并提供
关联图与反向查询。

这个插件是**纯页面插件**：只注册侧边栏入口和面板页，不注册任何模型工具、提示词片段或
上下文注入，因此不占用模型上下文。浏览器通过已认证的 `/api` 通道访问 Host 半端。

## 功能

- **概览** —— 默认落地页，零基础可读：一句话整体健康状况；三张服务卡（Docker =「容器
  管家」、Redis =「高速缓存」、PostgreSQL =「数据库」），各自带白话说明、友好状态、关键
  数字和一个引导操作；「需要你注意」列表用白话说明问题并带跳转按钮；「快速开始」三步
  检查清单（含可复制的 docker 命令）。
- **新手 / 专家模式** —— 默认新手模式：容器显示用途（网站服务 / 数据库 / 缓存 / …），
  状态写作「运行正常 / 已停止」，删除/停止等确认框会说明会造成什么影响，原始 ID、环境变量
  等收进「技术细节（高级）」，SQL 编辑器收进「高级（SQL）」；专家模式恢复完整技术界面。
  选择会记在浏览器里。
- **帮助词典（？）** —— 基础概念（Docker / 容器 / 镜像 / 数据卷 / 网络 / 端口）、Redis
  （键 / TTL）、PostgreSQL（数据库 / 表 / 列 / SQL）的白话解释，以及「停止容器会怎样」
  「删除数据卷会怎样」「多个服务在跑选哪个」「面板连不上怎么办」等常见问题。
- **Dockerfile 识别** —— Docker 页的「构建文件」子页签会在你的项目目录里（Harness 已知的
  所有工作区 + 设置里额外添加的目录）找出 Dockerfile，并用白话解释每个文件：它从哪个基础
  镜像开始（这个镜像本身是干什么的）、开放了哪些端口、是不是多阶段构建、程序怎么启动、
  环境变量 / 数据卷 / 健康检查，查看器里逐条注明「这行在做什么」；一键复制对应的
  `docker build` 命令或文件路径。文件名不叫 Dockerfile、但内容以 `FROM` 开头的文件（如
  `Containerfile`）也能识别。页面只读，且只能打开扫描结果里的文件。
- **关联** —— 独立页面：资源概览（容器/运行中/镜像/数据卷/网络/悬空镜像/未使用卷）、
  镜像 → 容器 → 数据卷的关联图（容器下方带网络徽标）、容器关联表（镜像标签、卷标签与
  bind 路径、网络标签、端口），以及按镜像 / 数据卷 / 网络的反向查询。点容器可跳到 Docker
  对应行，点资源可跳到对应子页签并过滤。
- **Docker** —— 四个子页签 + 磁盘占用概览：
  - *容器*：状态、镜像、端口、运行情况、实时 CPU/内存列、状态过滤；启动 / 停止 / 重启 /
    暂停 / 恢复；日志抽屉（可选行数、可刷新）；详情展示环境变量（凭据类键值打码）、挂载
    与网络。
  - *镜像*：repository:tag、短 ID、大小、创建时间、详情、删除。
  - *数据卷*：名称、驱动、作用域、挂载点、详情、删除。
  - *网络*：名称、驱动、作用域、internal 标记、详情（子网、已连接容器）、删除。
  - *磁盘占用*：镜像 / 容器 / 数据卷 / 构建缓存的数量、大小与可回收空间。
  - **所有破坏性操作都要二次确认**：停止、重启、暂停、删除（以及镜像 / 数据卷 / 网络的
    删除）都会弹出焦点锁定的确认框；启动与恢复保持一键。容器列表在页签打开时每 5 秒
    自动刷新。
- **Redis** —— 连接来自 Redis 容器（自动选择或按名称固定）：使用容器发布的主机端口，
  设置里未填写的凭据取自容器环境变量 `REDISCLI_AUTH` / `REDIS_PASSWORD`。页签展示连接
  概览（版本、运行时长、客户端数、内存、键数、QPS、命中率）；基于 `SCAN` 游标的键浏览
  （支持 pattern 与类型过滤）；按类型展示值（string / list / set / zset / hash /
  stream）与 TTL、内存占用；「写入数据」向导（选类型 → 填字段 → 保存）；重命名键、设置
  过期、持久化；hash 字段 / list 推入 / set 增删编辑器；删除键需二次确认。类型用白话命名
  （文本 / 列表 / 集合 / 哈希 / 有序集合 / 流），TTL 显示为「永不过期 / 还有 N 分钟」。
  服务器区还展示键总数与客户端连接表。
- **PostgreSQL** —— 同样通过容器发现（`POSTGRES_USER`、`POSTGRES_PASSWORD`、
  `POSTGRES_DB` 取自容器环境变量）：服务端版本与当前角色；数据库列表与当前库的表 /
  视图列表（含大小/预估行数）；表的列与类型、索引/约束与表大小；以「浏览数据」为主的
  流程（数据库 → 表 → 数据，分页 + CSV 下载）；活动会话面板；SQL 编辑器（带「查看前 10 行 /
  统计行数 / 查看有哪些列」模板按钮），结果表格展示列名、数据行（`NULL` 有独立样式）、耗时
  与是否因行数上限被截断，支持 CSV 下载与查询历史；SQL 错误会显示 PostgreSQL 的
  `SQLSTATE`。

连接设置面板的齿轮页编辑，保存在 Host 半端。每个服务有一个**连接方式**：*Docker 容器*
（默认 —— 选择容器，或由插件自动选择第一个运行中的容器）或 *手动地址*（主机/端口）。

## 安装

本包是一个 bundle：`cordis.patch.yml` 会插入一条 host-plane 行。用插件管理器安装包含
此 `package.json` 的目录，或在终端执行：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-long-data
```

安装后侧边栏会出现 **数据面板** 入口（与待办清单等面板插件并列）。通过 HMR 激活时不
需要重启；如果替换已安装的同一个包，需要重启 Harness 让 Host 半端加载新的模块。

## 依赖与环境

- Harness 自带 Node 运行时；插件**只使用 Node 内置模块**，没有第三方依赖，也没有需要
  编译的原生模块。
- **Docker 页签**需要 Host 进程能执行 `docker` 命令。当 GUI 应用的 `PATH` 里没有
  `docker` 时，插件还会依次探测 `/usr/local/bin/docker`、`/opt/homebrew/bin/docker`、
  `/Applications/Docker.app/Contents/Resources/bin/docker`、`~/.docker/bin/docker`；也可以
  在设置里填绝对路径。
- **Redis / PostgreSQL 运行在 Docker 容器中**。容器需要把端口发布到主机
  （`-p 56379:6379`、`-p 55432:5432` 等），插件从 Host 进程连这个发布端口，本机无需安装
  `redis-cli`/`psql`。没有发布端口的容器会给出可操作的错误提示。
- 凭据：设置里密码/角色/数据库留空时，插件使用容器环境变量里已有的值
  （`REDISCLI_AUTH` / `REDIS_PASSWORD`、`REDIS_USERNAME`；`POSTGRES_PASSWORD`、
  `POSTGRES_USER`、`POSTGRES_DB`）。设置里填了就以设置为准；手动地址模式完全使用设置。
- **多实例**：所有运行中的 Redis/PostgreSQL 容器都会被识别。只有一个运行且未固定容器时
  自动使用；两个及以上时面板会明确提示选择，在页签的实例条（或设置里的容器下拉）固定
  要用的容器。`redis.container` / `postgres.container` 用于持久固定默认容器。
- TLS：Redis 支持纯 TLS 连接；PostgreSQL 支持 `disable`、`prefer`（先试 TLS，服务端
  拒绝则回退明文）、`require`（服务端拒绝 TLS 即失败）。

## 配置

插件行位于 profile 的 `cordis.patch.yml` 层（bundle 自带默认值）。所有字段都可省略；
面板中保存过的连接优先生效。

| 键 | 默认值 | 含义 |
|---|---|---|
| `settingsFile` | `settings.json` | 保存在插件状态目录中的连接文档名。 |
| `docker.binary` | `docker` | Docker CLI 名称或绝对路径。 |
| `docker.timeoutMs` | `20000` | 单条 docker 命令的超时，超时后终止子进程。 |
| `redis.mode` | `docker` | `docker`（发现 Redis 容器）或 `manual`。 |
| `redis.container` | 空 | 固定的容器名；留空自动选择第一个运行中的 Redis 容器。 |
| `redis.host` / `redis.port` | `127.0.0.1` / `6379` | 手动地址模式的主机/端口。 |
| `redis.username` / `redis.password` | 空 | ACL 用户名与密码（覆盖容器环境变量凭据）。 |
| `redis.db` | `0` | 连接后选择的库序号。 |
| `redis.tls` | `false` | 是否用 TLS 包裹连接。 |
| `redis.timeoutMs` | `5000` | 连接 / 命令超时。 |
| `postgres.mode` | `docker` | `docker`（发现 PostgreSQL 容器）或 `manual`。 |
| `postgres.container` | 空 | 固定的容器名；留空自动选择第一个运行中的 PostgreSQL 容器。 |
| `postgres.host` / `postgres.port` | `127.0.0.1` / `5432` | 手动地址模式的主机/端口。 |
| `postgres.user` / `postgres.password` | 空 | 登录角色；留空用容器的 `POSTGRES_USER`（再回退到 `postgres`）。 |
| `postgres.database` | 空 | 数据库；留空用容器的 `POSTGRES_DB`（再回退到 `postgres`）。 |
| `postgres.ssl` | `prefer` | `disable` \| `prefer` \| `require`。 |
| `postgres.timeoutMs` | `8000` | 连接 / 查询超时。 |
| `logTailDefault` | `200` | 每次请求默认的 Docker 日志行数。 |
| `maxQueryRows` | `500` | 单条 SQL 结果的行数上限。 |
| `maxKeyScan` | `5000` | 单次 `SCAN` hint 的上限。 |
| `dockerfiles.roots` | `[]` | 额外扫描 Dockerfile 的绝对目录（工作区目录会自动扫描）。 |
| `dockerfiles.maxDepth` | `6` | 每个扫描根目录向下查找的层数。 |

状态目录跟随 Harness home，因此每个 profile 各自保存连接：
`<harness home>/dsh-long-data/settings.json`。文件原子写入，权限 `0600`（可能含密码）。

## 安全说明

- 密码不会传到浏览器：`/api/dsh-long-data` 只返回打码后的设置视图（用 `hasPassword`
  代替密码本身），发现的容器也只暴露 `hasPassword` / `credentialsSource`。保存时密码
  留空表示保留原密码；设置表单通过 `clearPassword` 支持显式清除。
- Docker 模式的凭据只在 Host 端读取所选容器的环境变量并用于当次连接；除非你在表单里
  主动填写，否则不会写入 `settings.json`。能执行 `docker inspect` 的本机用户都可以看到
  这些环境变量。
- Docker 容器环境变量中键名像凭据的（`PASSWORD`、`SECRET`、`TOKEN`、`API_KEY`、
  `AUTH` 等）在返回面板前会被替换成 `***`。
- 连接设置不是安全边界：Harness 进程能读取该文档，并用你给的凭据访问数据库。请把面板
  当作本机运维工具使用。
- 看起来像命令行参数的容器 id 会在启动任何 `docker` 进程前被拒绝；容器生命周期动作
  仅限固定列表。
- Redis 只走显式命令（PING/INFO/SCAN/TYPE/GET/SET/DEL），面板不提供任意命令执行。
  PostgreSQL 的 SQL 编辑器按设计接受任意 SQL（包括写操作），请在愿意修改的库上使用。

## 开发

```bash
cd dsh-long-data
node --check src/index.js && node --check client/index.js
node --test test/
```

Host 半端按协议拆分，便于单独测试：

| 文件 | 作用 |
|---|---|
| `src/index.js` | Cordis 入口：配置、设置存储、路由注册。 |
| `src/config.js` | 行配置校验、默认值、状态目录。 |
| `src/settings.js` | 连接文档持久化、打码、校验。 |
| `src/docker.js` | 基于 `child_process` 的 Docker CLI 服务（argv 数组，不走 shell）。 |
| `src/redis.js` | 无依赖、基于 `node:net` 的 RESP2 客户端。 |
| `src/postgres.js` | 无依赖的 PostgreSQL 线协议客户端（SCRAM-SHA-256）。 |
| `src/targets.js` | 发现 Redis/PostgreSQL 容器，解析每个实例的发布端口与容器环境变量凭据。 |
| `src/relations.js` | 把容器与镜像、数据卷、网络关联起来，供关联页面使用。 |
| `src/roles.js` | 推断容器是用来做什么的（网站 / 数据库 / 缓存 / …），让界面能用白话解释。 |
| `src/dockerfiles.js` | 有界扫描 + 无依赖解析 Dockerfile（阶段、基础镜像、端口、启动命令、逐条指令信息）。 |
| `src/ops.js` | 每个能力的唯一实现。 |
| `src/route.js` | `/api/dsh-long-data` Fetch 路由。 |
| `client/index.js` | 浏览器面板：`window.__ModuleLoader__` 工厂，仅使用 React。 |

集成测试会使用它找到的真实服务，找不到时自动跳过：

- Docker：本机 daemon；测试只读，不会删除 / 停止 / prune 任何已有的容器、镜像、数据卷或
  网络。
- Docker 模式的 Redis/PostgreSQL 发现逻辑会跑在当前存在的 Redis/PostgreSQL 容器上；没有
  运行中的容器时跳过。
- 手动地址模式的协议往返测试默认连 `127.0.0.1:6379`（无密码）和 `127.0.0.1:5432`
  （用户/库均为 `postgres`，无密码）；可用环境变量
  `DSH_LONG_DATA_REDIS_HOST/PORT/PASSWORD` 与
  `DSH_LONG_DATA_PG_HOST/PORT/USER/PASSWORD/DATABASE` 指向别处。不可达时跳过。

## 许可证

[MIT](LICENSE)

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
