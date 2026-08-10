# ADR-0136：失败回注 Agent 与 Runtime 用户终态兜底

- 状态：已接受（试验分支；“只回复模式”已由 ADR-0137 替代，Runtime/Web 兜底继续有效）
- 日期：2026-08-09
- 决策者：Runtime 团队
- 关联任务/PR：`feat/resilient-user-final-response`
- 关联决策：ADR-0069、ADR-0094、ADR-0135、ADR-0137

## 背景

当前 Runtime 会如实把工具、Sandbox、Provider、Worker、持久层和 Workspace 异常收敛为 `failed`、`cancelled` 或 `recovery_required`。但是，部分失败发生在模型生成最终正文之前，Worker 只提交 Attempt/Run 终态；页面最终只能显示“执行失败”或“执行已中断”，没有一条位于 Agent 对话区的说明。

其中一类典型故障已经拥有可安全继续所需的 durable 事实：工具失败结果已经落库，但旧实现仍在下一次 Provider 请求入口整体失败关闭。例如 `exec_command` 连续三次 Sandbox 数据面故障、`deliver_file` 的 fatal 发布错误以及部分 Skill/Todo fatal 错误。模型其实可以读取已经持久化的工具错误并向用户解释失败，只是不应再获得工具能力。

另一类故障不能继续模型：Tool Observation 未可靠落库、外部副作用许可被拒绝、双栅栏丢失、持久层不可用，或 Worker 已经停止。此时继续 Provider 调用可能打破 tool call/result 配对、重放未知副作用或越过执行权，因此必须失败关闭；但只要当前 Worker 仍持有可写 fence，就应写入一条安全、固定、用户可见的 Runtime 兜底说明。

## 决策驱动因素

- 用户不应只看到状态徽标而没有任何 Agent 区回复；
- 已形成 durable 工具失败事实时，应优先让同一 Agent 根据真实上下文解释，而不是用 Runtime 猜测工具细节；
- 用户可见回复不能把失败 Run 伪装成成功，工作区和交付物仍以 durable 事实为准；
- Observation、许可、fence 和幂等边界失败时不得为了“回复”而继续不安全的模型轮次；
- 兜底内容不能包含原始异常、命令参数、路径、Provider body、凭据或其他私有诊断；
- 旧数据、旧 Worker 或事件缺口仍应由页面提供最后一层展示兜底。

## 备选方案

### 方案 A：所有异常都转换为普通 Tool Error

模型回复率最高，但 Observation 未落库、许可拒绝或结果未知时继续运行会破坏 durable 配对和副作用安全，拒绝。

### 方案 B：所有异常都立即失败，只在状态栏展示错误

安全边界简单，但继续造成“任务失败却没有回复”的用户体验，且浪费了已经持久化的工具错误上下文，拒绝。

### 方案 C：双通道失败语义

对已持久化的 fatal 工具失败进入“只回复模式”；对不能安全继续模型的故障写 Runtime 终态兜底；页面再为旧数据或事件缺口提供展示兜底。无论哪条通道，Run/Attempt 保留真实失败状态。

## 选择

选择方案 C，并采用以下协议：

1. **只回复模式**：当 fatal 工具失败已经形成 durable tool result 时，Pi Session 立即调用 `setActiveToolsByName([])` 移除全部工具。下一轮 Provider 仍使用同一 Session 和已有上下文，但只能生成面向用户的文字说明，不能继续副作用。
2. Sandbox 命令数据面连续三次基础设施失败后进入只回复模式；`deliver_file`、Skill 和 Todo 的 `fatal=true` 失败也进入只回复模式。
3. Tool Observation 未落库、外部副作用许可拒绝等不安全失败继续使用硬阻断，不开放下一次 Provider 请求。
4. 只回复模式完成后，Session 返回 `failed_with_response`。Worker 持久化模型正文，但仍将 Run/Attempt 终结为 `failed`；模型回复不改变 Workspace Revision、Artifact 或成功事实。
5. 对没有安全模型回复的 `failed`、`cancelled` 和 `recovery_required`，Worker 在同一终态 mutation 中先追加 `runtime.notice`，再追加 `attempt_state_changed`。通知只使用稳定错误码到固定中文文案的映射，不携带原始异常。
6. 如果模型已经在只回复模式完成说明，Worker 不再追加重复 Runtime 通知；如果模型正文完成后 Workspace 验证/提交又失败，Worker 仍追加 Runtime 通知以纠正模型的乐观结果。
7. `run_terminal` Thread Context 同步记录稳定错误码和相同安全文案，使后续恢复可以知道上一 Run 的失败边界；已有通用失败投影保持兼容。
8. Web 将 `runtime.notice` 渲染为已完成的 Agent 回复。对于旧 Worker、旧事件或终态事件缺口，只要页面已知 Run 为 `failed`、`cancelled` 或 `recovery_required` 且没有任何完成回复，就根据最新稳定错误码生成一条展示层兜底，并避免与服务端通知重复。
9. `runtime.notice` 是明确的 Runtime 兜底，不伪装成 Provider 原话；Run 状态、Attempt 状态、Workspace Revision 和 Artifact 状态仍是成功与否的唯一事实来源。

## 无法绝对保证的边界

“任何问题都必须回复”只能在系统仍有至少一条可持久化或可展示通道时成立。以下情况无法由单个 Worker 绝对保证当前 Run 立即出现新回复：

- 数据库完全不可用，终态事件和 Run 状态都无法写入；
- Worker 已丢失 fence，旧执行者依法不得继续写入；
- 进程、宿主机或容器在写入前被强制终止；
- 客户端同时无法读取 Run 状态和事件。

这些情况由 Scheduler/新 Worker 的恢复、数据库恢复后的重试和页面已有状态兜底共同收敛。不得为了提高回复率绕过 fence 或伪造持久成功事实。

## 影响

### 正面影响

- durable 工具失败后，Agent 能利用真实工具错误向用户解释，而不是直接消失；
- Provider、协议、取消、超时、Sandbox、Workspace 和恢复态均获得用户可见的稳定说明；
- 运行仍保留真实失败状态，不会因“有回复”而误报成功；
- 页面兼容旧数据和事件缺口。

### 负面影响与成本

- fatal 工具失败最多增加一次无工具 Provider 调用及其 token、延迟；
- Web 与 Worker 都保留一份稳定错误码文案映射，修改文案时需要同步测试；
- `TOOL_FAILED` 当前统一映射为 Worker `INTERNAL`，后续可按工具域扩展更精细的稳定错误码；
- `recovery_required` 的 Runtime 通知已落库，但 Run 可能仍保持 `running`，客户端必须同时尊重 `executionStatus`。

### 安全与数据影响

- 只回复模式只在失败回执 durable 后开启，不放宽 Tool Observation 和副作用许可门禁；
- 工具列表在当前 Session 内动态清空，不向静态 system prompt 注入 Run 级动态数据；
- Runtime 通知只由稳定码生成，禁止透传异常堆栈、路径、参数和 Provider 私有响应；
- 回复与业务成功事实分离，未提交修改仍不视为成功。

## 验证

- Pi Adapter：Sandbox 连续三次基础设施失败后只调用三次 Sandbox，第四次 Provider 调用无工具并生成说明；fatal `deliver_file` 同样生成说明；Observation 未落库和许可拒绝仍阻断 Provider。
- Worker：只回复模式后模型正文被持久化，Run/Attempt 仍为 `failed`；Provider、事件拒绝、取消和恢复态提交 `runtime.notice`；服务端通知与 Attempt 事件序列连续。
- Web：`runtime.notice` 渲染为完成回复；终态无回复时按错误码生成兜底；已有通知时不重复。
- 工程门禁：执行受影响包 typecheck、定向测试、格式检查、lint 和构建。

## 可逆性与回退

改动不包含数据库 schema 迁移。可回退本 ADR 对应提交，恢复 fatal 工具失败的硬阻断和仅状态栏展示。已写入的 `runtime.notice` 是向前兼容的 `agent_event`；旧客户端会忽略未知事件类型，现客户端可继续展示既有通知。

## 后续工作

- 将 Worker 与 Web 的稳定错误文案抽取为不引入浏览器服务端依赖的共享协议包；
- 为 Skill、Todo、Artifact fatal 失败定义更细的稳定错误码；
- 增加真实 CubeSandbox/Provider 故障注入黑盒测试和“数据库恢复后最终可见回复”指标；
- 监控只回复模式的 Provider 成功率、额外 token 和重复兜底率。

## 实施记录

- 2026-08-09：在 `feat/resilient-user-final-response` 实现只回复模式、Worker Runtime 终态通知和 Web 最后一层兜底。
