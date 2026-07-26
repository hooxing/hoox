# ADR-0017：Sandbox Cleanup Outbox 消费与恢复协调

- 状态：已接受
- 日期：2026-07-26

## 决策

Cleanup 的 `pending` 只代表已武装且不可逆的业务事实，不代表可以调用远端 Sandbox。消费者只能在明确 Tenant RLS 作用域内领取；活动 Run claim、Workspace lease 与活动 Attempt 同时存在时绝不派发。恢复领取把遗留 `pending` 原子推进到 `started` 并且只决定一次 `close`；已处于 `started` 的 disposition 永远不改写，因此 waiting 正常路径的 `pause` 不会被恢复器覆盖。

领取令牌、generation、租约、重试时间、次数和 `remote_call_started_at` 由 0006 保存。远端调用前必须先写入后者；此后的进程崩溃或响应不确定只能收敛为 `unknown`，绝不自动重复 `settle`。未跨越远端边界的过期领取可由另一个消费者重领。

Scheduler 使用独立 consumer 实例和可关闭边界，不与 dispatch 共用可变单例。它只依赖按 registryId 解析并执行 pause/close 的适配器；lifecycle_unknown 与正式 cleanup 不共用消费路径，orphan capability 也不参与正式 armed cleanup。

## 影响

0006 不占用 dispatch 预留的 0005。迁移保持 FORCE RLS、既有复合外键与最小列 UPDATE ACL；down 仅允许既有测试环境破坏性回退。真实 CubeSandbox 冒烟必须 opt-in，并在 finally 中清理，不把 unknown 当作可安全重试。
