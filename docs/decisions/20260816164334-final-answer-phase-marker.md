# ADR：使用阶段标志生成最终答复

- 状态：已被 [ADR 20260816202624](./20260816202624-optional-long-process-collapse-marker.md) 修订
- 日期：2026-08-16

## 背景

Agent 在长任务中会持续输出思考、工具执行和阶段性说明。这些过程数据对实时观察和故障排查有价值，但任务完成后，部分用户只需要一段清晰的最终答复。仅在页面上折叠过程不会节省模型上下文；反过来改写 Active History 又会改变上下文缓存命中和后续模型效果。本次改动只解决展示语义，不改变提供给模型的历史投影。

## 备选方案

1. 让最终答复工具直接接收并返回答案文本。协议简单，但答案被包装成工具调用，流式 Markdown、消息语义和后续兼容性都较差。
2. 将空工具调用本身视为最终答复结束。无法区分工具前的过程文本和工具后的独立答案，也不利于模型生成完整的正常 assistant message。
3. 使用非终止型阶段标志：模型调用 `begin_final_answer()`，工具返回固定回执，模型在下一次采样中输出正常 assistant message。

选择方案 3。

## 决策

- 仅主 Agent 暴露 `begin_final_answer`；子 Agent 不具备该工具。
- 工具参数是严格的空对象，描述和成功回执均为字节稳定的静态内容，不注入 Thread、Run 或附件等请求级数据。
- 工具成功后不终止 Agent 循环。Pi 按常规工具结果继续采样，下一条正常 assistant message 承载最终答复。
- Worker 只在 `turn.completed` 安全点确认阶段转换：
  - 独占且成功的 `begin_final_answer` 工具轮与 `finalization.started` 事件原子持久化；
  - 后续无工具、非空且以 `stop` 结束的 assistant 轮与 `final_answer.committed` 事件原子持久化；
  - 最终答复因 `length` 分段时继续保留最终阶段，直到完整停止；
  - 标志后再次调用其他工具或产生空终态时取消本次最终阶段。
- assistant 的 Thread Context body 可携带 `phase: "commentary" | "final_answer"` 展示元数据。Active History 投影明确忽略该字段，因此后续模型输入、上下文压缩策略和缓存前缀不变。
- 前端收到已提交阶段后默认折叠标志之前的过程并展示标志之后的最终答复。阶段已开始但任务仍在运行时显示“正在整理最终答复”。任务失败、取消、恢复中断或阶段取消且没有提交时，恢复展示完整过程，避免隐藏故障证据。
- 历史轮次从 Thread Context 的 `phase` 识别最终答复；过程详情按需读取该 Run 的事件，展开前不额外加载。

## 影响

- 模型多一次固定工具调用及后续采样边界，最终答复仍是标准 assistant message。工具是可选的，不调用时行为保持不变。
- UI 折叠与上下文节省解耦；本次不会因删除历史内容而降低缓存命中或模型效果。
- `run_events` 新增 `finalization.started`、`finalization.cancelled` 和 `final_answer.committed` 三种公开事件。旧客户端会把未知事件忽略或按通用事件处理，不影响已有消息和工具事件。
- 删除工具、阶段事件和 body 展示字段即可回退；已有 Thread Context 中的附加字段会被旧投影忽略。

## 验证

- 工具单元测试覆盖空参数契约、固定回执和 durable observation。
- Session 测试覆盖主 Agent 可见、子 Agent 不可见以及工具后继续生成 assistant message。
- Worker 测试覆盖开始、提交、输出截断续写和取消语义。
- Thread Context 测试证明展示接口返回 phase，同时 Active History 投影不发生变化。
- Web 测试覆盖当前 Run 折叠、等待占位、异常展开及历史过程按需加载。
