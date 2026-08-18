# Hoox

> **Hoox** —— 你说，它做。

Hoox 是统一的 Agent 产品与技术项目，计划使用 `hoox.aisay.cc` 作为公开入口。当前域名保留既有基础设施名称，不再区分产品品牌与技术底座品牌。

这是多租户 Agent Runtime 的 TypeScript Monorepo。旧 Python 原型仅作为行为参考，不是本仓库的运行时依赖，也不做数据兼容。

## 当前状态

仓库已实现并测试 Tenant、Thread、Run、Workspace、Resource、Artifact 等领域边界，以及 PostgreSQL 持久化与 RLS、HTTP API 协议、Run/Worker 状态机、CubeSandbox 适配、MinIO 对象存储和进程生命周期等能力。开发 API 与 Agent Worker 可使用本地 development 的真实 PostgreSQL、模型和 CubeSandbox；固定开发身份不属于生产认证，因此不能把开发服务当作产品服务。

M7 当前切片已提供生产 API JWT 身份、API/Scheduler/Worker 固定真实装配、严格 PostgreSQL TLS/最小权限角色探针、独立部署配置，以及三个进程的非 root runtime-only 容器 Gate。基础镜像固定到已记录 digest，锁文件闭包可离线复现 CycloneDX SBOM 和 License allow/deny 结果，并有静态发布/回滚清单。这些证据只覆盖代码、制品和外部依赖缺失时的失败关闭；真实 PostgreSQL/S3/CubeSandbox/模型/代理 readiness、外部 Web/OIDC 产品身份集成、完整越权矩阵、配额、对象生命周期、观测、容量与集群回滚演练仍未全部通过。因此仓库当前**不能宣称已可整体生产发布或浏览器生产闭环**。

当前最有价值的运行方式是执行工程 Gate、真实 CubeSandbox 冒烟和 PostgreSQL M4 黑盒测试，并通过 CubeSandbox、MinIO 自带的控制台观察外部资源。

开发 API 还提供给本地 Web 体验的最小读取契约。前端应通过本地开发服务器反向代理到 API 的同源 `/v1` 路径，不需要也不启用宽松 CORS：

- `GET /v1/threads/:threadId/runs/:runId/events?after=-1&limit=100`：按持久化 sequence 严格递增返回当前 Run 最新 Attempt 的事件；`after` 为排他游标，范围为 `-1` 到安全整数，`limit` 为 1 到 200。每项同时提供 Web 所需的 `{ eventId, sequence, occurredAt, type, payload }`，其中 `eventId` 为 `<attemptId>-<sequence>`，并保留兼容字段 `kind`。当 `kind=agent_event` 且 `payload.type` 是 Runtime 声明的类型（如 `message.delta`、`tool.started`）时，`type` 使用该值；其他情况 `type=kind`。cursor 只在响应的 `attemptId` 内有效，发生变化时客户端必须重置或分区去重。
- `GET /v1/threads/:threadId/runs/:runId/artifacts`：只列出已发布的 deliverable Artifact，不包含 diagnostic/trace。
- `GET /v1/threads/:threadId/runs/:runId/artifacts/:artifactId/preview` 与 `/download`：使用短期 S3 预签名 URL；两者均在签名前后重验租户成员关系、Run/Thread 归属、授权修订和完整固定 Blob 身份。preview 仅允许纯文本、安全图片和 PDF inline；HTML/SVG/XML 等主动内容只能使用带净化文件名的 attachment 下载。

开发 API 同时支持两类本地身份：`Authorization: Bearer dev-user-a|dev-user-b` 继续用于固定黑盒 fixture；Web 注册/登录由 `/v1/auth/register` 与 `/v1/auth/login` 签发随机不透明会话，并为每个账号原子创建独立 User、个人 Tenant 与 owner Membership。运行时始终从已认证身份重建 TenantScope，忽略客户端声明的个人 tenant。API 仍只监听回环地址，本地账号端点不会装配到 production API。

迁移完成后，用显式且可重复执行的命令初始化 `.env` 中两个开发身份，再启动开发 API：

```powershell
corepack pnpm dev:identity:provision
corepack pnpm dev:api
Invoke-RestMethod "http://$($env:API_LISTEN_HOST):$($env:API_LISTEN_PORT)/live"
Invoke-RestMethod "http://$($env:API_LISTEN_HOST):$($env:API_LISTEN_PORT)/ready"
```

`dev:identity:provision` 仅允许 `RUNTIME_ENV=development` 且 `DEV_AUTH_ENABLED=true`，通过 Runtime 数据库角色、正式 Tenant Repository、事务和 RLS 创建两个个人 Tenant 及 owner Membership；A/B 必须同时使用不同 User 和不同 Tenant，重复执行会验证并保留完全匹配的聚合，发现占用或关系冲突会失败关闭。`THREAD_CURSOR_SIGNING_KEYS` 格式为逗号分隔的 `kid:base64url-key`，每个 key 解码后必须为 32 到 64 字节。固定开发凭据只接受 `Bearer dev-user-a` 和 `Bearer dev-user-b`；它们是本机 fixture 选择器。development Web 还可使用服务端本地账号会话，但该能力不属于生产认证方案。因此 API 只允许监听字面回环地址 `127.0.0.1`、`::1` 或 `localhost`，其中 `localhost` 会直接规范化为 `127.0.0.1`，不会经过 DNS 或接受其他 hostname。`S3_PUBLIC_ENDPOINT` 同样必须为字面回环 origin，并与 API 和 Web（默认 `127.0.0.1:4173`）分离，推荐使用 `127.0.0.1:19000`。服务不会在启动时偷偷创建 Tenant 或 Membership，缺少开发身份数据时业务请求会返回 404。

## 开发 Agent Worker

完成数据库迁移和开发身份初始化后，在两个 PowerShell 分别启动真实 Worker 和 Scheduler：

```powershell
corepack pnpm dev:worker:check
corepack pnpm dev:worker
corepack pnpm dev:scheduler
```

上述开发命令都只接受 `RUNTIME_ENV=development`。`dev:worker:check` 会依次只读探测真实 PostgreSQL、MinIO、CubeSandbox 与
模型 Provider 后退出，不会启动 polling 或领取 Run；后者使用同一装配持续轮询 PostgreSQL dispatch。它不会使用内存队列、
Fake Sandbox 或 Faux Provider。`AGENT_WORKER_TENANT_ID` 在 development 仍必须等于
`DEV_AUTH_USER_A_TENANT_ID`，但它只作为启动兼容 Tenant，不再限制 Worker 的消费范围。个人或团队 Tenant
创建 dispatch 时会在同一事务唤醒动态控制面；Worker 通过 `DATABASE_WORKER_COORDINATOR_URL` 对应的独立
`DATABASE_WORKER_COORDINATOR_ROLE` 只领取 Tenant 租约，再回到普通 Runtime 连接和 Tenant RLS 内读取任务。
Coordinator 角色不得复用 `DATABASE_RUNTIME_ROLE`，也不得拥有 Run、Thread、成员或文件表权限。

Scheduler 是完整开发拓扑的必需常驻进程，负责消费普通 Sandbox cleanup outbox、Thread Sandbox
lifecycle effect 和可选标题生成任务。缺少 Scheduler 不会阻止 Worker 领取 Run，但失败或取消后留下的
Sandbox 会停留在待清理状态；本地联调不能只启动 API、Web 和 Worker。

API 的团队成员变更使用 `DATABASE_TEAM_COORDINATOR_URL` 对应的独立 `DATABASE_TEAM_COORDINATOR_ROLE`。普通
Runtime 连接仍不能更新 Membership 的 `role` 或 `status`；Team Coordinator 连接只注入团队协作 Repository，
不会交给 Worker 或普通 Repository。生产 readiness 会同时校验 Runtime 与 Team Coordinator 的实际登录角色。

模型 Provider 必须兼容 OpenAI `/models`。开发模式强制从
`MODEL_CONTEXT_WINDOW` 和 `MODEL_MAX_OUTPUT_TOKENS` 读取 Pi 的预算，并只要求 `/models` 返回配置的
`MODEL_ID`；不要把预算值猜测为 Provider 元数据。生产模式保持更严格的预算元数据匹配策略。生产 Worker
入口为 `runtime-ts/apps/agent-worker` 的 `pnpm start:production`，仅支持 Linux，并且只使用模块内固定的真实
PostgreSQL/S3/CubeSandbox/Pi/Workspace/Artifact 依赖图；它绝不会复用 development 身份或调用方注入的 Fake。
`MODEL_SUPPORTS_IMAGES` 是必须显式配置的模型输入能力：设为 `true` 时，Worker 会把当前 user turn 的 PNG、
JPEG、GIF 与 WebP 附件以内联图片输入直接提交给模型；设为 `false` 时不读取图片字节，模型仍可从 user turn
中的稳定 `/resources/...` 路径按需使用文件。该开关不能依赖 Provider 失败后自动降级。
当 `MODEL_ID=deepseek-v4-flash` 时，Worker 使用 DeepSeek 官方 0731 Oh My Pi profile，并严格要求
`MODEL_CONTEXT_WINDOW=1048576`、`MODEL_MAX_OUTPUT_TOKENS=65536`、`MODEL_SUPPORTS_IMAGES=false`；
reasoning、high thinking、`max_tokens` 与工具调用重放兼容项由代码中的可信 profile 固定。`MODEL_BASE_URL`
和 API Key 仍是部署传输配置，可以指向已验证会暴露该官方 model ID 的兼容网关。

`/resources` 要求 CubeSandbox 0.6+ 的 `runtime-resourcefs` Volume driver：Worker 只通过 Cube Volume API
确保 Tenant 卷并在创建时绑定，rclone/FUSE 运行于 Cubelet 宿主机而不是 Sandbox 模板。该只读卷同时提供
Run 附件和 `/resources/skills/<canonicalKey>/<exactVersion>` 公开 Skill 市场虚拟视图，因此所有 Sandbox 工具
都会请求此卷；市场文件按打开读取，不提前复制到 Sandbox。节点安装和真实上线 Gate 见
`deploy/cube-resource-volume/README.md`。

### 模型网络报文诊断（development）

模型网络报文诊断默认关闭。需要定位“模型生成的工具参数有误”还是“工具内部执行失败”时，在本机 `.env`
显式设置以下字段，然后重启 Worker；修改正在运行的进程环境不会动态开启采集：

```dotenv
MODEL_WIRE_TRACE_ENABLED=true
MODEL_WIRE_TRACE_RETENTION_DAYS=7
MODEL_WIRE_TRACE_MAX_BYTES=1048576
```

`MODEL_WIRE_TRACE_RETENTION_DAYS` 决定新记录的到期时间，`MODEL_WIRE_TRACE_MAX_BYTES` 是每个 request/response
正文的独立字节上限，超过上限只保存精确前缀并标记为 `truncated`。停止现有 Worker 后重新执行
`corepack pnpm dev:worker`，此后新 Run 的每次 `/chat/completions` 调用才会进入诊断面。旧 Run 在采集关闭期间
没有保存网络正文，不能追溯或事后重建精确请求与 SSE。

同一开关在 development 还会把实际捕获的正文 best-effort 镜像到项目根目录
`model-wire-traces/<runId>/<attemptId>/`，方便直接用编辑器排障。文件名包含模型轮次、传输次数、part 与采集状态，
例如 `model-turn-00-transport-0-request-complete.json` 和
`model-turn-00-transport-0-response-truncated.sse`。该目录已被 Git 忽略；写入采用同目录临时文件加原子发布，
相同字节可以幂等重放，不同字节不会覆盖已有文件。镜像写失败不会改变模型调用或 PG/MinIO 诊断持久化结果。
本地文件不提供 ACL、UI 读取或 retention 保证，PG/MinIO 始终是这些能力的唯一权威存储；production 不创建本地镜像。

同一显式开关还会在上述 Run/Attempt 目录写入已经形成 durable mutation 的 Run 事件，文件名形如
`runtime-event-00000003-agent_event.json`。每个 sequence 单独使用不可变文件，便于直接查看思考增量、工具生命周期、
稳定错误类别和 Attempt 状态，同时避免 JSONL 在崩溃或幂等重放时产生半行或重复行。该镜像仍可能含用户或模型正文，
安全、保留和删除约束与原始模型报文完全相同；它不会保存原始工具异常、凭据或被既有安全边界禁止的 stdout/stderr。

启动开发 API 和 Web 后，在 Web 中选择 Thread 与 Run，进入“模型网络报文”区域即可按 Attempt、
`modelTurn` 和 `transportAttempt` 查看记录：`modelTurn` 表示工具循环中的模型轮次，`transportAttempt` 表示
同一轮的 HTTP 重试。request 展示实际交给 Fetch 的最终 application request body；response 展示 HTTP
content-decoding 后、SSE 解析前的应用可见正文，不包含 TCP/chunk framing 或 Content-Encoding 前的线路字节。
页面可以查看 UTF-8 文本或下载未经 API 重编码的正文，并同时显示采集状态、HTTP 状态、字节数和 SHA-256。

同一读取能力也通过 Run 嵌套 API 提供：

- `GET /v1/threads/:threadId/runs/:runId/model-wire-traces?limit=500`：列出元数据，并可用返回的 `nextCursor`
  继续分页。
- `GET /v1/threads/:threadId/runs/:runId/model-wire-traces/:attemptId/:modelTurn/:transportAttempt/:part/body`：
  读取 `request` 或 `response` 的 `application/octet-stream` 正文字节。

### 内部轨迹查看器（development）

开启上述模型网络诊断并产生 Run 后，可启动只监听本机回环地址的维护者轨迹查看器：

```powershell
corepack pnpm dev:trajectory
```

默认打开地址为 `http://127.0.0.1:4188`，数据源固定为仓库根目录 `model-wire-traces`。查看器按 Run/Attempt
聚合 durable Run 事件，展示近似模型步骤、思考、回复、工具生命周期、Attempt 状态、稳定错误类别和模型
request/response 原文。事件文件不包含 PostgreSQL `occurred_at`，所以页面耗时使用不可变文件 mtime 近似计算，
只用于本地排障。可以使用 `-- --port 4190` 或 `-- --root <受控目录>` 覆盖默认值。

该查看器不接入用户 Web、公开 API 或 production 装配，也不提供远程认证；禁止把它绑定、代理或转发到非回环地址。
页面和本地文件都可能包含 Prompt、思考、工具参数及模型可见回执，应按敏感诊断数据处理。

这两类接口沿用现有认证、Tenant Membership/RLS 与 Thread/Run 归属校验，不返回 S3 URL。正文可能包含完整
Prompt、工具参数、模型生成的 tool call，以及下一轮请求中模型可见的工具回执，必须按敏感诊断数据处理。
采集端口不接受 HTTP headers，因此不会保存 `Authorization`、Cookie 或 Provider 密钥。关闭
`MODEL_WIRE_TRACE_ENABLED` 只停止新增采集；生产环境在保留清理 consumer 完成部署前若设置为 `true`，Worker
会在创建数据库 Pool、安装 fetch instrumentation 或触达任何外部依赖之前失败关闭。

development Worker 已启用 Workspace manifest 物化与发布。新文件的 stable Blob 引用会先绑定到同一
Attempt 的持久化 candidate；最终 RuntimeMutation 在一个 SERIALIZABLE 事务内核对完整执行身份、manifest、
active incarnation 与 Workspace head，再写入 revision、推进 head 并释放 candidate 引用。unchanged 文件按
同路径精确复用 parent revision，不创建新 Blob；发布失败、终态和租约过期恢复会释放未提交 candidate，
COMMIT 响应未知则只通过原 mutation 幂等键读取结果，不猜测成功或失败。新 Sandbox 仍必须在物化前证明
`/workspace` 为空，`0014` 仍会失败关闭没有逐文件 manifest 的旧 current head，旧数据必须先经受控回填。
development Worker 的新 Session 只向模型暴露两个工具：`exec_command` 在当前 CubeSandbox 中同步执行 Bash
并返回真实 stdout、stderr 与退出码；`deliver_file(path, name?)` 选择 `/workspace` 内已经生成的文件，并在
ResourceVersion、Artifact 与 published settlement 原子提交后返回成功。旧的 `sandbox_command`、
`sandbox_run_code`、`sandbox_read_file`、`sandbox_write_file`、`declare_deliverables` 与 `publish_artifact` 不再注册到
新 Session；Run 成功也不再等待旧声明完成门。只有模型显式调用 `deliver_file` 的文件才成为可下载 Artifact，
不会自动发布整个 Workspace。

与 Codex `exec_command` 尚未对齐的能力均为 TODO：PTY、`yield_time_ms`、后台 session/`write_stdin`、独立 cwd
参数、精确 tokenizer 输出预算、超时前部分输出、可恢复终端 transcript，以及可选 shell/login/TTY 参数。
当前同步 MVP 固定使用 `/bin/bash -c`，这些差异不应被解释为已经兼容。`deliver_file` 是产品交付工具，不是
Codex 命令工具的对应接口。

diagnostic/trace 的内部 Resource 不进入租户成员可搜索的 Resource Library。生产 `startWorkerProcess` 也使用同一
持久化 Workspace→Revision→Artifact 闭环，但 production 只接受部署分片 Tenant、Runtime 数据库角色、TLS 依赖
端点，并拒绝任何遗留的 `DEV_AUTH_*` 变量。完整协议见 [`ADR-0047`](docs/decisions/0047-workspace-candidate-atomic-handoff.md) 与
[`ADR-0048`](docs/decisions/0048-workspace-artifact-runtime-closure.md)、
[`ADR-0057`](docs/decisions/0057-single-exec-command-model-observation.md) 与
[`ADR-0058`](docs/decisions/0058-simple-deliver-file-tool.md)。

## 生产 API、Scheduler、Worker 与供应链 Gate

`deploy/production.env.example` 是 production 的独立、可提交配置契约；真实值必须由部署平台的秘密管理系统注入，
绝不能复制 development 的 `DEV_AUTH_*`、MinIO root、bootstrap 或 migration 变量。可执行的静态与容器 Gate 为：

```powershell
corepack pnpm config:check:production
corepack pnpm supply-chain:check
corepack pnpm license:check
corepack pnpm release:check
corepack pnpm test:production-api:container
corepack pnpm test:production-scheduler:container
corepack pnpm test:production-worker:container
```

三个镜像的 build 与 runtime 层固定使用同一 Node manifest digest，`packageManager` 同时固定 pnpm 版本与 registry
integrity。builder 只在 `pnpm fetch --frozen-lockfile` 阶段联网；其后的 offline 安装、编译、deploy 和裁剪均以
`RUN --network=none` 执行。最终镜像只含 production 闭包，不含源码、测试、development entry、Python、npm/npx、
Corepack/pnpm 或 Biome/TypeScript/tsx/Vitest。这里证明的是锁定 fetch 后的断网解析与编译，不是完整离线 Docker build。
容器 Gate 会确认 build context 不含 `.env` canary、进程使用非 root UID 与真实 production entry，运行闭包和证据均为
root:root 且不可由运行 UID 改写，并以只读 root filesystem 加独立 `/tmp` tmpfs 执行；同时在外部依赖不可用、
development 变量遗留、明文端点或 TLS/角色配置错误时验证失败关闭和秘密脱敏。API Gate 还在最终镜像中以真实 AWS SDK
执行与 Worker 相同 stable prefix 的 HEAD、GET 与预签名下载路径，防止 Artifact 读写侧漂移。Scheduler 在启动 cleanup
loop 前探测 PG 角色与 CubeSandbox，readiness 同时包含两者；它不使用对象存储，因此其环境投影拒绝接收 S3 密钥。

部署必须按服务分片秘密：API 只取得 PG/S3/JWT/TLS，Scheduler 只取得 PG/Cube，Worker 只取得 PG/S3/Cube/模型；不要
把 `production.env.example` 作为共享秘密文件整包注入任一容器。样例是三服务配置字段的合集，不是单容器授权清单。
三个 production 入口对非空 `NODE_*` 默认拒绝，仅允许镜像的 `NODE_ENV`/`NODE_VERSION` 与私有 CA 通道
`NODE_EXTRA_CA_CERTS`，并按大小写不敏感语义拒绝环境代理、vendor Cube 回退及 OpenSSL CA/config/provider 覆盖。
最终镜像先由非 Node entrypoint 拒绝 Node 启动前会消费的已知危险变量，防止 `NODE_OPTIONS` 预加载；未来 `NODE_*`
与 `CUBE_*` 则由最早 JS 配置边界失败关闭。该边界不能抵抗有权覆盖镜像 entrypoint/命令的
恶意部署者；真正的 admission policy、容器启动策略与 `readOnlyRootFilesystem` 仍须在 M7 外部部署验收中证明。
`API_PUBLIC_ORIGIN` 是浏览器/API 对外 origin，`S3_PUBLIC_ENDPOINT` 必须使用不同的专用对象 origin，禁止经应用同源路径
代理对象正文。对象存储/CDN 的 CORS 只能允许受信 Web origin；当前代码与容器 Gate 没有证明外部 CDN 已配置
`nosniff` 或 CSP，部署验收必须单独核对，不能把文档要求当作已验证响应头。

`supply-chain:check` 从 pnpm production installed closure 离线生成无时间戳、确定排序的 CycloneDX 1.6 并与已提交文件逐字
比较；`license:check` 对 registry 与 vendor 闭包执行默认拒绝策略，本地派生 vendor 的上游 commit、patch 与 canonical
tree hash 由 Gate 重算，exact patch 还必须通过 `git apply --reverse --check`；canonical tree 是包含 `PATCHES` 的完整证据
快照，并不声称 patch 单独重建自身证据文件。`LICENSE`/`SOURCE.md`/`PATCHES` 随 API、Scheduler、Worker 镜像交付。
基础镜像 digest 的当前依据是本地 Docker `RepoDigests`；网络不可达时不宣称已经远端重新验证。发布时必须填写
[`deploy/production-release-manifest.example.json`](deploy/production-release-manifest.example.json) 并执行
[`deploy/production-release-checklist.md`](deploy/production-release-checklist.md)。以上 Gate **不等同于**真实部署 readiness：
上线前仍需在 Linux、最小权限 Runtime 角色和真实外部依赖下完成验收及 M7 的其余 Gate。

## 开发基线

- Node.js 24.18.0 LTS
- pnpm 10.15.1
- TypeScript 5.9.3
- PostgreSQL 17（复用本机已有实例中的专用数据库）
- MinIO（由 `docker-compose.dev.yml` 管理）
- CubeSandbox（通过官方 Node SDK 接入）

## Windows PowerShell 启动与检查

### 非首次一键启动

已经完成依赖安装、数据库 bootstrap、迁移、开发身份初始化和 `.env` 配置后，可在仓库根目录双击 `start-development.cmd`，或执行：

```powershell
.\scripts\start-development.ps1
```

脚本不会启动或修改 PostgreSQL、S3/MinIO、CubeSandbox 和模型 Provider。它只使用 `.env` 执行 Worker 只读预检，任一外部服务不可用时直接报错。核心 Runtime 默认包含 API、Agent Worker、Scheduler 和 Web；已经运行且健康的应用会被复用，只为缺失应用打开新的 PowerShell 窗口。Skill Admin API 和 Skill Admin Web 默认不启动，脚本会交互询问 `是否启动 Skill Admin API 和 Skill Admin Web？[y/N]`，直接回车即跳过。

交互提示中输入 `y`、`yes`、`1` 或 `是` 才会启动 Skill 管理服务。自动化或非交互调用可以显式选择：

```powershell
# 不询问，明确只启动核心 Runtime
.\scripts\start-development.ps1 -CoreOnly

# 不询问，明确包含 Skill 管理服务
.\scripts\start-development.ps1 -IncludeSkill

# 其他可选参数
.\scripts\start-development.ps1 -SkipBuild
.\scripts\start-development.ps1 -NoBrowser
```

### 首次启动与检查

以下命令均在仓库根目录执行。先从 `.env.example` 创建只保存在本机的 `.env`，再填写自己的 PostgreSQL 角色、CubeSandbox 模板及其他配置；不要把真实凭据提交到 Git。

```powershell
Copy-Item .env.example .env
# 使用本地编辑器填写 .env

# 将 .env 注入当前 PowerShell，供后续真实冒烟和集成测试使用。
Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $name, $value = $_.Split('=', 2)
  Set-Item -Path "Env:$name" -Value $value
}

corepack pnpm install --frozen-lockfile
docker compose -f docker-compose.dev.yml --env-file .env up -d
docker compose -f docker-compose.dev.yml --env-file .env ps
```

检查 PostgreSQL TCP 端点、MinIO 和 CubeSandbox API。端口和 URL 均读取当前 `.env`，不需要把值写进命令：

```powershell
$database = [Uri]$env:DATABASE_URL
Test-NetConnection -ComputerName $database.Host -Port $database.Port
Invoke-WebRequest -UseBasicParsing "$($env:S3_ENDPOINT)/minio/health/live"
Invoke-RestMethod "$($env:CUBESANDBOX_API_URL.TrimEnd('/'))/health"
```

对已经按 [`docs/development.md`](docs/development.md) 完成角色与 Schema bootstrap 的专用数据库执行迁移，然后构建并运行从无 `dist` 开始的完整工程 Gate：

```powershell
corepack pnpm db:migrate:up
corepack pnpm dev:identity:provision
corepack pnpm build
corepack pnpm check:clean-workspace
```

真实 CubeSandbox 冒烟默认关闭，必须显式开启；它会创建 Sandbox，检查命令、代码、文件和暂停恢复，并在 `finally` 中清理所创建的 Sandbox：

```powershell
$env:REAL_CUBE_SMOKE = "1"
corepack pnpm test:cube:real
Remove-Item Env:REAL_CUBE_SMOKE
```

M4 PostgreSQL 黑盒会使用 `.env` 中的数据库管理连接创建、迁移和清理隔离的测试角色与 Schema；只应对专用开发数据库执行：

```powershell
$env:RUN_PG_RUN_WORKER_INTEGRATION = "true"
corepack pnpm test:integration:m4
Remove-Item Env:RUN_PG_RUN_WORKER_INTEGRATION
```

Pi + Cube 的真实纵向冒烟同样默认关闭。它可以从 Windows Worker 连接 Linux CubeSandbox；这里的“真实”是指连接真实 CubeSandbox 的纵向链路，模型侧使用 Pi Faux Provider，不调用外部模型，也不需要真实模型凭据：

```powershell
$env:REAL_PI_CUBE_SMOKE = "1"
corepack pnpm test:pi-cube:real
Remove-Item Env:REAL_PI_CUBE_SMOKE
```

完成观察后停止本仓库管理的 MinIO：

```powershell
docker compose -f docker-compose.dev.yml --env-file .env down
```

不要使用 `down -v`，除非明确需要删除 MinIO 开发数据。CubeSandbox 和 PostgreSQL 不由该 Compose 文件管理，应按各自部署方式停止。

## 可查看的入口

- CubeSandbox Web 控制台：`.env` 中的 `CUBESANDBOX_WEB_URL`
- CubeSandbox API 健康端点：`CUBESANDBOX_API_URL` 后加 `/health`
- MinIO Console：`http://127.0.0.1:<MINIO_CONSOLE_HOST_PORT>`
- MinIO S3 API：`.env` 中的 `S3_ENDPOINT`（宿主端口由 `MINIO_HOST_PORT` 指定）

这些入口只用于查看 CubeSandbox 与对象存储状态，并不是本项目的产品 Web UI。

## 文档与目录边界

- [开发指南](docs/development.md)
- [实施路线与阶段 Gate](docs/roadmap.md)
- [架构决策索引与记录规则](docs/decisions/README.md)
- [Python 原型参考行为清单](docs/python-prototype-reference.md)

`runtime-ts/apps` 保存可部署进程入口，`runtime-ts/packages` 保存运行时模块，`runtime-ts/vendor` 只保存经过版本固定和许可证审查的第三方源码。CubeSandbox SDK 的固定来源见 [`runtime-ts/vendor/cubesandbox-sdk/SOURCE.md`](runtime-ts/vendor/cubesandbox-sdk/SOURCE.md)。
