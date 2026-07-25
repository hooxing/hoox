# ADR-0009：PostgreSQL 核心 Schema、迁移与并发写入

- 状态：已接受
- 日期：2026-07-26
- 决策者：M1 持久化实现审阅
- 关联任务：M1-01、M1-03、M1-04

## 背景

M1 需要把 Tenant、Thread、Run 与 Workspace 从内存领域对象落到 PostgreSQL，并把领域层声明的 Workspace revision/lease 条件变成真正的数据库并发保证。新实现没有历史数据库兼容负担，但迁移仍必须可重复执行、可回退并能发现被修改的历史文件。

## 方案与选择

### Schema 与租户隔离

比较过“每租户独立 Schema”“所有表仅用全局 ID”“共享表加复合租户键”。独立 Schema 会显著增加迁移和连接池复杂度；只靠全局 ID 无法在数据库外键层证明关联未跨租户。因此选择共享表，并把 `tenant_id` 纳入 Thread、Run、Workspace、Revision 和 Lease 的主键或候选键以及所有下游外键。Repository 每个业务方法还必须接收 `TenantScope`，读取不到其他租户的数据。

首版采用文本 ID、`timestamptz`、文本状态加 `CHECK` 约束。相较 PostgreSQL enum，文本约束更容易在后续迁移中扩展和回退；相较任意文本，它能在写入边界阻止非法状态。

代码审查进一步比较了“只依赖 Repository 过滤”“每租户独立数据库”“共享表加数据库 RLS”。只靠过滤无法抵御漏写 `tenant_id` 条件；独立数据库隔离最强但首版连接池、迁移和成本过高。因此共享业务表除迁移记录外全部启用并 `FORCE ROW LEVEL SECURITY`。租户 Repository 必须在事务中通过参数化 `set_config(..., true)` 写入可信 `tenant_id/user_id`，策略再同时约束 `USING` 与 `WITH CHECK`。全局 User 表使用单独策略：只允许当前用户或当前租户成员可见，不把 User 强行改成租户实体。

数据库 bootstrap、迁移和运行采用三个边界：Database Admin 只负责建库、建角色、从 `PUBLIC` 撤销数据库全部权限、按需授予 `CONNECT` 和创建 Migrator 所有的专用 Schema；Migrator 是专用 Schema owner，但不是数据库 owner，也没有 `CREATEDB/CREATEROLE/SUPERUSER/BYPASSRLS/REPLICATION` 或任何上游角色成员关系；Runtime 使用独立 URL，不能是数据库、Schema、表或序列 owner，也禁止任何上游角色成员关系。这里不区分 `INHERIT/NOINHERIT`，因为后者仍可能允许 `SET ROLE` 并继承上游 ACL。

每次 up/down 在任何迁移表或业务 DDL 前执行同一生产 preflight：`current_user` 必须等于显式配置的专用 Migrator；Migrator 必须恰好是已存在配置 Schema 的 owner，不得拥有其他非系统 Schema 或目标 Schema 外的 relation、routine、type、operator、conversion、collation 或全文检索对象；`current_schema` 和 `search_path` 必须精确落在该 Schema；Runtime 与 Migrator 的角色属性、成员关系和 owner 边界必须合规；Runtime 对目标 Schema 的有效 `CREATE` 和数据库 `TEMPORARY` 必须为 false，即使权限来自 `PUBLIC` 或直接 ACL 也拒绝。当前迁移 manifest 明确不包含函数、过程或聚合，因而目标 Schema 的 routine 集合必须为空，预置 `SECURITY DEFINER` 也在首个 DDL 前拒绝。任一条件不满足时不创建迁移表或业务对象。

Runtime ACL bootstrap 在业务 DDL 前先设置 Migrator 的 routine 默认权限，从 Runtime 和 `PUBLIC` 撤销未来 routine 的 `EXECUTE`，并对目标 Schema 现存 routine 执行相同撤销。PostgreSQL 内建的 `PUBLIC EXECUTE` 是角色级全局默认，带 `IN SCHEMA` 的局部 `REVOKE` 无法覆盖它；因此这里对专用 Migrator 设置全局默认。前置 ownership 约束保证该角色只服务一个业务 Schema，使实际作用域仍等价于目标 Schema。随后撤销业务 Schema、全部业务表、`runtime_schema_migrations` 及 sequence 的全部权限，再精确授权：User/Tenant/Membership 仅 `SELECT/INSERT`；Thread/Run/Workspace 仅 `SELECT/INSERT/UPDATE`；WorkspaceRevision 仅 `SELECT/INSERT`；Lease 使用 `SELECT/INSERT/UPDATE/DELETE`；迁移表、sequence 和 routine 零权限。提交前以 `has_*_privilege` 与 ACL 检查对每张表的 `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER`、routine `EXECUTE`、Schema 的 `USAGE/CREATE` 以及数据库的 `CONNECT/CREATE/TEMPORARY` 执行有效权限白名单断言，防止 `PUBLIC` 或间接 ACL 绕过。up 将建表/变更 DDL、迁移记录、ACL bootstrap 与白名单断言放入同一 client 事务，首次 up 的 ACL 失败不会留下任何业务表。未来若要允许 routine，必须先加入显式 manifest，逐项审查 owner、参数类型、`search_path` 与 `SECURITY DEFINER`，并更新权限矩阵。Repository 包不公开原始 Pool 和任意事务函数，防止应用层绕过 TenantScope 与 RLS。开发/测试环境也使用相同角色边界。

角色和数据库级 ACL 属于不可由 Schema down 回滚的运维 bootstrap。Schema migration 之后也可单独、重复执行 Runtime ACL bootstrap；显式 down 的业务对象删除、Runtime/`PUBLIC` 动态 ACL 回收和结束白名单断言使用同一 client 与事务，失败时全部回滚，但不会重新开放数据库权限。down 在撤销 Runtime Schema `USAGE` 后把专用 Migrator 的 routine 默认权限恢复为 PostgreSQL 内建值，从而删除全局 `pg_default_acl` 记录；此时 Schema 不可访问，下一次 up 又会在任何业务 DDL 前重新加固默认权限。

### Workspace 并发与数据库时钟

比较过无锁单条 CAS、事务级 advisory lock、Workspace 行锁。选择短事务内 `SELECT ... FOR UPDATE` 锁定单个 Workspace，再检查 revision、lease epoch、root Run 和 `clock_timestamp()`。它的等待范围只覆盖同一个 Workspace，错误分类也能稳定区分 `revision_conflict` 与 `lease_lost`。提交 Revision 与推进 Workspace head 必须在同一个事务中；业务 Run 全程不得持有数据库锁。

所有涉及父状态的写入采用固定锁序 `Thread → Run → Workspace`。创建 Run/Workspace 在插入前锁定并重验 Thread 仍为 `active`；Lease 获取、续租、释放和 Revision 提交锁定并重验 Root Run 仍为 `running`。Thread/Run 普通更新使用独立 bigint version token，而不是可能相同的 wall-clock 时间，单条条件更新原子执行 `version = version + 1`。Revision 提交还必须重验 `parentRevisionId` 等于数据库当前 head。

Lease 使用独立表保存当前持有者，Workspace 的 `lease_epoch` 保存单调递增高水位。释放租约删除当前 Lease，但不回退 epoch；接管只能在数据库时钟确认旧 Lease 过期后以更高 epoch 完成。

### 错误映射

比较过直接抛出 `pg` 错误、全部映射为通用内部错误、定义稳定持久层错误码。选择第三种：Repository 对外只暴露 `PersistenceError` 的稳定代码或显式结果联合，不保留原始 `pg` error 作为 cause，也不包含 SQL、连接串和驱动消息。内部诊断只允许记录操作名与 SQLSTATE 分类。跨租户读取统一返回不存在，避免存在性侧信道。

### 迁移策略

比较过 ORM 自动同步、引入完整迁移框架、仓库内有序 SQL 加小型 runner。当前只有一个初始 Schema，且 Workspace CAS 需要精确 SQL，因此选择最后一种，不引入 ORM。Runner 按版本严格读取一一配对的 `up/down.sql`，拒绝重复版本、孤立方向和异常文件，并对 `version + name + up + down` 共同计算 SHA-256；再次执行会跳过已应用版本，任一方向被改写都会失败。下迁移按逆序执行，但默认关闭；只有调用方同时传入显式破坏开关且环境明确为 development/test 才执行，生产环境不能通过 CLI 回退。

依赖固定为 `pg@8.22.0` 与 `@types/pg@8.20.0`：前者是成熟的 PostgreSQL 驱动并提供连接池/事务原语，后者只提供编译期类型。当前范围不引入 ORM、Redis 或 JSON Repository。

## 影响

- 所有跨租户外键由数据库复合键兜底，查询仍需显式 TenantScope；
- 同 Workspace 并发写串行化，不同 Workspace 可以并行；
- 行锁事务必须保持短小，等待用户或模型时必须在事务之外；
- 归档 Thread、终结 Run 与 Workspace 写入会在相同父行锁上串行化，避免检查后状态变化；
- RLS 是 Repository 条件之外的第二道边界，连接复用时必须使用事务级设置，禁止会话级残留；
- 团队 Tenant 创建者与 Thread 创建者不同且双方 Membership 仍活动时可正确恢复；“创建者 Membership 已撤销但仍需读取历史 Thread”的读取模型尚未设计，明确延后，当前实现不宣称支持；
- 文本 ID 比 UUID 列占用更多索引空间，等 ID 生成规则稳定后可另立迁移评估；
- SQL runner 功能刻意有限，出现多分支迁移、数据回填编排需求时再评估成熟迁移框架。

## 验证

- 初始迁移连续执行两次，版本表只有一条记录；执行 down 后业务表不可见，再次 up 可恢复；
- 两个租户互查 Thread/Run/Workspace 均返回不存在；
- Runtime 角色跨租户直接写入被 RLS 拒绝，且不能建表或创建 Schema；
- Runtime 与 Migrator 任意上游成员关系、owner/高权限、当前用户和精确 `search_path` 检查发生在首条迁移 DDL 前；权限矩阵参数化验证全部表乘全部七类表权限，包含迁移表零权限、`PUBLIC` 残留授权和 NOINHERIT/SET ROLE 对抗；
- Runtime 的目标 Schema `CREATE` 与数据库 `TEMPORARY` 分别在 up/down 前置对抗中证明零 DDL；Migrator 额外 Schema ownership 与跨 Schema object ownership 均被拒绝；首次 up 的 ACL 断言失败证明迁移 DDL 整体回滚；
- 目标 Schema 预置 `SECURITY DEFINER` 与跨 Schema Migrator-owned routine 都在首个 DDL 前拒绝；默认权限、现存 routine ACL 和 down 结束状态均证明 Runtime/`PUBLIC` 无 `EXECUTE`；
- 两个并发提交相同 revision/epoch 时恰好一个成功；
- 两个相同时间戳、相同 version 的 Thread/Run 更新恰好一个成功；
- 已过期、错误 root Run 或错误 epoch 的 Lease 提交均返回 `lease_lost`；
- Thread 归档或 Run 终态与创建/Lease/Revision 竞争时，父锁重验决定唯一合法结果；
- 事务中途失败后不残留部分数据，Revision 插入失败不能推进 Workspace head；
- 并发迁移只有一个执行者，篡改 down SQL 会触发 checksum 失败，CLI 缺少安全门不能回退；
- 启动探针和错误日志不得输出连接串，常见网络系统错误统一映射为脱敏 `UNAVAILABLE`。

## 可逆性与回退

首个迁移提供严格逆序的 down SQL，只有隔离的 development/test 数据库可显式回退。down 在同一事务中撤销当前 Schema 的 Runtime 与 `PUBLIC` 动态 ACL、清除 routine 默认 ACL 记录并执行结束断言；Database Admin 创建的角色、数据库 `CONNECT`、`PUBLIC` 数据库权限撤销和 Schema 本身不随业务表回滚，避免 down 意外扩大权限。生产已有数据后禁止 down；应先备份、停止写入并用新的前向迁移修正。RLS 可以在迁移窗口内由 Migrator 回退，但取消强制租户边界属于安全降级，必须新增 ADR。Repository 接口与错误联合不依赖 `pg` 类型，未来可以替换驱动或迁移框架，但必须保持 TenantScope、角色分离、原子 head 更新和数据库时钟 Lease 语义。

Run 更新不能信任调用方传入的 `threadId` 来决定锁顺序。Repository 先按数据库 `tenant_id + run_id` 发现真实父 Thread，再固定锁真实 Thread、锁真实 Run，随后校验输入父级并在 `UPDATE WHERE` 中同时绑定 `thread_id`。因此合法领域对象制造的 wrong-parent RunId 碰撞不会更新另一父级的 Run，Thread 归档竞态也保持统一的 Thread→Run 锁序。
