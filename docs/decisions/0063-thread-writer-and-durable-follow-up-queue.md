# ADR-0063：Thread 单写者与持久 Follow-up 队列

- 状态：已接受
- 日期：2026-07-31
- 决策者：用户确认按实施总计划推进阶段 1
- 关联任务/PR：阶段 1 Thread 串行队列与 Run 基线延迟绑定
- 替代关系：重写未接受的 ADR-0063 大草案，仅保留 Thread writer 与队列边界；不替代已接受 ADR

## 背景

当前 `PgRunDispatchCreation` 在每次 `POST /v1/threads/{threadId}/runs` 时立即读取 Workspace head、写入 `run_execution_inputs`，并创建状态为 `ready` 的 dispatch outbox。`PgRunDispatchOutbox` 按 outbox 时间领取，没有 Thread execution head。Workspace write lease 会阻止同一 Workspace 同时写入，但它既不能保证 follow-up 的持久 FIFO，也不能保证同一 Thread 只有一个模型上下文写者；排队 Run 还会过早固化旧的 Workspace base revision。

[Thread 连续上下文实施总计划](../plans/thread-continuous-context.md) 已确定：同一 Thread 最多一个 active Run 和一个 Context writer；follow-up 必须持久、FIFO、逐项执行；Run 只有成为队首时才能绑定 Workspace 与 Context 基线。本 ADR 只冻结这组顺序语义，不决定 steer 安全点、Context 投影或 Sandbox Provider 细节。

## 决策驱动因素

- 输入在 API 重试、Worker 崩溃、Run 取消和 terminal 竞态下不丢失、不重复；
- 同一 Thread 不允许两个 Run 从同一旧上下文并行推进；
- 不在 Provider 调用或工具执行期间持有数据库行锁；
- 下一 Run 必须看见前一 Run 已线性化提交的 Workspace 与 Context；
- 新表必须具备 Tenant 复合外键、RLS、受限角色权限和可验证回滚边界。

## 备选方案

### 方案 A：沿用 Workspace lease 间接串行

改动较小，但多个 Run 仍可同时获得 dispatch，FIFO 不成立，且 Workspace lease 不覆盖 Context append、receipt 消费和 terminal handoff。

### 方案 B：执行期间持续持有 Thread 行锁

顺序直观，但网络和模型调用可能持续数分钟。长事务会放大锁等待、连接占用、故障恢复和 VACUUM 压力，不能接受。

### 方案 C：短事务线性化头 + 可续租 writer fencing（选择）

用 Thread execution head 分配 Turn/queue sequence、选择 active Run，并用 `writer_epoch + token + expires_at` 授予长执行写权。所有关键写入使用短事务锁头行并以 CAS 复核 fencing。

## 选择

1. 每个 Thread 建立一条 `thread_execution_heads`。该行是分配 Turn ordinal、queue sequence、选择 active Run、提升 writer epoch 和 terminal handoff 的唯一线性化点。
2. 长执行不持有行锁。Worker 获得包含 owner、token、epoch、expires_at 的 writer lease；旧 epoch 在接管后不得追加 Context、消费队列、提交 Workspace result 或转交 Sandbox lease。
3. 每个 follow-up 先保存一条不可变 input receipt，再创建一条 queue item 和一个状态为 `queued` 的 Run。每条输入各占一个严格递增的 queue sequence，不合并、不删除队列事实。
4. queued Run 在激活前不得写可领取的 dispatch outbox，也不得固定 `base_revision_id`、Context `through_sequence` 或新的空 `initial_projection`。激活队首时，在同一事务读取最新 Workspace head 与 Context head、写执行输入快照、写 dispatch outbox，并设置 active Run/Turn。
5. 既有 `POST /v1/threads/{threadId}/runs` 在队列能力启用后固定映射为 `follow_up`，保持“一个请求立即得到一个 queued Run ID”的兼容边界；它绝不隐式 steer 当前 Run。
6. Run terminal 时，Workspace result 和 writer fencing 必须先完成。随后在锁定同一 execution head 的事务中激活 FIFO 队首；阶段 1 遇到空队列只清空 active/writer，Sandbox pause intent 留给阶段 5。不得先在事务外判断队列为空。
7. queued 项取消、激活失败和 terminal failure 都通过状态转换保留事实。Run 取消不删除其他未消费 follow-up；无法执行的队首必须形成明确终态后允许下一项前进。
8. writer/queue/receipt 的所有幂等键、唯一约束和查询都限定在 `(tenant_id, thread_id)`，并通过复合外键证明 Run、Turn 和 receipt 的归属。

### 阶段 1 已接受的实施收窄

- 阶段 1 只实现 receipt、follow-up FIFO、execution head/writer fencing、激活时基线绑定和 `run_workspace_results`；不创建 Thread Context facts/checkpoint，不实现 compaction，也不改变 Sandbox 的每 Run acquire/close/pause 路径。
- `thread_execution_heads.context_through_sequence` 是后续 Context writer 的单调 cursor 接口；阶段 1 中 `NULL` 只表示尚无 Thread Context fact。激活事务把当时值复制到 `run_execution_inputs.context_through_sequence`，不把 `NULL` 固化为任何 Context 策略。
- 阶段 1 的 queue claim 与现有 Run claim 共用随机 token 和单调 epoch，并同时写入 execution head 与 queue item。这样现有 `ExecutionFence` 不增加第二套可泄漏 capability；后续 Context append 必须校验同一 writer fencing。
- 队列为空时阶段 1 只清空 active Run/writer；Sandbox pause intent 与跨 Run lease handoff 仍归 ADR-0066 的后续阶段，不能在本阶段提前实现。

首版逻辑 Schema 版本为：

- `thread_input_receipt.schema_version = 1`；
- `thread_follow_up_queue.schema_version = 1`；
- `thread_execution_head.schema_version = 1`。

这些版本不复用现有 Attempt rollout 的 `schemaVersion=2`，两者生命周期和兼容语义不同。

## 核心不变量与线性化点

| 操作 | 必须锁定/复核 | 成功后的唯一事实 |
|---|---|---|
| 接收 follow-up | execution head、幂等键 | receipt + queue sequence + queued Run |
| 激活队首 | execution head、FIFO 队首、Workspace/Context head | active Run + 延迟绑定基线 + dispatch |
| writer 接管 | execution head、旧 lease | 单调递增 epoch 与新 token |
| terminal handoff | execution head、writer fencing、FIFO 队首 | 下一 Run 激活或 pause intent，恰有一个 |
| 取消 queued Run | execution head、queue item | cancelled 状态；不物理删除 |

任何事务失败都不能留下“active Run 已变化但 dispatch/基线未写完”或“receipt 已成功但正文不可恢复”的部分结果。

## 影响

### 正面影响

- 为跨 Run Context、durable steer 和 Sandbox handoff 提供统一顺序；
- Run B 只会在 Run A 完成事实提交后捕获最新基线；
- Worker 接管后旧写者通过 fencing 失败关闭。

### 负面影响与成本

- 每个 Thread 的队列写和激活会在 execution head 上串行；
- 现有“创建 Run 即 dispatch”需要拆为“接受排队”和“激活 dispatch”两个阶段；
- Feature Flag 回退不能简单停止消费者，否则已持久化 queue item 会被遗留。

### 安全、数据与运维影响

- 日志只能记录 tenant-safe 的 thread/run/receipt 内部 ID、queue depth 和冲突原因，不记录正文、writer token 或完整租约；
- writer lease 时长、续租间隔、claim 退避、最大队列深度和正文 Blob 阈值是可配置参数，不在本 ADR 固化数值；
- waiting answer 的统一输入协议仍为待决项，不允许 `auto` 猜测。

## Feature Flag 与兼容

- 新增逻辑开关 `thread_serial_queue_v2`，默认关闭；关闭时只影响新请求入口，已经写入的 V2 queue item 仍必须由兼容 drainer 收敛。
- 进程配置名为 `THREAD_SERIAL_QUEUE_V2_ENABLED`。开关关闭时，没有 V2 queue 事实的 Thread 继续走旧路径；已有 V2 queue 事实的 Thread 拒绝新旧路径混跑，但幂等重放和 Worker drain 继续可用。重新开启即可恢复该 Thread 接收输入，回退不删除事实。
- 开启前执行 legacy drain Gate：目标 Thread 不得存在未进入 V2 queue 的 `queued/running/waiting` Run；代码在首个 V2 写事务中再次失败关闭，防止错误切换制造双 active。
- `thread_input_routing_v2` 依赖 `thread_serial_queue_v2`，但阶段 1 不启用 steer。
- 旧 `/runs` 响应结构保持不变；V2 激活前的 queued Run 读取必须能返回 queued/cancelled，而不能假装已经 dispatch。
- 回退以关闭新入口和继续 drain 已接受工作为主，不删除 receipt/queue/head 数据。

## 验证

- 阶段 1 PostgreSQL Gate 并发提交 100 次 follow-up 和 10 次同键重试，断言 sequence 连续、receipt/Run 不重复、只有一个 active Run 和一个可领取 dispatch；
- 阶段 1 PostgreSQL Gate 断言 queued Run 没有 execution input，前一 Run terminal 后才捕获最新 result revision 与 context through-sequence；
- 阶段 1 PostgreSQL Gate 覆盖双 Worker claim、writer 续租/过期、旧 writer 失败关闭、queued/active 取消、Worker 崩溃安全失败和 FIFO 继续；
- 迁移与既有集成 Gate 覆盖 up/down/up、RLS、跨 Tenant、复合外键和受限角色 ACL；
- Context append fencing 与 terminal/pause/new-input 三方竞态分别留给阶段 2 和 ADR-0066 对应阶段，阶段 1 不以占位实现伪造通过。

## 可逆性与回退

Schema 只新增表、约束和兼容列，不改写旧 Run/Attempt 事实。未写数据时可执行开发/测试 down migration；出现 receipt、queue 或 writer 审计事实后，生产环境不得用 down 作为回退手段。线上回退关闭新入口、保留兼容 drainer，并继续使用旧每 Run 执行路径处理尚未进入 V2 的请求。

## 实施依赖与后续边界

- 阶段 0 的并发事务、数据库时钟和崩溃恢复测试基座是本阶段前置依赖；
- 阶段 1 按本 ADR 实现 execution head、receipt、queue、Run 激活和 `run_workspace_results`；
- Thread Context 读取/写入、steer、compaction 与 Sandbox 跨 Run lifecycle 必须继续按总计划和各自 ADR 分阶段实现，本阶段不提供占位行为。

## 实施记录

- `0018_thread_execution_heads`：建立每 Thread 唯一 head、单 active Run 索引、writer shape、空 head 回填与 RLS；不猜测既有非终态 Run 的顺序。
- `0019_thread_follow_up_queue`：建立不可变正文 receipt、FIFO queue、单 active queue item 和激活时 `context_through_sequence` 快照列。
- `0020_run_workspace_results`：建立 Run 的 base/result/outcome/manifest 关系；`committed` 表示 head 已前进，`unchanged` 只用于成功且 head 未变，失败/取消且未产生新 revision 记录为 `failed_before_commit`。
- `/runs` 在开关开启时先返回 queued Run；只有队首激活事务创建 `run_execution_inputs` 和 `run_dispatch_outbox`。模型输入仍使用旧空 projection，未接入跨 Run Context 读取。
- Worker claim 同时取得 Run claim、Workspace lease 和 Thread writer；heartbeat、外部副作用许可、Runtime mutation、terminal handoff 与安全失败恢复均复核 writer fencing。
- terminal mutation、`run_workspace_results`、queue 终态、清空 writer 和激活下一项处于同一 PostgreSQL 事务；队列为空不触发任何 Sandbox 复用行为。
- 自动化 Gate 覆盖：100 个并发 follow-up 加 10 次同键重试、单 active/单 dispatch、激活时 revision/context 延迟绑定、旧 writer 失效、queued/active 取消、过期 writer 安全恢复、RLS/ACL 与迁移 down/up。
