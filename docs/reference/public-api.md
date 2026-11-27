# 公开 API v1

本文面向以服务凭据集成 Hoox 的部署方开发者，是 `/v1` 公开 API 的稳定接口参考。只有本页及[机器可读 OpenAPI](openapi/public-v1.json)列出的接口属于兼容承诺；同前缀的工作台、控制台、WebDAV 和其他内部路由不因此对 API Key 开放。

TypeScript 接入可使用[SDK 使用说明](sdk-typescript.md)，包含流式续连、客户端工具辅助与最小 Node 示例。

## 认证与空间边界

请求使用平台管理员在后台按空间创建的 API Key，通过 Bearer 认证。Key 的空间由服务端凭据解析，不接受调用方用 `X-Tenant-Id` 切换；跨空间或不存在的资源统一返回 404。每个公开路由还要求对应作用域：

| 作用域 | 可调用接口 |
| --- | --- |
| `threads:read` | Agent 列表、Thread 列表与查询 |
| `threads:create` | 创建 Thread |
| `runs:read` | Run 查询、分页事件、SSE、Artifact 列表与交付 |
| `runs:create` | 创建和取消 Run、上传文件 |
| `tool-results:submit` | 提交客户端工具调用结果 |
| `end-users:represent` | 允许携带 `Hoox-End-User` 代表终端用户；仍需接口本身的作用域 |

认证失败返回 401；有效 Key 但作用域不足返回 403。Key 管理、Webhook 管理、登录会话、团队成员管理及工作台专用接口不接受 API Key。服务端继续从集成身份的 Membership 构造 TenantScope，并在 PostgreSQL RLS 下访问数据。

```sh
export HOOX_API_ORIGIN="https://hoox.example.com"
export HOOX_API_KEY="hoox_sk_REPLACE_WITH_SECRET"
```

## 健康检查

健康检查不使用 `/v1` 前缀，也不要求 API Key。直连进程时使用 `/live`（进程存活）和 `/ready`（依赖就绪）；Demo 经反向代理使用 `/api/live` 与 `/api/ready`，没有 `/api/v1/live`。Demo 的 `HOOX_API_ORIGIN` 为 `https://hoox.aisay.cc/api`。

## 终端用户映射

部署方服务端可在任意公开 API 请求携带单个 `Hoox-End-User` 请求头，值为其业务系统中的终端用户 ID。Key 必须同时具有 `end-users:represent` 和目标接口要求的作用域，否则返回 403。人类登录会话不能使用此声明；重复请求头、空值或格式错误返回 400。请求体不接受终端用户身份字段。用 curl 测试显式空值时，使用 `-H 'Hoox-End-User;'`；`-H 'Hoox-End-User:'` 不会发送该头。

ID 区分大小写，为 1–128 个 ASCII 字符：首字符是英文字母或数字，其余可为英文字母、数字、`.`、`_`、`:`、`@`、`/`、`-`，不接受空白、控制字符或逗号。不应把密码、邮箱验证码或访问令牌用作 ID；服务端日志不记录 API Key 明文。

首次声明时，平台原子创建内部 User、个人空间、Owner Membership 和映射；重复及并发声明返回同一身份。命名空间是 Key 所属的**空间**：同一空间下不同 Key（包括不同后台创建者创建的 Key）对相同外部 ID 返回同一 User 与个人空间；不同空间的相同外部 ID 相互隔离。Key 的轮换、吊销与新建不会改变空间级映射身份，但每个请求仍须通过当前 Key 的作用域、有效期和集成身份状态校验。

携带声明的请求始终以映射 User 和个人空间执行，Thread、Run、Workspace、记忆、文件和幂等键均位于该空间，继续接受 Membership 与 PostgreSQL RLS 授权。不同终端用户以及原集成身份默认不能看到彼此数据；个人空间也不会继承 Key 所属空间的成员关系或限定空间的 Agent 使用权。若发送 `X-Tenant-Id`，其值仍只能是 Key 原属空间，不能借此选择映射空间或其他空间。

未携带声明时保留集成身份及其原属空间，不会自动选择某个终端用户。创建、查询、上传、下载与 SSE 重连都必须重复携带同一个 `Hoox-End-User`，否则将访问另一个空间并通常返回 404。部署方必须先验证自身终端用户身份，再由可信服务端选择该 ID；不能把具有代用户作用域的 Key 发给终端用户或直接信任浏览器传来的身份声明。

映射 User 没有登录账号、密码或工作台 Session，不能直接登录工作台。平台管理员可在后台「用户管理」按外部 ID 或内部 User ID 查找，来源标注为「API 映射」，可停用或恢复。停用后后续携带该映射声明的请求返回 403；恢复不创建新身份或空间。Key 吊销、到期或集成 Membership 失效后，也不能通过该 Key 使用映射。停用不取消已被接受的 Run，也不撤回已签发的短期下载 URL。

```sh
curl --fail-with-body -sS "$HOOX_API_ORIGIN/v1/threads" \
  -H "Authorization: Bearer $HOOX_API_KEY" \
  -H 'Hoox-End-User: customer:42'
```

## 接口

| 方法与路径 | 作用域 | 用途 |
| --- | --- | --- |
| `GET /v1/agents` | `threads:read` | 列出当前空间可用 Agent |
| `POST /v1/threads` | `threads:create` | 创建 Thread，可指定可用 Agent |
| `GET /v1/threads` | `threads:read` | 游标分页列出 Thread |
| `GET /v1/threads/{threadId}` | `threads:read` | 查询 Thread |
| `GET /v1/threads/{threadId}/runs` | `runs:read` | 查询该 Thread 最近 Run |
| `POST /v1/threads/{threadId}/runs` | `runs:create` | 创建 Run 并提交初始输入 |
| `GET /v1/threads/{threadId}/runs/{runId}` | `runs:read` | 查询 Run |
| `DELETE /v1/threads/{threadId}/runs/{runId}` | `runs:create` | 请求取消 Run |
| `GET /v1/threads/{threadId}/runs/{runId}/feedback` | `runs:read` | 读取当前终端用户的反馈（需 `Hoox-End-User`） |
| `PUT /v1/threads/{threadId}/runs/{runId}/feedback` | `runs:create` | 创建或修改当前终端用户反馈（评分 `up`/`down`，可选附言最多 2000 字符） |
| `DELETE /v1/threads/{threadId}/runs/{runId}/feedback` | `runs:create` | 撤销当前终端用户反馈 |
| `GET /v1/threads/{threadId}/runs/{runId}/events` | `runs:read` | 按序号分页读取事件 |
| `GET /v1/threads/{threadId}/runs/{runId}/events/stream` | `runs:read` | SSE 订阅与续连 |
| `POST /v1/threads/{threadId}/runs/{runId}/tool-results` | `tool-results:submit` | 按调用 ID 回传执行结果（仅 API Key） |
| `POST /v1/resources/uploads` | `runs:create` | 上传不超过 16 MiB 的文件 |
| `GET /v1/resources/{resourceId}/versions/{versionId}/download` | `runs:read` | 获取短时效下载 URL |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts` | `runs:read` | 列出已发布 Artifact |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/preview` | `runs:read` | 安全预览 Artifact |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/download` | `runs:read` | 获取 Artifact 下载交付 |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/content` | `runs:read` | 读取有界原始字节 |

反馈通过 `Hoox-End-User` 映射到集成身份下的终端用户；每位用户对同一 Run 只有一条反馈。API Key 请求缺少该头返回 `400 INVALID_REQUEST`，有效声明但作用域不足仍返回 `403 FORBIDDEN`。API 响应只返回当前用户自己的反馈，Run 不存在、不可见或来源为 Playground/评测时返回 `404`。公开 API Schema 及 SDK 类型以 OpenAPI 文档为准。

Run 在公开 API 入口创建时，来源由服务端持久化为 `api`；客户端不能在请求体中指定来源。创建 Thread、创建 Run 和上传文件都要求 `Idempotency-Key`；工具回传按 `callId` 去重。相同 Key 与相同请求载荷重放原结果；相同 Key 携带不同载荷返回 409。创建 Thread、创建 Run 和回传工具结果使用 `application/json`，上传使用 `application/octet-stream`；其他媒体类型返回 415。

## 创建 Thread 与 Run

```sh
thread=$(curl --fail-with-body -sS "$HOOX_API_ORIGIN/v1/threads" \
  -H "Authorization: Bearer $HOOX_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: onboarding-thread-0001' \
  -d '{"title":"客户调研","agentDefinitionId":"agent_public_id"}')
thread_id=$(printf '%s' "$thread" | jq -r '.data.id')

curl --fail-with-body -sS "$HOOX_API_ORIGIN/v1/threads/$thread_id/runs" \
  -H "Authorization: Bearer $HOOX_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: onboarding-run-000001' \
  -d '{"input":"整理这份客户访谈的主要需求。"}'
```

Thread 创建、Run 创建与文件上传使用同一个幂等键重试时，请保持有效载荷不变。相同键用于不同载荷返回 `409 CONFLICT`（`retryable: false`）；需要发起不同的操作时使用新键。

创建 Run 的输入上限为 1 MiB UTF-8。Thread/Run 列表以 `items` 返回；Thread 分页使用 `cursor` 和 `limit`，Thread 的 Run 列表返回最近窗口并使用 `limit`，事件使用 `after` 和 `limit`。仅 Thread 列表提供可续接 `nextCursor`；不能把 Run 最近窗口当作完整历史分页。

## 文件与 Artifact

上传时通过 `X-File-Name` 指定 URL 编码的文件名，可选 `X-File-Media-Type` 指定媒体类型；请求正文是原始字节，最大 16 MiB；超限返回 `413 PAYLOAD_TOO_LARGE`。响应包含 `resourceId` 与 `versionId`。下载文件与 Artifact 时，Hoox 先按当前认证上下文的有效空间授权（携带终端用户声明时为该用户个人空间），再返回短期 URL 或有界内容；不得长期保存或记录签名 URL。Artifact 仅列出已发布的交付物，预览类型和大小受限。

```sh
curl --fail-with-body -sS "$HOOX_API_ORIGIN/v1/resources/uploads" \
  -H "Authorization: Bearer $HOOX_API_KEY" \
  -H 'Content-Type: application/octet-stream' \
  -H 'Idempotency-Key: upload-brief-000001' \
  -H 'X-File-Name: brief.txt' \
  -H 'X-File-Media-Type: text/plain' \
  --data-binary @brief.txt
```

## SSE 事件续连

流响应使用 `text/event-stream`。每个 `run-events` 批次都有 SSE `id`，有事件时格式为 `{attemptId}-{sequence}`，序号取自最后一条事件。连接建立或 Run 快照变化时也可能收到 `items: []`；它复用当前游标，若尚无事件则使用 `{attemptId}-start`（未分配 Attempt 时为 `pending-start`）。`-start` 表示从序号 0 开始读取，不计为已消费的事件。空闲时服务端发送注释心跳，不改变游标。

断线重连时将最近处理完的批次 ID 放入 `Last-Event-ID`；也可用 `after` 与 `attemptId` 查询参数显式指定游标，两者同时提供时以请求头为准。Attempt 变化时服务端从新 Attempt 起点补读。流会在 Run 结束、等待外部动作或达到单次连接时限时发送不带 `id` 的 `end` 事件；`reason: renew` 表示客户端可带最后游标重新连接。

```sh
curl -N "$HOOX_API_ORIGIN/v1/threads/$thread_id/runs/$run_id/events/stream" \
  -H "Authorization: Bearer $HOOX_API_KEY" \
  -H 'Last-Event-ID: attempt_example-12'
```

## 执行客户端工具并回传

在 SSE 的 `run-events` 批次中查找 `page.items[].type === "requires_action"`，或订阅 [Webhook](webhooks.md) 的 `run.requires_action`。每条调用给出 `threadId`、`runId`、`callId`、`toolName`、`arguments` 和 UTC `deadline`（SSE 位于 `payload`，Webhook 位于 `data`）。普通 `run_waiting` 不是执行指令。调用方按 `runId + callId` 去重并自行授权、执行操作；不要把模型提供的参数当成身份或授权，也不要在日志中记录参数正文。

```sh
curl --fail-with-body -sS "$HOOX_API_ORIGIN/v1/threads/$thread_id/runs/$run_id/tool-results" \
  -H "Authorization: Bearer $HOOX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"callId":"client_REPLACE_WITH_CALL_ID","outcome":"succeeded","result":"订单已确认"}'
```

`outcome` 为 `succeeded` 或 `failed`；`result` 为 UTF-8 文本，最多 1 MiB，不接受 NUL 或无效 Unicode。模型最多读取每条结果的前 8192 字节；截断不拆开字符，回执带 `truncated` 标记。传 JSON 结果时先序列化为文本。服务端按完整文本和 `outcome` 比对重试，不要求 `Idempotency-Key`。首次接受和相同重试均返回 `200` 与 `data: {callId, accepted: true}`，更改内容、已超时或已取消返回 `409`。调用或父资源不存在、不可见时返回 `404`。使用终端用户映射时，必须带创建 Run 时相同的 `Hoox-End-User`，并同时持有代用户作用域。

一个 turn 可以发出多条调用，全部有回执（含超时）后才恢复同一个 Run；截止后调用方不能用迟到结果覆盖超时。waiting 时 SSE 会以 `end` 结尾，回传后仍用原 Run 地址续连。客户端只负责提交结果，不应再创建 Run。

## 错误与版本

JSON 成功响应统一为 `{ "version": "v1", "requestId": "…", "data": … }`；错误响应统一为 `{ "version": "v1", "requestId": "…", "error": { "code": "…", "message": "…", "retryable": false } }`。错误码包括 `INVALID_REQUEST`、`PAYLOAD_TOO_LARGE`、`UNSUPPORTED_MEDIA_TYPE`、`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`AGENT_REVISION_UNAVAILABLE`、`INVALID_STATE`、`RATE_LIMITED`、`DEPENDENCY_UNAVAILABLE` 和 `INTERNAL`。内部异常、凭据明文和对象存储签名信息不进入错误正文或日志。

兼容性契约由 `runtime-ts/packages/protocol` 的 TypeBox Schema 拥有。OpenAPI 3.1 产物位于 `docs/reference/openapi/public-v1.json`；运行 `pnpm api:openapi:generate` 生成，CI 通过 `pnpm api:openapi:check` 校验。破坏性变化通过新版本路径发布。
