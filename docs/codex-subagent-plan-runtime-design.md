# Codex Subagent 与 Plan 机制调研及 Cube Runtime 实施方案

> 调研日期：2026-08-05
> Codex 源码基线：`openai/codex@7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4`（2026-08-04）
> 目标仓库：`cubesandbox-agent-runtime`

## 1. 结论摘要

Codex 的 Subagent 不是在一个模型请求里模拟多个角色，而是创建多条真实、独立、可继续对话的 Agent Thread。根 Agent 通过一组控制面工具创建、发消息、追加任务、中断、列举和等待子 Agent；每个子 Agent 有自己的上下文、模型调用、工具循环、Rollout 和状态，结果通过父 Agent 的 mailbox 回传。并发上限、父子路径和持久化图共同约束整棵 Agent Tree。

Codex 中名为“Plan”的机制实际包含三个彼此独立的概念：

1. **Plan Mode**：一种 Collaboration Mode，依靠稳定的 developer instruction、工具可用性和客户端交互约束模型先调研、澄清，再给出可执行方案。
2. **Proposed Plan**：模型最终输出的 `<proposed_plan>` 标记块，由流式解析器从普通正文中提取并以专用 UI 展示。
3. **`update_plan`**：Default Mode 中更新执行清单的轻量工具；它不是 Plan Mode 的状态机，并且在 Plan Mode 中被明确拒绝。

当前 Cube Runtime 已有 `AgentTree` 和 `Plan` 领域对象，但它们只在领域测试中使用，尚未接入 Worker、PostgreSQL、Pi Adapter、API 或 Web。真实运行路径仍是“一个 Attempt、一个 root Rollout、一个 Pi Session、一个 `modelCompleted` 状态”。数据库迁移甚至明确限制每个 Attempt 只能有一个 `root` Agent Stream。因此不能只增加几个模型工具；必须补齐 Agent 控制面、持久化图、多 Session 调度、Agent 级副作用身份、mailbox 和恢复协议。

推荐顺序是：

- 先实现 Plan Mode 与 `request_user_input`，验证“模式快照—能力清单—持久 waiting—专用 UI”闭环。
- 再实现**只读 Subagent**，默认最多 4 个并发 Agent（含 root），MVP 最大深度为 1。
- 最后才开放可写 Subagent；每个可写子 Agent 必须使用隔离 Workspace/Revision，并经过显式合并，不能并发写同一个 `/workspace`。

## 2. Codex Subagent 是如何实现的

### 2.1 模型看到的是控制面工具

Codex V2 向模型注册以下工具：

| 工具 | 语义 |
|---|---|
| `spawn_agent` | 创建子 Agent Thread，可选择角色、模型、推理强度和上下文 fork 方式 |
| `send_message` | 向已存在的 Agent mailbox 投递消息，不主动启动新 turn |
| `followup_task` | 复用已存在的 Agent，并在空闲时启动新 turn |
| `wait_agent` | 等待当前 Agent mailbox 活动、用户 steer 或超时 |
| `interrupt_agent` | 中断目标 Agent 当前 turn，但保留 Agent Thread |
| `list_agents` | 返回当前 Agent Tree 中的路径与状态 |

`spawn_agent` 的 `fork_turns` 支持 `none`、`all` 或最近 N 个 turn。未显式覆盖时，子 Agent 继承父 Agent 的模型、推理强度、沙箱、审批策略和运行环境。V2 默认并发槽位是 4，包含 root 本身。

这组工具只是模型协议入口。真正的权限、并发、状态与持久化由 Runtime 控制面实现，模型不能自行伪造一个 Agent。

### 2.2 一个 Subagent 是一条真实 Thread

Codex 为每个子 Agent 创建独立的 Codex Thread，而不是只启动一个异步函数。所有 Agent 共享一个 session-scoped `AgentControl`，其中包含：

- `AgentRegistry`：维护 canonical path、Thread ID、昵称、状态与总数；
- `AgentExecutionLimiter`：限制同时运行的 Agent 数；
- `V2Residency`：按容量延迟加载或逐出不活跃子 Thread；
- `RolloutBudget`：限制整棵树的模型消耗；
- 指向全局 `ThreadManager` 的弱引用：负责创建、恢复和投递 Thread 操作。

创建时先通过 RAII reservation 原子预留并发槽、Agent 名称和路径，成功后才提交；任何中途失败都会自动释放预留，避免“幽灵 Agent”占用配额。

```mermaid
flowchart LR
    Root["Root Agent Thread"] -->|"spawn_agent"| Control["共享 AgentControl"]
    Control --> Registry["AgentRegistry + 并发限制"]
    Control --> ChildA["Child Thread A"]
    Control --> ChildB["Child Thread B"]
    ChildA --> RolloutA["独立 Rollout / Context"]
    ChildB --> RolloutB["独立 Rollout / Context"]
    ChildA -->|"FINAL_ANSWER mailbox"| Root
    ChildB -->|"FINAL_ANSWER mailbox"| Root
```

### 2.3 上下文 fork 不是简单复制数组

Codex 创建子 Thread 时可以不继承上下文、继承完整历史，或只继承最近 N 个 turn。完整/N-turn fork 会处理：

- 过滤不应复制的 Agent 间消息与临时 usage hint；
- 保留压缩后的有效上下文语义；
- 正确替换子 Agent 的 developer instruction；
- 记录父 Thread、父 turn 和 `spawn_agent` call ID；
- 将 spawn edge 写入持久化 Agent Graph。

因此 fork 是“从持久 Rollout 构造一个新的合法 Thread 历史”，不是对当前 Provider message 数组做浅拷贝。

### 2.4 消息、完成通知与等待

Codex 将 Agent 间通信表示为 `InterAgentCommunication`，其中 `trigger_turn` 区分两种行为：

- `send_message`：只入 mailbox，`trigger_turn=false`；
- `followup_task`：入 mailbox，并在目标空闲时触发新 turn，`trigger_turn=true`。

子 Agent 每个终止 turn 都会给直接父 Agent 发送一个固定信封，包含 `Message Type: FINAL_ANSWER`、task path、sender 和 payload。这里“Completed”表示这一次 turn 完成，并不意味着 Thread 永久终止；之后仍可用 `followup_task` 复用同一 Agent。

V2 的 `wait_agent` 不是循环查询所有子 Agent 状态。它订阅父 Agent 的 InputQueue 活动，在收到 mailbox 消息、用户 steer 或超时时返回。这一点同时减少轮询负载，并允许用户输入及时打断等待。

### 2.5 状态、持久化与恢复

Codex 的 Agent 状态包括 `PendingInit`、`Running`、`Completed`、`Interrupted`、`Errored`、`Shutdown` 和 `NotFound`。Agent Thread/Rollout 和父子边会持久化；运行时可只恢复元数据，真正需要通信或继续工作时再加载 Thread。

关键设计是将两个状态分开理解：

- **Thread 身份与可复用性**：只要没有关闭，Thread 可接收后续 turn；
- **当前/最近 turn 状态**：可以从 `Running` 进入 `Completed`，随后因 follow-up 再次进入 `Running`。

这与本仓库当前 `AgentThreadStatus=completed` 后永久终止的模型不同。

### 2.6 安全边界

Codex 的官方建议偏向并行、读取密集且边界清晰的任务；多个 Agent 同时修改同一文件会增加冲突风险。子 Agent 继承父 Agent 的沙箱和审批策略，角色配置只能进一步调整受允许的模型与指令，不能绕过宿主权限。

对 Cube Runtime 来说还要更严格：现有 Run 只有一个 Workspace lease、一个候选 Revision 和一个最终提交路径。即使工具调用在数据库中串行落库，也无法保证多个 Session 对同一文件系统的逻辑修改可合并。因此首版只能给子 Agent 只读能力。

## 3. Codex Plan 是如何实现的

### 3.1 Plan Mode 是 Collaboration Mode

Codex 的可见 Collaboration Mode 至少包含 `Plan` 和 `Default`。一个 mode snapshot 包含 mode、模型、推理强度和 developer instructions。内置 Plan preset 使用 Medium reasoning，并注入固定的 Plan 模板。

Collaboration Mode 作为 world-state snapshot 的一部分持久化；只有 mode/model 等状态发生变化时，Runtime 才向模型补充对应 developer 片段，避免每轮重复污染上下文。

Plan 模板要求 Agent：

- 先只读探索环境；
- 区分可以从仓库查到的事实与必须由用户决定的意图；
- 在关键选择未确定时使用 `request_user_input`；
- 不修改仓库；
- 只有在方案 decision-complete 时，才输出一个 `<proposed_plan>` 块。

需要注意：从所检查的 Codex 源码看，这个“不修改”约束主要由 developer instruction、工具暴露和客户端模式共同实现。对拥有通用命令工具的第三方 Runtime，仅靠 prompt 禁止写入并不构成可靠安全边界。

### 3.2 `request_user_input` 是一次可暂停的工具调用

Codex 的 `request_user_input` 只允许 root Agent 使用。Plan Mode 中它是阻塞式工具：Runtime 发出结构化问题事件，客户端收集用户答案，再通过 oneshot 通道把结果交回原工具调用，模型继续当前 turn。问题协议支持短问题、互斥选项和推荐项。

Subagent 不能直接向最终用户提问。它应该把缺失信息报告给父 Agent，再由 root 决定是否询问用户。这保证只有一个 UI 和一个 Agent 持有用户交互权。

### 3.3 Proposed Plan 使用流式标签解析

Codex 要求最终方案严格包在独占行标签中：

```text
<proposed_plan>
...Markdown plan...
</proposed_plan>
```

客户端的 `ProposedPlanParser` 能处理标签被拆在多个流式 chunk 中的情况。解析器把普通正文留在 `visible_text`，把 plan start/delta/end 作为专用 segment 输出，因此计划不会和普通 assistant message 重复显示。

Plan turn 结束后，TUI 弹出三个动作：

1. 切到 Default Mode，在当前上下文中发送 “Implement the plan.”；
2. 清空上下文，在新 Thread 中携带计划正文开始实现；
3. 留在 Plan Mode 继续修改方案。

### 3.4 `update_plan` 只是执行清单

`update_plan` 接收 `explanation` 和若干 `{step, status}`，然后发布 `PlanUpdate` 事件，工具结果固定为 `Plan updated`。它没有驱动 Plan Mode，也不负责 proposed plan 的批准与持久化；在 Plan Mode 调用会直接报错。

因此 Cube Runtime 不应把现有 `domain.Plan` 同时用于“方案审批”和“执行进度”。两者的生命周期、事实源和 UI 都不同。

## 4. 当前 Cube Runtime 的实际差距

| 层 | 当前实现 | 与目标的差距 |
|---|---|---|
| Domain | [`agents.ts`](../runtime-ts/packages/domain/src/agents.ts) 有 `AgentTree`；[`execution.ts`](../runtime-ts/packages/domain/src/execution.ts) 有 `Plan` | 两者仅被 domain test 使用；Agent completed 不可复用；Plan 混合了执行清单状态 |
| Worker | [`run-worker.ts`](../runtime-ts/apps/agent-worker/src/run-worker.ts) 每个 Attempt 创建一个 Session，并用单个 `modelCompleted` 跟踪状态 | 没有多 Session supervisor、Agent 级状态、mailbox 或子 turn 调度 |
| Session Port | [`ports.ts`](../runtime-ts/packages/run-contracts/src/ports.ts) 的 `AgentSessionFactoryPort.create` 只接收 Run 级 `ExecutionScope` | 缺少 `agentThreadId`、`agentTurnId`、角色、fork 历史和控制面端口 |
| Rollout | [`0011_runtime_rollout_checkpoint.up.sql`](../runtime-ts/packages/persistence/migrations/0011_runtime_rollout_checkpoint.up.sql) 已把 `agent_thread_id` 放入多数主键 | 同时有 `CHECK (agent_kind='root')` 和 `UNIQUE (tenant_id, attempt_id)`，明确只允许一个 root stream |
| 副作用许可 | `model_start` 每 Attempt 只允许一次；tool call 以 Attempt + call ID 唯一 | 多 Agent/多 turn 会冲突，许可未绑定 Agent 身份 |
| Pi Adapter | [`pi-session.ts`](../runtime-ts/packages/pi-adapter/src/pi-session.ts) 只注册 sandbox、skill、deliver tools | 没有协作工具、Plan 工具、mode-aware capability manifest 或 plan parser |
| Prompt | [`prompt-builder`](../runtime-ts/packages/prompt-builder/src/index.ts) 生成稳定 Harness 和能力摘要 | 没有 Collaboration Mode 模板及 mode snapshot；不得把动态 mode 数据直接拼进稳定系统提示词 |
| Waiting | Worker 已有 `Run waiting → answer → resume` 骨架 | [`pi-session-factory.ts`](../runtime-ts/apps/agent-worker/src/pi-session-factory.ts) 明确标注 `request_user_input` 尚未实现；当前只有单个文本 question |
| API | `CreateRunRequest` 无 collaboration mode；Thread input 的 `mode` 表示 auto/steer/follow_up | 必须新增独立 `collaborationMode`，不能复用现有 routing mode 字段 |
| Web | 只投影对话、工具和当前状态 | 没有 mode selector、Plan card、批准动作或 Agent Tree 面板 |

现有结构里最值得复用的是：Agent 维度已预留在 Rollout 主键中、Run waiting 恢复骨架、稳定 Prompt/Tool Manifest、Attempt/Workspace 双栅栏、Thread Active History 和 durable tool receipt。要替换的是“每 Attempt 只有一个 Agent”的隐含假设。

## 5. 目标架构

### 5.1 不变量

实现时应先固定以下不变量：

1. root 和每个 subagent 都有唯一 `agent_thread_id`、独立 Rollout 和独立 Session。
2. 一个 Agent Thread 可拥有多个顺序执行的 Agent Turn；turn 完成不等于 Thread 关闭。
3. 同一 Agent Thread 同时最多运行一个 turn；整棵树受统一并发 semaphore 限制。
4. 所有子 Agent 继承当前 Run/Attempt 的 tenant、Thread、Workspace 双栅栏和取消信号，不能改变所有权。
5. 子 Agent 的 Provider/tool call ID 在进入持久层前必须加入 Agent/turn namespace。
6. Agent 原始思考和工具日志只写自己的 Rollout；父 Agent 只收到有界 mailbox 消息和 final answer。
7. 只有 root 能请求用户输入、批准 Plan、发布 Artifact 或提交最终 Workspace Revision。
8. MVP 子 Agent 只读；任何写工具、通用 shell、交付工具和外部副作用工具都不进入其 capability manifest。
9. 关闭/取消 Run 必须级联中断所有活跃子 turn；失去 Attempt 或 Workspace fence 后任何 Agent 都不能继续产生副作用。
10. prompt、tool schema 和 collaboration mode 模板保持稳定、版本化，并进入现有兼容性 hash。

### 5.2 运行结构

```mermaid
flowchart TD
    API["API / Scheduler"] --> RW["RunWorker：root Attempt actor"]
    RW --> Supervisor["AgentSupervisor：本 Attempt 控制面"]
    Supervisor --> Store["Agent Graph / Turns / Mailbox"]
    Supervisor --> Limit["并发与预算限制"]
    Supervisor --> RootSession["Root Pi Session"]
    Supervisor --> ChildSession1["只读 Child Pi Session"]
    Supervisor --> ChildSession2["只读 Child Pi Session"]
    RootSession --> RootRollout["Root Rollout"]
    ChildSession1 --> ChildRollout1["Child Rollout"]
    ChildSession2 --> ChildRollout2["Child Rollout"]
    ChildSession1 -->|"durable mailbox"| Store
    ChildSession2 -->|"durable mailbox"| Store
    Store -->|"安全点注入 / wait 唤醒"| RootSession
```

`RunWorker` 继续拥有 Run 终态、Workspace 提交、Attempt fence 和统一 cleanup。新建的 `AgentSupervisor` 只管理 Attempt 内的 Agent Graph、Session、turn、mailbox、并发和子 Agent recovery，不能越过 `RunWorker` 直接提交 Run 或 Workspace。

### 5.3 持久化模型

建议新增规范化表，而不是把整棵 Agent Tree 作为 JSON aggregate 覆盖写入：

#### `runtime_agent_threads`

- 归属：`tenant_id/thread_id/run_id/attempt_id`；
- 身份：`agent_thread_id`、`parent_agent_thread_id`、`canonical_path`、`kind`；
- 配置：`role_name`、model/reasoning snapshot、fork policy、capability hash；
- 生命周期：`open/closed/failed`、version、created/closed timestamps；
- 不可变字段：parent、path、kind 和创建时兼容性身份。

#### `runtime_agent_turns`

- 主键：`agent_thread_id + turn_number`；
- 状态：`queued/running/completed/interrupted/failed`；
- 触发来源：spawn/follow-up/mailbox command ID；
- 记录开始、结束、最终消息摘要和错误码；
- CAS 保证同一 Agent 不会并发启动两个 turn。

#### `runtime_agent_mailbox_messages`

- recipient、sender、单调 sequence；
- kind：`message/followup/final_answer/error`；
- `trigger_turn`、payload、payload digest；
- `queued/injected/consumed` 游标；
- append command 使用 call ID + args digest 幂等。

#### `runtime_agent_commands`

记录 `spawn/send/followup/interrupt` 的 idempotency key、参数 digest 与稳定结果。Worker 崩溃恢复后重复同一模型 tool call 必须返回原结果，不能再创建一个子 Agent。

现有 `runtime_rollout_streams` 需要：

- 将 `agent_kind` check 扩展为 `root/subagent`；
- 删除 `(tenant_id, attempt_id)` 唯一约束，保留 `(tenant_id, attempt_id, agent_thread_id)`；
- 以外键绑定 `runtime_agent_threads`；
- 把 `openRootStreamFromClaim` 泛化为受 fence 约束的 `openAgentStreamFromClaim`；
- 保持 entries/checkpoints/replacements 的 Agent 维度主键不变。

### 5.4 Agent 级执行身份与许可

不要直接把 Agent 字段塞进所有 Workspace 领域对象。建议在 `ExecutionScope` 上增加窄扩展：

```ts
interface AgentExecutionIdentity {
  agentThreadId: AgentThreadId;
  agentTurnId: string;
  agentKind: "root" | "subagent";
}

interface AgentExecutionScope {
  execution: ExecutionScope;
  agent: AgentExecutionIdentity;
}
```

模型启动许可必须从“每 Attempt 一次”改为“每 Agent Turn 一次”；模型 continuation、工具执行和 tool receipt 也必须绑定相同 Agent 身份。建议持久化唯一键至少包含 `(tenant_id, attempt_id, agent_thread_id, agent_turn_id, effect, call_id)`。

Provider 可能在不同 Session 重用 tool call ID，因此 Adapter 应生成：

```text
runtime_call_id = agent_thread_id / agent_turn_id / provider_call_id
```

Provider 原始 ID 仅作为 Rollout body 字段保留，不能作为跨 Agent 事实主键。

### 5.5 `AgentControlPort`

在 `run-contracts` 增加面向 Pi tool handler 的窄端口：

```ts
interface AgentControlPort {
  spawn(input: SpawnAgentCommand): Promise<SpawnAgentResult>;
  sendMessage(input: SendAgentMessageCommand): Promise<void>;
  followUp(input: FollowUpAgentCommand): Promise<void>;
  wait(input: WaitAgentCommand): Promise<AgentMailboxWakeup>;
  interrupt(input: InterruptAgentCommand): Promise<void>;
  list(input: ListAgentsQuery): Promise<readonly AgentSummary[]>;
}
```

语义应与 Codex 对齐：

- `sendMessage` 只排队；
- `followUp` 在空闲时启动新 turn；
- `wait` 监听 mailbox/steer/cancel/timeout，不查询循环；
- `interrupt` 只终止当前 turn，不删除 Thread；
- `spawn` 成功必须同时得到持久 thread、turn、rollout stream 和确定性返回值。

MVP 默认参数建议为：总并发 4（含 root）、最大深度 1、单 Run 最多创建 16 个 Agent Thread、单 mailbox 消息 32 KiB、子 Agent 最终摘要 64 KiB。限额必须是服务端配置快照，工具描述只用于告知模型，不能承担 enforcement。

### 5.6 上下文 fork

首版只支持两种模式即可：

- `none`：子 Agent 只收到任务说明、稳定 Harness、角色 instruction 和必要的只读 Workspace 信息；
- `all`：从父 Agent 已提交的 durable Rollout/Thread Active History 构建 snapshot。

最近 N turn 可以后置。无论哪种模式，都必须复用 Context Policy 生成新的合法历史，并过滤 Agent mailbox、临时工具 usage hint、未完成 tool call 和父 Agent 私有控制消息。禁止直接复制 Pi 内存里的 `state.messages`，因为它不是 Runtime 事实源。

### 5.7 只读 Subagent 工具面

当前 `exec_command` 可通过 Shell 修改文件，不适合作为“只读”工具。推荐新增边界明确的工具：

- `list_workspace`：有界目录枚举；
- `search_workspace`：有界文本搜索；
- 复用现有 `read`：有界文件读取。

首版子 Agent 不注册 `exec_command`、`edit`、`write`、`deliver_file`、artifact、用户输入和任何有外部副作用的工具。Plan Mode root 也使用同一只读工具集。后续若需要只读 shell，应由 CubeSandbox 提供操作系统级只读文件系统和无网络/无进程副作用策略，而不是解析命令字符串做黑名单。

### 5.8 可写 Subagent 的后续方案

可写子 Agent 必须各自工作在从同一 base revision 派生的隔离 Workspace branch 中，产出不可变 candidate revision。root 只接收变更摘要和 candidate identity，再通过显式 merge/rebase 服务合并；冲突必须回到 root 处理。

在实现 branch/merge 协议前，不应允许多个 Session 共享当前 `/workspace` 写权限。数据库中的 tool serialization 不能解决文件内容层面的 lost update。

## 6. Plan Mode 在 Cube Runtime 的实现方案

### 6.1 协议与快照

在 API 中新增独立字段：

```ts
type CollaborationMode = "default" | "plan";
```

它应加入 `CreateRunRequest` 和 `CreateThreadInputRequest`，默认 `default`。现有 `mode: auto|steer|follow_up` 是输入路由语义，必须保留且不能重命名成 Plan Mode。

Run dispatch 时将 collaboration mode、mode template version、工具能力 manifest 和可选 model/reasoning override 固化为 Attempt 输入快照。恢复时必须使用相同快照；配置热更新不能改变正在运行或 waiting 的 Run。

### 6.2 稳定 Prompt 与强制能力策略

在 `prompt-builder` 中加入固定、版本化的 Plan/Default developer template，并把 mode/template version 纳入 prompt compatibility hash。模板中只允许稳定平台文本；tenant、Thread、路径、用户问题等动态数据继续走现有低信任 context entry。

Plan Mode 必须同时做两层限制：

1. developer instruction 说明探索、澄清、decision-complete 和 `<proposed_plan>` 协议；
2. 服务端 capability policy 只创建只读工具，拒绝写文件、交付、发布和通用命令。

第二层是实际安全边界。即使模型忽略 Plan instruction，也拿不到修改能力。

### 6.3 `request_user_input`

扩展当前 waiting 协议为结构化版本：

```ts
interface UserInputRequestV1 {
  requestId: string;
  questions: readonly {
    id: string;
    header: string;
    question: string;
    options?: readonly { label: string; description: string; recommended?: boolean }[];
  }[]; // 1..3
}
```

Cube Runtime 不必复制 Codex 的内存 oneshot。更符合现有恢复模型的做法是：

1. tool handler 持久化未完成 tool call、结构化问题和 waiting checkpoint；
2. `RunWorker` 原子进入 Run/Attempt waiting 并释放活跃 Session；
3. API 持久化用户答案并重新调度；
4. 新 Session 从 Rollout 恢复，补写同一 call ID 的 tool result，再继续模型 turn。

这样进程重启不会丢问题或答案。只有 root 能注册该工具；子 Agent 调用必须形成稳定拒绝回执。

### 6.4 Proposed Plan 事实源

在 Pi Adapter 增加可跨 chunk 的 `<proposed_plan>` parser，并发布专用事件：

- `plan.proposed.started`；
- `plan.proposed.delta`；
- `plan.proposed.completed { planId, markdown, digest }`。

普通 `message.delta` 不再包含 plan block，避免 UI 重复。完成后的方案应写入 `runtime_proposed_plans`，至少包含 thread/run/attempt、version、markdown digest、状态 `proposed/accepted/superseded` 和创建时间。

接受 Plan 必须是幂等命令。建议公开：

```text
POST /v1/threads/{threadId}/plans/{planId}/accept
{ "implementationContext": "continue" | "fresh" }
```

- `continue`：新建 Default Mode implementation Run，并在现有 Thread Active History 后引用已接受 plan；
- `fresh`：新建带 `plan-only` context policy 的 implementation Run，只携带稳定 Harness、用户原始目标和已接受 plan。该能力涉及 Thread Context 分支，应在后续小阶段实现；首版可只提供 `continue`。

Plan markdown 是用户/模型内容，应以引用事实进入 user/custom context，不能拼入系统提示词。

### 6.5 `todo_write` 与现有 `domain.Plan`

当前未接线的 `domain.Plan` 不用于本次功能。本仓库实现独立的 Run 级 `todo_write`：Agent 根据复杂度自主决定是否
使用，首次创建全 pending，之后以完整快照更新 pending/in_progress/completed。Runtime 只校验 Todo 自身一致性，
不把 Todo 变成读取、搜索、修改、执行或交付工具的前置门禁。

每次成功更新发布并持久化 `todo.updated` Run event，Web 在“运行进度”区域投影最新快照；既有工具历史继续在原位置
展示。它不需要独立数据库 aggregate，`run_events` 足以作为本次 Run 的 UI 与审计事实源。若未来需要跨 Run 的项目
计划，再单独设计领域生命周期。完整实施说明见 [Todo Writer Runtime 实现说明](todo-writer-runtime-implementation.md)。

## 7. 按模块的修改清单

| 模块 | 建议修改 |
|---|---|
| `packages/domain` | 将 Agent Thread 身份与 Agent Turn 状态拆分；补 canonical path、父子不变量和可复用 turn；将现有 Plan 改为执行清单，新增 ProposedPlan 独立概念 |
| `packages/protocol` | 增加 `CollaborationMode`、结构化 input request/answer、Plan 事件、Agent Tree 事件、Plan accept API；升级公开 schema 版本 |
| `packages/run-contracts` | 增加 `AgentExecutionIdentity`、`AgentControlPort`、Agent 级 Session create 参数、mailbox/wakeup、Agent 级 permit 与 cancellation 契约 |
| `packages/persistence` | 新增 Agent threads/turns/mailbox/commands/proposed plans 迁移与 repository；泛化 rollout stream；修改 model permit 唯一键和 RLS |
| `packages/prompt-builder` | 增加版本化 Collaboration Mode 模板与 mode-aware capability manifest；升级 prompt version 和恢复兼容 hash |
| `packages/pi-adapter` | 新增协作工具、`request_user_input`、`update_plan`、proposed plan parser；按 root/child/mode 组装不同工具集 |
| `apps/agent-worker` | 抽出 `AgentSupervisor`；把单 Session 状态改为 Agent/turn map；并发运行只读 child；mailbox 安全点注入；级联 abort 与恢复 |
| `apps/api` | 接收 mode snapshot；提交结构化 answer；Plan accept；读取 Agent Tree/Plan 投影 |
| `apps/web` | composer 模式切换、结构化提问、Plan card/接受动作、Subagent 面板；root 对话不混入 child 原始 trace |

实现前必须新增 ADR，因为它会改变 Agent 生命周期、PostgreSQL 事实源、公开 API、工具协议、副作用许可和恢复语义。建议至少拆成两个决策：

1. Agent Graph、Agent Turn、mailbox、多 Rollout 与只读并发边界；
2. Collaboration Mode、`request_user_input`、Proposed Plan 与执行清单边界。

## 8. 分阶段交付

### 阶段 0：协议与 ADR

- 固定术语、状态机、表结构、tool schema、限额、错误码和恢复策略；
- 增加 feature flags：`collaboration_plan_enabled`、`read_only_subagents_enabled`；
- 建立 Agent/Plan 的 protocol contract tests。

### 阶段 1：Plan Mode 闭环

- API mode snapshot 与稳定模板；
- root 只读 capability policy；
- durable `request_user_input`；
- proposed plan parser、持久化和 Plan card；
- `continue` 模式的接受并开始实现；
- Default Mode `update_plan` 执行清单。

这一阶段不需要多 Agent，但能先验证最难复用的 waiting、恢复、mode-aware tools 和 UI 协议。

### 阶段 2：只读 Subagent

- Agent Graph/turn/mailbox/command tables；
- 多 rollout stream 和 Agent 级 permit；
- `AgentSupervisor` 与协作工具；
- `none/all` fork；
- 默认 4 槽、深度 1；
- Web Agent Tree/状态面板；
- 崩溃恢复、幂等和级联取消。

### 阶段 3：隔离写入与合并

- 每子 Agent 独立 Workspace branch/candidate revision；
- root-controlled merge/rebase；
- 冲突事件和 UI；
- 写权限、artifact 和发布权限逐项开放，默认仍由 root 独占最终提交。

## 9. 测试矩阵与验收标准

### 9.1 必测场景

| 类别 | 场景 |
|---|---|
| Domain | Thread completed turn 后可 follow-up；关闭 Thread 不可启动新 turn；父子路径唯一；深度/数量限制 |
| 幂等 | 相同 `spawn_agent` call 重放只得到同一 child；同 key 不同 digest 冲突 |
| 并发 | 两个 spawn 抢最后一个槽只有一个成功；同一 child 不能并发 turn |
| 隔离 | child capability manifest 不含 write/exec/deliver；跨 tenant/attempt/agent permit 全部拒绝 |
| Rollout | root/child sequence 独立；未完成 tool pair 不能 fork；恢复选择正确 agent stream |
| Mailbox | send 不触发 turn；follow-up 触发；final answer 唤醒 wait；steer/cancel 能打断 wait |
| Recovery | spawn 提交后 Worker 崩溃；child 模型完成但通知未消费；过期 lease 下的 running turn 收敛 |
| Plan 安全 | Plan Mode 即使模型请求 write，也没有工具或被服务端拒绝；恢复后 mode/tool hash 不漂移 |
| Parser | 开闭标签跨 chunk、缺失闭标签、多 plan block、标签似是而非、UTF-8 边界 |
| Waiting | question/tool call/checkpoint 原子；答案重放幂等；重启后补齐同一 tool result |
| UI | Plan 不重复进普通正文；root 对话不出现 child 原始 trace；接受 Plan 只创建一次 implementation Run |
| 取消 | root Run 取消或 fence 丢失时，所有 child Provider/工具调用停止且不能提交终态副作用 |

### 9.2 完成标准

只读 Subagent 可视为可发布，至少需要满足：

- 一个 root 能并行启动三个 child，收到三个有 sender/path 的 durable final answer；
- Worker 在任一持久化边界崩溃并重启后，不重复创建 child、不重复调用已确认的工具副作用；
- root Run 终态前不存在活跃 child turn；
- child 无法写 Workspace、发布 Artifact、请求用户输入或获得不属于自己的许可；
- root/child Rollout 都能单独恢复和审计，Thread 用户对话只包含 root 事实与有界 child 汇总；
- 现有单 Agent Run 在 feature flag 关闭时行为、prompt hash 和恢复路径保持兼容。

Plan Mode 可视为可发布，至少需要满足：

- mode 在 API、Run snapshot、Prompt、tool manifest、waiting 恢复和 Web 中一致；
- Plan Mode 只能执行只读能力；
- 结构化问题能跨进程重启完成同一工具调用；
- proposed plan 跨任意流式 chunk 边界都只生成一个持久 Plan；
- 接受操作幂等地创建一个 Default Mode implementation Run；
- `update_plan` 与 Plan Mode 的事实和 UI 完全分离。

## 10. 不建议采用的捷径

- **只增加 `spawn_agent` 工具，然后在内存里 `Promise.all`**：崩溃后无法恢复，工具重放会重复创建 Agent，也无法审计。
- **复用一个 Pi Session 模拟多个 Agent**：上下文、工具 call ID、取消和状态互相污染，不具备真正并行性。
- **复用现有 `AgentThread.completed` 作为永久终态**：无法支持 Codex 的 follow-up 复用语义。
- **把 Plan Mode 等同于 `domain.Plan` 或 `update_plan`**：会混淆方案审批与执行进度。
- **仅用 prompt 禁止 Plan/Subagent 写文件**：`exec_command` 仍可修改文件，安全边界不成立。
- **让多个子 Agent 共享可写 `/workspace`**：会产生无法可靠检测的 lost update。
- **把 child 全量 trace 写入 Thread Active History**：会迅速膨胀 root 上下文，并把内部推理暴露成用户对话。
- **轮询子 Agent 状态实现 wait**：浪费资源且响应 steer 较慢，应等待 mailbox activity/cancellation。

## 11. 参考资料

### 官方文档

- [OpenAI Codex：Subagents](https://developers.openai.com/codex/subagents)
- [OpenAI Codex 源码仓库](https://github.com/openai/codex)

### 本次检查的 Codex 源码

- [多 Agent 工具 Schema](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [V2 spawn handler](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
- [共享 AgentControl](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/agent/control.rs)
- [子 Thread 创建与 history fork](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/agent/control/spawn.rs)
- [AgentRegistry 与 reservation](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/agent/registry.rs)
- [V2 mailbox 驱动的 wait](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
- [Agent 间消息信封](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/session_prefix.rs)
- [Plan Mode 模板](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/collaboration-mode-templates/templates/plan.md)
- [Collaboration Mode presets](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/models-manager/src/collaboration_mode_presets.rs)
- [Proposed Plan 流式解析器](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/utils/stream-parser/src/proposed_plan.rs)
- [Plan 完成后的实现选择](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/tui/src/chatwidget/plan_implementation.rs)
- [`update_plan` handler](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/tools/handlers/plan.rs)
- [`request_user_input` handler](https://github.com/openai/codex/blob/7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4/codex-rs/core/src/tools/handlers/request_user_input.rs)

### 本仓库相关决策

- [ADR-0029：可信 Prompt 与能力清单](decisions/0029-trusted-prompt-and-session-capability-manifest.md)
- [ADR-0030：Runtime Rollout 事实源](decisions/0030-runtime-rollout-checkpoint-fact-source.md)
- [ADR-0063：Thread 单写者与 Follow-up](decisions/0063-thread-writer-and-durable-follow-up-queue.md)
- [ADR-0067：Durable Steer](decisions/0067-durable-steer-and-unified-thread-input.md)
- [ADR-0068：Runtime 持久 Compaction](decisions/0068-runtime-owned-persistent-compaction.md)
- [ADR-0089：当前状态 UI](decisions/0089-conversation-thinking-and-current-status-only.md)
