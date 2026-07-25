# Domain 包

该包保存不依赖数据库、HTTP、Pi 或 CubeSandbox SDK 的领域模型和状态机。

## 关键边界

- 所有实体 ID 使用不同的品牌类型，避免编译期误传。
- 首版只提供个人 Tenant 创建入口；团队 Tenant 仅保留类型形态。
- Thread 是 Workspace、Run、SandboxSession 的所有权根，后三者的 `tenantId` 从 Thread 继承。
- Workspace Revision 和 Resource Version 只能追加，已创建版本会冻结。Workspace 领域层只生成包含 revision/lease 双条件的提交命令；真正的并发安全必须由 Repository 原子条件更新保证。
- Workspace 写入者是持有有效 `rootRunId + epoch + expiresAt` 租约的根 Run；释放或到期后必须用更高 epoch 重新取得租约。
- 状态转换通过显式函数完成；终态不能恢复。Artifact 失败记录本身也是终态，Agent 修正后必须创建绑定新 ResourceVersion 的新 Artifact 发布记录。
- 任意 Agent 父节点进入终态前必须等待所有活跃后代显式结束，不进行隐式级联。
- 所有权错误不携带实体 ID。公开层还必须把跨 Tenant 越权和实体不存在统一映射为 `NOT_FOUND`。

领域对象是内存快照，不是 ORM 实体。Repository、事务和 DTO Mapper 由后续任务实现。
