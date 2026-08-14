# ADR-0173：外部效果许可消费的瞬时故障收敛

- 状态：已接受
- 日期：2026-08-14

## 背景

Agent Worker 在 `tool.started` 持久化后签发并消费一次性外部效果许可，只有消费成功才允许模型工具越过副作用边界。一次真实运行中，许可已经签发，但 PostgreSQL 会话在消费阶段瞬时失败；存储层把异常统一映射为 `unavailable`，Worker 因而把整个 Attempt 转为 `recovery_required`。模型响应和 Sandbox 均正常，目标命令尚未真正开始。

原实现只重试 PostgreSQL 明确回滚的 SERIALIZABLE/deadlock 事务。连接重置不会重试，`COMMIT` 已提交但响应丢失时也无法按许可事实读回；同时恢复终止只释放栅栏，没有把普通 Sandbox 的 pending cleanup 推进为可消费状态。

## 约束

- 不确定的外部工具调用绝不能重放。
- 数据库许可消费本身是幂等状态转换，可以在确认没有越过工具副作用边界时重放。
- 独立的第二次消费必须继续返回 `already_consumed`，不能借恢复逻辑再次放行。
- `recovery_required` 不能同步调用远端 Sandbox；清理必须交给持久化 Scheduler。
- 开发环境的 PostgreSQL、CubeSandbox 和 MinIO 仍由外部端口映射提供，不引入 Docker 启动依赖。

## 备选

1. 任意数据库错误都立即中止。安全但对短暂连接抖动过于敏感，正是本次故障来源。
2. Worker 收到 `already_consumed` 一律视为成功。实现简单，但独立重放会获得第二次副作用授权。
3. 在单次存储调用内部有界重试瞬时连接错误；若本次调用见过 `COMMIT` 结果未知，仅将随后精确读回的同一已消费许可收敛为成功。

## 决策

选择方案 3：

- 许可消费对连接类瞬时故障执行总计不超过 875ms 的有界退避重试；约束、协议和其他未知错误不重试。
- `COMMIT` 响应未知后，在同一次方法调用内重新锁定并严格核对 scope、Attempt version、双栅栏和许可全部不可变字段；读到 `consumed_at` 才返回 `consumed`。
- 未经历提交未知的独立调用仍返回 `already_consumed`。
- Worker 因持久化不可用或停机进入恢复时，在同一终止事务中把普通 Sandbox cleanup 从 `pending` 推进为 `started/close` 并释放栅栏，供 Scheduler 领取。
- README 明确把 Scheduler 列为本地完整运行拓扑的必需进程。

## 影响

短暂 PostgreSQL/端口映射抖动不再立即中断正在执行的 Agent；提交结果未知不会误判失败，也不会扩大工具副作用权限。持续超过重试预算的数据库故障仍会安全进入 `recovery_required`。普通 Sandbox 能在恢复事实提交后立即进入异步清理，但 Scheduler 未运行时仍会保留 durable 待办而不会私自调用远端。

## 验证

- Worker 单元测试覆盖许可消费不可用后 Attempt 恢复事实与 cleanup `started/close` 同时提交。
- PostgreSQL 集成测试注入消费 UPDATE 的一次 `ECONNRESET`，验证有界重试后成功。
- PostgreSQL 集成测试在真实 COMMIT 成功后丢弃客户端响应，验证同一次调用读回成功，而后续独立消费仍返回 `already_consumed`。
- 执行受影响包的格式、Lint、类型检查和测试。

## 可逆性

该改动不修改数据库结构。可以回退重试和读回逻辑；已经消费的许可与 cleanup 状态仍符合原有状态机，不需要数据回滚。
