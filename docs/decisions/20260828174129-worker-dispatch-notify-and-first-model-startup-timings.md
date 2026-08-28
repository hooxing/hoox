# ADR-20260828174129：Worker 使用事务通知唤醒并记录首模启动分段耗时

- 状态：已接受
- 日期：2026-08-28
- 决策者：Runtime 维护者
- 关联：ADR-0014、ADR-0016、ADR-0015、ADR-20260828170014
- 替代关系：补充动态 Tenant 调度的等待与诊断语义，不改变 PostgreSQL durable assignment、Run claim、租约、RLS 和有界并发事实源

## 背景

Agent Worker 原先只依赖固定间隔轮询 Worker Tenant assignment。API 或 Scheduler 已经在事务内写入 durable dispatch 与 assignment 后，空闲 Worker 仍可能等待完整轮询周期才开始 claim，形成与业务工作无关的排队延迟。

现有运行日志只能看出“领取 Run”和“开始模型请求”之间存在耗时，不能区分个性化、长期记忆、停止点、AgentSupervisor、Skill 恢复、Observation、Thread 历史、Runtime compaction、Pi Session 创建、模型阶段持久化、输入准备和模型许可各自消耗。直接增加同步日志或数据库写入又会放大首模关键路径。

## 决策驱动因素

- durable PostgreSQL 事实仍是调度正确性的唯一依据；
- 新工作应在事务提交后尽快唤醒空闲 Worker；
- 通知丢失、重复、迟到或监听连接中断不能导致 Run 丢失；
- 通知载荷不得携带 Tenant、Thread、Run 或用户数据；
- 诊断必须能定位首个 Provider 请求前的具体耗时阶段；
- 诊断写入失败不得阻塞模型请求或改变 Run 终态；
- production 不得因为本地排障需要写宿主机诊断文件。

## 备选方案

### 方案 A：只缩短轮询间隔

实现简单，但会持续增加 PostgreSQL 空轮询和跨 Tenant 竞争负载，仍无法消除轮询相位造成的排队。

### 方案 B：以 PostgreSQL 通知替代 durable assignment

延迟较低，但 `LISTEN/NOTIFY` 不提供持久队列语义；监听器断线或进程尚未完成订阅时会丢通知，不能作为正确性来源。

### 方案 C：事务通知作为提示，轮询兜底；首模耗时异步镜像

写入 assignment 的同一事务调用 `pg_notify`。Worker 使用独占连接监听固定无载荷频道，收到通知只触发一次尽快 claim；所有 Tenant、Run 和租约事实仍从既有表和 RLS 事务读取。轮询保留为丢通知和断线的兜底。

在 Worker 领取开始处建立一次性耗时收集器，记录低基数阶段名和毫秒值。Pi Session 在真正调用 Provider 前同步冻结快照并异步写入 development 本地诊断目录；写入 Promise 只在 Run 收口时排空，首模路径不等待文件系统。

## 选择

采用方案 C：

1. `scheduleWorkerTenantAt` 在 assignment upsert 后、同一事务内发送固定频道的空载荷 PostgreSQL 通知；事务回滚时通知不会提交。
2. 每个 Worker 进程使用 coordinator 数据库池的一条独占连接执行 `LISTEN`。连接错误后释放连接并按既有轮询间隔重连。
3. 通知只调用 polling loop 的 `wake()`；若当前 poll 正在执行，则合并为下一次立即 poll，禁止重叠 claim。Run 完成释放并发槽时也立即唤醒一次。
4. 固定轮询继续运行，负责监听建立前、断线期间和通知丢失时的最终可达性；通知不是 durable 队列、租约或授权。
5. 首模诊断从 `RunWorker.execute` 开始计时，只记录固定阶段名、阶段耗时、总耗时和既有 Run/Attempt 诊断上下文。
6. `PiWorkerSessionFactory` 在 `controller.prompt` 前发布快照。若首模前失败，Run Worker 在 `finally` 发布部分快照。
7. 诊断仅在 development 且 `MODEL_WIRE_TRACE_ENABLED=true` 时写入 `model-wire-traces/<runId>/<attemptId>/startup-timings.json`。写入 best-effort、不可变且不覆盖冲突文件；production 不装配本地镜像。

## 理由

事务通知缩短的是“durable 工作已提交到 Worker 开始 claim”的等待，而不是取代任何调度事实。空载荷和重新查询避免把不可信通知变成跨 Tenant 数据通道。保留轮询使正确性不依赖瞬时消息。

耗时收集器在内存中记录数值，发布方法不返回 Promise，因而不会在 Provider 调用前等待磁盘。把精细阶段覆盖到 Run Worker 与 Pi Session 两层，可以区分数据库停止点、上下文准备和 Session 内部恢复，而不记录用户正文或动态 Prompt。

## 影响

### 正面影响

- 正常新 dispatch 不再承担完整轮询周期的固定排队；
- Worker 有空闲并发槽时可以连续领取，Run 完成后也无需等待下一轮定时器；
- `startup-timings.json` 可以直接指出首模前主要耗时阶段；
- 通知与诊断失败都不会改变 durable 执行语义。

### 负面影响与成本

- 每个 Worker 进程长期占用 coordinator 数据库池的一条监听连接；
- 固定全局频道会唤醒多个 Worker 竞争同一批 assignment，规模扩大后可能需要分片频道或专用消息系统；
- development 敏感诊断目录新增每 Attempt 一个耗时文件，需要沿用现有清理纪律；
- 分段耗时是进程内单调时钟观测，不是跨进程分布式追踪，也不证明 Provider 首字节或模型生成耗时。

## 安全与隐私

- 通知 payload 固定为空，不包含 Tenant、Thread、Run、用户身份或正文；
- 通知接收后必须重新进入既有 coordinator claim 和 Tenant RLS 边界；
- 启动耗时文件只包含既有诊断上下文 ID、固定阶段名和数值，不包含 Prompt、附件路径、工具参数或模型正文；
- 本地文件继续受 `MODEL_WIRE_TRACE_ENABLED` 显式敏感诊断开关控制，禁止进入 production 装配。

## 验证

- persistence 测试验证 assignment upsert 后发送通知，并验证监听、频道过滤和关闭释放连接；
- polling loop 测试验证长轮询等待可被通知立即唤醒且不会重叠执行；
- Run Worker、耗时收集器和项目镜像测试验证首模前阶段、一次发布、失败隔离、幂等写入和环境门禁；
- 受影响包通过格式、Lint、TypeScript 和定向测试。

## 回退与迁移

无需数据库迁移。回退时可以删除 `pg_notify`、监听器和 `wake()` 快路径，Worker 会恢复为纯定时轮询；durable assignment 与 Run 不受影响。也可以停止装配启动耗时镜像，既有 `startup-timings.json` 仅作为历史排障文件保留或按敏感诊断清理流程删除。
