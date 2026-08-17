# ADR-20260817181138：Thread 定时任务与按需 Sandbox 复用

- 状态：已接受
- 日期：2026-08-17

## 背景

用户需要通过对话创建定时任务，并在工作台查看、暂停、恢复和删除。定时定义不能保存在 Sandbox：Sandbox 是可暂停、可回收的执行缓存，任务定义、触发时间和执行记录必须是数据库事实。

现有 Runtime 已具备 Thread 串行输入、Run Dispatch Outbox、动态 Tenant Worker Assignment、Thread Sandbox pause/resume 与 Workspace revision。新功能应复用这些边界，不能建立第二套 Agent 执行器，也不能跨 RLS 扫描业务载荷。

## 决策

1. 新增 `scheduled_tasks`、不可变 `scheduled_task_revisions`、`scheduled_task_occurrences` 和幂等 `scheduled_task_commands`。
2. 首版任务绑定已有 Thread。Agent 的 `automation_update` 默认绑定当前 Thread；Web 管理页允许从已有任务中选择目标 Thread。
3. 首版支持一次执行，以及 `MINUTELY`、`HOURLY`、`DAILY` 固定间隔 RRULE。复杂 BYDAY/BYHOUR 和 DST 日历规则后续扩展，不能静默近似。
4. 定时任务到期通过现有 `worker_tenant_assignments` 唤醒 Tenant。Worker 在 Tenant RLS 内先形成 occurrence，再调用统一 Thread Input Routing，最终进入既有 Run Dispatch Outbox。
5. Sandbox 继续绑定 Thread。Run 结束后按既有策略立即 pause；保留期内恢复，超期后销毁并从 Workspace revision 冷恢复。定时任务不能要求永久 Sandbox。
6. 首版 `overlap_policy` 接受 `coalesce|skip`，并依靠同一 Thread FIFO 保证不并发写 Workspace；后续根据 occurrence 与 Run 终态指标补充真正的跨周期合并策略。
7. 任务创建和修改每次重新验证 Membership、目标 Thread 和当前 Run fence。删除采用终态 `deleted`，不物理删除审计事实。

## 影响

- 定时任务不会因为 Sandbox 清理而丢失；Sandbox 数量仍由 Thread 活跃窗口和 retention 决定。
- 高频多 Thread 可能产生多个 paused Sandbox，但可以通过后续任务感知 retention、Tenant 配额和依赖缓存优化，不牺牲 Thread 隔离。
- 首版固定间隔 DAILY 按绝对 24 小时推进；不声称完整 RFC 5545 日历语义。

## 验证

- 调度规则单元测试覆盖 RRULE 规范化和下一次时间。
- 持久化测试覆盖幂等命令、RLS、到期 occurrence 和 Worker 唤醒。
- API 和 Web 测试覆盖列表、创建、暂停、恢复、删除以及侧栏“定时任务”入口。
- Pi 工具测试覆盖参数校验、durable observation 和重复调用回放。

## 可逆性

停止注册工具、API 和 Worker consumer 后可停止新触发；已有任务和 occurrence 保留为审计事实。迁移 down 仅允许在确认无保留需求时执行。
