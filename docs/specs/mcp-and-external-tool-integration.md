# MCP 与外部工具接入规范

- 状态：实施中；版本存储、凭据加密、MCP/HTTP Transport、Run 快照读取与 Session 装配已实现；管理面部分实现，端到端验收待完成
- 创建日期：2026-09-11
- 适用范围：`runtime-ts/packages/domain`、`persistence`、`protocol`、`admin-control`、`run-contracts`、`pi-adapter`、`prompt-builder`、`tool-router`、`runtime-ts/apps/api`、`agent-worker`、`admin-control-api`、`admin-web`
- 目标读者：负责外部工具接入、管理面发布、Run 快照、副作用授权与恢复的开发者与维护者
- 当前事实入口：[架构总览](../architecture/overview.md) · [Skill Runtime](../architecture/skill-runtime.md) · [仓库导览](../architecture/repository-map.md)

## 1. 生命周期与权威边界

本文定义 MCP Server 与其他外部工具接入的目标能力模型、边界、失败语义和验收。各切片状态见第 8 节；管理面发布不自动授予 Run 或 Pi Session 调用权限，工具还必须由 AgentRevision 白名单选定并固定到 Run 快照。Worker 只按 Run 快照读取版本并校验未撤销状态，凭据仅在 Worker 内解密，工具执行经 Tool Router。当前读取授权与执行边界分别见[外部工具快照读取](../architecture/agent-definition.md#外部工具快照读取)和[外部工具装配边界](../architecture/tool-calling-modes.md#外部工具装配边界)。

全部切片实现并验证后，稳定的工具装配与副作用规则迁入[架构总览](../architecture/overview.md)与相应参考文档，本文转为“已完成”并退出目标规范索引。若命名、Transport 或 schema 转换结论改变，直接修订本文并在变更中说明原因。

## 2. 当前基线

Runtime 现在的工具装配链路是：

1. `@hoox/pi-adapter` 的 `pi-session.ts::buildSafeSessionMaterial` 组装 `customTools`：沙箱四工具（`exec_command`、`read`、`edit`、`write`）、`collapse_process_for_final_answer`、`skill`、`todo_write`、`deliver_file`、`automation_update`、协作工具与按 Run 快照固定的外部工具；显式 `enabledToolNames`（子 Session）会过滤沙箱工具与 `skill`，并整体关闭折叠、Todo、交付、自动化与协作工具，后两者只在 root Session 注册。外部工具默认不下放，子 Session 只能装配显式授权的精确版本。
2. 同一组数组同时派生 System Prompt 的 `CAPABILITY_MANIFEST`、上下文预算使用的 `serializedToolDefinitions`、`deriveSafePiSessionCompatibility` 的 `toolSchemaHash`，并接受 `assertPiSessionCapabilityManifest` 的创建后断言。
3. `apps/agent-worker/src/pi-session-factory.ts` 为每个工具提供执行器端口：先持久化 `tool.started`，再领取并消费数据库一次性 `tool_execution` 许可，然后调用受控端口，最后写入固定受控回执。
4. `@hoox/context-policy` 的 `encodeControlledToolReceipt` 只保存 `toolName` 与 `outcome` 的固定回执；“模型可见的有界结果由工具适配器独立返回”，并作为 Thread Context 的 `tool_result` 事实保存。
5. `@hoox/run-contracts` 定义 `ExternalEffectCall`、`ExternalEffectPermit` 与 `AgentSessionFactoryPort.create` 的授权、Sandbox 准备和 Todo 写入端口；`@hoox/tool-router` 提供 `deliver_file` 与外部工具的路由、鉴权、错误归一化，以及 MCP/HTTP Transport。

`@hoox/prompt-builder` 当前把能力数量限制为 64、单个能力 id 限制为 128 字节且字符集为 `[A-Za-z0-9._:-]`、单个描述限制为 2 KB；`@hoox/context-policy` 对工具名要求 `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`。新工具名必须同时满足两处约束。

## 3. 目标

- 平台管理员可以注册、校验、发布、撤销 MCP Server，以及被允许的外部工具，不改写模型可见契约以外的授权语义。
- 模型在 Run 内只能看到并调用该 Run 快照中已固定的工具，重试、恢复、waiting 回答与 Worker 重启都使用同一份清单。
- 每个外部调用都通过 Tool Router 与一次性许可，且可审计、可归类失败、结果未知时不重放。
- 凭据与敏感参数不进入 System Prompt、日志与错误信息。Server 原始响应经过有界检查后，未命中凭据回显检测的正文可作为模型可见结果；疑似回显整体扣留，但仍记录调用成功，并提示模型勿重试。
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

凭据由管理面加密托管，后台只返回“是否已配置”。运行时按 Server 版本解析，只注入传输层请求头或协议字段，不直接进入模型请求、日志与错误信息。交付工具结果前，Router 检测凭据及认证材料的原文、反转、URL 编码、Base64/Base64URL、十六进制、JSON 转义等常见表示；JSON 结果另检查解析后的全部字符串键和值。命中时正文整体扣留，但远端调用可能已产生副作用，因此记录成功回执，模型收到 `withheld: EXTERNAL_TOOL_CREDENTIAL_ECHO` 与固定提示“外部工具调用已成功，但响应疑似包含凭据，正文已扣留，请勿重试。”；未命中则正常公开有界业务正文，字面脱敏保留为辅助。检测无法覆盖任意变换，端点仍不得把凭据作为业务结果返回。凭据轮换不影响已有版本的可追溯性，也不允许模型选择或覆盖凭据。

### 6.4 失败语义

- 请求尚未写出就失败：可以返回可纠正的失败结果，不越过副作用边界。
- 请求已写出后超时、连接重置或进程中断：一律视为结果未知，Attempt 进入恢复，不自动重放。结果未知后只有经显式对账、且持久事实确认原工具版本、canonical 参数摘要与幂等键一致才可重试；Worker 再投递与 Transport 不得自行重放。
- 服务端返回协议错误或工具级错误：归一化为受控错误码与中文提示，不原样透出服务端响应。
- 幂等重试只允许在发布期声明幂等且复用同一幂等键时进行。

### 6.5 观测与上下文

模型可见结果必须有界；durable Rollout 仍只保存 `ControlledToolReceipt`，需要保留完整外部输出时走独立有界 trace blob 端口，不能把服务端原文无界写入 Rollout。MCP 结果与描述都是低信任数据，不进入平台规范，也不能被声明为新的工具、授权或身份。

## 7. 管理面

平台管理员管理 Server 草稿与只写凭据，查看逐工具探测报告，按批次原子发布、查看工具版本、撤销与重新发布。Agent 编辑者只能选择已发布且未撤销的版本，Agent Revision 写入和发布时由服务端重新校验引用。HTTP 工具可从端点声明或 OpenAPI 片段预览；不可变版本已支持记录 HTTP 方法，但管理面仍仅提供 HTTP 预览，未开放 HTTP 发布。当前权限和事务边界见[平台控制面](../architecture/admin-control-plane.md#外部工具注册边界)。管理面还应提供调用量、失败率和结果未知率的可观测入口。

## 8. 实施切片与实现状态

| 切片 | 状态 | 主要位置 | 验收 |
| --- | --- | --- | --- |
| 领域与持久化 | 已实现，端到端验收待完成 | `@hoox/domain`、`@hoox/persistence` 迁移与 RLS | Server 版本、工具描述、Run 快照不可变性、Runtime 受限视图权限与 Tenant 隔离测试 |
| 管理面 | 部分实现 | `@hoox/protocol`、`@hoox/admin-control`、`admin-control-api`、`admin-web`、`@hoox/persistence` | MCP 草稿与只写凭据、逐工具探测、批次原子发布与撤销、命令审计、Agent 选择与服务端引用复核已接入；凭据不回显、撤销失败关闭；HTTP 仅预览，调用指标待接入 |
| Run 快照 | 已实现，端到端验收待完成 | `apps/api` Run 创建、`@hoox/run-contracts`、`@hoox/persistence` | 跨恢复 `toolSchemaHash` 一致、后续发布不影响已有 Run |
| Pi 工具协议 | 已实现，端到端验收待完成 | `@hoox/pi-adapter` 新工具工厂、`pi-session.ts` 注册 | 按字典序注册、schema 固定、manifest 派生、非法参数回执 |
| 执行路由 | 已实现，端到端验收待完成 | `@hoox/tool-router`、`apps/agent-worker/src/pi-session-factory.ts` | 许可绑定、参数摘要、结果未知不重放 |
| Transport 客户端 | 已实现（本地假服务验收中） | `@hoox/tool-router` MCP Streamable HTTP 与 HTTP 客户端 | 本地假 Server 覆盖初始化、清单探测、调用、Schema 拒绝、受控协议错误、响应上限与未知结果；真实 MCP Server 冒烟待验证 |
| 协作与提示词边界 | 已实现，端到端验收待完成 | `@hoox/run-contracts` 子 Agent 白名单、`@hoox/prompt-builder` 版本 | 子 Agent 默认不下放，显式授权绑定精确版本 ID；恢复保持授权且跨 Run 只取精确版本交集；Prompt 变更同步版本与测试 |

## 9. 验收门槛

- 发布期测试覆盖 schema 子集接受与拒绝、名称规范化、容量上限、凭据不回显。
- Run 快照测试证明同一 Run 跨重试、恢复与 Worker 重启使用同一工具清单与 `toolSchemaHash`，且快照缺失或撤销时失败关闭。
- 授权测试证明所有调用都经过一次性许可与参数摘要校验，缺少或重复许可被拒绝且形成 durable 失败回执。
- 故障注入证明请求写出后的结果未知进入恢复且不自动重放，声明幂等的工具复用同一幂等键。
- 子 Agent 白名单测试证明 MCP 工具不能由模型自行扩大或递归下放。
- 使用真实 MCP Server 完成发布、调用、撤销与恢复冒烟，并确认 System Prompt 与工具 schema 在同配置下字节稳定。
