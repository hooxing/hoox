# ADR-20260828163752：附件触发的 Sandbox 准备与首个模型请求并行

- 状态：已接受
- 日期：2026-08-28
- 决策者：Runtime 维护者
- 关联：ADR-0092、ADR-0095、ADR-0122
- 替代关系：部分替代 ADR-0092 中“非直送附件必须在 Provider 请求前完成 Sandbox 准备”的时序结论；不改变按需获取、single-flight、Thread Sandbox 生命周期、工具持久化前驱和失败关闭约束

## 背景

ADR-0092 已把无附件纯模型 Run 改为零 Sandbox，并让 Sandbox 工具在真实调用时按需等待执行环境。但文本模型收到附件，或视觉模型无法把全部附件直接传给 Provider 时，`prepareInput` 仍会等待 Sandbox acquire、Workspace materialize 和 ResourceFS 准备全部完成，首个模型请求因此被完整冷启动时间阻塞。

模型并不一定立即调用文件或命令工具。它可能先思考、追问，或者先调用 `skill`、Todo、自动化和 Agent 控制面等不依赖 Sandbox 的工具。继续在模型请求前设置完整准备屏障，会把可以并行的 Provider 推理与 Sandbox 初始化串行化。

## 决策驱动因素

- 首个模型请求不应被附件触发的 Sandbox 冷启动串行阻塞；
- 非 Sandbox 工具必须能够在准备期间直接执行；
- `exec_command`、`read`、`edit`、`write` 与 `deliver_file` 等 Sandbox 工具必须在数据面 ready 后才执行；
- 同一 Run 仍只能创建或复用一个完整准备任务；
- 后台准备不能产生未处理拒绝，也不能越过 Session 收口后继续修改或清理 Sandbox；
- acquire、materialize、ResourceFS、租约和 cleanup intent 的既有失败关闭语义必须保留。

## 备选方案

### 方案 A：继续在 `prepareInput` 中等待完整准备

生命周期最简单，但首个 Provider 请求继续承担全部冷启动延迟，无法利用模型推理时间。

### 方案 B：所有 Run 都在模型请求前后台预热 Sandbox

可以覆盖没有附件但随后调用工具的请求，不过会重新让问候、解释和普通文本生成消耗 Sandbox 配额，违背 ADR-0092 的按真实需求获取原则。

### 方案 C：附件只启动准备，依赖工具和 Session 收口分别设置等待屏障

非直送附件在 `prepareInput` 中启动 single-flight 准备但不等待。模型请求和非 Sandbox 工具立即继续；Sandbox 工具在既有 durable `tool.started` 前驱之后等待同一 Promise。若整个模型循环没有触发 Sandbox 工具，Session 仍在 prompt 收口前排空准备任务，避免终态清理与仍在进行的 acquire/materialize 竞态，并保留附件准备失败时的既有失败关闭行为。

## 选择

采用方案 C：

1. 支持直接视觉输入且成功加载全部附件时继续零 Sandbox，不启动后台准备。
2. 存在未直送附件时，`prepareInput` 立即调用 `ensureSandboxReady(reason=attachment)` 启动准备，并马上为 Promise 注册拒绝处理，但不等待其完成。
3. 模型许可与 Provider 请求随后直接发起。准备期间，`skill`、Todo、自动化和 Agent 控制面等不依赖 Sandbox 的工具不读取该 Promise。
4. Sandbox 工具继续在合法 `tool.started/tool_call` 持久化后调用 `ensureSandboxReady(reason=tool)`；Run Worker 的 single-flight 使它等待附件已经启动的同一准备任务，ready 后才签发短时工具许可并执行，工具结果再返回模型。
5. `controller.prompt` 成功收口后，Session 必须等待附件准备完成再向 Run Worker 返回；若 Provider 或工具循环先失败，Session 也要观察该 Promise 的结束，但保留原始错误作为主失败。
6. 准备失败、Workspace 冲突、ResourceFS 不可用、租约丢失和 cleanup intent 持久化失败继续沿用既有稳定错误码与清理协议。
7. 没有附件的 Run 不主动预热；首次 Sandbox 工具调用仍按 ADR-0092 在工具边界启动准备。

## 理由

该方案只重排已有附件准备与模型请求的等待顺序，不引入意图分类器，也不改变工具能力清单。模型推理、非 Sandbox 工具执行可以和冷启动重叠；真正依赖文件系统的工具仍通过同一个 readiness Promise 获得严格屏障。Session 收口排空后台任务则保住了 Sandbox 生命周期所有权，避免 Run 已终态而准备协程仍在写 Workspace 或创建远端资源。

## 影响

### 正面影响

- 带普通附件的请求可以更早发起首个 Provider 请求；
- 模型先思考或先调用非 Sandbox 工具时，其耗时与 Sandbox 准备重叠；
- Sandbox 工具不会在 acquire、materialize 或 ResourceFS 未完成时执行；
- 直接图片、无附件零 Sandbox、single-flight 和短时许可顺序保持不变。

### 负面影响与成本

- 即使模型最终不调用 Sandbox 工具，带非直送附件的 Run 仍会完成已经启动的准备，并在 Session 收口时等待其结束；本决策优化首个模型请求时延，不把附件契约改成可忽略的提示。
- SessionFactory 需要显式观察后台 Promise，并区分正常收口与原始 Provider 错误，控制流比同步准备更复杂。
- 没有附件但随后调用 Sandbox 工具的请求仍会在首次工具调用处承担完整冷启动时间。

## 验证

- Pi Worker 回归测试使用阻塞的 Sandbox acquire，证明文本模型附件请求能在准备未完成时进入 Provider；
- Skill 工具回归测试证明附件准备尚未完成时，非 Sandbox 工具不会等待，后续 `exec_command` 才消费同一准备结果；
- 既有工具循环、single-flight、附件直接图片、Sandbox 故障与 Workspace 故障测试继续覆盖失败关闭和生命周期收口；
- 执行受影响包测试、typecheck、仓库格式与 lint 检查。

## 可逆性

本变更不修改数据库和持久协议。可以把附件准备恢复为 `prepareInput` 中同步等待；回退只改变新 Session 的时序，不需要数据迁移。回退仍不得改变工具前驱、single-flight 或 Sandbox 终态清理规则。
