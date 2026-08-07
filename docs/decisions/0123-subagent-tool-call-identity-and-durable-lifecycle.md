# ADR-0123：SubAgent 工具调用身份与持久生命周期

- 状态：已接受
- 日期：2026-08-06
- 决策者：Runtime 团队
- 关联任务/PR：修复 SubAgent Provider 工具调用在 Attempt 副作用许可前失败
- 替代关系：细化 ADR-0122 第 6 条的工具 call ID namespace 和持久化边界，不替代其余结论

## 背景

SubAgent 的 Provider 工具调用 ID 是 Provider 自定义的非空字符串，例如 `call_xxx`，并不保证是十六进制 SHA-256。
首版实现错误地把该值传给只负责校验既有摘要的 `sha256Digest`，导致 Session 在发出 `tool.started` 前抛出异常，
Agent Turn 最终记录为失败。

修正 ID 生成后，SubAgent 还必须在 Attempt 级副作用许可表登记工具调用。现有持久化契约要求
`effectInvocation` 与唯一对应的 `tool.started` Run 事件在同一个 mutation 中原子提交；只提交 invocation 或使用空事件
都会被拒绝。若只持久化 started 而不持久化 completed，Run 级工具生命周期又会永久悬空。

完整子对话、思考和工具观察仍属于独立 Agent Rollout，不能因为满足 Attempt 副作用证明而复制进 root 上下文。

## 决策驱动因素

- 接受不同 Provider 的任意稳定工具调用 ID，同时避免不同 Agent/Turn 之间发生碰撞；
- 继续遵守 ADR-0011 的“工具开始事件与副作用 invocation 原子提交”约束；
- Run 级审计可以观察 SubAgent 工具调用的完整 started/completed 生命周期；
- 不把 SubAgent 的工具输出、思考或完整消息复制到 root 对话；
- 重放、重试和并行工具调用必须有稳定且互不冲突的幂等键。

## 备选方案

### 方案 A：为 Provider call ID 计算摘要，并持久化最小 Run 级生命周期

对 UTF-8 Provider call ID 计算 SHA-256，取前 32 个十六进制字符，与 `agent_thread_id`、`agent_turn_id` 组成
Attempt 级 call ID。`tool.started` 与 invocation 原子提交，`tool.completed` 使用独立 mutation 提交；两者仍同时写入
子 Agent Rollout，Run 级事件只复制工具元数据。

优点是兼容 Provider 原生 ID、满足既有事务不变量，并保留完整审计生命周期。缺点是同一工具事件存在 Rollout 和
Run 两个面向不同消费者的投影。

### 方案 B：直接使用 Provider 原始 call ID

实现最简单，但 Provider ID 只需在单次 Provider 会话内关联工具结果，不保证跨 Agent、Turn 或恢复重放全局唯一，
无法安全作为 Attempt 级副作用主键。

### 方案 C：放宽持久化契约，允许 invocation 不带 `tool.started`

可以绕过当前提交失败，但会破坏 ADR-0011 的原子审计不变量，使数据库可能存在无法由事件解释的外部副作用许可，
并扩大 root 和 SubAgent 两条执行路径的语义差异。

### 方案 D：工具生命周期只保存在子 Agent Rollout

不会产生 Run 级重复投影，但当前 Attempt 副作用许可消费依赖 Run mutation 原子登记 invocation。单独改造许可协议会
扩大恢复、幂等和审计边界，不适合作为本次故障修复。

## 选择

采用方案 A，并固定以下规则：

1. root Agent 保持 Provider 原始 call ID，兼容现有事件和恢复语义；SubAgent 的 Attempt 级 call ID 为
   `<agent_thread_id>:<agent_turn_id>:<sha256_utf8(provider_call_id) 前 32 个十六进制字符>`。
2. Provider 原始 call ID 只用于子 Agent Rollout 内部关联；副作用 invocation、许可消费和 Run 级工具事件统一使用
   namespace 后的 call ID。
3. SubAgent `tool.started` 与相同 call ID、tool name 的 `effectInvocation` 在同一个 Run mutation 原子提交。
4. SubAgent `tool.completed` 也提交到 Run 事件流。AgentSupervisor 在公布 turn 完成或失败结果前等待所有 started 和
   completed 提交结束；任一提交失败时中止 Session，并让 turn 失败关闭。
5. Run 级投影只保存现有工具生命周期元数据，不复制 prompt、思考、工具参数正文或工具输出；完整内容继续只属于
   子 Agent Rollout。
6. started 与 completed 的幂等键包含事件类型，避免同一个 call ID 的两个生命周期阶段互相覆盖。
7. 同一 Attempt 内的 SubAgent 工具事件在生成 Run sequence 前串行化；并行工具仍可并行执行，只串行提交其审计事件，
   避免多个事件读取相同的下一 sequence。

## 理由

namespace 中同时包含 Agent Thread、Agent Turn 和 Provider call ID 摘要，既保留了稳定性，又把 Provider 只保证局部
唯一的身份提升为 Attempt 可用身份。显式计算 SHA-256 也避免混淆“生成摘要”和“校验已有摘要”两个不同操作。

复用既有原子 mutation 比新增一套 SubAgent 副作用协议更小、更安全。started/completed 的 Run 级最小投影服务于
Attempt 许可与运行审计，Agent Rollout 则服务于子对话恢复；两者目的不同，不会把探索上下文泄漏给 root 模型。

## 影响

### 正面影响

- `call_xxx` 等合法 Provider ID 不再导致 SubAgent turn 在工具执行前失败；
- 不同 Agent/Turn 即使收到相同 Provider call ID，也不会争用同一 Attempt 副作用身份；
- 工具开始、许可登记和后续完成都有可恢复、可审计事实；
- root 工具调用的既有 call ID 与行为保持不变。

### 负面影响与成本

- 每个 SubAgent 工具调用除 Agent Rollout 外还增加两个轻量 Run 事件；
- 运维排查时需要认识 Provider 原始 ID 与 namespace 后 ID 两个层级；
- SHA-256 截断到 128 bit，虽然碰撞概率足够低，但不提供数学上的绝对无碰撞保证。

### 安全、数据与运维影响

本决策不扩大 SubAgent 工具权限、Sandbox 权限或 Tenant 边界。Run 级事件不新增敏感正文，只使用已有工具元数据。
无需数据库迁移；历史失败 turn 没有合法 invocation 事实，不做数据回填。部署时需要重启 Agent Worker 才能加载修复。

## 验证

- Pi Session 测试使用非摘要 Provider call ID，验证 started/completed 和许可消费均使用预期 namespace，同时 Rollout
  保留 Provider 原始 ID；
- RunWorker 测试使用严格持久化替身，验证两个并行 started 均与各自 invocation 原子提交、sequence 不冲突，并存在
  对应 completed 事件；
- AgentSupervisor 测试验证工具事件持久化失败会中止子 Session；
- 执行 Agent Worker 直接测试、typecheck、全仓格式和 lint 门禁。

## 可逆性与回退

代码可在没有活跃 SubAgent turn 时回退，或先以 `SUBAGENTS_ENABLED=false` 停用入口。回退不需要数据库 down
migration，但回退后的旧 Worker 无法继续使用 namespace call ID 完成尚未结束的工具调用，因此部署切换前必须 drain
或中止活跃 turn。已经写入的 Run 事件和 Agent Rollout 是审计事实，不删除、不改写。
