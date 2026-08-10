# ADR-0137：Durable 工具失败保留能力并回传模型自适应

- 状态：已接受
- 日期：2026-08-10
- 决策者：Runtime 团队
- 关联任务/PR：`feat/resilient-user-final-response`
- 替代关系：替代 ADR-0136 的“只回复模式”和 `failed_with_response`；保留其中 Runtime 终态通知与 Web 展示兜底

## 背景

ADR-0136 为了保证失败任务仍有用户可见回复，在 fatal 工具失败形成 durable Tool Result 后清空 Pi Session 的全部工具，再允许模型执行一次纯文本说明。该方案能够回复用户，但把“某一次工具调用失败”错误提升成“整个 Session 不再有任何工具”。

模型可能通过修改参数、改用 `read`/`write`/`deliver_file`/Skill 等其他工具、等待 Worker、缩小任务范围或直接说明失败来恢复。提前删除工具会阻止模型根据真实 Tool Error 自主调整，也让一次 `deliver_file` 或 Todo 持久化失败无关地禁用 Sandbox 与其他能力。

仍需区分两类错误：

1. 工具调用已经形成 durable 失败回执，call/result 配对完整，错误可以安全返回模型；
2. Tool Observation 未落库、副作用许可或 fence 被拒绝，结果未知，继续模型会破坏恢复与副作用不变量。

## 决策驱动因素

- 工具错误应是模型可观察的执行结果，而不是 Runtime 替模型作出的终止决定；
- 同一 Session 的能力清单应保持稳定，避免动态清空破坏模型缓存和行为预期；
- Sandbox 数据面持续故障需要熔断，不能让模型无界触碰不可用后端；
- durable Observation 与外部副作用门禁仍必须失败关闭；
- Worker、Provider 或持久层真正终止运行时，仍应通过 `runtime.notice` 保证用户收到回复。

## 备选方案

### 方案 A：保留只回复模式

实现已有，但会删除所有工具，阻止模型改用其他能力，拒绝。

### 方案 B：完全取消 Sandbox 熔断

模型每次都能重新调用真实 Sandbox，但后端持续不可用时会产生无界请求、延迟和噪声，拒绝。

### 方案 C：能力保留，数据面熔断，错误持续回传

工具始终保留在 Pi Session。前三次 Sandbox 基础设施失败触碰真实后端并形成 durable Tool Error；熔断后继续调用 `exec_command` 时不触碰 Sandbox，但仍形成新的 durable 失败回执并返回稳定 `EXEC_UNAVAILABLE`。其他工具不受该熔断影响。选择本方案。

## 选择

1. 删除 `ToolReportOnlyFailure`、`reportOnlyFailure`、`bindReportOnlyMode`、`setActiveToolsByName([])` 和 `failed_with_response` 协议。
2. `exec_command` 连续三次 Sandbox 基础设施失败后只熔断该 Session 的命令数据面。后续同名调用仍返回 durable `EXEC_UNAVAILABLE`，但不再执行许可或访问 Sandbox。
3. `deliver_file`、Skill、Todo 的 `fatal=true` 表示该次调用不可按原语义直接重试；在失败回执 durable 后，错误 JSON 仍返回模型，不移除任何工具。
4. 工具调用只要形成 durable result，下一 Provider 轮次继续正常开放完整工具清单。模型最终正常 `stop` 时，Run 按正常完成语义收敛；Runtime 不根据工具错误文本代替模型判断任务是否还能完成。
5. Tool Observation 未形成 durable 事实、许可拒绝、fence/取消失效等安全错误仍设置 continuation rejection，下一 Provider 请求失败关闭并由 Worker Runtime 通知兜底。
6. Provider、Worker、Sandbox acquire/settle、Workspace 提交等真正终止错误继续沿用 ADR-0136 的 `runtime.notice` 和 Web 最后一层回复兜底。

## 理由

Tool Error 是 Agent 闭环的一部分。只要调用结果已经 durable，模型拥有继续推理所需的完整事实，Runtime 不应删除与失败无关的能力。Sandbox 熔断仍保留资源保护，但熔断结果本身也以普通 Tool Error 进入模型上下文，因此模型能够选择其他工具或明确告诉用户无法继续。

## 影响

### 正面影响

- 单个工具失败不再导致全部工具消失；
- 模型可根据稳定错误码调整参数、切换工具或说明失败；
- Sandbox 持续不可用时最多触碰三次真实命令数据面；
- 静态工具清单在 Session 内保持稳定。

### 负面影响与成本

- 模型可能在熔断后继续多次调用 `exec_command`，每次都会新增 Provider 轮次和 durable 失败回执；
- Tool Error 后模型若输出失败说明但未显式修改协议终态，Run 会按正常模型完成收敛，当前没有“模型声明业务失败”的独立结构化终态；
- `fatal` 字段不再触发 Session 终止，只保留工具域错误分类意义。

### 安全与数据影响

- 熔断后的调用不签发外部副作用许可、不触碰 Sandbox；
- Observation 未落库和许可拒绝仍禁止继续 Provider，不放宽双栅栏；
- Tool Error 继续使用稳定投影，不向模型或用户泄露上游秘密、堆栈和私有路径。

## 验证

- Pi Adapter：连续三次 Sandbox 基础设施失败后，第四次 `exec_command` 仍在工具清单中并收到 `EXEC_UNAVAILABLE`，真实 Sandbox 只调用三次；fatal `deliver_file` 后工具清单保持不变。
- Worker：同一 Agent 在第四次熔断错误后仍能生成最终回复，Run/Attempt 正常完成；Observation 未知测试仍进入 `recovery_required`。
- 工具单测：deliver_file 与 Todo fatal 错误按“先 durable 回执、后 Tool Error”顺序完成，不触发 continuation rejection。

## 可逆性与回退

无数据库 schema 迁移。可回退本 ADR 对应提交恢复只回复模式；ADR-0136 的 Runtime 通知事件与已有数据保持兼容。

## 实施记录

- 2026-08-10：移除只回复模式，保留工具清单；将 Sandbox 熔断改为仅阻断真实数据面并持续返回 durable Tool Error。
