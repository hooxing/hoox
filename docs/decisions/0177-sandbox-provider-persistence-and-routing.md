# ADR-0177：Sandbox Provider 身份持久化与失败关闭路由

- 状态：部分已替代
- 仅部署配置选择新实例供应商的结论由 [后端管理 Sandbox 配置](20260910005916-managed-sandbox-routing.md) 部分替代，实施状态见该决策。
- Provider key 范围由 [ADR-20260909174703](20260909174703-tencent-ags-provider.md) 扩展；身份持久化与失败关闭路由结论继续有效。
- 日期：2026-08-14

## 背景

首期 E2B SDK 适配只提供了 Provider gateway。Sandbox 的持久身份仍只有 `provider_sandbox_id`，Worker 恢复、Scheduler cleanup/lifecycle recovery 也固定装配 Cube gateway。这样会把 E2B ID 错送给 Cube，或者在 Provider 未启用时静默走默认 Provider；两种情况都会破坏外部副作用的幂等与可审计性。

E2B 当前也没有在本仓库中得到验证的、只读且不向 Sandbox 暴露 Tenant 凭据的 ResourceFS 投影。把普通可写 Volume 当作 `/resources` 会扩大权限边界。

## 决策

1. `providerKey` 取稳定值 `cube | e2b`，是 Sandbox 身份、cleanup identity digest、未知生命周期事件和 Thread Session 的必填部分。
2. 数据库迁移为 registry、cleanup、unknown lifecycle、waiting recovery checkpoint、Thread Session 与 lifecycle effect 增加 `provider_key`；已有事实按 `cube` 回填。Provider ID 唯一性和 cleanup 外键扩展到 `provider_key`。
3. Worker 创建只走部署级默认 Provider；connect、settle、orphan cleanup 和 Workspace capability 必须按 Session 中的 `providerKey` 路由。Provider 未启用时失败关闭，不自动跨 Provider 故障转移。
4. Scheduler cleanup 与 Thread lifecycle resolver 读取持久化 claim 的 `providerKey` 后再选择 gateway；未注册 Provider 收敛为 `unknown`。
5. E2B 不注入 Cube ResourceFS Volume。任何 `requiresResourceFilesystem=true` 的 E2B 创建在远端 create 前失败关闭；普通不需要 `/resources` 的 Run 可以使用 E2B。
6. 配置使用 `SANDBOX_DEFAULT_PROVIDER` 与 `SANDBOX_ENABLED_PROVIDERS` 控制部署级装配。E2B 启用时 Worker 强制要求 `E2B_API_KEY`、`E2B_TEMPLATE_ID`，Scheduler 强制要求 `E2B_API_KEY`。

## 影响

- 已有 Cube 数据无行为变化；迁移默认回填 `cube`。
- Provider ID 可以在不同 Provider 命名空间重复，但同一 Provider 内仍保持唯一。
- 切换默认 Provider只影响新创建；已持久化 Session 和 cleanup 始终回到原 Provider。
- 需要 ResourceFS 的任务在 E2B 上会得到稳定失败，而不是获得降级后的可写或未隔离资源目录。

## 验证

- Provider Registry/Router 单元测试覆盖默认选择、持久化 key 路由、未知 Provider 失败关闭。
- Worker 测试覆盖 E2B ResourceFS 在 create 前拒绝。
- Scheduler 测试覆盖 claim 携带 `providerKey`。
- 迁移测试覆盖全部持久表、Provider 维度唯一性/外键及非 Cube 事实的 down 拒绝。

## 可逆性

仅在所有 `provider_key` 仍为 `cube` 时允许回退迁移；一旦产生 E2B 事实，down 明确拒绝，必须先完成外部资源与持久事实迁移，不能丢弃 Provider 身份。

## 合并记录

与主分支合并后，本 ADR 顺延为 ADR-0177。`0047_sandbox_provider_identity.up.sql` 内的 ADR-0171 注释属于已应用迁移的校验内容，为保持迁移 checksum 与既有数据库一致而不改写。
