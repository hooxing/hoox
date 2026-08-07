# ADR-0122：共享 Sandbox 的 SubAgent 控制面

- 状态：已接受
- 日期：2026-08-05
- 决策者：Runtime 团队
- 关联任务/PR：SubAgent 独立对话与共享 Sandbox 实施
- 替代关系：替代 `docs/codex-subagent-plan-runtime-design.md` 中“首版只读、隔离 Workspace 后才可写”的建议；不改变 ADR-0063 的产品 Thread 单写者边界

## 背景

当前一个执行 Attempt 只有 root Pi Session，但 Domain 和 Runtime Rollout 已预留 `agent_thread_id`。目标是在同一个
Run/Attempt 内让 root 通过模型工具下发独立子任务；每个 SubAgent 使用独立模型上下文和 Rollout，完成后只把有界
结果交付 root。SubAgent 与 root 必须看到同一个已经物化的 CubeSandbox `/workspace`，不能为每个 SubAgent 创建新的
Sandbox 或 Workspace branch。

已确认的产品约束是：root 保留当前工具集合并新增协作工具；SubAgent 的工具列表由 root 在 `spawn_agent` 时显式
选择；上下文默认可继承全部历史，也可选择不继承或最近 N 个 turn。共享写入不使用 Agent 级 writer token，不引入
文件版本 CAS，也不建设自动合并器。

## 决策驱动因素

- 子任务探索过程不能持续挤占 root 的模型上下文；
- 子 Agent 读取和修改的必须是 root 当前正在使用的同一 Sandbox 状态；
- 工具能力必须由 Runtime 白名单强制执行，不能只依靠提示词；
- spawn、turn、mailbox 和模型启动必须可审计并受当前 Attempt 双栅栏约束；
- 多 Agent 写同一文件时需要给模型一个可恢复的局部失败信号，但不能把 Workspace 变成全局串行写入；
- 现有单 Agent 路径在功能关闭时保持原行为和工具兼容身份。

## 备选方案

### 方案 A：同一 Run/Attempt、独立 Session、共享同一 Sandbox

RunWorker 继续拥有唯一 Thread Sandbox lease 和最终 Workspace verify/publish；AgentSupervisor 为每个 SubAgent 创建独立
Pi Session、Agent Turn 和 Rollout，并把同一个 `ensureSandboxReady` single-flight 能力传给所有 Session。结构化
`edit/write` 在同一文件的实际重叠窗口内让后到调用立即得到 `FILE_BUSY`。

优点是直接满足共享工作状态和上下文隔离，Sandbox 生命周期与最终提交仍只有一个所有者。缺点是多个 Agent 的
逻辑修改仍可能互相影响；尤其 `exec_command` 可以写文件，Runtime 不解析 shell 命令，因此它不受 `FILE_BUSY`
覆盖。

### 方案 B：每个 SubAgent 独立 Sandbox/Workspace branch

每个子任务从 base revision 派生独立环境，完成后由 root 合并。它能提供强隔离和确定性冲突检测，但需要 branch、
candidate、merge/rebase、冲突 UI 和额外 Sandbox 成本，不符合“共享同一 Sandbox”的产品语义。

### 方案 C：一个 Pi Session 内模拟多个角色

用提示词区分角色，所有历史仍进入同一上下文。实现成本低，但不具备独立上下文、并发 turn、独立取消和独立
Rollout，无法达到 SubAgent 的主要目的。

### 方案 D：共享 Sandbox，但使用 Agent writer token、文件版本 CAS 或自动合并

这能扩大 Runtime 的冲突控制范围，但会让 Agent 并发退化为写入串行，或引入新的文件版本/合并事实源。本阶段
明确不采用。

## 选择

采用方案 A，并固定以下边界：

1. SubAgent 是当前产品 Thread 的内部 Agent Thread，不创建新的产品 Thread、Run、Attempt、Workspace 或 Sandbox
   lease；所有 Session 共享 RunWorker 的同一个 `SandboxSessionRef` 和取消边界。
2. root 注册 `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent` 和 `list_agents`。SubAgent
   不获得这些工具，首版最大深度为 1。
3. `spawn_agent.tools` 必须显式指定（允许空列表），并与服务端可委派集合取交集；当前可委派工具是
   `exec_command/read/edit/write/skill`。
   `todo_write`、`deliver_file`、用户交互和最终 Workspace 发布仍只属于 root。
4. 上下文 fork 支持 `none`、`all` 和最近 N 个 user turn。fork 来源是 Runtime 恢复后的 `ThreadActiveHistoryV1`，
   不是客户端 messages 或对子 Session 内存数组的浅拷贝；创建后父子历史独立演进。
5. Agent Thread 与 Agent Turn 分离。turn 完成后 Thread 处于 idle，可用 `followup_task` 创建新 turn；同一 Agent Thread
   同时最多一个活跃 turn。总并发默认 4，包含 root；单 Attempt 最多 16 个 SubAgent Thread。
6. PostgreSQL 持久化 Agent Thread、Turn、mailbox 和幂等命令；root/child 使用独立 Rollout stream。SubAgent 的每个
   Provider turn 使用 `agent_model_start` 许可，工具 call ID 在进入 Attempt 级副作用表前加入 Agent/Turn namespace。
7. 不设置 Agent writer token，不保存文件版本，不执行自动合并。对相同 Sandbox 对象和规范化路径，结构化
   `edit/write` 只在实际调用重叠时返回 `FILE_BUSY`；不同文件可以并发。`exec_command` 的任意文件写入不做语义分析，
   root 若无法给子任务分配清晰所有权，应不委派该工具或在任务说明中约束范围。
8. Run 终态前必须 drain 或中断全部活跃 SubAgent。最终 Workspace 仍由 RunWorker 对共享 Sandbox 只 verify/publish
   一次，SubAgent 无权直接提交 Revision 或 Artifact。

## 理由

SubAgent 的核心收益来自“独立上下文、按需继承历史、并行探索、向 root 返回摘要”，并不要求独立 Workspace。让
AgentSupervisor 位于现有 RunWorker 双栅栏内部，可以复用当前 Sandbox 物化、心跳、取消和最终提交协议，避免出现
多个 Workspace 所有者。方案 B 与目标语义相反且引入大规模合并系统；方案 C 没有上下文隔离；方案 D 是已明确
排除的复杂度和并发限制。

`FILE_BUSY` 是面向模型的短暂协调信号，不被描述成完整并发正确性证明。它能覆盖最常用的结构化编辑工具，同时
保留不同文件并发。对 shell、外部进程或“先读后很久再写”的逻辑竞态，由 root 的工具选择和任务所有权分配处理。

## 影响

### 正面影响

- root 可以把读取、搜索、实现或验证子任务交给独立上下文，减少内部探索对主对话的干扰；
- 多个 Session 直接共享同一 Sandbox 当前状态，无需复制和合并 Workspace；
- Agent 命令、turn、mailbox、模型启动和工具副作用均有 durable 身份与双栅栏校验；
- root 可按任务最小授权选择子 Agent 工具，能力清单由真实注册工具派生。

### 负面影响与成本

- Provider 并发、token 消耗和数据库 Rollout 写入增加；
- `exec_command` 写文件不受结构化同路径忙碌检测覆盖；
- 子 Agent 在同一 Workspace 上的语义冲突仍需要模型通过任务边界和重试处理；
- 新增迁移、Runtime 角色 ACL、AgentSupervisor、多 Session 取消与新的模型许可类型。

### 安全、数据与运维影响

所有子 Agent 继承 root 的 Tenant、Thread、Run、Workspace、Attempt fence 和 Sandbox capability，不能扩大宿主或租户
权限。新增 `SUBAGENTS_ENABLED` 配置默认开启，可在模型工具协议尚未发布前关闭回退到单 Agent。生产库一旦存在
SubAgent 事实，0034 down migration 会拒绝无损回退。mailbox 和任务正文都有 32/64 KiB 上限，不记录私有思考作为
root 消息。

## 验证

- Domain 测试：Agent Turn 完成后同一 Thread 可创建 follow-up turn；
- AgentSupervisor 测试：工具选择、`none/all/N` fork、mailbox final answer、follow-up 复用和 4 槽限制；
- Pi Adapter 测试：子 Session capability manifest 只包含 root 选择的工具；同路径结构化写入返回 `FILE_BUSY`；
- Migration/ACL 测试：Agent 四张表、RLS、多 Rollout、`agent_model_start` 与 Runtime 角色最小权限；
- RunWorker 测试：所有子 Session 收到同一 `ensureSandboxReady` 结果，终态前 drain，取消时级联 abort；
- 执行格式、lint、受影响包 typecheck 和直接测试。

## 可逆性与回退

模型工具可通过 `SUBAGENTS_ENABLED=false` 停用，现有 root Session 和 Sandbox 路径保持可用。代码回退前必须确认没有
活跃 SubAgent turn。数据库尚未写入 SubAgent 行时可执行 0034 down；一旦已有 SubAgent 审计事实，回退必须先归档或
显式迁移这些事实，down migration 会失败关闭，避免静默删除历史。

## 后续工作

- 增加 Agent Tree 的公开只读投影和 Web 状态面板；
- 增加 Provider/token 的 Run 级预算和低基数指标；
- 观察 `FILE_BUSY`、SubAgent 工具失败和 root 未消费 final answer 的比例，再决定是否需要更强协调工具；
- 在确有需求时单独设计隔离 Workspace branch，不能把它隐式混入本决策。

## 实施记录

- 2026-08-05：新增 Agent Turn 领域对象、Agent 控制面持久化、独立 Rollout、`agent_model_start`、协作工具、共享
  Sandbox AgentSupervisor、历史 fork、mailbox 和结构化文件 `FILE_BUSY`。
