# Run 执行与恢复

本文面向修改 Agent Worker、Scheduler、执行持久化端口或恢复路径的开发者，说明一次 Run 从创建、领取、执行到终态的当前不变量。Thread 级上下文与输入顺序见 [Thread 连续上下文](thread-continuity.md)，数据库边界见[持久化与数据库边界](persistence-and-database.md)。

## 状态分层

Run 是用户可见的业务意图，只有六态：

```text
queued → running → waiting → running
                 ├→ succeeded
                 ├→ failed
                 └→ cancelled
```

每次实际领取创建独立的 ExecutionAttempt：

```text
claimed → running → waiting
                  └→ finalizing → succeeded | failed | cancelled
claimed/running/finalizing → recovery_required → abandoned | failed
```

- 基础设施不可用、栅栏丢失、Sandbox 结果未知和事件协议拒绝只影响 Attempt，不能把业务 Run 伪造为 `failed`。
- `recovery_required` 不是第七个 Run 状态。公开 `RunDto.status` 仍逐字投影六态，另以可选 `executionStatus: "recovery_required"` 覆盖信号表达“当前没有 Agent 在继续执行”；Web 据此停止计时、动画和短轮询，用户可以通过取消显式结束该 Run。
- 终态不可逆。修正通过新 Run、新 Attempt、新 Revision 或新 Artifact 表达，不改写已提交事实。

## 创建与投递

- API 在一个 Tenant 事务内按 Membership → Thread → Workspace 锁序重验状态，原子写入 queued Run、不可变执行输入、Dispatch Outbox、[RunAgentSnapshot](agent-definition.md)、`RunSkillSnapshot` 与 API 幂等记录。Thread 创建同样原子写入 Thread、初始 Workspace 与幂等记录，不允许由 API 顺序组合多个 Repository。
- 请求哈希绑定 Thread 与输入；同一幂等键只接受相同请求，不同请求稳定冲突。COMMIT 响应未知时只按原 scope、幂等键与请求哈希读回，禁止再次写入。
- 输入上限为 1,048,576 UTF-8 字节，API 与 PostgreSQL 各自执行。
- Worker 领取时验证固定 Agent 快照，在停止检查、续租及外部副作用许可边界验证 Revision 撤销事实。撤销不是用户取消；Run 在安全停止后失败，不继续发起模型或工具调用。Agent 的长期记忆策略随同 Revision 固定；`platform_default` 在执行时服从该 Run 的平台记忆配置，显式关闭不检索也不摄取。
- Worker 通过 Tenant assignment 发现有待处理工作的 Tenant，用短事务 `FOR UPDATE SKIP LOCKED` 领取 Outbox，并以 generation、claim token 与数据库租约作为确认栅栏。迟到确认是 no-op；Worker 仍负责 Attempt 级幂等。
- 全局 Tenant 发现由独立 Worker Coordinator 数据库身份授权，只能读取 assignment 并更新 claim 栅栏列，不能读取业务表。团队解散会主动终止调度事实，避免撤权后的重试热循环。

并发上限、维护租约和停机顺序见[架构总览](overview.md#run-调度并发边界)。

## 双栅栏与持久化通道

所有持久副作用都经过 `ExecutionPersistencePort.mutate`。每个命令携带：

- tenant、thread、run、rootRun、workspace、baseRevision 的完整复合 scope；
- Run claim token、单调 epoch 和到期时间；
- Workspace writer 的 rootRunId、单调 epoch 和到期时间；
- Attempt 预期版本、操作幂等键和事件 sequence 高水位。

命令以 canonical JSON 计算摘要（排除续租会变化的到期时间）。同一幂等键只接受同一摘要；首次提交、重复提交和响应未知后的读回都返回同一份不可变 receipt，不同摘要稳定返回 `IDEMPOTENCY_CONFLICT`。Receipt 逐项证明 Attempt 版本恰好加一、事件推进量、Outbox、Projection 与 Workspace head 的前后状态；Worker 只有在 receipt 与本地命令完全一致时才推进内存状态。

每个 Attempt 只有一条进程内 `DurableOperationLane`。事件写入、普通 mutation 与读回、外部副作用许可签发与消费、停止检查和续租都按进入顺序串行执行；命令与预期版本必须在进入通道后从最新上下文构造。停止时先停止生产者，再排空通道。

## 外部工具快照与撤销

Worker 通过独立的 Worker Coordinator 连接读取 RunAgentSnapshot 中精确 `toolVersionId` 对应的外部工具版本与密文；共享 Runtime 角色无密文视图或底表读取权限。视图将调用方提交的 claim token、claim epoch 和 Workspace lease epoch 与数据库中当前 Attempt、未过期且未释放的 claim、Workspace writer 和队列执行权事实匹配，不将 Tenant/Run 会话设置当作执行授权。凭据只在 Worker 内解密并交给 Tool Router 的 Transport，不进入 Prompt、Schema、事件或模型可见回执。

MCP 与 HTTP 的一次性许可绑定精确版本；DNS 与目标预检在最终消费之前完成，消费事务再次验证 Run 快照引用与撤销事实，并通过版本行锁与撤销提交建立顺序。先提交的撤销阻止发包；已经消费的调用不能撤回。turn 安全点仍检查撤销。已证实撤销以 `EXTERNAL_TOOL_REVOKED` 停止 Run；快照缺失或不匹配以 `EXTERNAL_TOOL_SNAPSHOT_INVALID` 失败关闭；连接等读取故障进入持久化恢复，不构成撤销证据。

子 Agent 的外部工具授权默认为空，显式授权记录精确版本 ID 并随子 Agent 持久化；恢复或 Worker 重启保持同一集合。跨 Run 复用时取授权版本与新 Run 快照的交集，不得按工具名替换成新版本。

## 重试与未知结果

| 情况 | 行为 |
| --- | --- |
| SQLSTATE `40001` / `40P01` | 以完全相同的签名命令重放整个事务，最多再试三次（5、15、45 毫秒退避） |
| 端口返回 `unavailable` | 同一命令按 25、100、500 毫秒退避，最多共四次；耗尽后进入 `recovery_required` |
| `response_unknown` | 不自动重试写入；在完整 ExecutionScope 下最多四次幂等读回，`not_found` 与 `unavailable` 都不证明未提交 |
| 约束冲突、协议错误、领域拒绝 | 确定性结果，不参与重试 |

Tool Observation 写入结果未知时，用同一个冻结命令和幂等键带退避重放，禁止在重试中改写正文或身份。

Tool 结果只持久化由 Runtime 按工具名与成败固定编码的受控回执。未截断时，回执以 schemaVersion 3 完整内联在 Rollout 或 PTC journal 中，不引用 Blob，恢复时直接从 body 重建并校验。只有观察被截断时，才先提交 stable/trace Blob 保存完整回执，再写 schemaVersion 2 的结果。这样常见路径只需一次 Rollout 事务，不必为几十字节的确定性回执走完整的 Blob 提交协议。

## 外部副作用许可

模型请求、Sandbox 操作和 Artifact 发布等外部副作用必须先持久化意图，再签发并消费一次性许可，随后立即触达外部系统：

- 工具调用先持久化 `tool_call` 意图，确认后才领取并消费许可；许可返回后不插入额外异步持久化窗口。
- `model_start` 要求已提交 `model_execution_started` checkpoint，数据库保证每个 Attempt 最多签发一次。
- 许可绑定身份、期限、调用与参数摘要、双栅栏和 Run 状态；Attempt 版本只允许前进，不允许倒退。
- 许可消费对连接类瞬时故障做有界退避；COMMIT 未知后在同一调用内重新核对所有不可变字段，读到 `consumed_at` 才视为已消费。
- 一旦到达 `model_execution_started`，恢复路径不得自动重跑可能含工具副作用的模型轮次。

## 等待与恢复

- waiting 安全点持久化 scope、Rollout checkpoint、Workspace head、base revision 和可选 Sandbox 身份。Sandbox 只有在 Tenant、Thread、Workspace、base revision、session generation 全部匹配且生命周期明确为 `paused` 时才复用。
- pause、connect、create、materialize 采用 intent/outbox Saga：持有有效租约时先提交意图，外部调用成功后才在同一事务线性化事件、Rollout 与决定事实。任何外部调用结果未知，或进程在意图后崩溃且没有成功证明，都持久化为 UNKNOWN 并停止自动重试。
- 恢复输入只来自 PostgreSQL 与 stable Blob；Pi Session 内存与 Sandbox 内状态不是事实源。
- 普通 Worker 永远不能重领 running Run。普通 claim 明确返回 `recovery_required` 后，Worker 只调用窄恢复入口把过期 Attempt 固化为 `recovery_required`；若该 Attempt 持有 Thread Sandbox 租约，同一事务写入唯一的 terminate effect、把 Session 隔离为 `unknown` 并释放租约，远端关闭交给 Scheduler。

## 取消与失败

- 生产 Worker 为每个活跃 Run 建立有界数据库取消轮询，观察到 `runs.status=cancelled` 后中止当前 Session。数据库探测失败不伪造取消。
- API 先提交 cancelled；持久化层仅凭仍未释放的原 claim 与 Workspace 租约，为原 Worker 开放 `final/cancelled` 窄门，用于标记 Attempt、释放栅栏和推进已武装的 Sandbox cleanup，禁止继续写模型事件、Rollout 或 Workspace。
- Worker 因持久化不可用或停机进入恢复时，在同一终止事务中把普通 Sandbox cleanup 推进为 `started/close` 并释放栅栏，供 Scheduler 领取。
- Cleanup 的 `pending` 只表示已武装的业务事实。消费者在 Tenant RLS 作用域内领取；活动 Run claim、Workspace 租约与活动 Attempt 同时存在时绝不派发。远端调用前先写入调用开始时间，此后崩溃或响应不确定只能收敛为 `unknown`，不自动重复。
- 首要业务失败码进入 Sandbox 清理后，清理 UNKNOWN/FAILED 只写入补偿事实，不覆盖首要失败码。
- Worker OpenTelemetry 是失败隔离的旁路：不等待导出才推进事件、签发许可或提交 Run。队列满、超时及其他导出拒绝均可丢弃；不因遥测发送结果创建恢复记录或重放副作用。Worker 排空在途执行后才有界刷新。

## 工具失败与用户回复

- 工具错误是模型可观察的执行结果，不由 Runtime 替模型终止；同一 Session 的能力清单保持稳定。Sandbox 数据面持续故障由熔断器限制，不让模型无界触碰不可用后端。
- durable Observation、许可、栅栏和幂等边界失败时不得为了“回复”继续不安全的模型轮次。
- Worker、Provider 或持久层真正终止运行时，通过 `runtime.notice` 保证用户收到回复；兜底内容不包含原始异常、命令参数、路径、Provider 正文或凭据。失败 Run 不伪装成成功，Workspace 与交付物仍以持久事实为准。

## 修改检查清单

- 新的持久副作用必须进入 `mutate` 或已有 intent/outbox 协议，携带完整 scope 与双栅栏。
- 新的外部调用必须定义 UNKNOWN 语义和对账入口，不能用普通重试猜测远端结果。
- 新的重试必须证明重放的是同一冻结命令，并给出耗尽后的 `recovery_required` 行为。
- 修改 Attempt 状态机或恢复入口时，同步验证 `tests/integration/postgres-run-worker.integration.test.ts` 等真实 PostgreSQL 黑盒。


## 外部工具结果未知

外部工具请求写出后发生超时、断连或进程中断时，结果属于 UNKNOWN，根 Attempt 以 `EXTERNAL_TOOL_RESULT_UNKNOWN` 持久化为 `recovery_required`，普通 Worker 再投递不得重放。根、子 Session 共用这一边界：先关闭后续副作用入口，再持久化待对账事实；子 Agent 不将它降级为普通 `SUBAGENT_FAILED`，父 Agent 也不能继续成功收口。撤销阻止新调用，但不能覆盖既有待对账事实。只有独立显式对账入口核对持久化的工具版本、canonical 参数摘要与原幂等键完全一致后，才可授权声明幂等工具复用同一幂等键重试；Transport 自身不得重放。外部工具版本与凭据读取受 Run 快照及当前执行栅栏限定。

外部工具 Transport 将失败明确分为两类可安全结束的结果：`not_sent` 表示可证明请求未写出（例如目标预检、DNS、缺少方法绑定或 TLS 握手完成前的失败）；`responded_failure` 表示收到可归一化的失败响应。两类都写入失败回执，不进入 UNKNOWN 恢复。HTTP 3xx（拒绝跟随）与 4xx（包括 408、429）属于 `responded_failure`；HTTP 5xx、写出后超时或取消、断连、2xx 正文中途中断、超限以及无法解释的 2xx 正文仍属于 UNKNOWN 并转入恢复。合法空成功响应（204、205 或声明长度为 0 的 2xx）按成功结算。MCP 协议错误响应和工具错误映射为 `responded_failure`。Transport 不重试；未明确分类的异常一律按 UNKNOWN 处理，且每次调用只结算一次。

整次外部调用共享一个从 DNS 预检开始计算的绝对截止时间；预检耗尽预算时按 `not_sent` 结束，Transport 不得在截止时间后继续等待或排空不使用的响应正文。HTTP Transport 每次调用新建连接并直接拨号到本次预检校验通过的 IP，不使用共享连接池，证书与 SNI 按原主机名校验。
