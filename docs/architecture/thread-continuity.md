# Thread 连续上下文

本文面向需要理解 Thread、Run、Context 和 Sandbox 恢复关系的开发者。它描述当前运行语义；灰度、旧 Thread anchor、指标和紧急回退见[运维手册](../operations/thread-continuity.md)，历史实施拆解见[归档计划](../archive/plans/README.md)。

## 所有权与顺序

Thread 是连续对话和 Workspace 的所有权根，Run 是一次待执行意图，ExecutionAttempt 是一次实际领取。一个 Thread 同时只有一个 Context 写者；后续输入先持久化，再作为当前 Run 的 steer 或 FIFO follow-up 处理，不能依赖进程内队列。

Run 只有成为队首后才能绑定 Context 与 Workspace 基线。完成、失败或取消不会删除 Thread 历史；新的 Run 从持久事实重建当前上下文。

## Context 事实与压缩

用户消息、Assistant 结果、工具事实和控制输入写入 Thread 级持久事实流。Canonical Context 根据当前可信配置从这些事实重建，Pi Session 内存不是恢复事实源。

Runtime 在接近模型窗口时创建持久 compaction checkpoint。Checkpoint 保存可恢复的 replacement history，原始事实不因压缩删除；后续重建可以组合 checkpoint 和未压缩事实。若配置、摘要或事实不一致，恢复路径失败关闭，不能静默截断或猜测历史。

## Sandbox 与 Workspace

Sandbox 是可复用缓存，不是业务事实源。Run 完成且没有待执行 follow-up 时，Thread Sandbox Session 进入 pause；新输入优先 resume。Sandbox 不存在、超过保留策略或无法安全复用时，Runtime 创建新 Sandbox，并从最新 Workspace Revision 和 ResourceFS 能力重建环境。

Run 交接必须在 Context、Workspace、租约和 Session 身份完成持久提交后发生。失去租约、generation 或 capability 的 Worker 不能继续复用或提交结果。

## 输入与恢复

- steer 作为真实用户输入持久化，在模型安全点按顺序接纳；结束竞态会原子转入 follow-up。
- follow-up 按 FIFO 逐项创建后续 Run，Worker 崩溃或当前 Run 取消不能丢失它。
- 旧 Thread 只有在证据式 anchor 完成后才进入 V2 读取路径；无法恢复的历史以明确 gap 表达，不伪造 Assistant 内容。
- 全局功能开关用于紧急回退，不删除 profile、anchor、checkpoint 或输入事实。

当前行为由 `runtime-ts/packages/persistence`、`runtime-ts/apps/agent-worker`、`runtime-ts/apps/api` 和 `runtime-ts/apps/scheduler` 共同实现；关键取舍见 ADR-0063 至 ADR-0071。
