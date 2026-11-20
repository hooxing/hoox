# 持久化与数据库边界

本文面向新增数据库事实、修改 Repository、迁移或数据库角色的开发者，说明 PostgreSQL 与对象存储的职责划分和必须保持的不变量。精确 ACL、角色 bootstrap 与迁移器校验见[维护者开发边界](../maintainers/runtime-development-boundaries.md#postgresql-角色-bootstrap)，Blob 提交与 GC 协议见 [`@hoox/persistence` README](../../runtime-ts/packages/persistence/README.md)。

## 事实源划分

- PostgreSQL 是业务状态的唯一事实源：状态迁移、唯一性、租约、幂等、Tenant 归属和 Outbox 都通过事务与条件写表达。
- S3 兼容存储只保存 Blob 字节。大文件不进入数据库热表；数据库保存完整的 Blob 身份（逻辑 SHA-256 与大小、不可复用的 incarnation、精确物理键）。
- 两者之间没有分布式事务。跨越它们的流程必须持久化协调快照，远端结果未知时只能通过固定事实对账收敛，不能猜测成功或失败。
- Sandbox、Pi Session 内存、浏览器状态和进程内队列都不是恢复依据。

## Tenant 隔离

- 外部工具版本、撤销事实与凭据由 Admin Control 写入，版本和凭据密文发布后不可修改；Runtime ACL 对这些表为零。凭据管理投影只返回是否配置。接入 Agent 快照前不得向 Worker 开放版本或凭据读取。
- 业务表全部启用并 FORCE RLS，策略基于事务内的 `app.tenant_id`、`app.user_id` 等可信设置。应用授权与 RLS 同时生效，不能只依赖其中一层。
- 认证只证明 User 身份；Runtime 必须在事务内从 Membership 重建 TenantScope。客户端头部或模型参数不能构造 scope。API Key 在尚未知 Tenant 时只可经 RLS 按当前事务 `app.api_key_hash` 精确读取匹配记录；凭据成功后业务访问仍必须使用集成 User 的 Tenant Membership。
- 跨表引用使用包含 `tenant_id` 的复合外键，阻止跨租户身份拼接。公开错误不泄漏跨 Tenant 实体是否存在。
- 持久层映射数据库异常时，只在错误 `cause` 中附加经格式校验的 5 位 SQLSTATE；驱动消息、SQL、参数、连接信息和原始异常均不跨越错误边界。
- 后台统计只通过 Migrator 拥有的受限视图跨 Tenant 聚合；底表保留 FORCE RLS，专属读取策略只面向 Migrator 并要求有效平台操作者。

## Thread 的 Agent 绑定

Thread 创建时固定绑定平台拥有的 AgentDefinition；迁移为既有 Thread 回填内置默认 Agent。绑定列只能在 INSERT 时写入：Runtime 对 `threads` 不拥有整表 `UPDATE`，仅获准更新标题、状态、版本、时间戳及标题生成元数据等现有业务列。列级 ACL 同时保护所有 SQL 写入路径，AgentDefinition 绑定不会随 Thread 更新、归档或标题生成改变。新增 Thread 前还必须通过 RLS 校验所选 Agent 已发布且对当前 Tenant 可用。

## 数据库角色

每个常驻进程只持有完成职责所需的数据库身份：

| 角色 | 使用者 | 边界 |
| --- | --- | --- |
| Migrator | 迁移命令 | 拥有 Schema 和受限视图；不被常驻进程使用 |
| Runtime | API、Worker、Scheduler | 表与列白名单 ACL；业务 Schema 不含 routine。API Key 吊销只授予 Runtime 所需列级 UPDATE，并由 Runtime 专属 RESTRICTIVE RLS 策略限制集成 Membership 状态转换和 Key 吊销行；API Key 认证只按哈希命中受 RLS 限制的凭据行 |
| Worker Coordinator | Worker 的 Tenant 发现 | 只能全局读取 assignment 并更新 claim 栅栏列，不能读取业务表 |
| Team Coordinator | API 团队协作 Repository | 在 Runtime 白名单基础上额外获得团队目录与 Membership 授权列的最小权限；Worker 不持有 |
| Admin Control | 统一 Admin API 控制面 | 控制面配置、AgentDefinition 发布与撤销、Run 浏览器受限视图及正文访问审计、外部工具版本发布与撤销、审计及统计投影；AgentDefinition 写入仅允许当前有效的 `operator` 或 `admin` 身份；工具凭据仅 INSERT，管理投影不读取密文 |
| Skill Publisher | 统一 Admin API Skill 路由 | Skill 发布状态机与对应对象存储权限 |

角色属于整个 PostgreSQL 集群；同一集群的开发、预览和生产数据库使用不同角色集合。迁移在任何 DDL 前校验全部角色、Schema owner、`search_path` 与跨数据库依赖，并在同一事务中完成 Schema 迁移、迁移记录、策略重绑定和最小 ACL 重建。readiness 探测的是实际连接身份，而不是配置文件中的声明。

## 事务与幂等

- 命令式写入使用显式幂等键，并以 canonical JSON 摘要绑定完整请求；同键异摘要稳定冲突。
- COMMIT 响应未知（`TransactionCommitUnknownError`）时只按原幂等键精确读回，禁止再次 INSERT 或重写。
- 序列化冲突只重放完全相同的命令；重试范围和次数见 [Run 执行与恢复](run-execution-and-recovery.md#重试与未知结果)。
- 租约、TTL、`created_at` 等时间只使用数据库时钟，应用不得提交发生时间。
- Agent Worker 的连接池开启预备语句缓存（`createPostgresPool({ preparedStatements: true })`）：带参数的单语句查询按 SQL 文本哈希命名，同一连接执行 5 次后复用通用计划。带 RLS 的多表 fence 查询规划约 4.5ms、执行约 0.4ms，因此这是事件持久化的主要提速手段。查询文本必须由常量拼成，不能把参数内联进 SQL，否则每个不同值都会产生一条新的预备语句；经过事务级连接池（如 PgBouncer transaction 模式）连接时不得开启。
- 锁序是正确性的一部分。例如 Membership `FOR SHARE` → Thread `FOR UPDATE`，Blob 引用 → lifecycle → incarnation；新增路径必须沿用既有锁序。

## Outbox 与后台消费

需要异步外部动作的事实（Run dispatch、Sandbox cleanup 与生命周期 effect、记忆写入、标题生成、模型诊断清理等）都在产生事实的同一事务中登记 Outbox。消费者：

- 在可信 Tenant scope 内领取，以 token、generation 和数据库租约作为栅栏，迟到写回是 no-op；
- 在调用远端前持久化“已开始”事实，之后的崩溃或不确定响应收敛为 `unknown`，不自动重复；
- 失败按有界退避重试，耗尽后进入明确的终止或人工处理状态。

事件写入在原事务中调用 `pg_notify` 唤醒 API 的事件流；通知只携带散列路由键，不是授权或持久事实，丢失由定时补读覆盖。

## Routine 与迁移

- 业务 Schema 不得存在自定义函数、过程或聚合，迁移 runner 在迁移前后均以严格 routine 检查失败关闭。API Key 撤销不使用数据库 routine：Runtime 的列级 UPDATE 权限受 Runtime 专属 RESTRICTIVE RLS 策略进一步约束，只能将集成 Membership 从 active 改为 revoked，不能改人类成员或恢复已吊销 Membership；API Key 仅允许更新未吊销行，且新状态必须仍处于当前 Tenant，因此已吊销 Key 不可恢复。Key 与 Membership 在同一事务中更新，任一更新未命中预期行则整体回滚。这些策略随 API Key 表在同一迁移中创建与回退。
- 迁移文件位于 `runtime-ts/packages/persistence/migrations`，以 `NNNN_name.up.sql` / `.down.sql` 成对出现，runner 按版本顺序在单一事务中执行，并以 checksum 校验已应用记录。2026-11 起全部历史迁移已合并为 `0001_baseline`；基线及之后的迁移一经提交不可修改，新变化只能追加 `0002` 起的递增版本。压缩前建立的数据库会因迁移记录不一致而失败关闭，必须清空 Schema 后重建，见[开发环境准备](../development.md#迁移基线重置)。
- 基线 down 删除基线创建的全部表、视图与函数，不按数据内容阻止回退；新增迁移的 down 若可能丢失不可恢复事实，应自行失败关闭。
- `pnpm db:migrate:down` 只在 development/test 加显式破坏开关时工作。

## 包入口

`@hoox/persistence` 按职责提供子入口，每个模块只归属一个子入口：

| 子入口 | 内容 |
| --- | --- |
| `postgres` | 连接池、租户事务、通用错误、请求侧端口与 API 运行时装配 |
| `blob` | Blob 存储契约、S3 适配、提交协议与生命周期收敛 |
| `admin` | 模型与 Sandbox 配置、身份配置、凭据加密与 Skill 发布 |
| `thread` | 面向用户请求的 Thread、账户、团队、个性化、资源与技能读写 |
| `run-execution` | Worker 执行事实：调度领取、执行状态、Rollout、恢复、协作、定时任务与 Workspace 提交 |
| `maintenance` | Scheduler 的 Sandbox 清理与 Thread Sandbox 生命周期消费 |

根入口只是聚合全部子入口的兼容层。其他包的生产源码必须从子入口导入，使进程只加载与自身职责相关的 Repository 和 SDK；`pnpm deps:check` 拒绝生产源码导入根入口，测试不受此限制。新增模块时在 `src/entrypoints/` 中选择唯一归属；一个进程需要多个领域时分别导入对应子入口，不为单个进程新建聚合入口。

## 新增数据库事实检查清单

1. 新表启用并 FORCE RLS，策略与复合外键包含 `tenant_id`。
2. 更新 `role-bootstrap.ts` 中各角色的精确 ACL 白名单，并补真实 PostgreSQL 测试。
3. 写入路径具备幂等键、摘要冲突语义和 COMMIT 未知读回。
4. 需要远端动作时使用同事务 Outbox，并定义 UNKNOWN 收敛。
5. 不新增业务 routine；迁移后的业务 Schema 必须保持无 routine，迁移 runner 与 PostgreSQL 权限测试对此失败关闭。
