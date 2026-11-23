# 持久化与数据库边界

本文面向新增数据库事实、修改 Repository、迁移或数据库角色的开发者，说明 PostgreSQL 与对象存储的职责划分和必须保持的不变量。精确 ACL、角色 bootstrap 与迁移器校验见[维护者开发边界](../maintainers/runtime-development-boundaries.md#postgresql-角色-bootstrap)，Blob 提交与 GC 协议见 [`@hoox/persistence` README](../../runtime-ts/packages/persistence/README.md)。

## 事实源划分

- PostgreSQL 是业务状态的唯一事实源：状态迁移、唯一性、租约、幂等、Tenant 归属和 Outbox 都通过事务与条件写表达。
- S3 兼容存储只保存 Blob 字节。大文件不进入数据库热表；数据库保存完整的 Blob 身份（逻辑 SHA-256 与大小、不可复用的 incarnation、精确物理键）。
- 两者之间没有分布式事务。跨越它们的流程必须持久化协调快照，远端结果未知时只能通过固定事实对账收敛，不能猜测成功或失败。
- Sandbox、Pi Session 内存、浏览器状态和进程内队列都不是恢复依据。

## Tenant 隔离

- 外部工具版本、撤销事实与凭据由 Admin Control 写入，版本和凭据密文发布后不可修改；Runtime ACL 对这些底表及密文视图为零，许可消费只通过无密文的快照版本门控视图校验撤销。凭据管理投影只返回是否配置。Worker Coordinator 的专用连接只经校验数据库当前双栅栏事实的受限视图读取 Run 快照内的密文，不获得外部工具底表权限。
- 业务表全部启用并 FORCE RLS，策略基于事务内的 `app.tenant_id`、`app.user_id` 等可信设置。应用授权与 RLS 同时生效，不能只依赖其中一层。
- Run 反馈以 `(Tenant, Run, User)` 唯一，外键固定到该 Run 的 Revision 快照。Runtime 仅允许 Run 发起用户读取、写入、更新或撤销本人发起的正式/API Run 反馈；同租户其他成员即使可见该 Run 也统一得到 not-found。Repository 查询与 RLS 同时强制此边界；Playground 与评测 Run 不接收反馈。管理员附言只经 `run_content.read` 审计视图读取，统计仅提供按 Agent/Revision 的点赞、点踩计数与比率。
- 认证只证明 User 身份；Runtime 必须在事务内从 Membership 重建 TenantScope。客户端头部或模型参数不能构造 scope。API Key 在尚未知 Tenant 时只可经 RLS 按当前事务 `app.api_key_hash` 精确读取匹配记录；凭据成功后业务访问仍必须使用集成 User 的 Tenant Membership。
- 跨表引用使用包含 `tenant_id` 的复合外键，阻止跨租户身份拼接。公开错误不泄漏跨 Tenant 实体是否存在。
- 持久层映射数据库异常时，只在错误 `cause` 中附加经格式校验的 5 位 SQLSTATE；驱动消息、SQL、参数、连接信息和原始异常均不跨越错误边界。
- 后台统计只通过 Migrator 拥有的受限视图跨 Tenant 聚合；底表保留 FORCE RLS，专属读取策略只面向 Migrator 并要求有效平台操作者。
- Agent 运营指标通过按小时分组的只读视图提供，Control 只可读取聚合行，不获 Run、Attempt、事件、Thread、模型用量或计价快照底表权限。指标窗口与维度筛选在 Run 基表扫描阶段生效，`created_at` 范围索引支撑查询；同一时刻只允许一个指标聚合查询。
- Run 用量首次落库时按 Run Agent 快照中的固定 Provider Key、Revision 和 Model ID 读取价格，并使用 `runtime_agent_pinned_model_read` 的 Run 级 RLS 上下文；无固定模型时使用 Run 固定运行配置 Revision。价格快照与用量同事务提交，后续配置 Revision 不会重算历史成本。迁移按稳定的 `:output` observation 后缀幂等回填历史模型生成次数。

## Thread 的 Agent 绑定

Thread 创建时固定绑定平台拥有的 AgentDefinition；迁移为既有 Thread 回填内置默认 Agent。绑定列只能在 INSERT 时写入：Runtime 对 `threads` 不拥有整表 `UPDATE`，仅获准更新标题、状态、版本、时间戳及标题生成元数据等现有业务列。列级 ACL 同时保护所有 SQL 写入路径，AgentDefinition 绑定不会随 Thread 更新、归档或标题生成改变。新增 Thread 前还必须通过 RLS 校验所选 Agent 已发布且对当前 Tenant 可用。

## 数据库角色

每个常驻进程只持有完成职责所需的数据库身份：

| 角色 | 使用者 | 边界 |
| --- | --- | --- |
| Migrator | 迁移命令 | 拥有 Schema 和受限视图；不被常驻进程使用 |
| Runtime | API、Worker、Scheduler | 表与列白名单 ACL；业务 Schema 不含 routine。API Key 认证只按哈希命中受 RLS 限制的凭据行；吊销只开放必要列的 UPDATE，Runtime 专属 RESTRICTIVE RLS 限制集成 Membership 的旧/新状态与未吊销 Key 行。Webhook 订阅目的地址不可改，只开放密文与停用列的列级 UPDATE；Outbox 与业务状态在同一事务写入，Runtime 只能入队（INSERT 与去重唯一键列的 SELECT），不能读取或结算 Outbox。用户 HTTP API 不注册 API Key 或 Webhook 管理路由；面向部署方的管理授权由 Admin Control 执行。Team Coordinator 通过独立的 Tenant 读列与入队策略处理批量取消 |
| Worker Coordinator | Worker 的 Tenant 发现与外部工具快照读取 | 全局读取 assignment 并更新 claim 栅栏列；只经受限视图读取持有有效双栅栏的 Run 快照版本与密文，不读取业务底表 |
| 轨迹目录读取角色 | Scheduler 的轨迹保留清理 | 只能 SELECT 目录视图中的 Tenant ID；不能访问底表或读写 assignment；清理操作另走 Runtime 的 Tenant RLS |
| Webhook Dispatcher | Scheduler 的 Webhook Outbox 消费 | 只持有 Outbox 与订阅投递列的列级 SELECT、Outbox 投递/租约列的 UPDATE 与订阅停用列的 UPDATE；不读取 Run、Thread、Membership、Tenant 或订阅名称等列；RLS 只允许把启用的订阅改为停用。Outbox 不保存地址或密钥，领取时读取订阅地址，发送前复核当前密钥与停用状态。Bootstrap 会撤销不再配置的旧 Dispatcher 角色（Schema、表、列 ACL 与策略绑定），并断言 Dispatcher 与旧角色不持有白名单外权限 |
| Team Coordinator | API 团队协作 Repository | 在 Runtime 白名单基础上额外获得团队目录与 Membership 授权列的最小权限；Webhook 订阅只有筛选所需列的 SELECT、Outbox 只能入队，用于解散时的批量取消事件，除去重唯一键外不能读取 Outbox，不能读取或改写订阅密文，也不能改写已入队记录；Worker 不持有 |
| Admin Control | 统一 Admin API 控制面 | 控制面配置、AgentDefinition 发布与撤销、Run 浏览器受限视图及正文访问审计、外部工具版本发布与撤销、审计及统计投影；AgentDefinition 写入仅允许当前有效的 `operator` 或 `admin` 身份；工具凭据仅 INSERT，管理投影不读取密文。接入配置另由有效平台 `admin` 按 Tenant RLS 管理：只开放 Key、Webhook 订阅元数据与专用审计的必要权限，以及 User/Tenant/Membership 的关联列；不能读取 Webhook 密文、Run/Thread 底表或 Webhook Outbox，不能撤销人类 Membership、恢复已吊销 Key 或改写作用域与目的地址 |
| Skill Publisher | 统一 Admin API Skill 路由 | Skill 发布状态机与对应对象存储权限 |

角色属于整个 PostgreSQL 集群；同一集群的开发、预览和生产数据库使用不同角色集合。迁移在任何 DDL 前校验全部角色、Schema owner、`search_path` 与跨数据库依赖，并在同一事务中完成 Schema 迁移、迁移记录、策略重绑定和最小 ACL 重建。readiness 探测的是实际连接身份，而不是配置文件中的声明。

## Playground 持久化边界

`runs.origin` 是服务端受理路径写入的可信来源；客户端字段不能覆盖它。普通 Runtime 受理策略拒绝 Playground Thread/Run，专用 Playground 事务只有在有效 `operator`/`admin`、活动 Membership、本人个人 Tenant 均成立时才能插入草稿 Revision 快照。该路径不放宽普通已发布 Revision 的策略。

`run_playground_mocks` 通过包含来源值的复合外键只能关联 Playground Run，并按 Tenant RLS 隔离。当前 Playground 受理请求可携带 `mocks` 对象，与 Run 在同一事务写入；仅当前有效管理员本人在自己的个人 Tenant 中创建的 Playground Run 可以配置。键为外部工具版本 ID 或该 Revision 中客户端工具的精确名称，值为任意合法 JSON 值；缺省为空对象。Run 创建后的 Mock 不可变，修改配置需重新受理新 Run。Worker 领取快照仅在持久化 `origin=playground` 时读取 Mock；其他来源强制投影空配置。工具执行边界再次检查可信领取快照中的来源，只有 Playground 外部工具/客户端工具可命中；Mock 命中不发起网络请求、不消费外部工具凭据许可，成功回执和轨迹标记 `playground_mock`。缺少配置时按既定工具失败语义结束，不回退到真实执行。Mock 结果只进入工具执行结果，不进入 system prompt、工具 schema 或轨迹安全视图的正文投影。数据库外键、领取投影及执行层共同保证普通、API 与评测 Run 永不读取或应用 Mock。统计视图与用户目录显式排除 Playground 数据。 Playground 的来源隔离也覆盖事务副作用：终态转换不为其创建业务 Webhook 或长期记忆任务；记忆领取器与 Tenant 调度即使遇到遗留待消费任务，也必须按关联 Run 的持久化来源跳过。Playground 交付 Artifact 保留在 Run/Artifact 事实中供受限运行详情使用，但不设为普通可搜索 Resource、不写入历史文件目录；ResourceFS、个人历史列表及按 ID/路径的直接解析都必须关联 Artifact 来源 Run 并排除 `origin=playground`，不能依赖管理身份或 UI 隐藏。

## 事务与幂等

- 命令式写入使用显式幂等键，并以 canonical JSON 摘要绑定完整请求；同键异摘要稳定冲突。
- COMMIT 响应未知（`TransactionCommitUnknownError`）时只按原幂等键精确读回，禁止再次 INSERT 或重写。
- Webhook Dispatcher 的领取、发送前复核与结算使用覆盖连接池等待及整个事务的客户端截止时间；超时淘汰连接，不能只依赖服务端 `statement_timeout`。提交结果未知时不立即重放领取或结算，由领取令牌与数据库租约恢复收敛。
- 序列化冲突只重放完全相同的命令；重试范围和次数见 [Run 执行与恢复](run-execution-and-recovery.md#重试与未知结果)。
- 租约、TTL、`created_at` 等时间只使用数据库时钟，应用不得提交发生时间。
- Agent Worker 的连接池开启预备语句缓存（`createPostgresPool({ preparedStatements: true })`）：带参数的单语句查询按 SQL 文本哈希命名，同一连接执行 5 次后复用通用计划。带 RLS 的多表 fence 查询规划约 4.5ms、执行约 0.4ms，因此这是事件持久化的主要提速手段。查询文本必须由常量拼成，不能把参数内联进 SQL，否则每个不同值都会产生一条新的预备语句；经过事务级连接池（如 PgBouncer transaction 模式）连接时不得开启。
- 锁序是正确性的一部分。例如 Membership `FOR SHARE` → Thread `FOR UPDATE`，Blob 引用 → lifecycle → incarnation；新增路径必须沿用既有锁序。

## Outbox 与后台消费

需要异步外部动作的事实（Run dispatch、Sandbox cleanup 与生命周期 effect、记忆写入、标题生成、模型诊断清理等）都在产生事实的同一事务中登记 Outbox。消费者：

- 在可信 Tenant scope 内领取，以 token、generation 和数据库租约作为栅栏，迟到写回是 no-op；
- 在调用远端前持久化“已开始”事实，之后的崩溃或不确定响应收敛为 `unknown`，不自动重复；
- 失败按有界退避重试，耗尽后进入明确的终止或人工处理状态。

Webhook 管理删除只写入不可恢复的停用墓碑，不物理删除订阅或 Outbox，避免并发业务事务已经选中的订阅在外键检查前消失并回滚 Run 状态。墓碑不再出现在管理列表，也不能轮换密钥或再次停用；物理回收随 Tenant 生命周期级删除级联进行。发送复核与在途请求的边界见 [Webhook 参考](../reference/webhooks.md)。

事件写入在原事务中调用 `pg_notify` 唤醒 API 的事件流；通知只携带散列路由键，不是授权或持久事实，丢失由定时补读覆盖。

## Routine 与迁移

- 业务 Schema 不得存在自定义函数、过程或聚合，迁移 runner 在迁移前后均以严格 routine 检查失败关闭。API Key 撤销不使用数据库 routine：Runtime 的列级 UPDATE 权限受 Runtime 专属 RESTRICTIVE RLS 策略进一步约束，只能将集成 Membership 从 active 改为 revoked，不能改人类成员或恢复已吊销 Membership。由于 `SELECT ... FOR SHARE/UPDATE` 同样施加 UPDATE 策略的 USING，Membership 策略的 USING 只限定当前 Tenant 的 active 行，使人类成员的授权加锁与 `lock_marker` 自更新继续命中；集成身份与目标状态只在 WITH CHECK 中约束，因此 Runtime 也无法锁定或更新已吊销 Membership；API Key 仅允许更新未吊销行，且新状态必须仍处于当前 Tenant，因此已吊销 Key 不可恢复。Key 与 Membership 在同一事务中更新，任一更新未命中预期行则整体回滚。这些策略随 API Key 表在同一迁移中创建与回退。
- 迁移文件位于 `runtime-ts/packages/persistence/migrations`，以 `NNNN_name.up.sql` / `.down.sql` 成对出现，runner 按版本顺序在单一事务中执行，并以 checksum 校验已应用记录。2026-11 起全部历史迁移已合并为 `0001_baseline`；基线及之后的迁移一经合并到 `main` 或执行即不可修改，新变化只能追加 `0002` 起的递增版本。压缩前建立的数据库会因迁移记录不一致而失败关闭，必须清空 Schema 后重建，见[开发环境准备](../development.md#迁移基线重置)。
- 每个 up/down 脚本执行前，runner 在当前迁移事务内执行 `SET CONSTRAINTS ALL IMMEDIATE`；迁移内不得依赖延迟约束完成循环写入，必须先建立被引用事实再更新引用，避免带数据升级时 UPDATE 留下的待处理触发器事件阻塞后续 ALTER TABLE（SQLSTATE `55006`）。约束检查失败时整批迁移、迁移记录与 ACL 一并回滚。设置由执行器负责，不改写迁移 SQL 或 checksum，也不改变业务事务中约束的初始延迟属性。
- 开发时使用 `pnpm migration:new <名称>` 创建成对的迁移文件。并行分支合并前，先同步 `origin/main` 并将其迁移纳入工作区，再用 `pnpm migration:renumber` 将分支新增、尚未执行的迁移顺延到基准之后，并同步更新对文件名主干的引用。若工作区或 Git 索引缺少基准迁移或与基准内容不符，命令拒绝重编号。两个命令只操作文件和 Git，不连接数据库；重编号会改变 checksum，不能用于已执行的迁移。
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
