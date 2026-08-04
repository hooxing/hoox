# ADR-0106：过期 Attempt 自动收敛与长任务 Sandbox 时限

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联：ADR-0011、ADR-0069、ADR-0088、ADR-0092、ADR-0104
- 替代关系：细化 ADR-0011、ADR-0088 的恢复入口；替代 ADR-0104 的 15 分钟 Run 与 20 分钟 Sandbox 默认时限

## 背景

真实开发 Run 已完成模型回复、Workspace 校验和 Artifact 发布，却在 `finalizing` checkpoint 与最终
RuntimeMutation 之间中断。30 秒 claim 过期后，普通 claim 正确返回 `recovery_required`，但 RunWorker
只把它映射成 `ignored`，dispatch 又把该结果映射成五秒 defer。现有 `recoverExpiredAttempt` 没有生产调用方，
导致同一 dispatch 无界空转，Attempt 保持 `finalizing`，Web 继续显示“正在准备任务”。Thread Sandbox 的
pause effect 也尚未创建；Provider 虽可按 TTL 自动挂起，数据库仍保留 `running` Session 和过期 lease。

同时，15 分钟 Run 和 20 分钟 Sandbox TTL 无法覆盖需要数小时的 Agent 任务。TTL 是 Worker 崩溃时的
Provider 侧保险，不应代替正常收尾；正常回答结束后仍应立即按队列事实 handoff 或 pause。

## 决策

1. RunWorker 只有在普通 claim 明确返回 `recovery_required` 后，才以
   `decision=require_manual_recovery` 调用窄恢复入口。恢复入口只把过期 Attempt 固化为
   `recovery_required`，不重跑模型或工具，也不猜测 Run 的业务成功、失败或取消。
2. 恢复成功返回 Worker 的 `recovery_required` 结果，dispatch 将其确认成已分派，停止五秒空转；恢复存储
   对已经写入的 `recovery_required` Attempt 幂等返回成功，以覆盖 dispatch ack 结果未知后的再次投递。
3. 若过期 Attempt 持有 Thread Sandbox lease，恢复事务原子写入唯一的 pending terminate effect，把
   Session 隔离为 `unknown` 并释放 lease。Scheduler 继续负责远端关闭和结果对账；恢复事务本身不得直接
   调用 CubeSandbox。失败 Run 的可变环境不能交给后续 Run 复用。
4. Web 继续使用 ADR-0088 的 `executionStatus=recovery_required` 终止投影：停止计时、动画和短轮询，显示
   “执行已中断”。Domain Run 保持 `running`，排队 Follow-up 仍需用户显式“结束本次运行”后推进。
5. 默认 `AGENT_WORKER_RUN_TIMEOUT_MS` 调整为 43,200,000 毫秒（12 小时），允许配置上限调整为 24 小时；
   默认 `CUBESANDBOX_SESSION_TTL_SECONDS` 调整为 43,800 秒（12 小时 10 分钟），继续强制覆盖 Run timeout
   与 90 秒 lifecycle 收敛窗口。
6. 成功或 waiting Run 的正常终态策略不变：队列已有下一 Run 时 running handoff；队列为空时在终态事务
   提交后立即执行 pause effect。长 TTL 不延迟主动 pause。

## 备选方案

### 只让 dispatch 停止重试

这能停止数据库空转，但不会产生 durable `recovery_required` 事实，Web 仍会显示运行中，过期 Sandbox
lease 也不会清理，因此拒绝。

### 自动把模型已启动的 Run 标为 failed 或重新执行

基础设施不能证明工具副作用是否已经发生，也不能证明业务失败；自动重跑可能重复副作用，自动 failed 会
伪造领域事实，因此继续采用 ADR-0088 的恢复终止投影。

### 每个工具调用后暂停 Sandbox

这会给连续的 read/write/exec 调用增加大量 pause/resume 延迟，并冻结仍在运行的子进程。选择保持一个
Run 内持续运行，只在完整 Run 的终态边界快速挂起。

## 影响

- 过期 finalizing Attempt 会在下一次 dispatch 时自动形成可见终止事实，不再无界显示“正在准备任务”；
- dispatch ack 重试不会重复创建 terminate effect；
- Provider 自动 TTL 与数据库生命周期仍可能短暂错位，但过期 Attempt 的 durable terminate effect 会最终
  将两侧收敛为 terminated；
- 正常成功任务仍在回答结束后快速挂起，长任务时限只扩大执行窗口和 Worker 崩溃时的最坏 Provider 运行期；
- `recovery_required` Run 不会自动推进 Follow-up，用户仍保有是否结束当前业务 Run 的决定权；
- 无数据库迁移，使用既有 Attempt、Session、lease 和 lifecycle effect 表。

## 验证

- RunWorker 单元测试构造模型已启动且 claim 过期，验证首次和重复 dispatch 都收敛为
  `recovery_required`，且不创建模型 Session；
- PostgreSQL 集成测试构造过期 finalizing Attempt 与活跃 Thread Sandbox lease，验证恢复原子写入
  `recovery_required`、唯一 terminate effect、Session=`unknown`、lease released，并可由 Scheduler store
  收敛为 terminated；
- Worker 配置测试验证 12 小时 Run、12 小时 10 分钟 TTL 和覆盖约束；
- 复用现有 Web 测试验证 `recovery_required` 停止计时、活动动画和短轮询；
- 执行 format、lint、受影响包 typecheck、单元测试及 PostgreSQL 集成测试。

## 可逆性

时限可通过环境变量独立回退。自动恢复入口可停止调用，但已经写入的 `recovery_required` Attempt 和
terminate effect 是审计事实，不得删除；Scheduler 仍应完成既有 effect。若回退恢复调用，旧的无界 defer
问题会重新出现，因此只允许在替代恢复协调器已经部署后回退。
