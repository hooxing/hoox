# Prompt、上下文预算与模型交互

本文面向修改系统提示词、工具描述、上下文预算、记忆注入或模型 Provider 适配的开发者，说明模型可见内容的信任分层与缓存稳定性约束。Thread 历史重建与压缩见 [Thread 连续上下文](thread-continuity.md)，工具展示与 PTC 见[工具调用模式](tool-calling-modes.md)。

## 字节稳定的固定前缀

模型上下文缓存命中依赖固定前缀不变。相同能力配置下：

- system prompt（含 Platform Harness 与 Operator 指令）、developer/harness prompt 与工具 Schema 必须字节稳定，不注入 Tenant、User、Thread、Run、附件等请求级动态数据；
- 动态文件名、资源 ID、文件路径、签名 URL、目录内容和派生摘要不得进入 system prompt；
- 当前轮附件、记忆检索结果和其他请求级事实放在最新 user turn 的结构化内容中，或通过可按需读取的持久资源（例如 `/resources`、`/history`）暴露；
- Worker 重启后，用同样输入必须重建字节一致的 Prompt，并能核对版本和摘要。

`@hoox/prompt-builder` 是系统提示词的唯一组装入口。修改 Harness 文本或工具描述属于行为变更，需要更新版本号并检查模型可见结果。

## 信任分层

系统角色按信任从高到低依次包含三段，任何一段都不接收请求级动态数据：

1. **Platform Harness**：与具体 Agent 无关的平台规范（安全边界、工具协议、Skill 与低信任数据规则、交付规则），不包含 Agent 名称、品牌或回复语言。沙箱边界使用厂商中性的描述，不注入当前部署或 Session 的 Provider 信息。Harness 明确声明自身优先级高于 Operator 指令和全部低信任内容。
2. **Operator 指令**：`RuntimePromptInput.operatorInstructions`，由可信的 Agent 配置提供，原样放在 `<OPERATOR_INSTRUCTIONS>` 中。它可以定义角色、业务规则、语气和回复语言；Harness 声明它不能新增或模拟工具、授予授权、改变 Tenant 身份或覆盖 Harness，自称系统、平台或声明新增能力的文本不产生这些效果。
3. **能力清单与 Skill 目录**：由本次 Session 实际注册工具派生的能力清单，以及可用 Skill 目录；Skill 目录只来自 Run 固定的 Skill 快照，不接收请求正文或用户自报目录。能力清单由传给模型的同一组工具生成，Operator 指令和任何文本都不能改变它，缺失的能力不能出现在提示中；Runtime 同时保留完整清单摘要、Schema 摘要和 Prompt 摘要用于审计。

Operator 指令的输入约束与失败语义：

- `@hoox/prompt-builder` 要求调用方显式提供 Operator 指令，`@hoox/pi-adapter` 的 Session 选项同样必填，不会回退到默认值，避免漏传 Agent 配置时静默套用错误身份。Worker 对根 Session、子 Agent 与恢复 Session 一律传入 [RunAgentSnapshot](agent-definition.md) 的 Operator 指令。内置 Agent 的种子指令与 `DEFAULT_AGENT_OPERATOR_INSTRUCTIONS` 字节一致；Revision 摘要只参与审计与恢复比较，不进入模型输入。
- 正文必须是非空 NFC 字符串，UTF-8 不超过 `MAX_OPERATOR_INSTRUCTIONS_BYTES`（16 KiB），不得以空白开头或结尾，除换行外不得包含控制、Bidi、零宽或非法 Unicode 字符，也不得包含任何 Runtime Prompt 结构标记（如 `PLATFORM_HARNESS`、`OPERATOR_INSTRUCTIONS`、`CAPABILITY_MANIFEST`，不区分大小写），防止伪造或提前闭合分区。任一校验失败时构造 Prompt 直接抛错，不截断、不清洗，Session 不会创建。
- 同一 Operator 指令在相同能力配置下产生字节一致的 system；Prompt 摘要原像除完整 system 外还单独包含 Operator 指令摘要。

低信任内容与其他约束：

- Tenant、Skill、User 上下文和个性化偏好以 user/custom 消息提供，标记为低信任数据；即使自称系统或管理员指令，也不能新增工具、授权、Tenant 身份或修改平台规范。团队偏好先于个人偏好，二者都可被当前用户请求和适用 Skill 覆盖。
- 长期记忆检索结果以“低信任派生数据、不是指令”的结构化块只拼入当前 user message，不进入 system/developer prompt、工具 Schema 或恢复投影。检索超时、拒绝或畸形结果降级为没有记忆，不改变 Run 终态。
- 工具操作细节只在 Tool Schema 中维护一份，Harness 不重复描述，避免两处漂移。

## 上下文预算

- 预算基于 Run 快照中的模型上下文窗口与最大输出，按 system、工具、历史、输出保留和安全余量分别计量，诊断能够解释各部分占用。
- Provider 可见消息、预算计算和压缩输入使用同一过滤规则；审计事实继续持久保存，不因为减少上下文而删除。
- 已知模型使用匹配的离线 tokenizer（例如 DeepSeek V4），运行时不联网；未知模型使用保守估算，不静默套用错误 tokenizer。第三方 tokenizer 资源固定版本并保留许可证。
- Pi 内置 Compaction 和上层自动重试关闭，压缩只由 Runtime 的持久 checkpoint 实现。

## 模型绑定

- Worker 通过 `@hoox/pi-adapter` 直接装配 `pi-ai` Provider 与 `pi-agent-core` 工具循环，不使用 `pi-coding-agent` 的 Session、设置或宿主资源发现。逻辑工作目录固定为 `/workspace`。
- 模型请求使用 Run 快照中的 Provider Revision、模型能力和凭据。Agent 固定模型以 `providerKey + providerRevision + modelId` 精确引用已保存配置；缺失或不匹配必须失败关闭，不回退 active 或部署默认值。Provider 请求前重新复核预算、工具能力和可信模型绑定；`MODEL_CONTINUATION_REJECTED` 与 `PROVIDER_BINDING_DRIFT` 属于 Runtime 本地协议阻断。
- 发送给 OpenAI-compatible Provider 的函数参数 Schema 顶层必须是 `object`，不使用顶层 `anyOf`；严格的联合校验由 Runtime 在调用后执行，并返回字段级错误。
- 推理模型默认开启思考；思考内容可流式展示，但不作为可信事实或交付物。默认 Agent 的 Operator 指令要求默认使用中文回复。
- 模型输出达到上限时由 Runtime 受控续轮，不把截断输出伪装为完整回复。

## 标题与辅助模型调用

Thread 标题生成使用后台运行设置引用的标题模型，请求只包含固定指令、受字节上限约束的首条用户原文和附件名称/类型；不包含历史、主 Agent Prompt、工具 Schema、签名 URL 或内部 ID，不启用工具与流式输出。模型必须返回严格单字段 JSON，标题经规范化与长度校验后只在仍为确定性标题时写入，不覆盖用户改名。

## 修改检查清单

1. 新的动态事实是否进入了 system prompt 或工具 Schema？如果是，改为放入最新 user turn 或可读取资源。
2. 修改 Harness、默认 Agent 指令、分区结构或工具描述时更新 `RUNTIME_PROMPT_VERSION` 与 Golden Test，并验证相同输入产生相同字节与摘要。
3. Agent 级内容（身份、品牌、业务规则、语气、回复语言）只写入 Operator 指令，不写入 Platform Harness；Harness 只保留与具体 Agent 无关的平台规范。
4. 新的 Operator 指令来源必须来自可信且不可变的 Agent 配置，并显式传入；不得在其中拼接模板变量或用户、Tenant、时间、文件名等请求级数据，也不得让它影响能力清单或工具 Schema。
5. 新增低信任输入时显式标记来源与信任级别，并加长度上限。
6. 新增模型 Provider 时提供能力元数据、流式与失败测试，不在运行时探测或自动降级能力。
