# ADR-0069：Thread Sandbox Session 生命周期实施边界

- 状态：已接受（阶段 5）
- 日期：2026-07-31
- 关联：实施总计划阶段 5、ADR-0063、ADR-0064、ADR-0066、ADR-0068
- 范围：Thread/Workspace Sandbox Session、lease、effect、handoff、pause/resume、冷恢复
- 不包含：旧 Thread 回填、灰度策略优化、固定长期 retention、Sandbox 作为 Context 事实源

## 背景

阶段 1 至 4 已完成 Thread 单写者、Run 激活时延迟绑定、Thread Context 与 Runtime Compaction。
现有 Sandbox registry 仍绑定 Attempt：成功先远端 close 再提交 Run terminal，waiting 才 pause；它无法在
terminal 的同一 writer 事务里判断下一 Run，也无法安全表达 pause/resume/terminate 的 UNKNOWN。

ADR-0066 冻结了产品状态机，但 retention、Provider TTL、状态查询能力和具体事务协议仍是提议，不能直接
当成实现规范。本 ADR 记录阶段 5 的可部署选择。

## 备选与理由

- 备选 A：继续沿用 Attempt 级 registry，success close、waiting pause。改动最小，但无法在 terminal
  事务内完成 Thread handoff，也不能证明下一 Run 接管的是相同 revision/generation，因此不满足阶段 5。
- 备选 B：把 Provider 的 running/paused 状态当作主事实，数据库只保存 provider ID。实现较薄，但远端
  调用 UNKNOWN、进程崩溃和跨 Tenant 重放都缺少可审计 CAS，且会让 Sandbox 取代 Workspace/Context
  事实源，因此拒绝。
- 备选 C：同时实施旧 Thread 回填、长 retention 和配额优化。它会把未取得真实指标的参数固化，并扩大
  回滚面，属于阶段 6，不在本轮实施。
- 选择：采用数据库 Session/lease/effect 状态机、原子 terminal handoff 和 Feature Flag 双路径。代价是
  增加三张表与 Scheduler 对账，但能在不改变长期事实源的前提下失败关闭，并保留关闭 reuse 的回退路径。

## 选择

1. 迁移 `0025` 新增 `thread_sandbox_sessions`、`thread_sandbox_leases` 和
   `sandbox_lifecycle_effects`。旧 `sandbox_registry`/`cleanup_outbox` 不改名、不回填；Feature Flag
   关闭时继续使用旧 create/close 与 waiting recovery。
2. Session 绑定 Tenant、Thread、Workspace、registry、provider ID 和单调 generation。可复用状态为
   `running | pausing | paused | resuming`；`unknown` 被隔离，允许新 generation cold rebuild，但禁止
   再使用原 provider ID；provider ID 在单一 Provider 账号对应的数据库中全局唯一，跨 Tenant 或
   generation 重放由数据库直接拒绝。
3. 同一 Session 只有一个 `released_at IS NULL` lease；同时限制同一 Run 只有一个未释放 Session lease。
   handoff 先释放旧 lease，再为已激活的下一 Run 建立无 Attempt 的 lease；新 Worker claim 后用 token、
   epoch、Run、Attempt、Tenant、Thread、Workspace 全量 CAS attach。
4. Run terminal 前先进入 `finalizing` checkpoint。最终 RuntimeMutation 依次提交 Workspace、Thread
   Context、Run/Attempt/fence 和 Thread FIFO 决策，然后才在同一事务内：有下一 active Run 则 running
   handoff；无下一 Run或 waiting 则释放 lease、写 pause effect 并把 Session 置为 `pausing`。Worker
   不能在事务外预读队列。
5. pause 外部调用发生在 terminal commit 之后。成功 receipt 把 Session 置为 paused 并写 retention；
   超时、进程崩溃或结果不明只把 effect/Session 置为 unknown，不回滚已经提交的 Run、Workspace 或
   Context。Scheduler 消费未执行的 durable effect，并对已越过 remote marker 的 effect 只查询对账。
   create 同样先取得有期限的 effect claim 并写 remote marker；claim 到期后旧 generation 固化为 unknown，
   新 generation 才能 cold create，避免崩溃重放同一次不确定 create。
6. queued handoff 的下一 Worker 重新 `connect` 同一 provider ID。paused Session 先持久化
   `paused → resuming` effect，再 connect；明确 NOT_FOUND 标记 terminated 并 cold create；结果不明
   进入 unknown。`pausing/resuming` 的竞争输入有界等待持久 receipt，不取消进行中的 pause。
7. 只有 materialization attestation 同时满足 Tenant、Thread、Workspace、generation、唯一 lease、
   retention 和 `materialized_revision_id IS NOT DISTINCT FROM base_revision_id` 才跳过物化。任何 revision
   不一致或无法证明 clean 的缓存先 terminate，再 cold create；新的 Sandbox 物化成功后才写 attestation。
8. create 固定显式发送 `lifecycle.onTimeout="pause"` 与 `autoResume=true`。该配置只用于 Worker/Scheduler
   异常时的资源兜底，不能替代 terminal pause intent。
9. Scheduler 始终允许收敛已有 lifecycle effects；`THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED` 只控制
   paused 到期是否创建 terminate intent。UNKNOWN 对账通过受控 `listV2` 状态查询：明确 paused 或
   NOT_FOUND 才收敛；明确 running 只把旧 effect 记为未生效并创建新 effect，绝不重放原 effect；无法
   识别的 Provider 状态继续保持 unknown。retention terminate intent 与 Session 隔离在同一事务提交，
   禁止到期 Session 在 terminate 执行窗口重新 resume。
10. success/waiting 使用新 terminal 编排；失败、取消、物化/验证失败会用 Thread lifecycle terminate
    当前可变缓存。旧路径在开关关闭时字节级协议兼容，不读取新表。

## 迁移与部署顺序

固定顺序为：

`0018 writer → 0019 queue → 0020 workspace result → 0021/0022 context → 0023 input → 0024 compaction → 0025 sandbox session`

部署顺序：先迁移并部署能消费 effect 的 Scheduler，再部署兼容 Worker，最后按 Tenant/新 Thread 开启
reuse；retention scheduler 最后单独开启。关闭 reuse 后不得停止 effect reconciler。`0025` 任一表存在
事实时 down 直接拒绝。

## Feature Flag 与可配置参数

- `THREAD_SANDBOX_SESSION_REUSE_ENABLED=false`：控制新 Worker 是否使用 Thread lifecycle；依赖串行队列
  和 V2 Context write/read。
- `THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED=false`：只控制 paused 到期回收。
- `CUBESANDBOX_SESSION_TTL_SECONDS=120`：create/onTimeout TTL 灰度起点；当前代码允许的 1～86400
  只是已验证候选范围，不是 Provider 永久承诺。
- `THREAD_SANDBOX_PAUSED_RETENTION_SECONDS=600`：paused retention 灰度起点，不是产品常量。
- `THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS=90000`：pause/connect/query 的调用与过渡等待上限。

Tenant 配额、最大 paused 快照大小、长 retention、退避次数、Provider 最大 TTL、平台版本能力矩阵和
更细 manifest 漂移校验仍是待决项，阶段 6 只能依据真实指标调整，不能把上述样例值固化为永久规则。

## Test Gate

- migration 契约验证三个事实表顺序、部分唯一 lease、RLS、unknown 隔离和非空 down 拒绝；
- Worker 自动化验证 success 先提交 terminal intent、不走旧 close；pause UNKNOWN 不回滚业务终态；
- running handoff 验证同一 Session、revision attestation 命中时跳过物化且不 pause；
- Gateway 验证 `onTimeout=pause`、`autoResume=true` 和配置 TTL 原样进入 SDK create；
- lifecycle consumer 验证 remote marker 早于副作用、UNKNOWN 不重放、running 只产生新 intent、
  NOT_FOUND 收敛 terminated；
- PostgreSQL 集成 Gate 必须验证 terminal 与 follow-up 并发只有 handoff 或 pause-intent 两种结果、
  未释放 lease 唯一、跨 Tenant/provider ID 重放失败。没有真实 PostgreSQL 环境时不得把该项标为已运行；
- 真实 CubeSandbox Gate 继续记录 pause/connect/terminate 延迟、paused retention 和 query 状态；
  未识别状态必须保持 unknown。

## 影响与可逆性

新表和 effect consumer 增加了状态机与运维成本，但 Workspace Revision、Thread Context、Blob 与 Artifact
仍是长期事实源；Sandbox 丢失只影响延迟。代码可关闭 reuse/retention 回到旧路径，已有 effect 必须继续
收敛。含 lifecycle facts 的 schema 不允许破坏性回退；待所有新 Session terminated 后才能另行 ADR 讨论
删表。
