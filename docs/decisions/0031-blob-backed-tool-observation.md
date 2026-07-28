# ADR-0031：Blob-backed Tool Observation 截断切片

- 状态：已接受
- 日期：2026-07-28
- 关联：M5 可靠执行、恢复与长上下文

## 背景

工具可能输出超大文本、Unicode 内容或失败细节。若直接把结果塞入 Pi 会话或 Rollout，既无法稳定控制模型上下文，也会使重启后的事实与模型可见内容不一致。仅先截断则丢失可审计的完整输出；仅上传对象而未完成 stable 引用又不能称为已保存。

## 决策

`ToolObservationPipeline` 采用严格顺序：先将 UTF-8 原始输出经 `TraceBlobPersistencePort` 持久化为同租户 `stable/trace` Blob，校验 reference、摘要、大小、incarnation 与物理键，再生成 observation 并通过 `ToolObservationRolloutPort` 写入 `tool_result`。两个端口均使用派生的固定幂等键，因此进程重启/重放不改变事实。

模型可见内容按 UTF-8 字节预算截断，并按 Unicode code point 迭代，不能切开多字节字符。预算包含截断占位符；极小预算允许 observation 为空或只有前缀的一部分。完整的工具调用配对、工具名、原始字节摘要、大小、截断原因及 Blob ref 始终写入 Rollout body，而不挤占模型预算。

Blob 返回 `unavailable`、`unknown` 或 `conflict` 时，不写 Rollout，不回传完整输出，也不显示“已保存”。Rollout 失败/未知时完整输出仍只保留在 Blob，调用方必须进行同一命令的幂等恢复，不能另造 observation。

## 备选方案

1. 先写 Rollout，再异步上传 Blob：Rollout 可指向不存在内容，重启期间无法证明完整输出存在。
2. 仅在超限时保存 Blob：小输出的审计、重放与安全语义会分叉。
3. 让 Pi/模型 SDK 负责截断：无法把预算、完整事实和恢复策略固定在 Runtime。

## 影响与可逆性

该切片只定义应用核心与端口，不实现完整 Worker 装配。生产适配器必须把 `TraceBlobPersistencePort` 接到现有 PG Blob 生命周期 + MinIO/S3 promotion，并把 `ToolObservationRolloutPort` 接到 `PgRuntimeRolloutRepository.append` 的 `tool_result` 草稿；后者会再次校验同租户 stable/trace 引用。端口可替换，但不得改变“先 stable Blob，后 Rollout”的顺序。

## 验证

单元测试覆盖大输出、Unicode、极小预算、Blob unknown、重放幂等键及跨租户伪造 Blob。后续接线时必须增加 PostgreSQL + MinIO 集成测试，验证真实 promotion、append replay 与 RLS。
