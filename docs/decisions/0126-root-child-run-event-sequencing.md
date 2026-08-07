# ADR-0126：Root 与 Child 的 Run 事件共享编码队列

- 状态：已接受
- 日期：2026-08-06
- 决策者：Runtime 团队
- 关联任务/PR：修复 root 等待期间 Child 首个工具事件间歇冲突
- 替代关系：细化 ADR-0123 的 SubAgent 工具生命周期，不替代其余结论

## 背景

root 与 Child 拥有独立模型会话和独立 Rollout，但它们同属一个 ExecutionAttempt。面向 UI 和审计的 `run_events` 使用
Attempt 级单调 `sequence`，因此 root 模型事件与 Child 工具 started/completed 必须进入同一序列。

RunWorker 已用 `DurableOperationLane` 串行执行 Attempt mutation，但 root 事件和 Child 工具事件原本各有一条 Promise 队列。
两条队列会在进入 durable lane 之前分别读取 `context.nextEventSequence` 并构造事件。当 root 正在发出 `wait_agent` 事件、
Child 同时开始首个工具时，两边可能编码出相同 sequence；先进入 durable lane 的 mutation 成功，后一个收到业务 `conflict`。
Child 随后被终止并投影成 `PROVIDER_BINDING_DRIFT`，或者整个 Run 进入 `PERSISTENCE_UNAVAILABLE` 恢复。

这个问题不是模型执行、Sandbox 或文件写入需要互斥，而是一个共享持久事件流必须有唯一的 sequence 分配顺序。

## 决策驱动因素

- root 与 Child 模型和工具仍要并发执行，不引入 Agent 级独占权；
- Attempt 的公开事件 sequence 必须严格单调且不能冲突；
- Child 独立 Rollout 与 mailbox 语义保持不变；
- `tool.started` 持久化屏障仍必须先于 Sandbox 准备和副作用许可；
- 失败后队列要可继续 drain，不能因一个 rejected Promise 永久污染后续清理。

## 备选方案

### 方案 A：root 与 Child 共用 Run 事件编码队列

所有需要写入 Attempt `run_events` 的模型/工具事件先进入同一 Promise 队列，在前一事件提交并更新
`nextEventSequence` 后再编码下一事件；数据库 mutation 继续由 durable lane 串行。

优点是改动局部，直接建立 sequence 分配的单一顺序，不影响模型和工具并发。缺点是一个事件持久化延迟会短暂阻塞同一
Run 的后续公开事件编码。

### 方案 B：在 durable lane 内统一重写事件 sequence

可保留多个生产队列，但需要重构通用 `applyMutation`，在命令摘要计算前重写全部事件及幂等键，并处理多事件 mutation、
readback 和诊断副本的一致性，影响范围更大。

### 方案 C：为每个 Agent 建立独立 Run event stream

可以取消共享 sequence，但 UI、SSE cursor、Attempt receipt 和恢复协议都要升级为多流合并；当前独立 Rollout 已承担模型
上下文隔离，不值得为公开事件再引入一套兼容协议。

## 选择

采用方案 A，并固定以下边界：

1. root Agent 事件与所有 Child `tool.started`/`tool.completed` 共享 RunWorker 的 `eventChain`；
2. 事件进入共享队列后才读取 `context.nextEventSequence`、生成幂等键并提交 mutation；
3. Child 工具事件调用方仍收到自己的 persistence Promise，以维持 started gate 和失败中止语义；
4. Child persistence Promise 的失败会关闭事件入口，但共享队列尾部转换为 fulfilled，允许已授权清理与最终 drain 退出；
5. Child 独立 Rollout、模型执行、Sandbox 工具执行和 mailbox 不进入该队列，继续并发运行。

## 理由

冲突发生在 sequence 编码阶段，而不是数据库执行阶段。只串行数据库 mutation 还不够，因为命令已经携带了旧 sequence。
共享事件编码队列把唯一的内存 sequence 状态和唯一的持久 Run event stream 对齐，同时不扩大到 Agent 执行或 Sandbox
写入互斥，符合共享 Sandbox 下并发协作的目标。

## 影响

### 正面影响

- root 发出 `wait_agent`/消息事件时，Child 首个工具事件不再因重复 sequence 被拒绝；
- Run event、effect invocation 和工具许可仍保持 started 先行的原子生命周期；
- 不影响 Child 独立上下文和独立 Rollout。

### 负面影响与成本

- 同一 Run 的公开事件持久化是单队列，某次数据库延迟会增加后续事件可见延迟；
- 新增 Agent 事件来源时必须复用该队列，不能自行维护 Attempt sequence。

### 安全、数据与运维影响

不扩大 Tenant、Sandbox 或工具权限，不新增字段和迁移。既有事件数据无需修复；部署需要重启 Agent Worker。

## 验证

- RunWorker 测试在 Child 两个 `tool.started` 之间插入 root `thinking.started`，验证交错事件均成功持久化、两个工具许可均
  正常签发且 Child final answer 成功交付；
- 完整 RunWorker 单元测试覆盖 root 事件、Child 工具生命周期、取消、恢复和清理；
- 开发 API 真实 Run 让 root 立即 `wait_agent`、Child 同时 write/read，共享 Sandbox 文件内容和 mailbox 最终结果均成功。

## 可逆性与回退

代码可直接回退，不涉及数据转换；回退后并发窗口会重新暴露重复 sequence 和恢复失败。若临时回退，应关闭 SubAgent 或
避免 root 在 Child 执行期间继续产生模型事件，但这只能降低概率，不能提供正确性保证。
