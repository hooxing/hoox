# `@hoox/persistence`

本包保存 Runtime 的持久化边界。目前已实现核心业务 Repository、S3/MinIO Blob Store、ADR-0012 定义的 PostgreSQL stable blob 生命周期，以及 ADR-0014 定义的 Run Worker 执行事实与事务适配器。

Resource Library 已增加 PostgreSQL 目录与显式提升提交：生产装配只暴露窄的 `ResourceCatalog` 和 verifier-gated `ResourcePromotionCommitPort`，创建运行时必须注入与受控 Tool Router 配对的 `PromotionCapabilityVerifier`，没有默认绕过。ResourceVersion 复合绑定 stable Blob 完整物理身份，pending 不可搜索；授权签发仍等待 Workspace 逐文件 Manifest 持久化，不在本包伪造完成。

## Run Worker PostgreSQL 约束

- API/调度器先用 `PgRunExecutionSetup` 写入不可变执行 scope、输入和初始 RolloutProjection；Worker 只能通过 `PgExecutionPersistence` claim；
- 初始化重放会锁行并逐字段核对，不同内容返回 `conflict`；waiting 回答必须同时提供预期 Run version 与旧回答；
- claim 同时创建 ExecutionAttempt、Run claim 与 Workspace lease，租约和所有发生时间只使用数据库时钟；
- `mutate` 在一个 SERIALIZABLE 事务内处理事件、EffectInvocation、Outbox、Projection、WorkspaceRevision、Run/Attempt 与不可变 receipt；
- COMMIT 响应未知返回 `response_unknown`，调用方必须按原始完整 scope 与幂等键调用 `readMutation`；
- 相同幂等键只接受相同 command digest；Attempt 内 callId 永久唯一，外部副作用 permit 一次性签发并消费；
- `model_start` 还要求已提交 `model_execution_started` checkpoint，并由数据库保证每个 Attempt 永久最多签发一次；
- 普通 Worker 不能重领 running Run，双租约过期后由恢复协调器调用 `recoverExpiredAttempt`；
- `PgBackedSandboxSessionRegistry` 负责把已取得的 Sandbox 先登记为数据库事实，再暴露给 Worker；本阶段不包含 cleanup Outbox consumer 和周期恢复扫描器。

执行端口和协议位于 `@hoox/run-contracts`，应用目录只保留兼容导出。生产表全部 FORCE RLS，Runtime 角色使用表/列白名单且没有 routine 权限。

## Workspace candidate 交接

`0015_workspace_candidate_handoff` 实现 ADR-0047 的 Workspace 发布事务边界：Sandbox 快照产生的新 stable
引用必须先绑定到完整 Attempt candidate，candidate 从 `building` 经 manifest 逐文件核验进入 `prepared`。
最终 `PgExecutionPersistence` 在同一 SERIALIZABLE RuntimeMutation 中写入 revision/manifest/files、推进
Workspace head、把 uploaded 引用标记为 `released` 并把 candidate 标记为 `committed`。已提交 revision file
随后是 GC 可达事实，released 引用仅保留审计身份。

同路径且内容与精确 incarnation 均未变化的文件直接复用 parent revision，不创建新 Blob 或引用。发布明确
失败、修正轮次、终态释放栅栏和租约过期恢复会在 PostgreSQL 事务内释放仍处于 building/prepared 的
candidate 与 uploaded 引用；COMMIT 响应未知只能通过原 RuntimeMutation 幂等键读取结果。stable 读取授权
及续期逐字段绑定 Tenant、Thread、Workspace、revision 和 relative path，不能用同一物理 Blob 越过文件事实。

`released` 是不可逆的生命周期状态，不计入 stable 引用可达性。迁移 down 只删除 candidate 协调表，故意
保留 released 状态和约束，避免把已释放引用错误恢复为会阻止 GC 的 stable。

## Blob Store 约束

- 调用必须携带可信 `TenantBlobScope` 和固定 `BlobPurpose`；
- 上传调用方只传 `uploadId`，不能指定对象键；可信 PG Repository 持久化完整 `StableBlobRef`，其中包含不可变 `incarnationId` 与包内派生的 `physicalObjectKey`；
- SHA-256 与大小是逻辑内容身份/去重键；stable 物理键还包含由 PG 生命周期事务安全随机分配的 UUID incarnation，同一逻辑内容删除后重新发布绝不复用旧键；
- `S3BlobStore` 必须注入可信 `StableBlobPromotionAuthorizationPort`。`promote` 只接受 `tenantId + operationId + authorizationId` 最小引用，再从 PG 解析完整规范授权；调用方自造 allocation/UUID、其他 operation、仅 reserved、retired 或 consumed 授权均不能触发 COPY；
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
3. 引用提交明确成功后，由 PG 生命周期事务预留并持久化完整 allocation；调用方不传 mode，由 PG 根据当前 lifecycle 与永久 retired 历史原子决定 `active_reuse | new_after_deleted`，状态进入 `allocation_reserved`；
4. 协调器只用 scope、operationId、expectedSnapshotVersion、allocationId 调用 `StatePort.startPromotion`。Repository 在同一 PG 事务中读取 snapshot、allocation/lifecycle 与永久 retired 历史，自行派生 canonical target/auth，并 CAS 到 `promotion_started`；调用方不能传 mode、target 或完整 authorization；
5. 每次 `promote` 生成不可碰撞 attemptId，并以最小授权引用原子 `claimPromotionExecution`。只有 `copy_allowed` attempt 可以继续；其他并发得到 `in_progress`，executing/unknown 只得到 `reconcile`。claim 必须先持久化显式 `pre_intent` 证明记录，远端 COPY 前再由 `markPromotionCopyIssued` 写不可撤销 intent；intent 前确定失败可把证明记为 `not_copied`，但不能删除 execution/审计记录。commit 只有通过 `StatePort.provePromotionNotCopied` 在同一 PG 事务消费 pre_intent/not_copied 证明并留下永久 tombstone，才能撤销授权回到 `allocation_reserved`；证明缺失、copy-issued 或 mark 响应未知一律不能回退；
6. 把业务 ReferenceVersion 切换为携带 incarnationId 与 physicalObjectKey 的 stable 引用；
7. 最后删除 staging；
8. 引用提交前失败的 staging 进入孤儿清理；补偿事件明确记录目标为 staging；结果未知时先通过同一 Tenant scope 下的对应 resolve 接口查明，不允许猜测后继续。

`BlobReferenceCommitPort` 和 `BlobCommitStatePort` 由 `PgBlobLifecycleRepository` 实现，并以 `(tenant_id, operation_id)` 建立复合唯一约束；所有 load/CAS/resolve 都同时校验 Tenant scope，不同 Tenant 可以使用相同 `operationId`。规范 lifecycle/incarnation/allocation/authorization/execution 是物理身份事实源，JSON commit snapshot 只承担协调状态。关键状态迁移由 `transitionBlobCommit` 校验，普通 CAS 不能签发 promotion 授权或撤销已开始授权。

PUT、COPY 或 DELETE 返回不确定结果后，只能通过后续 HEAD 的明确存在/不存在收敛；HEAD 自身失败时仍保持 `BLOB_RESULT_UNKNOWN`，由恢复任务重试，不能误判为成功或失败。stable GC 也遵守同一规则。

stable GC 的 `claimUnreachable` 必须在 PG 事务中检查零引用并写入 `pre_delete + generation + lease`；租约未过期稳定返回 `in_progress`。`beginDeletion` 用 generation CAS 写入不可逆 deleting 意图。只有从未 begin 的 pre-delete claim 可以释放；进入 deleting 后，即使 DELETE 明确失败、UNKNOWN、lease 到期或旧 Worker失去 generation，都不能恢复 active，因为旧 DELETE 仍可能延迟成功。恢复 Worker 保持 phase、递增 generation，重试幂等 DELETE 并收敛 deleted。所有新增 stable 引用在 `pre_delete/deleting` 时返回 `gc_in_progress`。

每个 ReferenceVersion、生命周期行和 GC claim 都必须绑定完全一致的 `incarnationId + physicalObjectKey`。GC 只能删除 claim 中的精确物理键，不能从 SHA-256 查询“当前对象”后删除。deleted 后重新发布必须分配新 incarnation；旧 DELETE 即使延迟成功也只能命中旧键。本协议不依赖 S3 bucket versioning。

`stable_mark_gc_blocked` 必须先解析生命周期：active 可重试标记，pre-delete/deleting 继续等待，只有明确 deleted 才能退回复制步骤并使用仍保留的 staging 重新 promote，不能从阻塞状态直接复制。

COPY 返回 UNKNOWN 时，commit snapshot 继续保持 `promotion_started` 与同一授权，execution 行保存 unknown/reconcile 及原 generation/attempt；不存在可被协调器解析成“未复制”的独立 UNKNOWN commit 状态。恢复只 HEAD 固定 destination：正确即 succeeded；NotFound、HEAD 异常或授权解析异常均保持同一授权与 unknown/reconcile，绝不能检查 source 后重发 COPY，也不能降为 not_copied。started/executing/unknown 存在时生命周期/GC 事务禁止退休该 incarnation。allocation mode 完全由可信 PG 生命周期事务依据全局永久历史决定；协调器不得由本 operation 是否见过 retired 反推 mode。

所有进入 S3 远端副作用的 Persistence 带值返回都必须先经字段白名单快照：Promotion claim/authorization resolution/mark、GC claim/beginDeletion、retired tombstone claim 的 root status 及每个嵌套字段只读取一次到普通对象，禁止 spread、structuredClone 或在分支、日志、DELETE/COPY、complete 中再次观察端口原对象。动态 getter、字段缺失、格式或连续性异常统一为 `BLOB_INTEGRITY_MISMATCH(result=unknown)`；只有已快照并验证的最小 execution identity 可以用于 best-effort reconcile，GC/tombstone 则必须在 DELETE 前完整绑定 plain snapshot 的 CAS 与物理 key。

远端请求一旦签发就无法撤销。即使缓存的旧 COPY 在授权收敛并发布新 incarnation 后迟到，它也只能写入永不复用的 retired physical key，不能覆盖新对象。retired key 的 tombstone 永久保留，GC scrub 必须可重复删除该精确键，使迟到写入收敛为可恢复孤儿。

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
