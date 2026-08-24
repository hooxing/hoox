# Domain 包

`@hoox/domain` 保存不依赖数据库、HTTP、模型 SDK 或 Sandbox SDK 的核心领域类型与状态机。

## 关键边界

- 所有实体 ID 使用不同品牌类型，避免编译期误传。
- 聚合实体使用名义品牌；数据库和 JSON 数据必须经过对应 `rehydrate*` 重新校验。
- Tenant 是隔离边界，Thread 是 Workspace、Run 与 SandboxSession 的所有权根。
- Workspace Revision 和 Resource Version 只能追加，已创建版本保持不可变。
- Workspace 写入由持有有效 `rootRunId + epoch + expiresAt` 租约的根 Run 控制。
- 状态转换通过显式函数完成；终态不能恢复，修正通过新 Attempt、新版本或新 Artifact 表达。
- Sandbox 厂商实例 ID 首次绑定后不可替换；重建创建新 Session，并保留替代关系。
- UTC 时间戳执行真实日历校验，不依赖 `Date.parse` 自动滚动。
- Agent 父节点进入终态前必须等待所有活跃后代显式结束，不进行隐式级联。
- 所有权错误不携带实体 ID；公开层还需把跨 Tenant 越权和不存在统一映射为 `NOT_FOUND`。

领域对象是内存快照，不是 ORM 实体。Repository、事务和外部适配位于 `@hoox/persistence` 等基础设施包；Domain/Protocol 转换与公开错误归一化统一经过 `@hoox/protocol-mapper`，调用方不得自行展开或恢复实体。

系统级关系见 [`docs/architecture/overview.md`](../../../docs/architecture/overview.md)。
