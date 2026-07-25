# Domain 包

该包保存不依赖数据库、HTTP、Pi 或 CubeSandbox SDK 的领域模型和状态机。

## 关键边界

- 所有实体 ID 使用不同的品牌类型，避免编译期误传。
- 首版只提供个人 Tenant 创建入口；团队 Tenant 仅保留类型形态。
- Thread 是 Workspace、Run、SandboxSession 的所有权根，后三者的 `tenantId` 从 Thread 继承。
- Workspace Revision 和 Resource Version 只能追加，使用期望版本号检测并发覆盖，已创建版本会冻结。
- 状态转换通过显式函数完成；终态不能恢复。Artifact 发布失败是例外，可回到 `publishing` 让 Agent 修正后重试。
- 所有权错误不携带实体 ID。公开层还必须把跨 Tenant 越权和实体不存在统一映射为 `NOT_FOUND`。

领域对象是内存快照，不是 ORM 实体。Repository、事务和 DTO Mapper 由后续任务实现。
