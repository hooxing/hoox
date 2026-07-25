# ADR-0009：Run Worker 状态机、栅栏租约与恢复边界

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M1-05、M2-05、M5-01、M5-02、M5-03
- 替代关系：无

## 背景

Run Worker 需要把 Pi 的易失活动会话、CubeSandbox 的外部副作用、Workspace 不可变版本和持久 Run 状态组合成一个可以崩溃恢复的执行单元。本阶段不绑定 PostgreSQL 实现，但端口必须提前固定原子性、幂等和租约丢失语义，否则内存 Fake 验证通过后仍会在多 Worker 部署中产生双写。

## 决策驱动因素

- 同一 Run 和 Workspace 在任意时刻只能有一个有效写入者；
- 流式事件可增量持久化，但 Run 终态、终态事件与 Outbox 必须原子提交；
- Sandbox 或其他外部副作用结果未知时不能自动重试或伪装成功；
- Worker 崩溃后只能从持久事实和已验证 WorkspaceRevision 恢复，不能使用 Pi 本地 Session 文件或 Sandbox 内存作为事实源；
- waiting、取消和超时必须在安全点释放 Workspace 写租约。

## 备选方案

### 方案 A：队列保证单消费者，Worker 直接更新状态

实现最少，但队列重新投递、网络分区和进程暂停仍会产生双消费者；没有数据库栅栏时旧 Worker 可以在租约过期后继续提交。

### 方案 B：Run claim 与 Workspace lease 使用独立栅栏，所有持久提交带条件版本

实现端口较多，但可以把队列视为至少一次通知；旧 Worker 的 claim token 或 lease epoch 一旦失效，事件、状态和 Revision 提交都会被拒绝。

### 方案 C：为整个 Run 持有数据库事务或互斥锁

表面原子，但模型调用和工具执行持续时间不可控，长事务会占连接、阻塞维护并放大故障恢复成本。

## 选择

采用方案 B，并固定以下细化规则。

### 状态机

应用层状态为：

```text
queued ─┐
waiting ├─→ running ─→ waiting
interrupted ┘          ├→ succeeded
                       ├→ failed
                       ├→ cancelled
                       └→ interrupted
```

终态不可重新领取。过期的 running 先由恢复协调器标记为 interrupted，再由新 Worker 领取；Worker Core 不把过期 claim 直接改回 running。单 Agent 阶段要求 `rootRunId === runId`，但所有端口仍显式携带 tenant/thread/run/rootRun，防止未来 Agent Tree 引入隐式换根。

### 幂等键与栅栏

- Run claim 返回不可猜测的 `claimToken`、单调 `claimEpoch` 和状态版本；后续所有 Run 事件/状态提交必须同时比较三者。
- Workspace lease 返回独立单调 `leaseEpoch`；Revision 提交比较 Tenant、Thread、Workspace、rootRun、base revision 和 epoch。
- 事件键使用 `runId/event/sequence`，sequence 从持久高水位继续分配；Outbox 使用业务事实键，而不是随机重试 ID。
- WorkspaceRevision 只接受 Workspace 验证端口产生的 `VerifiedWorkspaceRevision`，提交幂等键由 run、base revision 和内容摘要决定。

### 租约丢失

Run claim 或 Workspace lease 的心跳任一失败，当前 Worker 立即请求中止 Pi，并停止新的事件、Revision 和终态写入。旧 Worker只做 best-effort 资源释放；它没有权限把 Run 标记为失败。新 Worker 在旧 claim 过期并完成 interrupted 协调后接管。

### 事件、状态与 Outbox 原子性

同一个 `RunPersistencePort.commit` 必须在一个持久化事务中完成条件检查、事件追加、Outbox 追加、状态迁移和事件高水位推进。流式事件可以逐条提交；最终 succeeded/failed/cancelled/waiting 事件与对应状态必须在同一提交中发生。事件存储不可用时 Worker 中止 Pi，不提交 WorkspaceRevision，也不猜测终态。

### 恢复策略

- 重复投递遇到活跃 claim 或终态直接返回，不执行模型或 Sandbox。
- crash 后重入从事件高水位继续分配序号；已经提交的 Revision 和 Outbox 依靠幂等键返回 `already_applied`。
- Sandbox registry 可以 connect 已登记 Session 或 create 新 Session；`UNKNOWN` 必须作为 Outbox 事实并使本次执行失败/中断，不能自动重试创建。
- 完成顺序为：Pi 安全终态 → Workspace 内容验证 → Revision 条件提交 → Artifact 就绪端口检查 → Run succeeded 原子提交。Artifact 端口本阶段只表达完成前置条件，不实现发布。
- waiting 前先验证并提交 Workspace 安全点、记录恢复上下文、暂停或释放 Sandbox、原子进入 waiting，再释放 Workspace lease。恢复时以 follow-up 驱动全新内存 Pi 投影；本阶段端口预留 Rollout 恢复输入，不读取 Pi 本地 Session。

## 影响

### 正面影响

- 队列可采用至少一次投递而不产生并发双写；
- PostgreSQL、内存 Fake 或其他事务存储可以实现同一应用端口；
- 外部结果未知、事件故障和 Worker 崩溃都有明确的保守结果。

### 负面影响与成本

- Run 状态、事件和 Outbox 必须由同一个事务适配器实现，不能分别调用三个无事务 Repository；
- 流式事件逐条提交会增加写放大，后续可在不改变序号和原子边界的前提下安全批量；
- 当前恢复只固定应用边界，完整 Pi Rollout 投影和对象存储物化仍属于后续任务。

### 安全与运维影响

所有端口命令都携带完整所有权范围，错误不应泄漏其他 Tenant 的实体是否存在。必须监控 claim/lease 丢失、UNKNOWN Outbox、恢复次数、事件提交延迟和 Revision 冲突。UNKNOWN Outbox 消费失败时宁可保留 Sandbox 到短 TTL 回收，也不能自动创建第二个实例。

## 验证

- 双 Worker 重复领取和重复投递测试证明只有一个模型会话启动；
- 在模型调用、事件写入、Revision 提交前后注入 claim/lease 丢失，证明旧 Worker不能提交终态或 Revision；
- 取消迟到、超时、Provider 失败、事件写失败和 Sandbox UNKNOWN 均得到稳定状态与 Outbox；
- crash 后重新领取从持久 sequence 继续，Revision/Outbox 幂等键不双提交；
- Linux 专项使用 Pi Faux Provider 验证窄 Controller，Windows 继续在创建 Pi Session 前 fail-fast。

## 可逆性

在 PostgreSQL Schema 和生产事件写入前，可以调整端口命名和批量方式。claim epoch、事件 sequence、Outbox 幂等键和 Workspace lease epoch 一旦进入生产数据即成为恢复协议，修改需要版本化迁移；不能回退到依赖队列单消费者或 Worker 本地 Session 的方案。

## 实施记录

- 2026-07-26：已由不依赖具体 PostgreSQL 的 Worker Core、Pi 窄接口工厂、事务型内存 Fake 和故障注入测试落实。
- 已覆盖成功检查点、重复投递、Workspace 租约丢失、迟到取消、流式事件不可用、Sandbox 创建/收尾 UNKNOWN、Provider/Pi Session 创建失败、waiting/follow-up、超时和 crash 重入；这些测试均断言不会重复提交 WorkspaceRevision。
- `@cube-runtime/pi-adapter` 补齐源码 types export，保证应用包在干净安装且尚未构建依赖产物时也能独立 typecheck；运行时入口仍指向 `dist`。
- PostgreSQL 事务适配器、完整 Rollout 重建、Artifact 发布和 API 不属于本次实现。
