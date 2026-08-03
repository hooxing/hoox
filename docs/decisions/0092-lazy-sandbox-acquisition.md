# ADR-0092：按附件与工具信号延迟创建 Sandbox

- 状态：已接受
- 日期：2026-08-03
- 决策者：Runtime 维护者
- 关联任务/PR：避免纯模型对话创建空闲 CubeSandbox
- 替代关系：补充 ADR-0084；替代既有 Run Worker 将 Sandbox acquire、Workspace materialize 作为模型启动前必经阶段的实现结论；不改变 ADR-0069 的 Thread Sandbox lease、handoff 与终态 effect 约束

## 背景

Agent Worker 当前在 Pi Session 和首次模型请求之前固定 acquire Sandbox、持久化 cleanup intent 并物化
Workspace。即使用户只问候、请求解释，或者信息不足而模型先向用户追问，Runtime 也会创建一个最终未被
使用的 Sandbox，并在终态执行 verify 与 settle。

Pi Session 的工具 schema 必须在首次 Provider 请求前固定，但工具存在不代表执行环境必须已经存在。上传的
普通文件需要 `/resources` 文件系统；支持直接视觉输入的图片可以从 Blob 读取并直送 Provider。文件和命令
工具则只有在模型真实调用后才需要 Sandbox。

## 决策驱动因素

- 纯文本回答、思考和追问不应消耗 CubeSandbox 配额与启动延迟；
- 工具 schema、system prompt 和 capability manifest 必须保持稳定，不能按请求动态增删工具；
- 非图片附件在模型开始处理前必须已经能够通过 `/resources` 访问；
- Sandbox acquire、cleanup intent、Workspace materialize 和 Thread lease attestation 仍须保持失败关闭；
- 短时 `tool_execution` 许可只能在耗时的 acquire/materialize 完成后签发；
- `tool.started` 和 durable tool_call 必须先于工具触发的 Sandbox 生命周期副作用。

## 备选方案

### 方案 A：维持每个 Run eager acquire

实现简单，Session 始终持有具体 `SandboxHandle`，但所有纯模型请求都会产生无效资源消耗。

### 方案 B：根据用户文本在模型前分类是否需要 Sandbox

可以提前创建，但分类器会把请求级意图引入新的事实源，也无法准确预知模型会先追问还是调用工具。

### 方案 C：固定注册工具，由附件和真实工具调用按需准备 Sandbox

Session 只持有窄的 `ensureSandboxReady` 能力。普通附件在输入准备阶段触发；全部可直送视觉模型的图片不
触发；工具在 `tool.started` 持久化后、短时副作用许可签发前触发。并发触发共享同一个 Promise。

## 选择

采用方案 C：

1. Run claim 后先创建 Pi Session 和提交 `model_execution_started`，不 acquire Sandbox。模型可直接回答或
   追问。
2. 当前 user turn 没有附件时不触发；视觉模型成功直读全部附件图片时也不触发。只要存在未被直送的附件，
   `prepareInput` 就调用 `ensureSandboxReady(reason=attachment)`，在 Provider 请求前完成 acquire 和 materialize。
3. `exec_command`、`read`、`edit`、`write` 和 `deliver_file` 的 schema 始终注册。合法工具调用先形成 durable
   `tool.started/tool_call`，再调用 `ensureSandboxReady(reason=tool)`，最后签发并立即消费 `tool_execution`
   许可。
4. Schema 非法的工具调用只形成失败回执，不创建 Sandbox，也不申请副作用许可。
5. 首次触发执行 acquire、cleanup intent、Workspace materialize 和可选 Thread lease attestation；所有后续
   触发复用同一 `SandboxSessionRef`。同一 Run 的并发触发使用 single-flight，禁止创建多个 Sandbox。
6. cleanup intent 是与主执行阶段正交的生命周期事实。按需 acquire 发生在 `model_execution_started` 后时，
   intent mutation 不把 Attempt stage 回退到 `cleanup_intent_persisted`。
7. 模型 settled 后，只有实际创建过 Sandbox 才执行 Workspace verify，以及 close、pause、handoff 或
   Thread terminal effect。未创建 Sandbox 的成功 Run 直接经过无 Sandbox finalizing checkpoint，并提交
   `workspace_unchanged` 终态。
8. acquire、materialize、attest 或 intent 持久化失败继续使用既有稳定错误码与孤儿清理协议；已经获得的
   Sandbox 不得因 Session 已提前创建而逃逸 cleanup。

## 理由

方案 C 以真实能力使用作为资源边界，不要求 Runtime 猜测模型意图。固定工具清单保持 Provider 缓存与恢复
兼容身份稳定；在许可前准备 Sandbox 又避免长耗时初始化消耗一次性许可窗口。附件和直接图片的分流复用现有
Blob 图片加载边界，既满足普通文件可访问性，也避免图片对话创建不必要的文件系统环境。

## 影响

### 正面影响

- 问候、解释、纯文本生成、信息不足时的追问均为零 Sandbox Run；
- “创建文件”类请求可以先由模型思考，直到首次写入或执行工具时才付出启动成本；
- 支持视觉输入的纯图片请求继续直接使用 Blob，不创建 Sandbox；
- Sandbox 工具名称、schema 和 Prompt capability manifest 不随请求改变。

### 负面影响与成本

- 首次文件或命令工具调用会承担 acquire 与 materialize 延迟；
- SessionFactory、Pi 工具和 deliver_file Router 从具体 handle 改为按需能力，状态协调复杂度增加；
- acquire 故障现在可能发生在活跃模型工具循环中，必须先持久化失败回执再中止 continuation；
- Attempt 的主阶段不能单独表达 Sandbox 是否存在，恢复诊断需要结合 cleanup outbox 与 Thread Sandbox
  lifecycle 事实。

### 安全、数据与运维影响

- Pi 默认宿主工具仍全部禁用，按需能力最终只返回当前 Run 绑定的 CubeSandbox handle；
- 工具触发顺序固定为 durable 前驱、Sandbox 准备、短时许可、立即副作用；
- 不新增数据库 Schema。既有 cleanup outbox、Thread Sandbox lease 和 Workspace journal 继续作为事实源；
- 原始上传 Blob 与直接图片仍不进入 system prompt、长期 Thread Context 或宿主文件系统。

## 验证

- Run Worker 测试证明纯文本成功、纯模型失败和 waiting 路径均不会 acquire、materialize、verify 或 settle；
- Pi Worker 测试证明视觉模型直读全部图片时零 Sandbox，文本模型附件在模型许可前 acquire；
- 真实 Pi 工具循环测试证明首次 `exec_command` 才 acquire，多个工具调用只 acquire 一次；
- 故障注入继续覆盖 acquire UNKNOWN、cleanup intent 未提交、materialize/verify 失败、取消、超时、lease 丢失、
  settle UNKNOWN 与 Thread Sandbox handoff；
- 执行受影响包的格式、lint、typecheck 和测试。

## 可逆性与回退

本变更没有数据库迁移。可在新 Run 边界恢复 eager acquire，并把 SessionFactory 重新绑定具体 handle；已经完成
的无 Sandbox Run 只留下正常模型与 `workspace_unchanged` 事实，不需要数据回写。回退不得改变活跃 Attempt 的
执行方式，必须通过停止旧 Worker、完成恢复审计后滚动发布。

## 后续工作

- 为 Sandbox 使用率、首次触发原因和 acquire 延迟增加脱敏指标；
- 评估将不可变文本资源直接通过 ResourceStore 工具读取，进一步减少只读附件对 Sandbox 的需求；
- 如果恢复诊断需要独立查询 Sandbox 使用状态，再引入正交 `sandbox_state` 投影，不复用线性 Attempt stage。

## 实施记录

- 2026-08-03：完成附件/工具触发、直接图片豁免、single-flight acquire、无 Sandbox 终态和回归测试。
