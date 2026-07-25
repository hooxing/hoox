# `@cube-runtime/persistence`

本包保存 Runtime 的持久化边界。目前已实现 S3/MinIO Blob Store 基础；业务 Repository 和 PostgreSQL 表由后续任务实现。

## Blob Store 约束

- 调用必须携带可信 `TenantBlobScope` 和固定 `BlobPurpose`；
- 上传调用方只传 `uploadId`，不能指定对象键；可信 PG Repository 持久化完整 `StableBlobRef`，其中包含不可变 `incarnationId` 与包内派生的 `physicalObjectKey`；
- SHA-256 与大小是逻辑内容身份/去重键；stable 物理键还包含由 PG 生命周期事务安全随机分配的 UUID incarnation，同一逻辑内容删除后重新发布绝不复用旧键；
- `S3BlobStore` 必须注入可信 `StableBlobLifecycleAllocationPort`。`promote` 会回查 PG 中已持久化的 allocation 并逐字段核对，普通 UUID 或调用方篡改的 allocation 不能触发 COPY；
- `putStaging` 使用条件写入消除 HEAD→PUT 竞态；`putStaging`、`promote` 和 `deleteStaging` 可用相同引用幂等重试；
- 普通业务端口只能删除 staging。stable 删除必须经过 `StableBlobGcPort`；PostgreSQL 必须先以事务 claim 确认零引用并置 `pre_delete`，再用 `beginDeletion` 原子写入不可逆 `deleting` 意图，之后才能发起 S3 DELETE；
- 所有读取都会校验 ContentLength、累计大小和 SHA-256；当前 16 MiB 上限内会先完整缓冲并验证，验证成功前不向消费者交付 chunk；S3 ETag 不作为内容哈希；
- `mediaType` 是业务引用的展示元数据，不参与内容身份。同一 SHA-256 和大小可以被不同 `mediaType` 引用；
- 预签名必须传当前引用的 `responseMediaType`，由 S3 `ResponseContentType` 覆盖首次对象元数据。交付物默认 `attachment`；预览必须显式选择 `inline-preview`；
- Bucket 必须保持私有，预签名下载 TTL 由服务端配置限制；
- 容器内访问地址和浏览器下载地址不同时，分别配置 `endpoint` 与 `publicEndpoint`，签名 URL 只使用后者；
- 单次 `putStaging` 当前接收内存 `Uint8Array`，配置上限不得超过 16 MiB；读取接口提供 `AsyncIterable` 流，并在消费过程中继续执行上限和完整性校验。大文件 multipart/流式上传明确延后，不能通过调高配置绕过内存上限或补偿协议。

对象键形态是持久化与迁移契约；业务调用方不得自行拼接，必须使用 BlobStore 返回并由 PG 持久化的完整引用：

```text
<prefix>/tenants/<tenant>/staging/<purpose>/<upload-id>
<prefix>/stable/<tenant>/<purpose>/sha256/<sha256>/incarnations/<incarnation-id>
```

## 非事务补偿协议

对象存储和 PostgreSQL 不做分布式事务。协调器必须持久化 `BlobCommitSnapshot`，按以下顺序推进：

1. 上传并 HEAD 校验 staging；
2. 使用 `(TenantBlobScope, operationId)` 幂等提交业务引用；
3. 引用提交明确成功后，由 PG 生命周期事务预留并持久化完整 allocation（逻辑身份、incarnation/key、lifecycle/allocation ID、generation、mode），状态进入 `allocation_reserved`；
4. COPY 前持久化 `promotion_started`，再使用同一 allocation 调用 BlobStore 并校验 stable 物理对象；
5. 把业务 ReferenceVersion 切换为携带 incarnationId 与 physicalObjectKey 的 stable 引用；
6. 最后删除 staging；
7. 引用提交前失败的 staging 进入孤儿清理；补偿事件明确记录目标为 staging；结果未知时先通过同一 Tenant scope 下的对应 resolve 接口查明，不允许猜测后继续。

`BlobReferenceCommitPort` 和 `BlobCommitStatePort` 是协调契约，本包不实现具体业务表。PostgreSQL 实现必须以 `(tenant_id, operation_id)` 建立复合唯一约束，所有 load/CAS/resolve 都必须同时校验 Tenant scope；不同 Tenant 可以使用相同 `operationId`。关键状态迁移由 `transitionBlobCommit` 校验，非法跨越会失败。

PUT、COPY 或 DELETE 返回不确定结果后，只能通过后续 HEAD 的明确存在/不存在收敛；HEAD 自身失败时仍保持 `BLOB_RESULT_UNKNOWN`，由恢复任务重试，不能误判为成功或失败。stable GC 也遵守同一规则。

stable GC 的 `claimUnreachable` 必须在 PG 事务中检查零引用并写入 `pre_delete + generation + lease`；租约未过期稳定返回 `in_progress`。`beginDeletion` 用 generation CAS 写入不可逆 deleting 意图。只有从未 begin 的 pre-delete claim 可以释放；进入 deleting 后，即使 DELETE 明确失败、UNKNOWN、lease 到期或旧 Worker失去 generation，都不能恢复 active，因为旧 DELETE 仍可能延迟成功。恢复 Worker 保持 phase、递增 generation，重试幂等 DELETE 并收敛 deleted。所有新增 stable 引用在 `pre_delete/deleting` 时返回 `gc_in_progress`。

每个 ReferenceVersion、生命周期行和 GC claim 都必须绑定完全一致的 `incarnationId + physicalObjectKey`。GC 只能删除 claim 中的精确物理键，不能从 SHA-256 查询“当前对象”后删除。deleted 后重新发布必须分配新 incarnation；旧 DELETE 即使延迟成功也只能命中旧键。本协议不依赖 S3 bucket versioning。

`stable_mark_gc_blocked` 必须先解析生命周期：active 可重试标记，pre-delete/deleting 继续等待，只有明确 deleted 才能退回复制步骤并使用仍保留的 staging 重新 promote，不能从阻塞状态直接复制。

COPY 返回 UNKNOWN 时，`promotion_unknown` 必须继续保存完整 allocation 和目标 StableBlobRef；HEAD/COPY 重试只能围绕同一 physicalObjectKey 收敛，不能分配或切换 incarnation。GC 明确 deleted 时旧 incarnation 同步写入永久 retired 历史；协调器回到 `reference_committed` 后必须取得 `new_after_deleted` 新 allocation，旧 StableBlobRef/active_reuse allocation 均会被状态机拒绝。

来自调用参数的非法大小返回 `INVALID_BLOB_ARGUMENT`；来自 S3 HEAD metadata.size、GET ContentLength 或响应正文的超限属于存储响应完整性问题，返回 `BLOB_INTEGRITY_MISMATCH`。
`expectedSha256/expectedSize` 先校验参数格式，格式错误返回 `INVALID_BLOB_ARGUMENT`；只有格式合法但与正文不一致时返回 `BLOB_INTEGRITY_MISMATCH`。

## 测试

普通测试不访问网络：

```powershell
corepack pnpm test
```

MinIO 集成测试显式启用，并从进程环境读取 S3 配置。可以在仓库根目录使用 Node 加载本地 `.env`，测试不会打印配置值：

```powershell
$env:RUN_MINIO_INTEGRATION='true'
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run runtime-ts/packages/persistence/src/s3-minio.integration.test.ts
```

集成测试预先固定引用和键，使用唯一前缀，并在 `finally` 独立执行 staging 与 stable GC 两条清理路径；若正常清理失败，测试会按唯一前缀兜底清理并确认无残留。若未设置 `RUN_MINIO_INTEGRATION=true`，用例会跳过。
