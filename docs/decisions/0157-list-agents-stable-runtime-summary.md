# ADR-0157：list_agents 仅暴露稳定运行摘要

- 状态：已接受
- 日期：2026-08-12
- 决策者：Cube Runtime 维护者
- 关联任务/PR：`fix/subagent-control-contract`
- 替代关系：补充 ADR-0122

## 背景

`list_agents` 已返回 Agent 状态和 turn 序号，但运行中的节点缺少开始时间、已运行时长和已发布 mailbox 序号。父 Agent 难以判断一个任务运行了多久，也无法快速关联 `wait_agent` 游标。当前工具调用属于易失的瞬时事件，可能并行、迟到或在 Worker 崩溃后失真，不适合作为 AgentSummary 的稳定事实。

## 决策驱动因素

- 摘要字段必须含义稳定且不会泄漏工具参数；
- 运行时长只应在 Agent 实际标记为 running 时展示；
- mailbox 序号应与当前 Root Run 的父 Agent 收件流一致；
- 不为展示状态引入新的数据库写放大或迁移。

## 备选方案

### 方案 A：展示当前工具名、参数和输出

瞬时状态不可靠，且参数可能包含敏感数据，明确不实现。

### 方案 B：只保留现有状态

无法判断运行时长和消息进度，不采用。

### 方案 C：增加稳定的运行摘要

运行中返回 `startedAt` 和 `activeForMs`，所有状态返回当前 Root Run 已发布的 `lastMailboxSequence`。

## 选择

采用方案 C。`startedAt` 与 `activeForMs` 仅在 `status=running` 时存在；终态和 idle 不保留活动时长。`lastMailboxSequence` 初始为 0，在子 Agent 向 root 成功发布 mailbox 后单调递增。

## 理由

这些字段直接来源于 Supervisor 控制面和成功持久化的 mailbox 回执，含义清晰且成本低。拒绝展示当前工具可以避免把易失事件误当作可靠状态，也避免泄漏命令参数。

## 影响

### 正面影响

- 父 Agent 可判断运行中的 turn 已持续多久；
- `list_agents` 可直接提供该 Agent 最近发布的 mailbox sequence；
- 不暴露工具参数、输出或内部瞬时轨迹。

### 负面影响与成本

- 开始时间是当前 Worker/Supervisor 的内存事实，Worker 重启后恢复为 idle 对话时不展示；
- `activeForMs` 随读取时间变化，不能作为持久审计时间。

### 安全、数据与运维影响

不增加数据库字段或权限。时间来自 Worker 时钟，并对负时钟漂移钳制为 0。工具内容不进入摘要。

## 验证

- Supervisor 测试使用注入时钟验证 startedAt 和 activeForMs；
- 测试验证 mailbox 发布后 lastMailboxSequence 更新；
- 测试验证终态不再返回 activeForMs；
- 执行受影响测试和类型检查。

## 可逆性与回退

可删除新增摘要字段和注入时钟；无持久数据影响。

## 后续工作

- 不实现当前执行工具展示。
- 不实现工具参数或输出展示。

## 实施记录

- 2026-08-12：增加稳定运行摘要字段。
