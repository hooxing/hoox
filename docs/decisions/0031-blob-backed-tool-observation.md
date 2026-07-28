# ADR-0031：Blob-backed Tool Observation 截断切片

- 状态：已接受
- 日期：2026-07-28
- 关联：M5 可靠执行、恢复与长上下文

## 背景

Sandbox 工具的 stdout、文件内容、代码结果和异常文本都可能包含密钥或提示注入，不能直接进入 Pi、Rollout 或审计 Blob。Runtime 仍需持久化一个可验证、可恢复且受预算约束的工具执行事实，并保证数据库响应在 COMMIT 后丢失时不会产生第二份语义不同的结果。

## 决策

`createObservedSandboxTools` 在 Tool adapter 闭包内丢弃原始成功值和错误文本，只生成固定、精确编码的 `ControlledToolReceipt`。其 schema 只允许 `schemaVersion=1`、`trust=sandbox_untrusted`、受限工具名、成功/失败枚举和由 Runtime 固定的消息；调用方不能提交任意“已脱敏文本”。`ToolObservationPipeline` 只读取并重新解析该回执，原始输出不写 Trace、Rollout、日志或模型上下文。

Pipeline 采用严格顺序：先将受控回执的 UTF-8 字节经 `TraceBlobPersistencePort` 持久化为同租户 `stable/trace` Blob，校验 reference、摘要、大小、incarnation 与物理键，再生成模型可见 observation 并通过 `ToolObservationRolloutPort` 写入 `tool_result`。Rollout body 使用精确的 schemaVersion 2，并绑定回执摘要、大小、固定回执、可见字节数和截断原因；恢复时还要与数据库返回的 stable Blob reference、摘要和大小逐字段相互验证。

实际执行路径在领取 Sandbox 副作用许可后、触碰 Sandbox 前自动追加 `{toolName}` 的 `tool_call` 前驱；结果适配器只允许同一 `tenantId + threadId + runId + attemptId + agentThreadId + toolCallId` 的 `tool_result`。生产工厂必须把当前完整 `ExecutionScope`、Attempt 和 AgentThread 绑定进两个端口，错接任何一项都在写入前失败。数据库的相邻配对约束继续保证同 call ID 的 `tool_call` 后只能紧跟 `tool_result`。

模型可见 payload 与 Rollout body 使用两套独立硬预算；后者不超过数据库的 16 KiB 约束。模型可见内容按 UTF-8 字节预算和 Unicode code point 截断，不能切开多字节字符；这不是 grapheme cluster 契约。截断占位符只声明“受控执行回执已保存”，必须完整装入，否则返回空字符串。

Blob 或 Rollout 返回 `unknown` 时，适配器以完全相同的冻结命令和幂等键立即读回/重放一次：若第一次实际已提交，第二次必须收敛为 `replayed`；仍未知则中止 Pi，本 Attempt 进入 `recovery_required`，绝不能返回普通 Tool error 后继续成功。`conflict` 同样不能降级为模型可见结果。

## 备选方案

1. 保存原始输出再声明“低信任”：仍扩大密钥与提示注入的持久暴露面。
2. 先写 Rollout，再异步上传 Blob：Rollout 可指向不存在的回执，重启期间无法证明事实。
3. 让 Pi/模型 SDK 负责截断：无法把预算、Blob 证明和恢复策略固定在 Runtime。

## 影响与可逆性

`DurableTraceBlobPersistenceAdapter` 将回执 Blob 接到现有 PostgreSQL Blob commit/promotion 状态机和 S3/MinIO。`PgToolObservationRolloutAdapter` 接到 PostgreSQL Rollout，并在写入前验证可信 scope 绑定。Rollout 表通过复合外键绑定 stable/trace reference；适配器不以应用层一次查询冒充授权或完整性证明。端口可替换，但不得改变“自动前驱 → Sandbox → stable 回执 Blob → tool_result”的顺序和同键 UNKNOWN 收敛规则。

## 验证

单元测试覆盖固定回执精确 schema、原始成功/失败值隔离、Unicode/极小预算、双预算、Blob unknown、同键重放、scope 伪造、自动前驱和持续 UNKNOWN 强制恢复。真实 PostgreSQL + MinIO 集成覆盖自动 `tool_call`、Trace promotion、Rollout append 与进程级 adapter 重建后的同命令重放。
