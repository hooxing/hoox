# ADR-0014：PostgreSQL Run Worker 事实源与事务实现

- 状态：已接受
- 日期：2026-07-26
- 决策者：M2 PostgreSQL 实现审阅
- 关联任务：M2 PostgreSQL 生产基线
- 替代关系：无；落实 ADR-0011 的生产持久化边界

## 背景

ADR-0011 已固定双栅栏、ExecutionAttempt、不可变 receipt、Projection CAS、外部副作用许可与 cleanup Saga 的语义，但此前只有内存 Fake，无法证明多进程并发、数据库时钟、事务响应丢失、租户 RLS 和最小权限在真实 PostgreSQL 中成立。

本阶段不实现队列 scheduler、Outbox consumer 或真实恢复巡检进程，只提供这些进程可以依赖的事实表、索引和事务端口。

## 决策驱动因素

- Worker 崩溃或数据库响应丢失后必须精确判断事务是否提交；
- 旧 Worker 不能只凭内存 token 越过 Run claim 与 Workspace lease；
- Revision、Run 终态、事件、Projection、Outbox 与 receipt 不得出现可见半状态；
- Runtime 角色必须受 FORCE RLS、表/列 ACL 和无 routine 边界约束；
- 首版需要可审计、可测试的实现，不提前引入数据库存储过程和第二套协议。

## 备选方案

### 方案 A：应用层 SERIALIZABLE 事务

共享契约放入独立 `run-contracts` 包，PostgreSQL 适配器在应用层开启 Tenant 事务，锁定完整复合 scope，用数据库时钟完成校验和写入。优点是协议显式、TypeScript 可复用、无 routine 执行权限；代价是 SQL 较长，必须用真实并发测试防止遗漏锁或行数检查。

### 方案 B：数据库函数或存储过程

把 claim、renew 和 mutation 封装为数据库 routine。原子性集中，但会新增 routine 所有权、默认 ACL、`SECURITY DEFINER` 和独立版本管理风险，并与既有“目标 Schema 无 routine”安全基线冲突。

### 方案 C：沿用内存 Fake 或拆成普通 Repository

实现最省，但无法跨进程仲裁，也不能保证 Revision、Run 与 receipt 原子提交，只适合契约测试，不构成生产事实源。

## 选择

采用方案 A：

- 新增迁移 0004，保存不可变执行输入、Attempt、双栅栏事实、事件、Projection、Sandbox registry、cleanup/lifecycle unknown/alert Outbox、EffectInvocation、一次性 permit 和 mutation receipt；
- claim、renew、permit 和 mutation 使用数据库时钟；claim/mutation 使用 `SERIALIZABLE`，并对聚合根与栅栏行加锁；
- 初始化发生唯一键冲突后必须锁定已有输入并比较完整 scope、文本、回答、Projection 与摘要；只有逐字段相同才是幂等重放，否则返回显式 conflict；waiting 回答使用 Run version 与旧回答 CAS，禁止无条件覆盖；
- mutation receipt 保存完整不可变结果快照。COMMIT 后响应未知时只返回 `response_unknown`，调用方按原 scope 与幂等键读回，不重构或猜测结果；
- Revision、Workspace head、Run/Attempt 终态、事件、Projection、Outbox 和 receipt 在同一事务中提交；
- cleanup 只允许 `pending → started → completed|unknown`，`armed` 和身份永久不变，disposition 只能在 started 首次决定；
- EffectInvocation 以 Attempt+callId 永久唯一；permit 同时绑定双栅栏、Attempt version、调用参数摘要与数据库有效期，并且只能消费一次；
- `model_start` 只有在数据库已持久化 `model_execution_started` checkpoint 后才能签发，并以 Attempt 级部分唯一索引保证永久最多一次；
- Run claim 的 Workspace epoch 通过复合外键绑定不可变 fence，实时 lease 再以相同 root+epoch JOIN；permit 通过复合外键继续绑定原 claim 身份；Sandbox registry 通过复合外键绑定 Attempt 的 run/thread/workspace/root；
- 端口在事务前检查事件、Outbox、Projection、标识和摘要，数据库对 JSON/receipt/result snapshot 与标识字节长度再次 CHECK，防止其他 SQL 调用方绕过；
- Runtime 角色不拥有 Schema，不可 BYPASSRLS；事实表启用 FORCE RLS，追加事实不授予 UPDATE/DELETE，只对状态列授予最小 UPDATE；目标 Schema 不创建 routine；
- 普通 Worker 不越过 running Run。双租约过期后只能由恢复协调器调用恢复端口。

共享执行端口从 `agent-worker` 应用目录移到 `@cube-runtime/run-contracts`，避免 persistence 反向依赖应用。原应用路径只保留兼容导出。

## 理由

真实 PostgreSQL 集成测试已证明迁移、并发 claim、FORCE RLS、最小 ACL、无 routine、同键异摘要、callId 永久唯一、permit 一次性消费、cleanup 单调推进、租约过期恢复，以及 Revision 终态 COMMIT 响应丢失后的精确读回。应用层事务保留了 ADR-0011 的完整协议，又没有扩大数据库可执行代码和角色权限面。

## 影响

### 正面影响

- Worker、API/调度器和后续恢复进程可以共享稳定端口与事实表；
- 故障恢复依赖不可变事实，不依赖 Pi Session 或单机内存；
- PG 与 Fake 可以对同一命令/receipt 契约做差异测试。

### 负面影响与成本

- mutation SQL 涉及多个事实表，后续扩展必须同时维护 receipt、ACL、迁移和故障测试；
- SERIALIZABLE 冲突当前以稳定 unavailable/busy 结果交给上层重试，后续需要按指标决定是否加入有限重试；
- 尚无 Outbox consumer，pending/started 行只能作为恢复事实，不能宣称后台清理已经自动完成。

### 安全、数据与运维影响

- 0004 写入生产数据后，直接 down 会丢失执行审计与恢复事实，只允许测试环境显式 down；
- 运维需要监控过期未恢复 Attempt、started/unknown cleanup、lifecycle unknown、permit 过期和 runtime alert 积压；
- 输入与 Projection 可能含用户内容，日志不得输出行内容或数据库异常私有信息。

## 验证

- 两个真实 PG 连接并发 claim，恰好一个成功；
- mutation 同事务验证版本、事件序列、Projection CAS、Revision+Run 终态和完整 receipt；
- COMMIT 后故障注入返回 `response_unknown`，原 scope+key 读回相同结果；
- 同幂等键不同摘要、重复 callId、重复 permit 签发/消费均 fail closed；
- 相同初始化命令返回 already_exists，不同输入返回 conflict；waiting 回答的错误 Run version 或旧值返回 conflict；
- cleanup 身份、armedAt、disposition 与状态迁移不可回退；
- 租约过期前普通 claim 返回 busy，过期后仍只返回 recovery_required；恢复协调器收敛状态并释放 lease；
- 跨 Tenant 查询不可见、跨 Tenant 更新影响零行；Runtime 无 DDL、DELETE 追加事实、危险列 UPDATE 或 routine EXECUTE 权限；
- migration up/down/up、Windows 全量测试和 Linux 容器测试通过。

## 可逆性与回退

合并前可删除 0004 与适配器并恢复应用内端口。生产写入后不允许自动 down；回退应用时保留表和只读诊断能力，先停止新 claim，待活跃租约过期并完成恢复审计，再部署兼容旧版本。若要删除表，必须先导出 receipt、事件、registry 和 unknown/alert 事实。

## 后续工作

- 实现 cleanup Outbox consumer、恢复扫描器及抢占/重试指标；
- 为 SERIALIZABLE 冲突、积压和 unknown 生命周期建立告警阈值；
- API/调度器接入 `PgRunExecutionSetup`，完成 waiting 回答与唤醒链路；
- 在生产连接池演练数据库中断和恢复，不改变本 ADR 的稳定结果语义。

## 实施记录

- 决定不使用数据库 routine：安全基线优先，所有状态变化由受 RLS/ACL 约束的应用事务完成；
- 决定将共享端口抽成独立包：解除 persistence 对 app 的反向依赖；
- 决定本阶段不消费 Outbox：只实现持久事实和单调状态机，避免把后台调度范围混入事务基线。
