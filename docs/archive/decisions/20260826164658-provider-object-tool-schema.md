# ADR-20260826164658：Provider 工具参数使用顶层 object Schema

- 状态：已替代（由 [ADR-20260826172009](../../decisions/20260826172009-single-source-provider-object-tool-schema.md) 收敛为单一严格 Schema）
- 日期：2026-08-26
- 决策者：项目维护者
- 关联任务/PR：修复切换模型后新 Run 因工具 Schema 被 Provider 拒绝
- 替代关系：被 ADR-20260826172009 替代

## 背景

`automation_update` 使用顶层联合 Schema 表达 create、update、pause、resume 和 delete 五种 action。TypeBox 会把该联合序列化为只有 `anyOf`、没有顶层 `type` 的 JSON Schema。部分 OpenAI-compatible Provider 要求函数参数顶层明确为 `type: "object"`，因此会在生成开始前返回 HTTP 400；不携带工具的模型探测仍会成功，导致配置测试与真实 Run 结果不一致。

## 决策驱动因素

- 工具定义应能被常见 OpenAI-compatible Provider 接受；
- action 对应的必填字段、取值范围和多余字段限制不能放宽；
- 不修改定时任务 API、持久化数据或执行权限；
- 工具 Schema 保持静态，不注入 Run 或用户级动态数据。

## 备选方案

### 方案 A：继续发送顶层联合 Schema

Runtime 校验最直接，但已经被目标 Provider 拒绝，真实 Run 无法开始。

### 方案 B：只保留一个宽松 object Schema

Provider 兼容性最好，但执行边界无法保证每个 action 的必填字段和禁止多余字段语义。

### 方案 C：模型侧 object Schema 与 Runtime action Schema 分层

向 Provider 发送顶层明确为 object 的公共字段 Schema；Pi 参数桥在执行前继续用原有联合 Schema 做严格校验，无效参数只形成失败回执，不触发写入。

## 选择

选择方案 C。`automation_update` 的 Provider 参数定义改为稳定的顶层 object，action 仍为必填字段，其余字段按各 action 的并集公开。原联合 Schema 继续作为 Runtime 事实源；参数桥验证通过后才允许执行器接收参数。

## 影响

- DeepSeek 等要求函数参数顶层为 object 的 Provider 可以接受完整 Run 请求；
- 模型侧 Schema 不能单独表达 action 之间的全部条件关系，但工具说明和字段约束仍然可见；
- Runtime 校验、失败回执、持久化和权限边界不变；
- 不新增配置、数据迁移或运维步骤。

## 验证

- 单元测试断言 Provider Schema 顶层为 object；
- 单元测试证明模型侧公共 Schema 与 Runtime action Schema 分层生效；
- 既有无效参数测试证明错误参数不会触发写入；
- 执行 pi-adapter 的格式、lint、类型检查和测试；
- 使用当前已启用 Provider 发送包含 `automation_update` 的真实模型请求，确认不再返回 Schema 400。

## 可逆性与回退

该改动不写入数据，可通过恢复原 Provider 参数 Schema 回退。若后续所有受支持 Provider 都原生接受顶层联合 Schema，可以重新合并两层定义，但必须保留真实 Provider 兼容测试。
