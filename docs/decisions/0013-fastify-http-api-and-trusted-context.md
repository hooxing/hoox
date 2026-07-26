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

采用方案 C，精确固定 `fastify@5.10.0`，并以当前 Node.js 24 基线运行兼容性和依赖审计。

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

分页游标不是客户端可编辑的 base64 JSON。游标使用版本 `v=1`、`kid` 和 HMAC-SHA256 签名，签名载荷同时绑定 `tenantId`、`userId`、`updatedAt` 与 `id`。密钥环要求每个密钥为 32–64 字节规范 base64url，写入只使用 `activeKid`，读取可在轮换窗口接受旧 `kid`；验签使用常量时间比较。篡改、未知 `kid`、错误载荷、跨 Tenant 或同 Tenant 跨 User 重放统一返回 `INVALID_REQUEST`，不能成为密钥或授权探针。

所有 request body/query/path 用 `additionalProperties: false` 的 TypeBox Schema，AJV 禁止 `removeAdditional`，即额外字段必须拒绝而不是静默删除。默认 body 上限 64 KiB，请求接收和 handler 超时 15 秒。requestId 由服务端生成，同时写入 `x-request-id` 和 v1 Envelope。错误只返回固定 `ErrorEnvelope`，不包含异常消息、SQL、ID 或驱动细节。

JSON 解析显式拒绝 `__proto__` 与 `constructor` 污染键。Schema、超限和畸形 JSON 使用固定 400 `INVALID_REQUEST`；创建路由只接受 `application/json`，其他媒体类型使用固定 415 `UNSUPPORTED_MEDIA_TYPE`。两种失败都只返回公共错误信封。

日志只记录 requestId、HTTP method、路由模板、状态码、耗时和稳定失败类别；Authorization、Cookie 和 Set-Cookie 显式脱敏，不记录 body、原始 URL 或原异常。

### 事务端口与已知边界

`ThreadCreationPort` 规定 Thread、空 Workspace、幂等记录与 active Membership 重验原子提交。`EnqueueOutboxPort` 规定 `queued` Run、enqueue outbox、幂等记录与 active Membership 重验原子提交，且在事务锁内重验 Thread 仍为 active。当前 PG Repository 不支持这两个组合事务；本任务只提供契约和并发屏障 Fake。不提供“先写 Run 再发队列”或“先写 Thread 再写 Workspace”的生产默认适配。

创建端口不能作为普通可选字段直接装配。调用方必须同时提供两个端口并经 `createApiCreateCapability` 运行时工厂签发；只有签发对象存在时才注册两个 POST 路由。无创建能力时 `/ready` 可正常通过，两个 POST 返回 404，读取、归档和取消仍可部署。运行时用签发集合校验对象，TypeScript `as` 断言不能伪造能力。

Thread 归档使用独立 `ArchiveThreadCommandPort`。PostgreSQL 实现必须在一个事务中固定按 Membership→Thread 取行锁，在锁内重验 Membership 为 active 且角色为 Owner/Admin，再做幂等逻辑归档。API 层先读 Membership 仅用于建立请求上下文，不能替代命令事务内的授权重验；认证后发生撤权或降权时必须返回 `NOT_FOUND` 且不能归档。

PostgreSQL 的行级锁语法除 SELECT 外还要求目标表至少一个可更新列。Runtime 因此只获得 Membership `status` 列的 UPDATE 权限，不获得 `role` 或其他列的 UPDATE，也不获得表级 UPDATE。该最小列权限既允许归档命令锁定 Membership，也为后续受控撤权命令保留边界；任何 status 修改仍必须通过单独的事务命令端口，不能向通用 Repository 开放。

## 理由

Fastify 将 Schema 验证、序列化、生命周期和 inject 测试收敛在一个已经广泛使用的 TypeScript 边界。两段身份解析使身份供应商只负责证明 principal，PostgreSQL Membership 仍是业务授权事实源。强端口与 Fake 比顺序双写更诚实：它允许 HTTP 契约、领域状态和隔离先行验证，但不会宣称 Worker 已经可靠收到生产 Run。

## 影响

### 正面影响

- HTTP 边界复用已有 Domain、Protocol Mapper、PG Repository 和 RLS；
- 跨 Tenant、跨 Thread 和角色失败具有统一且脱敏的行为；
- create 的幂等和入队原子性被显式定义，后续 PG 实现有可复用的双参与者并发屏障目标契约；
- 已签名且绑定授权主体的游标不能被编辑或跨主体重放。

### 负面影响与成本

- 新增 Fastify 依赖和 lockfile 改动；
- 真实身份供应商、PG outbox/idempotency 以及生产 listen/shutdown 装配仍需要独立任务；
- 游标签名密钥需要配置分发、轮换和退役流程；
- 逻辑 DELETE 需要客户端按“归档/取消”理解，不能当成数据物理删除。

### 安全、数据与运维影响

- 反向代理必须完整传递 Authorization 且不能覆盖服务端 requestId；
- handler 超时不能证明已发出的持久化写入失败，create 调用方必须用同一 Idempotency-Key 重试；
- 游标密钥轮换时必须先发布同时含新旧 key 的读取密钥环，再切换 `activeKid`，最后等待既有游标过期后移除旧 key；
- ready 只表示已注入依赖的探针通过，live 不访问外部服务。

## 验证

- Fastify inject：严格字段、body 上限、畸形 JSON、原型污染键、415 媒体类型、handler 超时、requestId、固定 ErrorEnvelope 和脱敏错误；
- 契约测试：Thread create/get/list/archive、Run queued create/get/cancel、游标签名/轮换/跨主体拒绝、双方首次观察为空的并发幂等、认证后撤权重验和未签发创建能力不注册路由；
- 真实 PostgreSQL：API 使用 Runtime 角色经 RLS 读取/列表/归档/取消，证明裸 Tenant Header 不能跨租户读取，并以真实 Membership 行锁屏障证明降权先提交时归档被拒绝；
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
- 2026-07-26：复审后增加能力签发、PG 原子归档、命令端授权重验、HMAC 游标、并发幂等屏障、解析异常归一化和 Fastify 5.10.0 固定版本。
