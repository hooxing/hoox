# ADR-0035：模型感知的 Context Budget

- 状态：已接受
- 日期：2026-07-28
- 关联：ADR-0006、ADR-0029、ADR-0030、ADR-0032、M5

## 背景

不能以 `UTF-8 byte / 4` 当作 token 数。它会系统性低估中文、emoji、二进制样式高熵文本，导致实际 Provider 上下文越界。Pi 的默认 compaction 也不能成为持久化事实的裁剪机制。

## 决策

1. Budget 仅由实际 Pi Model metadata 投影或受信 `ModelBudgetDescriptor` 派生：`modelId`、`contextWindow`、`maxOutputTokens`、`compatibilityHash`。窗口、最大输出必须是正安全整数，最大输出不可大于窗口。
2. 使用可注入的模型 tokenizer；没有精确 tokenizer 时采用 UTF-8 字节上界估计。该估计会保守拒绝部分可执行请求，但不会对多字节文本低估。
3. 每次决策显式保留可信 system prompt、实际将注册的 tool schema、模型待输出、恢复 margin 和安全 margin。所有比率均限制为 `[0, 1]` 的有限数值。
4. 历史选择是纯函数：从最新事实向前选取，`tool_call/tool_result` 作为不可拆分原子组；事实不删除、不改写、不静默截断。未配对工具事实是协议错误，由恢复协调流程处理。
5. 每个策略生成稳定 SHA-256 `policyHash`，其输入包含模型描述符、tokenizer identity、各预留 token 数和可信 prompt/tool 的摘要。该 hash 纳入 Pi 的 `promptPolicyHash`，因此进入 Rollout 恢复兼容检查。
6. 模型切换、兼容 hash 变化、模型缩窗或策略 hash 变化返回结构化 `rebuild_required`；可信保留项或单个原子组无法放入窗口返回 `context_too_large`。两者都不能创建 Pi Session 或调用 `session.compact()`。
7. Pi 仍固定 `compaction.enabled=false`，Controller 不暴露 compact。未来摘要只能作为新的、可审计 checkpoint/replacement history 写入，不能绕过本决策。

## 影响

恢复入口在实例化 Pi 前先验证投影预算；模型或策略漂移会更早停止并要求可信重建。tokenizer 未接入时吞吐可能较低，这是数据完整性优先的可接受代价。

## 验证

- 中文、emoji、高熵字节、极小窗口、非法数值、超大原子项；
- tool call/result 配对与窗口选择；
- 模型切换、缩窗、策略变化和重启确定性；
- Pi 恢复前预算检查与 compaction 继续禁用。
