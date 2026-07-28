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
5. `pause/connect/create/materialize` 为 UNKNOWN 时进入显式恢复路径，不自动重试，不伪造成功事件。
6. PostgreSQL 实现以 checkpoint 唯一键和 CAS 签发单一恢复权。胜者在同一持久提交中记录 `sandbox_reused` 或 `sandbox_rebuilt`；其他 Worker 返回 busy/resolved。
7. 恢复输入只来自 PostgreSQL 与 Stable Blob；Pi Session 文件和 Sandbox 内状态不属于事实源。

## 影响

- 正面：服务重启与换机恢复可重复；跨租户和陈旧实例不会被误用；用户并发修改可见；恢复审计具有确定事件。
- 负面：需要 PostgreSQL checkpoint/CAS 适配器和外部生命周期 Saga；严格复用会增加部分重建。
- 安全：Scope 必须由可信数据库关联获得，客户端不能提交 provider ID、generation 或 expected head。
- 运维：分别监控复用、重建原因、Workspace 冲突、UNKNOWN 和恢复权竞争。

## 验证

- 纯决策契约覆盖 TTL 边界、generation 漂移、用户改文件、四类 UNKNOWN、重启和跨租户。
- Fake CAS 覆盖并发双恢复只有一个确定事实。
- PostgreSQL 适配任务必须补事务竞争、RLS、进程重启及 Stable Blob 校验失败集成测试；完成前不宣称生产 Worker 已装配。

## 可逆性

窄编排核心尚未接入生产 Worker 时可直接移除。开始写入 checkpoint 后，只能通过新增版本迁移替代事件/状态语义，不能改写已有确定事件或 UNKNOWN 审计事实。
