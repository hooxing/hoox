# ADR-0020：Resource Library 发现、局部预览与显式导入核心

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务/PR：M3 无数据库迁移切片
- 替代关系：无

## 背景

ADR-0005 已把 Resource Library 定义为 Tenant 内跨 Thread 的发现和复用边界，而不是共享可写目录。M3 仍需先固定搜索、预览、导入与显式提升的应用语义，随后才能安全接入 PostgreSQL、私有 S3、HTTP 和 Workspace Writer。当前 Workspace 包也在并行演进，Resource 包不能复制尚未冻结的物化、Lease 或 Sandbox 路径逻辑。

本切片只建立无数据库迁移的 TypeScript 核心和窄端口。它不实现上传、真实 FileSource、PostgreSQL/RLS、S3 读取或签名、HTTP、Workspace 文件写入及 UI，也不表示这些生产 Gate 已完成。

## 决策驱动因素

- 历史文件不能自动进入 Prompt，过程文件默认不能污染跨 Thread 搜索；
- 任何发现、预览、导入和提升操作都必须携带认证层提供的 Tenant 与最小用户主体；
- 客户端知道 Resource ID、Version ID 或对象键都不能替代授权；
- 预览必须限制媒体类型、字节范围和单次预算，不能成为任意对象读取入口；
- 导入必须固定不可变 ResourceVersion，且不能把“生成计划”误报为“已经写入”；
- Workspace 并行开发期间需要清晰集成点，避免两套路径和写入权规则漂移。

## 备选方案

### 方案 A：让 Agent 自动扫描全部历史文件并直接挂载共享目录

实现表面简单，但会扩大 Prompt、泄露无关历史、让 Thread 相互污染，并把“发现”“授权”和“写入”混为一体，不符合 ADR-0005。

### 方案 B：Resource 应用核心只接受可信 Scope，通过窄端口解析规范版本和 Workspace 目标

核心可以先独立验证查询、游标、预算和快照语义；PG、S3 与 Workspace 适配器随后实现同一契约。代价是需要额外端口和生产装配 Gate。

### 方案 C：直接同时实现 PostgreSQL、S3、HTTP 与 Workspace 物化

能更快看到完整界面，但会把多种迁移和副作用协议绑在一次变更中，也会与并行 Workspace 工作冲突，难以独立审阅租户边界。

## 选择

采用方案 B，并确认以下边界：

1. 所有公开应用操作接收 `ResourceAccessScope { tenantId, userId }`；`promote_resource` 还要求带 Agent Thread、Thread 和 Run 的可信 Agent 主体。身份验证及 Membership 重验在上游完成，Resource 核心不接受裸 `tenantId` 作为完整授权。
2. 搜索词依次执行 NFKC、首尾清理、空白折叠和小写化，按 UTF-8 字节限制；页大小严格限制而非静默扩大。目录固定使用 `updatedAt DESC, resourceId DESC`，返回结果由应用层按白名单字段重新投影。
3. 游标为 HMAC-SHA256 签名的不透明值，绑定版本、`kid`、Tenant、User、规范查询、排序位置、签发时间和过期时间；拒绝篡改、过期、未来签发、跨主体或跨查询重放。密钥使用 32 至 64 字节并支持读取期轮换。
4. 预览命令只接收 Resource ID、Version ID 和字节范围。目录端口先在 Scope 内解析规范的不可变 `ResourceVersion`，内容端口才可读取；公开输入没有 `objectKey`、响应头或预签名参数。类型不支持、范围不可满足和不存在分别返回稳定结果；单次读取不能超过服务端预算。
5. 导入只生成版本为 1 的 `resource_import_plan`：固定 ResourceVersion ID、版本号、摘要、类型与大小，目标为安全 POSIX 相对路径，首版冲突策略只有 `reject`。结果必须明确 `materialization=not_started` 和 `workspaceWriterLease=not_acquired`。未来物化器仍需在 Writer Lease 下重验目标不存在，不能把旧计划当写入能力。
6. 路径核心执行平台无关的词法检查：拒绝绝对路径、反斜线、控制字符、空片段、`.`、`..`、非 NFKC 形式以及超长路径。符号链接和 Sandbox 根目录逃逸必须由后续 Workspace 物化器再次检查。
7. `promote_resource` 当前只向 Workspace 事实源申请固定 Revision/路径的短期授权，并产出 `pending_explicit_commit` 请求；它不会直接创建可搜索 Resource。普通 Workspace 过程文件不进入 `ResourceCatalog`。用户手动提升和真实 FileSource 按 ADR-0007 后置。

## 理由

方案 B 把输入规范化和安全不变量集中在可复用核心，同时让授权事实与内容定位仍由未来 PG/S3 适配器掌握。调用者不能用对象键绕过 ResourceVersion 解析；导入计划也没有写入能力，因而可以在 Workspace 端口尚未合并时安全推进。

严格拒绝覆盖比自动改名或覆盖更保守。后续若产品需要 `rename` 或显式覆盖，必须在 Workspace Writer Lease 和冲突审计语义确定后新增决策，不能扩展现有 `reject` 的含义。

## 影响

### 正面影响

- 历史内容不会因搜索或 Thread 创建而自动读取或注入 Prompt；
- 搜索游标可确定性分页，不能跨 Tenant、User 或查询复用；
- 预览读取范围由服务端预算和规范版本共同限制；
- 导入来源不会因 latest 版本变化而漂移，也不会误报已物化；
- Resource 核心不依赖 PG、AWS SDK、HTTP 或 Workspace 的具体实现。

### 负面影响与成本

- 当前只有内存 Fake 契约证据，没有真实数据库查询和对象读取证据；
- 预览按允许媒体类型返回原始局部字节，不包含 PDF 页面渲染、图片缩略图或 Office 预览；
- 导入计划还不能产生 WorkspaceRevision，显式提升也还不能提交 ResourceVersion；
- 搜索适配器必须实现相同的规范查询和确定性排序，未来需要数据库索引配合。

### 安全、数据与运维影响

- 目录适配器不得返回未提升过程文件；应用层仍会对白名单字段投影，避免内部对象键意外外泄；
- ContentReader 只能接收本次授权解析得到的 ResourceVersion，并必须限制返回字节数；
- 不支持的媒体类型不会触发内容读取；跨 Tenant 和猜 ID 的公开结果不得泄漏对象是否存在；
- 本切片没有创建数据库表、RLS 策略、Bucket 对象、签名 URL 或生产凭据，也不新增网络出口。

## 验证

- 包级单元测试覆盖查询规范化、页大小、稳定排序、游标篡改、跨 Tenant/User/查询重放；
- 覆盖猜 ID、伪造对象键/响应头、不支持媒体类型、范围不可满足、超预算及 Reader 越界响应；
- 覆盖旧 ResourceVersion 快照在 latest 漂移后仍固定、目标冲突默认拒绝、路径穿越和 Unicode 规范化逃逸；
- 覆盖用户主体伪造 Agent 提升、跨租户授权响应和提交前不可搜索状态；
- 执行 Resource 包 test/typecheck/build、根质量门禁与 `git diff --check`。

生产接入前还必须新增 PostgreSQL/RLS 双租户集成、真实私有 S3 范围读取或受控衍生预览、Workspace Writer Lease 下物化、HTTP 授权与审计测试。

## 可逆性与回退

在 PG Schema 和公开 HTTP 协议落地前，可以删除 Resource 核心或调整端口而不迁移数据。游标无持久事实价值，可通过停用密钥立即失效。生产保存导入计划或提升授权后，改变快照字段、路径语义或冲突策略需要版本化命令；不可原地把现有 `reject` 计划解释成覆盖能力。

## 后续工作

- 用新迁移实现 Tenant 组合键、RLS、Resource/ResourceVersion 目录与稳定排序索引；
- 将 ContentReader 接到授权后的 Stable Blob 引用，增加真实 MinIO/S3 范围读取与完整性验证；
- 与 Workspace 包对接路径策略、目标检查、Writer Lease 和 Revision 提交；
- 增加上传与 FileSource Fake Provider，再建立 HTTP/工具协议；
- 独立实现用户手动提升、真实 FileSource 和丰富预览，不在本切片提前开放。

## 实施记录

- `@cube-runtime/resource` 已实现无持久化应用核心、窄端口、HMAC 游标和包级测试；生产适配仍未实施。
