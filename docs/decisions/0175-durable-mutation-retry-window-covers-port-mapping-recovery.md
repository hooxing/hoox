# ADR-0175：扩大 durable mutation 对端口映射恢复的覆盖窗口

- 状态：已接受
- 日期：2026-08-14

## 背景

ADR-0174 为 durable mutation 增加了 25ms、100ms 两次退避。真实 Run `run_7bb01d8a-945d-4039-a189-724339d44717` 执行子 Agent 读取 `data/records.csv` 时，`tool.started` 已作为 Attempt version 281 提交，但 `tool.completed` 没有 mutation receipt，随后 Attempt 进入 `PERSISTENCE_UNAVAILABLE`。

数据库同时证明恢复 mutation 在失败事件发生后约 230ms 已成功提交，Sandbox 也由 Scheduler 正常关闭。文件读取、模型传输和 Sandbox 本身没有失败；实际的 PostgreSQL/UU 端口映射抖动持续时间超过原策略覆盖的 125ms，但远短于默认 30 秒运行租约。

## 约束

- 仅允许重放明确返回 `unavailable`、确认没有提交的 mutation。
- 每次重放必须保持 command、幂等键、摘要、Attempt version 和事件 sequence 完全相同。
- `response_unknown` 仍只能按 receipt 读回，不得改为重放。
- 默认单次数据库连接等待上限为 5 秒；总尝试窗口必须低于 30 秒运行租约。
- 持续数据库故障仍要失败关闭并触发 Sandbox cleanup。

## 决策

- 将退避序列从 25ms、100ms 扩展为 25ms、100ms、500ms，总共最多尝试四次。
- 重试继续在同一 durable lane 内执行，第四次仍使用第一次构造的同一 command。
- 四次数据库连接等待的理论上限约 20.6 秒，低于默认 30 秒租约。
- 四次均不可用时沿用现有 `recovery_required` 和 cleanup 语义。

## 影响

数百毫秒级的端口映射或 PostgreSQL 连接池恢复不再中断长任务，且不会放宽幂等性和 fence 边界。持续故障最多增加一次数据库连接尝试及 500ms 退避。

## 验证

- Worker 单元测试证明连续三次 `unavailable` 后第四次使用同一幂等 mutation 成功，Run 正常结束。
- Worker 单元测试证明连续四次 `unavailable` 后仍进入恢复并推进 cleanup。
- 执行 Worker 测试、类型检查、格式和 Lint，并通过真实子 Agent 文件读取流程回归。

## 可逆性

该改动不修改数据库结构、持久化协议或既有 receipt。可恢复原退避数组和测试边界，历史数据保持兼容。
