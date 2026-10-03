# ADR-20260911162421：MCP 与外部工具接入采用发布期固化与 Run 快照

- 状态：提议
- 日期：2026-09-11
- 决策者：Runtime 维护者
- 关联任务：MCP 与外部工具接入设计
- 关系：沿用 [ADR-0024](0024-artifact-tool-authorization-and-production-gaps.md) 的「Pi 只定义工具协议、Tool Router 单向依赖」、[ADR-0029](0029-trusted-prompt-and-session-capability-manifest.md) 的「能力清单从真实注册工具派生」与 [ADR-0173](0173-external-effect-permit-consumption-recovery.md) 的「不确定外部调用不得重放」；沿用 [ADR-20260826155935](20260826155935-custom-provider-probes-use-saved-url.md) 的「管理员保存的地址经校验后直接作为出口目标，由部署网络层统一限制出口」边界；不改变 [Skill Runtime](../architecture/skill-runtime.md) 中 Skill 不能动态增加工具的结论。

## 背景

Runtime 的模型工具集合当前在 `runtime-ts/packages/pi-adapter/src/pi-session.ts` 的 `buildSafeSessionMaterial` 中静态装配，包含沙箱四工具、`skill`、`todo_write`、`deliver_file`、`automation_update` 与协作工具。System Prompt 的 `CAPABILITY_MANIFEST`、上下文预算使用的工具 schema 序列化、`RolloutCompatibilityIdentity.toolSchemaHash` 以及创建 Session 后的 manifest 断言全部从这同一组工具派生；除 `deliver_file` 外，`@hoox/tool-router` 尚未承载外部工具调用。

MCP Server 可以在任何时刻通过 `tools/list` 改变工具名、描述和 JSON Schema，而描述是模型可见文本。若按轮发现并注入工具集合，会同时破坏三件事：相同能力配置下 prompt 与 tool schema 的字节稳定性、Rollout 恢复身份，以及「模型只能执行平台已登记能力」的边界。外部工具还引入凭据托管、网络出口与不可重放副作用三个新的跨模块边界。

## 约束

- 权限与身份：模型与服务端参数都不能决定 MCP Server、租户或凭据；启用关系和凭据只能来自平台管理面与认证上下文。
- 副作用边界：所有外部效果必须经 `@hoox/tool-router` 和数据库签发的一次性 `tool_execution` 许可，禁止 Worker 或 Pi 适配器直接出网。
- 缓存与恢复：同一 Run 的重试、恢复、waiting 回答和 Worker 重启必须使用同一份工具清单与 schema，不能用服务端最新状态替换；相同能力配置下 System Prompt 与工具 schema 保持字节稳定。
- 不可信输入：MCP 服务端返回的工具名、描述、schema 与调用结果都是低信任数据，不能进入平台规范或扩权路径。
- 失败语义：请求已写出后的超时、连接重置或进程中断都属于结果未知，除发布期声明幂等并复用同一幂等键外不得自动重试。
- 供应链：MCP 客户端如引入第三方源码或依赖，必须固定精确版本、保留许可证与来源说明，并通过供应链与 SBOM 门禁。

## 备选方案

### 方案 A：按轮动态发现 MCP 工具并注入当前 Session

模型每轮都能看到最新工具。但服务端任意变更都会改写 System Prompt 与工具 schema，使 provider 前缀缓存、`toolSchemaHash` 恢复兼容和「注册即授权」同时失效；被撤销的工具也可能因缓存继续可达。不采用。

### 方案 B：只注册一个固定的 `mcp` 工具，参数携带 Server、工具名与原始 arguments

工具 schema 与平台配置完全解耦，字节稳定性最好。但模型失去逐工具的参数约束和描述，只能靠目录文本手写参数，工具选择与参数正确率显著下降；目录若放进 System Prompt 又回到方案 A 的问题。仅作为「未审阅或数量无界的 Server」的兜底形态保留，不作为首版主路径。

### 方案 C：发布期固化、Run 快照、会话期静态注册

管理面注册与发布时一次性读取 Server 能力并固化为不可变版本，Run 创建时固定启用版本与工具白名单，Session 只按快照生成工具。代价是新增发布流程、版本存储与快照链路；收益是复用现有五条不变量，且不需要改动模型请求的时序语义。采用。

## 决策

1. 能力模型分四段：注册（管理面保存 Server 配置与加密凭据）、发布固化（发布时执行一次 `initialize` 与 `tools/list`，把受支持工具固化为不可变 Server 版本）、Run 快照（Run 创建时固定 Server 版本与工具白名单）、会话期静态注册（Worker 只按快照生成工具并加入现有 `customTools`）。
2. 模型工具名使用 `mcp__<server>__<tool>`，按稳定字典序注册，并同时满足 `@hoox/prompt-builder` 与 `@hoox/context-policy` 的工具名格式与长度约束。
3. 工具 schema 只接受受控 JSON Schema 子集（object、string、number、integer、boolean、array、enum、required、`additionalProperties: false`）；`$ref`、递归、`oneOf`、`anyOf` 等结构在发布期拒绝，不降级为宽泛 schema。能力数量、单工具描述与 schema 字节、单 Run 总 schema 字节都设上限，超限时必须改为显式白名单。
4. 每次调用沿用现有顺序：持久化 `tool.started` → 领取并消费一次性 `tool_execution` 许可 → 经 Tool Router 调用 → 写入固定受控回执。MCP 返回的模型可见内容有界，durable Rollout 仍只保存 `ControlledToolReceipt`。
5. 请求已写出后的结果未知一律失败关闭为恢复，不自动重放；幂等重试只在发布期声明且复用同一幂等键时允许。
6. 凭据由管理面加密托管、运行时按需解析，只注入传输层，不进入 prompt、工具结果、日志或错误信息。
7. 第一阶段只支持 Streamable HTTP。stdio 型 Server 只能在 CubeSandbox 内运行，另行决策；不允许 Agent Worker 宿主直接拉起外部进程。

## 理由

方案 C 把「服务端可变」与「模型可见契约」在发布边界上解耦：Session 期不再访问 Server 元数据，因此 System Prompt、工具 schema、上下文预算和恢复兼容身份仍然从同一组真实注册工具派生，不需要为 MCP 引入例外。方案 A 的失败模式是多模块返工与安全回退，方案 B 的失败模式是可用性，因此首版选 C，并把 B 留作明确的降级形态。

## 影响

### 正面影响

- 保持现有 prompt/tool schema 稳定、预算与恢复身份派生的单一事实源。
- MCP 工具与内置工具走同一条授权、观测、恢复链路，不需要第二套副作用模型。
- Server 版本不可变，历史 Run 的调用行为可追溯、可复现。

### 负面影响

- 新增管理面发布流程、版本存储与 Run 快照，实施成本高于纯客户端接入。
- Server 更新需要重新发布并影响之后创建的 Run，已有 Run 不追随新版本。
- 逐工具展开会增加 System Prompt 与工具 schema 体积，需要数量与字节上限。

### 安全与隐私

- 服务端描述属于模型可见文本，只能在发布审阅后进入工具定义；不进入 `<PLATFORM_HARNESS>`。
- 凭据不回显、不入日志；调用参数摘要进入许可绑定，避免参数被替换后复用许可。
- 出口限制由部署网络层统一实施，应用层只做 HTTPS、禁止重定向、超时与响应大小约束。

### 数据、兼容与迁移

- 新增 Server 版本、工具描述与 Run 快照表，只向前迁移。
- 不接入 MCP 时工具集合与现有兼容身份不变；已创建 Run 的快照不因后续发布或撤销被改写。
- 第三方客户端的工具名、描述或 schema 变化只影响新发布版本与新 Run。

### 运维与可观测性

- 需要发布探测失败、调用失败、结果未知与许可拒绝的可观测分类，且错误信息不得回显凭据与完整服务端响应。
- 需要按 Server 版本统计调用量、失败率与结果未知率，作为撤销与容量判断依据。

## 验证

- 发布期测试覆盖 schema 子集接受与拒绝、名称规范、数量与字节上限、凭据不回显。
- Run 快照测试证明同一 Run 跨重试、恢复与 Worker 重启使用同一工具清单与 `toolSchemaHash`，后续发布不影响已有 Run。
- 授权测试证明缺少或未消费许可、参数摘要不匹配、`callId` 重放都被拒绝，且拒绝前已形成 durable 失败回执。
- 故障注入覆盖请求写出后连接重置，证明结果为未知时进入恢复且不自动重放。
- 子 Agent 工具白名单测试证明 MCP 工具只能按显式授权下放。
- 使用真实 MCP Server 完成发布、调用与恢复冒烟。

## 可逆性

不接入 MCP 时现有行为不变。回退实现可以停止注册 MCP 工具并保留 Server 版本与 Run 快照数据；已发布的版本、快照与调用事实不删除，不需要数据回滚。若后续改变命名、schema 转换或 Transport 结论，需要新增 ADR 替代本文，不能就地改写已接受结论。
