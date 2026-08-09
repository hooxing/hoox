# ADR-0134：压缩沿用模型输出预算并容忍推理终态

- 状态：已接受（试验分支）
- 日期：2026-08-09
- 决策者：Runtime 团队
- 关联任务/PR：`feat/context-auto-compaction`
- 关联决策：ADR-0068、ADR-0133
- 参考实现：OpenAI Codex `646f7c0a91b8e327d263335da68ae8ef212895ce` 的
  `codex-rs/core/src/compact.rs`、`codex-rs/protocol/src/openai_models.rs`

## 背景

一次 65,536 token 测试窗口中的长任务实际触发了 57 次本地压缩模型调用，但只提交了 6 个 checkpoint。
失败调用中，29 次以 `length` 停止，22 次已经生成有效 `text`，但同一 assistant 终态还包含 Provider
返回的 `thinking`，旧实现因存在非 text content 而整体拒绝。最后一个成功 checkpoint 后，连续 8 次
压缩都未安装 replacement，在线历史从约 21,737 token 增长到约 45,100 token，下一次模型准入最终以
`CONTEXT_TOO_LARGE` 失败。

旧默认值还把压缩输出单独限制为 2,048 token，明显低于同一模型正常请求的 8,192/16,384 token
预算。OpenAI Codex 的本地压缩调用沿用正常模型请求路径，没有再施加 2,048 token 的小上限；它从
assistant 正文构造摘要，且在压缩请求自身超过上下文时会重试，而不是因额外的推理内容丢弃正文。Codex
自动压缩触发阈值默认由上下文窗口的 90% 推导，但本 Runtime 已有 soft/target 双阈值和入站输入投影，
本次不改变其触发策略。

## 决策驱动因素

- 有效摘要不能因为 Provider 附带 `thinking` 而丢失；
- 压缩输出预算应足以覆盖复杂长任务的交接内容；
- `length` 终态中的正文虽然可能截断，仍优于反复保留即将撞窗的完整旧历史；
- 真正达到硬窗口时，压缩失败必须在压缩边界显式失败，不能继续调用主模型后才暴露无关的准入错误；
- 不删除持久 Thread facts，不破坏工具调用与结果的来源关系。

## 备选方案

### 方案 A：维持 2,048 token，并要求终态只能包含 text

实现最简单，但已被真实 trace 证明会系统性拒绝 reasoning Provider 的有效输出，并导致大量重复压缩调用。

### 方案 B：完全接受任意终态和任意 content

可最大化成功率，但工具调用、图片或其他主动内容可能被误当作可信交接，破坏 `tools=[]` 和纯文本
checkpoint 的边界。

### 方案 C：沿用模型输出预算，只忽略 thinking；length 重试一次并保留可用正文

既贴近 Codex 的正常模型预算和 assistant 正文提取方式，又保留 Runtime 对工具调用等非摘要内容的拒绝；
在完整终态与窗口存活之间提供有界回退。

## 选择

选择方案 C：

1. 未显式配置 `THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS` 时，默认等于
   `MODEL_MAX_OUTPUT_TOKENS`；显式值仍必须小于等于模型上限。
2. local compactor 只提取 `text`；同一终态中的 `thinking` 被忽略，任何其他 content 类型仍使该次输出无效。
3. `stop` 且有正文时立即接受。`length` 且有正文时保存候选，并追加“只输出更短最终摘要”的固定提示重试一次。
4. 两次均为 `length` 时使用字符数更长的候选；两次都没有正文或出现不可接受终态时才判定生成失败。
5. 两次调用共享同一个总超时，Pi 内建 retry 继续保持关闭，避免形成无界重试乘积。
6. 若压缩生成失败时投影输入已经达到硬窗口，Coordinator 抛出明确的压缩准入错误；尚未达到硬窗口时仍保留旧历史，允许后续安全点再次尝试。
7. soft/target 百分比、checkpoint CAS、replacement token 目标和原始事实持久化语义不变。

## 理由

本次故障的多数失败并非没有摘要，而是旧终态解析过严或输出预算过小。扩大到模型正常输出预算后，
Provider 有更大机会完成摘要；忽略 `thinking` 可以直接恢复 22 次已有正文的调用；对 `length` 进行一次精简
重试并保留部分正文，可以恢复最后窗口中的多个可用候选。相比删除最旧历史，继续通过持久 checkpoint 替换
活动投影能保持 ADR-0068 的来源、恢复和审计不变量。

## 影响

### 正面影响

- reasoning Provider 的 `thinking + text` 压缩终态可正常提交；
- 压缩不再受固定 2,048 token 默认上限约束；
- 长度耗尽只会触发一次有界精简重试，不再在多个 safe point 重复浪费大量调用；
- 硬窗口前的最终失败直接指向 compactor，而不是伪装成后续主模型准入失败。

### 负面影响与成本

- 单次压缩最坏可能调用模型两次，且输出预算增大；
- 接受 `length` 候选意味着摘要末尾可能不完整，但 replacement 仍必须通过 target token 校验；
- 字符数只用于两个截断候选之间的保守选择，不代表语义质量评分。

### 安全、数据与运维影响

- 工具调用等非 `text`/`thinking` 输出继续拒绝，不扩大 compactor 权限；
- system prompt、工具 schema 和请求级动态数据分层不变；
- `.env.example` 的压缩上限与示例模型输出上限对齐，部署时仍可单独下调；
- checkpoint schema、数据库迁移和原始事实均无变化。

## 验证

- Coordinator 单测覆盖 `thinking + text` 被接受并提交；
- Coordinator 单测覆盖首轮 `length` 后使用精简提示重试并采用完整终态；
- Coordinator 单测覆盖两次 `length` 时采用更长可用正文；
- Coordinator 单测覆盖硬窗口前生成失败显式抛错；
- 进程配置测试覆盖默认压缩输出预算等于模型输出预算；
- 运行 agent-worker 类型检查、相关 Vitest、格式化与 lint。

## 可逆性与回退

代码可回退到固定 2,048 token 和严格 text-only 解析，数据无需迁移；但这会重新引入已验证的长任务失败。
更安全的临时回退是显式下调 `THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS`，同时保留新的终态解析。
若必须禁用压缩，可设置 `THREAD_CONTEXT_COMPACTION_ENABLED=false`，既有 checkpoint 仍可读取。

## 后续工作

- 在长任务黑盒测试中记录每次压缩的 stop reason、候选正文 token 和重试次数；
- 评估是否为 remote compactor 契约增加结构化 stop reason，以统一 local/remote 的长度回退；
- 继续观察多次压缩后的摘要质量，必要时增加新任务建议或窗口次数告警。

## 实施记录

- `runtime-compaction.ts` 已实现有界重试、thinking 忽略、length 候选回退和硬窗口显式失败。
- `process-entry.ts` 已将默认压缩输出预算调整为模型正常输出预算。
