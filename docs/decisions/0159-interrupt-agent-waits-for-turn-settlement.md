# ADR-0159：中断控制在 Turn 终态落地后返回

- 状态：已接受
- 日期：2026-08-12


## 背景

`interrupt_agent` 原先在调用子 Session 的 `abort()` 后立即返回摘要。`abort()` 只发出取消信号，实际的子 Agent turn 仍需经过异常收敛、`runtime_agent_turns` 终态写入和 mailbox 发布。因此工具返回值可能仍是 `status: running`、`lastMailboxSequence: 0`，父 Agent 需要额外等待才能确认中断是否真正完成。

这会让控制命令的成功返回与可观察状态互相矛盾，也会诱导父 Agent 把“已请求中断”误判为“已完成中断”。

## 决策

Supervisor 为每个正在运行的子 Agent 保存当前 turn 的完成 Promise。`interrupt_agent` 在 `abort()` 后等待该 Promise 收敛，再返回最新摘要。

返回成功时必须满足：

- 当前 turn 已结束；
- turn 终态已经尝试持久化；
- mailbox 中断消息已经发布；
- 摘要不再返回 `running`，并反映最新 mailbox sequence。

不新增 `interrupting` 瞬时状态，也不在发出取消信号后提前伪造 `interrupted`。

## 影响

- `interrupt_agent` 的延迟包含被中断 turn 的收敛时间。
- 成功返回的摘要与随后的 `list_agents` / `wait_agent` 终态一致。
- 幂等重放仍返回当前子 Agent 摘要，不重复调用 Session `abort()`。

## 验证

- Supervisor 中断测试断言首次调用直接返回 `interrupted` 和最新 mailbox sequence。
- 测试继续验证 `abort()` 只调用一次、命令摘要一致以及 mailbox 的结构化中断终态。

## 可逆性

可移除 per-child 完成 Promise 的等待，恢复快速返回，但会重新暴露 `running` 竞态。
