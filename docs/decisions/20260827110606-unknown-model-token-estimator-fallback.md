# ADR-20260827110606：未知模型使用自动 Token 估算而不阻断 Provider

- 状态：已接受
- 日期：2026-08-27
- 决策者：Runtime 维护者
- 关联 Issue / PR：OpenAI Compatible Worker 未知 tokenizer 阻断修复
- 替代：ADR-0035 中“Worker 无精确 tokenizer 时使用 UTF-8 字节上界”的默认装配选择；ADR-0100 中“未注册 tokenizer 的模型失败关闭”的选择
- 被替代：无

## 背景

后台已经允许管理员保存、测试并启用任意 OpenAI-compatible 模型，但 Worker 在为已发布 Provider Revision 创建 Session 时调用固定 tokenizer 注册表；除 DeepSeek V4 外的默认模型会抛出 `MODEL_TOKENIZER_UNSUPPORTED`，因此已经通过真实 Provider 探测的模型仍无法进入转发链路。

模型实际 Token 用量应优先采用 Provider 返回的 usage。请求前的上下文 admission、历史选择和压缩不能等待响应 usage，仍需要一个本地计数能力；任意自定义模型又无法可靠获得与其真实底模、chat template 和 revision 完全一致的 tokenizer。

## 约束

- 安全与租户边界：模型计数能力仍必须由 Worker 内部可信装配绑定，Session 不接受管理员或请求方提供的裸 tokenizer。
- 数据与迁移：不修改 Provider Revision、Run 快照、Thread Context 或模型用量表结构。
- 兼容性：DeepSeek V4 固定离线 tokenizer、Provider 路由快照校验和 tokenizer identity 漂移检查继续有效。
- 运维与故障恢复：未知 tokenizer 不能阻断已发布模型；估算策略必须有稳定版本身份，以便策略变化触发现有上下文兼容重建。
- 性能与成本：未知模型降级不得动态下载 tokenizer，也不得引入按请求网络依赖。
- 交付范围与时间：不新增后台 tokenizer 配置，不建立任意 Hugging Face tokenizer 托管流程。

## 备选方案

### 方案 A：继续要求每个模型先注册精确 tokenizer

请求前计数最接近模型实现，但后台的任意 OpenAI-compatible 模型能力会被 Worker 私有注册表否决；同名模型还可能因为上游 chat template 或 revision 不同而产生虚假精确性，故不采用。

### 方案 B：完全依赖 Provider usage

响应完成后的用量最可信，但首轮请求、失败请求、上下文 admission 和压缩发生在 usage 可用之前，无法只依赖响应事实，故不采用。

### 方案 C：已知模型使用精确 tokenizer，未知模型自动使用稳定估算器

DeepSeek V4 保留固定资源和摘要校验；其他模型按模型 ID 自动选择 Gemini、Claude 或 OpenAI 默认权重，不要求管理员配置。选择本方案。

## 决策

1. Worker 的模型计数能力解析不再对未知模型抛出 `MODEL_TOKENIZER_UNSUPPORTED`。已注册的 DeepSeek V4 继续使用固定官方 tokenizer；未知模型返回版本化的本地估算能力。
2. 估算器按 new-api 的厂商分类和字符权重计算：模型 ID 包含 `gemini` 时使用 Gemini 权重，包含 `claude` 时使用 Claude 权重，其他模型统一使用 OpenAI 默认权重。状态机区分 Unicode 字母、连续数字、CJK、Emoji、数学符号、URL 分隔符、空白和普通符号，并对结果向上取整。对齐基准固定为 [`QuantumNous/new-api@8f6961c` 的 `service/token_estimator.go`](https://github.com/QuantumNous/new-api/blob/8f6961c675932f406260ff0c218bc2aa0603e9b2/service/token_estimator.go)。
3. 管理模型配置不增加 tokenizer、编码名称、估算权重或 revision 字段。模型保存、测试、启用和转发只依赖既有 Provider、模型能力和真实探测结果。
4. 本地估算器只负责请求前上下文预算、历史投影和压缩计数。Provider 返回的 assistant usage 继续作为模型用量指标的事实源；本次不把估算值伪装成 Provider usage。
5. 估算能力使用 `new-api-token-estimator:<family>-v1` identity，并通过既有可信能力 WeakSet、模型路由快照和探针计数校验绑定当前 Pi Model。估算策略变化必须升级 identity。
6. DeepSeek V4 精确 tokenizer 的固定资源、SHA-256 校验、来源 revision 和供应链记录保持不变。

## 理由

该方案使“模型是否能转发”与“Worker 是否拥有该模型的精确 tokenizer”解耦，同时保留请求前预算所需的确定性计数。自动厂商分类不增加管理员认知负担；未知模型默认使用 OpenAI 权重，与 new-api 的兜底行为一致。版本化 identity 让估算策略仍受现有恢复兼容和漂移门禁保护，不会成为绕过可信模型绑定的外部输入。

## 影响

### 正面影响

- 任意已发布 OpenAI-compatible 默认模型都能完成 Worker Session 装配。
- DeepSeek V4 继续享受精确离线计数，其他模型无需补充 tokenizer 资源即可运行。
- 中文、Emoji、数字和高熵符号不再统一按 UTF-8 字节数放大。
- 后台不增加 tokenizer 配置项。

### 负面影响

- 未知模型的请求前 Token 数是估算值，可能高于或低于真实 tokenizer 结果。
- 模型别名不含 `gemini` 或 `claude` 时会落入 OpenAI 默认权重。
- 估算 identity 变化会使既有上下文策略判定为不兼容并要求重建。

### 安全与隐私

- 不下载远程 tokenizer，不读取新增秘密，不持久化请求或响应正文。
- 外部调用方仍不能注入 TokenizerPort 或绕过模型路由绑定。

### 数据、兼容与迁移

- 无数据库迁移。
- 已持久化的 DeepSeek V4 tokenizer identity 不变。
- 原来使用 `utf8-byte-upper-bound-v1` 的非生产默认绑定在新 Worker 装配中改为版本化厂商估算 identity。

### 运维与可观测性

- Context Budget 诊断中的 `tokenizerIdentity` 会明确显示精确 tokenizer 或估算器 family。
- Provider usage 指标语义不变，缺少 usage 的 Provider 不会被本地估算冒充为真实用量。

## 验证

- Pi Adapter 单元测试证明 DeepSeek V4 继续加载固定 tokenizer，并保持既有中英文、Emoji 和探针计数。
- Pi Adapter 表格测试证明未知、Gemini 和 Claude 模型分别选择 OpenAI、Gemini 和 Claude 估算权重。
- Agent Worker 装配测试证明自定义模型可绑定 `new-api-token-estimator:openai-v1`，不再因未知 tokenizer 失败。
- 执行 Pi Adapter 与 Agent Worker typecheck，以及相关 Session、compaction 和 Worker 测试。

## 可逆性

可回退估算器和 Worker 自动绑定代码，恢复未知模型失败关闭；无数据迁移需要回滚。回退后，已发布的非 DeepSeek V4 模型会再次无法创建 Worker Session，因此只适合作为短期故障处置。

## 实施记录

- Issue：当前任务
- PR：直接分支合并
- 提交：与本 ADR 同步提交
- 后续验证：远程 main CI
