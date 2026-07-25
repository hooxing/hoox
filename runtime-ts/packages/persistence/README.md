# `@cube-runtime/persistence`

本包保存 Runtime 的持久化边界。目前已实现 S3/MinIO Blob Store 基础；业务 Repository 和 PostgreSQL 表由后续任务实现。

## Blob Store 约束

- 调用必须携带可信 `TenantBlobScope` 和固定 `BlobPurpose`；
- 调用方只传 `uploadId` 或不可变 `BlobRef`，不能传完整对象键；
- staging key 与 stable key 均由包内派生，stable key 使用 SHA-256 内容寻址；
- `putStaging` 使用条件写入消除 HEAD→PUT 竞态；`putStaging`、`promote` 和 `deleteStaging` 可用相同引用幂等重试；
- 普通业务端口只能删除 staging。stable 删除必须经过 `StableBlobGcPort`；PostgreSQL 必须用事务 claim 同时确认零引用并把生命周期置为 `deleting`，从而阻止删除期间新增引用；
- 所有读取都会校验 ContentLength、流式累计大小和 SHA-256；S3 ETag 不作为内容哈希；
- `mediaType` 是业务引用的展示元数据，不参与内容身份。同一 SHA-256 和大小可以被不同 `mediaType` 引用；
- 预签名必须传当前引用的 `responseMediaType`，由 S3 `ResponseContentType` 覆盖首次对象元数据。交付物默认 `attachment`；预览必须显式选择 `inline-preview`；
- Bucket 必须保持私有，预签名下载 TTL 由服务端配置限制；
- 容器内访问地址和浏览器下载地址不同时，分别配置 `endpoint` 与 `publicEndpoint`，签名 URL 只使用后者；
- 单次 `putStaging` 当前接收内存 `Uint8Array`，配置上限不得超过 16 MiB；读取接口提供 `AsyncIterable` 流，并在消费过程中继续执行上限和完整性校验。大文件 multipart/流式上传明确延后，不能通过调高配置绕过内存上限或补偿协议。

对象键形态只用于运维说明，不属于公开 API：

```text
<prefix>/tenants/<tenant>/staging/<purpose>/<upload-id>
<prefix>/tenants/<tenant>/stable/<purpose>/sha256/<sha256>
```

## 非事务补偿协议

对象存储和 PostgreSQL 不做分布式事务。协调器必须持久化 `BlobCommitSnapshot`，按以下顺序推进：

1. 上传并 HEAD 校验 staging；
2. 使用 `(TenantBlobScope, operationId)` 幂等提交业务引用；
3. 引用提交明确成功后，复制并校验 stable 对象；
4. 把业务引用切换为 stable；
5. 最后删除 staging；
6. 引用提交前失败的 staging 进入孤儿清理；补偿事件明确记录目标为 staging；结果未知时先通过同一 Tenant scope 下的对应 resolve 接口查明，不允许猜测后继续。

`BlobReferenceCommitPort` 和 `BlobCommitStatePort` 是协调契约，本包不实现具体业务表。PostgreSQL 实现必须以 `(tenant_id, operation_id)` 建立复合唯一约束，所有 load/CAS/resolve 都必须同时校验 Tenant scope；不同 Tenant 可以使用相同 `operationId`。关键状态迁移由 `transitionBlobCommit` 校验，非法跨越会失败。

PUT、COPY 或 DELETE 返回不确定结果后，只能通过后续 HEAD 的明确存在/不存在收敛；HEAD 自身失败时仍保持 `BLOB_RESULT_UNKNOWN`，由恢复任务重试，不能误判为成功或失败。stable GC 也遵守同一规则。

stable GC 的 `claimUnreachable` 必须在 PG 事务中检查零引用并写入 `deleting + generation + lease`。所有新增 stable 引用必须在自己的 PG 事务中读取同一生命周期行，`deleting` 时返回 `gc_in_progress`；`deleted` 只有在重新 promote 并 HEAD 验证后才能由引用事务原子恢复 active。DELETE 成功后按 generation 完成 claim；明确失败且对象仍存在时释放；UNKNOWN 或删除后数据库完成失败均保留 claim 给恢复任务。lease 过期只允许新 Worker 递增 generation 后接管，不能自动恢复 active。

来自调用参数的非法大小返回 `INVALID_BLOB_ARGUMENT`；来自 S3 ContentLength 或流式响应的超限属于存储响应完整性问题，返回 `BLOB_INTEGRITY_MISMATCH`。

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
