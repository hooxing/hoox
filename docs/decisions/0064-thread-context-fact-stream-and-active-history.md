# ADR-0064：Thread Context 事实流与活动历史

- 状态：已接受（阶段 2）
- 日期：2026-07-31
- 决策者：实施总计划维护者
- 关联任务/PR：阶段 0 语义冻结；ADR-0030、ADR-0032、ADR-0035、ADR-0063
- 替代关系：不替代现有 Attempt rollout；阶段 2 以双写和影子读取增量引入

## 背景

当前 `runtime_rollout_*`、`rollout_projections` 和 waiting recovery 都以 Run/Attempt 为恢复边界。新 Run 的 `initial_projection` 固定为空，因此这些事实能恢复一次 Attempt，却不能恢复整个业务 Thread 的连续对话。`run_events` 又承担 UI 流式展示，包含 partial/progress，不能直接作为跨 Run 模型历史。

[Thread 连续上下文实施总计划](../plans/thread-continuous-context.md) 已确定 Thread 是连续对话边界、Run 是执行单元、Canonical Context 必须按当前可信配置重建。本 ADR 定义 Thread 事实流、活动历史和现有 Attempt rollout 的关系，不定义 compaction 算法。

## 决策驱动因素

- Run B 必须从服务端可信事实恢复 Run A 的有效历史；
- 原始用户、Assistant、工具和 terminal 事实必须可审计、不可被压缩覆盖；
- partial UI 事件不得污染模型长期上下文；
- 当前 Attempt 恢复路径在新能力稳定前必须保持可用；
- Provider、模型或工具 schema 变化必须显式判定兼容性。

## 备选方案

### 方案 A：创建 Run 时回放 `run_events`

无需新事实表，但 `run_events` 混有流式 partial、UI 进度和内部失败信息，角色与工具配对也不是它的稳定契约。

### 方案 B：把 Attempt rollout 扩展为跨 Run

能复用表，但主键、fencing、terminal 和 checkpoint 都绑定 Attempt。直接扩展会同时改变现有恢复语义，迁移与回滚风险过高。

### 方案 C：新增 Thread facts，并保留 Attempt rollout（选择）

Thread Context 负责跨 Run 长期事实和模型活动历史；Attempt rollout 继续负责当前 Run/Attempt 的崩溃恢复。迁移期规范化双写并比较 digest。

## 选择

1. 每个 Thread 建立一条 `thread_context_streams`，并在 `thread_context_entries` 中保存单调、无间隙、仅追加的事实。sequence 由 ADR-0063 的 Thread writer 在短事务中分配。
2. 至少持久化 `run_started`、最终 `user_message`、最终 `assistant_message`、规范化 `tool_call`、对应 `tool_result`/结构化失败、`workspace_committed`/`workspace_unchanged`、`run_terminal`、rollback/cancel 标记和后续 compaction checkpoint 引用。
3. 流式 token、未完成 Assistant partial、UI progress、异常栈、秘密和全量 Workspace 文件不进入 Thread Context。`run_events` 继续只服务事件流/UI。
4. 用户正文、Assistant/tool 大正文必须保存可恢复内容或受审计 Stable Blob 引用。digest 只用于完整性与幂等冲突，不能代替正文事实。
5. tool call/result 必须按 Provider 实际产生且通过协议验证的顺序成对追加。无法证明配对时停止构建活动历史，不伪造 tool result。
6. failed/cancelled Run 的已确认事实不删除；活动历史通过明确 terminal/rollback 语义表达“未成功提交”，不能把 partial 或未提交 Workspace 描述为成功。
7. 活动历史由 Context Builder 确定性构建。未启用 compaction 时，它等于从起点规范化的有效 Thread facts；启用后等于最新兼容 checkpoint 的完整 replacement history 加其后的有效 facts。
8. Canonical Context 不属于历史摘要。每次 Session、窗口或模型兼容身份变化时，都由当前可信 Prompt/Tool/Skill/权限/Workspace 配置重新构建，并与低信任历史分层。
9. `compatibility_identity` 至少覆盖 Provider/模型协议能力、Context projection schema、tool schema、Prompt/Skill 身份及支持的 reasoning/多模态 item。身份不兼容时必须显式压缩、降级或拒绝，不能静默删项。
10. 阶段 2 继续维护 Attempt rollout。写入 Thread facts 后执行 shadow reconstruction，将 Provider-visible history digest 与现有运行投影比较；只有 Gate 通过后才开启 V2 read。
11. 阶段 2 的 Provider 投影保留真实 `user`、`assistant`、`toolResult` 角色与 tool call/result 配对，不把整段历史折叠成单条伪 user 文本。reasoning signature、图片或其他尚未冻结的 item 必须以 `unsupported`/协议错误失败关闭。
12. queued Run 的 `context_through_sequence` 仍只在激活时冻结。当前 Run 的 `run_started` 和 user fact 在 claim 事务中追加，但不回写该 predecessor cursor；下一 Run 只有在前一 Run 的 terminal append 完成后才激活并捕获新 cursor。
13. 大 body 先通过现有 Trace Blob commit/promotion 状态机形成 exact stable identity，再由 Thread writer 的短事务引用。正文阈值由 `THREAD_CONTEXT_INLINE_BODY_MAX_BYTES` 配置，当前样例值不是永久协议常量。
14. failed/cancelled 已确认的 assistant/tool facts保持原样；活动历史追加低信任 Runtime notice，明确未提交 Workspace 不算成功。阶段 2 不生成 checkpoint、不删除事实、不复用跨 Run Sandbox。

首版逻辑 Schema 版本为：

- `thread_context_entry.schema_version = 1`；
- `thread_active_history.projection_schema_version = 1`；
- `thread_context_append_command.schema_version = 1`。

它们与现有 `ControlledRolloutProjection.schemaVersion=2` 没有继承关系，禁止仅因字段相似就互相反序列化。

## 活动历史恢复公式

```text
Active History
= 最新兼容 checkpoint 的完整 replacement history（若存在）
+ checkpoint.through_sequence 之后的有效 Thread Context facts

Provider Request
= 当前可信 Canonical Context
+ Active History 的协议投影
+ 当前尚未进入事实流的受控调用输入（仅在明确边界内）
```

Context Builder 只接受数据库/Stable Blob 的可信读取结果，不接受客户端提交的历史、previous response ID 或任意 messages 数组。

## 影响

### 正面影响

- Thread 连续语义不再依赖 Worker 内存、Pi Session 文件或某个 Sandbox；
- 原始事实、UI 事件和模型活动窗口职责分离；
- 可以在不破坏 Attempt 恢复的前提下影子验证新读路径。

### 负面影响与成本

- 迁移期存在双写、两个投影和 digest 对账成本；
- facts 长期增长，需要 Blob 化、归档和容量指标；
- Provider 特殊 item、模型切换和多模态兼容需要显式 adapter 分支。

### 安全、数据与运维影响

- 历史用户/工具内容始终是低信任数据，不能提升为 system/developer 指令；
- 日志和指标不得记录正文、完整 tool output 或 Blob 下载凭据；
- entry 内联上限、Blob 阈值、旧 Thread backfill 深度和历史容量策略均为可配置参数或待决项。

## Feature Flag 与兼容

- `thread_context_v2_write`：只写 Thread facts，不改变模型读取；默认关闭。
- `thread_context_v2_shadow_read`：重建并比较 digest，但不喂给模型；依赖 V2 write 和 Thread 串行队列。
- `thread_context_v2_read`：模型读取 V2 Active History；依赖 shadow Gate 通过，按 Tenant/新 Thread 灰度。
- 关闭 read 后回到旧每 Run projection；已经写入的 facts 保留并继续可审计。关闭 write 前必须先关闭 read。
- 旧 Thread 不推测完整历史。阶段 6 只回填可证明事实，并对缺口写 `legacy_history_gap`/V2 anchor。

## 验证

- 规范化 entry 角色、sequence、append 幂等、tool pairing 和 terminal 后追加负例；
- 大正文 Blob 引用、digest、Tenant 归属和不可达 staged Blob 负例；
- Run A → Run B 的 wire trace 明确包含 A 的有效 user/assistant/tool 历史；
- 服务重启前后 Provider-visible history digest 相同；
- partial Assistant 不进入 Thread facts，failed/cancelled/unchanged 的投影语义稳定；
- 双写故障注入覆盖“Attempt 已写/Thread 未写”和“Thread 已写/Attempt 未写”的幂等收敛；
- RLS、Membership revoke、跨 Tenant Blob/Run/Thread 复合外键测试通过。

## 可逆性与回退

新表和新写入只追加。未写事实时可在开发/测试 down；出现事实后生产 down 必须拒绝。线上优先关闭 `thread_context_v2_read`，保留 write/shadow 以便诊断；必要时再停止新双写，但不删除或改写已存在 facts。

## 后续工作

- 阶段 0：完成 Provider `/chat/completions` 历史形状 Spike，冻结 adapter 能力矩阵；
- 阶段 2：实现 stream/entry/append command、双写、shadow reconstruction 和新 Thread 灰度读取；
- 阶段 4：由 ADR-0065 引入 checkpoint/replacement history，不修改本 ADR 的原始 facts。

## 实施记录

- 2026-07-31：阶段 2 已实现 `0021_thread_context_stream` → `0022_thread_context_history_audits` 迁移、claim/turn/terminal 双写、Stable Blob body、确定性重建及摘要审计、真实 Provider 角色注入和 Web 跨 Run 对话投影。
- 运行时开关映射为 `THREAD_CONTEXT_V2_WRITE_ENABLED`、`THREAD_CONTEXT_V2_SHADOW_READ_ENABLED`、`THREAD_CONTEXT_V2_READ_ENABLED`；三者默认关闭且强制 `read ⇒ shadow ⇒ write ⇒ serial queue`。
- 未实施阶段 3 steer、阶段 4 compaction/checkpoint 或阶段 5 Sandbox 跨 Run lifecycle。
