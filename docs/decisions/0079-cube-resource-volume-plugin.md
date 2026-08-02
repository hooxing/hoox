# ADR-0079：Cube 宿主机 ResourceFS Volume Plugin

- 状态：已接受
- 日期：2026-08-02
- 决策者：Runtime 团队
- 关联任务/PR：`/resources` 虚拟目录的 Cube 原生挂载
- 替代关系：替代 ADR-0077 的 Sandbox 内 rclone/FUSE 实施方式

## 背景

ADR-0077 首版让 Worker 在 Sandbox 内执行 rclone/FUSE，把 capability 保护的 WebDAV ResourceFS
挂到 `/resources`。这要求定制每个 Sandbox 模板、向 microVM 提供 `/dev/fuse`，恢复时还要重新签发
短期 token 和重挂载。CubeSandbox 0.6 已提供 E2B-compatible Volume 生命周期、binary/RPC Plugin、
`volumeMounts` 和由 Cubelet 把插件 `hostPath` 经 virtiofs 暴露给 microVM 的能力。

我们的文件视图不是一个裸 S3 bucket。可见目录由 PostgreSQL 中 `searchable` ResourceVersion 决定，
逻辑路径为 `/resources/<resourceId>/<versionId>/<safeFileName>`；真实字节来自 MinIO stable Blob，物理
object key、生命周期状态和租户边界不能暴露给 Sandbox。因此需要利用 Cube 的 Volume 编排，同时保留
Runtime ResourceFS 的逻辑目录和完整性校验。

## 备选方案

### 直接使用官方 S3/COS Volume 插件

部署最省事，但只能把 bucket/prefix 原样呈现。它无法仅凭 S3 列表重建 PostgreSQL Resource 目录、过滤
visibility/stable 状态或隐藏物理 object key；为每个 Tenant 注入对象存储凭据也扩大了权限边界。

### 继续在 Sandbox 内挂载

不依赖 Cube Volume API，但模板、guest FUSE、短期 token 恢复和每个 Sandbox 的 rclone 进程仍然存在。

### 自定义 Cube ResourceFS Volume Plugin

CubeMaster/Cubelet 使用 Cube 0.6 binary Volume Hook；Cubelet 宿主机以只读 rclone 挂载现有 WebDAV
ResourceFS，Cube 负责 refCount、hostPath 校验和 virtiofs 绑定。Sandbox 只看到普通 `/resources`。

## 决策

选择自定义 Cube ResourceFS Volume Plugin，并且当前不实现其他 Sandbox Provider：

- 每个 Tenant 使用一个长期 Cube Volume，Volume `name/id` 等于已验证 Tenant ID，driver 由必填
  `CUBESANDBOX_RESOURCE_VOLUME_DRIVER` 指定。Worker 在创建 Sandbox 前先 GET，缺失才 POST；多 Worker
  并发 POST 的 409 必须再 GET 到完全相同身份才能收敛。
- Sandbox 创建请求只允许一个 Volume mount，路径固定 `/resources`。业务代码不能注入任意 hostPath、
  Volume 名或 mount path；connect/pause/resume 复用 Cube 已持有的绑定。
- Worker readiness 同时只读探测 Sandbox 列表和 `/volumes`，Cube 低于 0.6 或 Volume API 不可用时拒绝启动。
- binary 插件实现 Create/Destroy/Attach/Detach。Create/Destroy 不创建或删除业务数据；Attach 在 Cubelet
  `volumeBaseDir` 内建立 `--read-only` rclone WebDAV mount，Detach 只在 node refCount 归零后卸载。
- API capability 增加 v2 host-volume audience，HMAC payload 精确为 `{"v":2,"tenantId":"..."}`。
  它没有请求级过期时间，只允许存在于 root-owned Cubelet 配置和 rclone 进程；Sandbox 不获得 token。
  原 v1 Tenant+Sandbox+TTL token 仍可验证以保证切换期兼容，但 Worker 不再签发或在 guest 使用它。
- API 仍是首版 ResourceFS 服务边界，内部继续通过 PostgreSQL RLS 目录和 BlobStore 完整校验读取 MinIO；
  后续拆为独立服务只需修改宿主插件 endpoint，不改变 `/resources` 或 Agent 契约。

## 理由

Cube Volume Plugin 正好把存储后端挂载和 microVM 暴露分开：Runtime 维护业务目录语义，Cube 维护
Sandbox/Node refCount 与 virtiofs。rclone/FUSE 从不可信 guest 移到受管宿主机后，模板保持通用，Sandbox
也无法读取 WebDAV token。每 Tenant 一个长期视图卷还能让同节点多个 Sandbox 共享 mount 和缓存，资源库
新增文件通过短目录缓存窗口自动出现，而不会复制 Tenant 全量字节。

保留 WebDAV 适配而不直接挂 S3，是因为 Resource 与 Blob 的可见性不等同于 object prefix。宿主 capability
不设短 TTL 是为了避免共享 mount 在有活跃/暂停 Sandbox 时过期；其风险由宿主 root 边界、独立 audience、
HTTPS、签名密钥轮换和 Sandbox 不可见性控制。

## 影响

- CubeMaster、CubeAPI、Cubelet 必须统一升级到 0.6 及以上，并在 Master/每个 Node 注册同名 plugin。
- rclone、FUSE3 与签名配置从 Sandbox 模板迁移到 Cubelet；host mount 和 2 GiB VFS cache 需要节点容量监控。
- Volume 名在 Cube 控制面中等于 Tenant ID，因此该 Cube 集群/driver 命名空间视为 Runtime 专用；Tenant ID
  继续受 128 字符和安全字符集约束。
- host capability 泄漏等价于读取对应 Tenant ResourceFS。配置必须 root:root 0600，日志禁止打印 token，
  Cubelet 主机访问权按生产秘密边界管理。
- key 轮换不会自动更新正在运行的 rclone；必须先停止/卸载旧 mount，以新配置重新 attach，再撤销旧 key。

## 验证

- Sandbox 包测试验证 Volume GET/POST/409 并发收敛、响应身份、鉴权头、只读 readiness 和固定 mount path；
- Worker 测试验证 Tenant Volume 在 Sandbox create 前确保，最终请求带唯一 `/resources` mount；
- Resource 测试验证 v1/v2 capability 的 audience、HMAC、篡改与 v1 过期语义；
- 部署契约测试验证四个 Hook、只读权限、禁止 MinIO 凭据和 Destroy 不递归删除；
- 真实上线 Gate 见 `deploy/cube-resource-volume/README.md`，必须在目标 Cube 节点单独完成。

## 可逆性与回退

停止 Worker 的 `volumeMounts` 注入即可不再创建新绑定；已有 Resource/Blob 与 Cube Volume 均无需删除。
短期可回到 ADR-0077 的 guest mounter，但需要重新提供模板 FUSE 与 v1 token，且不能同时在同一 Sandbox
重复挂载 `/resources`。切换独立 ResourceFS 服务时保留 v2 capability 字节格式和 WebDAV 路径，仅更新
Cubelet root 配置并按密钥轮换流程重建 mount。
