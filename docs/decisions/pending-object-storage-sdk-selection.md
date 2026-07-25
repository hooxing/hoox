# 待编号决策：对象存储客户端 SDK 选择

- 状态：已确认，集成时分配 ADR 编号
- 日期：2026-07-26
- 关联任务：M1 对象存储基础

## 背景

开发环境使用 MinIO，生产目标是私有 OSS/S3 兼容存储。基础层需要私有对象 put/head/get/delete、服务端复制和短期预签名下载，并要明确处理写响应丢失和幂等恢复。候选为 AWS SDK for JavaScript v3 与 MinIO JavaScript SDK。

## 备选

### AWS SDK for JavaScript v3

优势：S3 命令和错误元数据覆盖完整，预签名能力独立，模块化包可只安装 S3 组件；对 AWS S3 和大多数兼容实现是通用协议基线。代价是依赖图较大，部分 S3 兼容差异需要集成测试。

### MinIO JavaScript SDK

优势：对本地 MinIO 体验直接，API 较集中。代价是客户端语义更贴近 MinIO，未来接入 AWS 或其他 S3 服务时仍需验证/改写；与生产目标的通用 S3 协议边界不完全一致。

### 自行实现 S3 HTTP 签名和请求

依赖最少，但签名、区域、重试、流式响应和兼容错误处理风险高，不适合作为本项目业务价值。

## 选择

选择 AWS SDK for JavaScript v3，精确锁定：

- `@aws-sdk/client-s3` `3.1095.0`；
- `@aws-sdk/s3-request-presigner` `3.1095.0`。

业务代码只依赖本包的 `BlobStore`，AWS 类型不进入 Workspace、Resource 或 Artifact 领域模型。MinIO 作为显式 opt-in 的 S3 兼容集成目标。

同时确认以下领域与恢复边界：

- staging 使用 `If-None-Match: *` 条件写入；条件冲突后通过 HEAD 比较固定描述符，消除先 HEAD、后 PUT 的覆盖竞态；
- stable 对象不暴露通用删除方法，只能由专用 GC 端口持有 PostgreSQL 事务 claim 后回收；
- 内容身份由 Tenant、用途、SHA-256 和大小决定；`mediaType` 属于业务引用的展示元数据，不参与 stable 内容身份；
- 当前上传 API 只接收 `Uint8Array`，运行时配置不得超过 16 MiB；读取采用流式接口并同时校验 ContentLength、累计大小和 SHA-256；multipart/流式上传延后单独设计；
- PUT、COPY、DELETE 返回未知后，仅在 HEAD 得到明确结果时收敛。HEAD 失败仍为未知，由恢复任务重试，不能把协议异常当成 NotFound；
- 非事务提交与恢复状态按 `(tenant_id, operation_id)` 寻址，数据库实现必须建立复合唯一约束并校验 Tenant scope。

## stable GC 事务 Claim

### 背景

“先查询零引用、再删除对象”的快照证明存在 TOCTOU：查询完成后、S3 删除前可能并发新增引用，导致数据库出现指向已删除对象的引用。`checkedAt` 只能说明过去某一时刻不可达，不能作为删除授权。

### 方案

- PostgreSQL 为每个 `(tenant_id, purpose, sha256, size)` 保存 stable 生命周期行，至少包含 `active | deleting | deleted`、`generation`、`claim_id` 和 `lease_expires_at`；
- `claimUnreachable` 在一个数据库事务中锁定生命周期行、检查引用计数为零、把状态改为 `deleting`、递增 generation，并签发绑定 Tenant/对象/generation/lease 的 claim；
- 所有新增 stable 引用路径必须在同一数据库事务中锁定并读取该生命周期行。`deleting` 返回 `gc_in_progress`，不得写入引用；`deleted` 只有在重新 promote 且 HEAD 验证后，才能由引用事务原子恢复为 `active` 并新增引用；
- S3 删除明确成功后用 claimId + generation compare-and-set 调用 `completeDeletion`；删除明确失败且对象仍存在时才调用 `releaseClaim` 回到 active；
- lease 只控制恢复 Worker 的执行权。lease 到期不能自动解除 `deleting`；恢复 Worker 接管时必须递增 generation，使旧 Worker 无法完成或释放新 claim。

### 影响

- PG Repository 必须把新增引用、引用计数和生命周期状态纳入同一事务，不能把生命周期检查放到事务外；
- stable GC 需要持久化恢复扫描和租约接管，而不是普通定时 DELETE；
- GC 期间新增引用会被显式阻止。调用方应等待 claim 收敛；若对象最终删除，则利用仍保留的 staging 重新 promote、HEAD 验证，再由引用事务恢复 active，而不能把阻止结果当成已经完成 stable 标记；
- 当前任务只定义端口、状态语义和 S3 执行器；PG 表与事务实现由后续持久层任务交付。

### 恢复

- DELETE 或删除后的 HEAD 为 UNKNOWN：保持 `deleting`，不释放 claim，由恢复 Worker 查询对象并继续删除或完成；
- DELETE 明确失败且 HEAD 明确存在：按同 generation 释放 claim，允许稍后重试；
- DELETE 已确认而 `completeDeletion` 失败：仍保持 `deleting`，因为此时允许新增引用会指向缺失对象；恢复 Worker完成数据库状态；
- 过期 Worker 的 complete/release 会因 generation 不匹配被拒绝。

## 引用级媒体类型与交付策略

stable 对象可被多个引用以不同 `mediaType` 使用，因此首次上传到 S3 的 Content-Type 不能决定后续响应。预签名端口必须携带当前 Artifact/Resource 引用的 `responseMediaType`，并通过 `ResponseContentType` 覆盖对象元数据。交付物下载默认生成 `attachment`；只有上层明确选择 `inline-preview` 才生成 `inline`。两条策略都由服务端签名，客户端不能传任意响应头。

## 理由

系统的长期边界是 S3 兼容对象存储，不是 MinIO 专属能力。AWS SDK v3 能以官方 S3 命令和预签名实现该边界，同时保留切换具体服务商的空间。额外依赖成本可以通过精确版本、Lockfile、SBOM 和适配层控制。

## 影响

- 需要维护 AWS SDK 的升级与漏洞扫描；
- MinIO 必须使用 `forcePathStyle` 并通过真实集成测试验证 HEAD、CopyObject 和预签名；
- Provider 错误先在适配层转换成稳定的已知/未知结果，业务层不识别 AWS 异常类型；
- 普通业务流程只能清理 staging；stable 垃圾回收需要新增生命周期行、事务 claim、引用写入守卫和恢复扫描；
- 当前单次上传接收内存字节并受 16 MiB 绝对上限约束，大文件 multipart/streaming 另立任务；
- `mediaType` 的变更不会复制内容对象，业务引用表负责保存各自的展示类型；
- 预签名必须使用当前引用的 mediaType 覆盖 S3 首次对象元数据；下载默认 attachment，预览必须显式选择 inline 策略；
- 未知结果恢复必须持久化并反复查询；任何 HEAD 协议失败都不能缩短恢复流程。

## 验证

- Fake Client 单测覆盖派生键、Tenant 隔离、受控并发条件写、跨 Tenant 同 operation ID、不同 mediaType 复用内容、读取端超限、GC claim 阻止并发引用、claim 完成/释放/UNKNOWN 恢复和 TTL；
- 真实 MinIO 完成 put、head、流式 get、promote、引用级 Content-Type、attachment/inline Content-Disposition、staging 删除与 stable GC，并确认唯一测试前缀无残留；
- Clean install 和供应链检查确认依赖版本没有范围漂移；
- 未来生产对象存储加入同一契约套件。

## 可逆性

`BlobStore` 和 `S3ObjectClient` 隔离了 SDK。只要对象键、元数据和错误契约保持不变，可以在包内改用 MinIO SDK或其他 S3 客户端；生产已经存在的对象无需迁移。若发现目标服务不兼容 CopyObject，可改为受校验的读取后写入，但需记录新决策和性能影响。
