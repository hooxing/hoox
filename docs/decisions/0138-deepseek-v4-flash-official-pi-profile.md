# ADR-0138：DeepSeek V4 Flash 0731 官方 Pi 模型配置

- 状态：部分已替代（固定请求协议继续有效，能力固定值与阻断性装配校验已被 ADR-20260826000935 替代）
- 日期：2026-08-10
- 决策者：Runtime 团队
- 关联任务/PR：`feat/resilient-user-final-response`
- 关联决策：ADR-0078、ADR-0100、ADR-0134、ADR-0135
- 替代关系：上下文窗口、最大输出、图片能力的固定值及阻断性装配校验已被 [ADR-20260826000935](20260826000935-published-model-capabilities-are-runtime-facts.md) 替代；模型 ID 与请求协议决策继续有效

## 背景

Worker 通过自定义 OpenAI-compatible Provider 注册模型。Pi 无法仅根据第三方网关地址识别真实上游模型，因此旧配置把 `deepseek-v4-flash-0731` 当作普通非 reasoning 模型：模型 ID 使用网关别名，输出预算为 16K，且 Pi 会按通用 OpenAI 端点自动推断 developer role、`max_completion_tokens`、store、thinking 和工具调用重放规则。

DeepSeek 官方 API 文档将当前 `deepseek-v4-flash` 标记为 DeepSeek-V4-Flash-0731，公开 1M 上下文；官方 Oh My Pi 集成进一步给出了该模型的 Pi 配置：64K `maxTokens`、文本输入、reasoning、默认 high thinking、`max_tokens`、禁用 developer role/tool choice，并要求工具调用重放携带 assistant content 与 reasoning content。

部署仍可使用兼容网关提供传输和凭据，但网关主机名不能成为模型能力推断依据。模型协议必须按官方模型 ID 固定。

## 决策驱动因素

- 模型 ID、上下文、输出、输入模态和 reasoning 行为应与官方 Pi 集成一致；
- 第三方兼容网关不能让 Pi 自动误判为普通 OpenAI 模型；
- 官方配置需要集中维护、自动测试和启动时校验，不能散落在 `.env` 与调用代码中；
- 当前 Pi 版本尚未公开官方配置中的全部兼容字段，需要在最终 payload 边界补齐等价行为；
- 真实 API Key、网关地址和本地 `.env` 不得提交。

## 备选方案

### 方案 A：只修改 `.env` 数字和模型名称

可以修正 readiness，但 Pi 仍会按网关 URL 错误推断 role、token 字段与 reasoning 协议，拒绝。

### 方案 B：切换到 DeepSeek 官方 Base URL

协议识别更容易，但会强制改变部署传输和凭据，现有兼容网关密钥不能用于官方端点；模型能力配置与传输部署不应耦合，拒绝。

### 方案 C：官方模型 profile + 部署可选传输

以官方模型 ID 为键集中固定能力和 Pi 兼容配置；Base URL/API Key 仍由部署注入。选择本方案。

## 选择

1. 官方模型 ID 固定为 `deepseek-v4-flash`；`0731` 是当前模型版本，不进入 API 请求的 model ID。
2. 固定 `contextWindow=1_048_576`、`maxTokens=65_536`、`input=["text"]`、`reasoning=true`、默认 thinking level 为 `high`。
3. 固定 OpenAI Chat Completions 兼容项：不发送 store、不使用 developer role、不发送 reasoning effort、使用 `max_tokens`、使用 DeepSeek thinking 格式，并在重放 assistant 消息时保留 `reasoning_content`。
4. 当前 Pi 版本缺少官方 `supportsToolChoice=false`、`requiresAssistantContentForToolCalls=true` 和 `requiresReasoningContentForToolCalls=true` 三个同名字段。Provider 最终 payload 边界删除 `tool_choice`，为含 tool calls 的 assistant 消息补齐字符串 `content` 与 `reasoning_content`，并固定 `thinking={type:"enabled"}`。
5. Worker 选择官方模型 ID 时严格校验上下文、输出和图片能力；配置漂移时启动失败，不静默降级为通用模型。
6. 本地未提交 `.env` 更新为官方模型 ID、1M 上下文、64K 输出和禁用图片。Base URL/API Key 继续作为部署传输配置，不写入仓库。
7. Runtime compaction 的 16K 输出是应用压缩策略，不属于模型最大输出能力，继续独立配置。

## 理由

官方 Oh My Pi 配置比通用 API 理论上限更贴合当前 Agent Runtime 的实际调用协议。64K 是官方 OMP 对该模型的集成输出预算；它既高于旧 16K，又避免直接按 API 384K 理论上限为每轮保留过大的输出窗口。将 profile 集中在 Pi Adapter 后，第三方网关只负责传输，不能改变模型协议事实。

## 影响

### 正面影响

- 请求使用官方模型 ID 与 `max_tokens`；
- reasoning/thinking 与工具调用重放符合 DeepSeek 官方 OMP 配置；
- 图片不会被错误发送到文本模型；
- 模型能力漂移能在 Worker 启动时发现。

### 负面影响与成本

- 主模型每轮最大输出预算从 16K 提高到 64K，Provider 成本、延迟和上下文输出保留增加；
- 默认启用 high thinking，可能比旧 `reasoning=false` 产生更多 reasoning token；
- profile 当前按精确官方模型 ID 匹配，切换新版本时必须更新代码、测试和 ADR；
- 由于使用部署网关，readiness 仍需确认网关暴露官方 model ID。

### 安全与数据影响

- payload 规范化只处理协议字段，不读取或记录用户内容；
- API Key 和 Base URL 不进入 model profile、日志或提交；
- 模型能力校验在外部依赖装配前执行，失败不触碰 Provider。

## 验证

- 单元测试校验官方常量、reasoning、compat、thinking level 与 payload 规范化；
- Worker 装配测试校验官方 ID 生成 1M/64K/text/reasoning 模型，并拒绝 16K 漂移配置；
- tokenizer 测试改用官方 `deepseek-v4-flash` ID并继续验证固定离线资源；
- development `/models` 探针确认当前网关同时暴露官方 `deepseek-v4-flash`。

## 可逆性与回退

无 schema 迁移。可回退 profile 和本地 `.env`，恢复通用 OpenAI-compatible 配置；回退后将再次失去官方 DeepSeek reasoning 与工具重放兼容保证。

## 实施记录

- 2026-08-10：新增 DeepSeek V4 Flash 官方 profile、payload 规范化、装配校验与测试；本地运行配置切换到官方模型 ID 和 64K 输出。
