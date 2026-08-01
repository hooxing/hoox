# ADR-0072：模型思考流的连续性持久化与折叠展示

- 状态：已接受
- 日期：2026-08-01
- 关联：ADR-0055、ADR-0060、ADR-0064、ADR-0071
- 替代：ADR-0064 阶段 2 中“遇到 reasoning 内容显式拒绝整个 turn”的临时边界
- 范围：Pi 事件适配、Run 公开事件、Thread Active History、OpenAI-compatible 推理字段和 Web 对话展示

## 背景

OpenAI-compatible Provider 即使在模型元数据声明 `reasoning=false`、Pi `thinkingLevel=off` 时，也可能在
Chat Completions SSE 中返回 `reasoning_content`。Pi 会把该字段解析为 `thinking` 内容块，并在流式阶段
发布 `thinking_start`、`thinking_delta`、`thinking_end`。

现有 Runtime 只映射 `text_delta`，因此页面无法看到思考过程；更严重的是，Thread turn 安全点只接受
`text` 和 `toolCall`，遇到完整 `thinking` 块会抛出
`THREAD_CONTEXT_UNSUPPORTED_ASSISTANT_ITEM`。Pi 随后把 turn hook 异常包装为 assistant error，旧映射又把
所有 assistant error 归为 `PROVIDER`。结果是第一次工具执行成功后第二次模型请求没有发出，Run 失败且
错误分类失真。

## 备选

1. 在安全点静默删除 `thinking`。可以快速避免失败，但跨 Run 重放会丢失推理签名和模型上下文，部分
   Provider 可能拒绝后续请求，也不符合 Thread 连续性的目标，因此不采用。
2. 只把思考作为 Run UI 事件展示，不写 Thread Active History。展示目标可以满足，但同一 Pi Session
   与跨 Run 重建的上下文不同，恢复后效果和协议兼容性不可预测，因此不采用。
3. 把思考正文及 Provider 签名作为 assistant 内容的一部分写入 Thread 事实流，同时发布受限的 Run
   思考生命周期事件；页面思考中展开、结束后折叠。选择此方案。

## 选择

1. Runtime 公开新增 `thinking.started`、`thinking.delta`、`thinking.completed` 三种 `agent_event`。只有
   `thinking.delta.delta` 进入用户页面；Pi Adapter 以 100ms 或累计 1024 字节为上限合并 Provider 的细碎
   delta，并在任何思考/消息终态前同步排空，兼顾实时展示与持久化写放大。事件仍受既有
   Tenant/Thread/Run 授权、分页和事件大小约束。
2. Web 按事件顺序聚合多个思考块。当前块未结束时状态卡显示“正在思考”并默认展开；收到
   `thinking.completed` 后立即自动折叠，用户仍可手工展开查看。若 Provider 缺少 `thinking_end`，
   `message.completed` 作为兼容终态。
3. `turn.completed.assistant.content` 和 `ThreadHistoryMessageV1` 支持 `thinking`，保留正文、
   `thinkingSignature` 与 `redacted`；`toolCall` 同时保留可选 `thoughtSignature`。签名只用于模型协议重放，
   不进入页面事件或可见文案。
4. `assistant_message` body 保留旧 `text` 字段，并新增有序的非工具 `content` 数组。旧数据没有 `content`
   时继续由 `text` 重建；新数据可恢复思考块。工具调用仍作为独立事实，维持 tool call/result 配对和
   Thread 单写者事务边界，不新增数据库迁移。
5. Provider 原始错误继续映射为 `PROVIDER`；已知 Runtime turn hook/Thread Context 错误映射为
   `PROTOCOL`，避免内部适配故障伪装成上游模型故障。
6. `turn.completed` 安全点提交 Thread Context 前，Worker 必须等待此前已发布的公开事件全部完成持久化。
   Context 不得越过 `thinking.completed` 或 `message.completed`；任一事件落库失败都会先关闭写入口，安全点
   随后拒绝提交，避免出现“最终上下文已写入但 Run 事件流无法收敛”的分裂状态。

## 影响与安全

- 正面：带 `reasoning_content` 的工具循环可以继续发起下一次模型请求；同一 Thread 重建时保留真实
  assistant 上下文；用户可以实时观察 Agent 当前的推理进展。
- 成本：Run Event 和 Thread Context 的写入量增加；思考内容可能明显长于最终回复，后续需依据实际数据
  调整事件保留期、压缩阈值和页面最大展开高度。
- 安全：思考正文按不可信模型文本处理，沿用安全 Markdown 渲染，禁用原始 HTML 和模型图片外链。
  Provider 的 opaque/redacted 签名不会展示；跨租户读取仍由既有 RLS 和 API 授权阻断。
- 兼容：旧 assistant body 和旧 replacement history 继续可读；新增字段为加法扩展，不回填旧事实，也不
  伪造历史思考。

## 验证

- OpenAI-compatible SSE 契约测试覆盖 `reasoning_content + tool_calls` 的解析结果和事件顺序。
- Pi Adapter 测试覆盖思考流发布、完整 turn 安全点、工具结果配对和第二次 Provider 请求。
- Worker 测试验证思考正文及签名写入 `assistant_message` body。
- Worker 测试验证 turn 安全点严格晚于思考和消息公开终态事件。
- PostgreSQL 集成测试验证重启后 Active History 的 digest 稳定且包含思考正文和签名。
- Web 投影与组件测试验证流式聚合、兼容终态、思考中展开及结束后折叠。
- 合并前执行 `pnpm check`；真实 PostgreSQL 套件未实际运行不能计为集成验证通过。

## 可逆性

Web 折叠组件和 Run 思考事件可独立停止发布，但已经写入的事件仍按既有保留策略存在。Thread History
读取端可以回退为忽略 `content` 并使用旧 `text`，但回退后不得把依赖推理签名的 Provider 标记为连续性
兼容。已写入的思考事实无需删除；若未来调整保留策略，应通过新的 ADR 和显式数据生命周期任务执行。
