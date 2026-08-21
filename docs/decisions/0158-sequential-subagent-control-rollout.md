# ADR-0158：子 Agent 控制工具按顺序形成 Rollout 事实

- 状态：已接受
- 日期：2026-08-12


## 背景

Pi 允许模型在同一条 assistant 消息中发出多个工具调用。子 Agent 控制工具此前声明为 `parallel`，因此多个调用会并发执行并各自写入 durable `tool_call` / `tool_result`。

Runtime Rollout 的持久化不变量要求工具事实严格成对相邻：一个 `tool_call` 后必须先写入同一调用的 `tool_result`，才能开始下一次工具调用。实测中 `list_agents` 与 `followup_task` 并发时，前者先写入 `tool_call`，后者的 `tool_call` 因前驱仍未闭合而被数据库约束拒绝，最终将整个 Attempt 转入 `recovery_required`。

## 决策

六个子 Agent 控制工具统一使用 Pi 的 `sequential` 执行模式。模型仍可在同一消息中声明多个控制调用，但 Runtime 按消息顺序完成每一组 durable `tool_call` / `tool_result` 后再执行下一组。

不放宽 Rollout 的相邻配对约束，也不为控制工具增加旁路持久化协议。该约束是恢复、审计和幂等判定的基础。

## 影响

- 并列的 `list_agents`、`followup_task`、`interrupt_agent` 等调用不再因 durable 前驱竞态导致持久化失败。
- 同一模型消息中的控制工具不再真正并发；尤其不应把长时间 `wait_agent` 与其他控制操作放在同一批调用中。
- 单个子 Agent turn 自身仍在后台运行，不受控制工具调用顺序化影响。

## 验证

- 单元测试校验六个控制工具均声明为 `sequential`。
- 既有控制工具执行、失败回执和 schema 桥测试继续通过。

## 可逆性

若未来 Rollout 协议原生支持同一 assistant 消息中的多组并发工具调用及确定性配对，可在新增对应持久化与恢复测试后恢复并行执行。
