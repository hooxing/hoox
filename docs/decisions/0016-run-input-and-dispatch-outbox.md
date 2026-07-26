# ADR-0016：Run 输入与 Dispatch Outbox

- 状态：已接受
- 日期：2026-07-26
- 决策者：M3 Run 输入与调度闭环实施

## 背景

此前 API 可创建 queued Run，但没有持久化用户输入和可靠的 Worker 投递边界。直接由 HTTP 请求调用 Worker 会在数据库提交、网络超时和服务重启之间丢失或重复执行。

## 决策

1. `CreateRunRequest.input` 的上限定义为 **1,048,576 UTF-8 字节**。TypeBox 字符数只防止校验器耗尽；API 使用 `Buffer.byteLength`，PostgreSQL 使用 `octet_length`，两层共同执行该契约。
2. 请求哈希绑定 `threadId + input`。同一幂等键只有完全相同的请求可重放；不同输入固定冲突。
3. `PgRunDispatchCreation` 在一个 Tenant 事务内按 Membership→Thread→Workspace 锁序重验 active 状态、锁定 Workspace 原始 head，并原子写入 queued Run、`run_execution_inputs`、`run_dispatch_outbox` 与 API 幂等记录。COMMIT 响应未知时只按原幂等键读回，绝不猜测重写。
4. Scheduler 用短事务 `FOR UPDATE SKIP LOCKED` 领取 Outbox，以 `generation + claimToken + lease` 作为确认栅栏；事务返回后才调用 `RunExecutionStarterPort.execute`。失败、busy 和异常 defer；waiting/terminal/取消安全终结投递。Worker 本身仍负责 Attempt 级幂等。
5. Scheduler 的 Outbox 端口每次必须携带可信 Tenant scope。首版不引入跨租户 BypassRLS 扫描器；租户枚举/全局调度是后续有单独安全设计的能力。

## 取舍

- 选择 Outbox 而非数据库事务内调用 Worker，避免长事务、锁泄漏和外部副作用与 COMMIT 顺序倒置。
- 选择至少一次投递而非“恰好一次”传输承诺；网络结果未知时允许重投，但由 Run/Attempt 的持久化唯一性收敛。
- 不在本阶段实现 cleanup、Artifact、SSE 或真实模型；这些不应借用 Dispatch Outbox 的权限边界。

## 安全与验证

- 新表 FORCE RLS、复合外键、精确 Runtime 表/列 ACL，且没有函数、触发器或 routine；
- 关键日志只记录稳定错误码和标识，不记录 input、配置或异常 cause；
- 迁移必须支持 development/test 的 up/down 往返；
- 真实 PG 集成应覆盖双连接同键首次创建、COMMIT 响应丢失、租约崩溃重领、迟到确认、取消与跨租户 ACL。
