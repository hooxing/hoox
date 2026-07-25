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
- `compaction.enabled=false`，禁止调用 `session.compact()`；若仍出现 Pi compaction 事件，适配层上报 `compaction.forbidden`。
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
- 文件 API 的上游错误分类不完全一致，因此适配层统一映射为 `CANCELLED/TIMEOUT/NOT_FOUND/AUTHENTICATION/INVALID_ARGUMENT/PROTOCOL/UPSTREAM`。

取消存在一个需要后续解决的边界：部分上游控制面方法不接收 `AbortSignal`。普通非创建操作的适配层能立即停止等待并返回 `CANCELLED`，但底层 HTTP 请求可能继续到结束。`create` 不能这样处理，否则迟到的成功响应会丢失 Sandbox ID 并造成泄漏；因此 create 在取消或超时后仍等待上游请求返回，拿到 ID 后先销毁再返回稳定错误。所有调用者仍须持有生命周期所有权并在 `finally` 清理。后续应优先推动 SDK 原生 signal，不能把 `Promise.race` 误认为真正取消了上游操作。

## 4. Pi 集成决定

Pi 负责 Provider、Tool Call、流式事件、abort、steer 和 follow-up 的执行机制，自有适配层负责安全策略和稳定协议：

- 使用显式注入的 `ModelRuntime`，不让库代码自行读取用户目录中的认证文件。
- 使用 `DefaultResourceLoader` 的全关闭模式，只提供固定系统提示词。
- 同时使用 `noTools: "all"`、自定义工具白名单和内置工具黑名单。这样 Pi 新增默认工具时也不会自动获得宿主机权限。
- Pi 原始事件转换为 Runtime 事件；上层不持久化 Pi 私有事件类型。
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

全部通过，清理调用成功。自动测试结果：3 个测试文件、8 项测试全部通过，包括 Fake Sandbox 生命周期、错误契约、Fake Provider Tool Call、工具白名单、无 compaction 事件及 abort/steer/follow-up 委托。

上游 SDK 自带测试不纳入根 Vitest：它属于原样第三方源码，且其中 TLS SNI 测试依赖本机 `openssl`。根测试只验证自有适配契约；更新 vendor 时应在具备上游依赖的独立供应链任务中运行上游测试。

## 6. 未决风险与下一步

1. 为上游 SDK 的控制面和文件 API补原生 `AbortSignal` 能力，或在自有 HTTP 适配中实现真正取消。
2. 在 Agent Worker 中建立 Sandbox Lease；进程崩溃时由回收器根据持久化 Lease 清理，不能只依赖进程内 `finally`。
3. 将工具参数加入路径策略、命令策略、输出上限和审计事件；本验证只证明隔离位置正确。
4. CubeAPI 与 CubeProxy 分机部署前，把 Proxy IP/端口改为必填部署配置并增加启动检查。
5. Agent Worker 接真实 Provider 时继续显式注入内存/服务端 CredentialStore，禁止读取用户主目录。
