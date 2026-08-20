# 0080 API Blob 物理键前缀连续性

- 状态：已接受
- 日期：2026-08-02


## 背景

Resource 上传由 API 内的 `DurableResourceBlobWriter` 驱动。PostgreSQL Blob 生命周期仓库负责签发 canonical `physicalObjectKey`，S3 BlobStore 负责按该键完成 staging 到 stable 的提升。

API 的 S3 BlobStore 已固定使用持久契约前缀 `agent-worker`，但 API 创建 PostgreSQL 生命周期仓库时没有传入此前缀，仓库回退到历史默认值 `agent-runtime`。因此上传能够写入 staging，却会在提升前的授权连续性校验中失败，并向客户端返回可重试的 `DEPENDENCY_UNAVAILABLE`。

## 备选

1. 放宽 S3 侧连续性校验，接受数据库签发的任意前缀。
2. 修改生命周期仓库的全局默认值。
3. 在 API 装配边界显式把同一个持久前缀同时注入 PostgreSQL 生命周期仓库和 S3 BlobStore。

## 决策

采用方案 3。开发和生产 API 都向 `createApiPersistenceRuntime` 传入：

```ts
blobLifecycle: { objectPrefix: RUNTIME_BLOB_OBJECT_PREFIX }
```

S3 BlobStore 继续使用同一个 `RUNTIME_BLOB_OBJECT_PREFIX`。不放宽完整性校验，也不改变其他调用方可能依赖的仓库默认值。

## 影响

- 新上传的 canonical authorization、allocation 和 S3 stable 目标使用完全相同的物理键。
- 已经因错误前缀签发但未完成的本地上传仍保留原有不可变身份；客户端以新的幂等键重新上传即可，不对可能已签发的远端副作用做隐式改写。
- 前缀仍是持久数据契约；未来修改必须经过显式迁移。

## 验证

- 开发 API 装配测试断言 PostgreSQL 生命周期仓库收到 `agent-worker`。
- 生产 API 装配测试断言同一约束。
- 使用真实 PostgreSQL 与 MinIO 完成一次 HTTP Resource 上传，验证返回成功且对象可读。

## 可逆性

代码改动可以回退，但已经发布的新 Blob 物理键不能通过切换默认前缀迁移；若未来需要改名，必须新增数据与对象迁移流程。
