# Agent 协作与 Todo

本文面向维护 Agent Worker、Pi Adapter 和协作工具的开发者，说明当前 Root Agent、子 Agent 与 Todo 的运行边界。历史 Codex 调研和实施方案保存在[归档计划](../archive/plans/codex-subagent-runtime-design.md)。

## 子 Agent

Root Agent 可以创建可复用的独立子 Agent 对话。子 Agent 拥有自己的 Agent Thread、Turn、模型上下文、工具循环和持久 mailbox，但与 Root 共享当前 Run/Attempt 的 Sandbox 和 Workspace。共享执行环境不改变 Thread 的单写者语义；并发写入同一路径仍由文件工具冲突控制失败关闭。

协作工具只注册到 Root Session：

| 工具 | 当前语义 |
| --- | --- |
| `spawn_agent` | 创建子 Agent，显式选择 `exec_command`、`read`、`edit`、`write`、`skill` 子集，并选择不继承、继承全部或继承最近 N 个父 Turn |
| `send_message` | 向已有子 Agent mailbox 投递消息，不启动新 Turn |
| `followup_task` | 复用已有子 Agent，在可执行时启动新任务 |
| `wait_agent` | 使用单调 mailbox sequence 等待新活动或超时 |
| `interrupt_agent` | 中断当前 Turn，并等待 durable settle 后返回 |
| `list_agents` | 返回当前 Agent 树和稳定状态摘要 |

`wait_agent` 的公开参数只有必填的 `after_sequence` 和可选的 `timeout_ms`；`list_agents` 接收空对象。Runtime 用于识别非法参数的占位字段只参与内部校验，不进入模型工具定义、公开能力摘要或上下文预算。调用方提供内部字段或其他未声明字段时，调用失败并写入 durable 失败回执，不执行控制面操作。分层理由见 [ADR-20260906211950](../decisions/20260906211950-private-tool-validation-schema.md)。

Runtime 对可创建的子 Agent 总数和同时运行数量设置上限。Agent Thread、Turn、命令、mailbox 和终态都持久化；Worker 重启后不能依赖内存对象恢复协作状态。子 Agent 不获得 Root 协作工具，创建后也不能扩大工具集合。

## Todo

`todo_write` 是复杂或长程任务的可选规划工具，不是 Runtime 强制工作流。简单任务可以不创建 Todo；Runtime 不因缺少 `in_progress` 项而拒绝其他工具。

工具每次提交完整快照而不是 patch。首次快照可以原子标记当前 `in_progress` 和此前 `completed` 的步骤，同时最多一个 `in_progress`；后续快照中的已完成项不能改写。快照使用单调版本并作为 `todo.updated` 持久事实公开给 API 和 Web。完整参数和投影说明见[`todo_write` 参考](../reference/todo-write.md)。

## 事实归属

- Agent 协作领域状态位于 `runtime-ts/packages/domain/src/agent-*.ts`。
- Root 协作工具位于 `runtime-ts/packages/pi-adapter/src/agent-control-tools.ts`。
- 执行与恢复位于 `runtime-ts/apps/agent-worker/src/agent-supervisor.ts`。
- 持久化命令、Turn、mailbox 和对话位于 `runtime-ts/packages/persistence`。

设计边界见 [ADR-0122](../decisions/0122-shared-sandbox-subagent-control-plane.md)、[ADR-0127](../decisions/0127-thread-scoped-subagent-conversation.md)、[ADR-0153（SubAgent mailbox）](../decisions/0153-subagent-mailbox-terminal-status.md)、[ADR-0154（SubAgent 任务摘要）](../decisions/0154-subagent-initial-and-current-task.md)以及 ADR-0155 至 ADR-0164；Todo 设计见 [ADR-0113](../decisions/0113-agent-todo-writer-and-run-progress.md)。
