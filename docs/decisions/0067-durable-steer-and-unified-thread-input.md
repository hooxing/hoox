# ADR-0067：Durable Steer 与统一 Thread 输入协议

- 状态：已接受（阶段 3）
- 日期：2026-07-31
- 决策者：用户确认按实施总计划推进阶段 3
- 关联任务/PR：阶段 3 durable steer 与统一输入 API；ADR-0063、ADR-0064
- 替代关系：不替代 `/runs` 的 follow-up 兼容入口；收窄 waiting answer 为后续显式能力

## 背景

阶段 1 已建立 Thread 单写者、持久 follow-up FIFO 和激活时基线绑定，阶段 2 已建立 Thread Context 事实流与跨 Run 读取。但运行中的补充输入仍只能创建新 Run，无法作为真实用户消息进入当前 Run；Pi 的进程内 `steer()`/`followUp()` 又不能承担数据库幂等、崩溃恢复和 terminal 竞态。

[Thread 连续上下文实施总计划](../plans/thread-continuous-context.md) 要求统一输入入口、durable receipt、安全点 steer，以及结束竞态原子转 follow-up。本 ADR 只确定阶段 3 输入路由与消费边界，不实现 compaction、waiting answer 或 Sandbox 跨 Run 复用。

## 决策驱动因素

- API 成功前必须保存不可变输入，进程崩溃不能丢失；
- steer 必须以真实 `user` 角色进入 Provider history；
- 输入不得插入 assistant tool call 与对应 tool result 之间；
- terminal/cancel 与输入并发时只能 steered、queued 或明确 rejected 三选一；
- `/runs` 旧客户端仍固定为独立 follow-up；
- expected Run/Turn 不匹配必须返回稳定结果，不能猜测目标。

## 备选方案

### 方案 A：API 直接调用活跃 Worker/Pi Session

延迟最低，但数据库不是事实源，Worker 重启、网络断开或用户取消会丢失输入，也无法与 terminal 事务线性化。

### 方案 B：把所有补充都创建为 follow-up Run

可靠且已具备，但无法及时纠正当前任务，也不满足阶段 3 的 steer 产品语义。

### 方案 C：持久 receipt + Thread writer 安全点消费（选择）

API 先在 execution head 的短事务中决定 `pending_steer`、`queued` 或 `rejected`。Worker 只在完整模型 turn 和工具配对完成后，以 writer fencing 把 receipt 与真实 `user_message` 原子提交；terminal 事务把尚未应用的 receipt 原子转为 follow-up 或拒绝。

## 选择

1. 新增 `POST /v1/threads/:threadId/inputs`。`mode` 为 `auto | steer | follow_up`；显式 `steer` 必须提供 expected Run/Turn，只有 `fallbackToFollowUp=true` 才能改变为 follow-up。
2. 每个请求先写不可变 `thread_input_receipts`，并分配 Thread 级 `input_sequence`。receipt 保存原文、摘要、requested mode、expected/target 身份、fallback candidate Run ID 和最终 disposition。
3. `thread_execution_heads.active_turn_id` 在 Run 激活时设置为由持久 `turn_ordinal` 派生的稳定 ID；它不是 Worker Attempt ID。expected Run/Turn 只与锁定后的 head 比较。
4. `auto` 仅对 `running` 的 regular active Run 产生 `pending_steer`。waiting、无 active Run 或不可 steer 阶段直接成为 follow-up；`auto` 不猜测 waiting answer。
5. Worker 不在 Provider stream 中抢占或向 Pi 预排内存消息。完整 assistant/tool turn 收敛后才从数据库采样 pending receipt；在下一次 Provider 请求前先提交 steer user fact 与 receipt `steered`，再以同一 Pi Session 继续当前 Run。最初的单条采样粒度已由 [同一安全点批量接纳 Durable Steer](20260817151138-safe-point-batched-durable-steer.md) 细化为快照内有序批次。
6. Thread Context append 和 receipt `steered + applied_context_sequence` 使用同一个 Runtime mutation 事务。重复消费按 receipt/append 幂等键读回，不再次插入 user message。
7. terminal/cancel 事务锁定同一 execution head。尚未应用的 `auto` 或允许 fallback 的 steer 按 `input_sequence` 各创建一个 queued Run；不允许 fallback 的显式 steer转为 `rejected`。输入不能同时 steered 和 queued。
8. 显式 `follow_up` 及旧 `/runs` 都保持“一条输入、一个 Run、一个 FIFO queue item”。不调用 Pi `followUp()` 充当跨 Run 队列。
9. 新增 receipt 读取和 disposition 事件投影。事件只包含稳定 ID、模式、disposition、sequence 和拒绝码，不包含正文、writer token 或 Provider 身份。
10. waiting answer 本阶段不开放；`resuming` disposition 保留为后续协议项，不在实现中伪造。
11. `queue_sequence` 与 `turn_ordinal` 取该输入的 `input_sequence`；被 steer 消费的输入留下合法空洞。这样 terminal fallback 不会被更晚到达的显式 follow-up 反超。

## 安全点

阶段 3 首版安全点满足：

- 已形成完整 assistant turn；
- 该 turn 的全部 tool call/result 已完成配对；
- 下一次 Provider 网络请求尚未发出；
- 未开始 Workspace verify/publish；
- 当前 Thread writer fencing 仍有效。

任何一步不能证明时，receipt 保持 pending，由 terminal 转 follow-up或后续 writer 重试；不得先把正文仅写进内存 Session。

## 数据与迁移

- `0023_thread_input_routing` 扩展 receipt 为多 disposition，增加 `input_sequence`、expected/target/fallback 身份和事件表；
- 既有 follow-up receipt 以原 queue sequence 回填 input sequence，既有 disposition 不改变；
- 新字段与事件表均受 Tenant 复合外键、RLS 和受限角色 ACL 约束；
- 任一 receipt/事件存在时 down migration 拒绝破坏性回滚。

## Feature Flag 与兼容

- `THREAD_INPUT_ROUTING_V2_ENABLED` 默认关闭，并依赖 serial queue、Thread Context write/shadow/read；
- 首版不引入轮询间隔永久参数：Worker 在既有完整 turn 安全点读取数据库；未来若增加通知或流内采样，延迟参数必须另行配置和观测；
- 关闭开关后统一输入路由不可用，旧 `/runs` 继续固定 follow-up；已存在 pending receipt 仍由兼容 Worker/terminal drainer 收敛；
- Web 在统一入口不可用时回退 `/runs`，不会把旧入口误当 steer。

## 验证

- API 幂等同载荷重放、异载荷冲突、expected Run/Turn mismatch 和 waiting 不猜测；
- Provider stream、工具执行、terminal、cancel 四类竞态不丢失、不重复；
- Thread Context 中 steer 是一个真实 user fact，Provider wire messages 中角色为 `user`；
- 多条显式 follow-up 各自创建 Run 且 FIFO；
- receipt applied 后崩溃重放不会再次追加 context；
- RLS、跨 Tenant、迁移 up/down/up 和受限角色 ACL Gate。

## 可逆性与后续边界

线上回退先关闭新输入入口，保留 receipt、事件和 Context facts，并继续 drain 已接受输入；不通过 down 删除生产事实。阶段 4 才实现 Runtime compaction，阶段 5 才改变 Sandbox terminal/handoff 生命周期。waiting answer 的最终协议、stream interrupt 和通知机制需要新的 ADR 或本 ADR 的替代决策。
