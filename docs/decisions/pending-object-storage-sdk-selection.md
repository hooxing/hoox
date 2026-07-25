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
- stable 对象不暴露通用删除方法，只能由专用 GC 端口在持久层给出 Tenant 范围内的不可达证明后回收；
- 内容身份由 Tenant、用途、SHA-256 和大小决定；`mediaType` 属于业务引用的展示元数据，不参与 stable 内容身份；
- 当前上传 API 只接收 `Uint8Array`，运行时配置不得超过 16 MiB；读取采用流式接口并同时校验 ContentLength、累计大小和 SHA-256；multipart/流式上传延后单独设计；
- PUT、COPY、DELETE 返回未知后，仅在 HEAD 得到明确结果时收敛。HEAD 失败仍为未知，由恢复任务重试，不能把协议异常当成 NotFound；
- 非事务提交与恢复状态按 `(tenant_id, operation_id)` 寻址，数据库实现必须建立复合唯一约束并校验 Tenant scope。

## 理由

系统的长期边界是 S3 兼容对象存储，不是 MinIO 专属能力。AWS SDK v3 能以官方 S3 命令和预签名实现该边界，同时保留切换具体服务商的空间。额外依赖成本可以通过精确版本、Lockfile、SBOM 和适配层控制。

## 影响

- 需要维护 AWS SDK 的升级与漏洞扫描；
- MinIO 必须使用 `forcePathStyle` 并通过真实集成测试验证 HEAD、CopyObject 和预签名；
- Provider 错误先在适配层转换成稳定的已知/未知结果，业务层不识别 AWS 异常类型；
- 普通业务流程只能清理 staging；stable 垃圾回收需要新增可达性查询和证明持久化实现；
- 当前单次上传接收内存字节并受 16 MiB 绝对上限约束，大文件 multipart/streaming 另立任务；
- `mediaType` 的变更不会复制内容对象，业务引用表负责保存各自的展示类型；
- 未知结果恢复必须持久化并反复查询；任何 HEAD 协议失败都不能缩短恢复流程。

## 验证

- Fake Client 单测覆盖派生键、Tenant 隔离、受控并发条件写、跨 Tenant 同 operation ID、不同 mediaType 复用内容、大小上限、GC 权限、未知结果和 TTL；
- 真实 MinIO 完成 put、head、流式 get、promote、中文文件名 presign、staging 删除与 stable GC，并确认唯一测试前缀无残留；
- Clean install 和供应链检查确认依赖版本没有范围漂移；
- 未来生产对象存储加入同一契约套件。

## 可逆性

`BlobStore` 和 `S3ObjectClient` 隔离了 SDK。只要对象键、元数据和错误契约保持不变，可以在包内改用 MinIO SDK或其他 S3 客户端；生产已经存在的对象无需迁移。若发现目标服务不兼容 CopyObject，可改为受校验的读取后写入，但需记录新决策和性能影响。
