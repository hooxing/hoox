# ADR-0031：Blob-backed Tool Observation 截断切片

- 状态：已接受
- 日期：2026-07-28
- 关联：M5 可靠执行、恢复与长上下文

## 背景

工具可能输出超大文本、Unicode 内容或失败细节。若直接把结果塞入 Pi 会话或 Rollout，既无法稳定控制模型上下文，也会使重启后的事实与模型可见内容不一致。仅先截断则丢失可审计的完整输出；仅上传对象而未完成 stable 引用又不能称为已保存。

## 决策

`ToolObservationPipeline` 采用严格顺序：先将 UTF-8 原始输出经 `TraceBlobPersistencePort` 持久化为同租户 `stable/trace` Blob，校验 reference、摘要、大小、incarnation 与物理键，再生成 observation 并通过 `ToolObservationRolloutPort` 写入 `tool_result`。两个端口均使用派生的固定幂等键，因此进程重启/重放不改变事实。

模型可见 payload 与 Rollout body 使用两套独立硬预算；后者不超过数据库的 16 KiB 约束。模型可见内容按 UTF-8 字节预算截断，并按 Unicode code point 迭代，不能切开多字节字符；这不是 grapheme cluster 契约，组合字符可能在 code point 边界分开。占位符必须完整装入，否则返回空字符串，绝不生成半个标记。完整的工具调用配对、工具名、原始字节摘要、大小、截断原因及受限 Blob ref 写入 Rollout body；不持久化不可信的物理对象键。

Blob 返回 `unavailable`、`unknown` 或 `conflict` 时，不写 Rollout，不回传完整输出，也不显示“已保存”。Rollout 失败/未知时完整输出仍只保留在 Blob，调用方必须进行同一命令的幂等恢复，不能另造 observation。

## 备选方案

1. 先写 Rollout，再异步上传 Blob：Rollout 可指向不存在内容，重启期间无法证明完整输出存在。
2. 仅在超限时保存 Blob：小输出的审计、重放与安全语义会分叉。
3. 让 Pi/模型 SDK 负责截断：无法把预算、完整事实和恢复策略固定在 Runtime。

## 影响与可逆性

`DurableTraceBlobPersistenceAdapter` 与受审工厂已经把 `TraceBlobPersistencePort` 接到现有 PostgreSQL Blob commit/promotion 状态机和 S3/MinIO：暂存、引用提交、allocation、授权 promotion、stable HEAD/mark 与 staging 清理均以持久 snapshot 恢复。`PgToolObservationRolloutAdapter` 接到 `PgRuntimeRolloutRepository.append` 的 `tool_result` 草稿。Rollout 表通过 `(tenant_id, reference_id, state, purpose, sha256, size)` 复合外键绑定 `blob_references` 的 stable/trace 事实；适配器本身不以一次应用层查询冒充授权或完整性证明。前驱复合外键与 CHECK 约束保证 `tool_call` 后只能紧跟相同 `toolCallId` 的 `tool_result`。端口可替换，但不得改变“先 stable Blob，后 Rollout”的顺序。

## 验证

单元测试覆盖大输出、Unicode、极小预算、双预算、Blob unknown、重放幂等键及跨租户伪造 Blob。真实 PostgreSQL + MinIO 集成覆盖 Trace promotion、Rollout append 与进程级 adapter 重建后的同命令重放；既有 Rollout 集成继续覆盖配对、幂等冲突、跨租户 RLS 与 stable/trace 外键。
