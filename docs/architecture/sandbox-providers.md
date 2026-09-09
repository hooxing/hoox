# Sandbox Provider

本文面向接入或运维 Sandbox 的开发者，说明当前 Provider 注册、路由和持久身份。环境变量见[配置参考](../reference/configuration.md)，真实环境 Gate 见[生产就绪说明](../operations/production-readiness.md)，历史实施方案见[归档计划](../archive/plans/multi-sandbox-provider.md)。

## 当前支持

Hoox 当前支持 `cube`、`e2b` 和 `tencent-ags` 三种 `SandboxProviderKey`。Worker 与 Scheduler 在进程启动时根据 `SANDBOX_DEFAULT_PROVIDER` 和 `SANDBOX_ENABLED_PROVIDERS` 构造部署级注册表；默认 Provider 必须已启用，重复或未知 Provider 直接拒绝启动。

Provider 选择来自可信部署配置和持久化 Session 身份，不接受用户或单次 Run 动态指定。注册表不进行跨 Provider 自动故障转移：远端结果未知时必须由同一 Provider 和持久身份对账，不能在另一 Provider 上盲目重放外部副作用。

## 统一能力

Provider 适配层向 Runtime 提供统一的创建、连接、探测、命令、代码、文件、pause 和 kill 能力，并把厂商错误归一化为稳定失败语义。业务包不得直接依赖厂商 SDK；CubeSandbox vendored SDK 和 E2B SDK 都只能通过 `@hoox/sandbox` 适配。

Thread Sandbox Session 持久保存 Provider key、远端身份、generation、状态和能力。Worker 复用前验证 Tenant、Thread、Workspace、Provider、generation、租约和 ResourceFS 能力；Scheduler 清理和 retention 也按持久 Provider 身份路由。

## 按需准备时序

无附件的模型请求不会主动创建 Sandbox；全部图片都能作为视觉输入直送 Provider 时也保持零 Sandbox。存在未直送附件时，Session 会启动 Sandbox、Workspace 与 ResourceFS 准备，但首个模型请求不等待它完成。模型推理以及 `skill`、Todo、自动化和 Agent 控制面等非 Sandbox 工具可以继续执行；文件、命令和交付工具必须等待同一个 single-flight 准备任务 ready 后才执行，并把结果返回模型。

附件触发的后台准备必须在本次模型循环收口前排空，不能让 Run 终态与仍在进行的 acquire、materialize 或挂载发生竞态。准备失败仍按 Sandbox、Workspace、租约和 cleanup intent 的稳定失败语义关闭 Run。没有附件但随后调用 Sandbox 工具时，准备仍在首次工具调用边界启动。

## ResourceFS

CubeSandbox 通过受控只读 Volume 暴露 ResourceFS。E2B 不具备相同 Volume 能力，Worker 在安全边界内物化固定 ResourceFS 快照。两条路径都必须保持 `/history`、`/thread-files` 和 `/resources` 的模型可见契约，不向 Sandbox 暴露对象存储键、数据库身份或宿主机任意路径。

## 腾讯云 AGS

`tencent-ags` 复用 E2B 协议，但使用独立持久身份和部署配置，允许与 E2B 官方服务同时启用。Worker 和 Scheduler 都需要 `TENCENT_AGS_API_KEY`、`TENCENT_AGS_DOMAIN`；Worker 还需要 `TENCENT_AGS_TEMPLATE_ID`，并使用独立的 `TENCENT_AGS_SESSION_TTL_SECONDS`（默认 3600 秒）。域名不含协议或路径。配置值见[配置参考](../reference/configuration.md#腾讯云-ags)。

AGS 的 ResourceFS 采用 E2B 受控快照路径，Workspace 初始化要求普通执行用户可受控使用 sudo；模板必须具备 Python 3、Node.js、标准文件工具，以及任务需要的文档生成依赖。不得用 Cube Volume 参数代替腾讯 CFS 挂载。

Thread 的 AGS TTL 到期按销毁处理，不承诺自动暂停或自动恢复。Scheduler 仍可主动暂停，后续 connect 恢复已暂停实例。网关优先读取 `metadata["x-ags-sandbox-state"]`：过渡态、暂停失败、恢复失败及未知新状态返回 unknown，连接前阻止复用；连接返回后还需确认 running。暂停冲突进入既有 UNKNOWN 对账，不无界重试。持久化 Workspace Revision 仍是恢复事实源；到期后未持久化的文件和进程可能丢失。

### 接入与验收

1. 在腾讯云目标地域创建 API Key 和兼容 E2B 的沙箱工具，模板包含上述执行依赖。腾讯云模板名、启动命令、健康检查和执行用户须在目标环境验证。
2. 执行 `pnpm db:setup` 应用 Provider 身份迁移；配置 `SANDBOX_ENABLED_PROVIDERS` 包含 `tencent-ags`，按需设置 `SANDBOX_DEFAULT_PROVIDER=tencent-ags`。Worker 与 Scheduler 同步部署，旧 Provider 保持启用直到其存量清理完成。
3. 在受控环境执行 `pnpm test:tencent-ags:real`，验证 create、command、files、inspect、pause、connect 和 kill，并检查恢复后文件仍可读取。
4. 生产启用前验证：运行中 connect 是否延长实际 TTL；长任务跨 TTL；创建响应丢失后的 metadata 保存与过滤；暂停配额和恢复失败；附件、历史、技能快照及文档交付；Worker 重启与 Scheduler 回收。

仓库自动化验证适配逻辑，不代表已通过腾讯云目标地域验收。真实冒烟也不覆盖上述全部生产条件。不要将已有 `e2b` Session 改记为 `tencent-ags`；不支持凭借修改域名迁移运行中实例。

## 限制

- 支持 `cube`、`e2b` 和 `tencent-ags`；新增 Provider 需要扩展受限 key、实现完整网关、持久身份恢复、Scheduler 路由、真实冒烟和供应链证据。
- 仓库 Gate 不等于目标环境 readiness；Provider TTL、容量、账单、代理、证书和故障恢复必须在目标部署中验收。
- 自动故障转移不属于当前契约。
