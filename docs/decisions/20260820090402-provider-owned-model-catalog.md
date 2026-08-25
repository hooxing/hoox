# Provider 拥有可启用的模型目录

- 状态：部分已替代（管理页面的内置 Provider 改为只启用所选默认模型；多模型结构与 Runtime 兼容继续有效）
- 日期：2026-08-20
- 决策者：Runtime 维护者
- 关联任务/PR：后台控制面支持一个模型 Provider 配置多个模型
- 替代关系：细化 ADR-20260819165254 的模型配置结构，不改变其权限与 Run 快照边界
- 后续替代：[ADR-20260826000935](20260826000935-published-model-capabilities-are-runtime-facts.md) 收窄管理页面的多启用语义；API 数据结构、显式默认模型和 Worker 对历史多启用 Revision 的兼容不变

## 背景

首版后台控制面把一个 `model_provider` revision 同一个 `modelId`、上下文窗口和最大输出预算绑定。这使 Provider 与
模型变成一对一关系，无法表达同一个 OpenAI-compatible endpoint 下的多个模型，也偏离 Pi 的 Provider 模型：
Provider 持有连接和认证信息，模型目录持有各模型的能力与预算。

Worker 当前每个 Run 仍需要一个确定模型。只增加模型数组而不定义选择规则，会让发布后的执行语义不确定；只允许
一个模型启用，则又无法表达“允许使用的模型集合”。

## 备选方案

### 方案 A：每个模型复制一份 Provider

无需改变运行时选择逻辑，但重复保存 endpoint、协议和 secretRef；同一 Provider 的连接探测、审计和切换也会被拆散，
故不采用。

### 方案 B：Provider 保存模型目录，只允许一个模型启用

选择规则简单，但“启用”与“默认”混成一个状态，无法为后续按任务或用户选择模型保留稳定契约，故不采用。

### 方案 C：Provider 保存模型目录，模型独立启用，并显式指定默认模型

Provider revision 包含多个 Pi 风格模型条目。管理员可独立启用或停用每个模型；多个模型可以同时启用，但
`defaultModelId` 必须引用一个启用模型。当前 Worker 使用默认模型，后续选择能力只能从同一 Run 快照中的启用集合取值。

## 选择

采用方案 C，并固定以下约束：

1. Provider 继续拥有 `providerKey`、显示名称、协议、HTTPS Base URL 和部署 `secretRef`。
2. Provider 的 `models` 是 1 到 100 个不可重复模型。模型字段对齐当前 Pi Provider 模型的必要子集：`id`、`name`、
   `reasoning`、`input`、`contextWindow`、`maxTokens`；平台另加 `enabled` 管理状态。首版不让后台配置任意 headers、
   compat、单模型 URL 或价格，避免扩大网络与请求协议面。
3. 至少一个模型必须启用，`defaultModelId` 必须精确引用一个启用模型。模型 ID 区分大小写；重复 ID、重复输入能力、
   空输入能力或 `maxTokens > contextWindow` 均拒绝。
4. Provider 探针只验证启用模型，并要求所有启用模型都出现在该 Provider 的 `/models` 响应中；停用模型不影响探针。
5. Worker 从不可变 Run 配置快照向 Pi 注册该 Provider 的全部启用模型，并选择 `defaultModelId` 执行。Context budget、
   tokenizer 和 compaction 兼容性均以该默认模型的 Pi metadata 为准。
6. 运行设置发布校验与默认模型的 `maxTokens` 比较。切换启用集合或默认模型必须创建并发布新的 Provider revision，
   已建立快照的 Run 不受影响。
7. 迁移追加新版本收紧 JSON 形状；不改写已经记录的迁移。回退只有在不存在新形状模型配置事实时才允许。

## 理由

该结构把连接身份、模型能力和平台选择策略分开：Provider 与 Pi 一致地拥有模型目录，管理员可以维护可用集合，Worker
仍有确定且可审计的默认执行模型。显式默认值避免依赖数组顺序，也让未来引入用户选择或路由策略时不必再次改变
Provider 持久化形状。

## 影响

- 管理页面需要可增删的模型行、启用开关和默认模型选择；
- 控制 API 暂时不可用时，管理页面仍展示本地模型目录编辑器和明确错误，但提交继续失败关闭；
- Provider revision 和 API 协议发生不兼容变化，尚未合并的首版单模型结构由后续迁移替代；
- Provider 探针会因任一启用模型缺失而失败；
- 当前 Run 仍执行一个默认模型，启用的其他模型只形成受控目录，不自动参与负载均衡；
- secretRef、控制面数据库角色、JWT audience、聚合统计和 Run 快照权限边界保持不变。

## 验证

- 领域测试覆盖模型 ID 唯一、至少一个启用、默认模型必须启用、预算与输入能力规范化；
- 协议/API 测试覆盖多模型严格 JSON 和秘密值不进入请求；
- Provider 探针测试覆盖所有启用模型存在以及停用模型不参与检查；
- Worker 测试覆盖只注册启用模型、选择默认模型和 Run revision 缓存；
- PostgreSQL 测试覆盖新 JSON CHECK、发布兼容性与旧 Run 快照稳定；
- 管理 Web 测试覆盖模型行增删、启用和默认选择。

## 可逆性与回退

代码回退前应先停止发布新模型 revision，并确认不存在新目录形状的模型配置、激活记录或 Run 快照。迁移 down 在存在
任何模型配置事实时失败关闭，避免把多模型目录无损降级成单模型。已存在 Run 快照必须继续由新代码读取，或等待这些
Run 终结后再执行受控数据归档。
