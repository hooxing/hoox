# ADR-0066：Thread Sandbox Session 生命周期

- 状态：已替代（由 ADR-0069 实施）
- 日期：2026-07-31
- 决策者：待指定
- 关联任务/PR：阶段 0 语义冻结；ADR-0033、ADR-0037、ADR-0063、ADR-0064
- 替代关系：阶段 5 以 Feature Flag 渐进替代 success-close 与 waiting-only recovery；现有事实不改写

## 背景

当前生产 Registry 绑定 Attempt。Run 成功后调用 `settle(..., "close")`，只有 waiting 分支会 pause。数据库允许 `actual_ttl_seconds` 为 1～86400，但生产 `CubeSandboxGateway` 与 `CubeSandboxSessionRegistry` 当前把 create TTL 上限固定为 120 秒；waiting 决策允许最多十分钟，测试路径还存在 600 秒数据。三者不是同一个已验证的 Provider 能力。

Vendored CubeSandbox SDK 的类型和单测表明 create 可传 `lifecycle.onTimeout="pause"`、`autoResume`，`connect` 声称会自动 resume，且 SDK 另有已弃用的 `resume()`。Runtime 的 `SandboxCreateInput` 尚未暴露 lifecycle。[2026-07-31 首轮真实 Spike](../spikes/2026-07-31-thread-context-capability-spikes.md) 已证明当前目标的即时 pause/connect、短 TTL auto-pause、内存/文件恢复和 TTL 至少接受到 86400 秒，但仍没有精确最大 TTL、长 paused retention、平台版本或 UNKNOWN 收敛证据。因此本 ADR 只冻结产品状态机和失败语义；具体 retention/TTL 必须配置化并随 capability 证据更新。

## 决策驱动因素

- 无 queued follow-up 时不能保留空闲 running 资源；
- queued follow-up 可以直接接管 running Sandbox，但不能跳过 Workspace/Context/fencing 提交；
- paused/terminated/丢失 Sandbox 不得造成对话或文件事实丢失；
- pause/resume/create/terminate 的不确定结果必须失败关闭并可对账；
- Sandbox 复用不能造成跨 Tenant、跨 Thread、跨 generation 或双 lease。

## 备选方案

### 方案 A：每个 Run 总是 create/close

语义简单且接近现状，但连续 follow-up 和短暂停顿都支付冷建/物化成本，无法提供目标 resume 路径。

### 方案 B：成功后保留固定 Hot Running Window

短期 follow-up 延迟较低，但持续占用 CPU/内存，并扩大 revision 提交后后台进程漂移的窗口，违反总计划确定语义。

### 方案 C：有工作 running handoff，无工作立即 pause（选择）

Thread/Workspace 级 Session 作为可验证缓存。terminal 线性化点已有队首才 handoff，否则立即创建 pause intent；后续输入优先 resume，不能证明可复用时 cold rebuild。

## 选择

1. 新建 `thread_sandbox_sessions`，身份至少绑定 Tenant、Thread、Workspace、registry、provider sandbox ID 和 generation。目标状态固定为 `running | pausing | paused | resuming | terminated | unknown`。
2. `pausing`、`resuming` 是持久状态，必须由 lifecycle effect intent/receipt 驱动；不能只存在 Worker 内存。create、pause、resume/connect、terminate 都属于外部副作用。
3. 每个 Session 同时最多一个未释放 lease。唯一性以 `released_at IS NULL` 的部分唯一索引表达；过期 lease 先通过 epoch/token CAS release/reclaim，再建立新 lease，不能把“当前时间未过期”写进索引谓词。
4. Run terminal 先完成 Workspace result、Thread Context terminal facts 和 writer fencing。随后与 ADR-0063 队列决策在同一数据库事务中：有队首则激活下一 Run 并转交 running lease；无队列则写 pause intent。
5. 不设置 Hot Running Window。事务证明队列为空后立即进入 `running → pausing → paused`。当前 Spike 已证明测试目标可执行 `onTimeout=pause`；接入生产配置后它仍只作为 Worker/Scheduler 异常时的资源泄漏兜底，不能替代 Runtime intent。
6. 输入在 `pausing` 到达时只进入 durable queue。首版等待 pause receipt 后再执行 `paused → resuming → running`，不尝试取消正在进行的 pause。
7. 复用前必须同时验证 Tenant、Thread、Workspace、generation、状态、retention、唯一 lease 和 `materialized_revision_id == Run.base_revision_id`。无法证明文件未漂移时重物化；无法证明重物化清洁性时终止并 cold rebuild。
8. 任一 lifecycle 外部调用结果不确定，Session 进入 `unknown`。对账前禁止 resume、禁止复用同一 provider ID、禁止假定 terminate 成功；Scheduler 根据 Provider query/receipt 收敛到 paused 或 terminated。
9. paused 超过策略、Provider 已回收或明确不存在时标记 terminated，新建 Sandbox 并物化最新 Workspace Revision。Thread Context、Workspace Revision、Blob 和 Artifact 始终是事实源。
10. 当前 Attempt `sandbox_registry`、cleanup outbox 和 waiting recovery 在迁移期保留。阶段 5 新表先 shadow/只写，Feature Flag 开启后仅新 Session 走 Thread lifecycle；旧 cleanup/effect 必须 drain，不能通过重命名 enum 假装完成迁移。

首版逻辑 Schema 版本为：

- `thread_sandbox_session.schema_version = 1`；
- `thread_sandbox_lease.schema_version = 1`；
- `sandbox_lifecycle_effect.schema_version = 1`。

## 状态机与线性化要求

```text
create confirmed ───────────────→ running
running + queued follow-up ─────→ running（事务内 lease handoff）
running + empty queue ──────────→ pausing（事务内 pause intent）
pausing + confirmed receipt ────→ paused
paused + activated Run ─────────→ resuming
resuming + confirmed receipt ───→ running
paused + retention expired ─────→ terminated
任何副作用结果无法证明 ────────→ unknown
unknown + reconciliation ───────→ paused | terminated
```

`unknown` 不是普通重试态。只有明确“调用未生效”的暂时性失败可有界重试；已发出且结果不明的 effect 只能对账。

## 影响

### 正面影响

- 消除无工作时可观察的空闲 running 窗口；
- 连续 follow-up、paused resume 和冷恢复共享同一正确性边界；
- Sandbox 丢失不影响 Thread/Workspace 长期事实。

### 负面影响与成本

- 新增 Session registry、lease、effect reconciler、retention Scheduler 和状态 UI；
- 严格 attestation 会在无法证明一致时增加冷建；
- paused 快照占用存储，需要租户配额和容量指标。

### 安全、数据与运维影响

- provider sandbox ID、lease token、Provider receipt 正文和凭据不得出现在公开事件或普通日志；
- paused 默认保留时长、最大快照大小、TTL 候选、续期能力、退避、resume 后 manifest 校验层级和租户策略均为配置或待决项；
- `onTimeout=pause` 与 connect 自动恢复已有当前目标证据；Provider 最大 TTL、长 retention 和版本变化后的能力仍需追加真实环境证据才能进入 capability matrix。

## Feature Flag 与兼容

- `thread_sandbox_session_reuse`：控制新 Run 是否选择 Thread Session/handoff/resume；默认关闭。关闭时新 Run 使用旧 create/close 路径。
- `thread_sandbox_retention_scheduler`：控制 paused 到期回收；依赖新 Session schema，但不能用于停止已有 lifecycle effect 对账。
- 关闭 reuse 后，已有 running/paused/unknown Session 必须由兼容 reconciler 释放或终止；不能直接停掉消费者造成泄漏。
- waiting answer 协议在统一输入 API 决定前继续走既有显式恢复，不把普通 `auto` 输入猜成回答。

## 验证

- 真实 CubeSandbox Spike 记录平台版本、create/pause/connect/terminate 时间、状态变化、内存/文件恢复、TTL 候选、paused 保留和 `onTimeout=pause`；
- Fake effect receipt 覆盖 succeeded、明确未生效、unknown、延迟完成、重复回执和进程崩溃；
- queued handoff、空队列 pause、pausing 输入、paused resume、NOT_FOUND cold rebuild 和 retention 到期；
- terminal 与 API 并发，断言只出现 handoff 或 pause-intent 后 resume 两种路径；
- generation/revision/manifest/lease mismatch 均拒绝复用；
- 两个 Run/Worker 不能同时占有 Session，旧 epoch 不能执行工具或 lifecycle effect；
- RLS、跨 Tenant/provider ID 重放和 UNKNOWN 对账负例通过。

## 可逆性与回退

新表先增量部署，旧 registry 不原地改名。未写新 Session 时可在开发/测试 down；出现 lifecycle facts 后生产 down 必须拒绝。线上回退关闭新 reuse，保留 effect reconciler 和 retention cleanup，待所有新 Session 收敛为 terminated 后再评估删除。

## 后续工作

- 阶段 0：执行并保存真实 Provider capability 证据，不以 SDK 类型代替；
- 阶段 5：实现 Thread Session、lease、effect outbox/receipt、handoff、pause/resume 和 cold rebuild；
- 阶段 6：依据真实延迟、成功率、快照大小和成本调整 retention 配置。

## 实施记录

- 阶段 5 已由 [ADR-0069](0069-thread-sandbox-session-lifecycle-implementation.md) 实施。具体事务、
  迁移、Feature Flag、Scheduler 对账和参数边界以 ADR-0069 为准；本 ADR 保留阶段 0 的语义冻结历史。
