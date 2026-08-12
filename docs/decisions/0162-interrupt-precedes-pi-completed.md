# ADR-0162：主动中断优先于 Pi 的 completed 收敛

## 背景

真实 Pi Session 在正在执行的工具被取消后，可能先产生 `EXEC_CANCELLED` 工具结果，再以 `outcome.kind=completed` 和一个 `turn.completed` 事件收敛。Supervisor 原先只检查 Pi outcome 与 `turn.completed` 是否存在，因此会把中断前产生的部分文本保存为成功历史，并发布 `final_answer/completed`。

这导致主动中断事实丢失、父 Agent 收到错误终态，且后续 follow-up 会继承被取消 turn 的部分输出。

## 决策

Supervisor 在接收完 Pi outcome 与所有 pending tool 事件后，必须先检查 `interruptRequested` 和 Supervisor stopping 状态，再判断 Pi 是否完成：

- 只要当前 turn 已被主动中断，就进入统一异常收敛路径；
- turn 持久化为 `interrupted/INTERRUPTED`；
- mailbox 发布 `error/interrupted/INTERRUPTED`；
- 已收到的部分 `turn.completed`、Assistant 文本和取消工具结果不写入可复用成功历史；
- Pi 的 `completed` 不能覆盖 Runtime 控制面的主动中断事实。

## 影响

- `interrupt_agent` 在真实 Pi 取消收敛路径中返回结构化中断终态。
- 后续 follow-up 不再继承中断 turn 的部分回答。
- 正常未中断的 `completed` 行为不变。

## 验证

新增 Supervisor 测试模拟 `abort()` 后 Pi 仍产生 `turn.completed` 并返回 `completed`，断言最终仅持久化和发布 `interrupted`，不得发布成功答案。

## 可逆性

不可安全回退；回退会重新允许模型流终态覆盖 Runtime 主动中断事实。
