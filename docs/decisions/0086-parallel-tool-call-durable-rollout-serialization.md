# ADR-0086：并行工具调用的 Durable Rollout 串行化边界

- 状态：已接受
- 日期：2026-08-02
- 决策者：Runtime 维护者
- 关联任务/PR：并行工具调用触发 Rollout observation conflict 修复
- 替代关系：细化 ADR-0030、ADR-0031 的工具配对并发边界

## 背景

Pi 在同一 Assistant 消息包含多个 Tool Call 时，默认并发执行工具。当前 durable 路径则把一次工具执行
拆成两个 PostgreSQL append：副作用前写 `tool_call`，副作用及 Stable Trace Blob 完成后写
`tool_result`。`PgRuntimeRolloutRepository` 已用包含 Tenant、Attempt 与 Agent Thread 的事务级 advisory
lock 串行每个 append，避免两个事务分配同一 sequence；但该锁不能也不应跨越 Sandbox 或 Artifact
网络副作用。

因此，调用 A 的 `tool_call` 提交后、对应 `tool_result` 提交前，调用 B 可能取得 stream 写锁并尝试追加
第二个 `tool_call`。数据库的相邻配对约束会正确拒绝 B，适配器把该拒绝映射为 observation conflict，
`PiWorkerSessionFactory` 随即把 Attempt 关闭为恢复语义。常见的模型并行工具批次因而无法完成。

必须同时保留以下约束：Rollout 事实只追加；`tool_call/tool_result` 同 ID 且相邻；副作用前已经形成
durable call 意图；幂等键同正文可回放、异正文冲突；COMMIT 响应未知只用原命令读回；双栅栏和 Tenant
隔离继续由 PostgreSQL 重验。

## 决策驱动因素

- 不放宽 ADR-0030 的无间隙序号和相邻工具对数据库约束；
- 不在外部网络调用期间占用数据库连接或持有长事务；
- 模型发出的多个工具调用应被接受并确定性完成，不能因 Runtime 内部调度形成伪幂等冲突；
- 已提交但响应未知时仍只允许同键同正文回放，不猜测、覆盖或删除事实；
- 不能用进程内锁替代数据库对跨连接写入和 Tenant scope 的最终保护。

## 备选方案

### 方案 A：允许多个未配对 Tool Call

放宽前驱约束，使事实可形成 `call A → call B → result A → result B`。这会改变已接受的恢复协议，
需要新的批次关联、乱序结果投影和 Checkpoint 窗口规则，也失去单个调用的局部相邻证明。

### 方案 B：跨工具副作用持有 PostgreSQL session lock

`tool_call` 后保留专用连接和 session advisory lock，直到 `tool_result`。它能保持真并行调度入口，
但长命令会耗尽连接池；Worker 崩溃、取消、网络分区和结果 UNKNOWN 又需要新的连接所有权恢复协议。
这也违反“业务执行期间不持有数据库锁”的既有约束。

### 方案 C：为每个 Tool Call 建独立事实流或先写旁路 intent

结果阶段再原子追加完整 call/result 对，可实现真正并行副作用，但需要 Schema、恢复投影、EffectInvocation
和审计事实源迁移。旁路 intent 还会把当前唯一 Rollout 事实源拆成两套协议，超出本次最小修复范围。

### 方案 D：Pi 接受并行批次，但按完整 durable pair 顺序执行

把所有会写同一 Runtime Rollout stream 的 Pi 工具声明为 `executionMode=sequential`。Pi 仍接受同一模型
消息中的多个 Tool Call，并按消息顺序逐个执行完整的“call append → permit/副作用 → Blob/result append”；
每个 pair 完成后才开放下一个。每次 PostgreSQL append 仍由原有 stream advisory transaction lock
线性化，负责跨连接序号、幂等回执和 Tenant scope。

## 选择

采用方案 D。当前 `exec_command`、`deliver_file` 及保留的 Artifact Pi 工具统一声明顺序执行。调度边界
覆盖完整 Tool `execute`，而不是只串行两个独立的 Repository 方法，因此任何成功、受控失败或许可拒绝
都先形成相邻 call/result 对，再进入同批次下一调用。

数据库 stream 写锁继续使用完整 `tenant/thread/run/attempt/agentThread` scope；append 在锁内先读幂等回执，
再读取 tail、分配 sequence、插入事实和命令回执。该锁是跨连接最终线性化点，Pi 顺序模式只是满足跨外部
副作用的相邻 pair 调度前提，不能替代 PostgreSQL 锁和双栅栏重验。

## 理由

方案 D 不改变表结构、恢复格式、工具公开 Schema 或幂等键，且不持有跨网络数据库事务。真正并行副作用
与严格相邻、事前 durable call 在单一线性事实流中无法同时满足；在没有批次级新协议前，按完整 pair
顺序执行是最小且可证明的选择。

方案 A 会直接削弱数据库不变量；方案 B 把连接池和崩溃恢复变成长锁协议；方案 C 可以作为未来吞吐优化，
但需要独立迁移和替代 ADR，不能作为线上冲突的局部补丁。

## 影响

### 正面影响

- 同一模型消息中的两个或更多 Tool Call 不再互相制造 observation conflict；
- 每个工具事实仍是无间隙、同 ID、相邻且只追加的 call/result 对；
- 许可拒绝和工具失败也在下一调用开始前完成 durable 失败回执；
- PostgreSQL 幂等回放、UNKNOWN 收敛、双栅栏和 RLS 语义保持不变。

### 负面影响与成本

- 同一 Pi Session 的工具副作用不再并行，批次耗时等于各工具耗时之和；
- 新增 durable Pi 工具时必须显式沿用 sequential execution mode；
- 真正并行执行需要未来引入批次事实或独立子流协议。

### 安全、数据与运维影响

- 不新增数据库权限、表、routine 或长事务；外部副作用期间不占用 rollout 写锁；
- stream lock key 包含 Tenant scope，不会把一个租户的身份当成另一个租户的授权；哈希碰撞最多造成额外
  串行，不会放宽隔离；
- 已写事实格式不变，无需回填。监控中的 observation conflict 应只代表真实正文/身份冲突或事实损坏，
  不再代表正常并行批次。

## 验证

- Pi/Faux 纵向测试在单个 Assistant 消息中发出两个 `exec_command`，严格 recorder 在第二个 call 早于
  第一个 result 时立即返回 conflict；修复后 Worker 成功，事实顺序固定为 call A/result A/call B/result B，
  且 Sandbox 最大并发数为 1；
- 工具定义单测断言 `exec_command` 与 `deliver_file` 均为 sequential；
- 真实 PostgreSQL 用两个独立连接在同一 stream 写锁入口同步起跑，并发追加两个完整工具对，断言四个
  sequence 连续且各 pair 相邻；随后同键同正文精确回放原 sequence，同键异正文稳定 conflict；
- 既有 committed-but-unknown 单测继续断言同一冻结命令对象与幂等键重试，Tenant RLS、双栅栏、未配对
  恢复和直接 SQL 约束测试继续通过；
- 执行相关单测、PostgreSQL 集成测试和 `pnpm check`。

## 可逆性与回退

本决策没有数据迁移。发布前可以移除 sequential 标记回退代码，但会重新暴露正常并行批次冲突。发布后
已经写入的 Rollout 事实仍符合旧协议，无需改写或删除；回退只能以新 Attempt 为边界，不能在活跃 Session
中热切换调度。未来若采用批次或独立子流，应新增替代 ADR 和前向迁移，并继续读取现有相邻 pair 历史。

## 后续工作

- 若工具批次串行成为可观测性能瓶颈，设计带事前 durable batch intent、确定结果顺序和恢复投影证明的
  真并行协议；
- 为新增 Pi 工具提供共享构造器或静态门禁，避免遗漏 sequential execution mode。

## 实施记录

- `exec_command`、`deliver_file` 和 Artifact Pi 工具已声明 sequential execution mode；
- Pi 并行批次回归测试和 PostgreSQL stream 写锁并发/回放/冲突测试已加入。
