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

## 实体真实性、替换身份与协议时间

### 背景与备选

最初使用不可枚举 `unique symbol` 作为实体品牌。它能阻止从零构造对象，但 TypeScript 的对象展开在静态类型上仍会保留 symbol 品牌，导致 `{ ...valid, status: 非法值 }` 可能继续被视为实体。可选方案有：

1. 保留 symbol，并在每个公开函数重复运行时真实性校验。
2. 使用带 private/protected 成员的 class 名义品牌，让对象展开在编译期必然丢失身份。
3. 把全部领域状态封装成行为 class，不再暴露只读数据字段。

同时，替换 Artifact/Sandbox 若允许复用原 ID，会让一个 ID 对应两个不可变历史；协议时间只使用正则也会接受 2 月 30 日等不存在日期。

### 选择与理由

选择第二种，并继续保持“只读数据 + 纯转换函数”的领域风格。`sealEntity` 创建名义 class 实例，JSON 序列化仍只包含数据；任何展开或 JSON 恢复都会丢失身份，必须经过 `rehydrate*`。Artifact 和 Sandbox 替换同时要求新内容版本/厂商会话语义与新实体 ID。协议层为 UTC 时间注册 TypeBox 自定义 format，并与 Domain 一样通过规范化后的 `toISOString()` 回比验证真实日历。

### 影响与验证

- 业务代码不能通过对象展开修改聚合；必须调用公开状态转换函数。
- 使用 TypeScript Compiler API 编译两个 spread 篡改用例，固定要求产生赋值错误；这比只测试从零对象字面量更接近真实误用。
- create 与 rehydrate 都拒绝复用 Artifact ID 或 Sandbox Session ID，Workspace 恢复要求 `revisionNumber === 0` 当且仅当 `currentRevisionId` 缺失。
- TypeBox Schema 测试和 Domain 测试使用同一组非法闰日、月末日期和 24:00 反例。
- Domain、Protocol 与 Protocol Mapper 包的 `types` 和条件 `exports.types` 指向源码，运行时 `default` 指向 dist；干净安装后的 typecheck/build 验证依赖解析不依赖旧构建残留。

### 可逆性

未来可以升级为完整行为 class 或为高风险入口叠加运行时 `instanceof`，不会改变 JSON/DTO。替换 ID 与严格时间已经是持久化和公开协议不变量，若放宽必须新协议版本并迁移历史数据，不能静默回退。
