# ADR-0042：本地 Web 体验的 Run 事件与 Artifact 读取契约

- 状态：已接受
- 日期：2026-07-28
- 决策者：Runtime 团队
- 关联任务/PR：可体验 Web 纵向契约
- 替代关系：无

## 背景

现有 Runtime 已将 Worker 事件写入 PostgreSQL `run_events`，并将用户交付物以 Artifact 发布和 stable Blob 身份保存，但浏览器没有可安全消费的读取面。开发身份只允许监听回环地址，且现有公开 API 以可信身份重建 TenantScope。

## 决策驱动因素

- 不能让浏览器按裸 Tenant、Attempt 或对象键读取数据；
- UI 需要可断线续读的 sequence 增量事件和可打开的交付物；
- 复用现有 PostgreSQL RLS、Membership 重验与 S3 预签名边界；
- 不把开发 fixture 身份通过 CORS 扩散到网络。

## 备选方案

### 方案 A：API 直接提供同源读取与短期预签名 URL

API 在每次读取中以 `TenantScope` 重验 Membership，事件只读取 Run 的最新 Attempt；Artifact 只在 `Thread→Run→Artifact` 嵌套路由中投影 published deliverable，并在签发 URL 后再次确认授权。

### 方案 B：Web 直接连接 PostgreSQL 或对象存储

实现快，但会暴露数据库或对象存储凭据、对象键和跨租户枚举面，无法接受。

### 方案 C：SSE/WebSocket 实时流

可降低轮询延迟，但需额外处理连接恢复、背压和鉴权刷新。本轮只建立可重试的增量读取基础。

## 选择

采用方案 A。Web 本地开发服务器把 `/v1` 反向代理到 API，浏览器保持同源；API 不启用 CORS。事件接口使用 `after` 排他 sequence 游标和有限 `limit`，Artifact 预览/下载使用最长 300 秒的 S3 URL。事件 cursor 只在响应所示 `attemptId` 内有效；客户端发现 `attemptId` 改变时必须重置或按 Attempt 分区去重，不能把旧 cursor 用于新 Attempt。

Artifact 列表先确认 Run 与 Membership，再以 LATERAL 子查询筛选 published deliverable，因而授权 Run 没有 Artifact、只有 publishing 或只有 failed Artifact 时均返回 200 空列表，不会被误判为 404。预签名前后必须逐字段比较授权修订、Tenant/Thread/Run/Artifact/ResourceVersion、摘要、大小、媒体类型、incarnation 与物理对象键；任一漂移都按 404 失败关闭。BlobStore 的已知适配错误统一映射为不泄漏内部消息的 503。

inline 预览只允许被动媒体：带安全 charset 的 `text/plain`、PNG、JPEG、GIF、WebP 与 PDF。HTML、SVG、XML 等主动内容返回 422，但相同 Artifact 仍可通过 attachment 下载。开发 `S3_PUBLIC_ENDPOINT` 必须是与 API、Web 均不同的字面回环 origin，例如 MinIO 使用 `127.0.0.1:19000`、Web 使用 `127.0.0.1:4173`；不接受 LAN 地址或 `localhost` DNS 名称。

## 理由

该方案复用已经受审计的认证、RLS、成员关系和 Blob 预签名能力，以最小新状态建立完整纵向链路。轮询可由 sequence 去重并安全续读，后续可在同一语义上增加 SSE。

## 影响

### 正面影响

- 浏览器可读取真实持久化 Run 事件和发布交付物；
- 租户、Thread、Run、Artifact 归属均由服务端重验；
- 不新增数据库 Schema 或跨域认证面。

### 负面影响与成本

- 最新 Attempt 的定义依赖 Worker 现有 Attempt 排序；恢复场景的跨 Attempt 历史不在本轮接口中，cursor 不跨 Attempt 连续；
- 预签名 URL 在签发后到期前不能被主动撤销。

### 安全、数据与运维影响

- URL 仅能来自经校验的独立回环 S3 public origin，不能记录到日志；
- 开发环境仍只能监听回环地址，Web 必须使用同源代理；
- 成员撤销与预签名 URL 的残余时间上限为 300 秒。

## 验证

- Fastify 契约测试验证 sequence 增量读取、Run/Thread 边界和跨租户 404；
- 真实 PostgreSQL 集成测试覆盖无发布记录、publishing、failed 与 published 四种投影；
- API 测试覆盖签名前后绑定漂移、BlobStore 503、被动预览白名单和主动内容下载回退；
- 进程配置测试验证对象存储 public origin 与 API/Web 隔离；
- 运行 API 单元测试、类型检查和格式检查。

## 可逆性与回退

端点和 DTO 可在尚未有外部客户端时移除；不引入迁移。若需回退，停止注册体验读取依赖即可关闭新路由。已签发 URL 至多在 300 秒内仍可用，无法追溯撤销。

## 后续工作

- 在 Web 接入完成后评估 SSE 的背压、断线和多 Attempt 展示语义；
- 为真实 MinIO 增加端到端签名与响应头回归测试。

## 实施记录

- 2026-07-28：新增 Run 体验读取端口、API 端点与开发 S3 装配。
- 2026-07-28：补齐空 Artifact 投影、双读固定绑定、被动预览白名单与独立对象存储 origin。
