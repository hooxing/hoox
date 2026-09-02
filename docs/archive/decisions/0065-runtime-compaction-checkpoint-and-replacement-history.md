# ADR-0065：Runtime Compaction 检查点与 Replacement History

- 状态：已替代（候选语义由 ADR-0068 接受并实施）
- 日期：2026-07-31
- 决策者：待指定
- 关联任务/PR：阶段 0 语义冻结；ADR-0006、ADR-0030、ADR-0035、ADR-0064
- 替代关系：阶段 4 接管活动历史压缩；不修改现有 Attempt rollout 事实

## 背景

当前 Pi compaction 固定关闭，Context Policy 在实际 Provider 调用前执行预算门禁。现有 `runtime_rollout_replacements` 是 Attempt 范围、单调前缀式的恢复结构，其 replacement item 只描述 `from/through`，不是整个 Thread 的可安装模型历史。它不能直接充当跨 Run Runtime Compaction 的实施规范。

[Thread 连续上下文实施总计划](../plans/thread-continuous-context.md) 已确定：Runtime 是 compaction 事实源；原始 Thread facts 不删除；每个 checkpoint 保存不可变的完整 `replacement_history`；后一个 checkpoint 可以完全重组前一个窗口；Canonical Context 必须按当前可信配置重建。本 ADR 冻结该恢复协议，不固化阈值、预算或本地/远程路径选择。

## 决策驱动因素

- 超窗前必须可控压缩，并能在 Worker 重启后确定性恢复；
- 压缩失败不能破坏当前可用历史；
- 最近用户原文、未完成工作、工具 provenance 和 Workspace 事实不能被静默丢弃；
- 模型/Provider 能力变化需要明确兼容判定；
- 压缩调用不得产生 Workspace 或其他业务副作用。

## 备选方案

### 方案 A：重新启用 Pi 内建 compaction

实现快，但调用时机、历史改写和持久恢复由进程内 Session 决定，不能满足 Runtime 审计与重启一致性。

### 方案 B：只保存一段可变摘要文本

存储较小，但覆盖旧摘要后无法验证窗口链，也无法证明恢复历史与在线历史一致。

### 方案 C：Runtime 编排、不可变完整 replacement checkpoint（选择）

Runtime 从 Thread facts 构建输入，调用受控本地或 Provider 能力，验证完整 replacement history 后原子提交新窗口，并把同一规范化结果安装到 Session。

## 选择

1. Pi compaction 在阶段 4 Gate 通过前继续 `enabled=false`；之后 Pi 仍不拥有持久历史，也不得自行触发未受 Runtime 控制的压缩。
2. 每个 checkpoint 记录 `through_sequence`、`window_number`、`previous_window_id`、`window_id`、`compatibility_identity`、`policy_identity`、token usage、完整 replacement history digest 和创建时间。
3. replacement items 规范化到独立表，按 checkpoint 内 ordinal 排序。每个 checkpoint 的完整 replacement history 一经提交不可更新；Thread Context 原始 entries 永不因压缩删除、更新或重排。
4. 后一个 checkpoint 是新的完整活动历史，可以重新组织前一个 replacement history 与新增 tail，不要求保留旧 replacement 前缀。只要求窗口号、through sequence 和 previous-window 链单调、无分叉且可校验。
5. 恢复只安装最新兼容 checkpoint 的完整 replacement history，再重放 `through_sequence` 之后的 Thread facts。当前 Canonical Context 单独重建，不从摘要继承 system/developer 信任。
6. 压缩只在完整消息/工具组边界执行：Provider stream 已结束、tool call/result 已配对、没有 Workspace commit、下一次 Provider 请求尚未发出。压缩调用禁用全部业务工具。
7. 压缩结果必须显式保留最近真实用户原文的受控集合、任务状态、关键决策/约束、未完成工作、必要文件/符号/错误、Workspace revision 身份以及不确定/失败结论。最近原文预算与摘要输出预算分别配置。
8. 压缩事务先以 Thread writer fencing 复核 source through-sequence 和当前 window，再提交 checkpoint；CAS 失败时丢弃未提交结果并从新 head 重算，不能覆盖并发 tail。
9. 只有 checkpoint 数据库提交成功后，内存 Session 才切换到同一份规范化 history。若提交后进程崩溃，新 Session 从 checkpoint 恢复；若调用、校验或提交失败，旧 history 保持不变。
10. 本地 handoff summary 与 Provider remote compaction 是同一 Runtime 端口的能力分支。选择规则由配置、兼容身份和真实指标决定，本 ADR 不指定默认路径。

首版逻辑 Schema 版本为：

- `thread_context_checkpoint.schema_version = 1`；
- `thread_context_replacement_item.schema_version = 1`；
- `replacement_history_projection.schema_version = 1`。

Provider wire role 不是上述事实 schema。`compaction_handoff` 在事实层必须保持独立 kind，不能伪装成真实 `user_message`；它映射到 `/chat/completions` 的具体 role/item 形状必须由阶段 0 Provider Spike 和 adapter capability matrix 决定。

## 压缩提交协议

```text
读取最新兼容 checkpoint + tail
→ 构建当前 Canonical Context 与最终 Provider 可见表示
→ 计算精确/保守 token 预算
→ 在安全边界选择压缩范围
→ 无工具调用本地或远程 compaction
→ 验证 replacement、最近原文、工具组、digest 与兼容身份
→ writer fencing + source window CAS
→ 原子写 checkpoint、replacement items 和 checkpoint fact
→ 提交后安装同一 history
```

## 影响

### 正面影响

- 多次压缩和 Worker 重启后可确定性恢复；
- 原始事实与活动窗口分离，压缩失败可无损回退；
- 本地/远程实现可在同一持久协议下灰度比较。

### 负面影响与成本

- 完整 replacement history 会产生额外存储，需要 item 化、Blob 化和容量指标；
- 摘要质量存在累积损失，需要长期测试和产品提示；
- 兼容身份变化可能要求提前压缩或显式拒绝。

### 安全、数据与运维影响

- 压缩输入仍包含不可信历史，prompt 必须防止其提升权限；
- trace 不得记录秘密、完整大工具输出或 Provider credential；
- 软阈值、输出预留、最近原文预算、最大重试次数、裁剪策略、本地/远程选择和模型均为配置或待决项，不写成永久常量。

## Feature Flag 与兼容

- `thread_context_compaction` 只控制创建新 checkpoint，不控制读取已有 checkpoint；关闭后，已经压缩过的 Thread 仍必须能恢复其最后有效 checkpoint。
- 该开关依赖 `thread_context_v2_read`、Thread writer fencing 和 Provider compatibility Spike 通过。
- 未启用 compaction 的超窗 Thread 必须返回明确 `context_too_large` 或执行已批准的旧策略，禁止静默截断最近用户需求。
- 关闭 V2 read 可以临时退回旧每 Run Session，但不会删除 checkpoints/facts；重新开启后从原窗口链继续。

## 验证

- checkpoint/window/previous 链单调、无分叉、through 边界和 replacement digest 负例；
- tool call/result 不可拆分，partial Assistant 和未完成工具不得进入 checkpoint；
- compaction 超时、Provider 拒绝、无效结构、CAS 冲突和数据库提交失败均保持旧 history；
- 至少三次连续压缩后，在线 history digest 与重启恢复 digest 相同；
- Provider wire trace 验证当前 Canonical Context、最近用户原文、handoff item 和 tail 顺序；
- 模型/工具 schema/投影版本变化覆盖兼容、显式降级与拒绝；
- 原始 Thread facts 数量、digest 和 Blob provenance 在压缩前后不变。

## 可逆性与回退

新 checkpoint 只追加。线上回退先关闭新压缩，继续读取最后有效 checkpoint；必要时关闭 V2 read，但不删除窗口链。只有从未写入 checkpoint 的开发/测试库允许 down；生产数据出现后通过新版本向前迁移。

## 后续工作

- 阶段 0：完成 `/chat/completions` replacement history 形状、tool item 和模型兼容性 Spike；
- 阶段 4：实现 Context Builder、token 计量、compactor port、checkpoint Repository 和故障注入；
- 阶段 6：依据真实 token、质量、延迟与成本指标调整配置，不回写为架构常量。

## 实施记录

- 阶段 4 的具体实施选择由 [ADR-0068](../../decisions/0068-runtime-owned-persistent-compaction.md) 接受；
  本 ADR 保留为阶段 0 语义输入，不作为完整实施规范。Pi compaction 继续保持关闭。
