# ADR-20260905225608：公开正文增量在持久化前有界合并

- 状态：已接受
- 日期：2026-09-05
- 当前说明：[Run 实时输出](../reference/development-api.md#实时输出)
- 关系：细化 [ADR-0011](0011-run-worker-reliability-boundary.md) 的事件写放大优化，扩展 [ADR-0072](0072-reasoning-stream-continuity-and-disclosure.md) 的思考增量缓冲；保留 [持久事件推送](20260904103315-run-event-stream-and-incremental-rendering.md) 的 PG 事实源、授权、游标与重放边界。

## 背景与约束

Pi 将 Provider 的细碎正文增量逐条交给 Worker，每条事件各自经过 mutation 事务；thinking 已有缓冲，message.delta 尚无同等机制。逐片持久化使写入次数随 Provider 分片数量增长，合并连续增量可减少这部分写入，同时保留完整文本。

首段正文应立即可见。工具 started 必须在副作用授权前持久化，完整 turn 必须在下一次 Provider 调用前写入 Thread 事实。原始诊断、完整历史和公开事件各有用途，不能为节省公开事件写入而删去原始内容。

## 备选与选择

1. 保留逐片写入，只减少前端渲染：不能降低 Worker/PG 成本。
2. Worker 将多个原事件合为一次事务：保持原分片粒度，但需要重审共享序号队列、SQL 批量写入、mutation 大小及许可屏障。
3. 在 Pi 公开订阅层、分配持久 sequence 前合并同类连续增量：沿用 thinking 所在边界，完整文本不变，控制事件仍同步转发。

选择方案 3。每条 assistant 消息首段非空正文立即发布；后续正文使用 50ms/1KiB 窗口，thinking 保留 100ms/1KiB。窗口按最早待发布增量起算，不能被后续输入持续延长。任意控制事件或增量类别切换均先同步 flush。新增原始大增量先排空前驱，再原样转发，不拆片绕过 Worker 大小校验，也不与前驱拼接制造额外超限。

每个公开订阅独占缓冲和计时器；关闭订阅或 dispose Controller 时释放它们。`subscribeInternal` 原始轨迹不经过缓冲，Thread 历史仍由完整 turn 生成。`tool.started` 和 `turn.completed` 的同步前驱发布使既有 Worker eventChain 与 awaited 安全点继续生效。

## 影响、验证与可逆性

公开分片数量和大小会变化，客户端必须按文本与持久 sequence 消费，不能把事件当成 Provider token。后续正文最多增加一个目标缓冲窗口，实际延迟还取决于事件循环、PG 和网络。进程中止时未发布文字可能丢失，与已有 thinking 缓冲一致；不能提前展示为已提交事实。

验证覆盖首字、非防抖窗口、UTF-8、完整文本、超大单增量、工具/失败/终态顺序、多订阅及取消重入。真实 Faux Pi 测试证明原始分片保留、多个公开订阅完整交付、awaited turn 安全点已经看到全部文字，以及 dispose 后无迟到事件。Worker 的栅栏、取消和事件大小测试继续适用。

没有 schema、配置、Prompt 或历史格式变化。可回退公开正文到逐片转发；已经提交的合并事件继续按原 sequence 重放，无需迁移。
