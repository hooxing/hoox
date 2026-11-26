# 对象存储兼容性验证

本文面向为 Hoox 接入或升级 S3 兼容存储的部署维护者，说明生产路径依赖的 S3 能力、可重复执行的验收方法与已验证结果。文件事实与下载边界以[Workspace、Resource 与交付物](../architecture/workspace-and-files.md)为准；本套件不验证 PostgreSQL 生命周期、IAM 最小权限、浏览器 CORS 或供应商服务等级。

## 能力清单

| 能力 | 使用位置与验收要求 |
| --- | --- |
| `HeadObject` readiness | Blob 与 Skill 发布对固定哨兵键 `__hoox_readiness__/nonexistent` 发 HEAD；200/404 就绪，其他失败，不调用 `HeadBucket`；Bucket 必须预先创建 |
| `PutObject`、`GetObject`、`HeadObject`、`DeleteObject` | Blob 上传、校验读取与清理；支持零字节、1 MiB、9 MiB + 17 字节，保持 `Content-Length`、`Content-Type`、`Cache-Control` 和用户元数据 `sha256` |
| 条件首写 | 默认 `If-None-Match: *`；OSS 使用 `x-oss-forbid-overwrite: true`，不发送 `If-None-Match`。首次写入成功；重复或并发竞争的输家返回 HTTP 412 或 HTTP 409 `FileAlreadyExists`，不能覆盖赢家；Blob 端口统一映射为 `BLOB_PRECONDITION_FAILED`，业务层再校验相同内容并幂等收敛；Skill 发布同样读取规范对象确认结果 |
| `CopyObject` | 正确编码源键，复制正文、媒体类型与 `sha256` 元数据；缓存策略仍是 `private, no-store` |
| UTF-8 与保留字符对象键 | 中文、空格、`+`、`%`、`?`、`#`、`&`、`=`、引号与括号的读写和复制，不把 URI 编码当作实际对象键 |
| SigV4 预签名 GET | 使用 `S3_PUBLIC_ENDPOINT` 签发，由 Node `fetch` 实际下载；普通 S3 覆盖 `Content-Type`，OSS 不发送 `response-content-type` 并使用写入元数据；均支持 UTF-8 `Content-Disposition`，真实时间过期后拒绝访问 |
| SDK 请求与响应校验和 | AWS SDK `3.1095.0`：分别运行 `WHEN_SUPPORTED`、`WHEN_REQUIRED` 的缓冲和流式上传、读取；检查 CRC32 请求头或 trailer，以及 `aws-chunked` 是否实际启用；下载始终另验 SHA-256 |
| Skill 发布 | 真实 `S3StableSkillPublisher` 完成规范包文件与 manifest 上传、HEAD/GET 完整性证明、读取、重复发布及条件写竞争 |
| E2B Worker 物化 | 真实 `ManagedResourceFilesystemSnapshotMaterializer` 从生产 BlobStore 读取多个非空资源；假 Sandbox 接收默认 4 MiB 分块并在内存中合并 9 MiB 文件，逐文件校验大小与摘要 |
| Cube ResourceFS | 最小 Fastify 装配真实 ResourceFS 路由，通过本机 HTTP `PROPFIND`、`GET`、`HEAD`、`Range` 读取对象存储文件，覆盖中文名称、空文件、大文件与无凭证拒绝 |

生产对象存储实现没有直接发起 S3 `Range` 或 `ListObjectsV2`。WebDAV 的单段 Range 在 API 完整读取并校验 Blob 后裁切，本套件验证该实际路径，不额外要求供应商实现未使用的 S3 分页接口。清理使用记录过的精确对象键逐个 DELETE，不调用 ListObjectsV2 或批量删除接口；权限策略仍须允许缺失对象的 HEAD 返回 404，不能把“不存在”变成 403。

当前 Blob 与 Skill 上传传入完整 `Uint8Array`，大于 8 MiB 仍是单次 `PutObject`，并不自动变成 S3 multipart upload。套件额外用已知长度的 Node Readable 验证 SDK 的 `aws-chunked` 校验和路径；Worker 的 4 MiB 分块是 Sandbox 文件 API 的分块，不是 S3 multipart。

## 对新存储执行

使用专用测试 Bucket 或专用测试凭据。Bucket 必须为私有；需要同一 Bucket 内 HEAD、GET、PUT、COPY 和 DELETE 权限。内部端点、公网端点必须指向相同 Bucket；运行 Node 的主机必须能访问公网端点，代理不能丢弃签名查询参数或改写签名所依赖的请求。

复用现有配置契约，不新增测试专用环境变量。以下值是占位示例，真实凭据通过环境注入，不要写入命令历史、提交或日志：

```sh
export PATH="$HOME/.local/node/bin:$PATH"
export S3_ENDPOINT=https://s3-internal.example.invalid
export S3_PUBLIC_ENDPOINT=https://s3-public.example.invalid
export S3_REGION=replace-with-region
export S3_BUCKET=replace-with-conformance-bucket
export S3_FORCE_PATH_STYLE=true
export S3_ACCESS_KEY_ID=replace-with-conformance-access-key
export S3_SECRET_ACCESS_KEY=replace-with-conformance-secret-key
corepack pnpm storage:conformance
```

脚本会读取存在的根 `.env`，但已导出的同名环境变量优先。`S3_ENDPOINT`、`S3_PUBLIC_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 任一缺失或为空时，整个套件跳过；**跳过不算验收通过**。`S3_FORCE_PATH_STYLE=true` 使用 path style，否则使用 SDK 的默认寻址方式。配置完整但凭据、权限或网络错误时必须失败，不得改为跳过。

测试不需要数据库、rclone/FUSE 或真实 Sandbox。目录事实由内存夹具提供，文件字节由真实生产 BlobStore 读取。测试通过反射取得生产工厂创建的私有 SDK 客户端用于观测与协议探测，不复制生产客户端工厂，也不替换 HTTP 传输。Skill 的物理键由生产实现固定派生，因此只在该客户端的测试 middleware 中加随机命名空间，签名前完成转换；发布算法与返回引用保持原样。

除生产探针对固定哨兵键的只读 HEAD 外，每次运行只访问 `storage-conformance/<随机 UUID>/`。所有测试写入客户端在请求发出前记录尝试访问的精确键，结束时逐个删除并用 HEAD 确认不存在；即使上传响应未知也能清理。清理失败会使套件失败。进程被强制终止时无法保证清理，维护者可在专用 Bucket 中按这个前缀排查残留。失败报告隐藏原始 Provider/fetch 异常，不输出凭据或预签名 URL。

## 已验证结果与配置建议

| 存储 | 验证日期 | 环境与结果 |
| --- | --- | --- |
| SeaweedFS 4.53 | 2026-11-25 | `http://127.0.0.1:19000`，Bucket `agent-runtime-dev`，region `us-east-1`，path style，公网与内部端点相同；16 项测试全部通过，包括清理验证 |
| MinIO RELEASE.2025-04-22T22-12-26Z（源码编译，与 Demo 同版本） | 2026-11-25 | `http://127.0.0.1:19100`，path style，公网与内部端点相同；16 项全部通过 |
| SeaweedFS 4.53 官方镜像（按摘要固定） | CI 每次运行 | 由 CI 的 M4 作业启动，覆盖本套件与 Skill Center 套件。曾试用 adobe/s3mock，但它不实现条件写入、预签名过期与签名校验，不能作为兼容性验收端点 |
| 阿里云 OSS（S3 兼容接口） | 2026-11-25 | 首尔 `oss-ap-northeast-2`，端点 `https://s3.oss-ap-northeast-2.aliyuncs.com`，虚拟主机风格（`S3_FORCE_PATH_STYLE=false`），公网与内部端点相同；16 项全部通过，使用 OSS 条件首写与不覆盖响应类型策略，包括清理验证 |

### 阿里云 OSS 配置与权限

使用 S3 兼容端点而非 OSS 原生端点，并保持虚拟主机风格。`*.aliyuncs.com` 端点自动选择 OSS 条件首写；可选 `S3_CONDITIONAL_WRITE` 的显式覆盖与进程作用域见[配置参考](../reference/configuration.md#对象存储)。SDK middleware 在签名前加入 `x-oss-forbid-overwrite: true`；不发送 OSS 未实现的 `If-None-Match`。

限定到目标 Bucket 的 RAM 策略允许 `oss:GetObject`、`oss:PutObject`、`oss:DeleteObject`、`oss:ListObjects`、`oss:AbortMultipartUpload`、`oss:ListParts`；前两项也覆盖 HEAD、同桶 COPY 的源读取与目标写入。`ListObjects` 的资源为 Bucket，其余为该 Bucket 的对象；不需要 `oss:GetBucketInfo`，readiness 不再要求 `HeadBucket`。按进程职责进一步裁剪权限时，仍须保证固定哨兵键 HEAD 可以返回 200 或 404，并为不存在对象提供正确的 404 语义。兼容性套件不自动证明 RAM 最小权限或 CORS 配置。

OSS 不允许预签名覆盖 `Content-Type`，对象必须在首次 PUT 时带类型元数据，COPY 保留它。内容寻址对象的类型不属于身份，不能因另一个引用期望不同类型而覆盖共享元数据：OSS 下载保留存储类型，并用 `Content-Disposition: attachment` 回退；仅类型完全一致且属于安全二进制预览白名单时允许 inline。HTML、SVG 等主动内容即使类型一致也只能以附件交付；下载 origin 仍须与应用 origin 隔离。

### SDK 校验和建议

SeaweedFS、MinIO 与 OSS 接受 SDK 默认 `WHEN_SUPPORTED` 下缓冲请求的 CRC32，也接受流式请求的 `aws-chunked` 和 CRC32 trailer；`WHEN_REQUIRED` 下不自动添加这些可选校验和，两种上传和读取均通过。生产 Blob 与 Skill 客户端均未显式配置 `requestChecksumCalculation` / `responseChecksumValidation`；本套件不修改生产默认值。

建议先保持 SDK 默认 `WHEN_SUPPORTED`，在每个目标存储与代理拓扑中重跑验收。若目标只在流式或可选校验和请求上失败，应先确认供应商支持情况，再单独评审 `requestChecksumCalculation: "WHEN_REQUIRED"` 与 `responseChecksumValidation: "WHEN_REQUIRED"`，并重跑整套测试；不要把降低 SDK 校验要求视为普遍的兼容性修复。Hoox 的大小与 SHA-256 校验不能取消，条件首写竞争语义、元数据或预签名过期不兼容也不能通过关闭校验和绕过。

验证边界：Node 下载不能证明浏览器 CORS；同一 localhost 端点不能证明云端 DNS/TLS、反向代理或跨公网访问；假 Sandbox 不能证明供应商文件 API 或真实 rclone 挂载。Worker 的资源用例只证明非空文件物化，当前实现的零字节文件会在分块计划之前被跳过并报错；Blob 与 API 的零字节读取独立通过，此 Worker 限制需要另行修复，不能归因于对象存储。
