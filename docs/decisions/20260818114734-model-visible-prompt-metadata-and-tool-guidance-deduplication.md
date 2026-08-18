# ADR-20260818114734：模型可见 Prompt 元数据与工具指引去重

- 状态：已接受
- 日期：2026-08-18
- 决策者：System Prompt 精简实施审阅
- 关联范围：`prompt-builder`、Pi Session Prompt 兼容版本、Skill 目录注入
- 替代关系：局部替代 ADR-0029 中“模型可见 capability manifest 包含摘要、描述和参数 Schema 摘要”的展示格式；局部替代 Skill Center 规范中的空目录输出要求

## 背景

Runtime 已将同一组真实工具的完整名称、描述和参数 Schema 作为 Provider Tool Schema 发送给模型，同时又在 System Prompt 的 `CAPABILITY_MANIFEST` 中重复发送工具描述和参数 Schema 摘要。Harness 还重复记录了 Collapse、Todo、Edit 和 `user_facing_purpose` 等已经存在于工具 description 或参数 Schema 中的操作细节。

这些重复文本增加固定上下文成本。模型可见的 SHA-256 只服务于 Runtime 审计和兼容性核对，不能帮助模型理解或验证工具参数。没有 Skill 时输出固定空目录也不提供可执行信息。Pi Compaction 的启用状态属于 Runtime 内部强制配置，模型不能操作该设置。

## 决策驱动因素

- 只删除没有独立行为价值的重复内容，不改变信任分层、工具授权和副作用边界；
- 工具操作细节保持单一来源，避免 Harness 与 Tool Schema 漂移；
- Runtime 仍必须保留完整 capability manifest、Schema 摘要和 Prompt 摘要用于审计；
- 相同输入仍需生成字节稳定的模型上下文；
- 有 Skill 时的目录格式、排序、转义和快照来源保持不变。

## 备选方案

### 方案 A：维持当前模型可见内容

无需升级 Prompt 版本，但继续承担重复 Token 成本，并需要同步维护 Harness 与工具 description。

### 方案 B：删除 capability manifest

压缩最多，但会扩大本次改动范围，并改变 Harness 对实际工具列表的显式引用方式。

### 方案 C：保留模型可见工具 ID，移除哈希、描述和重复工具细节

仍向模型提供明确的实际工具列表，同时把完整描述和参数约束留在原生 Tool Schema，把摘要留在 Runtime 内部结构。

## 选择

采用方案 C，并只实施以下变化：

1. Prompt 版本升级为 `runtime-system-prompt.v14`。
2. 模型可见的 Prompt 顶部不再包含 capability manifest digest。
3. 模型可见的 `CAPABILITY_MANIFEST` 只输出实际工具 ID，不输出 manifest digest、`input_schema` 摘要或重复 description；`prompt-builder` 生成的低信任与个性化上下文封装也不再把内容摘要写入模型可见文本。
4. `ToolCapabilityManifest` 结构、完整 capability 输入、manifest digest、Prompt digest 和 Context Budget 中的原生 Tool Schema 保持不变。
5. 从 Harness 删除已经由工具 description 或参数 Schema完整表达的 Collapse、Todo、Edit 细节和 `user_facing_purpose` 说明；保留直接回答边界、文件工具选择和 `write` 的使用边界。
6. 删除模型不可操作的“Pi 默认 Compaction 已禁用”说明；Pi 配置、诊断和禁止 Compaction 的测试保持不变。
7. 没有可用 Skill 时不输出 `AVAILABLE_SKILLS` 分区；有 Skill 时继续输出原有目录内容。
8. Skill 市场发现、安全边界和缺少关键信息时询问用户的规则保持不变。

## 影响

### 正面影响

- 减少 System Prompt 与 Provider Tool Schema 的重复内容；
- 模型上下文不再承载无行为价值的高熵摘要；
- Tool description 和参数 Schema 成为工具操作细节的单一来源；
- 空 Skill 目录不再占用固定上下文。

### 负面影响与成本

- 模型不能从 System Prompt 看到工具描述和 Schema 摘要，但仍能从 Provider 原生 Tool Schema 获得完整工具契约；
- Prompt 字节发生变化，恢复兼容身份必须使用新版本；
- 调试模型请求时，需从 Runtime 诊断而不是模型可见文本读取摘要。

### 安全与兼容性

本决策不删除内部 manifest，不放宽 Tool Router、执行许可、Sandbox 或副作用校验。工具清单仍由即将注册给 Pi 的同一组真实工具派生。低信任上下文仍不进入 system role。Pi 默认 Compaction 仍由代码关闭，仅删除模型不可操作的说明文本。

## 验证

- Golden Prompt 固定为 v14，System Prompt、低信任上下文和个性化上下文的模型可见文本不包含 `sha256:`、`input_schema=` 或重复工具 description；
- manifest 仍包含完整工具描述和 Schema 摘要，并产生合法 SHA-256；
- 能力增删仍改变模型可见工具 ID 列表、manifest digest 和 Prompt digest；
- 同名工具 Schema 变化仍改变 manifest digest；
- 没有 Skill 时不出现 `AVAILABLE_SKILLS`，有 Skill 时目录排序和转义保持不变；
- Harness 不再重复 Collapse、Todo、Edit 和 `user_facing_purpose` 的工具细节；
- Pi Session 诊断继续证明 Compaction 关闭且无 Compaction Entry。

## 可逆性

该变化不修改持久化 Schema。回退时恢复 v13 模型可见格式和空 Skill 分区即可；内部 manifest 与摘要始终保留，不需要迁移历史数据。已经记录的 v13/v14 Prompt 版本和摘要继续按各自版本解释，不原地改写。
