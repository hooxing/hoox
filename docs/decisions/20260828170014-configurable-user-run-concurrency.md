# ADR-20260828170014：后台可配置的用户级有界 Run 并发

- 状态：已接受
- 日期：2026-08-28
- 决策者：Runtime 维护者
- 关联：ADR-0011、ADR-0016、ADR-0142、ADR-20260821115221
- 替代关系：部分替代 ADR-0142 中“单 Worker loop 不能提供任务并行、只能依赖增加 Worker 实例”的容量结论；保留动态 Tenant 发现、RLS、assignment 短租约和公平选择边界

## 背景

Agent Worker 原先每次只领取一个 dispatch，并等待对应 `RunWorker.execute`、模型、Sandbox、工具和最终 acknowledge 全部结束后才进行下一次轮询。任何长 Run 都会阻塞同进程后面的其他 Tenant 和 Thread；即使数据库、模型 Provider 和 Sandbox 仍有容量，请求也只能在 Worker 前形成队头阻塞。

不同 Thread 的 Run 没有必须串行的状态依赖。同一 Thread 则必须维持单活跃 Run，否则消息顺序、Thread Context、Workspace head、follow-up 和 steer 语义会冲突。Tenant 下存在多个 Membership/User；若使用固定 Tenant 上限，小团队容易被不必要地压低，大团队又需要按成员数反复调整。只在进程内限制用户并发也不足以覆盖多个 Worker 实例。

## 约束

- 同一 Thread 必须最多存在一个有效 dispatch 或 ExecutionAttempt；
- 用户并发按 `(tenant_id, requested_by_user_id)` 统计，避免用户在一个 Tenant 的任务阻塞其另一个 Tenant；
- 用户槽位必须由 PostgreSQL 全局保证，多个 Worker 不能各自重复发放；
- Tenant 发现和业务读取继续遵守 assignment 控制面与 Tenant FORCE RLS，不能跨 Tenant 扫描业务 Outbox；
- 并发上限降低时不能取消已经开始的 Run，只能停止领取新任务；
- 控制面不可用或尚未发布运行设置时必须回退到安全的内置默认值，不能退化为无限并发；
- 配置变更不改变已经固定到 Run 的模型、记忆和上下文设置快照。

## 备选方案

### 方案 A：维持单 Worker 串行，通过增加 Worker 实例扩容

实现最简单，但单实例仍有明显队头阻塞；每个实例都需要独立进程、连接和运维资源，也无法表达单用户公平性。

### 方案 B：为每个 Tenant 设置固定最大并发

能隔离大 Tenant，但上限与成员数量和活跃度不匹配。固定值会压制正常的多人团队；按成员数动态改写配置又会把 Membership 变化错误地变成容量配置事件。

### 方案 C：无限启动异步 Run

短期看似能消除 Worker 队列，但会把压力转移到模型连接、Provider 配额、Sandbox、PostgreSQL 连接池、内存和恢复任务，失去明确背压并放大失败重试。

### 方案 D：Worker 有界并发加 Tenant 内用户上限

Worker 使用可配置的总执行槽；每个 Tenant 内的请求用户使用独立上限。同一 Thread 始终串行，不设置固定 Tenant 运行上限。Tenant assignment 和用户活跃数用于公平选择，真正的模型执行不持有 Tenant 调度锁。

## 决策

采用方案 D：

1. `workerMaxConcurrentRuns` 由后台运行设置发布，默认值为 `20`，允许范围为 `1..100`。它限制单个 Agent Worker 进程的在途 Run 数。
2. `userMaxConcurrentRunsPerTenant` 由同一后台运行设置发布，默认值为 `2`，允许范围为 `1..100`。计数键为 `(tenant_id, user_id)`。
3. 不设置产品级固定 Tenant 最大运行数。Tenant 的实际并发由活跃用户槽位和 Worker 总槽共同决定。
4. Worker 每次 assignment 仍只领取至多一个 dispatch，并在调用模型前释放 assignment；只要本进程仍有槽位，就立即继续轮询其他 Tenant。
5. PostgreSQL 在 Tenant RLS 事务中以短时 Tenant 调度 advisory lock 串行执行“复核 Thread/User 活跃数并占槽”。该锁只覆盖 dispatch 领取事务，不覆盖模型、Sandbox 或工具执行。
6. 用户活跃数是以下 Run ID 的去重并集：仍有有效 dispatch lease 的 `claimed` Outbox，以及仍有有效 Run claim 的 `claimed/running/finalizing` ExecutionAttempt。这样既覆盖 Attempt 创建前的占槽窗口，也不会让过期或已释放租约永久占槽。
7. 请求用户以 `run_skill_snapshots.user_id` 为当前事实；历史 Run 缺失快照时兼容回退到 `threads.created_by_user_id`，不得因此搁置旧 dispatch。
8. 同一 Thread 的有效 claimed dispatch 或有效 ExecutionAttempt 会阻止第二个 Run 被领取；V2 follow-up queue 的顺序约束继续保留。
9. 后台配置读取失败时 Worker 保留最近一次有效设置；进程首次启动时使用 `20/2` 内置默认值。降低上限只影响后续 claim，在途 Run 自然排空。

## 理由

该方案把系统容量背压和用户公平性分开：Worker 总槽保护单进程资源，用户槽防止单个成员占满容量，Thread 单槽保护对话和 Workspace 正确性。Tenant 不需要随成员数量维护固定上限，大团队可以利用其真实活跃用户扩展并发；动态 assignment 仍能在 Tenant 之间提供非严格公平发现。

把占槽放在 PostgreSQL 短事务而不是进程内信号量，可在多 Worker 部署下保持全局一致。dispatch lease 与 Run claim 的并集消除了领取到 Attempt 建立之间的竞态，也允许崩溃后的过期槽位自动释放。

## 影响

### 正面影响

- 不同 Tenant、不同 Thread 的 Run 可以在一个 Worker 进程内并行；
- 单用户默认最多占用当前 Tenant 的两个运行槽；
- 大 Tenant 不受固定 `M` 值压制，系统总容量仍由每 Worker 上限控制；
- 后台发布设置即可调整新 claim，不需要重启 Worker；
- 多 Worker 下用户上限仍由数据库统一执行。

### 负面影响

- 每次 dispatch claim 增加活跃 Attempt/Outbox 计数查询和一个短时 Tenant advisory lock；
- 大 Tenant 的多个活跃用户仍可能占满 Worker 总槽，Tenant 间只提供公平发现而非硬配额；
- 单 Worker 上限是进程级值，部署总并发约为各 Worker 有效上限之和，仍需结合 Provider、数据库和 Sandbox 容量规划；
- 历史 Run 缺少请求者快照时只能按 Thread 创建者兼容计数。

### 安全与隐私

- 调度查询只读取 Tenant RLS 范围内的 ID、状态和租约，不读取输入正文、Prompt、工具参数或文件路径；
- 全局 assignment 表继续不保存 User、Run 或业务载荷；
- 后台运行设置沿用 Admin Control 的 Revision、发布和审计权限。

### 数据、兼容与迁移

- 迁移为所有历史 `runtime_settings` Revision 回填 `workerMaxConcurrentRuns=20` 和 `userMaxConcurrentRunsPerTenant=2`，随后收紧 JSON 形状约束；
- 为 `run_skill_snapshots(tenant_id,user_id,run_id)` 增加索引；
- down migration 删除新字段并恢复旧约束，仅允许现有开发/测试破坏性回退流程执行。

### 运维与可观测性

- 修改后台上限后不应期待取消在途 Run；应观察活跃数自然降到新上限；
- 应继续监控 ready dispatch 年龄、assignment 空领取率、过期租约、Provider 429、数据库连接等待和 Sandbox 配额；
- 若大 Tenant 长期占满 Worker，可增加 Tenant 公平队列指标或部署级容量，不应直接改回拍脑袋的固定 Tenant 上限。

## 验证

- Worker loop 测试证明不同 Tenant 的 Run 可并行且不会超过动态 Worker 上限，释放槽位后才领取下一项；
- dispatch 适配器测试证明 Tenant 调度锁、Thread 单活跃、User 活跃计数、有效租约过滤和越界配置拒绝；
- Admin Control、协议、Admin API 和 Admin Web 测试证明两个字段可创建、校验、展示和提交；
- 迁移测试证明历史 Revision 回填默认值、JSON 约束和用户索引成对存在；
- 类型检查覆盖 Agent Worker、Persistence、Admin Control、Protocol、Admin API 与 Admin Web。

## 可逆性

停止 Worker 领取并等待在途 Run 排空后，可以回退应用并执行 0057 down。回退会删除后台 Revision 中的两个并发字段和用户索引，Worker 恢复旧串行 loop；不会删除 Run、Attempt、Outbox 或用户数据。已经并行完成的 Run 和外部副作用属于正常业务事实，不能通过回退撤销。
