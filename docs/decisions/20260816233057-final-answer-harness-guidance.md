# ADR：平台 Harness 显式允许长过程折叠工具

- 状态：已接受
- 日期：2026-08-16

## 背景

`collapse_process_for_final_answer` 是可选的展示阶段工具：当一轮任务已经产生较长的过程消息时，
模型可以先发出阶段标志，让前端折叠此前过程，再输出一次独立的总结性最终回复。

原平台 Harness 同时规定“不得为展示过程调用工具”。Harness 的优先级高于工具描述，因此即使
Capability Manifest 已提供折叠工具，模型仍倾向于遵循更高优先级规则直接回答，导致长任务不能
稳定进入最终回复阶段。

## 备选

1. 只继续强化工具描述。不能解除更高优先级 Harness 的冲突。
2. 删除所有关于非必要工具调用的限制。会诱发直接问答和短任务产生多余工具调用。
3. 保留业务工具的必要性约束，并在 Harness 中只为
   `collapse_process_for_final_answer` 增加长过程例外。

## 决策

选择方案 3。Harness 继续要求：能直接回答时直接回答，业务工具只在完成请求确有必要时调用，
不得为了确认已知事实或收集非必要信息调用工具。同时明确：当最终回复前已累积较长中间过程，且
Capability Manifest 确实提供 `collapse_process_for_final_answer` 时，可以调用该工具折叠过程；
工具成功后再输出一次独立的总结性回复，方便用户直接查看结果。

该规则不要求直接回答、简短任务或几乎没有过程内容的任务调用折叠工具。工具是否可用仍以稳定的
Capability Manifest 为准，Harness 不新增能力或授权。

由于固定 System Prompt 字节发生变化，Runtime Prompt 版本从 v12 升为 v13，避免新旧 Prompt
共享错误的版本身份和缓存诊断。

## 影响

- 长任务不再因高优先级 Harness 禁令而放弃折叠工具。
- 直接回答和短任务仍保持单次普通 Assistant 回复。
- 固定 Harness 对相同能力配置仍保持字节稳定，不注入 Run 或请求级动态事实。
- Prompt v13 会建立新的前缀缓存；同版本后续请求可以继续复用。

## 验证

- Prompt Builder Golden 测试固定新的 Harness 文本、实际工具名与 v13 版本。
- Pi Session 诊断测试确认运行时报告 v13。
- 执行相关包测试、typecheck、格式检查和 lint。

## 可逆性

可恢复 v12 的第 7 条 Harness 及版本常量；已经保存的 Run 仍保留当时使用的 Prompt 版本与摘要，
无需迁移持久化数据。
