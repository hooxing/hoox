# ADR-0154：SubAgent 摘要区分首次任务与当前任务

- 状态：已接受
- 日期：2026-08-12
- 决策者：Cube Runtime 维护者
- 关联任务/PR：`fix/subagent-control-contract`
- 替代关系：补充 ADR-0127

## 背景

SubAgent 对话持久化的 `task` 表示 spawn 时的首次任务。`followup_task` 启动后，AgentSummary 仍返回该首次任务，导致父 Agent 无法从 `list_agents` 或 follow-up 回执判断当前 turn 实际执行的任务。Agent Turn 表保存了 prompt，但 Thread 级对话摘要没有保存可跨 Root Run 恢复的最近任务。

## 决策驱动因素

- 首次任务是稳定身份事实，不应被后续 follow-up 覆盖；
- 当前或最近任务必须能跨 Root Run 恢复；
- AgentSummary 字段语义必须明确，不能继续用一个 `task` 同时表示两种事实；
- 不依赖扫描旧 Attempt 的 Turn 表重建当前摘要。

## 备选方案

### 方案 A：覆盖原 task

实现简单，但丢失首次任务和创建意图，不采用。

### 方案 B：每次 list 动态查询最近 Agent Turn

会把 Thread 级摘要依赖到跨 Attempt 查询，增加恢复和索引复杂度，不采用。

### 方案 C：持久化首次任务与当前任务

保留原 `task` 作为首次任务，新增 `current_task`，spawn 时两者相同，follow-up 入队时更新当前任务。

## 选择

采用方案 C。AgentSummary 对外返回 `initialTask` 和 `currentTask`；闲置时 `currentTask` 表示最近一次 turn 的任务，运行时表示当前 turn 的任务。

## 理由

该方案保留稳定身份，同时提供低成本、可恢复的当前摘要。更新与 follow-up 入队处于同一事务，不会展示尚未成功创建的任务。

## 影响

### 正面影响

- follow-up 回执和 `list_agents` 展示真实当前任务；
- 跨 Root Run 恢复后仍保留最近任务；
- 首次任务语义不再与当前任务混淆。

### 负面影响与成本

- 对话表新增一个有界文本列；
- AgentSummary 的旧 `task` 字段被两个明确字段替代。

### 安全、数据与运维影响

迁移把既有对话的 `current_task` 回填为首次任务，不改变历史或工具权限。任务文本继续受 32 KiB 上限约束。

## 验证

- Supervisor 测试验证恢复时分别展示首次任务和上一轮任务；
- follow-up 完成后 `currentTask` 更新且 `initialTask` 不变；
- migration 测试验证回填、非空和长度约束；
- 执行受影响测试与类型检查。

## 可逆性与回退

down migration 删除 `current_task`。回退后首次任务仍保留，但当前任务展示能力丢失。

## 后续工作

- 无。

## 实施记录

- 2026-08-12：迁移在回填期间临时关闭目标表 RLS，并在约束建立后恢复 ENABLE/FORCE，确保跨租户既有行全部得到一致回填。
- 2026-08-12：将 `current_task` 纳入 Runtime 角色列级 UPDATE 白名单，保证 follow-up 可在同一事务推进 turn 序号与当前任务。
- 2026-08-12：修正 spawn 持久写入，使首次任务与当前任务在创建事务中同时落库，并增加 PostgreSQL 集成断言。
- 2026-08-12：增加当前任务持久字段并更新 AgentSummary 契约。
