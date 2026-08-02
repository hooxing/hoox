# ADR-0077：文件上传与按需只读虚拟目录

- 状态：已接受
- 日期：2026-08-01
- 决策者：Runtime 团队
- 关联任务/PR：用户文件上传与长期 Resource 目录
- 替代关系：细化 ADR-0009、ADR-0019、ADR-0028

## 背景

用户上传的文件需要先进入持久对象存储，并在当前轮告诉 Agent 文件名和可用位置。Thread
使用时间变长后，租户会积累大量文件；如果每次创建 Sandbox 都把全部文件从 MinIO 复制到
本地，不论本轮是否使用都会浪费网络、磁盘和启动时间。只给模型签名 URL 虽然省去挂载，
但模型、shell 工具和不同文件类型会得到多套访问方式，URL 还会过期并污染对话历史。

附件事实是请求级动态数据。把文件名、Resource ID、路径或签名 URL 放入 system、developer
或 harness prompt 会破坏跨请求上下文缓存，也会让请求事实进入错误的信任层级。

图片还有一条独立能力轴：支持视觉输入的模型可以直接接收图片字节组成的结构化
`ImageContent`，无需先用工具“看图”；纯文本模型则不能仅凭路径得到像素语义。是否把图片
字节直接送入模型，应由模型声明的输入模态决定，而不是改变文件的存储和目录协议。

## 决策驱动因素

- Agent 对历史文件和本轮上传使用同一个、接近 Sandbox 本地目录的稳定路径；
- 只有打开文件时才把内容传入 Sandbox，目录规模不等于 Sandbox 占用；
- MinIO/S3 是权威事实源，Sandbox 缓存可丢弃且不能反向修改 Resource；
- 当前轮附件事实只进入最新 user turn，能力配置下的静态 prompt 与工具 schema 字节稳定；
- Sandbox 不持有对象存储凭据或物理对象键；
- 首版控制部署复杂度，同时保留把高流量文件边界拆成独立服务的路径；
- 图片的视觉直传、OCR 或识图服务不能迫使普通文件采用另一套地址。

## 备选方案

### 方案 A：上传后或每次 Run 前复制到 Sandbox

路径最像本地文件，实现依赖最少，但会为未使用文件付出传输与磁盘成本。长期目录越大，启动
成本越高；Sandbox 重建还要重复复制。

### 方案 B：MinIO 权威存储，加 Sandbox 内只读虚拟目录

API 暴露受 capability 保护的只读 WebDAV 视图；Sandbox 模板安装 rclone 与 FUSE，Worker
把视图挂载为 `/resources`。目录项可立即枚举，内容在首次打开时按需拉取并进入临时 VFS
缓存。Agent 始终使用稳定版本路径。

### 方案 C：只在 user turn 注入对象 URL

无需修改模板，但 URL 有时效，shell、库和模型 Provider 的下载能力不同；对话恢复后旧 URL
可能失效。直接暴露签名 URL也扩大了泄漏面，并让普通文件、图片和历史 Resource 形成多套逻辑。

### 方案 D：宿主机 ResourceFS 加 Cube Volume Plugin

Cubelet 宿主机运行只读 ResourceFS 挂载，由 Cube Volume Plugin 返回 `hostPath`，Cube 再通过
virtiofs 将其绑定到 Sandbox `/resources`。Sandbox 模板不安装 rclone/FUSE，也不持有网络令牌。

## 选择

原首版选择方案 B；Cube 0.6 提供正式 Volume Plugin 后，按 ADR-0079 切换为方案 D：

- 上传 API 把原始字节写入现有可恢复 Blob 生命周期，再原子创建 `origin=upload` 的不可变
  Resource 首版；
- 所有版本使用 `/resources/<resourceId>/<versionId>/<safeFileName>`，文件名只影响末段展示，
  Resource ID 与 Version ID 决定身份；
- API 内置只读 WebDAV 模块，目录只投影当前 Tenant 中 `searchable` 且 Blob 为 `stable` 的版本；
- Worker 为 Tenant 幂等确保一个长期 Cube Volume，并在创建 Sandbox 时通过 `volumeMounts` 固定绑定
  `/resources`；Cubelet 插件在宿主机挂载 ResourceFS，attach 失败会直接使 Sandbox 创建失败；
- `/resources` 位于 `/workspace` 之外，不参与 Workspace Revision、Artifact 发布或写租约；
- 当前消息只提交 `{resourceId, versionId}`。API 重验目录授权后，把 JSON 转义的文件名和稳定
  路径追加到最新 user 文本；system、developer/harness prompt 与工具 schema 不改变；
- 当前 WebDAV 路由随 API 部署，但通过 `ResourceFilesystemCatalog`、`BlobStore` 和 capability
  codec 窄端口隔离。后续可把该模块拆成独立服务，而不改变上传 API、`/resources` 路径或
  Sandbox 挂载协议。

## 图片策略

存储与路径对图片和普通文件完全一致，首版不自动 OCR，也不因为文件扩展名改变挂载逻辑。

- 视觉模型：后续扩展最新 user turn 的结构化多模态内容时，可依据模型的 `input` 模态能力，
  直接把本轮图片字节作为 `ImageContent` 交给模型；路径仍用于 shell、代码和历史按需访问。
- 纯文本模型：只有任务确实需要图片语义时，才调用受控识图/OCR 工具或 MCP，把派生结果作为
  tool observation 返回；不在上传时对所有图片预识别。
- 模型不应被要求根据一个本地路径“直接看到”像素。路径只代表可访问资源；视觉直传必须是
  明确的结构化模型输入。

本 ADR 当前只实现统一上传、user turn 路径注入和虚拟目录；视觉直传与按需识图属于后续能力，
不能伪装成已经由路径挂载自动获得。

## 理由

方案 B 把长期 Resource 目录与短生命周期 Sandbox 解耦。Agent 看到的仍是普通 POSIX 路径，
不需要判断文件来自本轮上传、历史目录还是对象存储；未打开的文件只产生目录元数据开销。
不可变版本路径避免同名覆盖和历史恢复漂移。API 内置模块先复用现有身份、PostgreSQL RLS、
Blob 完整性校验与运维链路；边界已经足够窄，访问量或故障隔离需要时再拆服务不会迫使客户端迁移。

## 影响

### 正面影响

- Sandbox 启动不再随 Tenant 文件总字节数线性增长；
- Agent、shell 和代码只使用 `/resources` 一套路径；
- 用户消息只携带当前轮实际上传的文件事实，静态 prompt 保持最大化缓存；
- MinIO 凭据、签名下载 URL和物理对象键都不进入模型上下文或 Sandbox；
- 历史版本路径稳定，可在后续 Thread 中按需复用。

### 负面影响与成本

- Cube 平台必须为 0.6 及以上，CubeMaster/Cubelet 必须注册同名 ResourceFS Volume Plugin；
- rclone 与 FUSE3 只安装在 Cubelet 宿主机，Sandbox 模板不再包含它们；
- API 暂时承担 WebDAV 目录与文件读取流量；首版 BlobStore 会先做完整对象校验，单文件上限为
  16 MiB，不适合作为大文件流式网关；
- rclone 在打开过的文件上使用 Cubelet 宿主机缓存，已使用文件仍会占用节点磁盘；
- 宿主机插件与 API 共享签名配置，需由秘密管理系统一致注入并按 ADR-0079 的卸载顺序轮换；
- 当前租户 Resource 目录沿用既有 Tenant 共享语义，不新增“上传者私有”所有权模型。

### 安全、数据与运维影响

- 上传请求要求认证、幂等键、受限文件名、媒体类型和 16 MiB 大小边界；
- Blob 先进入可恢复生命周期，只有 stable 引用和 ResourceVersion 在事务中绑定成功后才可见；
- WebDAV 仅支持 `OPTIONS`、`PROPFIND`、`GET`、`HEAD`，拒绝写操作；
- 宿主机 capability 绑定 Tenant、使用独立 audience 且没有请求级过期时间，只存在于可信 Cubelet；
  Sandbox 不可读取 bearer token。签名密钥轮换必须重建现有宿主机 mount；
- 生产 WebDAV 端点必须 HTTPS。开发环境需用受控 HTTPS 隧道让远端 Cubelet 访问本地 API；
- Cubelet 的 rclone 与插件版本必须固定并通过目标集群 Gate；Sandbox 模板无需 `/dev/fuse`。

## 验证

- Resource 单元测试验证稳定路径、文件名转义、user turn 注入、授权解析、上传边界和 capability
  篡改/过期；
- API 测试验证原始字节上传、附件输入投影、WebDAV 目录不披露对象键、鉴权与 Range 读取；
- Sandbox/Worker 测试验证 Volume REST 幂等创建、固定 `/resources` mount 投影和失败关闭；
- 部署插件契约测试验证四个 Hook、宿主机只读 rclone 参数、HMAC 输入和禁止删除业务数据；
- Web 测试验证原始文件上传与 `{resourceId, versionId}` 输入协议；
- 环境契约测试覆盖新增端点与签名密钥，提交前执行 `pnpm check`；
- 上线 Gate 必须在目标 Cube 0.6 集群完成 attach/detach、pause/resume、跨 Sandbox 复用、租户隔离和
  Sandbox 内秘密不可见测试。

## 可逆性与回退

上传后的 Resource 与 Blob 遵守现有不可变资源生命周期，不应通过数据库回滚删除。若虚拟目录
上线失败，可停止 Worker 的 Volume 绑定并保留已写入 Resource；之后改用显式 Resource 导入或新的
只读服务继续访问。WebDAV 从 API 拆出时保持 URL path 后缀、宿主 capability 与 `/resources` 目录
不变，仅切换插件的 `RESOURCE_FILESYSTEM_ENDPOINT` 并重建宿主机挂载。

## 实施记录

- 2026-08-01：首版以内置 API 模块实现，代码注释标记后续可拆服务；视觉直传暂不实施。
- 2026-08-02：按 ADR-0079 切换到 Cube Volume Plugin 宿主机挂载，移除 Sandbox 内 rclone/FUSE。
