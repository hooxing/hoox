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

### Workspace 并发与数据库时钟

比较过无锁单条 CAS、事务级 advisory lock、Workspace 行锁。选择短事务内 `SELECT ... FOR UPDATE` 锁定单个 Workspace，再检查 revision、lease epoch、root Run 和 `clock_timestamp()`。它的等待范围只覆盖同一个 Workspace，错误分类也能稳定区分 `revision_conflict` 与 `lease_lost`。提交 Revision 与推进 Workspace head 必须在同一个事务中；业务 Run 全程不得持有数据库锁。

Lease 使用独立表保存当前持有者，Workspace 的 `lease_epoch` 保存单调递增高水位。释放租约删除当前 Lease，但不回退 epoch；接管只能在数据库时钟确认旧 Lease 过期后以更高 epoch 完成。

### 错误映射

比较过直接抛出 `pg` 错误、全部映射为通用内部错误、定义稳定持久层错误码。选择第三种：Repository 对外只暴露 `PersistenceError` 的稳定代码或显式结果联合，不包含 SQL、连接串和驱动消息。跨租户读取统一返回不存在，避免存在性侧信道。

### 迁移策略

比较过 ORM 自动同步、引入完整迁移框架、仓库内有序 SQL 加小型 runner。当前只有一个初始 Schema，且 Workspace CAS 需要精确 SQL，因此选择最后一种，不引入 ORM。Runner 按版本读取成对的 `up/down.sql`，在事务 advisory lock 下执行，记录 SHA-256；再次执行会跳过已应用版本，历史文件被改写会失败。下迁移按逆序执行。

依赖固定为 `pg@8.22.0` 与 `@types/pg@8.20.0`：前者是成熟的 PostgreSQL 驱动并提供连接池/事务原语，后者只提供编译期类型。当前范围不引入 ORM、Redis 或 JSON Repository。

## 影响

- 所有跨租户外键由数据库复合键兜底，查询仍需显式 TenantScope；
- 同 Workspace 并发写串行化，不同 Workspace 可以并行；
- 行锁事务必须保持短小，等待用户或模型时必须在事务之外；
- 文本 ID 比 UUID 列占用更多索引空间，等 ID 生成规则稳定后可另立迁移评估；
- SQL runner 功能刻意有限，出现多分支迁移、数据回填编排需求时再评估成熟迁移框架。

## 验证

- 初始迁移连续执行两次，版本表只有一条记录；执行 down 后业务表不可见，再次 up 可恢复；
- 两个租户互查 Thread/Run/Workspace 均返回不存在；
- 两个并发提交相同 revision/epoch 时恰好一个成功；
- 已过期、错误 root Run 或错误 epoch 的 Lease 提交均返回 `lease_lost`；
- 事务中途失败后不残留部分数据，Revision 插入失败不能推进 Workspace head；
- 启动探针和错误日志不得输出连接串。

## 可逆性与回退

首个迁移提供严格逆序的 down SQL，开发环境可完整回退。生产已有数据后，不允许直接 down；应先备份、停止写入并用新的前向迁移修正。Repository 接口与错误联合不依赖 `pg` 类型，未来可以替换驱动或迁移框架，但必须保持 TenantScope、原子 head 更新和数据库时钟 Lease 语义。
