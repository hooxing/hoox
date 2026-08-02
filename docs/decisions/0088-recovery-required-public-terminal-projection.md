# ADR-0088：recovery_required 的公开终止投影

- 状态：已接受
- 日期：2026-08-03
- 决策者：Runtime 团队
- 关联：ADR-0011、ADR-0014、ADR-0016、ADR-0042、ADR-0045、ADR-0061、ADR-0074
- 替代关系：细化 ADR-0011、ADR-0014 的 Run/Attempt 分层；部分替代 ADR-0045、ADR-0061 中仅凭 Domain Run `status` 决定“仍在执行”和短轮询的结论；细化 ADR-0074 的终态轮询边界

## 背景

Worker 可以在模型已经启动后遇到持久化 UNKNOWN、协议冲突或进程停机。它会在双栅栏仍有效时把
ExecutionAttempt 原子推进为 `recovery_required`、写入告警事实并释放栅栏，Domain Run 则按
ADR-0011 保持 `running`：普通 Worker 不能把不确定的基础设施结果伪造成业务 `failed`，也不能在
`model_execution_started` 后自动重跑可能已经产生工具副作用的模型轮次。

此前公开 Run DTO 只有 Domain 六态。API 因而持续返回 `running`，Web 把它解释成“Agent 仍在执行”，
继续拉取 Run、事件、Artifact、诊断和 Sandbox 状态。Attempt 已在数秒内明确终止后，页面仍会无限显示
动画和累计时长；用户只有主动取消 Domain Run 才能让这种假运行表现停止。这是事实分层没有进入读取面，
不是把 Run 改成 `failed` 就能安全修复的问题。

## 约束与驱动因素

- Domain Run 必须继续保持 queued/running/waiting/succeeded/failed/cancelled 六态；
- 只有 durable Attempt 事实可以否定“仍在执行”，不能从客户端计时、租约猜测或缺行推断；
- `model_execution_started` 后不得自动重领或重放模型与工具副作用；
- 用户取消仍必须来自明确取消命令，基础设施恢复不能伪造 `cancelled`；
- 公开协议需要兼容尚不认识恢复投影的旧客户端；
- Membership、Tenant RLS、Run/Attempt 归属和最新 Attempt 选择必须处于同一受权读取快照；
- Web 一旦观察到终止事实，事件积压、诊断分页或 Sandbox 瞬时态都不能重新武装无界短轮询。

## 备选方案

### 方案 A：由 Worker 或恢复扫描器把 Run 自动改成 failed/cancelled

这样旧客户端无需改动，也能立即得到 Domain 终态。但故障发生在模型或工具副作用之后时，基础设施只知道
“不能证明完整结果”，不知道业务执行失败或用户要求取消。自动写入 `failed`/`cancelled` 会违反
ADR-0011 的事实边界和取消语义。

### 方案 B：恢复协调器自动创建新 Attempt

它可以让 Run 最终自然收敛，但 `model_execution_started` 后重跑会重复尚未能证明结果的工具副作用。
若只对模型前 checkpoint 重跑，又不能解决本次模型后恢复状态的主要错位。

### 方案 C：保持 Domain Run，增加只读公开执行投影

PostgreSQL 在读取 Run 时同时选择其最新 Attempt。仅当 Domain Run 为 `running` 且最新 Attempt 明确为
`recovery_required` 时，Run DTO 追加 `executionStatus: "recovery_required"`。Web 把该覆盖视为“当前没有
Agent 执行”的终止投影并停止所有自动短轮询，但不改写 Domain Run、Attempt、队列或取消事实。

### 方案 D：只让 Web 从 Attempt 事件猜测

无需 API 变更，但事件页可能尚未加载、被分页或因最新 Attempt 切换而重置；其他 API 客户端仍会误判。
事件展示也不应取代 Attempt 表的规范状态事实。

## 决策

采用方案 C。

1. `RunDto.status` 继续逐字投影 Domain Run 六态；新增可选字段
   `executionStatus: "recovery_required"`。该字段是覆盖信号，不是第七个 Domain 状态。
2. `PgRunRepository.get/listByThread` 在原 Membership 与 RLS 查询内用 LATERAL 子查询选择按
   `created_at DESC, attempt_id DESC` 排序的最新 Attempt。只有显式的 `recovery_required` 行且 Run 仍为
   `running` 时返回覆盖；Attempt 缺失、租约过期、数据库不可用或其他状态均不猜测。
3. 字段保持可选以兼容旧响应消费者。旧客户端仍可读取原六态；新客户端必须优先检查
   `executionStatus`，不能仅凭 `status=running` 声明 Worker 活跃。
4. Web 对该投影显示“执行已中断”和“当前没有 Agent 在继续执行”，停止运行计时、动画及活动步骤旋转。
   它在完成本轮受权读取后不再安排下一次短轮询；事件 `hasMore`、模型诊断 `hasMore`、Sandbox
   `pausing/resuming` 和同轮其他读取失败都不能重新启动定时器。
5. Domain Run 仍允许用户通过既有 DELETE 取消；按钮改称“结束本次运行”以表达这是用户选择，而非正在
   向 Worker 发送停止信号。取消成功后公开覆盖消失，Run 真实进入 `cancelled`。本决策不自动激活排队的
   Follow-up，也不把恢复事实伪装成业务失败。
6. 不新增恢复扫描器、迁移或后台重放。后续若要提供人工恢复、显式放弃或原子“结束并重试”命令，必须
   另行定义授权、幂等回执和 Thread 单写者推进协议。

## 理由

Attempt 已经是规范、持久且受双栅栏保护的执行事实；把它安全投影到读取面即可消除假运行，无需创造第二个
可写状态机。查询与 Run 授权在一条 SQL 中完成，避免先读 Run、后按裸 Attempt 查询产生跨租户面或快照
错位。可选覆盖保留现有 DTO 的六态兼容性，同时让升级客户端获得明确的终止信号。

该选择刻意不自动写 Domain 终态。它解决“页面只有取消后才停止假运行”，但保留恢复不变量：若用户希望
释放仍为 `running` 的业务 Run 或推进后续队列，仍须执行明确的结束操作；系统不能替用户虚构取消或失败。

## 影响

### 正面影响

- Attempt 进入 `recovery_required` 后，API 与 Web 不再声称 Agent 仍在执行；
- Web 不再因为 Domain Run 长期 `running`、诊断积压或 Sandbox 瞬时态无限轮询；
- Domain、取消、幂等、双栅栏和外部副作用不变量均不改变；
- 无数据库迁移，现有 durable Attempt 立即可以被新读取面识别。

### 负面影响与成本

- 同一 DTO 可同时出现 `status=running` 与 `executionStatus=recovery_required`；客户端必须理解字段优先级；
- 旧客户端忽略新字段后仍会保留旧行为，这是添加式兼容的代价；
- 停止自动轮询后，迟到的 cleanup/Sandbox 对账结果要到刷新或其他显式读取时才显示；
- 本决策不自动释放业务 Run，排队 Follow-up 的推进仍依赖明确取消或未来受审恢复命令。

### 安全、数据与运维影响

- API 不公开 Attempt ID、checkpoint、Worker 错误码、租约或内部告警，只公开最小终止覆盖；
- 查询继续复用 Membership、Tenant RLS 和 Run 归属，不增加跨租户枚举面；
- 运维仍需监控 `recovery_required` 积压。本投影是用户可见收敛，不替代人工恢复协调和告警处理。

## 验证

- 协议和 Mapper 测试证明覆盖可选、值域封闭，且 DTO 往返不会把 Domain `running` 改成第七态；
- API 测试稳定构造 Domain Run=`running`、公开执行投影=`recovery_required`，验证单 Run 和最新 Run
  窗口均返回覆盖，显式取消后返回真实 `cancelled` 且移除覆盖；
- PostgreSQL 集成测试复现模型已启动后的恢复：原始表保持 Run=`running`、Attempt=`recovery_required`，
  同一受权 Repository 读取返回终止覆盖；
- Web 组件测试证明不显示运行动画或累计时长；定时器测试即使诊断仍有后续页，十二秒后也不发生第二次
  Run 读取；
- 执行协议、API、Web、PostgreSQL 相称测试以及完整 `pnpm check`。

## 可逆性

该改动不写新数据，可通过停止返回可选字段并恢复 Web 判定回退。回退不会改变已有 Run/Attempt，但会重新
出现假运行和无界轮询。已经存在的 `recovery_required` Attempt 必须保留，不能为回退而删除或改写。
