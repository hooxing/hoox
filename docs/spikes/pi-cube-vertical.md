# M0-05：Pi + CubeSandbox 纵向验证记录

日期：2026-07-26  
状态：通过，可进入 Agent Worker 最小闭环；本文不代表 Tenant、Thread 或 Run 数据模型已经实现。

## 1. 目标与安全边界

本验证只回答两个问题：CubeSandbox 0.6 能否被 TypeScript Runtime 稳定控制，以及 Pi 0.82.1 能否在不接触 Worker 宿主文件系统和 Shell 的前提下调用受控 Sandbox 工具。

已固定以下不变量：

- 业务代码只依赖 `@cube-runtime/sandbox`，不直接依赖厂商 SDK。
- Pi 不加载宿主机 `bash/read/write/edit/grep/find/ls`；模型只看到四个自定义 Sandbox 工具。
- Pi 的扩展、Skill、Prompt、主题和 AGENTS 文件自动发现全部关闭，避免加载宿主机或租户未审查代码。
- `SessionManager`、`SettingsManager` 均使用内存实现；Pi Session 不是持久化真相。
- `compaction.enabled=false`；生产 API 只返回使用 `#private` 保存会话的窄 Controller，不暴露 `AgentSession`，因此调用方无法取得或调用 `compact()`。若仍出现 Pi compaction 事件，适配层上报 `compaction.forbidden`。
- 创建方在 `finally` 中销毁 Sandbox。取消或业务异常不能绕过清理。
- 错误返回给模型前移除原始 cause，避免泄漏网络地址、认证信息和上游响应。

## 2. 供应链决定

CubeSandbox Node SDK 未跟随 `master`：

- 上游标签：`v0.6.0`
- 固定提交：`8721dd151971ce3c2966482bbd32904ad98f378e`
- 上游目录：`sdk/node`
- SDK 自身包版本：`@cubesandbox/sdk@0.3.0`
- 许可证：Apache-2.0

`runtime-ts/vendor/cubesandbox-sdk` 是上游机械快照，本地不打补丁；适配和兼容逻辑全部位于 `runtime-ts/packages/sandbox`。标签指向已用远端 `ls-remote` 和本地 `rev-parse` 双重确认。

## 3. SDK 实际能力与预期差异

在 CubeSandbox 0.6 实例上实际确认：

- `Sandbox.create`、`commands.run`、`runCode`、`files.write/read`、`pause`、`Sandbox.connect` 和 `kill` 可用。
- `connect` 会自动恢复 paused Sandbox，不需要调用已废弃的 `resume`。
- `pause/connect` 后，Jupyter 内存变量、文件和命令执行能力均保留。
- `runCode` 的超时是输出空闲超时；`commands.run` 同时包含客户端空闲超时和 envd 硬截止时间。适配层暂时对外只承诺稳定的 `TIMEOUT` 错误，不把差异传播给业务层。
- SDK 原生环境变量名是 `CUBE_*`，当前项目已有配置名是 `CUBESANDBOX_*`。适配层兼容两者，并以项目名优先。
- 数据面必须配置 CubeProxy 节点 IP。当前自托管拓扑中 CubeAPI 与 CubeProxy 同机，若未显式配置，适配层从 API URL 推导节点 IP；部署拓扑拆分时必须显式配置。
- 文件 API 的上游错误分类不完全一致，因此适配层统一映射为 `CANCELLED/TIMEOUT/NOT_FOUND/AUTHENTICATION/INVALID_ARGUMENT/UNKNOWN/PROTOCOL/UPSTREAM`。
- URL、端口、timeout、TTL、template、Sandbox ID、环境变量、命令、代码和文件路径在调用 SDK 前统一校验，非法值只返回 `INVALID_ARGUMENT`。

### 取消、超时与未知结果

适配层不再使用 `Promise.race` 模拟远端取消：

- `commands.run` 和 `runCode` 使用 SDK 原生 timeout 语义。
- files、connect、pause、kill 等没有完整原生 AbortSignal 的调用，一旦开始便等待上游 settle。期间 AbortSignal 只记录 `cancellation_requested`，完成后在安全点返回 `CANCELLED`；调用方不会先收到取消再被迟到写入覆盖。
- 对没有原生硬超时的文件调用，调用方 timeout 只能在 settle 后转换成 `TIMEOUT`。这不是快速中断，优点是副作用边界确定；真正中断需要上游 SDK 支持 signal。
- create 请求超时可能是“服务端已创建、客户端丢失响应”。每次 create 注入随机 metadata request ID；失败后通过 `listV2` 有限轮询对账，找到后 connect/kill。无法确认时返回 `UNKNOWN`，调用泄漏指标回调，并依靠最长 120 秒的短 TTL 兜底。生产回收器仍是后续必需项。
- create 已取得 Sandbox ID 后若收到取消，会先 kill 再返回 `CANCELLED`；清理失败则返回 `UNKNOWN`。

备选方案是 fork SDK 给所有数据面和控制面加入 AbortSignal，或使用自有 HTTP 客户端；M0 不修改 vendor，先选择“等待 settle＋显式 UNKNOWN”，避免伪造已经取消的语义。

## 4. Pi 集成决定

Pi 负责 Provider、Tool Call、流式事件、abort、steer 和 follow-up 的执行机制，自有适配层负责安全策略和稳定协议：

- 使用显式注入的 `ModelRuntime`，不让库代码自行读取用户目录中的认证文件。
- 使用自有 `EmptyResourceLoader`：它没有宿主路径和 PackageManager，不扫描扩展、Skill、Prompt、主题或 AGENTS 文件；逻辑 cwd 恒定为 `/workspace`。
- 同时使用 `noTools: "all"`、自定义工具白名单和内置工具黑名单。这样 Pi 新增默认工具时也不会自动获得宿主机权限。
- Pi 原始事件转换为 Runtime 事件；只有 assistant 成功终态生成 `message.completed`，provider error 和 aborted 分别生成稳定 `PROVIDER/ABORTED`，user/toolResult 不会被重复当成交付消息。
- Fake Provider 使用 Pi 官方 Faux Provider，配合内存 CredentialStore 和运行时测试密钥，不调用外部模型。
- 本阶段没有调用真实模型：CubeSandbox 生命周期与 Pi Tool Call 已分别由真实 Cube 和 Faux Provider 验证，额外真实模型调用不会提升 M0-05 的边界置信度，只会引入费用和密钥暴露面。

## 5. 验证结果

2026-07-26 对 `http://192.168.53.128:3000` 的 CubeSandbox 0.6 运行显式冒烟，模板使用本地 `.env` 注入且没有输出配置值：

```text
create
→ command
→ runCode（建立变量）
→ file write/read
→ pause
→ connect（自动恢复）
→ runCode（变量仍在）+ file read + command
→ finally kill
```

全部通过，清理调用成功。自动测试结果：3 个测试文件、14 项测试全部通过，包括 Fake/直接 SDK Gateway 生命周期、非法输入、迟到副作用、create 对账与 UNKNOWN、Fake Provider Tool Call、assistant-only 终态、Provider 失败、真实 abort/steer/follow-up 队列、零宿主资源发现、工具白名单和无 compaction 入口/事件。

### 安全复现

先在当前进程准备下列变量；只写变量名，不把值写进命令、日志或仓库：

```text
CUBESANDBOX_API_URL
CUBESANDBOX_TEMPLATE_ID
# 如部署需要，再设置 CUBESANDBOX_API_KEY、CUBESANDBOX_PROXY_NODE_IP/PORT/SCHEME
```

PowerShell 中显式开启真实测试：

```powershell
$env:REAL_CUBE_SMOKE = "1"
pnpm test:cube:real
Remove-Item Env:REAL_CUBE_SMOKE
```

脚本默认拒绝运行，不输出配置值，并在 `finally` 执行 kill。执行者应从本机 Secret/.env 安全注入进程环境，不要使用会把密钥留在 shell history 的赋值命令。

上游 SDK 自带测试不纳入根 Vitest：它属于原样第三方源码，且其中 TLS SNI 测试依赖本机 `openssl`。根测试只验证自有适配契约；更新 vendor 时应在具备上游依赖的独立供应链任务中运行上游测试。

## 6. 未决风险与下一步

1. 为上游 SDK 的控制面和文件 API补原生 `AbortSignal` 能力，或在自有 HTTP 适配中实现真正取消。
2. 在 Agent Worker 中建立 Sandbox Lease；进程崩溃时由回收器根据持久化 Lease 清理，不能只依赖进程内 `finally`。
3. 将工具参数加入路径策略、命令策略、输出上限和审计事件；本验证只证明隔离位置正确。
4. CubeAPI 与 CubeProxy 分机部署前，把 Proxy IP/端口改为必填部署配置并增加启动检查。
5. Agent Worker 接真实 Provider 时继续显式注入内存/服务端 CredentialStore，禁止读取用户主目录。
