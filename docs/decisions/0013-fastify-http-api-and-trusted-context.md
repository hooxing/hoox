# ADR-0013：Fastify HTTP API 与可信 Tenant Context

- 状态：已接受
- 日期：2026-07-26
- 决策者：M2 API 核心实施审阅
- 关联任务/PR：M1-02、M1-03、M1-04，`feat/m2-api-thread-run-core`
- 替代关系：无

## 背景

领域对象、v1 DTO、PostgreSQL Repository 和 RLS 已存在，但 `apps/api` 仍只有空入口。首个 HTTP 边界需要公开 Thread/Run 的最小操作，同时不能把客户端传入的 Tenant ID、驱动错误、非原子队列双写或宽松 JSON 形状变成生产契约。

## 决策驱动因素

- 请求必须由可验证的身份 principal 和当前有效 Membership 共同解析 `TenantScope`；
- 公开 JSON、错误、分页、幂等和 requestId 需要稳定 v1 契约；
- API 进程不运行 Agent Loop，Run 创建只能持久化 `queued` 并可靠投递给 Worker；
- 当前 PostgreSQL Repository 没有“Run + enqueue outbox”或“Thread + 空 Workspace + 幂等记录”的组合事务，不能用顺序双写伪装成原子性；
- 请求体、处理时间和日志内容需要默认边界。

## 备选方案

### 方案 A：Node.js 原生 `http`

依赖最少，但需要自行组合路由、Schema 编译、body limit、inject 测试、超时和日志边界，容易使传输层逐步自制框架。

### 方案 B：Express 加独立校验中间件

生态成熟，但 JSON Schema 与 TypeScript 类型需要另外粘合，内建 inject、序列化 Schema 和插件封装不如 Fastify 集中。

### 方案 C：Fastify v5 + TypeBox

使用成熟的路由、AJV、序列化、脱敏 Pino 边界和 `inject`，与已有 TypeBox 协议直接对齐。代价是新增一个生产依赖，并必须显式覆盖 Fastify 默认删除额外字段的 AJV 行为。

## 选择

采用方案 C，精确固定 `fastify@5.8.5`。该版本是实施时 Fastify v5 的官方最新安全发布，支持当前 Node.js 24 基线。

### 可信身份与角色

1. `AuthContextResolver` 是生产适配端口，只接收 Authorization 凭据和服务端 requestId，返回已验证的 `userId + tenantId` principal。本任务只实现测试 Fake，不选择真实身份供应商。
2. API 必须用 principal 构造候选 scope，再调用 Tenant Repository 确认当前有效 Membership。`x-tenant-id`、URL、body 或模型参数不参与 scope 解析。
3. 凭据无效返回 `UNAUTHORIZED`；principal 有效但 Membership 或资源无效、跨 Tenant、角色不允许均统一返回 `NOT_FOUND`，不形成存在性探针。
4. 有效 Member 可创建和读取 Thread/Run；Thread 归档只允许 Owner/Admin。首版产品仍只开放个人 Tenant，但传输层不预留越权缺口。

### HTTP 契约

- `GET /live`、`GET /ready`；
- `POST /v1/threads`、`GET /v1/threads`、`GET /v1/threads/:threadId`、`DELETE /v1/threads/:threadId`；
- `POST /v1/threads/:threadId/runs`、`GET /v1/threads/:threadId/runs/:runId`、`DELETE /v1/threads/:threadId/runs/:runId`。

DELETE 表示可重复的逻辑 archive/cancel，不物理删除记录。两个 create POST 强制 8–128 字符 `Idempotency-Key`；同 scope、操作和 key 且请求哈希相同时返回原实体，哈希不同返回 `CONFLICT`。Thread 列表使用 `updated_at DESC, id DESC` 键集游标，默认 20、上限 100；游标只影响当前已授权 scope 的查询位置。

所有 request body/query/path 用 `additionalProperties: false` 的 TypeBox Schema，AJV 禁止 `removeAdditional`，即额外字段必须拒绝而不是静默删除。默认 body 上限 64 KiB，请求接收和 handler 超时 15 秒。requestId 由服务端生成，同时写入 `x-request-id` 和 v1 Envelope。错误只返回固定 `ErrorEnvelope`，不包含异常消息、SQL、ID 或驱动细节。

日志只记录 requestId、HTTP method、路由模板、状态码、耗时和稳定失败类别；Authorization、Cookie 和 Set-Cookie 显式脱敏，不记录 body、原始 URL 或原异常。

### 事务端口与已知边界

`ThreadCreationPort` 规定 Thread、空 Workspace 和幂等记录原子提交。`EnqueueOutboxPort` 规定 `queued` Run、enqueue outbox 和幂等记录原子提交，且在事务锁内重验 Thread 仍为 active。当前 PG Repository 不支持这两个组合事务；本任务只提供契约和内存 Fake，`createApiApp` 必须由调用方显式注入实现。不提供“先写 Run 再发队列”或“先写 Thread 再写 Workspace”的生产默认适配，因此在后续 PostgreSQL outbox/idempotency 迁移完成前，生产启动装配不得开放两个 create 路由。

## 理由

Fastify 将 Schema 验证、序列化、生命周期和 inject 测试收敛在一个已经广泛使用的 TypeScript 边界。两段身份解析使身份供应商只负责证明 principal，PostgreSQL Membership 仍是业务授权事实源。强端口与 Fake 比顺序双写更诚实：它允许 HTTP 契约、领域状态和隔离先行验证，但不会宣称 Worker 已经可靠收到生产 Run。

## 影响

### 正面影响

- HTTP 边界复用已有 Domain、Protocol Mapper、PG Repository 和 RLS；
- 跨 Tenant、跨 Thread 和角色失败具有统一且脱敏的行为；
- create 的幂等和入队原子性被显式定义，后续 PG 实现有可测试的目标契约。

### 负面影响与成本

- 新增 Fastify 依赖和 lockfile 改动；
- 真实身份供应商、PG outbox/idempotency 以及生产 listen/shutdown 装配仍需要独立任务；
- 逻辑 DELETE 需要客户端按“归档/取消”理解，不能当成数据物理删除。

### 安全、数据与运维影响

- 反向代理必须完整传递 Authorization 且不能覆盖服务端 requestId；
- handler 超时不能证明已发出的持久化写入失败，create 调用方必须用同一 Idempotency-Key 重试；
- ready 只表示已注入依赖的探针通过，live 不访问外部服务。

## 验证

- Fastify inject：严格字段、body 上限、handler 超时、requestId、固定 ErrorEnvelope 和脱敏错误；
- 契约测试：Thread create/get/list/archive、Run queued create/get/cancel、游标、幂等重放/冲突、Thread 归档竞态和 Member 归档拒绝；
- 真实 PostgreSQL：API 使用 Runtime 角色经 RLS 读取/列表/归档/取消，并证明裸 Tenant Header 不能跨租户读取 Thread/Run；
- 全量 format/lint/typecheck/test/build、clean-vendor 和敏感信息扫描。

## 可逆性与回退

当前没有新增 PostgreSQL Schema，回退可删除 API 路由和 Fastify 依赖；既有领域数据不受影响。对外客户端依赖 v1 路由后，改变 URL、Envelope、幂等键或逻辑 DELETE 语义需要协议版本过渡。后续 PG outbox 必须保持本 ADR 的端口结果和幂等语义。

## 后续工作

- 新增 PostgreSQL idempotency/outbox 迁移和原子 `ThreadCreationPort` / `EnqueueOutboxPort` 适配；
- 选择身份供应商并实现真实 `AuthContextResolver`；
- 增加生产启动、优雅停机、反向代理可信网段和指标装配；
- Worker 实现后追加 outbox 领取、重试和取消竞态端到端验证。

## 实施记录

- 2026-07-26：完成 Fastify app factory、v1 Thread/Run 核心路由、内存原子端口 Fake 和真实 PostgreSQL RLS API 测试。
