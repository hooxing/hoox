# ADR-0107：托管开发 ResourceFS Sidecar 与 Thread Sandbox 按需能力

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联问题：无附件工具任务被 ResourceFS Sidecar 停止阻断

## 背景

开发环境的 Cubelet Volume Plugin 通过宿主机 HTTPS Sidecar 访问仅监听 loopback 的 API ResourceFS。
Sidecar 原先依赖开发者单独从终端启动，终端退出或宿主重启后不会恢复，Volume attach 随即返回
`RESOURCEFS_VOLUME_PLUGIN_FAILED`。

同时，Thread Sandbox reuse 路径没有传递附件需求。Provider 因而为每个 Thread Sandbox 挂载 ResourceFS，
导致一个完全不含附件、只需执行 `exec_command` 的任务也被 Sidecar 故障阻断。一次性 Sandbox 已在
ADR-0103 中实现按需挂载，但 Thread Session 缺少持久能力事实，不能直接复用该判断。

## 备选方案

### 继续手工运行 Sidecar

实现成本最低，但进程生命周期不受 Runtime 管理，重启后容易形成无监听器的隐蔽故障。

### 所有 Thread Sandbox 始终挂载 ResourceFS

路径稳定，但把附件数据面的可用性扩大为所有工具任务的前置依赖。

### API 托管 Sidecar，并持久化 Thread Session 能力

开发 API 在自身监听成功后启动 Sidecar，将其纳入 readiness 与 graceful shutdown；Worker 显式传递当前输入的
ResourceFS 需求，Thread lifecycle 持久化并检查 Session 是否已挂载。

## 决策

选择第三种方案：

- development API 通过显式 `RESOURCEFS_PROXY_*` 配置启动同进程 HTTPS Sidecar；生产环境在配置解析最早
  边界拒绝这些变量；
- Sidecar 只转发 `/v1/resource-filesystem`，upstream 固定从实际 API loopback listener 推导，不接受独立
  upstream 配置；
- API readiness 同时探测 PostgreSQL 与启用后的 Sidecar；关闭时先停止 Sidecar并等待转发完成，再关闭
  Fastify upstream；装配失败时反向清理已启动资源；
- `ThreadSandboxSessionLifecyclePort.acquire` 与 Provider create 增加必填的
  `requiresResourceFilesystem`；无附件工具启动传 `false`，附件输入传 `true`；
- `thread_sandbox_sessions.resource_filesystem_mounted` 持久化实际能力。历史 Session 因旧实现始终挂载而回填
  `true`，新 Session 默认 `false` 并由 create receipt 写入真实值；
- 请求附件能力时，允许复用已挂载 Session；遇到未挂载 Session 时先按既有 durable terminate effect 退役，
  再创建新 generation 并挂载 ResourceFS；反向复用是安全的；
- 同一个活跃 Run 已创建无挂载 Sandbox 后若再出现附件，不尝试热挂载。Worker 明确失败关闭，避免让模型在
  缺失 `/resources` 的环境中继续执行；下一 Run 可通过 generation 重建完成能力升级；
- 任何声明需要 ResourceFS 但未配置 Volume provider 的创建都失败关闭，不静默创建缺少 mount 的 Sandbox。

## 理由

Sidecar 是开发 ResourceFS 数据面的必要组成部分，应与唯一 upstream API 共享生命周期和健康状态。Thread
Sandbox 则是可复用缓存，能力必须成为持久事实；只依据本次调用参数或 provider ID 推测会在跨 Run 复用时把
无挂载 Session 错交给附件任务。

## 影响

- API 进程存活时 Sidecar 不再依赖独立终端；API 启动失败或退出时不会遗留无人管理的监听器；
- 无附件的 Thread Sandbox 工具任务不访问 Resource Volume API，也不再受 ResourceFS 故障影响；
- 首次附件任务仍严格依赖 Sidecar、Volume Plugin 和 mount，任一失败都会显式终止当前 Run；
- 从无挂载 Session 升级到附件能力需要关闭旧 Sandbox 并冷建新 generation，会增加一次创建延迟；
- 数据库新增可回退列；存在可复用的无挂载 Session 时拒绝回退，防止旧代码错误复用。

## 验证

- API 配置测试覆盖缺省关闭、配置完整性、production 拒绝和 upstream 推导；
- development assembly 测试覆盖 Sidecar 启动、readiness 和先于 Fastify 的关闭顺序；
- HTTPS 代理测试继续覆盖 WebDAV 转发、路径隔离、上游失败和 loopback 限制；
- Provider 测试覆盖 Thread create 的有/无挂载分支与缺少 Volume provider 的失败关闭；
- Worker 测试验证附件需求进入 Thread lifecycle；迁移测试验证历史回填、新默认值和安全回退条件；
- PostgreSQL 集成测试验证 Session capability 随 lifecycle acquire 持久化并参与复用。

## 可逆性与回退

关闭 `RESOURCEFS_PROXY_ENABLED` 可恢复为外部 Sidecar，但必须由其他进程管理器保证其存活。代码回退前需先
终止所有 `resource_filesystem_mounted=false` 的可复用 Thread Session，再执行 0031 down migration；否则回退
脚本拒绝删除能力事实。
