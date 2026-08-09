# ADR-0133：自动压缩采用整窗摘要与入站输入投影

- 状态：已接受（试验分支）
- 日期：2026-08-09
- 决策者：Runtime 团队
- 关联任务/PR：`feat/context-auto-compaction`
- 关联决策：ADR-0065、ADR-0068、ADR-0100
- 参考实现：OpenAI Codex `646f7c0a91b8e327d263335da68ae8ef212895ce` 的
  `codex-rs/core/src/compact.rs`

## 背景

ADR-0068 的首版 replacement 采用“一个 handoff 加最近真实 user 边界后的完整尾部”。该方案在多轮
用户对话中可以保留精确尾部，但在最常见的单用户长任务中没有可压缩前缀：历史通常是“一条 user +
多轮 assistant/tool”，最近 user 位于第一项，旧策略因此持续返回 `no_safe_prefix`。即使已有 checkpoint，
后续没有新 user 时也只能再次摘要旧 handoff，无法释放其后的 assistant/tool 体积。

另一个缺口是压缩只计算已经持久化的 active history。即将发送的首轮 user 输入以及 turn safe point
已经持久消费、马上进入 Pi steer 队列的 user 输入都没有进入 soft-limit 投影。旧历史可能单独低于 80%，
但追加输入后立即超过 admission 窗口，Runtime 会在没有尝试压缩的情况下返回 `CONTEXT_TOO_LARGE`。

Codex 的本地压缩会收集近期真实用户消息，把它们放在压缩摘要之前，并用摘要收束整个旧窗口。该形状既能
处理单用户长任务，也让模型看到“原始目标/约束 → 已完成工作摘要”的时间顺序。

## 备选

### 备选 A：维持 user 边界尾部策略，仅降低 soft limit

优点是没有 replacement 形状变化。缺点是单用户历史无论多早触发都没有可压缩前缀，降低阈值不能解决根因；
入站大输入仍可能绕过触发。

### 备选 B：只在 Provider 返回 context-window 错误后删除最旧 item 并重试

优点是实现局部。缺点是会破坏工具调用/结果 provenance、绕过持久 checkpoint，并把 Provider 错误变成正常
控制流；删除原始事实也违反 ADR-0068。

### 备选 C：整窗摘要并保留近期真实 user，触发时计入即将追加的 user 输入

优点是覆盖单用户长任务，保持原始事实不删除，且在 Provider admission 前主动释放空间。成本是 replacement
中 handoff 不再恒为第一项，持久提交校验和测试必须接受“近期 user 在前、handoff 在后”的合法形状。

## 决策

选择备选 C，并保留一个兼容分支：

1. active history 以 assistant/runtime 完整结果结束时，压缩源覆盖整个当前窗口；按
   `recentUserTokens` 从尾部选择近期真实 user，整条逐字保留且不截断，replacement 为
   `retained users + compactionHandoff`。
2. 历史恰好停在尚未执行的 user 边界时，继续使用 ADR-0068 的
   `compactionHandoff + untouched suffix`，避免把待处理 user 写到摘要之前而改变执行语义。
3. 既有 `compactionHandoff` 不当作真实 user 保留；新的整窗摘要继承最早
   `sourceFromSequence`，形成连续 source range。
4. 首轮 `initialInputText` 和 safe-point steer 文本按与 Pi admission 相同的 Provider user message
   JSON 形状计 token。`history + incoming` 达到 soft limit 即触发压缩。
5. replacement 的历史目标先扣除 incoming token：优先使“replacement + incoming”降到 target；
   单条输入已经超过 target 时，至少为 soft limit 或最终 admission 留出空间。单条输入本身超过可用窗口时仍
   失败关闭，不伪造可继续状态。
6. checkpoint 继续记录被替换历史自身的 `tokens_before/tokens_after`；入站 token 只参与触发和目标余量，
   不写成已经进入 replacement 的事实。
7. PostgreSQL 提交校验要求 replacement 中恰有一个与 checkpoint/source range 匹配的 handoff，
   不再要求 handoff 位于 ordinal 0。既有 handoff-first checkpoint 保持可恢复。

## 影响

### 正面影响

- 单用户、长工具循环和连续 assistant/tool 任务可以真正自动压缩；
- 大 follow-up/steer 在进入 Provider 前触发压缩，减少可预见的窗口拒绝；
- 近期真实用户目标保持逐字可见，摘要负责表达已完成工作、决定、失败和未决项；
- 原始 Thread Context facts、Blob identity、checkpoint CAS 和恢复链不变。

### 成本与限制

- 整窗摘要比只摘要旧前缀覆盖更多输入，compactor 调用成本可能略高；
- replacement 可出现连续 user-role message，Provider 兼容层必须继续接受该既有 Codex 风格形状；
- 图片 token 仍由模型/Provider 能力单独处理，本次只投影文本输入；
- 摘要失败、目标未达到或提交冲突时仍保留旧历史，最终可能返回 `CONTEXT_TOO_LARGE`。

## 验证

- 纯策略测试覆盖单用户长历史整窗压缩、近期 user 在摘要前、user 边界兼容尾部和入站 token 投影；
- Coordinator 测试覆盖旧历史单独低于阈值、加入首轮输入后提前压缩；
- Worker 测试证明 claim 的实际首轮文本传入 Session factory；
- 既有连续三次 checkpoint、恢复 digest、local `tools=[]`、提交失败保持旧 history 测试继续通过；
- persistence 校验与 PostgreSQL 集成门禁继续验证 replacement item 顺序、digest 和 checkpoint 链。

## 可逆性

应用层代码可回退到 ADR-0068 的 handoff-first 策略；新 checkpoint 的 schema 未变化，旧代码若仍硬编码
ordinal 0 为 handoff 将无法提交或正确解释新 replacement，因此回退前必须先部署兼容读取补丁，或关闭
`THREAD_CONTEXT_COMPACTION_ENABLED` 只读既有 checkpoint。原始 facts 从未删除，无需数据恢复。
