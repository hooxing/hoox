# ADR-0033：waiting 与 SandboxSession 恢复安全边界

- 状态：已接受
- 日期：2026-07-28
- 关联：ADR-0011、ADR-0014、ADR-0022、ADR-0030

## 背景

Run 在向用户追问后进入 `waiting`。用户回答可能在另一进程、另一节点或服务重启后到达。同一 Thread 的 CubeSandbox 也许仍在保温，但 Sandbox 内变量、进程和网络连接都是短暂状态，不能成为恢复正确性的前提；Workspace、Runtime Rollout 与大对象事实分别落在 PostgreSQL 和 Stable Blob。

恢复面临错误复用另一 Tenant/Thread 实例、TTL 或 generation 漂移、用户在 waiting 期间修改 Workspace，以及 `pause/connect/create/materialize` 已发出但结果未知等风险。并发 Worker 还可能对同一 checkpoint 双恢复。

## 备选

1. 永远新建 Sandbox：语义简单，但浪费资源并增加追问后的延迟。
2. 只依据 provider sandbox ID 和 TTL 复用：体验较快，但无法证明 Scope、generation 和 Workspace 基线一致。
3. 以 PostgreSQL waiting checkpoint 为恢复权和决策事实源，在严格匹配时复用，否则重建或冲突。

## 决策

选择方案 3：

1. waiting 安全点持久化 Scope、Rollout checkpoint、Workspace head、base revision，以及可选 Sandbox registry ID、provider ID、generation、暂停时间、到期时间和生命周期结果。
2. warm window 最多十分钟，只有 `now < expiresAt` 有效；恰好到期必须重建。
3. 只有 Tenant、Thread、Workspace、base revision、session generation 全匹配且生命周期明确为 `paused` 时才复用。环境变量、进程和网络连接不参与判定。
4. 恢复前重新读取 Workspace 最新 head。head 改变时，上层若能基于 Stable Blob 重算计划则标记 `replan`；不能重算时返回包含 expected/actual head 的结构化冲突。
5. `pause/connect/create/materialize` 采用 intent/outbox Saga：先在持有有效数据库租约时提交副作用 intent，再调用外部系统，成功后才在同一事务线性化 `run_events`、Runtime Rollout 与 checkpoint 决定事实。不能把计划当成已复用/已重建事实。
6. 任一外部调用为 UNKNOWN、或进程在 intent 后崩溃而缺少成功证明时，持久化 UNKNOWN 并停止自动重试；协调器不得重复 connect/create/materialize。
7. PostgreSQL 实现以完整 Tenant/Thread/Run/Workspace/rootRun/baseRevision/checkpoint Scope 和 CAS 签发单一恢复权。租约、TTL 和 reclaim 使用数据库时钟。胜者提交确定事实，其他 Worker 返回 busy/resolved/claim_lost。
8. Workspace head 使用 `found(revisionId)`、`empty`、`unavailable` 三态。waiting checkpoint 只接受 found/empty 严格基线；副作用前必须重新读取，unavailable 不能当成 empty 或 unchanged。
9. 恢复输入只来自 PostgreSQL 与 Stable Blob；Pi Session 文件和 Sandbox 内状态不属于事实源。

## 影响

- 正面：服务重启与换机恢复可重复；跨租户和陈旧实例不会被误用；用户并发修改可见；恢复审计具有确定事件。
- 负面：需要 PostgreSQL checkpoint/CAS 适配器和外部生命周期 Saga；严格复用会增加部分重建。
- 安全：Scope 必须由可信数据库关联获得，客户端不能提交 provider ID、generation 或 expected head。
- 运维：分别监控复用、重建原因、Workspace 冲突、UNKNOWN 和恢复权竞争。

## 验证

- 纯决策契约覆盖 TTL 边界、generation 漂移、用户改文件、四类 UNKNOWN、重启和跨租户。
- Fake CAS 覆盖并发双恢复只有一个确定事实。
- `0012_waiting_recovery` 提供 checkpoint、claim lease 与 effect outbox 事实表，`PgWaitingRecoveryStore` 在受限 Tenant 事务中实现 record/claim/intent/UNKNOWN/resolve。
- 生产 Worker 完整装配和 Stable Blob 内容校验仍是后续任务；完成前不宣称该切片可独立对外服务。

## 可逆性

窄编排核心尚未接入生产 Worker 时可直接移除。开始写入 checkpoint 后，只能通过新增版本迁移替代事件/状态语义，不能改写已有确定事件或 UNKNOWN 审计事实。
