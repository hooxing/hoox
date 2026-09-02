# ADR-0036：waiting 恢复事实由已完成副作用证明推导

- 状态：已替代（普通 proof 信任边界由 [ADR-0037](../../decisions/0037-waiting-recovery-capability-and-append-only-rollback.md) 替代）
- 日期：2026-07-28
- 关联：ADR-0030、ADR-0033

## 背景

ADR-0033 要求 `sandbox_recovery_decided` 与 Runtime Rollout 只能记录已确定的恢复事实。若公共 PostgreSQL 仓储的 `resolve` 接口继续接收调用方提供的 `sandboxFact`，任一拥有恢复权的调用者都可以声明 Sandbox 已复用或已重建，而无需和已提交的 effect outbox 成功证明对应。

此外，Worker 在 intent 提交后崩溃时，后续恢复者无法可靠判断外部调用是否抵达 provider。重新投递会把一次不确定的 create/connect/materialize 变成重复副作用。

## 备选

1. `resolve` 接收任意调用方传入的恢复事实，并由调用方自行保证一致性。
2. 将事实写入 effect outbox 的计划载荷后立即发布。
3. `resolve` 只接收恢复决策；仓储在同一事务中验证 completed outbox proof，再推导并追加公开事实。

## 决策

选择方案 3。

1. `connect` 的成功证明必须匹配 checkpoint 中可信的 registry ID、provider sandbox ID 与 generation，才可推导 `sandbox_reused`。
2. `create` 与 `materialize` 必须各有 completed proof，且两个证明完全相同，才可推导 `sandbox_rebuilt`；重建原因只来自已校验的恢复决策。
3. `resolve` 不再接收 `sandboxFact`。proof 与 decision 在 TypeScript 和数据库约束两层校验，公开 run event 和 Rollout 由仓储内部生成。
4. `effect_pending` 租约过期且仍有 pending outbox 时，下一次 claim 原子地把 effect 与 checkpoint 写为 UNKNOWN，并清除租约；不重新授权副作用。

## 影响

- 正面：公开仓储接口无法伪造已复用/已重建事实；恢复事件、Rollout 与 effect 证明可审计对应。
- 负面：成功 effect 与 resolve 之间崩溃时，需要由新的 claimant 读取 completed proof 后收尾；若 intent 仍 pending 则保守终止为 UNKNOWN。
- 安全：generation、TTL 和 Scope 仍在授权 effect 前用数据库时钟与受限行锁验证，proof 不可越过这些前置条件。

## 验证

- 单元测试覆盖带持久化 create proof 的 materialize 编排。
- PostgreSQL 集成测试覆盖 derived event、错误 Scope、过期 effect_pending 自动收敛 UNKNOWN，以及迁移 up/down。
- `pnpm check` 是格式、Biome、类型、测试与配置的最终门禁。

## 可逆性

已经写入的恢复事件不能被改写。若需要扩展 proof 结构，应新增版本化字段或新事件种类，并保留当前推导规则以解释历史记录。
