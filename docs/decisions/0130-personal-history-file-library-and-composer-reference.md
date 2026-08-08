# ADR-0130：个人历史文件云盘与输入框引用

- 状态：已接受（试验分支）
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：`test/cloud-drive-history-files`
- 关联决策：ADR-0005、ADR-0027、ADR-0050、ADR-0067、ADR-0118、ADR-0119、ADR-0120、ADR-0129

## 背景

> 2026-08-08 修订：云盘独立入口、无时间语义路径、键盘选择和“只显示文件 Chip”的交互由 ADR-0131 取代本文第 3、4 项及相关限制。结构化附件与缓存边界决策继续有效。

个人历史文件已经通过 Tenant 级 ResourceFS Volume 暴露为 `/history`、`/thread-files` 和
`/resources`，Agent 可使用普通文件工具按需读取，且不会预下载或复制未使用的 Blob。该能力解决了 Agent 侧的文件访问，
但 Web 用户仍缺少三个入口：

1. 按语义任务和时间浏览已有文件；
2. 搜索并下载某个历史文件；
3. 在新的输入中复用历史文件，而不是重新上传。

把所有历史文件名、目录或摘要注入 Prompt 会破坏上下文缓存，也会让请求大小随用户历史增长。把历史文件复制到当前 Sandbox 或
Workspace 则会产生无必要的网络、存储和生命周期成本。现有 `thread_history_directories` 与
`thread_history_file_entries` 已经是 personal Tenant 历史关系的事实源，ResourceVersion 与 Stable Blob 也已有授权和完整性边界，
因此 Web 发现和复用应建立在这些事实之上。

## 决策驱动因素

- System、developer/harness Prompt 和工具 Schema 必须保持字节稳定；
- 默认查询成本不能随用户全部历史线性进入响应；
- 选择历史文件后必须沿用现有结构化附件协议，不能只把 URL 或文本路径交给 Agent；
- 下载必须遵守 Tenant 隔离、短期签名和签名前后双重授权；
- 复用文件不能复制 Blob、预下载到 Sandbox 或增加新的 Volume；
- 本期只支持 personal Tenant，但接口和数据边界不能妨碍后续团队能力另行设计。

## 备选方案

### 只保留 Sandbox 中的 `/history`，不增加 Web 能力

不采用。原生文件系统对 Agent 很合适，但用户无法在界面中确认历史文件、下载或显式复用，上传重复文件会成为常规操作。

### 新增 `search_history_files` 工具或识别 MCP

本期不采用。Sandbox 已可使用 `find`、`rg --files` 等原生工具，额外工具会增加 Schema、路由和模型选择复杂度。
Web 搜索属于用户交互，不需要进入模型工具面。未来只有在文件规模和语义检索需求证明原生目录不足时再单独决策。

### 选择后复制到当前 Workspace 或 Sandbox

不采用。复制会增加对象读取、Sandbox 网络和本地磁盘消耗，并引入副本清理、版本漂移和重试幂等问题。现有 ResourceFS 与
Thread 附件关系已经能提供相同的按需读取体验。

### 直接把 MinIO 签名 URL 放进用户输入

不采用。短期 URL 会过期，模型 Provider 未必能访问本地或私网地址，也会绕开 ResourceVersion、当前 Thread 附件关系和
Sandbox 文件工具。签名 URL 只用于用户点击下载，不作为 Agent 文件身份。

### 使用现有历史关系查询，并把选择结果作为结构化附件发送

采用。Web 负责发现和选择，统一输入协议负责授权和关联，Worker/ResourceFS 继续负责 Agent 的稳定路径与按需读取。

## 决策

1. 新增个人历史文件库服务和只读 API：
   - `GET /v1/me/history-files` 按任务返回文件；
   - 默认使用当前时间向前六个日历月的 `activeAfter`；
   - 使用 `lastFileAt + threadId` 的稳定游标分页，单页默认 24、最大 50 个任务；
   - `q` 同时匹配任务目录名、目录入口文件名和 Resource 原名；
   - 加载更早记录时使用上一窗口起点作为 `activeBefore`，不再自动补六个月下界。
2. `GET /v1/me/history-files/:resourceId/versions/:versionId/download` 只解析当前 personal Tenant
   已存在的历史关系，签发 300 秒短期下载地址；签名后再次解析并比对完整授权事实，发生关系漂移时返回 404。
3. 技能中心增加“云盘”标签：按最后文件时间分月、按语义任务折叠，支持搜索、继续分页、加载更早、下载和加入当前输入。
4. 输入框只识别末尾的 `@查询`，180 毫秒后按需搜索，最多展示 8 个去重文件。选中后显示文件 Chip，并保留可读的
   `@文件名` 文本；真正的授权身份是 `resourceId + versionId` 结构化附件。
5. 历史文件与本轮新上传文件共用统一 Thread Input 的 `attachments` 字段，总数继续受 20 个附件上限约束。持久层在当前
   Thread 输入事务内维护历史关系，Agent 随后通过既有 `/thread-files`、`/history` 或 `/resources` 路径读取。
6. 本功能不向 System Prompt、developer/harness Prompt 或工具 Schema 注入任务名、文件名、ID、路径、签名 URL 或查询结果。
   动态事实只存在于当前 user turn 的结构化附件和按需 API/文件系统结果中。
7. 不新增 PostgreSQL 表、Blob、副本、Cube Volume、FUSE 进程或 Sandbox 模板依赖；复用 personal 历史目录关系、Stable Blob 与
   Tenant 级 ResourceFS Volume。
8. team Tenant 本期不暴露历史文件库。未来团队任务、个人任务、发布转换和成员可见性必须另立 ADR，不能把 personal 查询直接放宽。

## 影响

### 正面影响

- 用户可在不重复上传的情况下发现、下载和复用历史文件；
- Agent 继续获得与上传文件相同的本地路径体验，不需要理解文件来自当前上传还是历史记录；
- 默认只返回最近六个月活跃任务，旧记录按用户操作继续加载，避免一次枚举完整生命周期；
- Blob 仍按需读取，不增加 Sandbox 磁盘副本和对象存储流量；
- 模型上下文缓存和稳定工具 Schema 不受用户历史规模影响。

### 成本与限制

- 当前子串搜索使用 PostgreSQL 大小写归一后的包含匹配，尚未增加 trigram/全文索引；超大个人历史需要查询计划与 10,000 任务
  性能 Gate 后再决定专用索引或搜索服务；
- 查询先分页任务再读取这些任务的文件，响应任务数受控，但单个任务内文件数仍需观测；
- `@文件名` 是可读提示，不是引用语法的持久身份；删除文字不会自动删除已经选中的 Chip，用户应通过 Chip 的移除按钮取消；
- 云盘搜索与下载依赖 API、PostgreSQL 和对象存储；失败不会影响已挂载 ResourceFS 中的 Agent 文件读取；
- 本期没有 team Tenant UI、权限或个人转团队能力。

## 安全与隐私

- API 使用认证上下文提供 Tenant，拒绝请求体或查询参数伪造 Tenant；
- Catalog 对非 personal Tenant 返回能力不存在，跨 Tenant 文件返回 404；
- API DTO 不返回对象键、Blob 引用或对象存储凭据；
- 下载地址禁止缓存，并在签名前后确认同一历史文件授权事实；
- Web 不把签名 URL写入 Thread 输入，也不让模型 Provider 直接访问 MinIO；
- 文件内容仍由 Sandbox 的只读 ResourceFS 按需读取。

## 验证

- Resource 服务单元测试覆盖默认六个月、加载更早窗口和历史关系下载解析；
- API 契约测试覆盖查询参数、游标成对校验、DTO 脱敏、短期签名、双重解析和跨 Tenant 404；
- Web API 测试覆盖查询与下载路由；
- 云盘组件测试覆盖分月/任务展示、搜索、加载更早、加入输入和同步开窗下载；
- 输入框测试覆盖末尾 `@` 识别、按需搜索和结构化附件选择；
- 受影响包执行格式、Lint、TypeScript、Vitest、构建与本地 API/Web 联调。

## 可逆性

Web 标签、`@` 选择器和两个 API 路由可一并关闭或回退，不需要迁移数据。历史关系、ResourceVersion、Stable Blob、
`/history` 与 `/thread-files` 均由既有 ADR 管理，不因本功能回退而删除。已通过该入口复用的文件会作为普通 Thread
附件事实保留；这与重新上传文件后的历史关系相同，不应回滚。未来替换为专用索引或独立服务时保持 API DTO 和结构化附件契约即可。
