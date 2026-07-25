# 决策：协议运行时 Schema 使用 TypeBox

- 状态：已接受
- 日期：2026-07-26
- 范围：`runtime-ts/packages/protocol`

## 背景

协议层需要同时提供 TypeScript DTO 类型和运行时校验，供 HTTP、SSE、队列事件与持久化 Rollout 边界复用。协议必须能显式版本化、生成或暴露标准 JSON Schema，并且不能依赖领域对象的 TypeScript 品牌类型。若只声明 TypeScript interface，外部输入在运行时没有可信边界；若手写类型和 JSON Schema，两者容易漂移。

## 备选方案

### TypeBox

- Schema 本身符合 JSON Schema 结构，适合协议发布、文档生成和跨进程/跨语言消费者。
- `Static` 从同一 Schema 推导 TypeScript 类型，`Value` 提供无代码生成的运行时校验。
- 组合泛型 Schema 时类型相对直接，适合成功、错误和事件信封工厂。
- 缺点是领域级 refinement 和面向表单的错误体验不如 Zod 直观；部分高级校验需要自定义 Format 或边界后的领域校验。

### Zod

- 社区成熟、API 直观，解析、转换和结构化错误能力强，适合应用输入与表单。
- 缺点是核心抽象不是 JSON Schema；即便可以转换，协议发布仍多一层转换规则和兼容风险。转换、默认值等行为也容易混入只应描述数据形状的协议层。

### 手写 JSON Schema + Ajv

- JSON Schema 和校验性能都成熟，跨语言能力最佳。
- 缺点是还需要额外的 TypeScript 类型生成或重复声明，首版工具链和漂移风险最大。

## 选择

选择 `@sinclair/typebox` `0.34.52`。协议 Schema 以 `v1` 为首个明确版本，默认 `additionalProperties: false`。领域包不依赖 TypeBox；协议包也不导入领域包，二者只通过独立的 `@cube-runtime/protocol-mapper` 适配包连接。

## 理由

当前优先级是稳定、可发布的机器协议，而不是表单错误体验。TypeBox 让 JSON Schema 成为一等产物，同时保留足够精确的静态类型与运行时验证，最符合 API、事件和后续多语言消费者的共同边界。

## 影响

- API 或 Worker 在接收外部数据时必须先通过协议 Schema，再映射为带品牌 ID 和不变量的领域对象。
- TypeBox 校验通过只代表数据形状合法，不代表 Tenant 所有权或状态转换合法；这些规则仍由 `domain` 执行。
- 新增字段必须先决定是 v1 的可选兼容字段还是新协议版本，不允许直接放宽 `additionalProperties`。
- 公开错误只使用稳定错误码；跨 Tenant 的不存在与无权访问统一映射为 `NOT_FOUND`。

## 验证

- 使用序列化往返测试证明 DTO 经 JSON 编解码后仍通过同一 Schema。
- 使用属性测试覆盖 ID 格式，并用反例验证额外字段和非法状态被拒绝。
- 成功、错误、事件信封由通用工厂或固定 Schema 验证协议版本。

## 可逆性

选择可逆。DTO 的外部契约是 JSON Schema 和 JSON 数据，而不是 TypeBox API。若未来切换 Zod 或 Ajv，先冻结导出的 v1 Schema 快照和兼容测试，再替换内部构造器；领域包和已发布协议不需要随库迁移。
