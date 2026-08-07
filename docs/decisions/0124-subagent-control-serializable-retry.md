# ADR-0124：SubAgent 执行链路事务并发冲突重试

- 状态：已接受
- 日期：2026-08-06
- 决策者：Runtime 团队
- 关联任务/PR：修复 `spawn_agent`、Child Rollout、共享 Thread Sandbox acquire 及 Child 工具许可间歇失败
- 替代关系：细化 ADR-0122 的 Agent 控制面和独立 Rollout 持久化并发语义，不替代其余结论

## 背景

Agent 控制面的 root 初始化、spawn 和 follow-up，从执行 claim 打开 root/Child Rollout，共享 Thread Sandbox acquire、
RunWorker heartbeat 续租，以及外部副作用许可的签发和消费，均使用 PostgreSQL `SERIALIZABLE` 事务；Rollout recovery
使用 `REPEATABLE READ`。这些事务会在内部重验当前 Attempt 双栅栏或读取正被 Attempt 更新影响的会话事实。
RunWorker 同时会更新 Attempt、claim 或 workspace lease，例如提交模型事件和续租。上述事务与这些更新重叠时，PostgreSQL
会以 SQLSTATE `40001` 明确回滚当前事务。

原实现把所有数据库异常直接投影为 `unavailable`。因此一次正常、可安全重试的序列化冲突会立即变成
`AGENT_SPAWN_UNAVAILABLE`，模型通常不会再次 spawn。即使 spawn 成功，同一竞争也可能让 Child 在创建 Session 时无法
打开或恢复独立 Rollout；Child 首次使用 Sandbox 工具时，Thread Sandbox acquire 也可能在读取活跃 Attempt 的同时被
根 Agent 事件提交触发 `40001`，继而被误报为 Sandbox 创建失败。之后 Child 还可能无法签发或消费副作用许可，或者被
一次并发 heartbeat 失败中断，最终被上层投影为 provider failure。

## 决策驱动因素

- 保留每次 Agent 控制命令和 Rollout 打开对最新 Attempt 双栅栏的验证；
- 不降低 spawn/follow-up 容量判断和幂等命令的事务隔离；
- 只重试 PostgreSQL 已明确回滚、不会产生未知提交结果的事务；
- 重试必须有界，不能让模型工具无限等待；
- 每次重试必须重新执行完整事务，不能复用旧快照、锁或 fence 判断。

## 备选方案

### 方案 A：对执行链路中已明确回滚的高隔离/deadlock 事务做有界重试

遇到 SQLSTATE `40001` 或 `40P01` 时，分别等待 5、15、45 毫秒后重新执行整个 Agent 控制事务，最多额外尝试三次。
其他错误和提交结果未知错误不重试。

优点是保留现有隔离与事务不变量，并把 PostgreSQL 要求调用方重试的正常并发结果封装在持久化层。控制面和 Rollout
使用同一个显式选择的重试封装。缺点是冲突时会增加少量延迟和数据库请求。

### 方案 B：把 Agent 控制事务改为 READ COMMITTED

`FOR SHARE` 与 Attempt 级 advisory lock 可以覆盖当前主要竞争，但这会整体改变容量读取、命令重放和 fence 快照语义，
需要重新证明更多并发交错，不适合作为局部故障修复。

### 方案 C：继续向模型返回 correctable unavailable

无需修改持久化层，但把数据库正常并发控制泄漏为模型决策。模型可能不重试、使用不同参数重试，或错误判断平台未
启用 SubAgent，无法提供稳定语义。

### 方案 D：在通用事务封装中自动重试所有高隔离事务

可减少重复代码，但部分调用包含提交后回调、非幂等外部操作或专用 readback 协议。没有逐个审计前，全局自动重试
可能扩大副作用风险。

## 选择

采用方案 A，并固定以下规则：

1. root 初始化、spawn、follow-up、从 claim 打开 root/Child Rollout、共享 Thread Sandbox acquire/续租/物化证明及
   生命周期状态切换、heartbeat 续租，以及外部副作用许可的签发和消费，显式选择可重试的 SERIALIZABLE Tenant 事务
   封装；Rollout recovery 显式选择同规则的 REPEATABLE READ 封装；普通 `withTenantTransaction` 仍保持单次执行语义。
2. 仅 SQLSTATE `40001`（serialization failure）和 `40P01`（deadlock detected）进入重试；这两类错误均证明当前事务已
   被 PostgreSQL 回滚。
3. 重试延迟固定为 5、15、45 毫秒，最多额外尝试三次；超过上限后仍返回既有 `unavailable` 投影。
4. 每次尝试都重新开启事务、设置 Tenant RLS 上下文、重验 Attempt fence，并重新取得 Agent 控制 advisory lock。
5. 提交响应未知、连接中断、权限/约束错误和业务冲突都不进入本重试路径；已有幂等 command/replay 规则保持不变。

## 理由

PostgreSQL 的 `40001` 和 `40P01` 是“事务没有提交、调用方应重试”的明确结果，与 COMMIT 后连接断开的未知状态不同。
Agent 控制命令本身已有稳定 command ID、参数摘要和 replay 检查，完整重放不会创建第二个 Child 或 Turn；Rollout
stream 由唯一键和 `already_exists` 语义保证重放稳定。Thread Sandbox 的 session/effect/lease ID 在事务外固定，状态
推进受唯一键和 CAS 约束，且 Provider 调用不位于可重试事务内部；明确回滚后完整重放不会重复远端副作用。许可签发的
随机 permit ID 不可能在 `40001`/`40P01` 回滚后留下已提交行；许可消费的 `consumed_at` 更新也未提交。heartbeat 只用
`GREATEST` 延长租约并读回 fence，重复执行不会缩短租约；Rollout recovery 只读取一致快照，不写入事实。因此这些事务
都能安全执行新的完整事务。

只有经过审计的 `PgAgentControlRepository`、claim-based Rollout 打开/recovery 路径、
`PgThreadSandboxSessionLifecycle` 高隔离状态事务，以及 `PgExecutionPersistence` heartbeat/许可路径显式选择这一处理，
可以让模型看到稳定的执行语义，同时避免把自动重试扩展到全部持久化事务。
短退避覆盖 RunWorker 的事件提交和心跳更新窗口，又保持工具调用延迟有界。

## 影响

### 正面影响

- spawn/follow-up、Child Rollout 打开/恢复、Thread Sandbox acquire、heartbeat 和 Child 工具许可不再因一次 Attempt
  并发更新而间歇性失败；
- 每次成功仍由原隔离级别、双栅栏和 advisory lock 共同约束；
- 模型工具协议和公开错误码无需变化。

### 负面影响与成本

- 冲突时最多增加 65 毫秒显式退避以及额外事务耗时；
- 持续高竞争超过重试上限时仍会失败关闭；
- SubAgent 执行链路显式选择共享重试逻辑，需要与其他高隔离路径保持审阅一致。

### 安全、数据与运维影响

不扩大 Tenant、工具或 Sandbox 权限，不新增持久字段，也不需要数据库迁移。每次重试都会重新设置 Tenant RLS 并重新
校验 fence；未知提交结果不会被当作可安全重试。部署需要重启 Agent Worker 以加载新的持久化代码。

## 验证

- PostgreSQL 集成测试分别让 spawn、Child Rollout 打开及 recovery 的 fence 查询等待并发 Attempt 更新；释放更新后
  第一次事务确定触发 `40001`，验证 Repository 完整重试、只创建一个 Child，并成功打开和恢复唯一 Child stream；
- PostgreSQL RunWorker 集成测试分别在 heartbeat 的 claim `UPDATE`、许可 `INSERT` 和消费 `UPDATE` 注入一次 `40001`，
  验证完整事务重试后续租成功、许可成功签发且只消费一次；
- PostgreSQL RunWorker 集成测试在 Thread Sandbox acquire 的 session 查询注入一次 `40001`，验证完整准备流程重试后
  只冷建一个挂载 ResourceFS 的 Sandbox；
- 运行完整 PostgreSQL Rollout 集成测试，覆盖既有 spawn replay、follow-up 和独立 Rollout；
- 执行 persistence/Agent Worker typecheck、直接测试、格式与 lint 门禁；
- 使用开发 API 发起真实 SubAgent Run，确认 spawn、子模型 turn、工具调用和 mailbox 交付均成功。

## 可逆性与回退

代码可直接回退，不涉及数据转换。回退后已有 Agent 控制事实仍可读取，但相同并发窗口会重新暴露
`AGENT_SPAWN_UNAVAILABLE`。若必须临时回退，可先以 `SUBAGENTS_ENABLED=false` 停止新 spawn，并 drain 活跃 SubAgent。
