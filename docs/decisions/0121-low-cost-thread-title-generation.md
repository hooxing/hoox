# ADR-0121：personal Thread 低成本标题 Outbox 与异步目录就绪

- 状态：已接受
- 日期：2026-08-07
- 取代范围：ADR-0120 中“本次不调用标题模型”的后置决定

## 背景

ADR-0120 已实现 personal Tenant 的历史文件虚拟目录，但语义目录和 Web 任务标题仍直接使用浏览器生成的确定性标题。用户明确要求本期补齐低成本标题模型，同时保持两项既有约束：请求级事实不能进入主 Agent 的 system/developer prompt；历史文件目录必须按需暴露，不能为了生成标题读取附件正文或下载 Blob。

标题调用位于用户首条 durable 输入之后，不能阻塞创建 Thread、上传附件或提交 Run。模型不可用、输出不合法和进程崩溃都必须有界收敛；用户未来主动改名时，后台模型不得覆盖用户选择。

## 决定

1. personal Tenant 的首条已接受 `thread_input_receipt` 与 `thread_title_generation_outbox` 在同一事务创建。Outbox 以 `(tenant_id, thread_id)` 为主键，因此同一 Thread 只接受一个首条来源；team Tenant 不创建该事实。
2. 标题生成作为现有按 Tenant 分片 Scheduler 中的独立 consumer 运行，不新建服务。端口、模型适配器和轮询生命周期位于独立 `@cube-runtime/thread-title` 包，后续可在不改变数据与路径契约的前提下拆分部署。
3. 模型请求只包含固定标题指令、受 UTF-8 字节上限约束的首条用户原文，以及最多 20 个附件的名称和媒体类型。不得包含附件正文、历史消息、主 Agent system/developer prompt、工具 schema、签名 URL、Resource ID、Thread ID 或对象存储身份；调用不启用工具和流式输出。
4. 使用独立 OpenAI-compatible 配置 `HISTORY_TITLE_MODEL_*`，允许选择价格更低的文本模型。Provider 不在 Scheduler 启动时探针，避免可降级的标题能力阻断 Sandbox 清理等核心循环；远端故障通过 Outbox 有界重试处理。
5. 模型必须返回严格单字段 JSON `{"title":"..."}`。标题执行 NFKC、空白、路径危险字符、时间前缀、Unicode 字符数和 UTF-8 字节数校验；错误正文和完整模型请求不写数据库或日志。
6. claim 使用 token、generation、lease 和数据库 CAS。模型成功后仅当 `threads.title_source='deterministic'` 且 `title_generation_version` 仍等于 Outbox 快照时更新标题；否则标记 `superseded`，不得覆盖 model/user 标题。
7. 首条附件在标题 pending 时仍建立稳定历史文件关系，但语义目录使用不会被 Agent 枚举或解析的内部 `pending-<threadId>` 名称。模型成功、被用户标题取代或达到最大尝试次数后，在 Tenant 级命名锁内一次性分配时间语义目录并切换为 `ready` 或 `fallback`。
8. `/thread-files` 不受 pending 状态影响，当前任务仍可立即读取附件；`/history` 只枚举和解析 `ready/fallback`，因此 Agent 永远不会看到内部 pending 名称。
9. 只持久化模型 ID 的 SHA-256、延迟、token 数和稳定结果类别，不持久化模型名称、API Key、完整请求或响应。模型 ID 哈希用于低基数运维统计，不作为授权或幂等身份。
10. 功能由 `HISTORY_TITLE_GENERATION_ENABLED` 控制。API 仅在历史文件系统与 V2 输入路由同时启用时接受该开关；Scheduler 启用时必须提供独立模型配置，并要求 claim lease 至少覆盖模型超时和 5 秒写回余量。

## 备选方案

### 同步生成后再提交首条消息

拒绝。它会把低优先级模型延迟和可用性放到用户主路径，并使附件上传成功但 Run 未创建的失败窗口更复杂。

### 直接复用主 Agent 模型与完整上下文

拒绝。成本更高，也会把请求级目录事实带入主模型上下文，降低缓存命中并扩大数据披露面。

### 先暴露确定性目录，模型完成后直接重命名

拒绝。模型历史消息、正在运行的 Sandbox 和 WebDAV 缓存可能继续引用旧路径。pending 目录在首次公开前完成命名，避免本期引入路径别名协议。

### 立即拆为独立标题服务

暂不采用。当前吞吐不足以抵消部署、鉴权、可观测性和故障域复杂度；独立包和 Outbox 已保留后续拆分边界。

## 影响

### 正面影响

- Web 任务标题和历史目录获得同一模型生成的语义标题；
- 主 Agent prompt 与工具 schema 继续保持字节稳定；
- 不下载未读取附件 Blob，标题成本只与一段受限文本和附件元数据有关；
- Provider 故障不会阻断 Run，最多按配置尝试后确定性 fallback；
- claim fencing、CAS 和 pending 隐藏避免重复调用写回或半命名目录被公开。

### 成本与限制

- 每个新 personal Thread 最多产生配置次数的低成本模型调用；网络超时或 Scheduler 崩溃可能导致同一 attempt 的重复远端调用，但数据库写回仍由 fencing 保证至多一次生效；
- Scheduler 仍按单一 `SCHEDULER_TENANT_ID` 消费，跨 Tenant 编排不在本期范围；
- 已有 fallback 历史目录不回填、不重命名，避免破坏已经暴露的路径；
- Web 当前通过既有 Thread 列表读取最终标题；更实时的推送或专用状态事件仍可后续增加。

## 安全与隐私

- 标题 Provider 凭据只进入 Scheduler 声明环境，不进入 API、Worker、Sandbox 或模型 prompt；
- 附件只传名称和媒体类型，不传正文、对象键、签名 URL 或内部身份；
- Provider HTTP 错误统一收敛为稳定类别，禁止把响应正文写入错误或日志；
- Outbox、Thread 和历史目录均使用 Tenant RLS，team Tenant 不参与个人标题流程。

## 验证

- 标题包单元测试覆盖严格 JSON、路径清理、时间前缀拒绝、输入截断、无工具请求、Provider 错误和 consumer 成败分支；
- 迁移测试覆盖单 Thread 主键、receipt 来源、claim fencing、RLS、pending 状态和安全 down 门禁；
- API/Scheduler 配置测试覆盖依赖关系、独立模型配置、HTTPS 与 lease 余量；
- Persistence、API、Scheduler 类型检查和相关进程测试作为本地门禁。

## 回退与可逆性

先停止 API 创建新 Outbox，再让 Scheduler 将既有 `pending/claimed` 条目收敛为成功或 fallback，确认不存在 `naming_state='pending'` 后关闭 Scheduler 标题循环。0035 down 会在仍有 pending 目录时拒绝执行，防止把内部名称误暴露为普通 fallback 目录。Outbox 删除不影响 ResourceVersion、Blob、Thread 输入或已经就绪的历史路径。
