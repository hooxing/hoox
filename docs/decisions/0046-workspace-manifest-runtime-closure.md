# ADR-0046：Workspace manifest Runtime 闭环

- 状态：部分接受（Worker 发布启用延期）
- 日期：2026-07-29

## 背景

ADR-0038 为避免 Sandbox 文件在成功 Run 后丢失，要求非空 `/workspace` 失败关闭。该下限不具备跨 Run
物化能力，也不能把一个扁平 `object_key` 当成 Workspace 的内容事实。现有 `WorkspacePublisher` 和
`WorkspaceMaterializer` 已具备快照、逐文件摘要、stable incarnation 与 journal 语义，但尚未接入
development Worker 的真实装配和 RuntimeMutation 事务。

约束如下：每个文件必须引用精确的 stable Blob incarnation；Workspace head 推进、revision、manifest
和文件引用必须同 RuntimeMutation 事务提交；Journal 的 unknown 不能被重试覆盖；新 Sandbox 必须在
创建 Session/模型调用前物化 Attempt checkpoint 指向的 head。

## 备选

1. 继续使用 ADR-0038 的空目录 verifier。安全但所有非空 Workspace Run 都不可用，无法交付用户文件。
2. 保存一个 tar/manifest Blob 的 `object_key`，在下一 Run 下载并解包。实现较短，但丢失逐文件 stable
   incarnation、GC reachability 和路径安全证明，且会把实现细节伪装为内容事实。
3. 以逐文件 stable Blob manifest 作为 revision 内容事实，复用 Publisher/Materializer、Blob lifecycle
   和 CubeSandbox Workspace port，并在 Worker 两个安全点接线。

## 决策

采用方案 3 的数据模型与持久化约束，但暂不启用 Worker 的发布路径。候选 Blob 现在会先取得 stable
引用，而 RuntimeMutation 的 lease/CAS、取消和 unknown 结果发生在后面；这不是可证明的引用交接，不能把
它当作可回收的发布事务。development Worker 因此继续采用 ADR-0038 的失败关闭装配，直到候选引用能与
revision/head 提交原子绑定，或有等价的持久化补偿与恢复协议。

迁移 `0014_workspace_manifest_journal` 新增 `workspace_revision_manifests`、
`workspace_revision_files` 和 `workspace_operation_journal`。文件行用 lifecycle、incarnation 与物理键
的复合外键绑定精确 stable Blob；GC 将这些文件行计为可达引用。新 RuntimeMutation 写入 revision、manifest、
文件行并推进 head 的操作处于同一 PostgreSQL 事务。新 revision 的旧 `object_key` 为 `NULL`，不再承担
manifest 角色。

Worker 的 `WorkspaceRuntimePort.materialize` 在 cleanup intent 已提交、Session 创建前执行；它拒绝
Attempt checkpoint 与当前 head 不一致。该 runtime 会先证明新 Sandbox 的 `/workspace` 为空，不能将模板
或上次执行残留当作可信 previous。当前 production/development 装配不调用它的 `verify` 发布；空目录 verifier
在模型前与模型后均检查根目录和额外文件，避免未交接的候选 Blob 或 Sandbox 文件被静默成功关闭。

CubeSandbox Workspace capability 只能由 acquire 时冻结的完整 `ExecutionScope` 和同一 `SandboxSessionRef`
经 registry 私有 WeakMap 派生；之后所有 scope 字段都必须逐一相同。适配器经 Cube SDK 在远端执行文件 I/O，
因此 development Worker 的 Windows 宿主不会获得本地文件能力。

## 影响

- 正面：schema 已禁止 flat `object_key` 伪装 manifest，且完成后的 revision 可精确引用 stable incarnation。
- 负面：当前 Worker 会拒绝所有非空 Workspace，跨 Run 文件闭环尚不可用。
- 兼容：`0014` 不尝试越过 FORCE RLS 检查或猜测转换旧 `current_revision_id`；运行时遇到没有 manifest 的旧
  head 必须失败关闭。运维必须先运行受控 backfill 或在确认可丢弃后清空 head；迁移后 Worker path 不读取或
  写入 legacy object_key。
- 未包含：Artifact declaration/publication 与用户下载继续由 Artifact Router 闭环；本 ADR 不把 Workspace
  文件自动发布成 Artifact，也不改变生产认证边界。

## 验证

- Workspace 核心测试覆盖 manifest、materializer、publisher、snapshot 与 journal 不变量。
- Worker 测试断言 materialize/空目录预检发生在 Session 前，根缺失或额外模板文件失败时执行 cleanup 且不启动模型。
- `PgExecutionPersistence.mutate` 在写 manifest 前逐文件核验 stable incarnation 为 active；迁移包含 RLS、
  外键和 journal 单调状态约束。
- 启用发布前必须补齐候选引用与 RuntimeMutation/CAS 的原子交接，并对 unchanged/cancel/conflict/unknown
  证明无 orphan stable 引用，再执行真实 development PostgreSQL/MinIO/CubeSandbox 跨 Run 冒烟。

## 可逆性

在没有写入新 revision 前可回退到 ADR-0038 的失败关闭装配。写入 `0014` manifest 后不能删除文件引用或
重用 incarnation；开发/测试环境可用迁移 down 将 legacy column 还原为占位兼容值，生产回退应保留新表与
数据、仅停止新 Worker 接线，避免破坏已提交的 Workspace 历史。
