# 可定制 Agent 平台规范

- 状态：草案
- 创建日期：2026-11-19
- 适用范围：`runtime-ts/packages/domain`、`persistence`、`protocol`、`run-contracts`、`prompt-builder`、`pi-adapter`、`tool-router`、`skill`、`identity`、`admin-control`、`trajectory`，以及 `runtime-ts/apps/api`、`agent-worker`、`scheduler`、`admin-control-api`、`admin-web`、`web`
- 目标读者：参与把 Hoox 演进为“可定制云端 Agent 平台”的开发者、维护者和协作智能体
- 实施顺序：[可定制 Agent 平台实施计划](../plans/20261119-custom-agent-platform.md)
- 当前事实入口：[架构总览](../architecture/overview.md) · [Prompt 与模型交互](../architecture/prompt-and-model-io.md) · [Skill Runtime](../architecture/skill-runtime.md) · [后台控制面](../architecture/admin-control-plane.md) · [MCP 与外部工具接入规范](mcp-and-external-tool-integration.md)

## 1. 生命周期与权威边界

本文定义 Hoox 产品方向和跨模块目标契约，不描述当前已经具备的行为。各能力的实现状态以[实施计划](../plans/20261119-custom-agent-platform.md)和当前说明为准。

某一部分实现并验证后，稳定的约束迁入 `docs/architecture` 中对应的现状文档（新增 `agent-definition.md` 等主题文档），本文相应章节删除或缩减为链接。全部能力完成后，本文退出规范索引。实施中若发现本文的选择不可行，先修订本文并在 PR 描述中写明原因，再改代码；不得在代码中悄悄偏离。

MCP 接入的细节契约由 [MCP 与外部工具接入规范](mcp-and-external-tool-integration.md) 拥有，本文只规定它与 Agent Definition 的关系。

## 2. 产品方向

**Hoox 是一个开源、可自托管的云端 Agent 平台。其他公司或开发者在 Hoox 上编写指令（system prompt）、接入自己的工具、上架自己的 Skill，就能得到一个运行在云端沙箱中的专属 Agent，并通过 Hoox 工作台或 API 交付给他们的用户。**

这里的“云端”指 Agent 在服务端隔离沙箱中执行，不在终端用户电脑上运行，也不访问终端用户的本地文件系统。

目标用户使用 Hoox 有三种方式，优先级从高到低：

| 方式 | 典型用户 | 需要 Hoox 提供 |
| --- | --- | --- |
| A. 后台配置，直接用 Hoox 工作台交付 | 企业内部团队、希望快速上线的业务方 | 后台编辑 Agent、不改代码接入工具、工作台选择 Agent、品牌定制 |
| B. 把 Hoox 当作 Agent 后端（Headless） | 有自己产品和前端的公司 | 服务凭据、稳定公开 API、终端用户映射、事件流、Webhook、客户端工具、SDK |
| C. Fork 并修改代码 | 需要深度定制的开发者 | 稳定的 Provider 与工具扩展点及其文档 |

A 和 B 的共同要求是**不修改 Hoox 代码**。凡是 A、B 用户需要改代码才能完成的定制，都视为平台缺口。

现有的可靠执行、恢复、多租户隔离和 Tool Router 边界，是“为什么可以放心把业务 Agent 放在 Hoox 上”的支撑，不是对外的首要卖点。对外宣传、README、Landing 和文档都按本节的方向组织，并且只宣传已经实现的能力（见[第 11 节](#11-对外表述)）。

## 3. 当前差距

| 目标能力 | 当前事实 | 差距 |
| --- | --- | --- |
| 后台编辑 system prompt | `@hoox/prompt-builder` 中的 Platform Harness 是固定文本，包含 Hoox 身份和中文回复要求；Tenant、Skill、User 内容只能作为低信任上下文注入 | 没有可信的 Operator 指令层，身份和语言无法按 Agent 配置 |
| 一个安装内有多个 Agent | 模型、工具调用模式和 `enabledTools` 是全安装级运行设置 | 没有 Agent 对象，Thread 和 Run 无法区分属于哪个 Agent |
| 不改代码接入工具 | 只有内置工具；MCP 只有未实现的草案 | 没有外部工具运行路径 |
| 上架 Skill | Skill 中心、精确版本安装和 `RunSkillSnapshot` 已具备；只有平台 Skill 管理员能发布 | 缺 Agent 自带 Skill，以及开发者自助发布 |
| Headless 接入 | 浏览器使用 Hoox Session，非浏览器调用方只有 JWT 兼容后备；SSE 事件流已存在 | 缺服务凭据、外部用户映射、Webhook、客户端工具、OpenAPI 和 SDK |
| 测试 Agent 效果 | 只能在工作台手动对话 | 缺草稿版本、Playground、工具 Mock 和评测集 |
| 观测 Agent 行为 | 持久事件、内部轨迹查看器、模型报文诊断和 Token 聚合指标面向维护者；控制面统计不能读取 Prompt 和模型正文 | 缺按 Agent 维度的运行浏览、受审计的内容访问、成本、反馈和外部导出 |

## 4. 核心概念

### 4.1 命名

现有代码中的 `AgentThread` 表示 Run 内的 Root 或子 Agent 对话，与本文的新概念不同。为避免混淆，新概念固定命名为：

- **AgentDefinition**：一个可交付的 Agent，有稳定 ID、名称和可用范围。
- **AgentRevision**：AgentDefinition 的不可变版本，承载全部行为配置。
- **RunAgentSnapshot**：Run 创建时固定的 AgentRevision 引用及其摘要。

代码、数据库、协议和文档中不得用裸 `Agent` 指代 AgentDefinition。

### 4.2 AgentRevision 内容

一个 AgentRevision 包含：

| 字段组 | 内容 | 约束 |
| --- | --- | --- |
| 身份 | 显示名称、简介、头像引用、欢迎语、建议问题 | 只用于展示；显示名称可以进入 Operator 指令 |
| 指令 | Operator 指令正文、回复语言 | 有字节上限；不得包含请求级动态数据 |
| 模型 | 模型 Provider Revision 引用与模型 ID，或“跟随平台默认” | 引用已保存的模型配置，不内嵌凭据 |
| 工具 | 内置工具子集、外部工具版本白名单（MCP、HTTP）、客户端工具声明、工具调用模式 | 内置工具不得超出平台允许的上限名单 |
| Skill | Agent 自带的精确 Skill 版本；是否允许叠加 Tenant 已安装 Skill | 自带 Skill 与 Tenant Skill 合并后写入 `RunSkillSnapshot` |
| 执行环境 | Sandbox 模板引用、空闲策略 | 受平台 Sandbox 配置约束 |
| 记忆 | 是否启用长期记忆 | 受平台记忆配置约束 |

AgentRevision 发布后不可原地修改。修改即创建新的草稿 Revision，发布后成为该 AgentDefinition 的当前版本。

### 4.3 生命周期

- **草稿**：只对 Agent 管理员可见，可以在 Playground 中运行，不能被工作台或公开 API 选择。
- **已发布**：每个 AgentDefinition 最多一个当前已发布 Revision；新 Run 使用它。
- **停用**：AgentDefinition 停用后不能创建新 Run；在途 Run 按快照继续完成。
- **紧急撤销**：撤销某个 Revision 后，使用它的在途 Run 在下一个安全点失败关闭，不静默替换为其他 Revision。

发布、停用和撤销使用与现有控制面相同的幂等键、`expectedGeneration` 和审计。

### 4.4 所有权与可用范围

首个版本中，AgentDefinition 归平台所有，由具有 Agent 管理角色的管理员创建和发布，模式与 Skill 中心一致。每个 AgentDefinition 声明可用范围：全部 Tenant，或指定的个人/团队 Tenant。Tenant 自己拥有和发布 Agent 不在首个版本范围内（见[第 12 节](#12-待决问题)）。

安装初始化和迁移必须创建一个内置的**默认 Agent**，其指令、工具和模型设置与当前行为等价。已有 Thread 绑定到默认 Agent。默认 Agent 可以编辑，但不能删除。

### 4.5 Thread 与 Run 的绑定

- Thread 创建时绑定一个 AgentDefinition，之后不可更改。
- 每个 Run 创建时，在与 `RunSkillSnapshot` 相同的事务边界内写入 `RunAgentSnapshot`，固定当时已发布的 AgentRevision。
- 同一 Run 的重试、恢复 Attempt 和子 Agent 只读取快照，不反查当前 Revision。快照缺失或摘要不匹配时失败关闭。
- 同一 Thread 的后续 Run 可以使用更新后的 Revision。历史中出现当前 Revision 不再提供的工具调用时，上下文按历史事实呈现，不得让模型以为该工具仍可调用。

## 5. 指令与提示词分层

模型可见内容按信任从高到低分为四层：

1. **Platform Harness**：平台固定规范，只保留安全规则、工具协议、交付规则等与具体业务无关的内容。不包含 Agent 名称、品牌和回复语言。
2. **Operator 指令**：来自 AgentRevision，由 Agent 管理员编写，可信度低于 Platform Harness、高于下面所有层。它可以定义角色、业务规则、语气和语言，但不能新增工具、授权、Tenant 身份，也不能声明自己覆盖平台规范。
3. **能力清单与 Skill 目录**：由本次 Session 实际注册的工具和 `RunSkillSnapshot` 派生。
4. **低信任上下文**：Tenant、Skill、个性化与用户内容，规则保持[现状](../architecture/prompt-and-model-io.md#信任分层)不变。

缓存约束：

- Platform Harness、Operator 指令和工具 Schema 都放在 system/developer 前缀；同一 AgentRevision 在相同能力配置下必须字节稳定。
- Operator 指令不得包含模板变量或请求级数据（用户名、时间、Tenant 名、文件名等）。需要这些信息时，通过最新 user turn 的结构化内容或可读取资源提供。
- `RUNTIME_PROMPT_VERSION` 在 Harness 拆分时提升版本；Prompt 摘要包含 AgentRevision 摘要。
- 默认 Agent 的 Operator 指令承接当前 Harness 中的 Hoox 身份和中文回复要求，使默认 Agent 的模型可见行为与现状等价。

## 6. 工具接入

所有工具，无论来源，都必须经过 `@hoox/tool-router`、一次性执行许可和 durable 回执，遵守现有的字节稳定、上下文预算与恢复不变量。Agent 管理员只能从已发布的工具版本中选择，模型不能在运行时发现或注册工具。

| 方式 | 适用场景 | 执行位置 | 规范 |
| --- | --- | --- | --- |
| 内置工具 | 文件、命令、交付、Todo、协作 | 平台与 Sandbox | 现有实现 |
| 远程 MCP | 已有 MCP Server 的服务 | 外部 Server，经 Streamable HTTP | [MCP 规范](mcp-and-external-tool-integration.md) |
| HTTP 工具 | 业务方后端暴露的普通 HTTP 接口 | 业务方后端 | 本节 6.2 |
| 客户端工具 | 必须在调用方系统内执行的操作 | 调用方，经公开 API 回传结果 | 本节 6.3 |
| Sandbox 内工具 | 脚本、CLI、领域软件 | 自定义 Sandbox 模板与 Skill 脚本 | 现有 Skill 与 Sandbox 能力 |

### 6.1 外部工具共同约束

- 外部工具定义是带版本的平台配置：发布时固化名称、描述、规范化 inputSchema、摘要、超时、响应上限、副作用等级和是否幂等。发布后不可原地修改。
- 工具名、Schema 子集、容量上限沿用 [MCP 规范](mcp-and-external-tool-integration.md#53-工具命名与容量)。HTTP 工具名固定为 `http__<tool>`。
- AgentRevision 引用外部工具版本；MCP 规范中“按租户或用户的启用关系”由 AgentRevision 白名单取代。
- 凭据由管理面加密托管，只写不读，不进入模型请求、工具结果、日志与错误。
- 出站请求只允许 HTTPS，禁止重定向，拒绝回环、链路本地和私有网段目标，除非部署显式放行。
- 请求写出后超时、断连或进程中断，一律视为结果未知，Attempt 进入恢复，不自动重放；只有声明幂等并复用同一幂等键时才能重试。
- 工具结果是低信任数据，模型可见部分必须有界。

### 6.2 HTTP 工具

- 业务方提供 OpenAPI 片段或逐个声明的端点、方法、参数 Schema 和凭据引用。
- Hoox 以 JSON 发送参数，并附带签名头，包括 HMAC 签名、时间戳、幂等键，以及 Tenant、终端用户、Thread、Run 的不透明标识，供业务方鉴权与审计。签名密钥按工具版本独立。
- 响应只接受有界 JSON 或文本；非 2xx 响应归一化为受控错误码与提示，不原样透出响应正文。

### 6.3 客户端工具

- AgentRevision 声明客户端工具的名称、描述和 Schema，Hoox 不持有它们的执行端点。
- 模型调用客户端工具时，Run 进入 `waiting`，通过事件流和 Webhook 发出 `requires_action`，其中包含工具调用 ID 和参数。
- 调用方通过公开 API 提交结果；提交按工具调用 ID 幂等。超过等待时限时写入失败回执，由模型决定后续动作。
- 客户端工具的副作用由调用方负责；Hoox 只保证同一调用 ID 的结果只被接受一次。

## 7. Skill

- 现有 Skill 中心、精确版本安装和 `RunSkillSnapshot` 保持为唯一的 Skill 事实源。
- AgentRevision 可以自带精确 Skill 版本，并声明是否叠加 Tenant 已安装的 Skill。Run 创建时两者合并写入 `RunSkillSnapshot`；同名冲突时 Agent 自带版本优先，并在快照中记录来源。
- 开发者自助发布：在平台 Skill 管理员之外，增加可按命名空间授权的 Skill 发布者角色。发布仍然经过包校验，不因此获得额外工具权限。
- Skill 不扩张工具或权限的约束保持不变。

## 8. Headless 接入

### 8.1 服务凭据

- 新增 Tenant 持有的 API Key，带作用域（读 Thread、创建 Run、提交工具结果、管理 Webhook 等）、到期时间和备注。
- 只保存哈希，明文只在创建时显示一次；支持轮换与吊销，所有使用记录可审计。
- API Key 认证后，服务端仍然从 Membership 和 PostgreSQL RLS 重建 `TenantScope`，不新增绕过 RLS 的路径。

### 8.2 终端用户映射

业务方的终端用户不一定是 Hoox 账号。公开 API 允许 API Key 携带业务方的终端用户 ID，由 Hoox 映射到内部 User 并按需创建。目标是让不同终端用户的 Thread、Workspace、记忆默认相互隔离。具体映射模型是待决问题，见[第 12 节](#12-待决问题)。

### 8.3 公开 API

- 在 `/v1` 下提供有稳定性承诺的公开 API：列出可用 Agent、按 Agent 创建 Thread、提交输入并创建 Run、上传文件、订阅事件（SSE）、提交客户端工具结果、取消 Run、列出和下载 Artifact。
- 请求与响应 Schema 从 `@hoox/protocol` 生成 OpenAPI 文档，不手写第二份契约。
- 公开 API 与工作台使用的内部接口分开标注；只有公开 API 进入兼容性承诺。破坏性变更只能通过新版本路径发布。

### 8.4 Webhook

- Tenant 注册 Webhook 地址与订阅的事件类型：Run 进入 `waiting`/`requires_action`、成功、失败、取消，以及 Artifact 发布。
- 投递经数据库 Outbox，至少一次投递，带事件 ID、HMAC 签名和时间戳；接收方按事件 ID 去重。
- 失败按退避重试；超过上限后停用该 Webhook，并在后台显示原因。

### 8.5 SDK 与嵌入

- 首先提供 TypeScript SDK，包括类型、SSE 续连和客户端工具回传辅助。其次提供 Python SDK。
- 可嵌入的聊天组件排在 SDK 之后，复用工作台的对话展示组件。

## 9. 测试与评测

### 9.1 Playground

- 后台可以选择任意 AgentRevision（包括草稿）直接对话。旁边实时展示执行轨迹，包括模型调用、工具调用、耗时与 Token。
- Playground 的 Run 标记 `origin=playground`，运行在执行者自己的空间中；它们不进入业务指标，也不能被终端用户看到。
- 外部工具和客户端工具可以在 Playground 中配置 Mock 返回值。Mock 只对 `origin=playground` 生效，已发布 Revision 的正常 Run 永远不读取 Mock。

### 9.2 评测集

- 评测集由用例组成。每个用例包括输入、附件和断言。
- 确定性断言：是否产出符合名称或类型的 Artifact、是否调用或未调用某工具、最终回复是否匹配文本规则。
- 模型评分断言：使用后台指定的评审模型和评分标准打分，记录评分理由。
- 评测运行把一个评测集批量运行在指定 AgentRevision 上，Run 标记 `origin=eval`，并发受独立上限约束。结果可以按 Revision 对比。
- 可以从真实 Thread 保存为用例；这会复制输入和附件，必须由有权查看该内容的管理员执行并留下审计。
- 发布时可以选择要求通过某评测集，作为发布门槛。

## 10. 观测

- **Run 浏览器**：在后台按 AgentDefinition、Revision、Tenant、状态、来源（正常、Playground、评测、API）筛选 Run；详情页展示时间线、模型调用、工具调用、错误、耗时和 Token。数据来自现有持久事件与轨迹，不建第二个事实源。
- **内容访问权限**：现有控制面统计只能读取聚合视图，不读取 Prompt 和模型正文。查看 Run 正文是一项新的显式权限，只授予 Agent 管理相关角色，每次访问写入审计。没有该权限的管理员只能看到结构和指标。
- **指标与成本**：在现有 Token 指标基础上增加 AgentDefinition 和 Revision 维度，以及成功率、失败率、结果未知率、工具失败率、延迟分位数和平均轮次。成本按模型配置中的单价计算。
- **终端用户反馈**：工作台和公开 API 支持对 Run 点赞、点踩并附言，反馈关联到 Run 和 Revision。
- **外部导出**：按 OpenTelemetry GenAI 语义约定导出 Span 和指标，供业务方接入自有观测平台。默认不导出 Prompt 和正文，开启需要显式配置。
- **数据保留**：轨迹正文和诊断数据按部署配置的保留期清理，不因观测需求无限保留。

## 11. 对外表述

- 定位统一为：**开源、可自托管的云端 Agent 平台。写好指令、接上你的工具、上架 Skill，就是你自己的专属 Agent。** README、Landing、`package.json#description`、GitHub 描述保持一致。
- 文档按开发者旅程组织：快速开始（构建你的第一个 Agent）→ 概念（AgentDefinition、工具、Skill、Thread、Run、Artifact）→ 指南（编写指令、接入 MCP/HTTP 工具、发布 Skill、测试与评测、观测、通过 API 嵌入产品）→ 参考（公开 API、Agent 配置格式）。现有架构文档继续面向贡献者。
- 只把已经实现并验证的能力写成现在时；尚未实现的能力只能出现在路线图中，并标明阶段。“生产就绪”的表述限制继续遵守[首次公开发布检查清单](../maintainers/open-source-release-checklist.md#对外表述)。

## 12. 待决问题

以下问题在对应工作包开工前必须由维护者确定，并把结论写回本文：

| 问题 | 建议 | 影响的工作包 |
| --- | --- | --- |
| AgentDefinition 归平台还是归 Tenant | 首版归平台，Tenant 只获得使用范围；之后再评估 Tenant 自建 | A1、A4 |
| 终端用户映射模型 | 每个“业务方应用”对应一个 Tenant 下的集成身份，终端用户 ID 映射为内部 User，默认每人一个个人空间；业务方的组织映射为团队空间 | C3 |
| Thread 是否锁定 Revision | 不锁定，每个 Run 使用当时已发布的 Revision | A3 |
| Agent 配置文件格式 | YAML，顶层 `schemaVersion: 1`，凭据只写引用 | E1 |
| 成本单价来源 | 模型配置中增加可选的输入、输出、缓存单价 | D3 |

## 13. 验收门槛

- 默认 Agent 的 Prompt 字节与迁移前的模型可见语义等价，有 Golden Test 证明。
- 同一 Run 跨重试、恢复、子 Agent 和 Worker 重启都使用同一 `RunAgentSnapshot`；发布新 Revision 不影响在途 Run；快照缺失或被撤销时失败关闭。
- Operator 指令不能使模型获得 AgentRevision 之外的工具；有测试覆盖指令中自称“系统”或“平台”的越权文本。
- 同一 AgentRevision 在相同能力配置下的 system 前缀与工具 Schema 字节稳定。
- 外部工具和客户端工具的结果未知、重复提交、超时和凭据不回显都有故障注入测试。
- API Key 认证后的所有访问都经过 RLS；跨 Tenant 访问统一返回 404。
- Webhook 至少一次投递、签名校验与停用路径有测试。
- Playground Mock 不会影响正常 Run，有测试证明。
- 内容访问有审计；无权限的管理员看不到 Run 正文。
- 每项能力实现后，对应的现状文档、参考文档和对外文档已更新。
