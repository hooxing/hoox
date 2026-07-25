# `@cube-runtime/persistence`

本包保存 Runtime 的持久化边界。目前已实现 S3/MinIO Blob Store 基础；业务 Repository 和 PostgreSQL 表由后续任务实现。

## Blob Store 约束

- 调用必须携带可信 `TenantBlobScope` 和固定 `BlobPurpose`；
- 调用方只传 `uploadId` 或不可变 `BlobRef`，不能传完整对象键；
- staging key 与 stable key 均由包内派生，stable key 使用 SHA-256 内容寻址；
- `putStaging`、`promote` 和 `delete` 可用相同引用幂等重试；
- 所有读取都会校验大小和 SHA-256；S3 ETag 不作为内容哈希；
- Bucket 必须保持私有，预签名下载 TTL 由服务端配置限制；
- 容器内访问地址和浏览器下载地址不同时，分别配置 `endpoint` 与 `publicEndpoint`，签名 URL 只使用后者；
- 单次 `putStaging` 当前接收内存 `Uint8Array`。大文件分片/流式上传需要另立任务，不能绕过同一完整性和补偿协议。

对象键形态只用于运维说明，不属于公开 API：

```text
<prefix>/tenants/<tenant>/staging/<purpose>/<upload-id>
<prefix>/tenants/<tenant>/stable/<purpose>/sha256/<sha256>
```

## 非事务补偿协议

对象存储和 PostgreSQL 不做分布式事务。协调器必须持久化 `BlobCommitSnapshot`，按以下顺序推进：

1. 上传并 HEAD 校验 staging；
2. 使用 `operationId` 幂等提交业务引用；
3. 引用提交明确成功后，复制并校验 stable 对象；
4. 把业务引用切换为 stable；
5. 最后删除 staging；
6. 引用提交前失败的 staging 进入孤儿清理；结果未知时先通过对应 resolve 接口查明，不允许猜测后继续。

`BlobReferenceCommitPort` 和 `BlobCommitStatePort` 是协调契约，本包不实现具体业务表。关键状态迁移由 `transitionBlobCommit` 校验，非法跨越会失败。

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

集成测试使用唯一前缀并在 `finally` 删除自己创建的对象。若未设置 `RUN_MINIO_INTEGRATION=true`，用例会跳过。
