# Development 诊断指南

本页面向维护者，描述模型网络报文和内部轨迹查看能力。诊断数据可能包含完整 Prompt、思考、工具参数、模型生成的 Tool Call 和模型可见回执，必须按敏感用户数据处理。

## 模型网络报文诊断

该能力默认关闭。需要区分“模型生成的工具参数有误”和“工具内部执行失败”时，在本机 `.env` 中显式设置：

```dotenv
MODEL_WIRE_TRACE_ENABLED=true
MODEL_WIRE_TRACE_RETENTION_DAYS=7
MODEL_WIRE_TRACE_MAX_BYTES=1048576
```

修改后必须重启 Worker；运行中的进程不会动态开启采集。

- `MODEL_WIRE_TRACE_RETENTION_DAYS` 决定新记录的到期时间。
- `MODEL_WIRE_TRACE_MAX_BYTES` 是每个 request/response 正文的独立字节上限。
- 超限只保存精确前缀并标记为 `truncated`。
- 采集关闭期间的旧 Run 无法事后重建精确请求与 SSE。
- 采集端口不接收 HTTP headers，因此不会保存 Authorization、Cookie 或 Provider 密钥。

## 本地镜像目录

在 development 中，Worker 会 best-effort 将采集内容镜像到：

```text
model-wire-traces/<runId>/<attemptId>/
```

典型文件：

```text
model-turn-00-transport-0-request-complete.json
model-turn-00-transport-0-response-truncated.sse
runtime-event-00000003-agent_event.json
startup-timings.json
```

`startup-timings.json` 记录 Worker 开始领取 Run 到首个 Provider 请求即将发起之间的总耗时，以及 claim、个性化、记忆、停止点、AgentSupervisor、Skill 恢复、Observation、Thread 历史、Runtime compaction、Pi Session 创建、模型阶段持久化、输入准备和模型许可等低基数阶段。它不保存 Prompt、工具参数或用户正文；若 Run 在首模前失败，则在 Run 收口时保存截至失败点的部分快照。

文件使用同目录临时文件和原子发布；相同字节可以幂等重放，不同字节不会覆盖已有文件。本地镜像写入在首模边界异步启动，失败不阻塞 Provider 请求，也不改变模型调用或 PostgreSQL/MinIO 持久化结果。

该目录已被 Git 忽略，但不提供 ACL、自动删除或 retention 保证。PostgreSQL/MinIO 是产品能力的权威存储；production 不创建本地镜像。

## Web 中查看

启动 development API 与 Web 后，在 Thread 的 Run 详情中进入“模型网络报文”区域，可以按以下维度查看：

- Attempt；
- `modelTurn`：工具循环中的模型轮次；
- `transportAttempt`：同一模型轮次的 HTTP 传输重试；
- request/response；
- HTTP 状态、字节数、SHA-256 和采集状态。

request 是交给 Fetch 的最终 application request body；response 是 HTTP content-decoding 后、SSE 解析前的应用正文，不包含 TCP/chunk framing 或压缩前线路字节。

## 诊断 API

```http
GET /v1/threads/:threadId/runs/:runId/model-wire-traces?limit=500
GET /v1/threads/:threadId/runs/:runId/model-wire-traces/:attemptId/:modelTurn/:transportAttempt/:part/body
```

第一个端点返回元数据并使用 `nextCursor` 分页；第二个端点读取 request 或 response 的 `application/octet-stream` 原始正文。接口沿用认证、Tenant Membership/RLS 和 Thread/Run 归属校验，不返回 S3 URL。

## 内部轨迹查看器

产生诊断记录后运行：

```powershell
corepack pnpm dev:trajectory
```

默认地址：

```text
http://127.0.0.1:4188
```

查看器从仓库根目录 `model-wire-traces` 聚合 durable Run 事件，展示近似模型步骤、思考、回复、工具生命周期、Attempt 状态、稳定错误类别和 request/response 原文。

development 管理 Web 的“数据运营”页显示“打开内部轨迹”链接。该链接在新窗口打开回环地址，不把轨迹正文交给 Admin API；仍需维护者单独启动上述命令。

受控 Demo 默认在同一镜像中构建并启动查看器，入口为 `https://hoox.aisay.cc/trajectory/`。页面外壳不包含轨迹数据；列表、详情与模型报文 API 会读取同源 `hoox.auth-session.v2`，只有 Demo 管理员 Hoox Session 能通过 Nginx `auth_request`。鉴权后 Nginx 会清空转发给查看器的 `Authorization`。Demo Worker 与查看器共享固定数据 epoch 的轨迹卷；新 Run 产生的轨迹跨应用发布和回滚持续保留，旧 release 目录清理不得删除该卷。启用稳定卷以前的记录不自动回填。

可覆盖参数：

```powershell
corepack pnpm dev:trajectory -- --port 4190
corepack pnpm dev:trajectory -- --root <受控目录>
```

事件文件不包含 PostgreSQL `occurred_at`，页面耗时使用不可变文件 mtime 近似计算，只用于排障。

## 安全约束

- 查看器只允许绑定本机回环地址。除 `deploy/demo` 明确实现的同源管理员会话网关外，不得代理或转发到远程网络。
- 通用 production 装配不得嵌入或代理查看器；development 管理页使用回环新窗口链接，受控 Demo 管理页使用同源 `/trajectory/` 新窗口链接。
- Demo 只能公开不含数据的页面外壳；`/trajectory/api/` 必须拒绝无会话和非管理员会话，且不得把 Hoox Session Token 转交给查看器进程。
- 禁止将 `model-wire-traces`、截图或正文粘贴到公开 Issue。
- 删除诊断数据前确认相关故障证据已经完成受控留存。
- 关闭 `MODEL_WIRE_TRACE_ENABLED` 只停止新增采集，不自动删除既有记录。
- production 在保留清理 consumer 完成部署前若开启该变量，Worker 应在触达外部依赖之前失败关闭。

## 其他排障入口

- API：`/live` 与 `/ready`。
- 统一 Admin API（默认 `127.0.0.1:3003`）：`/live` 与 `/ready`。
- CubeSandbox：`CUBESANDBOX_API_URL` 后加 `/health`。
- MinIO：`S3_ENDPOINT` 后加 `/minio/health/live`。
- Worker 外部依赖只读检查：`corepack pnpm dev:worker:check`。

对外部问题创建公开 Issue 前必须删除凭据、签名 URL、对象键、用户正文、数据库连接信息和内部网络地址。
