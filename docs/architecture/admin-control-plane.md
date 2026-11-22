# 后台控制面与运行配置

本文面向修改后台管理 API、模型/记忆/沙箱/运行设置或 Worker 配置读取的开发者，说明控制面与 Runtime 之间的配置所有权和快照不变量。接口、页面和角色操作细节见[维护者开发边界](../maintainers/runtime-development-boundaries.md#平台控制面)，变量与默认值见[配置参考](../reference/configuration.md)，沙箱配置见 [Sandbox Provider](sandbox-providers.md#后台配置与分配)。

## 边界

- 用户 Web、Skill 发布和平台控制面保持不同的身份与授权边界。统一 Admin API 进程同时承载控制面与 Skill 路由，但内部仍使用 Admin Control 与 Skill Publisher 两套数据库连接，Skill Publisher 另持发布用对象存储凭据；合并的是进程与 HTTP 边界，不是数据库权限。
- 管理请求使用同源 Hoox Session，Admin API 向固定主 API 校验会话与有效管理身份，再按领域角色（`viewer`、`operator`、`admin` 及 Skill 管理身份）授权。浏览器路由、菜单可见性和查询缓存都不构成授权事实。
- 统计面只能读取预定义的跨 Tenant 聚合视图，不获得 Prompt、模型正文、Tenant 业务行或对象存储内容。[Run 浏览器与正文访问](#run-浏览器与正文访问)和[接入管理](#接入管理边界)使用各自独立的受限读取与授权，不能借此访问任意业务表。
- PostgreSQL、对象存储、监听地址、数据库角色和平台根秘密（包括 `MODEL_CREDENTIAL_ENCRYPTION_KEY`）由部署配置提供，不依赖自身管理的动态配置，也没有通用环境变量编辑器。

## 配置是类型化、不可变的事实

- 模型 Provider、记忆、运行设置和沙箱配置都保存为不可变 Revision，带类型校验、审计和全局 generation。保存接口要求幂等键与 `expectedGeneration`，服务端事务完成授权、并发比较、写入、active 切换与审计，失败不留下待启用状态。
- 模型配置以 Provider 为聚合根，一个 Revision 包含多个模型条目和一个默认模型。已保存的输入模态、上下文窗口和最大输出就是 Worker 的模型能力事实；模型家族 Profile 只补充请求协议，不用硬编码能力值覆盖已保存配置。Pi 目录只用于填充初始值。
- 运行设置包含工具调用模式、工具启用名单、并发上限、标题模型引用和上下文压缩参数；未保存时使用部署回退值，页面明确区分推荐值和已保存值。

## 接入管理边界

- API Key 与 Webhook 属于部署方集成配置，只由有效的平台 `admin` 在后台「接入」管理；`viewer`、`operator`、仅有 Skill 管理授权的身份、Tenant Owner/Admin 与 API Key 均无此权限。工作台只面向终端用户，不提供这两类管理入口。
- 页面使用管理员可搜索的空间目录选择目标，展示团队名或个人用户邮箱/名称。默认目标固定为初始化管理员的个人空间，不随当前登录管理员变化；无法解析时不预选。管理员不必成为目标空间成员；服务端在事务中复核平台管理角色与目标空间。跨空间的资源 ID、缺失空间或已删除资源统一返回 404。
- `GET /v1/admin/control/integrations/tenants` 只向有效平台管理员返回空间 ID、可读名称、类型及是否为初始化管理员个人空间；读取通过受限安全视图，不授予 Admin Control 对 Tenant 或用户目录底表的通用读取权限。
- 路由前缀为 `/v1/admin/control/integrations/:tenantId`。`GET/POST /api-keys` 列表和创建，`POST /api-keys/:keyId/rotate` 轮换，`DELETE /api-keys/:keyId` 吊销；`GET/POST /webhooks` 列表和注册，`POST /webhooks/:webhookId/rotate-secret` 轮换密钥，`POST /webhooks/:webhookId/disable` 停用，`DELETE /webhooks/:webhookId` 逻辑删除。用户 API 的 `/v1/api-keys`、`/v1/webhooks` 不提供兼容管理路由。
- 管理操作复用 API Key、Webhook 持久化仓储与现有领域校验；读取和变更均在事务内写入 `integration_admin_audits`，只记录操作者、Tenant、动作、目标 ID 和时间，不写入 Key、Webhook 密钥或密文。审计失败会回滚变更。Admin Control 只获得接入表的必要 ACL 与身份关联的列级权限，不能读取 Webhook 密文、Thread、Run 或 Webhook Outbox。
- API Key 创建与轮换、Webhook 注册与密钥轮换各只在成功响应中返回一次明文，不进入持久回执、查询缓存、日志或错误；页面关闭、离开页面或切换 Tenant 后无法取回，迟到响应不能显示到另一 Tenant。请求失败时先刷新列表核对结果，不自动重试写入。
- Webhook 地址经 Tool Router 校验公网 HTTPS 目标；投递、签名和停用语义见 [Webhook 参考](../reference/webhooks.md)。`WEBHOOK_SECRET_ENCRYPTION_KEY` 只注入 Admin Control 与 Scheduler，主用户 API 和 Worker 不需要该根密钥；未配置时仍可管理 API Key 和读取、停用、删除 Webhook，但注册与轮换密钥返回 503。

## 外部工具注册边界

- 只有有效的 `admin` 能在「Agent → 外部工具」注册 MCP Server、写入或清除凭据、探测、发布、查看批次及其不可变版本、撤销批次。HTTP 单端点声明与 OpenAPI 片段共用导入器，只返回预览；没有 HTTP 发布接口。
- 草稿设置和凭据共享一个 generation；变更必须匹配 `expectedGeneration`。MCP 端点只接受不含用户信息、查询串和片段的 HTTPS 地址；改地址前必须清除已绑定的凭据。凭据独立加密：草稿密文绑定草稿 ID，只在探测或发布时解密；每个发布版本重新加密并绑定自己的版本 ID。管理响应、命令回执与审计不含明文或密文。
- 探测经 Tool Router 检查 HTTPS 目标并逐工具报告。探测（包括发布前探测）共用进程级全局与目标并发上限，并将 initialize、通知及所有分页的响应字节计入单次探测总预算；超预算失败关闭。带凭据时，远端工具元数据若包含凭据原文、反转、URL 编码、Base64/Base64URL 或十六进制编码，探测拒绝该工具且不回显其名称或 Schema。该检测是凭据只写边界的纵深防御，不替代凭据不进入日志、错误及凭据响应的约束。
- 发布不信任浏览器的报告：重新探测，在事务内锁定草稿并复核 generation，再一次写入批次、所有版本（含远端原名和 Schema 摘要）、凭据、成功审计与幂等回执。草稿变化、清单为空或任一工具不合规都不产生部分版本。写命令的幂等键按操作者隔离，同键同请求返回既有结果，同键异请求冲突。发布在探测前写入绑定请求摘要的数据库租约，跨 API 进程协调同键请求；竞争者等候或读取已提交回执。崩溃遗留的租约到期后可被接管，发布事务必须锁定并复核租约所有者，旧执行者不能提交或释放新租约。明确失败释放执行权但保留请求摘要；结果未知保留租约等待对账。探测失败、拒绝或写入异常后按原键及摘要精确读回；若 COMMIT 结果或读回仍不能确认，返回结果未知，调用方必须以相同幂等键查询或重试，不得换键重写。
- 单次探测保留的解析工具对象最多 64 个，整体响应累计字节受同一预算约束。注册、凭据、批次、发布声明、命令或审计数据存在时，迁移拒绝破坏性回退；空库仍允许完整回退与重新升级。
- 撤销对整批生效，不改写版本。Agent 编辑者（`operator`、`admin`）只通过 `external_tool_selectable_versions` 选择版本；视图只含版本 ID、来源、模型可见名称、描述和批次名，不含端点、Schema 或凭据。Agent 草稿保存与发布都在事务内复核来源和可选状态，与撤销互斥；已撤销版本不能再次选入。Runtime 不获这些管理表或视图的访问权。

## 凭据

- 模型与记忆 API Key 是只写字段。Admin API 用平台主密钥经 HKDF 派生 AES-256-GCM 密钥加密，AAD 绑定用途和 Provider；密文可以在同一 Provider 的后续 Revision 复用，不能跨 Provider 搬用。
- 读取投影、审计、幂等响应和错误只返回 `credentialConfigured`，不返回明文或密文。`providerKey` 是内部标识，入口拒绝常见密钥形态。
- 平台主密钥只授予 Admin API 与 Worker，必须稳定并备份；更换会使已保存凭据无法解密。记忆作用域秘密同样不得删除或更换，否则既有用户记忆标识会改变。

## Run 快照

Agent 版本在受理 Run 时固定，见 [Agent 定义、版本与 Run 快照](agent-definition.md)。平台运行配置仍在 Worker 首次解析时固定；Agent 的显式内置工具清单受平台快照的 `enabledTools` 约束。Agent 记忆策略可显式开关或跟随平台设置，任何 Agent 配置都不能启用平台未配置的记忆。固定模型的解析需要按 `providerKey + providerRevision + modelId` 精确定位已保存配置，不能复用“当前 active”解析结果。

新配置不改变已经开始执行的 Run，进程重启后也恢复同一配置：

- Worker 首次为 Run 解析配置时写入平台运行配置快照，固定平台模型 Revision（与其绑定的凭据）、记忆选择（包括“未配置”）、工具调用模式与启用名单；压缩参数另存独立快照。固定模型 Agent 另按自己的 Run Agent 快照解析模型与凭据，不解密快照里的平台模型凭据，也不改变平台记忆的回退条件。
- 同一 Run 的重试、恢复 Attempt 和子 Agent 按已有快照读取配置，不反查当前 active 配置。排队但尚未建立平台运行配置快照的 Run 采用首次解析时的 active 配置，不影响已固定的 Agent 版本。
- 并发上限在调度时热读取，读取失败保留最后有效值；降低上限不取消在途 Run。
- 部署回退模型的具体参数不持久化，修改对应环境变量前应排空在途 Run。

## 首次安装与未配置状态

- 空安装通过首次运行页面在锁定唯一 `installation_state` 的同一事务中创建初始管理员、个人 Tenant、会话与控制面授权。已有管理员（包括禁用状态）即关闭该入口，重启不能重新提权。production 与代理后的初始化需要部署安装令牌。
- Worker 与 Scheduler 在模型或沙箱未配置时继续常驻：数据库、对象存储与角色检查仍是启动门槛，但 readiness 报告未就绪且不领取业务任务。后台保存配置后同一进程自动读取；“配置已保存”不等同远端可用。
- 后台读取或凭据解密失败时失败关闭，不退回旧部署凭据掩盖故障。

## Run 浏览器与正文访问

后台“运行记录”按 Tenant、状态、时间和用户问题关键词浏览 Run，列表显示问题、Thread 标题、Agent、发起用户及调试指标。问题和标题来自 `run_execution_inputs`、`threads` 的只读投影视图；时间线复用 `@hoox/trajectory` 的投影。接口与页面入口见[维护者开发边界](../maintainers/runtime-development-boundaries.md#平台控制面)。

- **管理员直接调试**：有效 `admin` 在列表和详情直接看到用户问题、思考、回复、工具参数/结果与错误；查看问题和标题不会替代正文审计。`viewer`、`operator` 可以查看结构指标，但不会收到问题、Thread 标题或事件正文，正文接口始终拒绝非管理员。
- **正文读取必审计**：每次管理员详情加载、Attempt 切换或刷新正文时，服务端在同一读写事务内以本人身份写入 `admin_run_content_access_audits`（操作者、Tenant、Run、Attempt、时间与事务号），再读取 `admin_run_event_content`。该视图只放行“有效 `admin` + 本事务写入 + 审计号与 Tenant/Run/Attempt 全部匹配”的行；审计写入被 RLS 拒绝时整个读取失败，旧审计号在后续事务中读不到任何行。界面不要求额外点击，也不展示审计操作提示。
- **审计独立保留**：正文访问审计不引用业务行，不阻塞 Run 数据的保留清理，也不随其删除。只有有效 `admin` 能写入或查看该表，Runtime 与 Team Coordinator 对其零 ACL。
- **完整轨迹读取**：逻辑轨迹也受 `run_content.read` 保护。每个 Run/Attempt 分页请求都先写独立访问审计，再通过审计事务限定的目录视图读取 Blob 索引；对象正文只在审计提交后按引用读取。分页在下载前按索引字节数执行 2 MiB 预算，并将 Blob 读取并发限制为 4；超大单事件返回受限占位记录。任何授权、审计、索引或对象读取失败均失败关闭，不输出轨迹正文、秘密或对象键。管理 Web 自动汇总分页；达到 50,000 条或 20 MiB 上限时明确标记汇总仅覆盖已加载部分。
- **授权位置**：菜单和页面路由不参与授权；服务端在每个请求中重新解析角色，数据库视图与 RLS 再独立校验一次。操作者被停用后，列表、结构详情与正文读取均立即失败。
- **来源与 Playground**：Run 目录的 `agent_definition_id`、`agent_revision_id` 与 `origin` 来自持久化快照和 Run 来源列。Playground 运行可在实时 Run 浏览器中查看，但不计入业务运行数、会话数及 Token 指标；个人目录与终端用户路径排除 Playground Thread/Run。
- **耗时与用量口径**：耗时为 Run 创建到最新 Attempt 结束的端到端时间（含排队），未结束时缺省；模型调用次数与 Token 为该 Run 所有 Attempt 的用量账本汇总；工具调用、失败与错误计数只统计最新 Attempt 的持久事件。时间线默认展示最新 Attempt，可切换历史 Attempt。

## 修改检查清单

1. 新增配置项必须有类型、默认值、取值范围和明确生效时机（调度时热读，还是首次快照固定）。
2. 影响已在途 Run 的配置必须进入快照，并验证重试与恢复读取的是快照。
3. 涉及秘密的字段只写不读，投影、审计和日志均不包含明文或密文。
4. 新增读取跨 Tenant 数据的统计必须经过受限视图，不扩大底表权限。
5. 新增会返回 Prompt、模型输出、工具参数或用户输入的控制面读取，必须要求 `run_content.read` 并在同一事务写入访问审计；结构视图新增字段前确认其不是正文。

## Agent 定义与版本管理

后台「Agent → Agent 管理」维护平台所有的 `AgentDefinition`；个人和团队成员只有使用权。读写接口位于 `/v1/admin/control/agent-definitions`，使用控制面会话。`operator` 与 `admin` 可管理 Agent；`viewer` 只能读取已发布过的版本，包括停用或撤销后的历史，草稿 Definition、草稿 Revision 和正文对其不可见。服务端在数据库事务中确认有效角色；管理策略只绑定控制面数据库角色，Runtime 不因调用者也是平台管理员而获得草稿视野。菜单不参与授权。默认 Agent 同样可编辑，无删除接口，控制面连接也没有删除 Definition 的权限。

- 保存编辑会追加一个草稿 Revision，不修改已有版本，也不切换当前发布版本。发布时显式选择草稿；版本差异由两个获授权的不可变 Revision 正文在浏览器比较，列表和历史不返回正文。Operator 指令使用 UTF-8 字节上限且不接受动态模板变量。显式内置工具名单在保存和发布时均受平台当前运行设置约束。
- 长期记忆可跟随平台、启用或关闭；显式启用不绕过平台设置。初始种子 Revision 的历史布尔设置在后台读取时映射为当前显式开关，不改写原始正文与摘要。
- 模型编辑器可选择跟随平台默认，或从已保存的 Provider 版本中固定一个已启用、绑定托管凭据且符合 Agent 引用约束的模型。保存与发布均按精确三元组校验；界面及管理接口不返回凭据。
- 可用范围属于 Definition，不属于 Revision。管理员可选择全部 Tenant 或指定 Tenant ID。变更不需要发布新 Revision；停用时保留已配置范围，重新发布后才恢复该范围内的可用性。
- 写操作使用 `Idempotency-Key` 请求头和 `expectedGeneration`。重复的同一命令返回原结果；相同键用于其他请求、或用过期的 generation 提交不同命令，会返回冲突。Definition 状态、范围、审计与幂等结果同事务提交，失败不留下部分范围或审计。
- 停用阻止新 Run；撤销是不可恢复的独立事实。撤销当前 Revision 时 Definition 也进入撤销状态，不自动回退到历史版本。页面要求确认并填写撤销原因；撤销与停用对 Run 的不同影响见 [Agent 生命周期](../specs/custom-agent-platform.md#43-生命周期)。
