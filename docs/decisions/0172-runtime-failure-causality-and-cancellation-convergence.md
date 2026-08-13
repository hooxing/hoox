# ADR-0172：运行失败根因与取消信号必须有界收敛

## 背景

真实 Runtime 批量执行暴露出四类可用性问题：API 已将 Run 标记为 cancelled，但生产 Worker 只能等待租约心跳发现；PostgreSQL COMMIT 回包未知后仅做一次读回，远端端口映射连续重置时会把已提交事实误判为不可恢复；Pi 会把 Runtime 本地续轮阻断包装成 assistant error，旧映射误报为 Provider 故障；业务失败后的 Sandbox 清理不确定会用 `SANDBOX_UNKNOWN` 覆盖原始错误码。

这些问题不改变 Agent 功能能力，却会让任务长时间占用 Worker、产生错误归因或掩盖首要故障，直接影响日常可用性和排障质量。

## 决策

1. 生产 Worker 为每个活跃 Run 建立有界数据库取消轮询，观察到 `runs.status=cancelled` 后中止当前 Session；Run 结束时显式释放轮询资源。数据库探测失败不伪造取消，租约心跳继续承担 fail-closed 责任。
2. RuntimeMutation 返回 `response_unknown` 时，在完整 ExecutionScope 下最多执行四次幂等读回。`not_found` 与 `unavailable` 都不证明事务未提交；耗尽后仍保持 `response_unknown`。Tool Observation 写入发生未知结果时，也以同一个冻结命令和幂等键执行四次带退避重放，禁止在重试中改写正文或身份。
3. `MODEL_CONTINUATION_REJECTED` 与 `PROVIDER_BINDING_DRIFT` 属于 Runtime 本地协议阻断，统一投影为 `PROTOCOL`，不再归责 Provider。
4. 已有业务失败码进入 Sandbox 清理后，清理 UNKNOWN/FAILED 只写入持久补偿事实，不覆盖首要失败码。没有首要业务失败时，仍使用 `SANDBOX_UNKNOWN` 或 `SANDBOX_FAILED`。

## 备选方案

- 只依赖 Worker 心跳发现取消：实现简单，但取消延迟受心跳和 durable lane 阻塞影响，已被真实运行证明不足。
- 对未知 COMMIT 重新执行写事务：命令虽有幂等键，但扩大了写侧重放面；只读收敛更容易审计。
- 始终以清理错误作为终态码：有利于提醒资源风险，但会丢失导致清理发生的原始故障，不利于定位首因。补偿 Outbox 已能独立表达清理风险。

## 影响与验证

- 每个活跃 Run 增加一次按 Worker poll interval 执行的轻量只读查询；Run 完成后立即释放。
- PostgreSQL 短暂连接重置时，已提交的 mutation 与 Tool Observation 有更高概率在当前 Attempt 内收敛，避免工具完成后因观察事实暂时不可读而阻断下一次模型请求。
- 错误事件与恢复码保留首因，Sandbox 清理消费者仍可依据 durable Outbox 重试。
- 自动化测试覆盖数据库取消传播与释放、未知 COMMIT 首次读回失败后的收敛、Tool Observation 连续连接重置后的同键收敛、本地续轮错误分类，以及业务失败叠加 cleanup UNKNOWN 的根因保留。

## 可逆性

取消轮询、读回次数和错误优先级都位于 Worker/Adapter 边界，不改变数据库结构或已持久化协议，可分别回退。
