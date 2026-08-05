# 开发指南

## 前置版本

- Node.js `24.18.0`
- pnpm `10.15.1`
- Docker Compose v2（只在校验和本地基础设施中使用）

版本同时固定在 `package.json`、`.node-version`、`.nvmrc` 和 CI 中。依赖版本必须精确锁定，不能使用 `^`、`~` 或浮动标签。

## 常用命令

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm config:check
```

`pnpm check` 按上述顺序执行完整校验。格式修复使用 `pnpm format`。配置校验只读取可提交的 `.env.example`，不会读取真实 `.env`；错误也只能输出变量名，不能输出值。

## Workspace 边界

### 可部署应用

| 路径 | 边界 |
| --- | --- |
| `runtime-ts/apps/api` | HTTP/SSE 协议适配和依赖装配 |
| `runtime-ts/apps/agent-worker` | Agent 执行循环和运行协调 |
| `runtime-ts/apps/scheduler` | 回收、清理等可重试后台工作 |
| `runtime-ts/apps/web` | 浏览器应用入口，只消费公开协议 |
| `runtime-ts/apps/skill-admin-api` | Skill 提交、复核、发布和撤销的独立管理 API |
| `runtime-ts/apps/admin-web` | 独立 Skill 发布管理界面，只消费管理协议 |

### 共享包

| 包 | 唯一职责 |
| --- | --- |
| `domain` | Tenant、Thread、Run 等领域实体与不变量 |
| `protocol` | API、事件和进程间消息契约 |
| `protocol-mapper` | Domain 与 Protocol 的显式映射及公共错误归一化 |
| `persistence` | PostgreSQL 仓储、事务与迁移适配 |
| `process-runtime` | 严格进程配置、信号、排空、关闭和健康状态语义 |
| `prompt-builder` | 可审计、可复现的系统提示词组装 |
| `context-policy` | 上下文选择、截断和压缩策略 |
| `tool-router` | 工具鉴权、路由、审计和错误归一化 |
| `sandbox` | CubeSandbox 厂商 SDK 适配 |
| `workspace` | Thread 私有工作区及版本快照 |
| `resource` | 跨 Thread 资源和不可变版本 |
| `artifact` | Agent 明确发布的最终交付物 |
| `testing` | Fake、夹具和跨包测试工具，仅供测试使用 |

应用依赖共享包时，必须通过 pnpm Workspace 依赖显式声明，不能使用跨目录相对导入。共享进程包不拥有业务依赖，也不提供测试 Fake 作为生产默认值。

## 配置安全

- 真实 `.env` 只保存在开发者机器并由 Git 忽略。
- 新增或删除 development 环境变量时，必须同步修改 `.env.example` 和 `scripts/env-contract.mjs`；production 变量必须同步修改 `deploy/production.env.example` 和 `scripts/production-env-contract.mjs`。跨环境共享变量两套契约都要更新。
- 示例中的数据库密码、访问密钥、模板 ID、模型地址和模型 ID 必须保持为明显占位值。
- CI 的工程基线任务只使用 `.env.example` 执行静态 Compose 展开；独立的 Ubuntu M4 黑盒 Gate 会连接 CI PostgreSQL service，运行真实 HTTP、RLS、Dispatch、Worker 与 Pi adapter（Faux Provider）纵向链路。该 Gate 不连接 MinIO、真实 CubeSandbox 或外部模型服务。

服务进程先用各应用的 `select*ProcessEnvironment` 从 `process.env` 投影声明键，再严格解析。禁止把完整宿主环境直接交给解析器，也禁止为缺失的 `RUNTIME_ENV` 回退到 development。API 的 `DEV_AUTH_ENABLED=true` 只允许 development/test；生产环境必须使用真实身份装配器。配置错误只记录变量名与稳定分类，不能记录值。

## 进程启动与关闭

`runtime-ts/apps/api` 在 `RUNTIME_ENV=development`、显式启用开发身份时可选择内建的开发装配：它打开真实 PostgreSQL Repository 和 HTTP listener，可用 `pnpm dev:api` 启动。迁移后先显式执行 `pnpm dev:identity:provision`，该命令幂等创建配置的两个 User、个人 Tenant 和 owner Membership；服务启动本身绝不写入授权数据。该装配和初始化命令都不支持 production，也不会退化到内存 Fake。

需要测试 Skill Center 时，可显式执行 `pnpm dev:skill:publish:pptx`。该命令只接受 `RUNTIME_ENV=development`，把固定提交的 Anthropic PPTX 测试包幂等写入私有对象存储并原子发布到受管目录；API 启动不会隐式发布目录内容。该 fixture 受专有许可证约束，不属于生产目录或发布制品。

### 管理员 Skill 上架

一般 Skill 不再通过修改代码或普通 Runtime API 上架。管理员发布面是独立的 `skill-admin-api` 与
`admin-web`，日常状态流为：

```text
publisher 创建草稿并上传包 -> publisher 提交 -> reviewer 批准/驳回
-> admin 发布到技能中心 -> admin 必要时硬撤销
```

发布者不能审核自己的申请；首次公开某个规范键时必须勾选“设为推荐版本”。驳回申请为终态，修订内容需要创建
新的申请。每次写操作都有独立幂等键，状态推进还使用界面返回的版本令牌，409 表示页面状态已过期，应刷新后再
决定操作，不能盲目重放成另一请求。

开发环境准备顺序如下：

1. 由 Database Admin 创建与 Runtime/Migrator 互异的 `DATABASE_SKILL_PUBLISHER_ROLE` 登录角色。该角色必须
   `NOINHERIT`，不能拥有任何角色成员、数据库/Schema/关系/routine ownership、`CREATE` 或 `TEMPORARY`；只授予
   目标数据库 `CONNECT`。把它的连接串写入忽略的 `.env` 中的 `SKILL_PUBLISHER_DATABASE_URL`。
2. 为发布服务配置独立的 `SKILL_PUBLISHER_S3_*` 凭据；该凭据不能复用普通 API/Worker 的 S3 身份。执行
   `pnpm db:migrate:up`，迁移会从空 ACL 重建发布角色的精确白名单并验证 Runtime 对管理表零权限。
3. 先执行 `pnpm dev:identity:provision` 创建开发 User。再由受控数据库运维事务向
   `platform_skill_operators(user_id, role, status)` 配置 `publisher`、`reviewer`、`admin`；管理 API 故意不提供
   自助提权路由。单进程本地完整流程可把 `DEV_SKILL_ADMIN_USER_ID` 配置为 `admin`；职责分离测试应使用不同用户与
   进程。operator 变更必须进入数据库运维审计。
4. `.env` 中为管理 API 设置 `DEV_SKILL_ADMIN_USER_ID` 与至少 16 字符的
   `DEV_SKILL_ADMIN_TOKEN`。开发 Vite 代理只在服务端注入该 Token，不会把它编译进浏览器静态资源。
5. 在两个终端分别启动：

```powershell
corepack pnpm dev:skill-admin:api
corepack pnpm dev:skill-admin:web
```

浏览器访问 `http://127.0.0.1:4174`。上传包必须包含根级、严格 UTF-8 的 `SKILL.md`，最多 256 个文件、总计
32 MiB、入口最多 64 KiB；界面采集 SPDX 许可证，上游 URL 和不可变 revision 是可选高级信息。未声明兼容性时由
系统固定为 `Agent Skills 标准格式`，未声明上游来源时以规范包 SHA-256 标识实际文件。确定性校验通过后的版本仍
标记为 `restricted`，管理员必须人工检查入口正文、许可证、文件摘要及已声明的来源；它不等价于恶意软件或脚本
行为检测。

选择文件或目录后，管理 Web 会在本地解析 `SKILL.md` 的受限 YAML Front Matter，并自动预填 `name`、
`description`、`license` 以及已显式声明的扩展发布字段。`Proprietary` 声明映射为
`LicenseRef-Proprietary`，完整条款仍以包内声明为准。浏览器无法从本地目录获得可信仓库来源和提交身份，因此来源
字段保持可选，不会被猜测；格式兼容性由系统生成。该预填不替代服务端包校验，边界见
[ADR-0114](decisions/0114-skill-frontmatter-metadata-prefill.md) 和
[ADR-0115](decisions/0115-system-compatibility-optional-provenance-and-skills-cli.md)。

production 管理服务必须单独注入 `SKILL_ADMIN_JWT_*`、`SKILL_PUBLISHER_DATABASE_URL` 与
`SKILL_PUBLISHER_S3_*`，且 JWT audience 不能复用普通 API。静态管理 Web 与 API 由同源身份网关托管：网关必须
剥离浏览器伪造的 Authorization，根据已登录管理会话注入短期管理 JWT。没有该网关时不得把 development Token
或固定生产 Token 写入 Web 构建。完整边界见 [ADR-0112](decisions/0112-managed-skill-admin-publication.md)。

PPTX Skill 宣称预装的 Node.js、`pptxgenjs`、图标渲染和 LibreOffice/Poppler 依赖必须由 Sandbox 模板提供，不能在 Run 内临时安装。开发模板从 `deploy/cubesandbox/agent-sandbox-pptx.Dockerfile` 构建；发布镜像后用 CubeSandbox `Template.build({ image })` 创建不可变模板，并把返回的模板 ID 写入本地 `.env` 的 `CUBESANDBOX_TEMPLATE_ID`。基础镜像使用摘要固定，Node 模块使用精确版本；每次发布使用新的不可变镜像标签，不在既有标签上依赖 `Template.rebuild` 刷新。命令服务会净化进程环境，因此模板同时提供根级 `/node_modules` 解析路径，不能只依赖镜像中的 `NODE_PATH`。旧模板保留到新模板完成真实 `.pptx` 生成及 pause/resume 冒烟后再回收。

`agent-worker` 的 `pnpm dev:worker` 同样仅支持 development：它使用真实 PostgreSQL dispatch、S3 durable observation、CubeSandbox 和 OpenAI-compatible Provider。`AGENT_WORKER_TENANT_ID` 必须严格等于 `DEV_AUTH_USER_A_TENANT_ID`，保证 `dev-user-a` 的 Web/API 创建结果由同一 Worker 消费。先用 `pnpm dev:worker:check` 执行不常驻、只读的完整 readiness；它不会启动 polling 或领取 dispatch。开发 Provider 的 `/models` 只需存在 `MODEL_ID`，但 `MODEL_CONTEXT_WINDOW` 与 `MODEL_MAX_OUTPUT_TOKENS` 仍为严格必填的显式预算。

VMware 内的 Cubelet 挂载附件与 `/resources/skills` 公开市场视图时，不能直接访问只监听 Windows loopback 的
API。所有 Sandbox 工具现在都依赖该 ResourceFS 数据面。先为宿主虚拟网卡生成独立的开发 TLS 证书，把 CA 公钥
安装到 Cubelet 节点系统信任库，再随 API 启动最小 ResourceFS Sidecar：

```powershell
$env:RESOURCEFS_PROXY_LISTEN_HOST='<VMware host-only 宿主地址>'
$env:RESOURCEFS_PROXY_LISTEN_PORT='<HTTPS 端口>'
$env:RESOURCEFS_PROXY_UPSTREAM='http://127.0.0.1:3001'
$env:RESOURCEFS_PROXY_TLS_KEY_PATH='<未提交的 server.key 绝对路径>'
$env:RESOURCEFS_PROXY_TLS_CERT_PATH='<未提交的 server.crt 绝对路径>'
node scripts/development-resourcefs-proxy.mjs
```

Sidecar 只接受 `/v1/resource-filesystem`，不得用它转发其他 API 路由。证书、CA 私钥和日志必须放在 `.arts` 等
忽略目录。节点 endpoint 使用该证书覆盖的 HTTPS 地址；未携带 ResourceFS capability 的探针应快速返回 401，
而不是超时。配置与安全边界见 [ADR-0105](decisions/0105-development-resourcefs-https-sidecar.md)。

production Worker 使用 `pnpm --filter @cube-runtime/agent-worker start:production` 或 `Dockerfile.production-worker-gate`，仅支持 Linux。公开入口固定模块内真实装配，不接受调用方注入的 Fake，且不改写 `runtimeEnvironment=production`；通用 `process-runtime` 只是受信代码的生命周期编排器，不是 JS 进程内调用方 ACL。启动前必须验证 `DATABASE_RUNTIME_ROLE`、部署 Tenant 分片、严格模型元数据和 TLS 端点；任一 `DEV_AUTH_*` 变量（包括 `DEV_AUTH_ENABLED=false`）都会失败关闭。生产装配已经接入持久化 Workspace revision/Artifact 发布闭环，但这不替代真实基础设施验收。

装配器按业务接收顺序实现 `stopAccepting`，将数据库连接池、HTTP listener、消费者和遥测等资源按确定顺序登记。关闭时先停止接收，再等待 `lifecycle.track()` 登记的在途操作，最后串行关闭资源。资源错误只上报稳定名称；库不调用 `process.exit`。部署平台的强制终止宽限期必须大于 `PROCESS_SHUTDOWN_TIMEOUT_MS`。

进程骨架专项校验：

```powershell
corepack pnpm test:process-runtime
corepack pnpm test:process:container
corepack pnpm config:check:production
corepack pnpm supply-chain:check
corepack pnpm license:check
corepack pnpm release:check
corepack pnpm test:production-api:container
corepack pnpm test:production-scheduler:container
corepack pnpm test:production-worker:container
```

第一条在 Windows/Linux 运行相同单元与入口测试；第二条需要 Docker，构建 Linux 非 root 最小镜像并验证配置、就绪和关闭顺序。
后七条依次校验独立 production 配置、离线 SBOM、许可证、发布回滚以及 API/Scheduler/Worker runtime-only 容器边界；容器 Gate 故意不连接真实外部依赖。部署必须分片注入秘密：API 使用 PG/S3/JWT/TLS，Scheduler 只使用 PG/Cube，Worker 使用 PG/S3/Cube/模型，不能把共享 env 文件整包注入。部署前仍必须在 Linux 上用最小权限 Runtime 角色、真实 PostgreSQL/S3/CubeSandbox/模型完成 readiness 和其余 M7 Gate；Web/OIDC 产品身份仍是未完成的外部集成。

## PostgreSQL 角色 bootstrap

业务 Schema 迁移不能替代数据库级 bootstrap。首次准备专用数据库时，由不进入应用进程的 Database Admin 完成以下一次性操作：

1. 创建无 `SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION` 的 Migrator、Runtime 与 Skill Publisher 登录角色，并保证三者互异且都没有任何上游或下游角色成员关系；Runtime 和 Skill Publisher 必须为 `NOINHERIT`，不能保留可 `SET ROLE` 的成员关系；
2. 从 `PUBLIC`、Migrator、Runtime 和 Skill Publisher 撤销目标数据库的全部权限，再只向三个角色授予 `CONNECT`；Runtime 与 Skill Publisher 不得通过 `PUBLIC` 获得 `CREATE` 或 `TEMPORARY`；
3. 创建专用业务 Schema，并只让 Migrator 成为该 Schema owner；Database Admin 继续作为数据库 owner；
4. 确认 Runtime 与 Skill Publisher 都不是数据库、Schema、表、序列或 routine owner；Migrator 不是数据库 owner，且只拥有配置的业务 Schema；
5. 分别写入本机忽略文件中的 `DATABASE_BOOTSTRAP_URL`、`MIGRATION_DATABASE_URL`、`DATABASE_URL`、`SKILL_PUBLISHER_DATABASE_URL`、`DATABASE_RUNTIME_ROLE`、`DATABASE_MIGRATOR_ROLE`、`DATABASE_SKILL_PUBLISHER_ROLE` 与 `DATABASE_SCHEMA`。Bootstrap/Migration URL 只用于本地权限集成测试或受控运维，不能进入常驻服务进程。

`pnpm db:migrate:up` 会在任何 DDL 前同时验证 Runtime、当前 Migrator、Skill Publisher、Schema owner 与精确 `search_path`，并拒绝 Runtime/Skill Publisher 的目标 Schema `CREATE`、数据库 `TEMPORARY`、角色继承/成员关系/ownership、Migrator 对无关 Schema 的有效 `CREATE`、额外非系统 ownership、任何 routine default ACL 记录及任何目标 Schema routine。Schema migration、迁移记录、最小 ACL bootstrap 和结束白名单断言共用同一事务。首版 routine manifest 为空；runner 完全不修改 routine 的全局或局部 default ACL，并在迁移 SQL 后、提交前再次断言目标 routine 集合仍为空，任何 migration 创建 routine 都会整体回滚。bootstrap 从空集合重建 Runtime 与 Skill Publisher 的精确 ACL，并对逐表全部 DML/DDL、routine `EXECUTE` 及数据库、Schema 有效权限执行白名单断言。未来引入函数、过程或聚合前，必须单独设计 manifest 并显式审查 `SECURITY DEFINER`、owner、参数、固定 `search_path` 和调用权限。`pnpm db:migrate:down` 只在 development/test 加显式破坏开关时工作；down SQL、ACL 回收和结束断言同样共用一个事务，任一步失败都整体回滚。down 不修改 routine default ACL，也不会删除角色或回滚 Database Admin bootstrap。

## HTTP API 开发边界

开发 API 监听 `API_LISTEN_HOST`/`API_LISTEN_PORT`，未配置时分别为 `127.0.0.1`/`3001`；启动时先探测 PostgreSQL，再开始报告 ready。`/live` 只表示 HTTP 进程存活，`/ready` 会实时探测数据库。SIGINT/SIGTERM 先调用 Fastify close 停止接收并排空 handler，再关闭 PG pool；启动中任一步失败也会尽力回收两者。分页密钥环采用 `kid:base64url-key,kid:base64url-key`，每把 key 解码后必须为 32 到 64 字节。开发身份初始化命令复用 Runtime 角色、正式 Tenant Repository、租户事务和 RLS；每个个人租户聚合原子提交，重复执行只接受已存在且 owner/active 关系完全匹配的结果，冲突失败关闭。开发装配不会自动写入身份数据，避免“启动服务”隐式改变租户关系。

`runtime-ts/apps/api` 使用 `createApiApp` 显式注入身份、Repository、时钟、ID、HMAC 游标密钥环和探针等端口。测试用 `Fastify.inject` 而不监听网络端口。`AuthContextResolver` 只返回已验证 principal，之后仍必须用 PostgreSQL Membership 解析 `TenantScope`；不得读取 `x-tenant-id` 构造 scope。游标密钥必须来自密钥管理配置，不能使用仓库内常量；最短 32 字节。codec 必须注入可信时钟、签发 TTL 和最大 TTL；轮换按“先同时读取新旧 key、再切换 active、等待旧 key 签发游标的 `expiresAt` 与最大 TTL 都失效、最后移除旧 key”进行。

`PgThreadCreation` 与 `PgRunDispatchCreation` 分别提供 Thread+初始 Workspace、Run+不可变输入+Dispatch Outbox 的原子 PostgreSQL 适配；两者均以租户事务、成员资格重验、advisory lock 和幂等记录收敛首次并发竞争。COMMIT 响应未知或提交后响应丢失时，只允许按同一 scope+idempotency key+request hash 精确读回，禁止再次写入。只有 `createApiCreateCapability` 同时签发两个原子端口时才注册 POST；签发和 App 创建都会快照能力，运行中替换对象无效。不注入能力时服务保持可读、可归档、可取消且 `/ready` 正常。`ArchiveThreadCommandPort` 已有 PostgreSQL 适配，必须保持 Membership `FOR SHARE`→Thread `FOR UPDATE` 锁序、事务内角色重验和数据库单调时间，禁止退化为 API 层 Repository 读改写。

Runtime 对 Membership 只有 SELECT、INSERT 和恒定 `lock_marker` 的单列 UPDATE，不允许表级 UPDATE，也不允许更新 `status`、`role`、租户/用户关联、ID 或创建时间。`lock_marker` 由 CHECK 约束为 `false`，只用于满足 PostgreSQL `FOR SHARE` 的列权限前提。不得把它改造成业务状态；成员变更必须由独立权限边界完成。

0003 才引入 `lock_marker`。ACL bootstrap 与白名单断言必须按数据库实际列集合工作，partial down 到 0002 时不能引用该列，再次 up 到 0003 后必须恢复单列权限。新增版本相关 ACL 时必须同时增加真实 PostgreSQL 的 `最新→旧版→最新` 往返测试。

公开错误中，Schema、超限、畸形 JSON、危险原型键和游标错误统一为 400 `INVALID_REQUEST`；非 `application/json` 的创建请求为 415 `UNSUPPORTED_MEDIA_TYPE`。不能把 Fastify/AJV 的内部错误消息直接返回给客户端。

## 本地 Web 体验 API

本地 Web 开发服务器必须将 `/v1` 反向代理到 API，保持浏览器同源；API 不注册 CORS 插件或通配来源。开发固定身份仅用于回环网络，不能通过 CORS 扩大其可达范围。

`GET /v1/threads/:threadId/runs/:runId/events?after=-1&limit=100` 从 PostgreSQL 的 `run_events` 按 `(attempt_id, sequence)` 读取。`after` 是排他 sequence 游标，响应只包含当前 Run 最新 Attempt 中 sequence 更大的持久化事件，按升序返回，最大 200 条。每项以 `<attemptId>-<sequence>` 形成稳定 `eventId`。当 `kind=agent_event` 且 `payload.type` 位于 RuntimeAgentEvent 的受支持白名单时，`type` 使用该子类型；其他事件或未知 payload 一律令 `type=kind`，并始终保留原始 `kind`。Run 不存在、Thread 不匹配、跨租户或成员关系失效一律为 404；数据库异常为 503，不泄漏 SQL 或事件内部错误。

`GET /v1/threads/:threadId/runs/:runId/artifacts` 只返回已 settled 为 published 的 deliverable；授权 Run 没有发布记录、只有 publishing 或只有 failed 记录时返回 200 空列表。预览和下载端点仅对该列表中的 Artifact 签发最长 300 秒的 S3 URL；签发后再次读取并逐字段确认授权修订及完整固定 Blob 绑定，任一漂移都按 404 失败关闭。BlobStore 适配错误统一返回不泄漏内部消息的 503。`preview` 只为安全 charset 的纯文本、PNG/JPEG/GIF/WebP 和 PDF 生成 inline 响应；HTML、SVG、XML 等主动内容返回 422，但 `download` 仍可使用已净化文件名以 attachment 方式签发。URL、对象键和签名不写入 API 日志或持久化事实。Artifact DTO 在该投影中补充可选 `mediaType` 与 `sizeBytes`，旧的领域 DTO 映射不要求提供它们。

固定开发身份启用时，`S3_PUBLIC_ENDPOINT` 必须使用字面回环地址，并与 API origin 和 Web 的 `http://127.0.0.1:4173` origin 不同；推荐 MinIO 使用 `http://127.0.0.1:19000`。LAN 地址、`localhost`、携带凭据/路径/查询的 public endpoint 均在装配前失败。

## 提交前检查

1. 行为变化有测试。
2. 架构或兼容性取舍写入 `docs/decisions`。
3. 关键边界、不变量和失败语义有必要的中文注释。
4. `pnpm check` 通过。
5. `git status` 中没有 `.env`、构建产物或无关文件。
