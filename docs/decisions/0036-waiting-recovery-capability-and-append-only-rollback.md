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
3. intent 签发一次性高熵 completion capability，适配器回执必须携带并由仓储核验；checkpoint 只从 registry、已完成 pause outbox 和数据库时间推导；存在只追加恢复事实时拒绝 down。

## 决策

选择方案 3。

1. `record` 必须绑定最新 waiting run event、Rollout tail、对应 checkpoint 和最新 Attempt；Sandbox 候选从同 Attempt 的 `paused` registry 与 completed pause cleanup outbox 推导，warm window 由数据库时间限制为最多十分钟。
2. 每个 effect intent 生成固定长度 intent ID 和一次性 completion capability。数据库仅存 capability 的 SHA-256 摘要；complete 必须同时匹配 claim、intent、effect 与 capability，且成功 proof 只保存身份字段，不保存原始 capability。
3. decision 在 begin 时与 checkpoint、Workspace head 和数据库时间重新核对，并作为 intent plan 持久绑定。complete 与 resolve 都读取该 plan；调用者不能在 resolve 时替换复用身份或重建原因。
4. `replan + sandbox_reused` 执行 `connect` 后还必须独立执行 `materialize`，两者拥有独立 intent 与 UNKNOWN 边界。
5. Runtime Rollout 恢复 entry 使用共享 canonical digest 和与普通 append 完全相同的 advisory lock key。
6. 0012 down 只允许尚无恢复 event/entry 的部署；一旦存在只追加事实，迁移在同一事务中明确失败并完整回滚。

## 影响

- 正面：陈旧 checkpoint、跨 Attempt claim、伪造 TTL/generation/decision/proof 均 fail-closed；崩溃后的 completed connect 可以继续收尾。
- 负面：适配器必须传递一次性 capability；生产部署执行 0012 down 前必须确认尚未写入恢复事实。
- 权限：Runtime role 只增加 effect outbox `payload` 列级 UPDATE，因为 capability 摘要、proof 与 UNKNOWN 审计都在该列内演进。

## 验证

- 单元测试覆盖 replan 物化、capability 透传和 UNKNOWN。
- 受限 Runtime role PostgreSQL 集成覆盖 payload 更新、陈旧 Attempt/checkpoint、崩溃接管、TTL 边界、canonical digest 与并发 append。
- 独立空 Schema 覆盖 0012 up/down；含恢复事实的 Schema 验证 down 安全失败且事务不产生部分回退。

## 可逆性

尚未写入恢复事实时可回退 0012。写入后只能向前迁移；不得删除或重排已有 Runtime Rollout entry。
