# ADR-0127：Thread 级 SubAgent 对话与 Run 级执行

- 状态：已接受
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：SubAgent 跨 Root Run 复用与模型报文隔离
- 替代关系：细化 ADR-0122 的 Agent Thread 生命周期和 ADR-0125 的历史来源；不改变共享 Sandbox、单层子 Agent和 Root Run 最终提交边界

## 背景

现有 `AgentSupervisor` 按 Root Attempt 创建，子 Agent 元数据和历史只存在于该 Supervisor 内存及 Attempt 级控制表中。Root
Run 结束后，下一次用户消息产生新的 Run/Attempt，`list_agents` 无法发现之前的子 Agent，`followup_task` 也会返回
`AGENT_NOT_FOUND`。这与“中断后保留对话”“复用闲置子 Agent”的工具承诺不一致。

产品边界同时要求：Root Run 结束时不能留下仍在运行的子 Agent；子 Agent 只是 Root 完成当前任务的内部执行者，不能成为
脱离 Root 的后台任务。需要把“可复用对话”和“当前执行”拆成两个生命周期。

## 备选方案

### 方案 A：SubAgent 全部绑定当前 Run

Root Run 结束即删除子 Agent 身份和历史。实现简单，但下一次 Root Run 无法继续既有对话，`followup_task` 和
`interrupt_agent` 的长期语义会落空。

### 方案 B：SubAgent 对话与执行都跨 Run 存活

Root Run 结束后允许子 Agent 继续运行。它会破坏 Root 对 Sandbox、取消、Workspace 最终提交和成本的所有权，不符合内部
协作者定位。

### 方案 C：对话属于主 Thread，执行属于当前 Root Run

保存子 Agent 的稳定身份、固定工具清单和已完成历史；每次 follow-up 在当前 Root Run 中创建新的 Agent Turn。Root 终态前
必须 drain 活跃子 turn，取消或失败时级联中断；下一次 Root Run 只恢复闲置对话，不恢复进程、Session 或未完成 turn。

## 选择

采用方案 C，并固定以下不变量：

1. `runtime_subagent_conversations` 以 `(tenant_id, thread_id, agent_thread_id)` 保存可复用对话，包含 canonical path、首次任务、
   `fork_turns`、全局 turn 序号、已完成历史及摘要。
2. `runtime_agent_threads`、`runtime_agent_turns`、mailbox 和 command 继续属于当前 Attempt。Root 初始化时把同一主 Thread 的
   持久对话物化为当前 Attempt 的闲置控制面节点。
3. `spawn_agent` 在同一事务中创建 Thread 级对话、当前 Attempt 子 Agent 节点、首个 turn 和幂等命令。Agent ID 由主
   Thread、Root Run 和 spawn command 派生，不再由 Attempt ID 派生。
4. `followup_task` 可在后续 Root Run 中复用对话，但同一 Agent 同时最多一个活动 turn；工具清单沿用创建时的固定 manifest。
   需要其他工具时必须新建子 Agent，禁止在 follow-up 中调整。
5. Root 正常完成前等待所有子 turn 结束；Root 取消、失败、fence 丢失或 Worker 停止时中断全部活动子 Session。任何情况下
   都不允许 Root 已终态而子 Agent 仍在后台运行。
6. 只有 `completed` turn 可以原子提交新的可复用历史。`interrupted`、`failed` 和进程中断不写入部分 assistant/tool 历史，
   后续 follow-up 从上一次完整历史继续。
7. `send_message` 只向当前正在运行的子 Agent steer，不为闲置对话排队；闲置目标必须使用 `followup_task`。`list_agents`
   列出主 Thread 中已保存的对话，`wait_agent` 只等待当前 Root Run 的 mailbox。
8. 子 Agent 模型请求和响应继续使用独立 Pi Session。开发镜像写入
   `model-wire-traces/<run>/<attempt>/subagents/<agent>/<turn>/`；Root 目录只保存 Root 请求体，Root 模型上下文只获得协作
   工具调用及其有界结果，不注入子 Agent 内部请求、思考或工具轨迹。
9. Root 与子 Agent 共享同一 RunWorker Sandbox，不增加 Agent writer token、文件版本 CAS 或自动合并器。结构化
   `edit/write` 对同路径重叠调用继续向后到调用返回 `FILE_BUSY`。

## 理由

Thread 级对话提供用户预期的跨消息复用；Run 级执行保留 Root 对成本、取消、Sandbox 和最终 Workspace Revision 的唯一
所有权。把完成历史作为唯一可复用事实，可以避免失败 turn 污染下一次模型请求；固定工具清单避免 follow-up 在不显眼的
位置扩大权限。独立 Trace 路径让排障能够看到子请求体，同时不会把它混入 Root 对话事实。

## 影响

### 正面影响

- 下一次 Root Run 的 `list_agents` 能发现既有子 Agent，`followup_task` 能继续其完整对话；
- Root Run 生命周期仍封闭，不产生孤儿后台 Agent；
- 子 Agent 权限在创建时固定，可审计且不会随 follow-up 漂移；
- Root 与子 Agent 的模型报文在本地诊断目录中物理分离。

### 负面影响与成本

- 新增 Thread 级持久表，并在每次 Root 初始化时物化当前 Attempt 控制节点；
- 对话会持续占用主 Thread 的 Agent 数量配额，目前没有永久删除工具；
- `send_message` 不再接受闲置目标，模型需要明确选择实时 steer 或新 follow-up。

### 安全、数据与运维影响

新表启用并强制 Tenant RLS；Runtime 角色只能插入、读取，以及更新 turn 序号和完成历史。历史大小限制为 32 MiB，工具
manifest 和摘要在创建后不可更新。开发 Trace 目录使用已校验的 Agent/Turn 标识和既有防链接逃逸写入路径；生产环境不创建
本地镜像。

## 验证

- Supervisor 测试覆盖下一次 Root Run 恢复闲置对话、固定工具和历史，并继续增加全局 turn 序号；
- Supervisor 与 RunWorker 测试覆盖 Root drain、级联取消、mailbox 和 Agent 工具持久化屏障；
- 模型报文测试覆盖 Root/Child Session 共享不冲突的模型轮次，以及子 Agent 独立目录；
- 文件工具测试覆盖同一 Sandbox 路径重叠写入返回 `FILE_BUSY`；
- migration 与 Runtime role 测试覆盖新表、RLS、列级更新权限和有数据时拒绝破坏性 down。

## 可逆性与回退

功能代码可回退到 Attempt 级 Agent，但已有可复用对话会丢失可见性，因此 migration down 在表中存在数据时明确拒绝。需要
回退时先停用新 SubAgent、等待全部 Root Run drain，再导出或清理持久对话；表为空后才允许执行 0035 down。
