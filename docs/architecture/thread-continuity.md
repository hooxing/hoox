# Thread 连续上下文

本文面向需要理解 Thread、Run、Context 和 Sandbox 恢复关系的开发者。它描述当前运行语义；指标和紧急回退见[运维手册](../operations/thread-continuity.md)。

## 所有权与顺序

Thread 是连续对话和 Workspace 的所有权根，Run 是一次待执行意图，ExecutionAttempt 是一次实际领取。一个 Thread 同时只有一个 Context 写者；后续输入先持久化，再作为当前 Run 的 steer 或 FIFO follow-up 处理，不能依赖进程内队列。

Run 只有成为队首后才能绑定 Context 与 Workspace 基线。完成、失败或取消不会删除 Thread 历史；新的 Run 从持久事实重建当前上下文。

## Context 事实与压缩

用户消息、Assistant 结果、工具事实和控制输入写入 Thread 级持久事实流。Canonical Context 根据当前可信配置从这些事实重建。`pi-adapter` 直接向 `pi-agent-core` 的 `Agent` 提供有序消息；内存消息不是恢复事实源，也不建立 Pi Session 文件、entry/leaf 或分支树。

Runtime 在接近模型窗口时创建持久 compaction checkpoint。Checkpoint 保存可恢复的 replacement history，原始事实不因压缩删除；后续重建可以组合 checkpoint 和未压缩事实。若配置、摘要或事实不一致，恢复路径失败关闭，不能静默截断或猜测历史。

压缩参数按 Run 固定，区别于压缩 checkpoint 中的历史正文。Worker 首次建立 Session 时先解析模型，解析后台当前压缩设置（未配置则回退部署值），把五项参数存入 `run_compaction_settings_snapshots`；使用部署回退模型的 Run 也会建立该快照。同一 Run 的重试和进程重启优先读取压缩快照，不改用之后的环境变量或后台运行参数。恢复时执行输出预算仍受实际使用模型的最大输出约束；若模型上限降低，执行预算会进一步裁剪，但不改写原快照，其余四项保持不变。

升级前已绑定后台 `runtime_settings_revision` 的 Run，首次建立独立压缩快照时继承该历史配置；此前没有持久化部署参数的旧 Run 无法还原原始部署值，只能在首次建立快照时采用当前后台配置或部署回退值。模型与记忆首次解析会固定当前选择，包括未配置状态；已有空模型快照不会因后台新增模型改变选择。部署模型的具体参数仍来自环境变量，修改它们前应排空相应在途 Run。变量与默认值见[配置参考](../reference/configuration.md)，所有权与迁移取舍见[后台控制面与运行配置](admin-control-plane.md)。

Runtime 在完整 `turn_end` 后提交事实并准备下一轮历史，Provider 请求前重新复核预算、工具能力和可信模型绑定。Runtime 在请求前产生的预算、绑定或受控续轮拒绝按调用 generation 归属，内存消息和未消费 steer 回滚到该次调用的检查点，已经持久化的工具事实保留。底层 `agent_end` 不表示 Runtime 已空闲；回滚完成后才发出 `agent.settled`，`abort()` 等待它捕获的执行事务跨过同步屏障，在此之前不允许新 prompt 重入。

## Sandbox 与 Workspace

Sandbox 是可复用缓存，不是业务事实源。Run 完成且没有待执行 follow-up 时，Thread Sandbox Session 进入 pause；新输入优先 resume。Sandbox 不存在、超过保留策略或无法安全复用时，Runtime 创建新 Sandbox，并从最新 Workspace Revision 和 ResourceFS 能力重建环境。

Run 交接必须在 Context、Workspace、租约和 Session 身份完成持久提交后发生。失去租约、generation 或 capability 的 Worker 不能继续复用或提交结果。

## 输入与恢复

Web 的未发送文字草稿保存在当前标签页的 sessionStorage，按账号、个人或团队空间以及 Thread 隔离。刷新可恢复文字；附件需要重新选择。新任务创建后草稿迁移至该 Thread，发送成功才清空；发送失败保留，退出账号清除该账号的草稿。浏览器拒绝存储时显示复制提示，内存内容仍可编辑和发送，但不保证刷新恢复。

- steer 作为真实用户输入持久化，在模型安全点按顺序接纳；结束竞态会原子转入 follow-up。
- follow-up 按 FIFO 逐项创建后续 Run，Worker 崩溃或当前 Run 取消不能丢失它。
- 所有通过 Thread 创建入口建立的 Thread 都直接使用持久 Context 读取路径；无法恢复的历史以明确 gap 表达，不伪造 Assistant 内容。
- 全局功能开关用于紧急回退，不删除 checkpoint 或输入事实。

当前行为由 `runtime-ts/packages/persistence`、`runtime-ts/apps/agent-worker`、`runtime-ts/apps/api` 和 `runtime-ts/apps/scheduler` 共同实现。

控制器不提供进程内 `followUp()` 队列；子 Agent 的 `followup_task` 仍由 Runtime 持久协作协议执行。事件契约保留历史 `queue.updated` 与 `compaction.forbidden` 成员供轨迹和协议读取，新内核不产生它们。内核适配见 [Prompt、上下文预算与模型交互](prompt-and-model-io.md#模型绑定)。
