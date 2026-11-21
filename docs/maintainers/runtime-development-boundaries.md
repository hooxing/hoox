> [!NOTE]
> 本文保留进程装配、数据库权限、Skill 发布和 HTTP 实现不变量，面向维护者。首次配置和日常启动请阅读 [`docs/development.md`](../development.md)；API 使用方请阅读[开发 API 契约](../reference/development-api.md)。
# Runtime 开发边界（维护者）

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

独立的 `typecheck` 和 `test` 会先构建所需产物；`pnpm check` 先检查工具链、模型目录、格式和 lint，只执行一次全工作区构建，再复用产物执行补充类型检查、测试和配置校验。`pnpm check:clean-workspace` 先删除工作区 `dist`，验证构建不依赖历史产物。格式修复使用 `pnpm format`。配置校验只读取可提交的 `.env.example`，不会读取真实 `.env`；错误也只能输出变量名，不能输出值。

## CI 合并门禁

CI 并行执行三个独立 Job：工程构建与测试（含生产配置契约校验与生产依赖漏洞审计）、Linux/Windows 进程测试和 M4 PostgreSQL 黑盒。工程检查保留完整 clean build；进程专项与 M4 各自清理并构建依赖，不从其他 Job 下载工作区产物。

“工程基线校验”汇总工程 Job 结果，在依赖结束后始终检查，只有成功才通过；失败、取消或跳过均不能放行。PR 新提交取消过期 CI，main CI 不取消。

仓库管理员应在 main 的 ruleset 或分支保护中要求“工程基线校验”“进程骨架（ubuntu-latest）”“进程骨架（windows-latest）”和“M4 开发黑盒（Linux PostgreSQL）”全部成功。工作流文件不会自动启用远端分支保护，不能用其存在代替设置核验。Demo 发布入口见[Demo 持续部署](../operations/demo-cd.md)。

## Workspace 边界

### 可部署应用

| 路径 | 边界 |
| --- | --- |
| `runtime-ts/apps/api` | HTTP/SSE 协议适配和依赖装配 |
| `runtime-ts/apps/agent-worker` | Agent 执行循环和运行协调 |
| `runtime-ts/apps/scheduler` | 回收、清理等可重试后台工作 |
| `runtime-ts/apps/web` | 浏览器应用入口，只消费公开协议 |
| `runtime-ts/apps/admin-control-api` | 模型、记忆、配置、统计与 Skill 发布路由的统一管理 API |
| `runtime-ts/apps/admin-web` | 独立后台管理界面，只消费管理协议 |

`runtime-ts/apps/skill-admin-api` 保留 Skill 提交、复核、发布和撤销的可复用路由模块，但不再拥有独立 listener、身份配置或进程入口。

### 共享包

| 包 | 唯一职责 |
| --- | --- |
| `domain` | Tenant、Thread、Run 等领域实体与不变量 |
| `protocol` | API、事件和进程间消息契约 |
| `protocol-mapper` | Domain 到 Protocol 的显式投影及公共错误归一化 |
| `persistence` | PostgreSQL 仓储、事务与迁移适配 |
| `process-runtime` | 严格进程配置、信号、排空、关闭和健康状态语义 |
| `prompt-builder` | 可审计、可复现的系统提示词组装 |
| `context-policy` | 上下文选择、截断和压缩策略 |
| `tool-router` | 工具鉴权、路由、审计和错误归一化 |
| `sandbox` | CubeSandbox 厂商 SDK 适配 |
| `workspace` | Thread 私有工作区及版本快照 |
| `resource` | 跨 Thread 资源和不可变版本 |
| `artifact` | Agent 明确发布的最终交付物 |

应用依赖共享包时，必须通过 pnpm Workspace 依赖显式声明，不能使用跨目录相对导入。共享进程包不拥有业务依赖，也不提供测试 Fake 作为生产默认值；测试夹具与其消费方共置。

## 配置安全

- 真实 `.env` 只保存在开发者机器并由 Git 忽略。
- 新增或删除 development 环境变量时，必须同步修改 `.env.example` 和 `scripts/env-contract.mjs`；production 变量必须同步修改 `deploy/production.env.example` 和 `scripts/production-env-contract.mjs`。跨环境共享变量两套契约都要更新。
- 示例中的数据库密码、访问密钥、模板 ID、模型地址和模型 ID 必须保持为明显占位值。
- CI 的工程基线任务只使用 `.env.example` 执行静态 Compose 展开；独立的 Ubuntu M4 黑盒 Gate 会连接 CI PostgreSQL service，运行真实 HTTP、RLS、Dispatch、Worker 与 Pi adapter（Faux Provider）纵向链路。该 Gate 不连接 MinIO、真实 CubeSandbox 或外部模型服务。

服务进程先用各应用的 `select*ProcessEnvironment` 从 `process.env` 投影声明键，再严格解析。禁止把完整宿主环境直接交给解析器，也禁止为缺失的 `RUNTIME_ENV` 回退到 development。API 的 `DEV_AUTH_ENABLED=true` 只允许 development/test；生产环境必须使用真实身份装配器。配置错误只记录变量名与稳定分类，不能记录值。

## 进程启动与关闭

`runtime-ts/apps/api` 在 `RUNTIME_ENV=development`、显式启用开发身份时可选择内建的开发装配：它打开真实 PostgreSQL Repository 和 HTTP listener，可用 `pnpm dev:api` 启动。迁移后先显式执行 `pnpm dev:identity:provision`，该命令幂等创建配置的两个 User、个人 Tenant 和 owner Membership；服务启动本身绝不写入授权数据。该装配和初始化命令都不支持 production，也不会退化到内存 Fake。

### 管理员 Skill 上架

一般 Skill 由 `admin-control-api` 与 `admin-web` 组成的后台管理面上架。管理员上传包，经确定性校验后预览，再直接发布。页面通过 `GET /v1/admin/skill-submissions?latestOnly=true` 展示每个 `canonicalKey` 的最新申请；服务端先按 `(created_at,submission_id)` 选出该技能最新上传，再按游标分页，publisher 不参与技能身份分组。省略 `latestOnly` 保留旧全记录列表。

管理员可以直接发布 `draft`、`submitted`、`approved`，publisher/reviewer 不能发布。旧提交和复核接口保持兼容，原自审限制仍约束真实复核操作；直接发布不制造审核动作或审核者，已审核申请的证据保留。`rejected/revoked` 申请不原地恢复，管理员通过“上传更新”创建新申请；新包尚未发布时，原已发布目录和安装继续有效。

创建请求可省略 `version`，服务端根据操作者与幂等键生成稳定内部标识；显式版本继续兼容旧调用方。页面不展示版本、令牌或推荐选择，发布自动设为推荐，新安装使用推荐包，已有安装仍固定精确版本。撤销确认说明该内容不能继续执行，当前推荐包撤销后停止新安装；原因可省略，审计仍记录真实操作者与状态变化。

每次写请求继续使用独立幂等键，状态推进携带内部 `expectedVersionToken`。409 表示持久状态已改变，应显式刷新后再操作，不能悄悄更新并发检查值重放。Schema 允许直发记录没有审核者，approved/rejected 仍保留真实审核证据；不得为直发记录补造审核者。

开发环境准备顺序如下：

1. 由 Database Admin 创建与 Runtime/Migrator 互异的 `DATABASE_SKILL_PUBLISHER_ROLE` 登录角色。该角色必须
   `NOINHERIT`，不能拥有任何角色成员、数据库/Schema/关系/routine ownership、`CREATE` 或 `TEMPORARY`；只授予
   目标数据库 `CONNECT`。把它的连接串写入忽略的 `.env` 中的 `SKILL_PUBLISHER_DATABASE_URL`。
2. 为发布服务配置独立的 `SKILL_PUBLISHER_S3_*` 凭据；该凭据不能复用普通 API/Worker 的 S3 身份。执行
   `pnpm db:migrate:up`，迁移会从空 ACL 重建发布角色的精确白名单并验证 Runtime 对管理表零权限。
3. 先执行 `pnpm dev:identity:provision` 创建开发 User。再由受控数据库运维事务向
   `platform_skill_operators(user_id, role, status)` 配置 `publisher`、`reviewer`、`admin`；管理 API 故意不提供
   自助提权路由。本地完整流程可让 `DEV_ADMIN_CONTROL_USER_ID` 对应用户同时拥有 Skill `admin` 与控制面 `admin`；
   职责分离测试应使用不同用户身份。operator 变更必须进入数据库运维审计。
4. 为 Admin Control 准备与其他常驻角色互异的 `ADMIN_CONTROL_DATABASE_URL` 和 `DATABASE_ADMIN_CONTROL_ROLE`。
   统一进程分别验证 Admin Control 与 Skill Publisher 角色，两个连接池不能互换或合并。
5. `.env` 中为管理 API 设置 `DEV_ADMIN_CONTROL_USER_ID` 与至少 16 字符的
   `DEV_ADMIN_CONTROL_TOKEN`。开发 Vite 代理只在服务端注入该 Token，不会把它编译进浏览器静态资源。
6. 在两个终端分别启动：

```powershell
corepack pnpm dev:admin-control:api
corepack pnpm dev:admin:web
```

浏览器访问 `http://127.0.0.1:4173/admin/`。上传包必须包含根级、严格 UTF-8 的 `SKILL.md`，最多 256 个文件、总计
32 MiB、入口最多 64 KiB；界面采集 SPDX 许可证，上游 URL 和不可变 revision 是可选高级信息。未声明兼容性时由
系统固定为 `Agent Skills 标准格式`，未声明上游来源时以规范包 SHA-256 标识实际文件。确定性校验通过后的版本仍
标记为 `restricted`，管理员必须人工检查入口正文、许可证、文件摘要及已声明的来源；它不等价于恶意软件或脚本
行为检测。

选择文件或目录后，管理 Web 会在本地解析 `SKILL.md` 的受限 YAML Front Matter，并自动预填 `name`、
`description`、`license` 以及已显式声明的扩展发布字段。`Proprietary` 声明映射为
`LicenseRef-Proprietary`，完整条款仍以包内声明为准。浏览器无法从本地目录获得可信仓库来源和提交身份，因此来源
字段保持可选，不会被猜测；格式兼容性由系统生成。该预填不替代服务端包校验，边界见
[Skill Runtime](../architecture/skill-runtime.md)。

production 管理服务必须单独注入 `ADMIN_CONTROL_JWT_*`、`ADMIN_CONTROL_DATABASE_URL`、
`SKILL_PUBLISHER_DATABASE_URL` 与 `SKILL_PUBLISHER_S3_*`，且 JWT audience 不能复用普通 API。统一进程共用
listener 与管理身份，但必须保留两套数据库连接池，Skill Publisher 的对象存储客户端只能注入发布 Repository。
静态管理 Web 与 API 由同源身份网关托管：网关必须
剥离浏览器伪造的 Authorization，根据已登录管理会话注入短期管理 JWT。没有该网关时不得把 development Token
或固定生产 Token 写入 Web 构建。完整边界见 [Skill Runtime](../architecture/skill-runtime.md) 与
[后台控制面与运行配置](../architecture/admin-control-plane.md)。

### 平台控制面

模型、记忆、身份、用户治理、聚合统计和 Skill 发布都由同一个 `admin-control-api` 进程提供。进程共用管理身份与监听端口，
但内部继续创建 Admin Control 与 Skill Publisher 两个 PostgreSQL pool，后者还单独持有发布用 S3 凭据；合并的是
进程和 HTTP 边界，不是数据库授权边界。

首次准备开发环境时：

1. 由 Database Admin 创建 `DATABASE_ADMIN_CONTROL_ROLE`，要求 `NOINHERIT`、无角色成员、无对象 ownership、
   无 `CREATE`/`TEMPORARY`，并与 Migrator、Runtime、Skill Publisher、Worker Coordinator、Team Coordinator
   角色互异。将该角色的连接串写入本机忽略文件中的 `ADMIN_CONTROL_DATABASE_URL`。
2. 模型与记忆连接探测直接请求对应 Revision 保存的无凭据 HTTPS 地址，不要求部署域名白名单或重启控制服务。探测仍
   禁止跟随重定向、使用有界超时，模型响应正文也按大小限制读取。`providerKey` 只是平台内部标识，不是 API Key：模型页面不提供该输入，领域入口仍拒绝常见密钥形态，并
   遮蔽、隔离历史异常标识，控制 API 的列表、概览和审计读取投影也只返回固定脱敏占位符。模型密钥由页面一次性写入，
   Admin API 使用平台级主密钥加密后绑定到具体 Provider Revision；页面、控制 API、审计和错误响应只返回
   `credentialConfigured`，不返回明文或密文。记忆凭据仍使用部署秘密引用；一旦密钥曾被误填到普通字段，
   必须在 Provider 侧轮换，不能把响应脱敏视为秘密已经从历史事实中删除。疑似密钥启发式只约束新写入；持久化读取
   继续验证完整配置结构，但必须先允许既有对象键进入受控投影，不能在脱敏前把整次概览读取变成服务端错误。
3. 空安装可通过首次运行页面原子创建唯一初始管理员；已有安装的授权变更仍由受控数据库运维事务向
   `platform_control_operators(user_id, role, status)` 写入 `viewer`、`operator` 或 `admin`。授权事务先锁定 `installation_state` 单行；控制 API 不提供既有安装的自助提权
   路由。日常模型与记忆的一次保存生效均要求 admin；operator 仍可通过旧兼容接口创建草稿和测试。
   模型与记忆的新保存接口和旧发布接口均不以连接测试为启用门禁；兼容探测接口仍可诊断连接，服务端授权与并发检查继续有效，不能以导航或按钮替代。

模型配置以 Provider 为聚合根：一个 Provider revision 可以维护多个模型条目，并指定一个默认模型。管理 Web 左侧列出
持久化 Provider，右侧用同一编辑器处理 Pi 与自定义 Provider；Pi 目录只填入初始模型能力，模型 ID、名称、图片输入、推理、
上下文窗口和最大输出都可修改，也可手工添加目录外模型。页面只启用管理员选中的默认模型，其他条目保持停用，不暗中参与
运行或测试。编辑器只提供“保存并使用”，由 `PUT /v1/admin/control/model-providers/current` 在同一事务中保存并启用；列表保留“使用”和“测试已保存配置”。测试向已保存的默认模型发送受限 `chat/completions` 文本请求，不依赖 `/models`，也不是切换门禁。能力字段位于高级设置，Worker 不会在运行时重新用 Pi 目录覆盖已保存数据。模型页面不展示 Revision 历史或变更原因；
这些仍存在的服务端事实只用于持久化、审计与 Run 快照。后台不可用时仍可浏览 Pi 目录和编辑初始值，但这些内容没有保存、
测试或生效。Worker 以 Run 固定 Revision 中的输入模态、上下文窗口和最大输出作为模型能力事实；模型家族 Profile
只补充请求协议，不使用另一组硬编码能力值覆盖或拒绝已发布配置。

管理 Web 和控制 API 共用 `@hoox/protocol/pi-model-catalog` 的静态快照与查询。生成器从锁定的 `pi-ai` 读取公开目录，只保留已支持的 `openai-completions` 模型；两个运行时消费者不加载 Pi Provider。连接失败或可重试 5xx 可以降级到浏览器快照，401/403 不得静默降级；保存、测试和启用始终由后台完成。目录更新执行 `pnpm admin:pi-catalog:generate`，一致性由 `pnpm admin:pi-catalog:check` 校验。

Worker 通过 `pi-adapter` 直接装配 `pi-ai` 的 `Models`、Provider 和内存凭据，并用 `pi-agent-core` 的 `Agent` 执行受控工具循环。逻辑工作目录固定为 `/workspace`，实际 system prompt 保留固定后缀 `\nCurrent working directory: /workspace`，不使用宿主路径或资源发现。每个内核实例的随机 `sessionId` 跨轮稳定，仅传给 Provider，不进入 prompt。Provider 流默认超时为 300,000ms，重试等待上限为 60,000ms；上层自动重试与自动压缩不启用。内核边界见 [Prompt、上下文预算与模型交互](../architecture/prompt-and-model-io.md#模型绑定)，持久恢复与安全点见 [Thread 连续上下文](../architecture/thread-continuity.md)。

成功 Run 的终态事务仍可登记记忆 Outbox。消费者按 Run 固定配置解析提供方，关闭时以 `skipped` 结束本地消费并释放 claim，保留已有 Provider 事件与提交时间，不伪造成功或计入失败。`skipped` 不参与后续领取、待处理统计和 Tenant 调度；维护成功后正常释放 Tenant 租约。已有积压等待租约到期后自动重领收尾，无需手工改状态。Outbox 消费的通用规则见[持久化与数据库边界](../architecture/persistence-and-database.md#outbox-与后台消费)。

模型与记忆一次保存接口要求幂等键和 `expectedGeneration`，由服务端事务执行授权、generation 比较、不可变配置写入、active 切换及审计；失败不遗留待启用配置。页面保存失败保留输入与原并发检查值，冲突后由管理员显式刷新。记忆保存使用 `PUT /v1/admin/control/memory-providers/current`，独立于后台模型；表单带入当前值并按 `enabled` 显示开启或关闭，Mem0 API Key 支持加密托管与同供应商凭据复用。投影、幂等结果与审计不返回密钥明文或密文。

启用配置会递增全局 generation；首次建立托管模型/记忆快照的 Run 固定对应 revision 与密钥，重试不反查当前 active。运行配置快照允许模型为空及 generation 为零，首次快照也固定未配置的选择；已有空模型快照继续使用部署 `MODEL_*`，不会中途绑定新托管模型。部署回退模型的具体参数仍未持久化，修改其环境变量前应排空在途 Run。独立压缩快照与旧 Run 继承边界见[Thread 连续上下文](../architecture/thread-continuity.md)。

Worker 并发与五项上下文压缩数值参数由后台运行设置优先提供，未保存时采用部署默认；直接保存入口为 `PUT /v1/admin/control/runtime-settings/current`，旧草稿/发布路由不恢复。并发在调度时热读取，失败保留最后有效值。`run_compaction_settings_snapshots` 以 Tenant/Run 复合键保存实际使用的五项压缩参数，Runtime 只有 SELECT/INSERT，管理角色无权读取。变量默认值、生效时机与预算裁剪规则见[配置参考](../reference/configuration.md)。

数据库、角色、JWT、TLS、S3、Sandbox 和监听地址由部署文件管理，没有通用 ENV 写接口。`MODEL_CREDENTIAL_ENCRYPTION_KEY` 只是部署级加密根，不是 Provider 调用密钥。在线配置、凭据加密与 Run 快照边界见[后台控制面与运行配置](../architecture/admin-control-plane.md)，Demo 数据 epoch 见[Demo 持续部署](../operations/demo-cd.md)。

`admin-web` 保留 React 19 与 Vite，使用 Ant Design 统一控件和视觉，通过 React Router 暴露可复制的模块路径，并由
TanStack Query 协调控制面读取、去重和失效。页面按工作台、运营、AI 能力和系统分组，运行配置不在导航中，旧 `/settings` 跳转身份设置。操作审计拥有独立只读入口，展示配置动作与操作者；身份和用户治理审计仍在各自事实表中，尚未汇总到该列表。
现有类型化 API Client 仍是协议适配边界，浏览器路由、菜单可见性和 Query 缓存都不构成授权或审计事实。完整取舍见
[后台控制面与运行配置](../architecture/admin-control-plane.md)。

数据运营页按最近 24 小时展示输入 Token、输出 Token、Assistant 生成吞吐和缓存命中率。Worker 只把未缓存输入、输出、
缓存读取和生成时长原子写入租户隔离的低基数指标账本，不保存 Provider 身份或模型正文；控制服务只能读取跨 Tenant 的
受限聚合视图。development 页面新窗口打开回环轨迹查看器；受控 Demo 构建新窗口打开同源 `/trajectory/`，轨迹 API 由 Demo 管理员 Hoox Session 保护；其他 production 构建不显示该入口。
统计与诊断边界见[运行事件与对话展示](../architecture/run-events-and-presentation.md#诊断数据)。

运营分组下的“运行记录”页（`/runs`，详情 `/runs/:tenantId/:runId`）读取 `GET /v1/admin/control/runs`（筛选 `tenantId`、`status`、`createdFrom`、`createdTo`，预留 `agentDefinitionId`、`agentRevisionId`、`origin`，游标分页）与 `GET /v1/admin/control/runs/:tenantId/:runId?attemptId=`，两者只返回结构与指标。正文由管理员在详情页主动打开，调用 `GET /v1/admin/control/runs/:tenantId/:runId/content?attemptId=`；每次调用都写入正文访问审计，正文只保存在页面组件状态中。权限位、数据库视图与审计边界见[后台控制面与运行配置](../architecture/admin-control-plane.md#run-浏览器与正文访问)。

使用一键开发脚本时，既有 `-IncludeSkill` 兼容开关会启动统一 Admin API 与 Admin Web；默认核心拓扑仍不启动任何
管理服务。

PPTX Skill 宣称预装的 Node.js、`pptxgenjs`、图标渲染和 LibreOffice/Poppler 依赖必须由 Sandbox 模板提供，不能在 Run 内临时安装。开发模板从 `deploy/cubesandbox/agent-sandbox-pptx.Dockerfile` 构建；发布镜像后用 CubeSandbox `Template.build({ image })` 创建不可变模板，并把返回的模板 ID 写入本地 `.env` 的 `CUBESANDBOX_TEMPLATE_ID`。基础镜像使用摘要固定，Node 模块使用精确版本；每次发布使用新的不可变镜像标签，不在既有标签上依赖 `Template.rebuild` 刷新。命令服务会净化进程环境，因此模板同时提供根级 `/node_modules` 解析路径，不能只依赖镜像中的 `NODE_PATH`。旧模板保留到新模板完成真实 `.pptx` 生成及 pause/resume 冒烟后再回收。

`agent-worker` 的 `pnpm dev:worker` 同样仅支持 development：它使用真实 PostgreSQL dispatch、S3 durable observation、CubeSandbox 和 OpenAI-compatible Provider。`AGENT_WORKER_TENANT_ID` 仍严格等于 `DEV_AUTH_USER_A_TENANT_ID`，但只用于启动兼容；个人与团队 dispatch 都会原子唤醒动态 Tenant 控制面。`DATABASE_WORKER_COORDINATOR_URL` 必须使用独立的 `DATABASE_WORKER_COORDINATOR_ROLE` 登录，该角色领取无业务载荷的 Tenant 租约，并通过[双栅栏受限视图](../architecture/agent-definition.md#外部工具快照读取)读取当前 Run 的外部工具快照与密文；其余任务事实仍在 `DATABASE_URL` 对应的 Runtime 角色和 Tenant RLS 内读取。先用 `pnpm dev:worker:check` 执行不常驻、只读的完整 readiness；它会同时检查两个数据库身份，但不会启动 polling 或领取 dispatch。无模型时 Worker 保持运行且不领取任务，后台保存配置后自动恢复。预检对已配置模型使用受限 `chat/completions`；部署回退模型存在时，`MODEL_CONTEXT_WINDOW` 与 `MODEL_MAX_OUTPUT_TOKENS` 仍为严格必填的显式预算。

新增或修改工具必须同时交付模型调用契约与用户展示契约：安全用途或操作对象、真实生命周期、受控失败信息，以及正常/PTC 共用投影。同步维护 `pi-adapter` 展示与错误映射，并测试前端终态、旧事件缺字段和重放一致性；不得从完整参数、源码或输出推断界面摘要。当前字段、失败和兼容边界见[工具调用模式](../architecture/tool-calling-modes.md#用户可见工具信息与错误处理)，

发送给 OpenAI-compatible Provider 的函数参数 Schema 顶层必须明确声明为 `object`。`automation_update` 向 Provider 暴露不含顶层 `anyOf` 的稳定 object 形状，Runtime 再用复用同一组字段 Schema 的严格 action 联合校验必填字段和多余字段；Schema 错误必须返回字段级 `details`，字段值错误、权限拒绝、状态冲突与服务不可用使用不同稳定码。详见[工具调用模式](../architecture/tool-calling-modes.md)。

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
而不是超时。配置与安全边界见 [Sandbox Provider](../architecture/sandbox-providers.md)。

production Worker 使用 `pnpm --filter @hoox/agent-worker start:production`，仅支持 Linux。公开入口固定模块内真实装配，不接受调用方注入的 Fake，且不改写 `runtimeEnvironment=production`；通用 `process-runtime` 只是受信代码的生命周期编排器，不是 JS 进程内调用方 ACL。启动前必须验证 `DATABASE_RUNTIME_ROLE`、部署 Tenant 分片、已配置部署模型的严格元数据和 TLS 端点；任一 `DEV_AUTH_*` 变量（包括 `DEV_AUTH_ENABLED=false`）都会失败关闭。生产装配已经接入持久化 Workspace revision/Artifact 发布闭环，但这不替代真实基础设施验收。

装配器按业务接收顺序实现 `stopAccepting`，将数据库连接池、HTTP listener、消费者和遥测等资源按确定顺序登记。关闭时先停止接收，再等待 `lifecycle.track()` 登记的在途操作，最后串行关闭资源。资源错误只上报稳定名称；库不调用 `process.exit`。部署平台的强制终止宽限期必须大于 `PROCESS_SHUTDOWN_TIMEOUT_MS`。

进程骨架专项校验：

```powershell
corepack pnpm test:process-runtime
corepack pnpm config:check:production
corepack pnpm security:audit:production
```

第一条在 Windows/Linux 运行相同单元与入口测试；后两条校验独立 production 配置契约与生产依赖漏洞。部署必须分片注入秘密：API 使用 PG/S3/JWT/TLS，Scheduler 只使用 PG/Cube，Worker 使用 PG/S3/Cube/模型，不能把共享 env 文件整包注入。仓库不提供生产镜像，部署前仍必须在 Linux 上用最小权限 Runtime 角色、真实 PostgreSQL/S3/CubeSandbox/模型完成 readiness 与[生产就绪说明](../operations/production-readiness.md)中的验收；Web/OIDC 产品身份仍是未完成的外部集成。

## PostgreSQL 角色 bootstrap

业务 Schema 迁移不能替代数据库级 bootstrap。首次准备专用数据库时，由不进入应用进程的 Database Admin 完成以下一次性操作：

1. 创建无 `SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION` 的 Migrator、Runtime、Skill Publisher、Worker Coordinator、Team Coordinator 与 Admin Control 登录角色，并保证六者互异且都没有任何上游或下游角色成员关系；Runtime、Skill Publisher、Worker Coordinator、Team Coordinator 和 Admin Control 必须为 `NOINHERIT`，不能保留可 `SET ROLE` 的成员关系。PostgreSQL 角色和密码属于整个集群，不属于单个数据库；同一集群的不同开发库、预览库和生产库必须使用不同的六角色集合，建议统一加数据库或部署后缀；
2. 从 `PUBLIC` 和六个角色撤销目标数据库的全部权限，再只向六个角色授予 `CONNECT`；Runtime、Skill Publisher、Worker Coordinator、Team Coordinator 与 Admin Control 不得通过 `PUBLIC` 获得 `CREATE` 或 `TEMPORARY`；
3. 创建专用业务 Schema，并只让 Migrator 成为该 Schema owner；Database Admin 继续作为数据库 owner；
4. 确认 Runtime、Skill Publisher、Worker Coordinator、Team Coordinator 与 Admin Control 都不是数据库、Schema、表、序列或 routine owner；Migrator 不是数据库 owner，且只拥有配置的业务 Schema；
5. 分别写入本机忽略文件中的 `DATABASE_BOOTSTRAP_URL`、`MIGRATION_DATABASE_URL`、`DATABASE_URL`、`DATABASE_WORKER_COORDINATOR_URL`、`DATABASE_TEAM_COORDINATOR_URL`、`SKILL_PUBLISHER_DATABASE_URL`、`ADMIN_CONTROL_DATABASE_URL`、六个数据库角色名与 `DATABASE_SCHEMA`。Bootstrap/Migration URL 只用于本地权限集成测试或受控运维；Worker 常驻进程只接收 Runtime 与 Worker Coordinator 两个受限连接，API 只把 Team Coordinator 连接交给团队协作 Repository。

开发数据库完成上述一次性边界后，`pnpm db:roles:bootstrap` 使用 `DATABASE_BOOTSTRAP_URL` 和六个应用连接中的密码，仅创建当前数据库缺失的登录角色并授予目标数据库 `CONNECT`。命令以数据库级 advisory transaction lock 串行化并验证 Database Admin 同时拥有当前数据库和角色管理能力；它不会修改已存在角色的密码、属性、成员关系或 ownership，也不会创建或转移 Schema。任一已存在角色被其他数据库依赖时，命令在创建角色前失败关闭。`pnpm db:setup` 串行执行角色补齐与向上迁移，供两台开发机拉取新增角色契约后各自在本机运行；production 禁止使用该本地补齐命令。

`pnpm db:migrate:up` 会在任何 DDL 前同时验证 Runtime、当前 Migrator、Skill Publisher、Worker Coordinator、Team Coordinator、Admin Control、Schema owner 与精确 `search_path`，并通过 `pg_shdepend` 拒绝任一应用角色被当前集群中的其他数据库依赖。角色缺失与真实跨数据库复用使用不同诊断：前者列出缺失角色并指向 `pnpm db:roles:bootstrap`，后者列出发生复用的角色和数据库。它还会拒绝四个常驻角色的目标 Schema `CREATE`、数据库 `TEMPORARY`、角色继承/成员关系/ownership、Migrator 对无关 Schema 的有效 `CREATE`、额外非系统 ownership、任何 routine default ACL 记录及任何目标 Schema routine。Schema migration、迁移记录、角色定向 RLS policy 重绑定、最小 ACL bootstrap 和结束白名单断言共用同一事务。首版 routine manifest 为空；runner 完全不修改 routine 的全局或局部 default ACL，并在迁移 SQL 后、提交前再次断言目标 routine 集合仍为空，任何 migration 创建 routine 都会整体回滚。bootstrap 从空集合重建五种常驻角色的精确 ACL：Worker Coordinator 全局读取 assignment 并更新 claim 栅栏列，外部工具快照仅经校验当前双栅栏的受限视图读取，不拥有业务底表权限；Team Coordinator 只供 API 团队协作 Repository 使用，在 Runtime 白名单基础上额外获得团队目录及 Membership 授权列的最小权限；Skill Publisher 和动态 Worker policy 始终重绑定到本次显式配置的角色。未来引入函数、过程或聚合前，必须单独设计 manifest 并显式审查 `SECURITY DEFINER`、owner、参数、固定 `search_path` 和调用权限。`pnpm db:migrate:down` 只在 development/test 加显式破坏开关时工作；down SQL、ACL 回收和结束白名单断言同样共用一个事务，任一步失败都整体回滚。down 不修改 routine default ACL，也不会删除角色或回滚 Database Admin bootstrap。

## HTTP API 开发边界

所有 development 常驻入口都会主动读取仓库根 `.env`，并让文件中的显式值覆盖长驻终端继承的同名变量；生产入口仍只接受部署平台注入的环境。开发 API 监听 `API_LISTEN_HOST`/`API_LISTEN_PORT`，未配置时分别为 `127.0.0.1`/`3001`；启动时先探测普通 Runtime 与 Team Coordinator 两个 PostgreSQL 身份，再开始报告 ready。`/live` 只表示 HTTP 进程存活，`/ready` 会实时探测数据库。SIGINT/SIGTERM 先调用 Fastify close 停止接收并排空 handler，再关闭 PG pool；启动中任一步失败也会尽力回收两者。分页密钥环采用 `kid:base64url-key,kid:base64url-key`，每把 key 解码后必须为 32 到 64 字节。开发身份初始化命令复用 Runtime 角色、正式 Tenant Repository、租户事务和 RLS；每个个人租户聚合原子提交，重复执行只接受已存在且 owner/active 关系完全匹配的结果，冲突失败关闭。开发装配不会自动写入身份数据，避免“启动服务”隐式改变租户关系。

`runtime-ts/apps/api` 使用 `createApiApp` 显式注入身份、Repository、时钟、ID、HMAC 游标密钥环和探针等端口。测试用 `Fastify.inject` 而不监听网络端口。`AuthContextResolver` 只返回已验证 principal，之后仍必须用 PostgreSQL Membership 解析 `TenantScope`；不得读取 `x-tenant-id` 构造 scope。游标密钥必须来自密钥管理配置，不能使用仓库内常量；最短 32 字节。codec 必须注入可信时钟、签发 TTL 和最大 TTL；轮换按“先同时读取新旧 key、再切换 active、等待旧 key 签发游标的 `expiresAt` 与最大 TTL 都失效、最后移除旧 key”进行。

`PgThreadCreation` 与 `PgRunDispatchCreation` 分别提供 Thread+初始 Workspace、Run+不可变输入+Dispatch Outbox 的原子 PostgreSQL 适配；两者均以租户事务、成员资格重验、advisory lock 和幂等记录收敛首次并发竞争。COMMIT 响应未知或提交后响应丢失时，只允许按同一 scope+idempotency key+request hash 精确读回，禁止再次写入。只有 `createApiCreateCapability` 同时签发两个原子端口时才注册 POST；签发和 App 创建都会快照能力，运行中替换对象无效。不注入能力时服务保持可读、可归档、可取消且 `/ready` 正常。`ArchiveThreadCommandPort` 已有 PostgreSQL 适配，必须保持 Membership `FOR SHARE`→Thread `FOR UPDATE` 锁序、事务内角色重验和数据库单调时间，禁止退化为 API 层 Repository 读改写。

Runtime 对 Membership 只有 SELECT、INSERT 和恒定 `lock_marker` 的单列 UPDATE，不允许表级 UPDATE，也不允许更新 `status`、`role`、租户/用户关联、ID 或创建时间。`lock_marker` 由 CHECK 约束为 `false`，只用于满足 PostgreSQL `FOR SHARE` 的列权限前提。不得把它改造成业务状态；成员变更只能经独立 Team Coordinator 连接完成，角色分工见[持久化与数据库边界](../architecture/persistence-and-database.md#数据库角色)。

ACL bootstrap 与白名单断言按数据库实际列集合工作。基线之后新增的迁移若引入版本相关 ACL（新表、新列或列级权限），必须同时增加真实 PostgreSQL 的 `最新→上一版→最新` 往返测试。

公开错误中，Schema、超限、畸形 JSON、危险原型键和游标错误统一为 400 `INVALID_REQUEST`；非 `application/json` 的创建请求为 415 `UNSUPPORTED_MEDIA_TYPE`。不能把 Fastify/AJV 的内部错误消息直接返回给客户端。

## 本地 Web 体验 API

本地 Web 开发服务器必须将 `/v1` 反向代理到 API，保持浏览器同源；API 不注册 CORS 插件或通配来源。开发固定身份仅用于回环网络，不能通过 CORS 扩大其可达范围。

`GET /v1/threads/:threadId/runs/:runId/events?after=-1&limit=100` 从 PostgreSQL 的 `run_events` 按 `(attempt_id, sequence)` 读取。`after` 是排他 sequence 游标，响应只包含当前 Run 最新 Attempt 中 sequence 更大的持久化事件，按升序返回，最大 200 条。每项以 `<attemptId>-<sequence>` 形成稳定 `eventId`。当 `kind=agent_event` 且 `payload.type` 位于 RuntimeAgentEvent 的受支持白名单时，`type` 使用该子类型；其他事件或未知 payload 一律令 `type=kind`，并始终保留原始 `kind`。Run 不存在、Thread 不匹配、跨租户或成员关系失效一律为 404；数据库异常为 503，不泄漏 SQL 或事件内部错误。

`GET /v1/threads/:threadId/runs/:runId/artifacts` 只返回已 settled 为 published 的 deliverable；授权 Run 没有发布记录、只有 publishing 或只有 failed 记录时返回 200 空列表。预览和下载端点仅对该列表中的 Artifact 签发最长 300 秒的 S3 URL；签发后再次读取并逐字段确认授权修订及完整固定 Blob 绑定，任一漂移都按 404 失败关闭。BlobStore 适配错误统一返回不泄漏内部消息的 503。`preview` 只为安全 charset 的纯文本、PNG/JPEG/GIF/WebP 和 PDF 生成 inline 响应；HTML、SVG、XML 等主动内容返回 422，但 `download` 仍可使用已净化文件名以 attachment 方式签发。URL、对象键和签名不写入 API 日志或持久化事实。Artifact DTO 在该投影中补充可选 `mediaType` 与 `sizeBytes`，旧的领域 DTO 映射不要求提供它们。

固定开发身份启用时，`S3_PUBLIC_ENDPOINT` 必须使用字面回环地址，并与 API origin 和 Web 的 `http://127.0.0.1:4173` origin 不同；推荐 MinIO 使用 `http://127.0.0.1:19000`。LAN 地址、`localhost`、携带凭据/路径/查询的 public endpoint 均在装配前失败。

## 提交前检查

1. 行为变化有测试。
2. 影响架构边界或兼容性的变化同步更新 `docs/architecture` 中对应的现状文档。
3. 关键边界、不变量和失败语义有必要的中文注释。
4. `pnpm check` 通过。
5. `git status` 中没有 `.env`、构建产物或无关文件。
