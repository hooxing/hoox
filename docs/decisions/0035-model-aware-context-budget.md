# ADR-0035：模型感知的 Context Budget

- 状态：部分已替代（Worker 未知模型的默认计数由 ADR-20260827110606 改为 new-api 风格估算；可信绑定、预算与恢复门禁继续有效）
- 日期：2026-07-28
- 关联：ADR-0006、ADR-0029、ADR-0030、ADR-0032、ADR-20260827110606、M5

## 背景

不能以 `UTF-8 byte / 4` 当作 token 数。它会系统性低估中文、emoji、二进制样式高熵文本，导致实际 Provider 上下文越界。Pi 的默认 compaction 也不能成为持久化事实的裁剪机制。

## 决策

1. Budget 仅由实际 Pi Model metadata 投影或受信 `ModelBudgetDescriptor` 派生：`modelId`、`contextWindow`、`maxOutputTokens`、`compatibilityHash`。窗口、最大输出必须是正安全整数，最大输出不可大于窗口。
2. tokenizer 必须由可信 Provider/model registry 与同一个 Pi Model 对象绑定，Session 不接受独立窗口、descriptor 或裸 tokenizer。创建 Session 时通过 `ModelRuntime.getProvider/getAuth` 固定 Provider implementation、模型、`baseUrl`、headers、auth 与 env 的已解析请求快照；逐调用重新解析并比较，完成 Pi header transform 后不再跨越异步边界，直接调用已捕获实现。任一路由、实现、认证或 tokenizer 漂移均失败关闭。没有精确 tokenizer 时采用 UTF-8 字节上界估计。
3. 每次实际 Provider 调用前计量最终可见表示：可信 system prompt、全部低信任 custom entries、完整 messages（含工具循环结果）、带 description/parameters 的实际 tool definitions、当前用户输入、模型待输出、恢复 margin、安全 margin 和固定协议开销。超限在调用真实 Provider implementation 前失败关闭。所有比率均限制为 `[0, 1]` 的有限数值，聚合使用 checked safe integer。
4. 历史选择是纯函数：从最新事实向前选取，随后只用 `activeEntries` 构造实际 Pi custom message。事实不删除、不改写。Rollout 恢复器仍严格验证 `tool_call/tool_result` 配对；依据 ADR-0032，工具 body 不恢复进 Pi 投影，因此它们也不计入 Provider 可见预算。通用预算端口仍将显式工具 entry 作为不可拆分原子组，避免未来扩展时拆半。
5. 每个策略生成稳定 SHA-256 `policyHash`，其输入包含模型描述符、tokenizer identity、各预留 token 数和可信 prompt/tool 的摘要。该 hash 纳入 Pi 的 `promptPolicyHash`，因此进入 Rollout 恢复兼容检查。
6. 请求不能提交 `previous`。当前 PostgreSQL Rollout stream 尚未持久化独立的 budget identity，因此它只能通过已记录的 `promptPolicyHash` 报告 `compatibility_mismatch/rebuild_attempt`，不得把缺失身份伪造成兼容；`RecordedContextBudgetIdentity` 仅供已接通该持久事实的恢复端口使用。可信保留项或单个原子组无法放入窗口返回 `context_too_large`。
7. Session 建立时先裁剪恢复投影；`prompt/steer/followUp` 入口只做无状态预检，权威门禁位于逐 Provider 调用边界并直接读取 Pi 最终 Context。Pi 将 lazy stream 内错误投影为普通 Provider error，因此适配器另行保留原始预算拒绝信号；每个信号绑定唯一 prompt transaction generation，只有所有者可以消费和回滚。transaction commit/rollback 完成前拒绝并发或事件回调重入的新 prompt，活跃 steer/followUp 只进入当前 Pi 队列；`abort()` 捕获调用时的 generation，在触发 Pi abort 后等待该 transaction 完整结束，但不等待之后的新事务。Pi settle 后恢复调用前的 Agent messages、清空队列并把 SessionManager leaf 切回 checkpoint，再向 Controller/Worker 返回稳定 `CONTEXT_TOO_LARGE`、`rebuild_context`。被拒分支作为非活动审计事实保留，但不再进入后续上下文或恢复路径。
8. Pi 仍固定 `compaction.enabled=false`，Controller 不暴露 compact。未来摘要只能作为新的、可审计 checkpoint/replacement history 写入，不能绕过本决策。

## 影响

恢复入口在实例化 Pi 前先验证投影预算；模型或策略漂移会更早停止并要求可信重建。独立 budget identity 尚未进入 PostgreSQL stream 前，缩窗会保持 `rebuild_attempt`，不会降级为允许恢复。tokenizer 未接入时吞吐可能较低，这是数据完整性优先的可接受代价。

## 验证

- 中文、emoji、高熵字节、极小窗口、非法数值、超大原子项；
- tool call/result 配对与窗口选择；
- 模型切换、缩窗、策略变化和重启确定性；
- Pi 恢复前预算检查与 compaction 继续禁用。
