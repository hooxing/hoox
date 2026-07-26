# ADR-0011：Run Worker 双栅栏、ExecutionAttempt 与恢复 Saga

- 状态：已接受（2026-07-26 审查后重写）
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M1-05、M2-05、M5-01、M5-02、M5-03
- 替代关系：替代本 ADR 早期将基础设施中断加入 Run 状态机的方案

## 背景

Run Worker 组合了数据库状态、Pi 模型执行、CubeSandbox 外部副作用、Workspace 不可变版本和 Artifact 完成门。队列只能提供至少一次通知，进程可能在任意 `await` 后消失，外部调用也可能“已生效但响应丢失”。因此，Run 不能承担执行器内部恢复细节，单独的 Run claim 或 Workspace lease 也不足以阻止旧 Worker 双写。

## 决策

### Run 与 ExecutionAttempt 分层

Run 严格复用 Domain 已有六态，不新增 `interrupted` 或其他基础设施状态：

```text
queued → running → waiting → running
                 ├→ succeeded
                 ├→ failed
                 └→ cancelled
```

每次领取创建独立 `ExecutionAttempt`，状态为：

```text
claimed → running → waiting
                  └→ finalizing → succeeded | failed | cancelled
claimed/running/finalizing → recovery_required → abandoned | failed
```

Attempt 同时记录阶段 checkpoint：`claimed`、`cleanup_intent_persisted`、`model_execution_started`、`model_settled`、`workspace_verified`、`finalizing`、`sandbox_settled`、`finished`。Sandbox 可见与 cleanup intent 在同一首笔事务中确认，不保留无法证明已提交的 `sandbox_acquired` 阶段。

基础设施不可用、栅栏丢失、Sandbox UNKNOWN 和事件协议拒绝只影响 Attempt；不能把业务 Run 伪造为 failed。普通 Worker 永远不能直接重领 running Run。恢复协调器必须等双租约过期，再根据 Attempt checkpoint 决定安全失败、人工恢复或放弃；一旦到达 `model_execution_started`，不得自动重跑可能含工具副作用的模型轮次。

### 统一双栅栏事务能力

所有持久副作用统一经过 `ExecutionPersistencePort.mutate`，每个命令都携带：

- tenant、thread、run、rootRun、workspace、baseRevision 的完整复合 scope；
- Run claim token、单调 epoch、expiresAt；
- Workspace writer rootRunId、单调 epoch、expiresAt；
- Attempt expected version、操作幂等键、事件 sequence 高水位。

Mutation 是版本化命令（当前 `schemaVersion: 1`），使用键排序、数组保序的 canonical JSON 计算 SHA-256 `commandDigest`；摘要绑定完整 scope、claim token/epoch、Workspace root/epoch、Attempt/Projection 预期版本及业务 payload，但排除续租时会变化的 `expiresAt`。同一幂等键只接受同一摘要：首次提交、重复提交和响应不确定后的读回，都必须返回同一份不可变 receipt；同一键不同摘要稳定返回 `IDEMPOTENCY_CONFLICT`，不得按“已提交”吞掉。

Receipt 必须逐项证明 Attempt version 恰好 `+1`、事件 sequence 推进量、Outbox 业务键/状态/payload digest、Projection 前后版本/digest，以及 Workspace change digest/前后 head。Worker 只有在 receipt 与本地命令、当前 checkpoint 完全一致时才推进内存状态。RolloutProjection 使用独立 version CAS，不能只依赖 Attempt version 防止旧投影覆盖新投影。

每个 Attempt 只有一条进程内 `DurableOperationLane`。所有 agent event mutation、普通 mutation/readback、permit issue/consume、stop/fence inspect/renew，以及任何读取或推进 Attempt version 的事务，都按进入 lane 的顺序串行执行。命令及 expected version 必须在 lane 回调开始后从最新 context 构造，不能在排队前捕获旧版本。heartbeat 不得绕过 lane；重复 tick 可以复用在途任务或排队，停止时必须先停止生产者，再 drain lane。

真实 Pi 工具调用还增加一层顺序门：PiWorkerSessionFactory 必须先观察到匹配 `callId + toolName` 的 `tool.started`，RunWorker 再把该事件经 lane 提交并取得 receipt，之后工具 authorizer 才能进入 lane。首次 `tool.started` 事件必须在同一事务登记永久 `EffectInvocation`，数据库以 `(ExecutionScope, attemptId, callId)` 建唯一约束并在 receipt 返回原始 callId/toolName；同一 Attempt 内的 callId 绝不释放或复用，重复事件、重复授权或重复签发无论 toolName/argsDigest 相同或不同，都稳定关闭为 `PROTOCOL` 或 `IDEMPOTENCY_CONFLICT`，绝不再次访问 Sandbox。Pi 和 Worker 的内存 gate 只做低延迟前置拒绝，不能删除数据库事实。

permit issue 与 consume 位于同一个 lane 回调，中间禁止 agent event、heartbeat 或其他 mutation 插入；这避免 `tool.started` 推进 Attempt version 后旧许可在 consume 时误判 fence_lost。取消信号在每个排队操作实际开始时重新检查；排在工具许可前的 lease 检查一旦判定失效，后续许可不得签发或消费。

生产实现必须在同一个数据库事务中，用单次数据库 `now` 校验两组租约仍有效，再原子写入事件、Outbox、Attempt、RolloutProjection、WorkspaceRevision 和 Run 状态。应用命令不携带 `occurredAt`、Revision `createdAt` 或终态时间，只提交 lease duration 和已验证内容，所有时间及 deadline 均由数据库生成。

完整 scope 在 Attempt 生命周期内不可变，即使 Revision 已推进，`baseRevisionId` 也不能被 current head 替换。新的 current revision 单独保存在 Attempt checkpoint；claim、inspect、mutation result 与 readback 都必须逐字段校验 tenant/thread/run/rootRun/workspace/baseRevision、Run/Workspace 归属以及 checkpoint current head。禁止为了找回已提交事务而放宽复合键查询。

heartbeat interval 必须小于 lease TTL 的一半。每个 Worker 的 heartbeat 不可重入，`stop()` 必须停止新 tick 并等待唯一在途续租结束；heartbeat Promise reject 也必须触发 stop 与 Session abort，不能形成未处理拒绝。`inspect/renew` 保持 claim token/epoch、Workspace root/epoch 和 running Run 不变，只允许两个 expiry 严格向后推进，且返回的 writerLease 必须与 Workspace fence 完全一致。任一栅栏失效后，旧 Worker 只能中止内存 Session 和做不带业务写入的 best-effort 清理，不能写事件、Revision 或 Run 终态。

模型启动和每次工具调用还必须使用数据库签发、数据库一次性消费的短时 `ExternalEffectPermit`。许可绑定完整双栅栏、Attempt version、effect 类型、`callId`、`toolName`、canonical `argsDigest`、DB issued/expiresAt；重复消费、许可过期或 Attempt version 推进都必须拒绝。模型在 `model_execution_started` checkpoint 后同步 stop/renew，再领取并消费 `model_start` 许可。Tool Router 在每次 Sandbox 工具执行前单独领取并消费 `tool_execution` 许可；消费返回后用本机单调时钟限制 continuation delay，再检查 AbortSignal，下一条语句直接调用 Sandbox，不插入额外 `await`。

该协议封闭了数据库许可与本地调度之间可控的异步窗口，但无法消除“最后一次本地检查刚通过、网络调用刚发出时取消/失联”的物理竞争。此残余窗口由短 TTL、一次性消费、Sandbox 请求幂等键、registry 事实和 cleanup Saga 共同收敛，不能宣称严格 exactly-once。

### WorkspaceRevision 与 Run 终态

Workspace verifier 返回带 tenant/thread/workspace/rootRun/parent head 的 revisionId、objectKey 和 SHA-256 digest 候选，不返回可伪造的 `verified: true`。Worker 只提交 `ValidatedWorkspaceChange` 内容；持久层比较完整 scope、Attempt current head 与 lease epoch，并在事务内调用 Domain `prepareWorkspaceRevision(dbNow)` 生成不可变 Revision 和 CAS 条件。

waiting checkpoint 和 success checkpoint 均由一次 `mutate` 原子完成：

- WorkspaceRevision（若内容有变化）；
- Run `waiting` 或 `succeeded`；
- Attempt 对应状态和阶段；
- 事件高水位、RolloutProjection 和双栅栏释放。

因此不存在“Revision 已提交但 Run success 丢失”的可见半状态。若事务已经提交但响应丢失，Worker 用操作幂等键调用 `readMutation` 读回结果，禁止盲目重提 Revision。

### Sandbox cleanup Outbox / Saga

Sandbox acquire 返回已登记实例后，Worker 在创建 Pi Session 或启动模型前，必须首先持久化带 `armed: true` 的 `sandbox_cleanup` pending intent。`armed` 是 cleanup 行永久且不可逆的事实，不是 pending 状态的临时字段；清理 Outbox 是已证明提交后的事实源：

1. pending 只表示实例已武装，但 consumer 必须等待当前 lease/Attempt 终止；pending payload 不携带 `pause | close`；
2. 调用 settle 前在同一事务把 armed pending 推进为 `started`，并且只在这一步一次性决定 `pause | close`；
3. settle 成功后持久化 `completed`；
4. 结果不确定时持久化 `unknown` 与稳定告警；
5. 状态严格单调：`pending → started → completed | unknown`；调用抛异常时保留 `started`，禁止回退为 `pending`；
6. worker 可在 intent 提交后做同进程低延迟 dispatch，但崩溃恢复和重复消费仍以同一个 Outbox 幂等键为准。

同一个 cleanup 业务键的 `registryId`、`providerSandboxId`、`armedAt` 是不可变身份事实；进入 started 后 disposition 也不可变，任何撤销 armed、伪造 armedAt、pending 预填 disposition 或 started 换 disposition 都必须事务冲突。Receipt 的 cleanup 项和 payload digest 同时包含 armedAt、原始 identity 与 identity digest，并在 started 后包含 disposition；Worker 除核对当前命令外，还必须核对上一份 receipt 的 disposition，防止存储层把已决定的 close 改写为 pause（或反向改写）。

acquire 自身的 UNKNOWN 使用独立 lifecycle-unknown 记录，不伪装成一条已经 armed 的 cleanup 行。该事实直接保存 requestId、可用 sandboxId、实际 TTL、发生阶段和原始不确定事件；即使没有可连接的 Sandbox ref 也不能丢弃。acquire 返回前若取消或超时已经发生，Worker 必须先证明 lifecycle-unknown 事实提交，再决定 Run cancelled/failed；事实无法证明提交时不得抢先写业务终态。若 acquire 已成功登记，但 cleanup-intent mutation 返回 unavailable、response_unknown 且 readback 无法证明 receipt，或 fence_lost，Worker 不能假设 Outbox 已存在；registry 仍必须保留创建事实，Worker 用独立 registry 恢复键执行 best-effort orphan close，并记录原因和 settled/unknown/failed 结果指标。该路径不写业务终态，也不依赖 Outbox consumer。

UNKNOWN 不能自动再次 settle 或创建替代 Sandbox。生产 Outbox consumer 通过 registryId 重新取得句柄并执行同一 Saga。create 期间取消或丢栅栏时，返回后绝不启动模型；registry 必须保留创建请求事实，旧 Worker 只做 best-effort close。

### Pi waiting 恢复

Pi 的本地 Session 文件不是事实源。Runtime 持久化版本化、限长的 `ControlledRolloutProjection`，其中只允许经过审核的 user/assistant 文本和 checkpointId，不允许 Pi 内部 entry、宿主路径或任意工具结果。

waiting 回答到达后创建全新的内存 Pi Session，把 RolloutProjection 注入受控上下文，再用 `prompt(answer)` 真正启动模型。禁止对空 Session 调 `followUp`。Linux Faux Provider 测试必须证明历史投影和用户回答同时进入真实模型上下文，且只发起一次新模型调用。当前端口和测试只证明恢复机制；真实 `request_user_input` 工具生成 waiting、API 回答写入和调度唤醒仍是后续任务，本阶段不宣称产品链路完成。

### stop / fence 检查规则

每个外部副作用前后都设置 stop point，包括 Sandbox create/connect、Pi Session 创建、模型 prompt、Workspace verify、Artifact 完成门和 Sandbox settle。特别地，`model_execution_started` 提交后、prompt 前，以及 settle 返回后、Run 终态事务前必须再次同步检查，后者以取消为优先。持久事务本身在 DB 内检查双栅栏；流式事件转换或持久化一旦拒绝，Worker 原子关闭 event acceptance，已排队事件只 drain、不再 mutation 或更新成功标志，并保存、等待 Session abort Promise 后才开始 Sandbox 清理。

取消和超时可以在双栅栏仍有效、Sandbox 已安全收尾后进入 Domain `cancelled`/`failed`。scope mismatch 或基础设施不可用优先释放 claim、写稳定告警并重试；如果持久层本身不可用，则保留 claim 到期，由恢复协调器接管，绝不猜测业务终态。

### 协议、错误和清理

事件和 Outbox 使用 `schemaVersion: 1` 的联合类型，分别限制为 64 KiB。事件 sequence 来自持久高水位；Outbox 使用业务幂等键。上游异常只映射为稳定错误码，不持久化 Provider、SDK 或数据库私有消息：Workspace verifier 抛错或候选冲突映射 `WORKSPACE_CONFLICT`，Artifact 完成门异常映射 `ARTIFACT_NOT_READY`，Sandbox acquire/settle 异常映射 `SANDBOX_FAILED`，幂等摘要/receipt 冲突映射 `IDEMPOTENCY_CONFLICT`。

`finally` 先用 `Promise.allSettled` 停止 heartbeat 并等待已保存的 abort Promise，再取消订阅和 dispose Session；cleanup intent 已由 Outbox 持久接管，finally 不得把 `started` 回退为 `pending`。

## 放弃的方案

### 在 Run 中加入 interrupted

这会把基础设施恢复细节泄漏到产品状态、API 和领域迁移，并绕过 Domain 转移表，因此禁止。

### 队列单消费者或单 claim

无法处理重复投递、租约过期后的旧 Worker 和 Workspace 双写，因此禁止。

### `verified: true` DTO 与分开的 Revision/Run 更新

布尔值没有领域证明能力，分开事务会产生半提交。改为 Domain prepare 命令和统一双栅栏事务。

### 复用 Pi 内存 Session 并调用 followUp

进程重启后 Session 不存在，空 Session 的 followUp 也不会可靠启动模型。改为持久投影和新 Session prompt。

## 影响

- PostgreSQL 适配器必须同时实现 claim、双租约、Attempt、事件、Outbox、Revision 和 Run 状态事务，不能拆成无事务 Repository。
- Sandbox registry/outbox consumer、真实 request_user_input waiting 链路和 PostgreSQL Schema 属于后续实现，但本阶段端口已固定它们的原子性与幂等契约。
- 流式事件逐条事务会产生写放大；后续可以批量，但不能改变 sequence、大小上限和双栅栏边界。
- `expireWorkspaceLease` 只供恢复协调器在 DB 时钟确认过期后使用，生产 Repository 仍需 CAS。

## 验证与实施记录

- 双 Worker 重复投递、Run/Workspace lease 分别到期和跨 Tenant scope；
- Sandbox create 期间双栅栏丢失，确保不启动模型；
- verify 调用前和返回后丢栅栏、Artifact 返回后丢 claim；
- Revision+Run final 事务响应丢失按幂等键读回；
- settle 调用前事务失败、调用后丢 claim、异常和 UNKNOWN；
- 事件持久化不可用、超大 adapter event、Provider 失败、取消和超时；
- waiting checkpoint/resume、受控 RolloutProjection 和 Linux Faux 真模型序列；
- `model_execution_started` 后 crash 只能进入 recovery_required，普通 Worker不能重领。
- 原始 base scope 精确 readback、模型/settle 两个窄 stop 窗口与 ExternalEffectPermit；
- 事件排队拒绝、await abort、heartbeat reject、DB 统一时间和 cleanup Outbox 回退拒绝。
- canonical mutation digest、不可变 receipt、同键异摘要冲突、Projection version CAS；
- permit 调用绑定/一次性消费/版本推进失效、真实 Pi 连续写读工具组合；
- acquire 后 intent 不可证明时的 registry 孤儿清理与恢复指标、cleanup 身份不可变；
- inspect/renew 身份不变与 expiry 严格推进、heartbeat 非重入并等待在途任务；
- Workspace、Artifact、Sandbox 和幂等冲突的稳定错误码映射。
- per-Attempt lane 下 tool.started→issue→consume→后续事件的严格顺序，以及取消/lease 检查优先级；
- Linux Faux + PiWorkerSessionFactory 真实写文件链路，heartbeat 只能排在 permit consume 之后；
- cleanup pending 无 disposition、armed/armedAt/identity 永久、started disposition 一次决定与 receipt digest。
- acquire UNKNOWN 与取消/超时竞争时事实优先，含/不含 sandboxId 均可恢复；
- EffectInvocation 原子登记、Attempt 级 callId 永久唯一，以及同名/异名/同参/异参重放拒绝；
- cleanup completed/unknown receipt 必须延续 started disposition，伪造 close→pause 时失败关闭。

PG、对象存储、真实 Outbox consumer 和 API 不在本次实现范围；它们必须遵守本 ADR，不能重新引入 Run 基础设施状态或 Pi Session 事实源。
