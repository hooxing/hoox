# ADR-0036：waiting 恢复能力回执与只追加回退边界

- 状态：已接受
- 日期：2026-07-28
- 替代：ADR-0035 中“普通 proof 足以证明副作用成功”的部分
- 关联：ADR-0030、ADR-0033、ADR-0035

## 背景

普通 JSON proof 可由任一仓储调用者构造，不能证明回执来自已授权的外部适配调用。恢复 checkpoint 若接受调用方提供的 Sandbox 生命周期、TTL 或 generation，也会把计划输入误当成数据库事实。另一方面，`sandbox_recovery` 已进入 Runtime Rollout 的只追加、自引用序列；迁移 down 删除中间 entry 会破坏后继链。

## 备选

1. 继续依赖 TypeScript 类型和调用约定，并在 down 时删除恢复 entry。
2. 让仓储直接调用 provider，把网络边界耦合进持久化事务。
3. 将 provider 调用封闭在受控执行器，由适配器签发绑定请求/响应摘要的证明并由仓储验证；checkpoint 只从 registry、pause outbox 和数据库时间推导；存在任何恢复状态或只追加事实时拒绝 down。

## 决策

选择方案 3。

1. `record` 必须绑定最新 waiting run event、Rollout tail、对应 checkpoint 和单调 Attempt generation；Sandbox 候选从同 Attempt 的 registry 与 pause cleanup outbox 推导，pause UNKNOWN 必须保留并阻止自动 create，warm window 由数据库时间限制为最多十分钟。
2. 仓储不向协调器返回 completion bearer、request digest 或前置 proof，也不公开完成提交方法。实现类和生产构造边界不导出，adapter/verifier 使用 ECMAScript 私有字段，实例与 prototype 冻结；fake 仅能经过显式 testing factory，且该工厂在生产环境拒绝构造。
3. `beginEffect` 不接受调用方声称的 Workspace head/manifest。它锁定 `workspaces` 并按 tenant/workspace/head 读取 `workspace_revisions.digest/object_key`，再生成可信 plan。plan 与 attestation 完整绑定 tenant/thread/run/root run/workspace/checkpoint/intent/Attempt generation/effect/Sandbox/provider/head/manifest/request/response；materialize 完成与 resolve 都再次核对数据库 revision 事实。
4. `replan + sandbox_reused` 执行 `connect` 后还必须独立执行 `materialize`，两者拥有独立 intent 与 UNKNOWN 边界。
5. `execute` 先在 PostgreSQL 内将 pending intent CAS 为 `executing`，以内部 execution token 占用后才调用 provider。provider 返回后的 verifier 失败、lease/generation 丢失、registry CAS 失败或提交异常都不能回到 pending；当前事务或后续 reconcile 只能收敛 UNKNOWN，provider 不得重投。
6. `record/claim/begin/reserve/complete/resolve/reconcile` 均以 `runs` 行锁为 Attempt generation 线性化点；新 Attempt 创建路径已使用同一行锁。换代发生在 provider 调用之后时，complete 必须记 UNKNOWN；reconcile 不得因旧 generation 跳过 executing/pending 收敛。
7. Runtime Rollout 恢复 entry 使用共享 canonical digest 和与普通 append 完全相同的 advisory lock key。
8. 0012 down 只允许尚无 checkpoint/outbox/event/entry 的部署；迁移在 DROP 前暂时取消 FORCE RLS 执行跨租户非空检查，拒绝时事务回滚会同时恢复 RLS。

## 影响

- 正面：陈旧 checkpoint、跨 Attempt claim、伪造 TTL/generation/decision/proof 在 provider 调用前 fail-closed；崩溃后的 completed connect 可以继续收尾，已发出副作用的失败则 fail-closed 为 UNKNOWN。
- 负面：适配器必须实现请求/响应摘要 attestation；生产部署执行 0012 down 前必须确认没有 checkpoint、outbox 或恢复事实。
- 权限：Runtime role 只增加 effect outbox `payload` 列级 UPDATE，因为 capability 摘要、proof 与 UNKNOWN 审计都在该列内演进。

## 验证

- 单元测试覆盖 replan 物化和 UNKNOWN；PostgreSQL 集成验证公共协调器拿不到 digest/proof，且实现类、私有完成方法与生产 testing factory 均不可达。
- 受限 Runtime role PostgreSQL 集成覆盖 provider 前过期/伪造输入不调用、伪造 attestation 后 UNKNOWN、DB revision digest 绑定、Attempt 换代与 provider 并发只调用一次、旧 generation reconcile、canonical digest 与并发 append。
- 独立空 Schema 覆盖 0012 up/down；含恢复事实的 Schema 验证 down 安全失败且事务不产生部分回退。

## 可逆性

尚未写入恢复事实时可回退 0012。写入后只能向前迁移；不得删除或重排已有 Runtime Rollout entry。
