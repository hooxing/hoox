# ADR-0142：动态 Worker Tenant 分配与团队任务调度

- 状态：已接受（试验版）
- 日期：2026-08-10
- 决策者：Runtime 团队
- 关联任务/PR：`codex/team-edition-prototype`
- 替代关系：替代 ADR-0049 中“`AGENT_WORKER_TENANT_ID` 作为单一 durable dispatch 分片边界”的结论；细化 ADR-0011、ADR-0016 与 ADR-0139；不替代 ADR-0054 的生产安全约束

## 背景

Agent Worker 原先在启动时读取唯一的 `AGENT_WORKER_TENANT_ID`，之后每次只在该 Tenant 的 RLS 事务中领取 `run_dispatch_outbox`。个人空间与开发 Worker 都配置为 `tenant_a` 时，这条链路可以工作；团队版由 API 动态创建团队 Tenant 后，团队 Run 和 dispatch 已经在团队事务中成功提交，但没有任何 Worker 会进入该 Tenant 领取它们，因此任务会一直显示“排队”。这不是 Run 状态机或模型容量问题，而是固定消费分片无法发现运行期新增 Tenant。

ADR-0016 明确禁止通过跨租户扫描业务 Outbox 来补这个缺口，ADR-0139 也只把动态团队 Tenant 调度列为后续能力。团队数量由用户行为动态增长，如果继续要求每创建一个团队就新增一套环境变量和 Worker 部署，既无法原子覆盖新团队，也会把产品创建流程错误地绑定到运维编排。

## 决策驱动因素

- `run_dispatch_outbox`、Run、Thread、Workspace 等业务事实必须继续受 Tenant FORCE RLS 隔离；
- 新团队 dispatch 提交后必须在同一事实链中产生可恢复的唤醒，不能依赖重启 Worker 或人工补配置；
- Tenant 的发现、公平分配不能成为模型执行期间的 Tenant 级互斥锁；
- dispatch 至少一次投递与 Run/Workspace 双栅栏语义不得因动态路由而放宽；
- 团队解散必须主动终止调度事实，不能在 Membership 撤销后形成无法读取业务表的重试热循环；
- 全局 Tenant 发现必须由数据库可验证的独立身份授权，不能把任意会话参数当作权限边界。

## 备选方案

### 方案 A：每个 Tenant 部署固定 Worker

保留既有 `AGENT_WORKER_TENANT_ID` 分片，RLS 边界直观，也不需要全局发现表。但创建或加入团队后必须等待外部部署系统同步创建消费者；团队删除、弹性伸缩和故障转移都会产生额外编排状态，遗漏一次就会永久排队。它适合少量静态租户，不适合产品内动态创建团队。

### 方案 B：Worker 全局扫描业务 Outbox

给 Worker 的运行角色授予 BYPASSRLS，或为 `run_dispatch_outbox` 增加跨租户读取策略，可以直接找到所有任务。实现最短，但会把包含 Thread、Run 和重试状态的业务表暴露给全局消费者，并让一次查询、日志或实现错误跨越全部 Tenant，违反 ADR-0016 和最小权限要求。

### 方案 C：无业务载荷的全局 Tenant 控制面，再进入 Tenant RLS 领取 dispatch

增加只保存 Tenant ID、就绪时间和短租约栅栏的控制表。Worker 先在短事务中领取一个 Tenant，再使用普通 Tenant 事务领取该 Tenant 的具体 dispatch。控制面不保存或返回用户输入、Thread、Run、文件和 Workspace 内容，也不跨租户查询业务 Outbox。

### 方案 D：外部消息总线承载 Tenant 路由

可以获得独立的分区、扩缩容和可观测能力，但需要新基础设施、消息与 PostgreSQL Outbox 的双写收敛及额外生产运维。本阶段已有 PostgreSQL durable dispatch，先引入消息总线的成本高于收益。

## 选择

采用方案 C，新增 `worker_tenant_assignments` 作为 Worker Tenant 控制面，并遵守以下边界。

### 唤醒与发现

创建 durable dispatch 的同一 Tenant 数据库事务同时 upsert 对应 assignment 为 `ready`；defer dispatch 时同步记录最早的下一次尝试时间。若 assignment 正被领取，唤醒保留其 `claimed` 状态和更早的 `next_attempt_at`，由本轮 settle 重新计算是否仍有工作，避免覆盖在途栅栏或丢失唤醒。

0042 上线时不允许旧版写入进程与新版动态 Worker 长时间混跑：先停止接受旧版 Run 创建并排空创建事务，再应用迁移和回填，随后启动同时写 assignment 的新版 API 与 Worker。迁移提交后若仍由旧版代码新增 Outbox，该写入没有 assignment 唤醒且不会被全局扫描自动发现；发生这种异常混跑时必须停止写入并执行受审的补回填，不能靠用户重新提交任务。

Worker 的全局 claim 只读取 assignment，按可执行时间和更新时间公平选择一个 Tenant，并写入 `generation + claimToken + workerId + leaseExpiresAt`。租约到期可被其他 Worker 重新领取；旧 generation 的 settle 必须是 no-op。`AGENT_WORKER_TENANT_ID` 在试验版中只保留为启动兼容和个人 Tenant 的初始唤醒，不再限定 Worker 唯一可消费的 Tenant。

控制面取得 Tenant ID 后，所有实际维护与 dispatch claim 都重新进入 `withTenantTransaction(tenantId)`。禁止把 assignment claim 改成 `run_dispatch_outbox` 的无 Tenant 扫描，也禁止把业务载荷复制到控制表。

### Tenant 租约与执行栅栏

Tenant assignment 租约只覆盖“发现 Tenant → 在该 Tenant 内领取至多一个 dispatch”。无论是否取得 dispatch，都在离开领取阶段时 settle；取得 dispatch 时必须在调用 `RunWorker.execute` 之前释放 assignment，不能让模型、Sandbox 或工具执行占用 Tenant 租约。

动态控制面不替代现有正确性栅栏：

1. assignment 的 generation/token 只防止旧 Worker 覆盖新的 Tenant 分配；
2. dispatch 的 generation/claimToken/数据库租约继续约束 acknowledge，迟到确认不改变新 claim；
3. RunWorker 继续使用 ADR-0011 的 Run/Workspace 双栅栏、Attempt 幂等与外部副作用许可。

因此 assignment 提前释放不会授权两个 Worker 提交同一个 Run。任一进程在 assignment settle 后崩溃，仍由 dispatch 租约和 Run 栅栏恢复，而不是依赖 Tenant 互斥。

### 同团队分支并行

不同团队任务分支是不同 Thread，各自拥有独立的 Thread 执行头和队列。一个 Worker 领取首个分支的 dispatch 后立即释放团队 assignment；另一 Worker 实例即可再次领取同一团队，并取得另一个 Thread 的 active dispatch。动态 Tenant 控制面因此不阻止同团队多分支并行。

同一 Thread 的 follow-up 仍只允许一个 active Run，不能借动态调度绕过单 Thread 串行不变量。单个 polling loop 也仍一次执行一个 Run；真正并行需要多个 Worker 实例或等价的受控并发执行槽。

### 团队解散收敛

团队解散必须在撤销 Membership 之前、同一个 Tenant 事务内完成调度收敛：按既有取消语义取消非终态 Run，终止 `ready`/`claimed` dispatch，并推进 assignment generation、清除 claim 后使其不再就绪，然后才撤销团队目录与全部 Membership。任一步失败都回滚整个解散事务。

不能等下一次 Worker claim 再检查团队是否解散；届时 Membership 已撤销，普通 Tenant 聚合可能无法读取 Run，却会反复 defer 已失去执行条件的 dispatch。旧 dispatch 的迟到 acknowledge 和旧 assignment 的迟到 settle 分别由各自 generation/token 栅栏收敛为 no-op。已经发出的外部请求仍受物理取消窗口限制，但旧 Run/Workspace 栅栏不得再允许其提交业务结果。

### 数据库角色边界

迁移 0042 同时要求独立的 Worker Coordinator 登录角色。普通 runtime role 和 coordinator role 必须是两个不同的 PostgreSQL 身份，应用也使用两个独立连接池：

- coordinator role 不是 superuser、没有 BYPASSRLS，只能全局 `SELECT` assignment，并更新领取栅栏所需的精确列；它没有任何业务 Outbox、Run、Thread、Membership、资源或文件表权限；
- 普通 runtime role 的 assignment RLS policy 仍绑定 `app.tenant_id`，只能在当前 Tenant 内 wake/settle，并继续通过原 Tenant pool 领取具体 dispatch；
- coordinator 的全局 RLS policy 直接绑定数据库角色，不读取 `app.worker_id` 或其他调用方可自行设置的 GUC；
- 两个连接池分别校验 PostgreSQL `current_user`，任一身份不匹配都会在启动探针阶段失败关闭。

角色名由迁移安全上下文传入，迁移只在验证安全标识符和四个数据库角色互异后创建策略。控制面最小权限并不使整个团队执行链自动具备生产闭环；Scheduler 动态化、容量和故障演练仍是独立门禁。

### Scheduler 范围

本次只动态化 Agent Worker 的 Run dispatch。独立 Scheduler 仍由 `SCHEDULER_TENANT_ID` 选择固定 Tenant，其拥有的生命周期对账和后台消费尚未接入 assignment 控制面。因此团队 Run 能被 Worker 执行，不代表该团队所有 Scheduler-owned 恢复路径已经形成生产闭环；Scheduler 动态化必须单独设计、实现和验证。

## 影响

### 正面影响

- API 创建的新团队 dispatch 无需部署新 Worker 即可被现有 Worker 发现；
- 全局发现表不含业务载荷，具体任务读取仍由 Tenant RLS 和 Membership 约束；
- Tenant 租约不包住模型执行，水平扩容后可并行处理同团队的独立 Thread；
- assignment、dispatch 与 Run 各自有独立恢复栅栏，崩溃不会依赖进程内状态收敛；
- 迁移会回填已有 `ready`/`claimed` dispatch，已经排队的团队任务不需要重新提交。

### 负面影响与成本

- 每次 dispatch 创建、defer 和领取都会增加一条控制面写入或短事务；
- assignment 是派生调度事实，必须与 Outbox 的状态转换保持事务一致，并处理丢唤醒、重复唤醒和租约过期；
- 单 Worker loop 仍不能提供任务并行，需要以 Worker 实例数或明确并发槽扩容；
- 部署必须额外管理 Coordinator 的独立登录凭据、连接池、角色探针和最小 ACL；
- Scheduler 仍固定 Tenant，团队版的后台恢复覆盖暂不完整。

### 安全、数据与运维影响

- `worker_tenant_assignments` 只允许最小表/列 ACL，并启用 FORCE RLS；不得向其中增加用户输入、资源路径或签名 URL；
- 应监控每 Tenant 最老 ready dispatch 的排队时长、assignment claim 过期次数、空领取率和 defer 频率，持续空领取或解散团队重复 defer 必须告警；
- assignment 只用于调度，业务事实源仍是 Run、Thread queue 与 `run_dispatch_outbox`；删除 assignment 行不得被解释为删除任务；
- 多 Worker 公平性是可观测目标，不承诺严格轮询顺序。

## 验证

- 迁移契约测试验证 0042 创建控制表、FORCE RLS、claim shape、最小 ACL、已有 Outbox 回填以及成对 down；
- 适配器测试验证原子 wake、最早重试时间、并发 `SKIP LOCKED` claim、租约过期重领、generation/token 迟到 settle no-op，以及 settle 后 `ready`/`idle` 投影；
- Worker loop 测试验证 Tenant claim 失败不碰业务队列、dispatch claim 后且模型执行前 settle、settle 失败不破坏已取得 dispatch 的 Run 栅栏，以及关闭时不启动新执行；
- PostgreSQL 集成测试在至少两个 Tenant 创建 dispatch，证明同一 Worker 可依次消费且查询业务 Outbox 始终带具体 Tenant scope；
- 两个 Worker 的并发测试在同一团队的两个 Thread 创建 active Run，证明二者可同时进入执行，而同一 Thread 的 follow-up 仍串行；
- 团队解散测试证明非终态 Run、dispatch 和 assignment 在 Membership 撤销前收敛，旧 dispatch acknowledge 与旧 assignment settle 均不能复活任务；
- coordinator/runtime 双角色负向 ACL 测试证明普通 Runtime 不能全局枚举 assignment，Coordinator 也不能读取任何业务表。

## 可逆性与回退

0042 up 创建控制表，并在持有排他锁的迁移窗口内回填已有 `ready`/`claimed` Outbox；因原业务 Outbox 使用 FORCE RLS，回填只允许迁移角色在该窗口暂时关闭 RLS，完成后必须立即恢复 ENABLE/FORCE RLS。该过程不修改用户输入或 Run 业务状态。

回退前必须停止并排空动态 Worker，再把应用回退到固定 Tenant 版本，最后执行 0042 down 删除策略和 `worker_tenant_assignments`。控制表只含可重建的调度元数据，删除不会删除 Run 或 Outbox；但回退后团队任务只有在为对应 Tenant 部署固定 Worker 时才能继续执行。若先删表再回退应用，wake/claim 会失败，因此不支持该顺序。

生产中已经创建的团队、Run、dispatch、取消事实和已完成外部副作用都不是 0042 down 的回退对象，不能通过删除控制表撤销。

## 后续工作

- 为独立 Scheduler 设计动态 Tenant 发现与其专属恢复语义；
- 增加多 Worker 容量、饥饿、租约抖动、进程崩溃和数据库故障注入测试；
- 根据队列时延与空领取指标评估批量 dispatch claim 或外部消息总线，但不得放宽 Tenant 业务隔离。

## 实施记录

- 迁移 0042、动态 assignment 适配器以及 Coordinator/Runtime 双角色连接池在 `codex/team-edition-prototype` 试验分支实现；Scheduler 动态化尚未完成。
