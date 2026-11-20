# MCP 与外部工具接入规范

- 状态：草案
- 创建日期：2026-09-11
- 适用范围：`runtime-ts/packages/domain`、`persistence`、`protocol`、`admin-control`、`run-contracts`、`pi-adapter`、`prompt-builder`、`tool-router`、`runtime-ts/apps/api`、`agent-worker`、`admin-control-api`、`admin-web`
- 目标读者：负责外部工具接入、管理面发布、Run 快照、副作用授权与恢复的开发者与维护者
- 当前事实入口：[架构总览](../architecture/overview.md) · [Skill Runtime](../architecture/skill-runtime.md) · [仓库导览](../architecture/repository-map.md)

## 1. 生命周期与权威边界

本文是尚未实现的目标契约，说明 MCP Server 与其他外部工具接入必须满足的能力模型、边界、失败语义和验收，不描述当前已经具备的行为。当前模型只能使用内置工具集合，MCP 未接入，外部工具只有经 `@hoox/tool-router` 的 `deliver_file`。

全部切片实现并验证后，稳定的工具装配与副作用规则迁入[架构总览](../architecture/overview.md)与相应参考文档，本文转为“已完成”并退出目标规范索引。若命名、Transport 或 schema 转换结论改变，直接修订本文并在变更中说明原因。

## 2. 当前基线

Runtime 现在的工具装配链路是：

1. `@hoox/pi-adapter` 的 `pi-session.ts::buildSafeSessionMaterial` 组装 `customTools`：沙箱四工具（`exec_command`、`read`、`edit`、`write`）、`collapse_process_for_final_answer`、`skill`、`todo_write`、`deliver_file`、`automation_update` 与协作工具；显式 `enabledToolNames`（子 Session）会过滤沙箱工具与 `skill`，并整体关闭折叠、Todo、交付、自动化与协作工具，后两者只在 root Session 注册。
2. 同一组数组同时派生 System Prompt 的 `CAPABILITY_MANIFEST`、上下文预算使用的 `serializedToolDefinitions`、`deriveSafePiSessionCompatibility` 的 `toolSchemaHash`，并接受 `assertPiSessionCapabilityManifest` 的创建后断言。
3. `apps/agent-worker/src/pi-session-factory.ts` 为每个工具提供执行器端口：先持久化 `tool.started`，再领取并消费数据库一次性 `tool_execution` 许可，然后调用受控端口，最后写入固定受控回执。
4. `@hoox/context-policy` 的 `encodeControlledToolReceipt` 只保存 `toolName` 与 `outcome` 的固定回执；“模型可见的有界结果由工具适配器独立返回”，并作为 Thread Context 的 `tool_result` 事实保存。
5. `@hoox/run-contracts` 定义 `ExternalEffectCall`、`ExternalEffectPermit` 与 `AgentSessionFactoryPort.create` 的授权、Sandbox 准备和 Todo 写入端口；`@hoox/tool-router` 目前只导出 `deliver_file` 的路由、鉴权与错误归一化。

`@hoox/prompt-builder` 当前把能力数量限制为 64、单个能力 id 限制为 128 字节且字符集为 `[A-Za-z0-9._:-]`、单个描述限制为 2 KB；`@hoox/context-policy` 对工具名要求 `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`。新工具名必须同时满足两处约束。

## 3. 目标

- 平台管理员可以注册、校验、发布、撤销 MCP Server，以及被允许的外部工具，不改写模型可见契约以外的授权语义。
- 模型在 Run 内只能看到并调用该 Run 快照中已固定的工具，重试、恢复、waiting 回答与 Worker 重启都使用同一份清单。
- 每个外部调用都通过 Tool Router 与一次性许可，且可审计、可归类失败、结果未知时不重放。
- 凭据、Server 原始响应和敏感参数不进入 System Prompt、模型可见结果、日志与错误信息。
- MCP 工具的加入不改变既有 prompt/tool schema 字节稳定、上下文预算与 Rollout 恢复身份的不变量。

## 4. 非目标

- 首版不接入 MCP 的 Resources、Prompts、Sampling 与 Roots，只接入 `tools/list` 与 `tools/call`。
- 不允许用户或模型自定义即时生效的 MCP Server，也不做按轮动态发现。
- 首版不做交互式 OAuth 授权流程；远程凭据由管理面托管。
- 不允许 Agent Worker 宿主直接拉起 stdio Server；stdio 只能在 CubeSandbox 内运行，另行决策。
- 不在本规范内实现任意 HTTP 工具、Webhook 或用户脚本等非 MCP 外部能力的通用协议。

## 5. 能力模型

### 5.1 注册与发布

MCP 工具对哪个 Agent 可用，由 [AgentRevision 的外部工具白名单](custom-agent-platform.md#61-外部工具共同约束)决定，不再按租户或用户单独维护启用关系。

MCP Server 是可版本化配置：注册保存名称、Transport、地址、凭据引用、超时与响应上限；发布执行一次 `initialize` 与 `tools/list`，把每个受支持工具固化为不可变记录（工具名、描述、规范化 inputSchema、schema 摘要、是否声明幂等）。发布是原子操作：任一工具不符合 schema 子集即整体拒绝，不存在“部分工具已发布”的中间状态。

发布后的版本不可原地修改。更新 Server 需要创建新版本并重新发布，只影响之后创建的 Run。撤销版本对已有 Run 失败关闭，不静默替换成新版本。

### 5.2 Run 快照

Run 创建时按与 `RunSkillSnapshot` 同级的方式固定：启用 Server 的版本 id、工具白名单、每个工具的 schema 摘要，以及快照摘要。快照与 Rollout 兼容身份一起决定 Run 实际可用的工具集合。快照缺失、摘要不匹配或版本已撤销时失败关闭，不退回环境默认值。

### 5.3 工具命名与容量

模型工具名固定为 `mcp__<server>__<tool>`，按稳定字典序注册；Server 名与工具名先做字符集与长度规范化，保证组合名同时满足两处工具名约束。容量受三层限制：单 Server 工具数、单 Run MCP 工具数、单 Run 总能力数 64。任一层超限时，快照必须显式声明工具白名单，不能静默截断。

### 5.4 Schema 转换

外部 JSON Schema 只转换为 TypeBox 可表达的受控子集：object、string、number、integer、boolean、array、enum、required、`additionalProperties: false`。`$ref`、递归、`oneOf`、`anyOf`、`not` 以及未知关键字在发布期拒绝并记录原因，不降级为宽泛 schema。转换结果与摘要一起固化，Session 期不再重新读取 Server。

## 6. 执行边界

### 6.1 授权与调用顺序

每次调用必须保持现有顺序：持久化 `tool.started` → 领取并消费绑定 `callId`、工具名与 canonical 参数摘要的一次性许可 → 经 Tool Router 调用 → 返回有界模型可见结果并写入固定受控回执。缺少匹配的 `tool.started`、重复消费、许可过期、参数摘要不匹配或 Attempt version 推进都必须拒绝，并先生成 durable 失败回执。

### 6.2 传输与网络出口

首版只支持 Streamable HTTP。请求必须使用无凭据的 HTTPS URL、禁止重定向、有界连接与总超时、有界响应字节，并限制并发。应用层只校验地址与调用语义，出口限制由部署网络层统一实施，不新增第二套域名白名单真源。

### 6.3 凭据

凭据由管理面加密托管，后台只返回“是否已配置”。运行时按 Server 版本解析，只注入传输层请求头或协议字段，不进入模型请求、工具结果、日志与错误信息。凭据轮换不影响已有版本的可追溯性，也不允许模型选择或覆盖凭据。

### 6.4 失败语义

- 请求尚未写出就失败：可以返回可纠正的失败结果，不越过副作用边界。
- 请求已写出后超时、连接重置或进程中断：一律视为结果未知，Attempt 进入恢复，不自动重放。结果未知后只有经显式对账、且持久事实确认原工具版本、canonical 参数摘要与幂等键一致才可重试；Worker 再投递与 Transport 不得自行重放。
- 服务端返回协议错误或工具级错误：归一化为受控错误码与中文提示，不原样透出服务端响应。
- 幂等重试只允许在发布期声明幂等且复用同一幂等键时进行。

### 6.5 观测与上下文

模型可见结果必须有界；durable Rollout 仍只保存 `ControlledToolReceipt`，需要保留完整外部输出时走独立有界 trace blob 端口，不能把服务端原文无界写入 Rollout。MCP 结果与描述都是低信任数据，不进入平台规范，也不能被声明为新的工具、授权或身份。

## 7. 管理面

管理面需要提供：Server 草稿与凭据写入、发布前探测、发布、查看版本与工具清单、撤销与重新发布、在 Agent 编辑页挑选已发布的工具版本，以及调用量、失败率与结果未知率的可观测入口。管理面不返回凭据明文，不允许用户自行修改 transport 或绕过发布流程。

## 8. 实施切片与实现状态

| 切片 | 状态 | 主要位置 | 验收 |
| --- | --- | --- | --- |
| 领域与持久化 | 未开始 | `@hoox/domain`、`@hoox/persistence` 迁移与 RLS | Server 版本、工具描述、Run 快照的不可变性与 Tenant 隔离测试 |
| 管理面 | 未开始 | `@hoox/protocol`、`@hoox/admin-control`、`admin-control-api`、`admin-web` | 发布原子性、凭据不回显、撤销失败关闭 |
| Run 快照 | 未开始 | `apps/api` Run 创建、`@hoox/run-contracts`、`@hoox/persistence` | 跨恢复 `toolSchemaHash` 一致、后续发布不影响已有 Run |
| Pi 工具协议 | 未开始 | `@hoox/pi-adapter` 新工具工厂、`pi-session.ts` 注册 | schema 固定、manifest 派生、非法参数回执 |
| 执行路由 | 未开始 | `@hoox/tool-router`、`apps/agent-worker/src/pi-session-factory.ts` | 许可绑定、参数摘要、结果未知不重放 |
| Transport 客户端 | 未开始 | 新 MCP 客户端模块或包 | 超时、响应上限、协议错误归一化 |
| 协作与提示词边界 | 未开始 | `@hoox/run-contracts` 子 Agent 白名单、`@hoox/prompt-builder` 版本 | 子 Agent 只能按显式授权下放；Prompt 变更同步版本与测试 |

## 9. 验收门槛

- 发布期测试覆盖 schema 子集接受与拒绝、名称规范化、容量上限、凭据不回显。
- Run 快照测试证明同一 Run 跨重试、恢复与 Worker 重启使用同一工具清单与 `toolSchemaHash`，且快照缺失或撤销时失败关闭。
- 授权测试证明所有调用都经过一次性许可与参数摘要校验，缺少或重复许可被拒绝且形成 durable 失败回执。
- 故障注入证明请求写出后的结果未知进入恢复且不自动重放，声明幂等的工具复用同一幂等键。
- 子 Agent 白名单测试证明 MCP 工具不能由模型自行扩大或递归下放。
- 使用真实 MCP Server 完成发布、调用、撤销与恢复冒烟，并确认 System Prompt 与工具 schema 在同配置下字节稳定。
