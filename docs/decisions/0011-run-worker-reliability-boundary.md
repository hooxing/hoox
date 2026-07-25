# ADR-0009：Run Worker 双栅栏、ExecutionAttempt 与恢复 Saga

- 状态：已接受（2026-07-26 审查后重写）
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M1-05、M2-05、M5-01、M5-02、M5-03
- 替代关系：替代本 ADR 早期将基础设施中断加入 Run 状态机的方案

## 背景

Run Worker 组合了数据库状态、Pi 模型执行、CubeSandbox 外部副作用、Workspace 不可变版本和 Artifact 完成门。队列只能提供至少一次通知，进程可能在任意 `await` 后消失，外部调用也可能“已生效但响应丢失”。因此，Run 不能承担执行器内部恢复细节，单独的 Run claim 或 Workspace lease 也不足以阻止旧 Worker 双写。

## 决策

### Run 与 ExecutionAttempt 分层

Run 严格复用 Domain 已有六态，不新增 `interrupted` 或其他基础设施状态：

```text
queued → running → waiting → running
                 ├→ succeeded
                 ├→ failed
                 └→ cancelled
```

每次领取创建独立 `ExecutionAttempt`，状态为：

```text
claimed → running → waiting
                  └→ finalizing → succeeded | failed | cancelled
claimed/running/finalizing → recovery_required → abandoned | failed
```

Attempt 同时记录阶段 checkpoint：`claimed`、`sandbox_acquired`、`cleanup_intent_persisted`、`model_execution_started`、`model_settled`、`workspace_verified`、`sandbox_settled`、`finalizing`、`finished`。

基础设施不可用、栅栏丢失、Sandbox UNKNOWN 和事件协议拒绝只影响 Attempt；不能把业务 Run 伪造为 failed。普通 Worker 永远不能直接重领 running Run。恢复协调器必须等双租约过期，再根据 Attempt checkpoint 决定安全失败、人工恢复或放弃；一旦到达 `model_execution_started`，不得自动重跑可能含工具副作用的模型轮次。

### 统一双栅栏事务能力

所有持久副作用统一经过 `ExecutionPersistencePort.mutate`，每个命令都携带：

- tenant、thread、run、rootRun、workspace、baseRevision 的完整复合 scope；
- Run claim token、单调 epoch、expiresAt；
- Workspace writer rootRunId、单调 epoch、expiresAt；
- Attempt expected version、操作幂等键、事件 sequence 高水位。

生产实现必须在同一个数据库事务中，用数据库时钟校验两组租约仍有效，再原子写入事件、Outbox、Attempt、RolloutProjection、WorkspaceRevision 和 Run 状态。应用进程计算的时间不能作为租约有效性的依据；应用只提交 lease duration，deadline 由数据库计算。

heartbeat interval 必须小于 lease TTL 的一半。任一栅栏失效后，旧 Worker 只能中止内存 Session 和做不带业务写入的 best-effort 清理，不能写事件、Revision 或 Run 终态。

### WorkspaceRevision 与 Run 终态

Workspace verifier 只返回 revisionId、objectKey 和 SHA-256 digest 候选，不返回可伪造的 `verified: true`。Worker 使用 Domain `prepareWorkspaceRevision` 生成不可变 Revision 和 CAS 条件；持久层再次比较完整 scope、base revision、lease epoch 与数据库时钟。

waiting checkpoint 和 success checkpoint 均由一次 `mutate` 原子完成：

- WorkspaceRevision（若内容有变化）；
- Run `waiting` 或 `succeeded`；
- Attempt 对应状态和阶段；
- 事件高水位、RolloutProjection 和双栅栏释放。

因此不存在“Revision 已提交但 Run success 丢失”的可见半状态。若事务已经提交但响应丢失，Worker 用操作幂等键调用 `readMutation` 读回结果，禁止盲目重提 Revision。

### Sandbox cleanup Outbox / Saga

Sandbox acquire 返回已登记实例后，Worker 在创建 Pi Session 或启动模型前，必须首先持久化 `sandbox_cleanup` pending intent。清理 Outbox 是事实源：

1. 调用 settle 前持久化 `started`；
2. settle 成功后持久化 `completed`；
3. 结果不确定时持久化 `unknown` 与稳定告警；
4. 调用抛异常时恢复为 `pending` 并保留重试码，不能删除 intent；
5. worker 可在 intent 提交后做同进程低延迟 dispatch，但崩溃恢复和重复消费仍以同一个 Outbox 幂等键为准。

UNKNOWN 不能自动再次 settle 或创建替代 Sandbox。生产 Outbox consumer 通过 registryId 重新取得句柄并执行同一 Saga。create 期间取消或丢栅栏时，返回后绝不启动模型；registry 必须保留创建请求事实，旧 Worker只做 best-effort close。

### Pi waiting 恢复

Pi 的本地 Session 文件不是事实源。Runtime 持久化版本化、限长的 `ControlledRolloutProjection`，其中只允许经过审核的 user/assistant 文本和 checkpointId，不允许 Pi 内部 entry、宿主路径或任意工具结果。

waiting 回答到达后创建全新的内存 Pi Session，把 RolloutProjection 注入受控上下文，再用 `prompt(answer)` 真正启动模型。禁止对空 Session 调 `followUp`。Linux Faux Provider 测试必须证明历史投影和用户回答同时进入真实模型上下文，且只发起一次新模型调用。

### stop / fence 检查规则

每个外部副作用前后都设置 stop point，包括 Sandbox create/connect、Pi Session 创建、模型 prompt、Workspace verify、Artifact 完成门和 Sandbox settle。持久事务本身在 DB 内检查双栅栏；流式事件转换或持久化一旦拒绝，Worker 立即 abort Pi。

取消和超时可以在双栅栏仍有效、Sandbox 已安全收尾后进入 Domain `cancelled`/`failed`。scope mismatch 或基础设施不可用优先释放 claim、写稳定告警并重试；如果持久层本身不可用，则保留 claim 到期，由恢复协调器接管，绝不猜测业务终态。

### 协议、错误和清理

事件和 Outbox 使用 `schemaVersion: 1` 的联合类型，分别限制为 64 KiB。事件 sequence 来自持久高水位；Outbox 使用业务幂等键。上游异常只映射为稳定错误码，不持久化 Provider、SDK 或数据库私有消息。

`finally` 使用独立 Promise 和 `Promise.allSettled` 停止 heartbeat、保留 pending cleanup、取消订阅和 dispose Session，任一步失败不得跳过其他步骤。

## 放弃的方案

### 在 Run 中加入 interrupted

这会把基础设施恢复细节泄漏到产品状态、API 和领域迁移，并绕过 Domain 转移表，因此禁止。

### 队列单消费者或单 claim

无法处理重复投递、租约过期后的旧 Worker 和 Workspace 双写，因此禁止。

### `verified: true` DTO 与分开的 Revision/Run 更新

布尔值没有领域证明能力，分开事务会产生半提交。改为 Domain prepare 命令和统一双栅栏事务。

### 复用 Pi 内存 Session 并调用 followUp

进程重启后 Session 不存在，空 Session 的 followUp 也不会可靠启动模型。改为持久投影和新 Session prompt。

## 影响

- PostgreSQL 适配器必须同时实现 claim、双租约、Attempt、事件、Outbox、Revision 和 Run 状态事务，不能拆成无事务 Repository。
- Sandbox registry/outbox consumer、完整 request_user_input 工具和 PostgreSQL Schema 属于后续实现，但本阶段端口已固定它们的原子性与幂等契约。
- 流式事件逐条事务会产生写放大；后续可以批量，但不能改变 sequence、大小上限和双栅栏边界。
- `expireWorkspaceLease` 只供恢复协调器在 DB 时钟确认过期后使用，生产 Repository 仍需 CAS。

## 验证与实施记录

- 双 Worker 重复投递、Run/Workspace lease 分别到期和跨 Tenant scope；
- Sandbox create 期间双栅栏丢失，确保不启动模型；
- verify 调用前和返回后丢栅栏、Artifact 返回后丢 claim；
- Revision+Run final 事务响应丢失按幂等键读回；
- settle 调用前事务失败、调用后丢 claim、异常和 UNKNOWN；
- 事件持久化不可用、超大 adapter event、Provider 失败、取消和超时；
- waiting checkpoint/resume、受控 RolloutProjection 和 Linux Faux 真模型序列；
- `model_execution_started` 后 crash 只能进入 recovery_required，普通 Worker不能重领。

PG、对象存储、真实 Outbox consumer 和 API 不在本次实现范围；它们必须遵守本 ADR，不能重新引入 Run 基础设施状态或 Pi Session 事实源。
