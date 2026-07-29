# ADR-0052：Artifact 工具许可与 Attempt 版本的单调边界

- 状态：已接受
- 日期：2026-07-30

## 背景

一个模型响应可以同时发出多个工具调用。每个 `tool.started` 都是独立的持久化事件，因而会合法递增同一 Attempt 的版本。Artifact 工具许可已在第一个调用的 `tool.started` 后签发并消费；若边界把当前 Attempt 版本要求为与许可签发版本完全相等，后续并发 `tool.started` 会在不改变 Run claim、Workspace lease 或许可本身的情况下错误撤销第一个调用。

此外，PostgreSQL 的 `clock_timestamp()` 默认保留微秒而 `pg` 的 `Date` 往返仅保留毫秒。边界必须继续精确比对 permit 的签发、过期和消费时间，所以签发时统一以毫秒截断写入这两个时间列。

## 决策

许可仍固定保存 `permit.attempt_version`，并继续精确校验 permit 身份、消费状态、期限、call/args digest、claim token/epoch、Workspace lease、Run 状态和进程内短 continuation 能力。PG Artifact 执行边界仅将当前 Attempt 版本校验由 `=` 改为 `>=`：允许同一活跃 Attempt 的后续持久化事件前进版本，拒绝版本倒退。

`issueExternalEffectPermit` 使用同一 `date_trunc('milliseconds', clock_timestamp())` 值写入 `issued_at` 并派生 `expires_at`，因此不放宽精确时间匹配。

## 影响

并发的合法工具开始事件不会撤销已消费的首个 Artifact 许可；取消、lease/claim 变化、期限到期、旧版本或终态 Run 仍失败关闭。该规则不授予跨 Attempt、跨 fence 或跨租户能力。

## 验证

`tests/integration/postgres-artifact.integration.test.ts` 在真实 PostgreSQL 隔离 schema 中，经 `PgExecutionPersistence` 写入首个 `tool.started`、签发并消费 permit、再写入第二个 `tool.started` 以将 Attempt 从版本 1 推进到版本 2；随后 `PgArtifactDeliveryRepository` 使用首个 permit 成功开始发布。该测试同时断言数据库中 `issued_at` 与 `expires_at` 的微秒余数为零，并拒绝版本倒退、已释放 claim、过期 Workspace lease、伪造 fence epoch 与已取消 Run。开发环境纵向 Run 另覆盖 Workspace 发布后的 Artifact 读取、预览和下载。

## 可逆性

若未来每个工具调用获得隔离的 immutable Attempt 版本或将事件与 effect 排序为单一事务，可恢复严格相等校验；迁移前必须保留对应的并发正向测试。
