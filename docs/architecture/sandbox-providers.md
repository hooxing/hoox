# Sandbox Provider

本文面向接入或运维 Sandbox 的开发者，说明当前 Provider 注册、路由和持久身份。环境变量见[配置参考](../reference/configuration.md)，真实环境 Gate 见[生产就绪说明](../operations/production-readiness.md)，历史实施方案见[归档计划](../archive/plans/multi-sandbox-provider.md)。

## 当前支持

Hoox 当前支持 `cube` 和 `e2b` 两种 `SandboxProviderKey`。Worker 与 Scheduler 在进程启动时根据 `SANDBOX_DEFAULT_PROVIDER` 和 `SANDBOX_ENABLED_PROVIDERS` 构造部署级注册表；默认 Provider 必须已启用，重复或未知 Provider 直接拒绝启动。

Provider 选择来自可信部署配置和持久化 Session 身份，不接受用户或单次 Run 动态指定。注册表不进行跨 Provider 自动故障转移：远端结果未知时必须由同一 Provider 和持久身份对账，不能在另一 Provider 上盲目重放外部副作用。

## 统一能力

Provider 适配层向 Runtime 提供统一的创建、连接、探测、命令、代码、文件、pause 和 kill 能力，并把厂商错误归一化为稳定失败语义。业务包不得直接依赖厂商 SDK；CubeSandbox vendored SDK 和 E2B SDK 都只能通过 `@hoox/sandbox` 适配。

Thread Sandbox Session 持久保存 Provider key、远端身份、generation、状态和能力。Worker 复用前验证 Tenant、Thread、Workspace、Provider、generation、租约和 ResourceFS 能力；Scheduler 清理和 retention 也按持久 Provider 身份路由。

## ResourceFS

CubeSandbox 通过受控只读 Volume 暴露 ResourceFS。E2B 不具备相同 Volume 能力，Worker 在安全边界内物化固定 ResourceFS 快照。两条路径都必须保持 `/history`、`/thread-files` 和 `/resources` 的模型可见契约，不向 Sandbox 暴露对象存储键、数据库身份或宿主机任意路径。

## 限制

- 只支持 `cube` 和 `e2b`；新增 Provider 需要扩展受限 key、实现完整网关、持久身份恢复、Scheduler 路由、真实冒烟和供应链证据。
- 仓库 Gate 不等于目标环境 readiness；Provider TTL、容量、账单、代理、证书和故障恢复必须在目标部署中验收。
- 自动故障转移不属于当前契约。
