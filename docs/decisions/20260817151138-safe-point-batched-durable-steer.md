# ADR：同一安全点批量接纳 Durable Steer

- 状态：已接受
- 日期：2026-08-17
- 关联：ADR-0067 Durable Steer 与统一 Thread 输入协议
- 替代关系：细化 ADR-0067 第 5 条的“单条 pending receipt”消费粒度，不改变其安全点和持久化边界

## 背景

阶段 3 的 durable steer 已保证输入先落数据库、完整 assistant/tool turn 持久化后再进入 Pi，并在 terminal 竞态中唯一收敛为 `steered`、`queued` 或 `rejected`。但 Worker 的安全点读取使用 `ORDER BY input_sequence LIMIT 1`，`onTurnSafePoint` 也只允许返回一条 steer。用户在同一个模型步骤期间连续插入多条消息时，每条消息都要等待一次新的 Provider 往返；最终 `/chat/completions` 请求无法像 Pi 原生 steering 队列那样在下一次上下文中同时携带这些用户消息。

## 决策

1. 安全点读取一次返回该目标 Run/Turn 在当前数据库快照中全部 `pending_steer` receipt，并保持 `input_sequence` 顺序。
2. Worker 在同一个完整 turn 安全点逐条执行既有的单 receipt 幂等 mutation，将每条输入作为真实 `user_message` 写入 Thread Context，并将 receipt 标记为 `steered`。
3. `onTurnSafePoint` 返回有序 `steers` 列表；Pi Session Factory 在安全点 hook 返回前按序调用 Pi 原生 `steer()`。
4. Runtime 创建的内存 Pi Settings 固定使用 `steeringMode: "all"`。这是 Pi 已提供的原生批量语义：同一安全点排入的 steering messages 一次进入下一次 Provider 上下文；不自行修改 `agent.state.messages`，也不实现第二套内存队列。
5. Runtime compaction 的新增输入预算按该批次所有 steer 文本 token 之和计算，不能只为第一条预留。
6. 若 Pi 已经 settled、当前没有活跃 prompt，Worker 仍只消费批次队首并用新的 `prompt()` 启动 continuation；其余 receipt 保持 pending，等待该 prompt 的下一个安全点。禁止为了“批量”提前把无法交付给活跃 Pi 队列的 receipt 标记为 `steered`。
7. 不引入“批量 RuntimeMutation”或新的持久化 receipt schema。每条 receipt 继续使用原有 idempotency key 独立提交；中途失败时，已提交项可从 Thread Context 恢复，未提交项仍保持 pending。

## Request Body 语义

当前 Provider 请求正文永不被修改。安全点批次在下一次请求中表现为按序排列的普通用户消息：

```json
{
  "messages": [
    { "role": "user", "content": "原始任务" },
    { "role": "assistant", "content": "当前完整回复或工具轮次" },
    { "role": "user", "content": "第一条插话" },
    { "role": "user", "content": "第二条插话" }
  ]
}
```

消息不会获得 `steer` 专用 role，也不会进入 assistant tool call 与对应 tool result 之间。

## 过度设计审视

### 保留：不是过度设计

- **Durable receipt 与 Thread writer fencing**：负责崩溃恢复、跨 Worker 幂等和 terminal 线性化，Pi 内存队列无法替代。
- **完整 assistant/tool 安全点**：防止非法打断 tool call/result 配对，是 Provider 协议不变量。
- **`steered` / `queued` / `rejected` 三分结果**：避免同一输入既进入当前 Run 又创建 follow-up Run。
- **独立 follow-up Run FIFO**：表达跨 Run 调度，不应与当前 Run 的 Pi steering 队列合并成一个概念。

### 本次简化

- 删除“安全点永远只允许一条 steer”的偶然限制，改为有序列表。
- 抽取单条 steer mutation helper，消除安全点路径与 settled fallback 路径重复构造 mutation 的代码。
- 复用 Pi 自带的 `steeringMode: "all"`，不直接篡改 Pi message state，也不新增 Runtime 自有的模型请求拼装队列。
- 复用既有单 receipt mutation，不新增批量事务 schema、批量 receipt 或新的队列表；这些扩展会放大持久格式和恢复逻辑，而当前需求并不需要。

### 仍存在但暂不扩大修改范围

代码中同时出现数据库 `pending_steer`、Pi 原生 steering queue 和 `thread_follow_up_queue` 三个“队列”。它们分别承担持久准入、单个活跃 prompt 的模型调度、跨 Run FIFO，职责不同；当前更需要统一命名和诊断展示，而不是强行合并状态机。若后续继续简化，应优先整理术语与观测，而不是删除安全边界。

## 验证

- Worker 测试覆盖同一安全点两条 pending steer 按序全部消费并交给同一活跃 Session。
- Pi Faux Provider 测试覆盖多条 steer 在下一次 Provider context 中同时出现且顺序稳定。
- 既有测试继续覆盖 Provider stream 和完整 tool call/result 收敛前不读取 steer。
- 类型检查覆盖 run-contracts、persistence、agent-worker 与 pi-adapter 的接口一致性。

## 可逆性

回退时恢复单条读取和单条 `steer` 返回即可；数据库表和 receipt 格式没有变化，不需要迁移或删除生产事实。
