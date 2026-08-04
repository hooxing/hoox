# ADR-0108：终态原子 Mutation 的 SERIALIZABLE 有界重放

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联问题：Agent 已交付结果但 Run 被恢复为“执行已中断”

## 背景

Run Worker 在模型结束后通过一个 `SERIALIZABLE` 事务原子提交 Attempt/Run 终态、Workspace、Thread 上下文、
Sandbox 生命周期和 Outbox。一次实际执行已经完成模型响应和交付文件，但该终态事务在更新
`thread_sandbox_sessions` 时被 PostgreSQL 以 SQLSTATE `40001` 明确回滚。Persistence 将所有数据库异常统一映射为
`unavailable`，Worker 因而退出；claim 过期后恢复协调器把 Attempt 收敛为 `recovery_required`，界面最终显示
“执行已中断”。

`40001`（serialization failure）和 `40P01`（deadlock detected）都表示当前事务已被数据库明确回滚，调用方可以
安全地重放完整事务。这与 COMMIT 响应丢失不同：后者无法判断事务是否已经提交，不能直接重试。

## 备选方案

### 不自动重试，完全依赖恢复协调器

实现最简单，但恢复协调器无法补造已经回滚的 Workspace、上下文和 Sandbox 终态原子事实，只能中断已完成的
任务，形成错误的用户状态。

### 降低事务隔离级别

可以减少 serialization failure，但会削弱 fence、Attempt version、幂等结果与跨聚合终态提交之间的一致性保证。

### 有界重放已明确回滚的幂等 Mutation

保留 `SERIALIZABLE` 一致性，在 PostgreSQL 明确回滚时使用同一命令、幂等键、digest 和 fence 重放整个事务；
COMMIT 结果未知仍进入独立恢复路径。

## 决策

选择第三种方案：

- `PgExecutionPersistence.mutate` 仅对 SQLSTATE `40001` 和 `40P01` 重放完整事务；
- 首次失败后最多重试三次，退避分别为 5、15、45 毫秒，避免并发冲突时立即热循环；
- 每次重放使用完全相同的签名命令、幂等键、digest、fence 和预期 Attempt version；
- `TransactionCommitUnknownError` 继续返回 `response_unknown`，禁止自动重试；
- 约束冲突、协议错误和领域拒绝继续沿用原有确定性结果，不参与重试；
- 重试耗尽后返回 `unavailable`，由既有 claim/recovery 机制接管。

## 理由

终态 Mutation 已具备数据库幂等记录、fence 与乐观版本约束，数据库明确回滚后不存在部分提交，完整重放是安全
且最小的修复。保留未知 COMMIT 的独立语义，可以避免实际已提交却再次执行外部可见状态转换。

## 影响

- 短暂的 PostgreSQL serialization failure 或 deadlock 不再把已完成任务错误收敛为“执行已中断”；
- 极端持续冲突最多增加 65 毫秒本地退避，随后仍按原有不可用路径失败关闭；
- 已经进入 `recovery_required` 且释放 Workspace/Sandbox 的历史 Attempt 不会被事后伪造为成功；修复作用于后续
  Mutation；
- 事务隔离级别和聚合一致性边界不变。

## 验证

- PostgreSQL 集成测试在 `UPDATE execution_attempts` 前注入一次 `40001`，验证同一幂等 Mutation 自动重放、
  Attempt version 只推进一次且幂等结果可查询；
- 既有 COMMIT 响应丢失集成测试继续验证未知结果不会被自动重试；
- Persistence 包 typecheck、格式、lint 和相关集成测试作为本地提交门禁。

## 可逆性与回退

该改动不修改 Schema 或持久数据。回退代码即可恢复旧行为，但 serialization failure 会再次由恢复协调器中断。

