# ADR-20260828113059：定时任务工具分离 Provider 形状与可纠正错误语义

- 状态：已接受
- 日期：2026-08-28
- 决策者：项目维护者
- 关联任务/PR：修复 `automation_update` 合规请求误判与错误语义污染
- 替代关系：部分替代 ADR-20260826172009 的单一严格 Schema 实现；继续保留字段定义复用与顶层 object 要求

## 背景

`automation_update` 曾把严格 action 联合 Schema 直接作为 Provider 参数，并通过额外声明顶层 `type: "object"` 满足 OpenAI-compatible Provider 的格式要求。该组合通过了目标 Provider 的请求探针，但真实工具验收中，省略可选字段、显式首跑时间和携带 RRULE 的合规创建请求仍可能全部进入 `AUTOMATION_ARGUMENTS_INVALID`。失败只返回“定时任务参数无效”，虽然标记 `correctable: true`，却没有字段或原因，模型无法据此修正。

此外，Schema 之后的时区、RRULE、时间和 UTF-8 字节长度校验抛出的 `TypeError` 会穿过持久化边界并被统一投影成 `AUTOMATION_PERSISTENCE_UNAVAILABLE`；权限拒绝又与不存在、状态冲突和幂等冲突共用同一条可纠正文案。参数错误、操作拒绝和基础设施故障因此失去稳定分类。

## 决策

1. 向 Provider 暴露不含顶层 `anyOf` 的稳定 object Schema，列出 action 与所有公共候选字段。Provider Schema 和 Runtime Schema 复用同一组字段 Schema，避免字段类型、长度和说明各自漂移。
2. Runtime 继续使用严格 action 联合 Schema 校验必填字段、允许字段和 `null` 边界。参数桥在替换为内部占位参数时保存本次校验诊断；失败结果返回 `details: [{ field, reason }]`，使 `correctable: true` 对调用方可达。
3. 在进入定时任务持久化端口前规范化名称、指令、时区、首跑时间和 RRULE。字段值失败使用 `AUTOMATION_ARGUMENT_VALUE_INVALID`，并保留字段级详情；首跑时间必须显式携带 `Z` 或数值偏移。
4. 错误投影严格区分：
   - 结构错误：`AUTOMATION_ARGUMENTS_INVALID`，可纠正；
   - 字段值错误：`AUTOMATION_ARGUMENT_VALUE_INVALID`，可纠正；
   - 不存在、状态冲突和幂等冲突：保留各自稳定码与针对性文案，可纠正；
   - 权限拒绝：`AUTOMATION_NOT_AUTHORIZED`，不可通过修改参数保证修复，不标记为可纠正；
   - 未知或基础设施失败：`AUTOMATION_PERSISTENCE_UNAVAILABLE`，不可纠正并失败关闭。
5. Schema 失败仍必须形成 durable Tool Observation，且不得调用定时任务写入端口。

## 影响

- Provider 不再承担顶层联合 Schema 的兼容风险，Runtime 仍保持 action 级严格校验。
- 模型可以根据字段级详情修复请求，不需要盲目枚举参数组合。
- 领域值错误不会再伪装成持久化不可用；权限和服务故障也不会再共用参数或状态错误语义。
- 创建和更新请求会在写入前规范化为 UTC 首跑时间、规范 RRULE 和有效 IANA 时区，幂等摘要绑定规范化后的领域命令。
- 不修改定时任务表、公开 HTTP API 或既有任务数据。

## 验证

- Pi Adapter 测试覆盖 Provider Schema 无顶层 `anyOf`、Runtime action 严格校验，以及省略可选字段、显式时区、携带 RRULE 的三类合规创建请求。
- Pi Adapter 测试覆盖 Schema 错误字段详情和首跑时间时区偏移校验。
- Agent Worker 测试覆盖字段值错误、状态错误、权限拒绝与服务不可用的稳定投影差异。
- 运行受影响包的类型检查、测试、格式检查、Lint 与 `git diff --check`。

## 可逆性与回退

该改动不迁移数据。若未来所有目标 Provider 都稳定支持顶层联合 Schema，可新增证据后恢复单一严格 Schema；字段级诊断和错误分类应继续保留，不随 Provider 形状回退。
