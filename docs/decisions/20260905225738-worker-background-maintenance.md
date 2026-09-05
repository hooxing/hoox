# ADR-20260905225738：已领取 Run 与有界后台维护并行

- 状态：已接受
- 日期：2026-09-05
- 当前说明：[Run 调度并发边界](../architecture/overview.md#run-调度并发边界)
- 部分替代：[ADR-0142](0142-dynamic-worker-tenant-assignment.md) 和 [用户级有界并发](20260828170014-configurable-user-run-concurrency.md) 中“始终在模型执行前释放 Tenant assignment”的要求；不改变 Tenant RLS、短事务占槽、Worker/User/Thread 并发限制和 claim 栅栏。

## 背景与约束

Worker 在领取 dispatch 前等待 Blob 恢复、记忆入库和定时任务消费。任一远端维护变慢会挡住本轮 Run，并挡住同一 polling loop 对其他 Tenant 的发现。只增加 Run 并发槽不能消除此等待。

assignment 的 settle 在 Tenant 事务中重算 dispatch、memory 和 scheduled task 的下一次候选，但不包含 Blob 清理候选。对已 claimed 的 assignment 调用 wake 只修改唤醒时间，随后的 settle 仍可能把它覆盖为 idle。因此不能把“后台调用 maintenance，再提前 settle/wake”当作可靠重试协议。

## 备选与选择

1. 继续串行等待维护后领取 Run：恢复行为不变，但阻塞整个 Worker 的新任务发现。
2. 提前释放 assignment，用进程内队列和 wake 重试维护：延迟最小，但进程退出及跨 Worker wake/settle 竞态可能丢失 Blob 恢复机会。
3. 引入独立持久维护队列与调度租约：可以彻底分离同 Tenant 后续领取，但需要新的持久状态、角色权限和迁移协议。
4. 先领取并启动 Run，把本轮维护与 assignment settle 交给有界后台任务；未收敛时保留已有 claimed 租约等待过期重领。

选择方案 4，作为无需数据迁移的局部优化。后台最多并行维护四个 Tenant，不建立无界等待队列。每次发现仍只领取至多一个 dispatch；Run 槽满而维护有容量时，仍可发现维护任务。维护饱和时不阻止已领取 Run 启动，但该次 assignment 不释放，租约到期后重新发现。

每个 Tenant 在单进程只运行一轮维护。维护期间 assignment 过期重领时，记录最新 token；完成旧一轮后再执行新一轮维护，不能用旧快照提前 settle 新 generation。多个进程间仍由各维护子系统已有的持久 claim、Blob 身份与幂等协议收敛，assignment 不是副作用授权。

维护组合等待所有已启动子任务结束再报告结果。任一子任务拒绝、Blob claimed 大于 converged，或 Blob 领取达到批次上限，都不释放 assignment；满批可能仍有后续项，宁可在租约到期后多读一次。明确已收敛时才 settle，迟到或失败的 settle 继续受既有栅栏和租约到期保护。

## 影响与限制

首个已领取 Run 和其他 Tenant 不等待该维护结束。同 Tenant 的后续发现仍可能受维护时长和 assignment 租约影响；这不等于全解耦，也没有新增独立 Blob 未来唤醒机制。尚未达到 grace 的孤立 Blob 仍借现有 Tenant 后续发现机会清理。

模型执行和维护可能在时间上重叠，但 assignment 的释放取决于维护而非 Run 完成；短时 PostgreSQL 调度锁仍仅覆盖 claim 事务。没有新增环境变量、数据库角色或 migration，不扩大宿主机能力和模型上下文。

停机先停止 polling 与新维护生产，再发送 Run shutdown、关闭通知监听，等待已启动 Run、维护的全部子任务及 settle 后关闭连接。尚未启动或停机后才返回的 assignment 保持租约，不创建无人管理的异步副作用；进程退出后可由其他 Worker 到期重领。

## 验证与可逆性

测试使用真正的 polling loop 与模拟租约到期的 assignment 端口，覆盖慢维护下本轮与其他 Tenant Run 启动、Run 槽满时维护、四 Tenant 上限、失败和饱和重领、新 generation 与旧 settle 竞态、停机后迟到 claim、不补跑新一轮及 drain 等待全部副作用。

既有 dispatch 并发、Run 栅栏及进程关闭测试继续适用。真实多副本与外部服务容量仍由目标环境验证，不能从 Fake 计时推断生产吞吐。

可回退到原同步维护路径；没有持久格式变化，遗留 claimed assignment 会自然到期。若以后需要同 Tenant 后续领取完全不受维护影响，应设计方案 3 的独立持久维护所有权，不能删除本决策中的重试锚点。
