# Sandbox Provider

本文面向接入或运维 Sandbox 的开发者，说明当前 Provider 注册、路由和持久身份。环境变量见[配置参考](../reference/configuration.md)，真实环境 Gate 见[生产就绪说明](../operations/production-readiness.md)。

## 当前支持

Hoox 当前支持 `cube`、`e2b` 和 `tencent-ags` 三种 `SandboxProviderKey`。后台“沙箱服务”管理供应商连接、模板和策略，支持单供应商切换或按权重分配新实例。尚未发布后台路由时，Worker 与 Scheduler 沿用 `SANDBOX_DEFAULT_PROVIDER` 和 `SANDBOX_ENABLED_PROVIDERS` 构造的部署注册表；非空部署注册表的默认 Provider 必须已启用，重复或未知 key 拒绝启动。空安装允许无部署供应商常驻等待；readiness 不伪装就绪，后台配置后自动可用。

Provider 选择来自可信后台路由或部署配置，不接受业务用户或模型指定。注册表不进行跨 Provider 自动故障转移：远端结果未知时必须由同一 Provider 和持久身份对账，不能在另一 Provider 上盲目重放外部副作用。

## 后台配置与分配

Cube 使用独立代理时，在供应商配置中填写代理主机、端口和协议。该代理配置随版本绑定到实例；未填写时不继承 SDK 的进程级代理环境变量。

管理员保存供应商时生成不可变版本，密钥加密保存，读取接口只返回是否已配置。每个版本独立设置连接地址、模板、实例 TTL、操作超时、生命周期超时、暂停保留时间以及任务结束后暂停或销毁的策略。生命周期超时上限为 90 秒，保证 Scheduler 的连接和生命周期调用落在最短 210 秒清理租约内并保留写回预算。

保存后执行“测试连接”，通过真实模板的命令、文件、所选暂停恢复策略及清理检查，才可应用分配。“测试连接”不覆盖 ResourceFS 快照物化，快照体积大或部署主机到供应商数据面的链路较慢时，探测可以通过而真实任务仍然失败；供应商加入新建池前必须完成一次真实任务验证。配置保存和路由发布使用版本冲突检查，过期页面不能覆盖新配置。单供应商模式选择一个版本；多供应商模式对新实例按权重分配，例如 1:3 约分担 25%:75%。权重是长期新建比例，不是实时并发配额，也不自动根据延迟调整。

Worker 在远端创建意图之前将选中的版本持久绑定到 registry 身份。已有会话的恢复、Workspace 能力、终态处理及 Scheduler 清理继续使用绑定版本；切换路由或从新建池移除供应商不会迁移旧实例。后台读取或凭据解密失败时失败关闭，不自动退回环境默认供应商。配置与绑定保留供恢复和审计，不能删除仍有远端实例引用的版本。

任务连续 handoff 优先复用当前实例；没有后续任务时按绑定版本生成 pause 或 terminate 意图。暂停保留时间同样固定于版本。各供应商的 TTL 能力仍由适配层决定，空闲策略不等于到期自动暂停。接入步骤和加密根要求见[配置参考](../reference/configuration.md#后台沙箱配置)。

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

沙箱工具是地域内资源：同一个 API Key 可以在多个地域通过鉴权，但工具只存在于创建它的地域，跨地域调用返回 `ResourceNotFound.SandboxTool`。部署主机到不同地域数据面的可达性差异很大。实测同一部署主机（Oracle 春川）到 `ap-shanghai` 的文件写入路径在约 20 余次请求后停止投递新请求，受控快照物化无法完成；改用 `ap-hongkong` 后同一份快照与真实任务正常完成。

受控快照物化用有界并发写出文件，超过分块大小的文件在远端拆块写入后再合并，单块写入失败会重试，并在连续失败时自动换用更小的请求体重试同一文件，直到请求体足够小或档位耗尽。这些策略缓解链路抖动与大请求体被静默丢弃，但突破不了链路本身的可达性：降级到 256KiB 仍失败的路径就是这种情形。选择地域时优先靠近部署主机，并先用真实任务验证该路径，再把它加入新建池；“测试连接”通过不足以证明可用。

Thread 的 AGS TTL 到期按销毁处理，不承诺自动暂停或自动恢复。Scheduler 仍可主动暂停，后续 connect 恢复已暂停实例。网关优先读取 `metadata["x-ags-sandbox-state"]`：过渡态、暂停失败、恢复失败及未知新状态返回 unknown，连接前阻止复用；连接返回后还需确认 running。暂停冲突进入既有 UNKNOWN 对账，不无界重试。持久化 Workspace Revision 仍是恢复事实源；到期后未持久化的文件和进程可能丢失。

### 接入与验收

1. 在腾讯云目标地域创建 API Key 和兼容 E2B 的沙箱工具，模板包含上述执行依赖。腾讯云模板名、启动命令、健康检查和执行用户须在目标环境验证。
2. 执行 `pnpm db:setup` 应用 Provider 身份迁移；配置 `SANDBOX_ENABLED_PROVIDERS` 包含 `tencent-ags`，按需设置 `SANDBOX_DEFAULT_PROVIDER=tencent-ags`。Worker 与 Scheduler 同步部署，旧 Provider 保持启用直到其存量清理完成。
3. 在受控环境执行 `pnpm test:tencent-ags:real`，验证 create、command、files、inspect、pause、connect 和 kill，并检查恢复后文件仍可读取。
4. 生产启用前验证：运行中 connect 是否延长实际 TTL；长任务跨 TTL；创建响应丢失后的 metadata 保存与过滤；暂停配额和恢复失败；附件、历史、技能快照及文档交付；Worker 重启与 Scheduler 回收。

仓库自动化验证适配逻辑，不代表已通过腾讯云目标地域验收。[上海实测记录](../verification/2026-09-10-tencent-ags-smoke.md)覆盖基本生命周期、Worker 预检及 metadata 对账前提，不覆盖上述全部生产条件。不要将已有 `e2b` Session 改记为 `tencent-ags`；不支持凭借修改域名迁移运行中实例。

## 限制

- 支持 `cube`、`e2b` 和 `tencent-ags`；新增 Provider 需要扩展受限 key、实现完整网关、持久身份恢复、Scheduler 路由、真实冒烟和供应链证据。
- 仓库 Gate 不等于目标环境 readiness；Provider TTL、容量、账单、代理、证书和故障恢复必须在目标部署中验收。
- 自动故障转移不属于当前契约。
