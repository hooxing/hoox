# Domain 包

该包保存不依赖数据库、HTTP、Pi 或 CubeSandbox SDK 的领域模型和状态机。

## 关键边界

- 所有实体 ID 使用不同的品牌类型，避免编译期误传。
- 聚合实体使用带 private 成员的 class 名义品牌；对象展开只得到普通数据，不能继续作为实体传入状态转换。数据库或 JSON 数据必须经过对应 `rehydrate*`，重新校验字段和关联。
- 首版只提供个人 Tenant 创建入口；团队 Tenant 仅保留类型形态。
- Thread 是 Workspace、Run、SandboxSession 的所有权根，后三者的 `tenantId` 从 Thread 继承。
- Workspace Revision 和 Resource Version 只能追加，已创建版本会冻结。Workspace 领域层只生成包含 revision/lease 双条件的提交命令；真正的并发安全必须由 Repository 原子条件更新保证。
- Workspace 写入者是持有有效 `rootRunId + epoch + expiresAt` 租约的根 Run；释放或到期后必须用更高 epoch 重新取得租约。
- 状态转换通过显式函数完成；终态不能恢复。Artifact 失败记录本身也是终态，Agent 修正后必须创建绑定新 ResourceVersion、使用新 Artifact ID 的新发布记录。
- Sandbox 的厂商实例 ID 首次绑定后不可替换；重建必须创建新 Session ID，并通过 `replacesSessionId` 保留关系。
- UTC 时间戳会执行真实日历校验，不能依靠 `Date.parse` 的自动日期滚动。
- 任意 Agent 父节点进入终态前必须等待所有活跃后代显式结束，不进行隐式级联。
- 所有权错误不携带实体 ID。公开层还必须把跨 Tenant 越权和实体不存在统一映射为 `NOT_FOUND`。

领域对象是内存快照，不是 ORM 实体。Repository 与事务由后续任务实现；Domain/Protocol 转换和公共错误归一化统一通过 `@cube-runtime/protocol-mapper`，调用方不得自行展开或恢复实体。
