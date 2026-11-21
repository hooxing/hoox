# Development API 契约

本页描述本地工作台和开发集成依赖的主要 HTTP 边界。它不是完整、稳定的公共 OpenAPI；在 `0.x` 阶段，协议变化必须同步 TypeBox Schema、映射、测试和本页。

## 网络与身份边界

- development API 只允许监听字面回环地址 `127.0.0.1`、`::1` 或 `localhost`。
- Web 开发服务器通过同源代理访问 API，不启用宽松 CORS。
- `Authorization: Bearer dev-user-a|dev-user-b` 只用于固定隔离测试 fixture。
- 服务端凭据使用 `Authorization: Bearer hoox_sk_…`。明文只在 `POST /v1/api-keys` 创建成功响应中返回一次；Tenant Owner/Admin 可列出前缀与元数据并吊销。API Key 需具备路由显式声明的作用域；未声明作用域的路由默认拒绝 API Key，Key 管理、会话、账号及团队成员路由仅接受人类会话。
- API Key 绑定不可登录的集成 User 与 Tenant `member` Membership；认证后仍从 Membership 重建 TenantScope 并受 PostgreSQL RLS 限制。
- `/api/auth/*` 承载内嵌 Better Auth 的邮箱、OAuth 和手机号协议；`/v1/auth/config` 返回公开启用状态，`/v1/auth/exchange` 把 Better Auth Cookie Session 交换为 Hoox 会话。
- `/v1/auth/register` 和 `/v1/auth/login` 只在 development 显式保留，用于本地账号兼容和测试。
- 服务端始终从已认证 User 和 PostgreSQL Membership 重建 `TenantScope`。`X-Tenant-ID` 只选择个人或团队空间，不能替代 Membership 授权。
- 固定 development 身份和旧本地注册登录端点不会装配到 production API；production 使用内嵌 Better Auth，并保留 JWT 解析作为非浏览器调用方的兼容后备。

## 主题路由

本页不复制完整 TypeBox Schema。需要修改某组接口时，先从下表找到事实拥有者，再核对 `runtime-ts/packages/protocol`、`runtime-ts/apps/api` 和对应测试。

| 路由组 | 主要用途 | 当前说明 |
| --- | --- | --- |
| `/v1/agents`、`/v1/threads`、`/:threadId/runs`、`/inputs`、`/context`、`/continuity` | 列出当前 Tenant 可用 Agent，创建任务、执行 Run、统一输入、读取上下文和连续性状态 | [Agent 定义与工作台选择](../architecture/agent-definition.md)、[Thread 连续上下文](../architecture/thread-continuity.md) |
| `/v1/threads/:threadId/forks` | 创建同空间分支或发布到已授权团队 | [团队协作](../architecture/team-collaboration.md) |
| `/v1/me/teams`、`/v1/teams`、`/:teamId/members` | 团队目录、创建、成员角色和解散 | [团队协作](../architecture/team-collaboration.md) |
| `/v1/skills`、`/v1/me/skills` | 浏览 Skill 目录并管理当前 Tenant 安装 | [Skill Runtime](../architecture/skill-runtime.md) |
| `/v1/me/history-files`、`/v1/me/team-files/import` | 浏览当前 Tenant 云盘、下载固定版本和跨空间导入 | [历史文件与 ResourceFS](history-files.md) |
| `/v1/me/personalization`、`/v1/teams/:teamId/personalization` | 读取和更新个人或团队偏好 | [团队协作](../architecture/team-collaboration.md) |
| `/v1/automations` | 管理 Thread 定时任务 | `@hoox/automation`、Protocol Schema 和 API 测试 |
| `/api/auth/*`、`/v1/auth/config`、`/v1/auth/exchange` | 注册登录、邮箱验证 OTP、OAuth/手机号流程和 Hoox 会话交换 | [身份、账号与会话](../architecture/identity-and-session.md) |
| `/v1/resources/uploads` | 通过受控上传协议创建 ResourceVersion | [架构总览](../architecture/overview.md) |
| `/v1/api-keys` | 为当前 Tenant 创建、列出和吊销服务凭据 | [身份、账号与会话](../architecture/identity-and-session.md#服务凭据与集成身份) |

路径中的 `/me` 表示以当前认证用户发起操作，不必然表示数据属于全局个人空间；最终作用域仍由该路由的 `TenantScope` 和业务校验决定。

## Agent 与 Thread 创建

`GET /v1/agents` 使用当前已认证 Tenant 返回可用的已发布 Agent，API Key 需要 `threads:read` 作用域。响应 `data.items` 中每项只包含 `id`、`displayName`、`description`、可选 `avatarRef`、可选 `welcomeMessage` 和 `suggestedQuestions`；Operator 指令、草稿与 Revision 管理信息不会返回。结果受 Tenant RLS 可见性约束。

创建 Thread 时可在原有标题之外传入 `agentDefinitionId`：

```http
POST /v1/threads
Idempotency-Key: create-thread-0001
Content-Type: application/json

{"title":"整理客户反馈","agentDefinitionId":"agent_support"}
```

省略该字段时仍绑定 `agent_default`。成功响应的 Thread DTO 带有 `agentDefinitionId`。RLS 不可见的定义（包括不存在、跨 Tenant、不在可用范围和已停用定义）统一返回 `404 NOT_FOUND`，不区分原因；仅定义仍可见但没有可用的已发布 Revision 时返回 `409 AGENT_REVISION_UNAVAILABLE`。已有 Thread 创建 Run 时沿用 A3 的该 409 语义。新建 Thread 不会改写已有 Thread 的 Agent 绑定。

## 后台 Agent 固定模型

`GET /v1/admin/control/agent-definitions` 为可管理 Agent 的 `operator` 和 `admin` 返回 `pinnedModelOptions`；`viewer` 得到空数组。选项只包含 `mode: "pinned"`、`providerKey`、`providerRevision` 和 `modelId`，不包含凭据。创建 Agent 或保存 Revision 时，把该选项作为 `content.model` 提交；跟随平台默认时提交 `{ "mode": "platform_default" }`。不存在、未启用或未绑定托管凭据的引用返回 400。发布时会重新校验。角色及版本语义见 [后台控制面](../architecture/admin-control-plane.md#agent-定义与版本管理)。

## 健康端点

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/live` | 进程存活，不代表外部依赖全部可用 |
| `GET` | `/ready` | 当前装配声明的外部依赖和角色探针已通过 |

## Run 事件

```http
GET /v1/threads/:threadId/runs/:runId/events?after=-1&limit=100
```

- 只读取当前 Run 最新 Attempt 的持久事件。
- `after` 是排他 sequence 游标，范围为 `-1` 到安全整数。
- `limit` 范围为 `1` 到 `200`。
- 结果按 sequence 严格递增。
- `eventId` 采用 `<attemptId>-<sequence>`。
- 当 `kind=agent_event` 且 `payload.type` 位于 Runtime 白名单时，`type` 使用该子类型；其他情况使用 `kind`。
- 游标只在同一 `attemptId` 内有效；Attempt 变化时客户端必须重置游标或按 Attempt 分区去重。
- Run 不存在、Thread 不匹配、跨 Tenant 或成员关系失效统一返回 404。
- 数据库异常映射为不泄漏 SQL 和内部错误的 503。

### 实时输出

```http
GET /v1/threads/:threadId/runs/:runId/events/stream?after=-1&attemptId=attempt_1
Accept: text/event-stream
```

该端点沿用分页端点的身份、Tenant、Thread/Run 归属和持久事件语义。浏览器用 fetch 携带现有身份 Header；`attemptId` 可省略，首次读取使用 `after=-1`。服务端发现最新 Attempt 与请求不同，会自动从 `-1` 补读。

- `run-events` 帧的 JSON 为 `{ run, page: { attemptId?, items, hasMore } }`，事件字段与分页端点相同，每页最多 32 条。没有事件时也可以发送空页和当前 Run 状态。
- `end` 帧的 JSON 为 `{ reason: "settled" | "renew" }`。Run 离开 queued/running 或进入 recovery_required，且事件已排空时发送 settled；约 30 秒后发送 renew，客户端携带已接收的 Attempt/sequence 立即续连。
- 每次补读重新认证和校验 Membership/Run 归属。首次读取前的错误使用既有 HTTP 错误信封；响应开始后的读取或授权失败中断连接。没有 end 的 EOF 不能视为正常完成。
- 事务提交通知唤醒 API 补读；通知丢失、监听断线或无通知的状态变化由约 1 秒的补读兜底。通知只含散列路由键，不包含正文，也不能绕过授权。
- API 每进程共用一条专用 PostgreSQL LISTEN 连接，连接失败时自动重建；响应读取服从背压。浏览器断开或 API 关闭会释放该流订阅。
- 响应使用 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`。反向代理需要关闭响应缓冲，不能把 SSE 累积为完整响应后才转发。

Worker 的 Pi 适配层在分配持久事件 sequence 前合并连续正文增量：每条 assistant 消息的首段非空正文立即发布，后续按 50ms 或 1KiB UTF-8 缓冲窗口刷新；思考增量使用 500ms 或 1KiB 窗口，以减少串行持久化事务。控制事件和消息、工具、turn 边界同步排空前驱文字，单个大增量原样交给既有大小门禁。事件分片不对应 Provider token，已提交事件的游标、重放和授权语义不变；内部原始轨迹与完整 Thread 历史不受合并影响。窗口时间受事件循环调度影响，不是端到端延迟保证。取消订阅或释放 Session 会清除计时器和未发布缓冲。决策见 [运行事件与对话展示](../architecture/run-events-and-presentation.md)。

Web 正文与交付物、上下文读取独立。首批与控制事件立即显示；连续文字合并三个动画帧，定时器兜底目标为 50ms，实际绘制仍受浏览器调度影响。流中断按已接收游标重连；端点 404 时降级到约 1 秒分页轮询。切换任务取消旧连接和待发布文字。辅助信息约 5 秒刷新一次，关键事件和运行状态变化触发提前刷新。

回复按新增事件折叠，Markdown 稳定块和代码行保持 DOM；跨块引用与脚注使用全文解析以保留语义。运行回复进入持久上下文时复用正文组件。用户回看历史时停止自动滚动，跟随底部时只在高度发生变化后调整位置。实现取舍见 [运行事件与对话展示](../architecture/run-events-and-presentation.md)。

## Artifact

### 列出交付物

```http
GET /v1/threads/:threadId/runs/:runId/artifacts
```

只返回已经 settled 为 `published` 的 deliverable Artifact；diagnostic、trace、publishing 和 failed 记录不会作为用户交付物返回。没有交付物时返回 200 空列表。

### 预览和下载

```http
GET /v1/threads/:threadId/runs/:runId/artifacts/:artifactId/preview
GET /v1/threads/:threadId/runs/:runId/artifacts/:artifactId/download
GET /v1/threads/:threadId/runs/:runId/artifacts/:artifactId/content
```

- `download` 和二进制 `preview` 为已授权的 published Artifact 签发短期 S3 URL；规范 UTF-8 纯文本 `preview` 返回安全 JSON 文本。
- 签名前后重验 Tenant 成员关系、Thread/Run 归属、授权修订和完整固定 Blob 身份。
- `preview` 只允许安全 charset 的纯文本、PNG、JPEG、GIF、WebP 和 PDF inline。
- HTML、SVG、XML 等主动内容不能 inline，只能通过使用净化文件名的 attachment 下载。
- URL、对象键和签名不能写入 API 日志或持久化事实。
- BlobStore 异常统一返回不泄漏内部消息的 503。
- `content` 提供有界、受授权的原始字节，供浏览器解析 Office、PDF、图片和文本，不执行服务端转换；读取前后复核固定身份，返回版本响应头。支持格式、选区引用请求与限制见[文件预览与选区引用](file-preview.md)。

## 输入与幂等

创建 Thread 和 Run 的写入路径通过 PostgreSQL 原子适配器完成：

- Thread 与初始 Workspace 原子创建。
- Run、不可变输入和 Dispatch Outbox 原子创建。
- 首次并发竞争通过 Tenant 事务、成员资格重验、advisory lock 和幂等记录收敛。
- 相同幂等键只接受相同 request hash。
- COMMIT 响应未知时只按原 scope、幂等键和请求摘要精确读回，禁止再次写入猜测结果。

Schema、超限、畸形 JSON、危险原型键和游标错误统一映射为 400 `INVALID_REQUEST`；不支持的创建请求媒体类型返回 415 `UNSUPPORTED_MEDIA_TYPE`。Fastify、AJV、SQL 和领域内部消息不能直接返回客户端。Thread 或 Run 创建所绑定的 Agent 已停用或没有可用的已发布 Revision 时返回 409 `AGENT_REVISION_UNAVAILABLE`；响应使用固定提示，不暴露持久层诊断信息。

## 对象存储 origin

在 development 固定身份启用时，`S3_PUBLIC_ENDPOINT` 必须：

- 使用字面回环地址；
- 与 API origin 不同；
- 与 Web 的 `http://127.0.0.1:4173` origin 不同；
- 不携带凭据、路径或查询参数。

推荐本地 MinIO 使用 `http://127.0.0.1:19000`。

## 稳定性说明

本页描述当前 development 产品面，但仓库尚未承诺正式 API 版本稳定性。新增或修改协议时必须：

1. 更新 TypeBox Schema；
2. 更新 Domain/Protocol 映射；
3. 补充兼容和越权测试；
4. 更新本页；
5. 若改变公开兼容边界，同步更新对应架构文档。
