# ADR-0150：Worker 心跳瞬时持久层故障有界重试

- 状态：已接受
- 日期：2026-08-12
- 决策者：Runtime 团队
- 关联任务/PR：修复 SubAgent 并发执行时偶发 `PERSISTENCE_UNAVAILABLE` 中断
- 替代关系：细化 ADR-0011 的 heartbeat 失败关闭规则，不改变双栅栏与持久事实边界

## 背景

Run Worker 的 heartbeat 经同一 `DurableOperationLane` 调用 `inspectAndRenew`，用于延长 Run claim 和 Workspace writer lease；启用 Thread Sandbox Session 复用时还会续租 Session lease。旧实现对任意一次 `inspectAndRenew` 抛错或 `unavailable`、以及一次 Session renew `unavailable`，立即把当前执行标记为 `unavailable` 并中止模型。

真实故障追踪显示，Root Agent 已可靠持久化两个协作工具结果，Child Agent 也已启动；随后模型流记录了稳定 `PROVIDER` 失败，但同一收尾窗口的一次 heartbeat 暂时不可用覆盖了该业务失败，最终把 Attempt 置为 `recovery_required/PERSISTENCE_UNAVAILABLE`。这会让短暂连接抖动、连接池切换或并发高隔离事务窗口不必要地中断长任务，并向用户显示“运行状态暂时无法可靠保存”。

ADR-0011 要求 heartbeat Promise reject 必须被捕获并最终失败关闭，避免旧 Worker 越过失效栅栏继续副作用；但它没有要求第一次无法访问持久层时立即终止。只要重试仍在同一 durable lane 中、使用最新已接受 fence，并且租约 TTL 留有充足余量，就可以先吸收短暂故障，而不降低双栅栏安全性。

## 决策驱动因素

- 明确的 `fence_lost`、`scope_mismatch`、取消和 Session `lease_lost` 必须立即生效，不能重试后继续；
- 暂时无法访问持久层不能无限等待，也不能让 heartbeat 与普通 mutation 交错使用旧 fence；
- 重试期间不能签发新的外部副作用许可或持久化事件；
- 持续故障仍必须中止 Session，并由恢复状态机接管；
- 不新增配置、公开错误码、数据库迁移或模型可见协议。

## 备选方案

### 方案 A：第一次 heartbeat 不可用立即失败关闭

保持旧实现，安全边界最保守，但会把单次瞬时连接故障放大为整个 Run 中断，并可能覆盖已经形成 durable 事实的真实失败原因。

### 方案 B：在 Worker heartbeat 内对 unavailable 做有界短退避重试

在同一 `DurableOperationLane` 中重新执行完整续租检查，延迟固定为 5、15、45 毫秒，最多额外尝试三次。明确的栅栏、取消或租约丢失结果立即返回；只有抛错、`unavailable` 或 Thread Sandbox renew `unavailable` 进入重试。

优点是保持现有双栅栏、顺序和失败关闭语义，同时吸收短暂基础设施抖动；缺点是持续故障的中止时间最多增加 65 毫秒及事务耗时。

### 方案 C：只在 PostgreSQL Repository 内扩大事务重试

ADR-0124 已处理 SQLSTATE `40001/40P01` 的明确回滚，但连接建立失败、连接池短暂耗尽、网络抖动和 Thread Sandbox lifecycle `unavailable` 不一定表现为这两个 SQLSTATE。只修改 Repository 无法覆盖完整 heartbeat 边界。

### 方案 D：失败后等待下一次周期 heartbeat

会在当前周期结束后重新开放普通 mutation 和副作用许可，无法证明期间 lease 仍有效；也可能让旧 Worker在不确定 fence 上继续执行，因此拒绝。

## 选择

采用方案 B：

1. heartbeat 与模型前后/清理前后的同步 `inspectAndRenew` 检查均在当前 Attempt 的 `DurableOperationLane` 内执行同一有界重试；
2. 首次尝试及最多三次重试均使用当前上下文中的最新 fence，每次成功后立即接受新 expiry；
3. 重试延迟依次为 5、15、45 毫秒，总显式退避 65 毫秒，远小于默认 30 秒 lease TTL；
4. `fence_lost`、`scope_mismatch`、`cancelled` 和 Thread Sandbox `lease_lost` 不重试；同步 stop/fence 检查仍保留既有取消与清理投影；
5. `inspectAndRenew` 抛错或返回 `unavailable`、Thread Sandbox renew 返回 `unavailable` 时重试；
6. 重试耗尽后保持既有行为：设置 `unavailable`、中止 Session，并尝试提交 `recovery_required/PERSISTENCE_UNAVAILABLE`；若持久层仍不可用，则保留 claim 到期，由恢复协调器接管。

## 理由

在 durable lane 内重试意味着任何 Agent 事件、工具许可或终态 mutation 都必须等待 heartbeat 得到明确结果；因此不会在未知 fence 上继续产生副作用。每次重试调用完整 `inspectAndRenew`，存储层仍会重验 claim token/epoch、Workspace root/epoch、Run 状态和 Revision head。明确失权结果立即失败关闭，只有“目前无法判断”的基础设施结果获得很短的恢复窗口。

65 毫秒的固定退避与 ADR-0124 的事务冲突重试预算一致，足以覆盖常见瞬时窗口，又不会显著侵占 lease TTL 或 Run 超时。重试成功后保留原模型/工具结果；重试耗尽后仍采用原恢复语义，不伪造成功。

## 影响

### 正面影响

- 单次续租/同步栅栏检查数据库异常不再直接中断正在运行或正在安全收尾的 Root/Child Agent；
- 已持久化的 Provider 或工具失败不会轻易被一次瞬时 heartbeat 故障覆盖；
- 不改变公开 API、事件 schema、稳定错误码和数据库结构。

### 负面影响与成本

- 持续故障最多延迟约 65 毫秒才触发 abort；
- heartbeat 在重试期间占用 durable lane，普通事件提交会短暂排队；
- 如果基础设施故障持续超过重试预算，用户仍会看到原有恢复提示。

### 安全、数据与运维影响

不扩大 Tenant、模型、工具或 Sandbox 权限。重试不包含 Provider 调用和远端业务副作用，只包含幂等续租与状态检查。部署后需要重启 Agent Worker 进程加载新逻辑。

## 验证

- 单元测试注入第一次 `inspectAndRenew` Promise reject，验证 heartbeat 重试成功、Session 不 abort，稳定 Provider 失败仍收敛为 Domain `failed`；
- 单元测试持续返回 `unavailable`，验证超过三次重试后仍中止 Session，并收敛为 `recovery_required/PERSISTENCE_UNAVAILABLE`；
- 既有测试继续覆盖明确 lease 过期、Thread Sandbox `lease_lost`、冷恢复旧 renew 迟到以及 heartbeat 非重入；
- 执行 Agent Worker typecheck、相关测试、格式与 lint 门禁。

## 可逆性与回退

改动仅位于 Worker 内存控制流和测试，不涉及数据迁移，可直接回退。回退后持久数据仍兼容，但单次 heartbeat 不可用会再次立即中断 Run。
