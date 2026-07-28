# ADR-0041：Worker 停机与工具拒绝的失败关闭边界

- 状态：已接受
- 日期：2026-07-28
- 关联：ADR-0011、ADR-0016、ADR-0031、ADR-0035、ADR-0040

## 背景

Agent Worker 的进程停止信号曾复用业务取消端口。在途 Run 因部署、终端信号或进程关闭而中止时，
RunWorker 会把它提交为用户 `cancelled`，改变了没有发生过的业务事实。Polling 在 claim 返回后发现
进程已经停止时，又用零延迟 defer；真实 PostgreSQL 端口要求最小一秒，异常被吞掉后只能等待 dispatch
claim lease 自然到期。

四个 Sandbox 工具则先在 durable 包装外领取许可并检查 continuation。许可被拒绝或本地 continuation
过期时，Pi 虽会生成内存错误，但已落库的 `tool_call` 没有经过 Trace Blob 与 Rollout `tool_result`
形成配对；如果后续 Observation 持久化失败，Pi 还可能抢先进入下一模型轮次。模型配置也只分别检查
两个正整数，没有约束最大输出预算不超过上下文窗口。

## 备选方案

1. 继续复用业务取消并依赖运维区分来源；工具拒绝只保留 Pi 内存错误。实现简单，但会伪造 Run 终态，
   并留下不可恢复的 Rollout 非配对事实。
2. 停机时等待所有在途 Run 自然完成，直到进程关闭总超时；工具拒绝时删除已写入的 `tool_call`。
   等待不能保证有界，删除又违反 Rollout 只追加事实源。
3. 为进程停机建立独立信号，停机只中止内存执行并把 Attempt 交给恢复语义；关闭后的 dispatch claim
   使用与 PG 一致的最小 defer。把授权与 continuation 检查纳入统一 Tool durable 包装，拒绝也写固定失败
   回执；任何 Trace/Rollout 未收敛都设置同步模型轮次闩锁。启动时同时验证模型预算交叉不变量。

## 选择与理由

采用方案 3。用户取消仍来自业务取消端口或 PostgreSQL Run 状态；进程停机使用独立信号和稳定
`WORKER_SHUTDOWN` 恢复码，只允许 Attempt 进入 `recovery_required` 并释放双栅栏，不推进 Run 到
`cancelled`。已武装的 Sandbox cleanup Outbox 继续由恢复消费者收敛；尚未武装但已取得的 Sandbox
仍走孤儿清理。

关闭后返回的 dispatch claim 用 `retryAfterMilliseconds=1000` defer，与 PostgreSQL 端口的下限一致。
四个 Sandbox 工具的授权、continuation 检查与远端调用全部处于 `toolResult` 的受控失败包装内；失败
正文固定编码，不包含数据库、Sandbox 或取消原因。Trace Blob 或 Rollout `tool_result` 返回
conflict/unavailable/unknown 时，Worker Session 设置恢复码，并在任何下一次 Provider 请求的同步入口
拒绝继续。`MODEL_MAX_OUTPUT_TOKENS` 大于 `MODEL_CONTEXT_WINDOW` 时，进程在装配外部依赖前拒绝启动。

## 影响

- 进程滚动停止不会伪造用户取消；相应 Attempt 需要恢复协调器按已有 checkpoint 收敛。
- Tool 拒绝会多写一份固定失败 Trace 与配对 Rollout 事实，Blob/PG 写放大是可接受成本。
- Observation 失败后的 Provider 请求会被本地闩锁阻断；调用方只得到恢复语义，不能得到普通成功。
- defer 最短一秒会稍微延后关闭竞态中的重新投递，但避免无效 ack 和完整 dispatch lease 延迟。
- 模型预算相等仍合法；只有明显自相矛盾的配置在启动时失败。

## 验证

- RunWorker 故障注入在模型在途时触发进程停机，断言 Session 被中止、Attempt 为
  `recovery_required`、Run 保持 `running`，且所有 mutation 均无 `nextRunStatus=cancelled`；业务取消测试
  继续断言真正的 `cancelled`。
- Polling 测试让 claim 在关闭后返回，断言不执行 Worker，并以 1000 毫秒 defer 确认。
- 四个 Sandbox 工具分别覆盖许可拒绝和 continuation 过期，断言不触碰 Sandbox 且记录固定失败回执；
  PiWorkerSessionFactory 测试断言 Trace Blob、`tool_call/tool_result` 配对及下一 Provider 轮次未发生。
- 进程配置测试覆盖输出预算大于窗口时拒绝、等于窗口时接受。
- 运行 Worker/Pi/context/persistence、process runtime 测试及 format、lint、typecheck 门禁。

## 可逆性与回退

代码和配置检查可在未部署时直接回退，不涉及数据库迁移。部署后已写入的恢复 Attempt、Trace Blob 与
Rollout 事实都是只追加审计记录，不得删除或改写；回退只能让恢复协调器按原协议收敛。若未来引入显式
draining/requeue 状态，可新增 ADR 和迁移替代 `WORKER_SHUTDOWN`，不能重新把停机映射为业务取消。

