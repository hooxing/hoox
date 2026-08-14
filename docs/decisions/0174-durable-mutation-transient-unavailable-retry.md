# ADR-0174：Durable mutation 瞬时不可用的同命令重试

- 状态：已接受
- 日期：2026-08-14

## 背景

修复外部效果许可消费后，一次包含大量流式事件和子 Agent 操作的真实 Run 在第 1370 个事件前再次中断。数据库显示 `todo.updated` 已作为 version 1384 提交，但随后 `tool.completed` 对应的 mutation 没有 receipt；Worker 等待一次 5 秒连接后收到 `unavailable`，立即关闭事件入口并把 Attempt 转为 `recovery_required`。

Worker 的通用 `applyMutation` 已能处理 `response_unknown`：当 COMMIT 结果不确定时按幂等键读回。但 `unavailable` 表示事务明确没有提交，原实现没有重试。UU 端口映射或 PostgreSQL 连接池的单次瞬时抖动因此会终止已经运行数分钟的任务。

## 约束

- `response_unknown` 与 `unavailable` 的语义必须保持分离：前者只能读回，后者才允许重放。
- 重放必须使用同一个已计算的 command、幂等键、摘要、Attempt version 和事件 sequence。
- 重试期间必须继续占用 durable lane，禁止 heartbeat、其他事件或许可插入。
- 有界等待不能接近默认 30 秒租约，否则会因恢复连接反而造成 fence 过期。
- 持续数据库故障仍必须失败关闭，并把普通 Sandbox 转交 Scheduler 清理。

## 决策

- `applyMutation` 对返回或抛出的 `unavailable` 使用 25ms、100ms 两次退避，总共最多尝试三次。
- command 在第一次调用前构造一次，后续只重放同一对象，不重新读取或推进本地 version/sequence。
- 任一次返回非 `unavailable` 后立即沿用原有状态机；`response_unknown` 继续只走幂等 receipt 读回。
- 三次均不可用时返回最后的 `unavailable`，由现有失败边界进入 `recovery_required`。

## 影响

单次或短暂 PostgreSQL/端口映射连接失败不会再中断流式事件、Todo、Thread Context、终态或 Sandbox checkpoint。最坏情况下三次数据库连接等待约 15 秒，仍低于默认 30 秒租约；持续故障不会无限重试。

## 验证

- Worker 单元测试证明首个流式事件 mutation 单次 `unavailable` 后以同一幂等键重试并完成 Run。
- Worker 单元测试证明连续三次 `unavailable` 后仍中止，并原子推进 cleanup `started/close`。
- 执行 Worker 类型检查、完整单元测试、格式和 Lint。

## 可逆性

该改动不修改数据库结构或持久化协议。可直接删除重试循环恢复旧行为；已经写入的 receipt 与事件保持完全兼容。
