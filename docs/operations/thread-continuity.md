# Thread 连续上下文运维

本文面向运维者，说明当前连续上下文、输入路由、Compaction 和 Sandbox Session 的检查与回退。运行语义见[架构说明](../architecture/thread-continuity.md)。不得把用户正文、Provider ID、lease token、对象键或凭据复制到工单、日志和指标标签。

## 发布与迁移

`pnpm db:migrate:up` 会校验已应用迁移的名称与 checksum，并按源码顺序安装全部缺失迁移。不要把部署步骤固定到某个历史 migration 编号，也不要在共享或生产环境执行 `db:migrate:down`。

API、Worker 和 Scheduler 必须来自同一发布版本，并共同识别当前迁移、Thread Context、输入路由和 Sandbox Session 事实。发布后至少确认：

1. API、Worker、Scheduler readiness 通过；
2. 新 Thread 能创建 execution head 与 Context stream；
3. follow-up 保持 FIFO，steer 在安全点接纳；
4. Context 重建和 digest 校验没有异常增长；
5. Sandbox pause、resume、cold rebuild 和 cleanup 能按持久 Provider 身份收敛。

## Feature Flag 与紧急回退

全局开关只用于紧急降级：

- `THREAD_CONTEXT_V2_READ_ENABLED=false`：停止 V2 Context 读取；
- `THREAD_INPUT_ROUTING_V2_ENABLED=false`：关闭统一输入和 steer；
- `THREAD_CONTEXT_COMPACTION_ENABLED=false`：停止创建新 checkpoint；
- `THREAD_SANDBOX_SESSION_REUSE_ENABLED=false`：停止复用 Thread Sandbox Session；
- `THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED=false`：停止创建新的到期 terminate intent，已有 effect consumer 仍须运行。

这些开关存在依赖关系，进程配置校验会拒绝不一致组合。降级不得删除 checkpoint、receipt、Workspace Revision 或 Sandbox lifecycle 事实，也不得通过 down migration 回写 Context cursor。恢复时先重新启用事实读取，再启用输入路由、Compaction 和 Session reuse。

## 指标与容量

指标是幂等 observation。先按时间窗聚合，再决定阈值和扩量；不要加入用户 ID、正文或 Provider ID：

```sql
SELECT metric_name,path,outcome,reason,count(*) AS samples,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY value) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95,
       max(value) AS maximum
FROM thread_continuity_metric_observations
WHERE tenant_id='<tenant-id>' AND observed_at >= clock_timestamp()-interval '24 hours'
GROUP BY metric_name,path,outcome,reason
ORDER BY metric_name,path,outcome,reason;
```

同时对账：

```sql
SELECT state,count(*) FROM thread_sandbox_sessions
WHERE tenant_id='<tenant-id>' GROUP BY state ORDER BY state;

SELECT effect_kind,state,count(*) FROM sandbox_lifecycle_effects
WHERE tenant_id='<tenant-id>' GROUP BY effect_kind,state ORDER BY effect_kind,state;

SELECT count(*) AS checkpoints,
       avg(tokens_after::numeric/tokens_before) AS average_token_ratio
FROM thread_context_compaction_checkpoints
WHERE tenant_id='<tenant-id>';
```

真实流量应审阅 queue wait、Context rebuild/digest mismatch、Compaction latency/token ratio、Sandbox create/resume latency、UNKNOWN 比例、paused 时长和 cold rebuild 原因。仓库测试不能替代 SLO、容量、Provider TTL 或成本结论。

Provider 当前没有统一可信的 snapshot byte size 回执；未知值不得写成 `0`。指标保留期、聚合粒度和外部导出没有批准前，不得临时写定永久天数或直接删除业务事实代替指标清理。

## 异常对账

- 历史中的 gap 事实是诚实边界，不得改写成 Assistant 内容；
- Sandbox `unknown` 由 Scheduler 查询原 Provider 后收敛，禁止在其他 Provider 重放原 effect；
- continuity endpoint 是用户可理解状态，不是 Provider 控制面；
- 恢复和回退优先操作功能开关，不删除持久事实。
