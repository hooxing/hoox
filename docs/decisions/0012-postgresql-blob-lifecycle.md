# ADR-0012：PostgreSQL Stable Blob 生命周期与副作用证明

- 状态：已接受
- 日期：2026-07-26
- 决策者：Runtime 实施审阅
- 关联任务/PR：M2 PostgreSQL Blob Lifecycle
- 替代关系：细化 ADR-0010，不替代既有决策

## 背景

ADR-0010 已确定 incarnation 不复用、promotion 必须由 PostgreSQL 授权、GC 必须先持久化不可逆意图，但尚未确定实际表边界、事务锁序、租约和 Runtime 权限。S3 的 COPY/DELETE 无法加入 PostgreSQL 事务，任一数据库响应也可能在 COMMIT 后丢失，因此不能依靠进程内状态证明“没有发出 COPY”或“仍有权删除”。

## 决策驱动因素

- 旧 Worker 的迟到 COPY/DELETE 不能作用于新 incarnation；
- Tenant RLS、复合外键和 Runtime ACL 必须共同阻止跨租户身份拼接；
- reserve、授权、execution、GC 和 scrub 必须能在响应丢失后幂等读回；
- migration manifest 首版禁止创建自定义 routine；
- 物理身份历史和远端副作用证明一旦形成，Runtime 不得物理删除。

## 备选方案

### 方案 A：单一 JSON 状态表

只保存 commit JSON，通过应用代码解释生命周期。迁移简单，但数据库无法用外键约束 authorization、execution、claim 与精确 incarnation/key 的连续性，也无法给审计表配置精确权限。

### 方案 B：规范化生命周期与审计表

分别保存 lifecycle、incarnation、allocation、commit、authorization、execution、GC claim、retired tombstone 和 reference。关键 CAS 在事务中锁定规范行，JSON snapshot 只保存协调器快照，不作为物理身份事实源。表较多，但约束和恢复边界可由数据库验证。

### 方案 C：数据库函数封装全部状态机

把签发和 CAS 写成 PostgreSQL routine。可减少网络往返，但扩大数据库可执行代码与权限面，违反当前无 routine manifest，也增加迁移和审计成本。

## 选择

采用方案 B，并确认以下实施规则：

1. `blob_lifecycles` 以 `(tenant_id, purpose, sha256, size)` 唯一；`blob_incarnations` 的 UUID 和 `physical_object_key` 全局永久唯一，retired 行和 tombstone 永不删除。
2. `blob_allocations`、`promotion_authorizations`、`promotion_executions`、`blob_gc_claims` 和 `blob_references` 都用复合 Tenant 外键绑定精确 lifecycle/incarnation/key。authorization 的 current execution 还必须用 `(tenant_id, authorization_id, execution_id, generation)` 复合外键指向同一 authorization 的 execution，Repository 读回后再次核对 Tenant、operation、authorization、execution 和 generation 连续性。`blob_commits.snapshot` 是协调快照；规范状态、version 和 Tenant 另列并做一致性读回校验。
3. reserve 在 `READ COMMITTED` 事务中按“operation → 逻辑 Blob”固定顺序取得 PostgreSQL advisory transaction lock，再锁 lifecycle。这样可在 RLS `set_config` 已执行的情况下等待前序事务后读取最新提交，避免 `SERIALIZABLE` 旧快照导致无意义重试。只使用 PostgreSQL 内建锁函数，不创建自定义 routine。
4. `startPromotion` 同事务锁 commit、allocation、lifecycle，派生完整 authorization 并 CAS snapshot；普通 CAS 禁止签发 `promotion_started` 或把它退回 `allocation_reserved`。
5. execution 的 `pre_intent → copy_issued` 是不可逆证明边界。所有同时访问 promotion authorization 与 execution 的事务，统一按“authorization → current execution”加行锁；complete、proof、claim 和 COPY intent 不得采用相反锁序。只有持久的 `pre_intent/not_copied` 可由 `provePromotionNotCopied` 原子消费；`copy_issued/succeeded` 永远不能证明未复制。UNKNOWN 保留同一 execution 和固定 destination，只允许 HEAD 恢复。
6. GC 先检查同一 incarnation 的 stable 引用和未收敛 promotion，再签发数据库时钟 lease。`pre_delete → deleting` 不可逆；租约接管只更换 claimId、递增 generation 并保持物理身份与 phase。
7. complete deletion 同事务退休 incarnation、写永久 tombstone。scrubber 用数据库租约领取 tombstone，只删除其中固定 key，完成后推进下一次 scrub 时间而不删除记录。
8. 所有新表启用并强制 RLS。Runtime 对 allocation 只有 `SELECT/INSERT`；其余生命周期和审计表也不授予表级 `UPDATE`，只按列授予状态机确实需要更新的 state、phase、proof、lease、version、snapshot、current 指针和时间列。Tenant、operation、authorization、execution、attempt、generation、incarnation 与物理 key 等身份列不可由 Runtime 改写；全部表无 `DELETE/TRUNCATE/REFERENCES/TRIGGER` 权限。
9. `startPromotion`、`provePromotionNotCopied`、`markPromotionCopyIssued` 和 `beginDeletion` 都以稳定输入支持“COMMIT 已成功但响应丢失”后的幂等读回；传输异常只表示结果未知，不得据此重复发出新的远端副作用。

## 理由

规范化表使数据库约束可以证明每次远端副作用绑定的 Tenant、operation、incarnation 和 key 完全一致。永久物理身份历史把“旧请求无法撤销”转化为地址隔离问题；数据库时钟和 CAS 则只决定谁能推进事实源。与数据库 routine 相比，显式 TypeScript 事务保留当前可测试的适配器边界，并遵守迁移安全 manifest。

## 影响

### 正面影响

- 并发 reserve 对同一逻辑内容复用同一 live incarnation；
- COPY/DELETE 响应未知不会触发第二个不受控副作用；
- 旧 incarnation 的迟到操作只能制造或删除旧 key，tombstone scrub 可持续收敛；
- 权限矩阵可阻止 Runtime 删除永久证明或改写其身份列。

### 负面影响与成本

- promotion 和 GC 需要多行锁与多次 SQL 往返；
- retired tombstone 永久增长，需要后续容量监控和只读归档策略，但不能删除唯一性事实；
- 业务引用删除/版本化必须另由领域 Repository 在同一 lifecycle 事务边界接入。

### 安全、数据与运维影响

- 生产备份必须同时覆盖全部生命周期表和对象存储；只恢复其中一侧会进入人工恢复流程；
- lease 时长和 scrub 周期是运行时配置，判定始终使用数据库 `clock_timestamp()`；
- 迁移 down 只允许 development/test，生产写入后不可通过删除表回退。

## 验证

- 真实 PostgreSQL：并发 reserve 去重、相同 operation 读回、跨 Tenant 隔离、完整授权绑定、单 copy attempt、UNKNOWN 恢复、GC lease 接管和不可逆 phase；
- 真实 PostgreSQL + MinIO：两代 incarnation 发布/读取/删除、旧 key 迟到 COPY 后 tombstone scrub、旧 DELETE 不伤新对象；
- 故障注入：COMMIT 已成功但响应丢失后，reserve、promotion start/proof/COPY intent 和 GC begin 均用稳定输入读回规范结果；
- 并发与约束：promotion 并发交错无 `40P01` 并收敛到同一 execution；错绑 current execution 被复合外键拒绝；Runtime 改写 execution 审计身份列被列级 ACL 拒绝；
- 迁移：并发 up、down、失败回滚、再次 up、无业务表残留、无 routine、Runtime 表级与列级精确权限矩阵；
- 全量 `check:clean-vendor` 与敏感信息扫描。

## 可逆性与回退

在没有生产数据时可执行 0002 down，恢复到只含核心表的版本。产生 stable incarnation、authorization 或 tombstone 后，代码可停止使用新能力，但不能删除永久身份和证明；真正回退需要冻结写入、导出完整历史并提供等价约束的新存储方案。

## 后续工作

- 将 Artifact/Resource/Workspace 的实际引用版本表接入 `blob_references` 的生命周期事务；
- 增加 tombstone 数量、lease 接管、UNKNOWN 停留时间和 scrub 延迟指标；
- 为生产备份恢复建立 PostgreSQL 与对象存储的一致性演练。

## 实施记录

- 2026-07-26：新增 0002 迁移、`PgBlobLifecycleRepository`、Runtime factory 接线与真实 PostgreSQL/MinIO 纵向验证。
- 2026-07-26：审阅修正统一 promotion 锁序，增加 current execution 复合绑定、Runtime 列级最小权限，以及关键事务 COMMIT 响应丢失和并发交错验证。
