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

## 理由

系统的长期边界是 S3 兼容对象存储，不是 MinIO 专属能力。AWS SDK v3 能以官方 S3 命令和预签名实现该边界，同时保留切换具体服务商的空间。额外依赖成本可以通过精确版本、Lockfile、SBOM 和适配层控制。

## 影响

- 需要维护 AWS SDK 的升级与漏洞扫描；
- MinIO 必须使用 `forcePathStyle` 并通过真实集成测试验证 HEAD、CopyObject 和预签名；
- Provider 错误先在适配层转换成稳定的已知/未知结果，业务层不识别 AWS 异常类型；
- 当前单次上传接收内存字节，大文件 multipart/streaming 另立任务。

## 验证

- Fake Client 单测覆盖派生键、Tenant 隔离、幂等、完整性、未知结果和 TTL；
- 真实 MinIO 完成 put、head、get、promote、presign、delete；
- Clean install 和供应链检查确认依赖版本没有范围漂移；
- 未来生产对象存储加入同一契约套件。

## 可逆性

`BlobStore` 和 `S3ObjectClient` 隔离了 SDK。只要对象键、元数据和错误契约保持不变，可以在包内改用 MinIO SDK或其他 S3 客户端；生产已经存在的对象无需迁移。若发现目标服务不兼容 CopyObject，可改为受校验的读取后写入，但需记录新决策和性能影响。
