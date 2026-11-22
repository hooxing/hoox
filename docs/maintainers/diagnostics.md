# 诊断指南

本页面向维护者，描述 Development 的模型网络报文和内部轨迹查看，以及 Worker 的 OpenTelemetry 导出。诊断数据可能包含完整 Prompt、思考、工具参数、模型生成的 Tool Call 和模型可见回执，必须按敏感用户数据处理。

## 模型网络报文诊断

该能力默认关闭。需要区分“模型生成的工具参数有误”和“工具内部执行失败”时，在本机 `.env` 中显式设置：

```dotenv
MODEL_WIRE_TRACE_ENABLED=true
MODEL_WIRE_TRACE_RETENTION_DAYS=7
MODEL_WIRE_TRACE_MAX_BYTES=1048576
```

修改后必须重启 Worker；运行中的进程不会动态开启采集。

- `MODEL_WIRE_TRACE_RETENTION_DAYS` 决定新记录的到期时间。
- `MODEL_WIRE_TRACE_MAX_BYTES` 是每个 request 正文的独立字节上限。
- 超限只保存精确前缀并标记为 `truncated`。
- 原始 response 正文（包括完整 SSE、截断片段和非 2xx 正文）不再复制、旁路读取或保存到 PostgreSQL/MinIO 与本地镜像；思考、回复、Tool Call 和工具结果仍由轨迹事件保留。
- Fetch 在返回响应前拒绝或中止时仍保存无正文的稳定失败类别，并向调用方原样抛回错误；响应开始后的断流由 Provider/轨迹事件报告，不再另存原始响应片段。
- 采集关闭期间的旧 Run 无法事后重建精确请求；未保存的原始 response 也无法从轨迹事件还原为逐字节报文。
- 采集端口不接收 HTTP headers，因此不会保存 Authorization、Cookie 或 Provider 密钥。

## 本地镜像目录

在 development 中，Worker 会 best-effort 将采集内容镜像到：

```text
model-wire-traces/<runId>/<attemptId>/
```

典型文件：

```text
model-turn-00-transport-0-request-complete.json
runtime-event-00000003-agent_event.json
startup-timings.json
phase-timing-00000001.json
```

`startup-timings.json` 记录 Worker 开始领取 Run 到首个 Provider 请求即将发起之间的总耗时，以及 claim、个性化、记忆、停止点、AgentSupervisor、Skill 恢复、Observation、Thread 历史、Runtime compaction、Pi Session 创建、模型阶段持久化、输入准备和模型许可等低基数阶段。它不保存 Prompt、工具参数或用户正文；若 Run 在首模前失败，则在 Run 收口时保存截至失败点的部分快照。

`phase-timing-*.json` 在同一诊断开关下记录整个 Attempt 的内部阶段。每条包含 Run/Thread/Attempt、独立序号、阶段名、开始时间、持续时间、调用结果，以及可选工具调用 ID；不包含工具参数、文件路径、正文或凭据。持续时间使用单调时钟，开始时间只用于定位；创建至领取阶段例外，使用同一数据库时钟的 `Run.createdAt` 与 claim 时间之差。它包含调度、领取以及重试前的累计等待，不能当作纯 Broker 排队时间。

| 阶段 | 边界与解释 |
| --- | --- |
| 沙箱获取 | 生命周期 acquire 总调用，包含创建/连接、资源准备及相关持久化；子阶段不可重复加到总计 |
| 沙箱创建、连接／自动恢复 | Provider create/connect 的调用时间；底层自动恢复若不可单独观测，不伪造独立恢复耗时 |
| 沙箱初始化、资源准备和验证 | 初始化器、资源目录挂载/物化、数据面探测分别计时；未执行的可选步骤不生成记录 |
| 工作区恢复、历史目录准备、结果校验 | 分别对应 manifest 物化、历史入口准备和输出 revision 校验 |
| 工具调用持久化、环境准备、授权、执行、回执持久化 | 关联工具调用 ID；执行阶段在准备和授权后计时，文件编辑锁等待不包含在执行时间内 |
| 交付文件读取、上传及稳定引用持久化、元数据提交 | 读取包含工作区打开和文件检查；上传阶段是 Blob writer 完整调用，包含稳定引用持久化，不等于纯网络上传 |
| 运行状态持久化、沙箱收尾 | mutation/readback 每次调用与沙箱终态处理；不代表所有数据库访问或整个 Run 收尾时间 |

阶段的 `succeeded/failed` 仅表示被测调用正常返回或抛出，业务失败返回值仍须结合原始日志判断。嵌套与并行阶段不能直接求和。诊断写入失败被隔离，不改变工具授权、操作结果或恢复流程；收口会等待已提交的诊断写入。通用 production 不装配该本地镜像，受控 Demo 沿用既有 development 诊断装配，不新增开关或开放接口。

文件使用同目录临时文件和原子发布；相同字节可以幂等重放，不同字节不会覆盖已有文件。本地镜像写入在首模边界异步启动，失败不阻塞 Provider 请求，也不改变模型调用或 PostgreSQL/MinIO 持久化结果。

该目录已被 Git 忽略，但不提供 ACL、自动删除或 retention 保证。PostgreSQL/MinIO 是产品能力的权威存储；production 不创建本地镜像。

## Web 中查看

普通用户工作台不提供模型报文入口，也不轮询诊断 API。维护者通过下方内部轨迹查看器查看 Attempt、模型轮次 `modelTurn`、同轮 HTTP 重试 `transportAttempt` 及 request 原文。

request 是交给 Fetch 的最终 application request body，不是由 payload 对象重建的 JSON。模型返回内容从轨迹中的思考、回复、Tool Call 和工具结果查看。

## 诊断 API

```http
GET /v1/threads/:threadId/runs/:runId/model-wire-traces?limit=500
GET /v1/threads/:threadId/runs/:runId/model-wire-traces/:attemptId/:modelTurn/:transportAttempt/:part/body
```

第一个端点返回元数据并使用 `nextCursor` 分页；第二个端点读取 request 或 response 的 `application/octet-stream` 原始正文。接口沿用认证、Tenant Membership/RLS 和 Thread/Run 归属校验，不返回 S3 URL。

该 API 保留旧 response 记录的读取兼容性和既有到期清理语义，不代表仍在新增采集 response。历史 PostgreSQL/MinIO 数据不做批量删除，也不修改已发布 migration。

## 内部轨迹查看器

产生诊断记录后运行：

```powershell
corepack pnpm dev:trajectory
```

默认地址：

```text
http://127.0.0.1:4188
```

查看器从仓库根目录 `model-wire-traces` 聚合 durable Run 事件，展示近似模型步骤、思考、回复、工具生命周期、Attempt 状态、稳定错误类别和 request 原文。`Model wire` 只列出 request；所有历史 response 文件均不列出，直接请求查看器文件 API 也返回 404。旧文件保留在原目录，不由查看器删除。

development 管理 Web 的“数据运营”页显示“打开内部轨迹”链接。该链接在新窗口打开回环地址，不把轨迹正文交给 Admin API；仍需维护者单独启动上述命令。

Demo 不部署查看器；旧 `/trajectory/` 只重定向到后台运行记录。完整逻辑轨迹按 Attempt 写入配置的 S3/MinIO 对象存储，由后台按管理员权限、独立审计和字节受限分页读取；数据库仅保存索引与保留元数据。Worker 可在 development 额外写入本地镜像供本机查看器使用，该镜像不是后台数据源。轨迹保留期由 Scheduler 全局清理，默认 30 天；清理目录只暴露 Tenant ID，不使用 Worker Coordinator 身份。

可覆盖参数：

```powershell
corepack pnpm dev:trajectory -- --port 4190
corepack pnpm dev:trajectory -- --root <受控目录>
```

查看器按 Thread 聚合 Run；Runtime 元数据不可用时，使用本地阶段记录或旧 `startup-timings.json` 中的匹配上下文回退分组。没有真实标题时显示 Thread ID，没有上下文的旧记录仍按 Run 展示，不从用户输入猜测标题。

Attempt 下拉框支持切换单次 Attempt，默认组合各 Run 的最新 Attempt。内部阶段表和“阶段计时”下载保留阶段明细；旧日志没有采集的阶段显示“未采集”，不补零。Session log 下载继续保留原始事件格式。

“模型流生成”为 assistant `message_start` 到 `message_end` 的累计时间；“模型等待”为各轮 `turn_start` 到首个 assistant `message_start` 的已采集等待，包含请求准备及首响应等待，不是精确 HTTP TTFT。完全缺少等待边界时显示空值。轨迹跨度来自内部事件的单调时钟范围，不能当作服务端完整 Run 总耗时。只有旧版 Runtime 镜像时才使用文件 mtime 做近似定位。

## 后台运行记录

管理 Web 的“运行记录”是所有部署的统一 Run 调试入口。列表按用户问题或 Thread 标题搜索，并显示 Agent、用户、状态、时间、耗时与 Token；详情直接展示持久事件中的思考、回复、工具参数与结果、错误及 Attempt 时间线。每次管理员详情读取均静默写入正文访问审计。权限边界见[后台控制面与运行配置](../architecture/admin-control-plane.md#run-浏览器与正文访问)。

已发布 Demo 的 `/trajectory/` 与 `/trajectory` 仅兼容重定向到 `/admin/runs`，不再运行轨迹 Web 服务。本地 development 仍可按需运行 `corepack pnpm dev:trajectory` 检查 Worker 在 `model-wire-traces` 下的诊断镜像；这些本地镜像包含额外的 Pi 原始事件、request 原文和内部阶段计时，不属于 PostgreSQL Run 事实，也不进入后台详情。后台逻辑轨迹保留在共享对象存储中，过期后由 Scheduler 清理；pending Blob 在确认提交状态并释放引用前不会删除索引锚点。

## 安全约束

- 本地查看器只允许绑定本机回环地址，不得代理或转发到远程网络。
- 通用 production 与 Demo 部署均不得嵌入或代理本地查看器；Demo 的旧路径仅用于跳转后台运行记录。
- 禁止将 `model-wire-traces`、截图或正文粘贴到公开 Issue。
- 删除诊断数据前确认相关故障证据已经完成受控留存。
- 关闭 `MODEL_WIRE_TRACE_ENABLED` 只停止新增采集，不自动删除既有记录。
- production 在保留清理 consumer 完成部署前若开启该变量，Worker 应在触达外部依赖之前失败关闭。

## 导出到 OpenTelemetry

Agent Worker 默认不导出。将以下配置注入 Worker 并重启，连接支持 OTLP/HTTP protobuf 的后端或 Collector；[配置契约](../reference/configuration.md#worker-opentelemetry-配置)列出了认证、采样和正文选项。

```dotenv
OTEL_EXPORT_ENABLED=true
OTEL_EXPORT_ENDPOINT=https://otel-collector.example.invalid
OTEL_EXPORT_CONTENT_ENABLED=false
```

在后端按 `service.name=hoox-agent-worker` 查找：

- 每个已领取并通过栅栏快照校验的 Attempt 有一个 `invoke_agent` 根 Span。子 Span 包括实际 Provider 流调用（含子 Agent 和模型压缩调用）以及已确认开始的工具调用。`hoox.run.id`、`hoox.attempt.id`、`hoox.thread.id`、`hoox.tenant.id` 是供关联的不透明 ID。`hoox.outcome` 区分 `success`、`failure`、`unknown`；等待用户输入是正常的 Attempt 收口，不代表 Run 成功。工具缺少确认的结束事件或受控回执结果未确认时标记 `unknown`。
- `hoox.run.completed` 统计 Worker 确认终态的 Run；`hoox.run.failed` 只统计已确认失败的 Run。`hoox.run.attempt.completed` 统计 Attempt 收口，等待和恢复不计入 Run 完成数。延迟见 `gen_ai.invoke_agent.duration` 和 `gen_ai.client.inference.duration`，输入与输出 Token 见 `gen_ai.client.inference.usage.input_tokens` 和 `gen_ai.client.inference.usage.output_tokens`。指标不带租户、Thread、Run 或 Attempt ID。
- Span 队列满时查看 `otel.sdk.processor.span.processed` 的 `error.type=queue_full`；采集层丢弃、网络发送失败和接收端报告的部分拒绝见 `hoox.otel.export.unsent`。这些计数不会写入 Run。Worker 不补传丢失的 Span；进程退出时在总关闭预算内最多等待遥测刷新 3 秒。若收集端始终不可用，计数也可能无法送达。

只在获准处理租户正文的后端启用 `OTEL_EXPORT_CONTENT_ENABLED`。正文包括 Provider 层的系统指令、文本消息、模型输出与工具调用内容；原生工具在 Worker 已有事件提供正文时附带参数和成功结果的文本。PTC 子工具在 Worker 只有结构化开始、完成事实，不补采正文。导出不包含模型认证、请求头、原始网络报文、图像或附件字节以及模型思考内容。单个正文属性超过 8 KiB 时省略。这些正文仍可能含敏感信息，删除与保留由接收端负责。此开关与 `MODEL_WIRE_TRACE_ENABLED` 无关。

## 其他排障入口

- API：`/live` 与 `/ready`。
- 统一 Admin API（默认 `127.0.0.1:3003`）：`/live` 与 `/ready`。
- CubeSandbox：`CUBESANDBOX_API_URL` 后加 `/health`。
- MinIO：`S3_ENDPOINT` 后加 `/minio/health/live`。
- Worker 外部依赖只读检查：`corepack pnpm dev:worker:check`。

对外部问题创建公开 Issue 前必须删除凭据、签名 URL、对象键、用户正文、数据库连接信息和内部网络地址。
