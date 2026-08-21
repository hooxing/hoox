# Development API 契约

本页描述本地工作台和开发集成依赖的主要 HTTP 边界。它不是完整、稳定的公共 OpenAPI；在 `0.x` 阶段，协议变化必须同步 TypeBox Schema、映射、测试和本页。

## 网络与身份边界

- development API 只允许监听字面回环地址 `127.0.0.1`、`::1` 或 `localhost`。
- Web 开发服务器通过同源代理访问 API，不启用宽松 CORS。
- `Authorization: Bearer dev-user-a|dev-user-b` 只用于固定隔离测试 fixture。
- `/v1/auth/register` 和 `/v1/auth/login` 提供 development 本地账号会话，并为新账号原子创建 User、个人 Tenant 和 owner Membership。
- 服务端始终从已认证 User 和 PostgreSQL Membership 重建 `TenantScope`。`X-Tenant-ID` 只选择个人或团队空间，不能替代 Membership 授权。
- development 身份和本地账号端点不会装配到 production API。

## 主题路由

本页不复制完整 TypeBox Schema。需要修改某组接口时，先从下表找到事实拥有者，再核对 `runtime-ts/packages/protocol`、`runtime-ts/apps/api` 和对应测试。

| 路由组 | 主要用途 | 当前说明 |
| --- | --- | --- |
| `/v1/threads`、`/:threadId/runs`、`/inputs`、`/context`、`/continuity` | 创建任务、执行 Run、统一输入、读取上下文和连续性状态 | [Thread 连续上下文](../architecture/thread-continuity.md) |
| `/v1/threads/:threadId/forks` | 创建同空间分支或发布到已授权团队 | [团队协作](../architecture/team-collaboration.md) |
| `/v1/me/teams`、`/v1/teams`、`/:teamId/members` | 团队目录、创建、成员角色和解散 | [团队协作](../architecture/team-collaboration.md) |
| `/v1/skills`、`/v1/me/skills` | 浏览 Skill 目录并管理当前 Tenant 安装 | [Skill Runtime](../architecture/skill-runtime.md) |
| `/v1/me/history-files`、`/v1/me/team-files/import` | 浏览当前 Tenant 云盘、下载固定版本和跨空间导入 | [历史文件与 ResourceFS](history-files.md) |
| `/v1/me/personalization`、`/v1/teams/:teamId/personalization` | 读取和更新个人或团队偏好 | [团队协作](../architecture/team-collaboration.md) |
| `/v1/automations` | 管理 Thread 定时任务 | `@hoox/automation`、Protocol Schema 和 API 测试 |
| `/v1/resources/uploads` | 通过受控上传协议创建 ResourceVersion | [架构总览](../architecture/overview.md) |

路径中的 `/me` 表示以当前认证用户发起操作，不必然表示数据属于全局个人空间；最终作用域仍由该路由的 `TenantScope` 和业务校验决定。

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
```

- 两个端点都只为已授权的 published Artifact 签发短期 S3 URL。
- 签名前后重验 Tenant 成员关系、Thread/Run 归属、授权修订和完整固定 Blob 身份。
- `preview` 只允许安全 charset 的纯文本、PNG、JPEG、GIF、WebP 和 PDF inline。
- HTML、SVG、XML 等主动内容不能 inline，只能通过使用净化文件名的 attachment 下载。
- URL、对象键和签名不能写入 API 日志或持久化事实。
- BlobStore 异常统一返回不泄漏内部消息的 503。

## 输入与幂等

创建 Thread 和 Run 的写入路径通过 PostgreSQL 原子适配器完成：

- Thread 与初始 Workspace 原子创建。
- Run、不可变输入和 Dispatch Outbox 原子创建。
- 首次并发竞争通过 Tenant 事务、成员资格重验、advisory lock 和幂等记录收敛。
- 相同幂等键只接受相同 request hash。
- COMMIT 响应未知时只按原 scope、幂等键和请求摘要精确读回，禁止再次写入猜测结果。

Schema、超限、畸形 JSON、危险原型键和游标错误统一映射为 400 `INVALID_REQUEST`；不支持的创建请求媒体类型返回 415 `UNSUPPORTED_MEDIA_TYPE`。Fastify、AJV、SQL 和领域内部消息不能直接返回客户端。

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
5. 若改变公开兼容边界，新增 ADR。
