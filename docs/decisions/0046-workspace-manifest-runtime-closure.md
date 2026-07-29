# ADR-0046：Workspace manifest Runtime 闭环

- 状态：已接受
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

采用方案 3。

迁移 `0014_workspace_manifest_journal` 新增 `workspace_revision_manifests`、
`workspace_revision_files` 和 `workspace_operation_journal`。文件行用 lifecycle、incarnation 与物理键
的复合外键绑定精确 stable Blob；GC 将这些文件行计为可达引用。新 RuntimeMutation 写入 revision、manifest、
文件行并推进 head 的操作处于同一 PostgreSQL 事务。新 revision 的旧 `object_key` 为 `NULL`，不再承担
manifest 角色。

Worker 的 `WorkspaceRuntimePort.materialize` 在 cleanup intent 已提交、Session 创建前执行；它拒绝
Attempt checkpoint 与当前 head 不一致。模型 settled 后调用 `verify` 发布 snapshot，只有 manifest digest
变化才返回候选 revision；最终 revision/head 仍由既有 RuntimeMutation 的双栅栏、CAS 与 lease 事务提交。

CubeSandbox Workspace capability 只能由当前 `ExecutionScope` 和同一 `SandboxSessionRef` 经 registry 私有
WeakSet 派生；适配器经 Cube SDK 在远端执行文件 I/O，因此 development Worker 的 Windows 宿主不会获得
本地文件能力。

## 影响

- 正面：文件内容不会因 Sandbox close 而在成功 Run 后丢失；下一 Run 从 committed manifest 重建；
  Blob 重用/GC 不会把 revision 静默指向错误 incarnation。
- 负面：一次文件发布会产生每文件 Blob lifecycle 与 journal 写放大；model settled 后的任何未知结果都
  进入恢复而不是乐观重试。
- 兼容：迁移保留历史 revision 的 `object_key` 只供旧记录读取。新的 Worker path 不读取或写入它。
- 未包含：Artifact declaration/publication 与用户下载继续由 Artifact Router 闭环；本 ADR 不把 Workspace
  文件自动发布成 Artifact，也不改变生产认证边界。

## 验证

- Workspace 核心测试覆盖 manifest、materializer、publisher、snapshot 与 journal 不变量。
- Worker 测试断言 materialize 发生在 Session 前，失败时执行 cleanup 且不启动模型。
- `PgExecutionPersistence.mutate` 在写 manifest 前逐文件核验 stable incarnation 为 active；迁移包含 RLS、
  外键和 journal 单调状态约束。
- 合并前运行 `pnpm check`，并对真实 development PostgreSQL/MinIO/CubeSandbox 执行跨 Run 冒烟。

## 可逆性

在没有写入新 revision 前可回退到 ADR-0038 的失败关闭装配。写入 `0014` manifest 后不能删除文件引用或
重用 incarnation；开发/测试环境可用迁移 down 将 legacy column 还原为占位兼容值，生产回退应保留新表与
数据、仅停止新 Worker 接线，避免破坏已提交的 Workspace 历史。
