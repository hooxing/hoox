# ADR-0016：Run 输入与 Dispatch Outbox

- 状态：已接受
- 日期：2026-07-26
- 决策者：M3 Run 输入与调度闭环实施

## 背景

此前 API 可创建 queued Run，但没有持久化用户输入和可靠的 Worker 投递边界。直接由 HTTP 请求调用 Worker 会在数据库提交、网络超时和服务重启之间丢失或重复执行。

## 决策

1. `CreateRunRequest.input` 的上限定义为 **1,048,576 UTF-8 字节**。TypeBox 字符数只防止校验器耗尽；API 使用 `Buffer.byteLength`，PostgreSQL 使用 `octet_length`，两层共同执行该契约。
2. 请求哈希绑定 `threadId + input`。同一幂等键只有完全相同的请求可重放；不同输入固定冲突。
3. `PgRunDispatchCreation` 在一个 Tenant 事务内按 Membership→Thread→Workspace 锁序重验 active 状态、锁定 Workspace 原始 head，并原子写入 queued Run、`run_execution_inputs`、`run_dispatch_outbox` 与 API 幂等记录。初始 Projection 固定为已校验的受控空上下文，并持久化 canonical digest；Claim 在创建 Attempt 前再次校验 Projection 与 digest。
4. 幂等表保持 `SELECT/INSERT` 最小 ACL：首个同键请求通过事务级 PostgreSQL advisory lock 串行化，再读回记录；不使用 `SELECT FOR UPDATE`，从而不为了行锁增加 `UPDATE` 权限。COMMIT 响应未知或提交后响应丢失时只按原幂等键读回，绝不猜测重写；读回发生在父 Thread 状态检查之前，归档不影响已提交命令的重放。
5. Scheduler 用短事务 `FOR UPDATE SKIP LOCKED` 领取 Outbox，以 `generation + claimToken + 未过期 DB lease` 作为确认栅栏；事务返回后才调用 `RunExecutionStarterPort.execute`。确认时锁定 Run 并验证 outcome 与状态一致，迟到 ack 是 no-op。失败、busy 和异常 defer；waiting/terminal/取消安全终结投递。Worker 本身仍负责 Attempt 级幂等。
6. Scheduler 的 Outbox 端口每次必须携带可信 Tenant scope。首版不引入跨租户 BypassRLS 扫描器；租户枚举/全局调度是后续有单独安全设计的能力。
7. 本 ADR **不**签发可部署的 production Scheduler。仓库尚没有受信的 `RunExecutionStarterPort` 具体实现；`startServiceProcess` 因而继续在 production 环境拒绝任意注入的 assembler、Fake 或空消费者。后续纵向 composition 必须封闭构造真实 PG Outbox、可信 Worker dispatch client 及其不可伪造 capability，才可解除该合并门禁。
8. HTTP Service 在读取到 Thread 后先委托原始命令端口按 `tenant + user + operation + key + requestHash` 查询回放，再执行 `createRun` 的 active Thread 校验：同键同载荷永远返回既有 Run，归档不改变其结果；同键异载荷固定为 409。该查询仅限可信 scope 的同一用户记录，不能作为跨租户或枚举接口。
9. Worker、持久化和 Pi 共享同一 `ControlledRolloutProjection` UTF-8 校验；不得在 Worker 再维护按 JavaScript code unit 计量的副本。数据库同时用 POSIX `[:space:]` 拒绝 tab/newline 等受限 SQL 直写空白，Unicode 空白的精确产品语义继续由 JavaScript `trim` 在端口边界收敛。

## 取舍

- 选择 Outbox 而非数据库事务内调用 Worker，避免长事务、锁泄漏和外部副作用与 COMMIT 顺序倒置。
- 选择至少一次投递而非“恰好一次”传输承诺；网络结果未知时允许重投，但由 Run/Attempt 的持久化唯一性收敛。
- HTTP body 上限覆盖最坏六倍 JSON 转义 wire body；真正的配额永远以解码后 UTF-8 字节数为准，trim 后为空一律拒绝。
- Outbox 不复制 `base_revision_id`，只从不可变 `run_execution_inputs` 读取，并以 NULL-safe 语义传递，避免出现两个可分叉的 base head 事实源。
- 不在本阶段实现 cleanup、Artifact、SSE、真实模型或 production Scheduler composition；这些不应借用 Dispatch Outbox 的权限边界。

## 安全与验证

- 新表 FORCE RLS、复合外键、精确 Runtime 表/列 ACL，且没有函数、触发器或 routine；
- 关键日志只记录稳定错误码和标识，不记录 input、配置或异常 cause；
- 迁移必须支持 development/test 的 up/down 往返；
- 真实 PG 集成应覆盖双连接同键首次创建、COMMIT 响应丢失、租约崩溃重领、迟到确认、取消与跨租户 ACL。
