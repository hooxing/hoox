# ADR-0070：旧 Thread 证据式 Anchor 与连续上下文灰度

- 状态：已接受（阶段 6，生产数据 Gate 待完成）
- 日期：2026-07-31
- 关联：实施总计划阶段 6、ADR-0063、ADR-0064、ADR-0067、ADR-0068、ADR-0069
- 范围：旧 Thread backfill/V2 anchor、新 Thread Tenant 灰度、指标、兼容投影与运维
- 不包含：用模型生成迁移摘要、删除旧事实、预设生产 SLO、固定 retention/compaction/backfill 参数

## 背景

阶段 1～5 已建立 Thread 串行队列、跨 Run Context、统一输入、Runtime Compaction 与 Sandbox Session。
旧 Thread 可能只有 `run_execution_inputs`、Workspace Revision、Run terminal 和不具备最终性证明的
Attempt rollout；直接开启 V2 read 会把缺失历史误当成完整事实。全局环境变量也只能作为进程级 kill
switch，不能稳定表达“某 Tenant 配置下新建的哪些 Thread 已进入样本”。

阶段 6 的最后一个 Gate 要求关键 SLO、容量和成本具有真实数据。仓库实现只能提供采集、查询与灰度工具，
不能伪造生产流量或把样例阈值写成通过结论。

## 备选

1. 为所有旧 Thread 从 rollout 或模型摘要恢复完整对话。rollout 的 partial/finality 不能普遍证明，模型摘要
   会生成新的不确定内容，因此拒绝。
2. 迁移时只写一个“从现在开始”的 marker，不回填任何历史。安全但丢弃了原始用户输入、Workspace 与
   terminal 等强证据，降低连续性，因此拒绝作为默认方案。
3. 按证据强度回填，缺口显式写 `legacy_history_gap`，再写不可变 anchor；新 Thread 用持久 cohort 档案和
   Tenant 策略灰度，进程 Feature Flag 继续作为最高优先级 kill switch。选择此方案。

## 选择

1. `0026` 先扩展 Context kind，再按顺序建立 Tenant policy、legacy anchor、逐项 backfill audit、Thread
   profile 和低基数 metric observation。所有表强制 RLS；Runtime 对 Tenant policy 只有 `SELECT`，不能
   自行扩大流量。
2. 新 Thread 创建事务计算 `sha256(tenant_id + NUL + thread_id) % 10000` cohort bucket，并把当时
   `new_thread_rollout_basis_points` 的选择结果和 `policy_version` 固化到 profile。改变百分比只影响之后
   新建的 Thread，不偷偷重分已有样本；没有 policy 时安全地选择旧读路径。
3. 有效 V2 read 同时要求：进程 `THREAD_CONTEXT_V2_READ_ENABLED` 开启、profile 已选中、Tenant
   `v2_read_enabled` 开启；legacy anchor 还要求 `legacy_anchor_read_enabled`。任一条件关闭即回到旧每 Run
   Session/旧 UI 回退路径，新 Context facts 不删除。
4. legacy anchor 必须取得 Thread 级 advisory lock，并确认无 active Run、无未结束 Run、无有效 writer。
   `maxRuns` 由每次运维命令显式提供，范围只是一道资源安全上限，不是产品默认。命令在单一 SERIALIZABLE
   事务内锁 stream，写 entries、推进 cursor、写 anchor/audit 和 profile；重试读回同一 anchor。
5. 强证据仅包括：`run_execution_inputs.input_text`、`run_workspace_results` 或
   `workspace_revisions.created_by_run_id`、`runs.status`。Assistant/tool 只有在未来专项 ADR 定义并验证
   finality 证明后才允许回填；本版统一记录 `not_provable` gap，不读取模型、不把 rollout projection
   当作 terminal Assistant 事实。
6. 空 Context stream 可按 Run 时间顺序回填强证据。已有 V2 facts 的 stream 不允许在尾部伪装成更早历史；
   只追加 `cannot_prepend_existing_stream` gap 和 anchor。超过显式 max depth、缺少输入源等情况都进入
   audit 和 `legacy_history_gap`。
7. 指标表只接受固定 metric name、数值和有限 path/outcome/reason，不保存用户正文、Provider Sandbox
   ID、lease token、凭据或完整 tool output。输入路由/激活、Context rebuild/digest 对账、compaction、Workspace
   materialize 与 Sandbox acquire/reconcile 写幂等 observation；queue/checkpoint/effect/session 事实表仍用于交叉
   对账。Provider 当前没有返回 snapshot byte size，因此 `sandbox_snapshot_bytes` 只保留协议名，不写虚假零值；
   接入前必须由 Provider 能力 Spike 给出可信来源。
8. `/v1/threads/:threadId/continuity` 只返回 boundary、read mode、queue depth、Context/window 和抽象
   Sandbox state。Web 展示 pause/resume/unknown、队列深度和 compaction window，不返回 Provider ID 或
   内部 lease。`legacy_history_gap` 作为 runtime notice 同时进入模型低信任历史和 UI。

## 迁移、兼容与回滚

固定迁移顺序为：

`0018 writer → 0019 queue → 0020 workspace result → 0021/0022 context → 0023 input → 0024 compaction → 0025 sandbox → 0026 rollout/anchor`

部署先运行 `0026`，再部署兼容 API/Worker/Scheduler，Tenant policy 初始保持 read 关闭；随后只扩大新 Thread
cohort，验证后逐 Thread anchor 旧数据。关闭全局 V2 read、input routing/steer、compaction、Sandbox reuse
和 retention scheduler 的既有独立 Feature Flag 即可回退代码路径；policy 还能关闭单 Tenant V2 read。
回退不删除 entry、receipt、checkpoint、anchor、profile 或 metric。任一阶段 6 事实存在时 down migration
拒绝执行，线上不得把 down 当紧急回滚。

## Test Gate

- migration 契约验证顺序、RLS、kind、低基数指标和非空 down 拒绝；
- cohort 单元测试验证确定性、Tenant/Thread 隔离和边界百分比；
- anchor PostgreSQL Gate 验证强证据精确回填、Assistant/tool gap、max depth gap、重复命令、非空 stream、
  active Run 拒绝、跨 Tenant RLS 与完整事务回滚；
- Worker Gate 验证未选 profile 返回 `unsupported` 并走旧读路径，选中 profile 才重建 V2；
- API/Web Gate 验证 continuity 投影不泄露 Provider/lease 身份，Feature Flag 关闭时旧客户端仍可使用；
- 指标 Gate 验证 observation 幂等且不包含正文；Provider 尚未提供的快照字节指标必须明确保持无样本。

自动化通过不等于生产 Gate。只有在真实流量下取得 Context rebuild、compaction、queue、Sandbox create/
resume/unknown、paused storage 等数据，并由容量评审给出可接受门槛后，才能把“关键 SLO 与容量成本有真实
数据”标为完成。

## 开放参数与可逆性

以下仍是配置或待决项：旧 Thread backfill 最大深度、Tenant rollout basis points、paused retention、
compaction 软阈值/目标/输出预算、manifest 校验强度、Provider TTL 与快照大小、扩大旧 Thread 的速率、
metric observation 的 retention/聚合导出策略、真实 SLO/告警门槛。`1..10000` 和 `0..10000` 只是输入/
存储安全范围，不是业务推荐值。

关闭 read 可立即恢复旧读路径；关闭 reuse 可恢复 cold create；关闭 steer 后输入转 follow-up。已写事实不可
逆向改写，但不会阻止旧路径继续运行。若未来要回填可证明的 Assistant/tool facts，必须新增 ADR、来源
finality 证明和独立 schema version，不能修改本 anchor 的历史结论。
