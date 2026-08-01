# Thread 连续上下文阶段 6 运维手册

本文只描述阶段 6 的灰度、旧 Thread anchor、观测与回退。所有占位符都必须替换为实际内部 ID；不得把
用户正文、Provider ID、lease token 或凭据复制到工单和指标标签。

## 发布前检查与顺序

1. 备份并确认当前 migration 到 `0026`，运行 `pnpm db:migrate:up` 安装 `0027`。
2. 同时部署能识别 `0027` 的 API、Worker、Scheduler；连续上下文、统一输入、compaction、Sandbox reuse
   和 retention scheduler 默认开启，不再依赖手工扩量才能获得正常产品行为。
3. 确认新 Thread profile 为 `rollout_selected=true`，并验证 digest、队列、Sandbox 和成本指标。
4. 逐个旧 Thread 执行 anchor；旧 Thread 不因默认开启而绕过证据迁移。
5. 需要单 Tenant 降级时再写显式 policy；环境开关只用于全局紧急回退。

数据库顺序不可调整：`0018 → 0019 → 0020 → 0021/0022 → 0023 → 0024 → 0025 → 0026 → 0027`。

## 配置 Tenant 新 Thread 灰度

Tenant policy 只能由 Migrator/运维控制面写入。以下 SQL 必须在目标 schema 和事务级 Tenant context 中执行：

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant-id>', true);
INSERT INTO tenant_thread_continuity_policies(
  tenant_id,policy_version,v2_read_enabled,new_thread_rollout_basis_points,
  legacy_anchor_read_enabled,updated_at
) VALUES ('<tenant-id>',1,false,<0-to-10000>,false,clock_timestamp())
ON CONFLICT (tenant_id) DO UPDATE SET
  policy_version=tenant_thread_continuity_policies.policy_version+1,
  v2_read_enabled=EXCLUDED.v2_read_enabled,
  new_thread_rollout_basis_points=EXCLUDED.new_thread_rollout_basis_points,
  legacy_anchor_read_enabled=EXCLUDED.legacy_anchor_read_enabled,
  updated_at=clock_timestamp();
COMMIT;
```

缺少显式 policy 时默认 `v2_read_enabled=true`、`basis_points=10000`、
`legacy_anchor_read_enabled=true`。`basis_points=100` 表示之后新建 Thread 的约 1% 样本，不会重分已有
profile；这是显式降级配置，不是正常安装步骤。比例调整必须依据真实数据决定。

## Anchor 单个旧 Thread

先确认 Thread 无 queued/running/waiting Run。最大回填深度必须由本次变更单明确提供：

```powershell
pnpm thread:legacy-anchor -- --tenant <tenant-id> --thread <thread-id> --max-runs <n> --operation <stable-operation-id>
```

合法结果：

- `anchored`：强证据、gap、anchor、audit 和 profile 已原子提交；
- `replayed`：该 Thread 已有 anchor，没有重复写入；
- `busy`：存在活跃/未结束 Run，稍后重试；
- `not_legacy`：已有 new/manual profile，不应再按旧 Thread 迁移；
- `not_found`：目标或 Tenant scope 不匹配。

核对时只查审计摘要，不导出 `thread_context_entries.body_inline`：

```sql
SELECT anchor_id,max_runs,total_terminal_runs,selected_runs,backfilled_entries,gap_items,
       first_context_sequence,anchor_context_sequence,completed_at
FROM thread_context_legacy_anchors
WHERE tenant_id='<tenant-id>' AND thread_id='<thread-id>';

SELECT evidence_kind,outcome,reason_code,count(*)
FROM thread_context_legacy_backfill_items
WHERE tenant_id='<tenant-id>' AND thread_id='<thread-id>'
GROUP BY evidence_kind,outcome,reason_code
ORDER BY evidence_kind,outcome,reason_code;
```

## Feature Flag 与紧急回退

现有独立开关保持最高优先级：

- `THREAD_CONTEXT_V2_READ_ENABLED=false`：回到旧每 Run Session 读路径；
- `THREAD_INPUT_ROUTING_V2_ENABLED=false`：关闭统一输入/steer，客户端回退 `/runs` follow-up；
- `THREAD_CONTEXT_COMPACTION_ENABLED=false`：停止创建新 checkpoint；
- `THREAD_SANDBOX_SESSION_REUSE_ENABLED=false`：停止新 reuse，回到 cold/旧清理路径；
- `THREAD_SANDBOX_RETENTION_SCHEDULER_ENABLED=false`：停止创建新的到期 terminate intent，但已有 effect
  consumer 仍须运行。

单 Tenant 回退把 policy 的 `v2_read_enabled` 改为 false 并递增 `policy_version`。不要删除 profile/anchor，
不要 down migration，不要回写 Context cursor。全局环境变量变更按现有进程发布机制重启后生效。

## 指标与容量查询

指标均为幂等 observation。先按时间窗聚合，再决定扩量；不要在查询中加入用户 ID、正文或 Provider ID：

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

paused 数量/存储时长、effect UNKNOWN 和 checkpoint 压缩比还应与事实表对账：

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

至少要用真实流量审阅 queue wait、Context rebuild/digest mismatch、compaction latency/token ratio、Sandbox
create/resume latency、unknown 比例、paused 时长/快照字节和 cold rebuild 原因。仓库测试结果不能替代 SLO、
容量、Provider TTL 或成本结论；这些门槛仍是待决项。

当前 Provider 能力没有可信的 snapshot byte size 回执，`sandbox_snapshot_bytes` 因此应保持无样本，不能用
`0` 代替未知。只有 Provider 能力 Spike 和专项 ADR 确认字节口径后才能启用该指标；评审期间以 paused
session 数量、实际 Provider 账单和 retention 时长三方对账。

指标 observation 的保留期、聚合粒度和外部导出仍是待决参数；在容量评审批准清理策略之前，不得临时
写定一个永久天数，也不得直接删除 anchor、checkpoint、receipt 或 Sandbox lifecycle 事实表来代替指标清理。

## 异常对账

- `legacy_history_gap` 是预期的诚实边界，不得人工改写成 Assistant 内容；
- `sandbox unknown` 必须由 Scheduler 查询 Provider 后收敛，禁止重放原 effect；
- continuity endpoint 只用于用户可理解状态，不是 Provider 控制面；
- anchor 命令失败时先按相同 operation ID 重试。SERIALIZABLE 事务保证不会只提交一半；
- 任一阶段 6 facts 已存在时 `0026 down` 会拒绝。紧急恢复只操作 Feature Flag/policy。
