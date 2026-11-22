# 公开 API v1

本文面向以服务凭据集成 Hoox 的部署方开发者，是 `/v1` 公开 API 的稳定接口参考。只有本页及[机器可读 OpenAPI](openapi/public-v1.json)列出的接口属于兼容承诺；同前缀的工作台、控制台、WebDAV 和其他内部路由不因此对 API Key 开放。

## 认证与空间边界

请求使用平台管理员在后台按空间创建的 API Key，通过 Bearer 认证。Key 的空间由服务端凭据解析，不接受调用方用 `X-Tenant-Id` 切换；跨空间或不存在的资源统一返回 404。每个公开路由还要求对应作用域：

| 作用域 | 可调用接口 |
| --- | --- |
| `threads:read` | Agent 列表、Thread 列表与查询 |
| `threads:create` | 创建 Thread |
| `runs:read` | Run 查询、分页事件、SSE、Artifact 列表与交付 |
| `runs:create` | 创建和取消 Run、上传文件 |
| `runs:read` | 查询 Run/事件/Artifact、下载文件 |

认证失败返回 401；有效 Key 但作用域不足返回 403。Key 管理、Webhook 管理、登录会话、团队成员管理、客户端工具结果提交及工作台专用接口不接受 API Key。服务端继续从集成身份的 Membership 构造 TenantScope，并在 PostgreSQL RLS 下访问数据。

```sh
export HOOX_API_ORIGIN="https://hoox.example.com"
export HOOX_API_KEY="hoox_sk_REPLACE_WITH_SECRET"
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
| `GET /v1/threads/{threadId}/runs/{runId}/events` | `runs:read` | 按序号分页读取事件 |
| `GET /v1/threads/{threadId}/runs/{runId}/events/stream` | `runs:read` | SSE 订阅与续连 |
| `POST /v1/resources/uploads` | `runs:create` | 上传不超过 16 MiB 的文件 |
| `GET /v1/resources/{resourceId}/versions/{versionId}/download` | `runs:read` | 获取短时效下载 URL |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts` | `runs:read` | 列出已发布 Artifact |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/preview` | `runs:read` | 安全预览 Artifact |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/download` | `runs:read` | 获取 Artifact 下载交付 |
| `GET /v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/content` | `runs:read` | 读取有界原始字节 |

Run 在公开 API 入口创建时，来源由服务端持久化为 `api`；客户端不能在请求体中指定来源。Run、Thread、上传和 Run 创建都要求 `Idempotency-Key`。相同 Key 与相同请求载荷重放原结果；相同 Key 携带不同载荷返回 409。Thread 与 Run 创建、上传要求 `application/json`（上传除外）或 `application/octet-stream`（上传），其他媒体类型返回 415。

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

创建 Run 的输入上限为 1 MiB UTF-8。Thread/Run 列表以 `items` 返回；Thread 分页使用 `cursor` 和 `limit`，Thread 的 Run 列表返回最近窗口并使用 `limit`，事件使用 `after` 和 `limit`。仅 Thread 列表提供可续接 `nextCursor`；不能把 Run 最近窗口当作完整历史分页。

## 文件与 Artifact

上传时通过 `X-File-Name` 指定 URL 编码的文件名，可选 `X-File-Media-Type` 指定媒体类型；请求正文是原始字节。响应包含 `resourceId` 与 `versionId`。下载文件与 Artifact 时，Hoox 先按当前 Key 所属空间授权，再返回短期 URL 或有界内容；不得长期保存或记录签名 URL。Artifact 仅列出已发布的交付物，预览类型和大小受限。

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

流响应使用 `text/event-stream`，每个事件批次都提供 SSE `id`，其格式为 `{attemptId}-{sequence}`。断线重连时将最近收到的 ID 放入 `Last-Event-ID`；也可用 `after` 与 `attemptId` 查询参数显式指定游标。Attempt 变化时服务端从新 Attempt 起点补读。流会在 Run 结束或达到单次连接时限时发送 `end` 事件；`reason: renew` 表示客户端可带最后游标重新连接。

```sh
curl -N "$HOOX_API_ORIGIN/v1/threads/$thread_id/runs/$run_id/events/stream" \
  -H "Authorization: Bearer $HOOX_API_KEY" \
  -H 'Last-Event-ID: attempt_example-12'
```

## 错误与版本

JSON 成功响应统一为 `{ "version": "v1", "requestId": "…", "data": … }`；错误响应统一为 `{ "version": "v1", "requestId": "…", "error": { "code": "…", "message": "…", "retryable": false } }`。错误码包括 `INVALID_REQUEST`、`UNSUPPORTED_MEDIA_TYPE`、`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`AGENT_REVISION_UNAVAILABLE`、`INVALID_STATE`、`RATE_LIMITED`、`DEPENDENCY_UNAVAILABLE` 和 `INTERNAL`。内部异常、凭据明文和对象存储签名信息不进入错误正文或日志。

兼容性契约由 `runtime-ts/packages/protocol` 的 TypeBox Schema 拥有。OpenAPI 3.1 产物位于 `docs/reference/openapi/public-v1.json`；运行 `pnpm api:openapi:generate` 生成，CI 通过 `pnpm api:openapi:check` 校验。破坏性变化通过新版本路径发布。

终端用户映射与客户端工具 `requires_action` / 结果提交尚不属于 v1 本次接口范围。
