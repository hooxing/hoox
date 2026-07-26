# ADR-0024：Artifact 工具授权、ResourceVersion 准备与生产缺口

- 状态：已接受
- 日期：2026-07-26
- 决策者：Artifact Tool 集成实现审阅
- 关联任务：M4 Artifact Tool Router、Pi Session、Run 完成门
- 替代关系：细化 ADR-0004、ADR-0005、ADR-0011、ADR-0021，不替代其结论

## 背景

Artifact 核心已经定义不可变发布、失败修正、完成门和下载授权，但模型尚不能通过受控工具声明或发布交付物。Workspace 文件发布还需要先固定成 ResourceVersion；当前没有 PostgreSQL Artifact Repository、真实 Workspace promotion、HTTP 下载接口和用户界面。

工具协议同时跨越 Pi、Tool Router、Run Worker、Artifact 和 Resource。若模型直接提交 Tenant、Run、双栅栏、对象键或签名参数，就能绕过可信执行上下文；若 Pi 反向依赖 Tool Router，又会形成 `pi-adapter → tool-router → artifact → run-contracts → pi-adapter` 的依赖环。

## 决策驱动因素

- 每次 Artifact 写入都绑定真实 Pi `callId + toolName + canonical argsDigest` 和数据库已消费许可；
- 模型只能选择业务来源，不能构造 scope、capability、对象存储位置或请求头；
- Workspace 文件必须先固定成不可变 ResourceVersion，Artifact 不得指向可变文件；
- 发布失败必须给 Agent 稳定、可修正的结构，未满足 required 时 Run 不能成功；
- 未完成生产依赖时必须拒绝装配，不能用内存 Fake 冒充持久化发布。

## 备选方案

### 方案 A：Artifact 工具直接接 ArtifactService，Workspace 路径由 Repository 解释

接口少，但 Artifact Repository 会被迫读取可变 Workspace，模糊 Resource 与 Artifact 的生命周期，也无法在发布前固定 lineage。

### 方案 B：Tool Router 消费 permit，先经窄端口准备 ResourceVersion，再调用 ArtifactService

授权和数据边界清晰；代价是 Tool Router 需要保存模型原始参数摘要，同时把解析后的 ResourceVersion 纳入 Artifact 命令摘要。

### 方案 C：模型只提交 Workspace 路径，Runtime 自动生成全部 ID 与幂等键

模型参数最少，但 Agent 无法显式表达失败修正的 `new Artifact + replaces`，响应未知后的重放语义也不透明。

## 选择

采用方案 B，并保留模型可见的逻辑 `artifactId`、`replacesArtifactId` 和 `idempotencyKey`：

1. `declare_deliverables` 只接受幂等键和最多 64 个 required/optional 声明。
2. `publish_artifact` 只接受逻辑 Artifact 字段，以及以下二选一来源：
   - 已规范化的安全 Workspace POSIX 相对路径和 Resource 展示名；
   - 已固定的 ResourceVersion ID。
3. TypeBox Schema 全部 `additionalProperties: false`；Tool Router 再拒绝访问器、非普通 JSON、过深/循环值、非 NFC、控制/格式字符、Windows 歧义路径和 UTF-8 超限路径。
4. 模型不能提交 Tenant、Thread、Run、Attempt、claim/workspace fence、permit、capability、object key、headers、Blob 身份或签名 URL。
5. Tool Router 对严格解码后的真实工具参数计算 canonical SHA-256；调用 Worker 的 authorizer 消费一次性 permit，再逐字段比较 `callId`、`toolName`、`argsDigest`、完整 ExecutionScope、claim token/epoch 和 Workspace root/epoch，随后才创建不可伪造的 `ArtifactExecutionAuthorization`。
6. 每个 Pi Session 使用独立 Router，并在进程内拒绝重复 permitId；数据库 Repository 仍是 permit、Attempt 和双栅栏事实的最终校验者。
7. Workspace 来源通过 `ArtifactPublicationResourcePort.prepareImmutableVersion` 准备或解析成 ResourceVersion。该端口只返回 ResourceVersion ID，不返回对象键或存储响应。Tool Router 随后调用 ArtifactService。
8. ArtifactService 分别绑定：
   - 模型原始工具参数摘要，用于 permit 授权；
   - 含固定 ResourceVersion、完整 scope、Artifact 字段和原始摘要的命令摘要，用于持久幂等。
9. Artifact 工具错误只投影稳定码、公开消息和 `correctable`。发布失败明确要求 Agent 创建新 ResourceVersion、新 Artifact，并用 `replacesArtifactId` 连接失败记录。
10. `ArtifactCompletionGateAdapter` 只向 RunWorker暴露 `assertReadyForCompletion`，任何未知依赖错误稳定映射为 `ARTIFACT_NOT_READY`；写能力不进入终态路径。
11. 纯 TypeBox 工具协议和 Pi 工具定义归 `pi-adapter`；Tool Router 单向依赖该协议，Pi 不依赖 Tool Router，从而保持无依赖环。

## 生产装配结论

当前切片只提供协议、授权、路由、Pi/Faux 纵向 Gate 和完成门适配，不宣称生产 Artifact 已可用。生产装配必须显式提供：

- PostgreSQL Artifact Repository，包括声明、发布、replacement、permit/双栅栏复验和完成门查询；
- 真实 Workspace 文件提升/固定与既有 ResourceVersion 授权解析；
- ResourceVersion 到 stable Blob 的真实绑定和 MinIO/S3 存在性检查；
- Artifact HTTP 列表、授权下载、预览接口及用户交付物界面。

上述依赖缺失时 `ArtifactToolRouterFactory` 构造即失败；Faux/内存实现只允许测试显式注入，不从生产入口导出。

## 影响

### 正面影响

- 模型参数无法伪造多租户与执行栅栏；
- Workspace 发布保留不可变 ResourceVersion lineage；
- permit 摘要与真实模型参数一致，同时持久命令绑定解析结果；
- Agent 可以根据稳定错误修正，required 完成门保持关闭。

### 负面影响与成本

- Tool Router 与 ArtifactService 需要同时保存原始参数摘要和解析后命令摘要；
- Workspace promotion 成功但 Artifact 发布因取消或窗口耗尽失败时，可能留下未被 Artifact 引用的不可变 ResourceVersion，后续需由 Blob/Resource 生命周期回收；
- 生产可用仍依赖后续 PostgreSQL、promotion 和 HTTP/UI 切片。

### 安全与运维影响

授权消费后到外部调用仍存在不可消除的物理竞争窗口，继续由短 TTL、一次性 permit、幂等键和持久 readback 收敛，不宣称 exactly-once。模型上下文、Runtime 事件和工具错误均不得包含对象键、签名 URL、请求头或依赖 cause。

## 验证

- Schema 拒绝未知字段、对象键/headers、路径穿越、Unicode 歧义、访问器和超限输入；
- 同形 JSON、错误 digest、跨 Attempt 栅栏、过期 continuation、取消和重复 permit 在业务端口前失败；
- Faux Provider 完成“声明 → 发布失败 → 新版本/新 Artifact/replaces 修正 → 完成门通过”；
- 缺失 required 时完成门稳定返回 `ARTIFACT_NOT_READY`；
- 工具上下文和 Runtime 事件扫描不到对象键、签名 URL 与私有依赖消息；
- 包测试、全仓类型检查、格式/静态检查与 clean-vendor Gate 通过。

## 可逆性与回退

在 PostgreSQL Artifact Schema 上线前，可删除 Artifact 工具注册并保留 Artifact 核心，不产生数据迁移。上线后工具字段可以按版本新增，但不能改变已发布 Artifact、ResourceVersion 和 replacement 的不可变语义；需要破坏性调整时新增工具版本和 ADR。
