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
- 逻辑内容身份由 Tenant、用途、SHA-256 和大小决定；物理对象身份额外包含不可复用 incarnation；`mediaType` 属于业务引用展示元数据；
- 当前上传 API 只接收 `Uint8Array`，运行时配置不得超过 16 MiB；读取采用流式接口并同时校验 ContentLength、累计大小和 SHA-256；multipart/流式上传延后单独设计；
- PUT、COPY、DELETE 返回未知后，仅在 HEAD 得到明确结果时收敛。HEAD 失败仍为未知，由恢复任务重试，不能把协议异常当成 NotFound；
- 非事务提交与恢复状态按 `(tenant_id, operation_id)` 寻址，数据库实现必须建立复合唯一约束并校验 Tenant scope。

## stable GC 事务 Claim

### 背景

“先查询零引用、再删除对象”的快照证明存在 TOCTOU：查询完成后、S3 删除前可能并发新增引用，导致数据库出现指向已删除对象的引用。`checkedAt` 只能说明过去某一时刻不可达，不能作为删除授权。

即使使用不可逆 deleting 和 generation，generation 也只能阻止旧 Worker 写 PostgreSQL，无法撤销已经发给 S3 的 DELETE。若 deleted 后重新发布仍复用 `sha256` 物理键，旧 DELETE 可以在新对象发布后延迟落地并删除新内容。因此不能让逻辑去重键同时承担可复用物理地址。

### 方案

- PostgreSQL 为每个 `(tenant_id, purpose, sha256, size)` 保存逻辑内容生命周期；当前 incarnation 记录至少包含安全随机 UUID `incarnation_id`、完整 `physical_object_key`、`active | pre_delete | deleting | deleted`、`generation`、`claim_id` 和 `lease_expires_at`；
- stable 物理键固定为 `<prefix>/stable/<tenant>/<purpose>/sha256/<hash>/incarnations/<incarnation-id>`。SHA-256 继续用于逻辑去重；incarnationId 由 PG 生命周期事务分配并持久化，active 时复用当前 incarnation，deleted 后重新发布必须分配新 UUID；
- 引入可信 `StableBlobLifecycleAllocationPort` 与 `StableBlobPromotionAuthorizationPort`。reserve 输入不含 mode，由 PG 在锁定 lifecycle 与永久 retired 历史后原子决定 `active_reuse | new_after_deleted`。S3 promote 不接收 allocation，只接收 tenantId、operationId、authorizationId 最小引用，再从 PG 解析完整规范授权并全字段比对；
- `claimUnreachable` 在一个数据库事务中锁定生命周期行并检查引用计数。零引用的 active 行进入 `pre_delete` 并签发租约；租约未到期的 `pre_delete/deleting` 稳定返回 `in_progress`，不能并发签发 claim；
- Worker 必须调用 `beginDeletion`，以 claimId + generation CAS 把 `pre_delete` 原子推进到不可逆 `deleting`，只有收到 `started + deleting claim` 后才能发起 S3 DELETE；
- 所有新增 stable 引用路径必须在同一数据库事务中锁定并读取该生命周期行。`pre_delete/deleting` 返回 `gc_in_progress`；active 引用必须复用并持久化当前 incarnationId/physicalObjectKey；deleted 重新发布时先分配新 incarnation，promote+HEAD 后再由引用事务激活并写入精确物理身份；
- 只有从未调用 `beginDeletion` 的 `pre_delete` claim 才允许 `releasePreDeleteClaim`。一旦进入 `deleting`，DELETE 明确失败、UNKNOWN、lease 到期和 Worker 接管均不得恢复 active；
- GC claim 必须绑定被 claim 时的 incarnationId 与完整 physicalObjectKey，执行器只删除该精确键；禁止仅凭 sha256 解析“当前 incarnation”；
- S3 删除明确成功后用 claimId + generation 联合 CAS 调用 `completeDeletion`；lease 到期与 claim 是否有效完全由 PG 事务/端口判定，S3 executor 不读取应用进程 `Date.now()`。接管保持物理身份与 phase，只递增 generation/claimId；
- 不依赖 S3 bucket versioning。安全性来自不可复用物理键：旧 Worker即使在新 incarnation 激活后才完成 DELETE，也只能作用旧 physicalObjectKey。
- commit 协调状态在 COPY 前依次持久化 `allocation_reserved` 与 `promotion_started`。`StatePort.startPromotion` 只接收 scope、operationId、expectedSnapshotVersion、allocationId 最小命令；Repository 在同一事务读取并锁定 snapshot、allocation/lifecycle/retired 历史，自行派生全部 canonical 字段与授权。公开 API 不接收完整 allocation/auth，调用方附带的结构与 getter 均不能影响派生结果。
- 每次 promote 生成随机 UUID attemptId。`claimPromotionExecution` 一次性 CAS 并绑定 executionId、generation、attemptId、incarnation/key：只有一个 attempt 得到 copy_allowed；其他新并发为 in_progress，executing/unknown 返回 reconcile，接管只能由 PG lease/generation 决定。COPY 前 `markPromotionCopyIssued` 写不可撤销 intent。intent 前确定失败才能 not_copied；intent 后只允许 executing/unknown/succeeded。
- GC lifecycle 明确 deleted 时，completeDeletion 原子写 deleted 并把旧 incarnation/key 放入永久 retired 历史。allocation mode 只由可信 PG 事务读取全局 lifecycle/retired 历史决定；协调器不从当前 operation 的局部 retired 信息推断 mode，只在确有旧 target 时校验新 incarnation/key 不同。因此新 operation 首次看到全局 deleted 逻辑 Blob 时也可以合法接收 `new_after_deleted`。

### 影响

- PG Repository 必须把新增引用、引用计数和生命周期状态纳入同一事务，不能把生命周期检查放到事务外；
- 每个 ReferenceVersion、生命周期记录、恢复任务和 GC claim 都必须保存 incarnationId + physicalObjectKey；只存 sha256 不足以安全读取或删除；
- allocation reserve、promotion authorization、execution claim 与 commit snapshot 都要持久化 lifecycleId、allocationId、generation、mode。executing/UNKNOWN 只能 HEAD 同一 destination；正确即 succeeded，NotFound/HEAD 或 resolve 异常保持 reconcile，禁止 source 检查和重复 COPY。完成 CAS 明确区分 succeeded、intent 前 not_copied、intent 后 unknown/reconcile；
- stable GC 需要持久化恢复扫描、`pre_delete → deleting` 意图日志和租约接管，而不是普通定时 DELETE；
- GC 期间新增引用会被显式阻止。调用方应等待 claim 收敛；若对象最终删除，则利用仍保留的 staging 重新 promote、HEAD 验证，再由引用事务恢复 active，而不能把阻止结果当成已经完成 stable 标记；
- 当前任务只定义端口、状态语义和 S3 执行器；PG 表与事务实现由后续持久层任务交付。

### 恢复

- DELETE、删除后的 HEAD 或 Provider 明确失败：只要 `beginDeletion` 已成功，都保持 `deleting`，由恢复 Worker 重试幂等 DELETE 并收敛；
- 只有尚未产生远端删除意图的 `pre_delete` claim 可因任务取消明确释放；beginDeletion 结果未知时也不能释放，因为事务可能已经提交；
- DELETE 已确认而 `completeDeletion` 失败：仍保持 `deleting`，因为此时允许新增引用会指向缺失对象；恢复 Worker完成数据库状态；
- 旧 DELETE 在 lease 到期后延迟成功：继任 Worker即使先遇到明确失败也保持 deleting；待租约再次到期后重试 DELETE/HEAD，并由当前 generation 完成 deleted；
- 过期 Worker 的 complete/begin/pre-delete release 会因 generation 不匹配被拒绝。
- 若 gen2 已完成旧 incarnation 的 deleted，可以分配并发布新 incarnation；随后落地的 gen1 DELETE 仍只命中 claim 绑定的旧物理键，新对象与新引用不受影响。

读取仍采用 `AsyncIterable` API，但在当前 16 MiB 上限内先缓冲全部响应并完成大小和 SHA-256 校验，再向消费者产生第一个 chunk，避免最终哈希失败前产生可提交的外部效果。S3 HEAD/GET 返回的 metadata.size 或 ContentLength 超限属于 `BLOB_INTEGRITY_MISMATCH`，只有调用参数和配置非法才是 `INVALID_BLOB_ARGUMENT`。

`expectedSha256` 和 `expectedSize` 在内容比较前先做调用参数校验：哈希格式、整数范围错误属于 `INVALID_BLOB_ARGUMENT`；参数合法但与实际正文不同才属于 `BLOB_INTEGRITY_MISMATCH`。GC claim 的格式错误同样是 `INVALID_BLOB_ARGUMENT`，Tenant 错配是 `TENANT_SCOPE_MISMATCH`，与目标 incarnation/physical key 错配是 `BLOB_INTEGRITY_MISMATCH`。lease 的时间有效性由 PG 决定，executor 只接受规范 UTC ISO（毫秒精度 `Z`）并验证 beginDeletion 除 phase 外全部字段连续。

`stable_mark_gc_blocked` 不能直接重新 promote。协调器必须先调用生命周期解析端口：`pre_delete/deleting` 继续阻塞，`active` 回到标记重试，只有明确 `deleted` 才退回复制步骤并使用保留的 staging 重新 promote。

## 引用级媒体类型与交付策略

stable 对象可被多个引用以不同 `mediaType` 使用，因此首次上传到 S3 的 Content-Type 不能决定后续响应。预签名端口必须携带当前 Artifact/Resource 引用的 `responseMediaType`，并通过 `ResponseContentType` 覆盖对象元数据。交付物下载默认生成 `attachment`；只有上层明确选择 `inline-preview` 才生成 `inline`。两条策略都由服务端签名，客户端不能传任意响应头。

## 数据模型与迁移要求

- stable 生命周期表增加 `incarnation_id uuid`、`physical_object_key text`，二者非空；建议 `(tenant_id, purpose, sha256, size, incarnation_id)` 唯一，当前 active incarnation 另设部分唯一约束；
- ReferenceVersion 的 stable 指针和 GC/恢复任务载荷必须同时增加 `incarnation_id`、`physical_object_key`，外键/事务检查保证它们指向同一生命周期 incarnation；
- claimId 与 generation 是联合 CAS 条件；begin、complete、pre-delete release 任一字段不匹配都拒绝；
- `stable_blob_incarnations` 至少建立 `UNIQUE (tenant_id, purpose, incarnation_id)` 与 `UNIQUE (tenant_id, purpose, physical_object_key)`；建议 physical_object_key 再做全局唯一。retired 行永久保留，不能被 GC/归档物理删除，也不能被 reserve 再次选中；
- allocation 记录以 allocation_id 唯一，并关联 lifecycle_id、generation 和 incarnation 外键；ReferenceVersion/commit snapshot 保存相同身份。数据库约束或事务触发器禁止 retired incarnation 重新进入 active；
- promotion authorization 以 authorization_id 唯一，并关联 tenant_id、operation_id、reference_id、staging_upload_id/key、allocation_id 与完整目标描述；execution 行以 authorization_id + generation 做 CAS，保存 attempt_id、execution_id、lease、phase 与精确 physical key。`promotion_started` CAS 与授权写入必须同事务；started/executing/unknown 受生命周期外键/事务守卫保护，禁止退休。
- retired physical key 保留永久 tombstone 与 scrub 游标。已发出的旧 COPY 无法撤销，迟到时只会重新形成旧 key 孤儿；scrubber 幂等重复 DELETE 旧 key，绝不从逻辑 hash 解析“当前 key”。
- 本项目是全新实现，不迁移旧 Python 原型。此前开发 MinIO 中不含 incarnation 的 stable key 只视为测试数据，应清理后重新发布；不提供旧 key 只读兼容，也不通过启用 bucket versioning 兜底；
- 若未来已有生产对象，必须另做离线迁移：冻结写入、为每个旧对象分配 incarnation、复制到新键、回填所有 ReferenceVersion 后再启用 GC，不能原地把旧键当新 incarnation。

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

- Fake Client 单测覆盖派生 incarnation 键、Tenant 隔离、受控并发条件写、不同 mediaType 复用逻辑内容、参数/响应分类、校验前零 chunk 交付、claimId+generation 联合 CAS、GC busy/租约接管、旧 DELETE 延迟成功后新 incarnation 仍可读且 GC 只删旧物理键；
- 真实 MinIO 完成 put、head、流式 get、promote、引用级 Content-Type、attachment/inline Content-Disposition、staging 删除与 stable GC，并确认唯一测试前缀无残留；
- Clean install 和供应链检查确认依赖版本没有范围漂移；
- 未来生产对象存储加入同一契约套件。

## 可逆性

`BlobStore` 和 `S3ObjectClient` 隔离了 SDK。保持 incarnation 键、元数据和错误契约即可在包内更换 S3 客户端；更换 SDK不需要对象迁移。旧版无 incarnation 的对象键与本决策不兼容，迁移要求见上节。若目标服务不兼容 CopyObject，可改为受校验的读取后写入，但需记录新决策和性能影响。
