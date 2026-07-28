# ADR-0040：开发 Worker 的 Windows 运行与模型就绪边界

- 状态：已接受
- 日期：2026-07-28
- 关联：ADR-0004、ADR-0035、ADR-0038

## 背景

本地可体验链路需要在 Windows 上运行 API 与 Agent Worker，并让浏览器创建的 Run 通过真实
PostgreSQL dispatch 被消费。CubeSandbox 的工具执行位置是 Linux Sandbox，不是 Worker 宿主机。

Pi 0.82.1 的 `createAgentSession` 会按宿主平台规范化传入的 cwd；Windows 因而会把逻辑
`/workspace` 表示成盘符路径。旧适配层把这视为 Pi 的硬限制，直接拒绝 Windows，导致即使所有
实际文件和命令都已经在 CubeSandbox 中执行，开发 Worker 也无法启动。

同时，部分 OpenAI-compatible Provider 的 `/models` 只返回模型 `id`，而 Pi 仍需要可信的
context window 和最大输出 token 才能做预算。把缺失元数据默认为任意值会削弱生产边界。
真实开发 Provider 还只实现 `/chat/completions`（包括 SSE 与工具调用），对同一 `MODEL_ID` 的
`/responses` 返回不支持；若装配层把“OpenAI-compatible”误写成 Pi Responses 协议，readiness 会通过，
但真实 Run 会在第一次模型请求后以 Provider 错误结束。

## 备选方案

1. 继续限制 Worker 只能运行在 Linux。
2. 在 Windows 上改为本地或内存工具实现。
3. 删除宿主平台拒绝，保留 Pi 内建宿主工具禁用和 CubeSandbox 工具边界；开发预算显式配置，生产
   继续验证 Provider 完整元数据。

## 决策

采用方案 3。Pi Session 固定使用 `EmptyResourceLoader`、内存 SessionManager，并以 `noTools: "all"`
关闭 Pi 的 `bash/read/write/edit/grep/find/ls`。唯一启用的工具是 Runtime 注册的受控 Sandbox 工具，
其 I/O 经 Tool Router、一次性许可和 CubeSandbox Gateway；Windows Worker 不执行宿主命令或读写宿主
工作区。Pi 的 cwd 仅保留为逻辑标签，不能作为宿主文件系统 capability。

development Worker 只接受 `RUNTIME_ENV=development`，并要求
`AGENT_WORKER_TENANT_ID === DEV_AUTH_USER_A_TENANT_ID`。它用真实 PG、S3、CubeSandbox 和 Provider
装配。`MODEL_CONTEXT_WINDOW`、`MODEL_MAX_OUTPUT_TOKENS` 一直是必填配置；development 的 `/models`
只验证 `MODEL_ID` 存在，production 的 probe 仍要求窗口和最大输出 token 元数据精确一致。
本地 OpenAI-compatible Provider 与其模型描述同时固定为 Pi `openai-completions`，模型请求因此只走
`/chat/completions`；不能依据 `/models` 的成功把协议推断为 `openai-responses`。API key 仍只进入
Pi 的 Provider 凭据配置，显式 context window、最大输出 token 与受控工具清单不因协议切换而放宽。

Workspace revision 发布未完成前，继续依据 ADR-0038 对非空 `/workspace` 失败关闭；不把它表述为
Artifact 支持。

## 影响

- Windows 可启动真实 development Worker，工具副作用仍在 Linux CubeSandbox。
- Provider 的简化 `/models` 响应不会阻断本地纯聊天体验，但错误的显式预算仍由 Pi 的 admission
  control 保护；生产不受此放宽影响。
- 开发 Run 使用 Chat Completions 的 SSE 文本与工具调用协议，不再访问 Provider 不支持的
  `/responses`；该选择只适用于当前 development 装配，不代表生产协议协商。
- 生产 Worker 仍无可用入口，不能把 development 装配视为部署方案。

## 验证

- Pi/Faux 测试在 Windows 执行真实自定义 Sandbox 工具循环，断言文件只进入 Sandbox、Pi 内建工具
  不会进入能力清单，且模型上下文保留逻辑 `/workspace`；
- Worker 配置测试覆盖 development tenant 一致性、id-only `/models` 通过和 production 元数据拒绝；
- 本地 SSE Provider 测试覆盖 `/chat/completions` 端点、Bearer 凭据、模型预算、受控工具 schema，
  并验证分片 `tool_calls` 能还原成 Pi `toolUse`；
- `pnpm dev:worker:check` 只读探测真实依赖，测试断言其不会启动 polling 或领取 dispatch；
- 真实 Cube 的纵向脚本在 Windows Worker 上可连接 Linux Sandbox，仍在 finally 清理 Sandbox。

## 可逆性

若 Pi 将来把 cwd 用作不可关闭的宿主 I/O capability，应恢复平台保护或将 Worker 迁入 Linux 容器；
不得以重新启用 Pi 内建工具作为回退。Provider 若补齐标准元数据，可在 development 将检查收紧为与
production 相同，而不改变显式预算配置。
