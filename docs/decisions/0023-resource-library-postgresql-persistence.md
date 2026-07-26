# ADR-0023：Resource Library PostgreSQL 目录与显式提升提交

- 状态：已接受
- 日期：2026-07-26
- 决策者：M3 PostgreSQL 持久化实施
- 关联任务/PR：M3 Resource Library PostgreSQL 持久层与 RLS
- 替代关系：细化 ADR-0005、ADR-0012 与 ADR-0020，不替代既有决策

## 背景

ADR-0020 已固定 Resource 搜索、局部预览、显式导入计划和 Agent-only 提升请求的应用语义，但当时没有数据库表、RLS 或稳定 Blob 引用。ResourceVersion 一旦可搜索，就必须同时拥有可验证的 Tenant 归属和完整 stable Blob 物理身份；否则 GC、跨租户授权和恢复都无法证明内容仍可读取。

当前 PostgreSQL 的 WorkspaceRevision 只保存 Revision 级对象，不保存逐文件 Manifest。Workspace 核心已经定义逐文件 Manifest，但真实 PG 提交尚未接入。因此本切片不能声称能从任意 Revision 路径自行签发提升授权。

## 决策驱动因素

- ResourceVersion 创建后不可原地修改，Resource latest 只能用短事务 CAS 推进；
- 搜索与 resolve 必须同时经过可信 Tenant/User context、active Membership 和 FORCE RLS；
- pending 提升不能在目录中出现，版本也不能先可见再补 Blob 引用；
- 版本引用必须固定 incarnationId、physicalObjectKey、SHA-256 和大小，且与 ADR-0012 生命周期连续；
- 同一幂等键需要在 COMMIT 响应未知后精确读回，不能重复发布版本；
- 在 Workspace 逐文件事实尚未落库时，必须保守缩窄接口而不是伪造路径授权完成。

## 备选方案

### 方案 A：ResourceVersion 只保存 objectKey 和摘要

字段较少，但 objectKey 不能证明当前 lifecycle/incarnation，GC 与旧副作用可能让引用指向错误物理对象，不符合 ADR-0012。

### 方案 B：版本复合外键绑定 stable blob reference，并消费 Workspace 持久授权

ResourceVersion 保存完整 Blob 身份并复合外键到 `blob_references`。Workspace 事实源以后在自己的可信事务边界写入短期、一次性授权；Resource 提交只消费授权并重验 Membership、Agent、Thread、Run、Revision 和 Writer Lease。当前不公开授权写入 API。

### 方案 C：Resource Repository 读取 Workspace 对象或 S3 Manifest 后自行判断路径

可在本切片内做出完整流程，但会把对象读取放进数据库事务，还会在 Workspace PG Manifest 未冻结时创建第二套解析事实，失败恢复和锁序都不清晰。

## 选择

采用方案 B：

1. `resources` 以 `(tenant_id, id)` 为主键，保存 `pending_explicit_commit | searchable`、latest version number/id 和规范搜索名；搜索固定按 `updated_at DESC, id DESC`，after 条件使用严格小于位置。
2. `resource_versions` 以 Tenant + Resource + Version 为复合身份，版本号和父版本形成不可变链；Runtime 只有 `SELECT/INSERT`，没有任何 UPDATE/DELETE 权限。
3. 每个版本同时保存并复合外键绑定 `blob_reference_id + purpose + lifecycleId + incarnationId + physicalObjectKey + sha256 + size`。提交事务只接受 `state=stable`、`purpose=resource`、active lifecycle/current active incarnation，且与授权摘要、大小、媒体类型相同的引用。
4. 新 Resource 在事务内可以短暂处于 pending/head=0；同一事务插入 Version、推进 latest、切换 searchable、消费授权并写幂等记录。事务提交前没有其他连接可见，任一失败整体回滚。
5. `resource_promotion_authorizations` 绑定 Tenant、User、AgentThread、Thread、Run、Workspace、Revision、Writer Lease epoch、规范路径、内容描述符和数据库 TTL。提交固定锁序为幂等 advisory lock → Resource advisory lock → Membership → authorization/Run/lease → stable reference/lifecycle/incarnation → Resource head。
6. 提交端口只接受 `AuthorizedAgentResourceContext`。同一用户的其他 Agent/Run 不能消费授权；active Membership、active Thread、running Run、未过期 Writer Lease 与授权 TTL 都在当前事务用数据库时钟重验。
7. 当前没有逐文件 Workspace PG Manifest，因此本包不提供授权签发方法。未来 Workspace Repository 必须在 Writer Lease 下验证 Revision 中的路径和完整 Blob 描述符后写入授权；普通 HTTP、Tool 参数和 Resource 包调用方不能创建授权。迁移表与消费端口是集成点，不代表 Workspace 实际物化或提升端到端已经完成。
8. 幂等记录按 Tenant + User + key 唯一，Repository 对规范输入自行计算 SHA-256 请求摘要。同键同摘要读回精确 Resource/Version；异摘要返回 `key_conflict`。COMMIT 响应未知只按同一键读回，不存在时继续返回脱敏 `UNAVAILABLE`。
9. 四张新业务表全部 ENABLE/FORCE RLS。Runtime 只取得明确的 SELECT/INSERT 与 `resources` head/visibility、authorization state/consumedAt 的列级 UPDATE；没有 DELETE、TRUNCATE、REFERENCES、TRIGGER 或任意 SQL 端口。生产装配只暴露 `ResourceCatalog` 和 `ResourcePromotionCommitPort`。

## 理由

该选择把“Workspace 证明某个路径快照可提升”和“Resource 原子发布可搜索版本”分成两个可审计事务能力，同时不把尚不存在的 Workspace PG Manifest 冒充事实源。完整 Blob 复合身份使 ResourceVersion 与 GC 使用同一 incarnation 语义；数据库 RLS、Membership 条件和应用层 scope 形成三道租户边界。

## 影响

### 正面影响

- pending 或无 stable Blob 的版本不会进入搜索与 resolve；
- 并发 latest 更新只有一个成功，ResourceVersion 历史不会被覆盖；
- COMMIT 响应丢失可精确恢复，不会创建第二个版本；
- 直接 Runtime SQL 也受 FORCE RLS 和列级 ACL 限制。

### 负面影响与成本

- Resource 表额外保存 Blob 完整身份，Schema 与集成测试更复杂；
- 同一 stable 内容若形成多个业务版本，需要独立 `blob_reference`，不能复用同一引用行；
- Workspace 提升在逐文件 Manifest 持久化和可信授权写入完成前仍然 fail closed。

### 安全、数据与运维影响

- 授权 ID 不是裸对象读取能力；消费仍需完全匹配当前可信 Agent 执行上下文；
- Runtime 日志和稳定错误不包含 SQL、对象键、连接串或驱动消息；
- 生产产生 ResourceVersion 后不得 down 0008；应使用前向迁移修正。

## 验证

- 真实 PostgreSQL 双租户目录、resolve 和直接 Runtime SQL 越权矩阵；
- 四张表 ENABLE/FORCE RLS 与完整表级/列级 ACL 白名单；
- pending 隐藏、稳定分页、并发 latest CAS、不可变 Version；
- active Membership、AgentThread/Run、Thread、数据库时钟 Writer Lease 与授权 TTL 重验；
- stable Blob 完整身份、失败事务回滚、同键重放、异摘要冲突和 COMMIT unknown 读回；
- 0008 down/up、现有迁移总版本断言、partial down 与根工程质量门禁。

## 明确未覆盖

- 上传意图、multipart/大文件上传和真实 S3/MinIO Resource 内容范围读取；
- HTTP 上传、Resource 搜索/预览/导入接口和真实 FileSource；
- Workspace 逐文件 Manifest 的 PostgreSQL 提交、授权签发与 Sandbox 实际物化；
- 用户手动提升、丰富预览和 UI。

这些能力必须复用本 ADR 的 Tenant、版本、Blob 身份与授权边界，不能直接向目录插入 searchable 行绕过提交端口。

## 可逆性与回退

在没有生产 ResourceVersion 时，development/test 可通过 0008 down 回到 0007，再次 up 可恢复空表。已有生产版本后，物理删除表、取消 FORCE RLS、缩短 Blob 身份或把版本改为可变都属于不可接受回退；功能可以停止装配，但数据修正必须使用新的前向迁移。

## 实施记录

- 2026-07-26：新增 0008 migration、`PgResourceCatalog`、`PgResourcePromotionRepository`、生产窄装配端口和真实 PostgreSQL 集成验证。
