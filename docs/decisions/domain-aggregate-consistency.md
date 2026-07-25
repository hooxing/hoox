# 决策：领域聚合的一致性与修正语义

- 状态：已接受
- 日期：2026-07-26
- 范围：Workspace、Agent Tree、Artifact

## 背景

纯领域对象只能表达单个内存快照，无法单独阻止多 Worker 并发提交。Agent Tree 的父节点终止和 Artifact 发布失败也都存在多种合理处理方式，若不先固定语义，持久层、事件和 UI 会各自推断出不同结果。

## Workspace CAS 与写租约

### 备选

1. 只在领域对象比较 `expectedRevisionNumber`。实现简单，但两个 Worker 可同时基于同一快照通过比较，不能提供并发安全。
2. 仅依赖数据库 revision CAS。可以阻止覆盖，但不能表达一个 Thread 当前由哪个根 Run 写入，也难以安全回收崩溃 Worker。
3. 数据库原子 revision CAS 加带过期时间的 writer lease/epoch。

### 选择与理由

选择第三种。Domain 建模 `rootRunId + epoch + expiresAt`，并生成同时携带 `expectedCurrentRevisionNumber` 和 `expectedLeaseEpoch` 的提交命令。Repository 必须在一个原子条件更新中比较当前 revision、writer、epoch，并使用数据库时钟判断租约未过期；Domain 内的比较只验证命令自洽，不能宣称已解决并发。

### 影响与验证

- Worker 取得、续租、释放均产生新的 Workspace 快照；旧租约到期后只能以更高 epoch 获取，避免旧 Worker 恢复后继续写入。
- Repository 后续必须以 `WorkspaceRevisionCommitPort` 为契约，集成测试用两个事务证明只有一个相同 revision/epoch 的提交成功。
- 当前单元测试只验证持有者、epoch、到期语义和提交命令包含 CAS 条件，不再伪造持久层并发结论。

### 可逆性

可以把租约实现迁移到 Redis 或专用协调服务，但 `rootRunId/epoch` 和原子提交结果语义必须保持；否则需要新事件版本和数据迁移。

## Agent 父节点终止后代策略

### 备选

1. 父节点进入终态时隐式级联取消所有后代。
2. 父节点等待所有活跃后代显式完成、失败或取消。
3. 允许父节点先终止，后代成为孤儿继续运行。

### 选择与理由

选择第二种。隐式级联会跳过各后代的中断、清理和事件记录；孤儿运行会破坏树的所有权和根 Agent 汇总职责。等待策略要求任意层级父节点进入 `completed/failed/cancelled` 前都没有 `active/waiting` 后代，每个后代必须走显式状态转换，因此审计链完整。

### 影响与验证

- 取消流程需要先从叶节点向上结束，不能只改根状态。
- 状态机测试覆盖三层树，并证明中间父节点也不能越过活跃孙节点终止。
- 后续协调器应提供显式的“取消子树”命令，逐节点发事件，而不是绕过该不变量。

### 可逆性

未来可在应用层增加显式、可审计的批量级联命令；领域单节点转换规则无需改变。允许孤儿运行属于不可兼容变化，不在当前可逆范围。

## Artifact 修正发布策略

### 备选

1. 失败 Artifact 原记录从 `failed` 回到 `publishing`，继续绑定原 ResourceVersion。
2. 复用 Artifact ID，但替换为新 ResourceVersion。
3. 失败记录保持终态；新建 Artifact 和新 ResourceVersion，并用 `replacesArtifactId` 连接。

### 选择与理由

选择第三种。前两种会改写用户曾经看到的发布尝试或让同一 ID 指向不同内容，破坏审计与下载可复现性。修正后的内容天然是新 ResourceVersion，新的发布尝试也必须是新 Artifact。

### 影响与验证

- `failed` 和 `published` 都是终态；修正发布只能替换同一 Run 下失败的 Artifact，且新旧 ResourceVersion ID 必须不同。
- UI 可沿 `replacesArtifactId` 展示修正链，默认只突出最新成功记录。
- 单元测试拒绝原版本重试，并验证新版本、新 Artifact 的修正发布可以完成。

### 可逆性

可以在读取模型中把修正链折叠成一个逻辑交付物，但底层不可变发布记录不能原地合并或覆盖。
