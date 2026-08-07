# ADR-0120：个人历史文件虚拟目录实现切片

- 状态：已接受
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：个人历史任务文件虚拟目录实现
- 替代关系：细化 ADR-0119 的首期实现顺序；不改变 ADR-0118 的长期方向
- 后续状态：低成本标题模型部分已由 ADR-0121 实现并取代本 ADR 的后置结论

## 背景

ADR-0119 已将首期范围收窄为 personal Tenant，但原实施计划仍同时包含历史关系、低成本标题模型、条件 Volume attach、
ResourceFS、Sandbox 入口和 Web 标题体验。当前交付要求进一步聚焦为“只实现虚拟目录”，避免把标题服务和 UI 一并引入。

同时，公开 Skill 市场已经复用同一个 Tenant 级 ResourceFS Volume。对当前 Sandbox 架构而言，再根据 `hasRecentHistory` 决定
是否挂载历史目录不会减少 Volume 或 FUSE/rclone 实例；历史能力只是现有挂载上的新只读投影。

还需要为当前 Thread 提供不受语义标题和六个月滚动窗口影响的 `/thread-files`。直接把它链接到
`/resources/history/<title>/files` 会让未来改名和历史过期破坏固定入口。

## 决策驱动因素

- 本次只交付 personal Tenant 的可浏览、可精确读取虚拟目录；
- 不复制 Blob，不增加 Volume 数，不向 Sandbox 下发 MinIO 凭据；
- `/thread-files` 必须稳定，Agent-facing 主路径不能暴露 Thread ID；
- Feature Flag 关闭和 team Tenant 必须保持既有行为；
- System/developer prompt 必须保持字节稳定，不注入请求级目录事实；
- 目录关系必须与 durable 输入接受保持一致，不能依赖 Run 最终成功；
- 后续标题模型、团队能力或独立部署不能迫使现有路径和数据迁移。

## 备选方案

### 方案 A：完整实现原计划全部阶段

同时实现标题 outbox、模型适配器、Web 更新、条件挂载和虚拟目录。功能完整，但明显扩大本次变更、故障域和验收成本。

### 方案 B：先实现虚拟目录主链路，复用既有标题和 Tenant Volume

在 durable 输入事务中建立历史关系，ResourceFS 提供语义目录和隐藏稳定 Thread 视图，Worker 建立固定入口。标题模型、UI 改名
别名和条件挂载后置。

### 方案 C：只提供历史搜索工具

无需文件系统投影，但 Agent、Shell 和第三方程序必须理解另一套发现协议，无法达到接近本地目录的统一体验。

## 选择

采用方案 B，并冻结以下实现：

1. 迁移 `0036_personal_history_filesystem` 创建 `thread_history_directories` 和
   `thread_history_file_entries`，使用 `tenant_id` 作为 RLS 与身份边界，并回填 personal Tenant 中已进入 durable receipt 的附件。
2. `HISTORY_FILESYSTEM_ENABLED` 同时控制 API 历史关系写入、ResourceFS 历史投影和 Worker 固定入口；任一进程关闭后不得暴露半套
   Agent 契约。
3. 新附件只有在 Thread 输入被 durable 接受为 queued 或 steer 时，才在同一数据库事务中幂等写入历史关系。Run 后续失败或取消
   不删除关系。
4. 目录名使用 Thread 创建时间、配置时区和已有可信 `threads.title`；文件名使用首次 durable 关联时间和 Resource 原始名称。
   时间提供主要重名信息，同秒冲突以数字序号兜底。目录一旦分配保持不变。
5. 本次不调用标题模型。迁移预留 `title_source`、`title_generated_at` 和 `title_generation_version`，确定性标题对应
   `naming_state=fallback`，以后可增加标题 consumer 而不改变历史关系主键。
6. ResourceFS 提供 `/resources/history/<semanticDirectory>/files/<semanticFile>`，根枚举只返回最近六个月有文件的目录。已知的
   旧语义路径仍允许精确解析，避免历史消息中的已记录路径在滚动窗口到期时立刻失效。
7. ResourceFS 另提供不参与根目录枚举的 `/resources/.thread-files/<threadId>/files/...`。Worker 只使用领取事务提供的可信
   Thread/Tenant 事实，在 personal Tenant Sandbox 内创建 `/thread-files` 软链接；模型无需知道内部 Thread ID。
8. `/history` 链接到 `/resources/history`。固定入口在 Sandbox acquire 后创建，已存在非预期对象或目标不可读时失败关闭；入口不写入
   `/workspace`。
9. 历史目录复用 Skill 已需要的 Tenant ResourceFS Volume，不实现 `hasRecentHistory` 条件 attach 或 Session generation 升级。
   若未来 ResourceFS 不再常驻，再以命中索引的 `EXISTS` 查询恢复需求信号。
10. System Prompt 只增加固定目录及避免大范围正文扫描的静态说明。目录名、文件名、Thread ID、资源 ID 和路径列表不进入
    system/developer prompt。
11. 当前实现保留独立 `HistoryFilesystemCatalog` 边界，但先与 ResourceFS HTTP 进程共同部署；后续可拆分子模块或服务，不改变
    Volume 和路径契约。
12. team Tenant 返回“能力不存在”而不是空的个人目录；本次不创建团队成员过滤、共享任务或 personal → team 发布流程。

## 理由

该切片已经提供用户需要的统一原生文件体验：Agent 可以直接使用 `find`、`rg --files` 和普通程序浏览路径，文件正文只在打开时
经现有 BlobStore 读取。复用 Tenant Volume 不增加挂载资源，路径定向 SQL 也避免历史查找退化为全 Tenant Resource 列表扫描。

隐藏稳定 Thread 视图把“安全内部身份”和“Agent-facing 语义路径”分开：Worker 负责把可信 Thread Scope 映射为固定
`/thread-files`，未来标题改名只需增加语义别名，不影响当前任务入口。

## 影响

### 正面影响

- personal Tenant 获得接近本地只读目录的历史文件体验；
- 未读取历史 Blob 不会下载，已有 Blob 不复制；
- 现有 `/resources/<resourceId>/<versionId>/<name>` 和 Skill 路径保持兼容；
- team Tenant 与其他 personal Tenant 继续由 Tenant capability、RLS 和 Blob 引用隔离；
- 标题模型和部署拆分可以独立演进。

### 负面影响与成本

- 当前语义标题质量取决于既有确定性标题，尚未达到低成本模型标题的最终体验；
- ResourceFS 根目录仍有既有 Resource 全量枚举行为，但 `/history` 路径本身使用定向查询；
- `/history` 的大规模 PROPFIND 响应尚未完成 10,000 目录性能 Gate；
- 直接知道旧语义路径时可以继续读取超过六个月的文件；六个月限制是发现窗口，不是数据授权或保留期；
- 一个 Tenant 的所有 Sandbox 继续共享同一只读 ResourceFS 挂载，当前只适用于 personal Tenant 安全模型。

### 安全、数据与运维影响

- Worker 不信任模型或客户端提供的 Tenant 类型和 Thread ID；只使用领取事务快照；
- team Tenant 不写历史关系，ResourceFS 也不返回历史根；
- 隐藏 Thread 路径不是新的授权边界，真正边界仍是 Tenant capability 和 RLS；
- Sandbox 不获得对象存储凭据、签名 URL 或物理对象键；
- 单一 Feature Flag 回滚时可以同时关闭写入、投影和固定入口，避免半启用状态。

## 验证

- 命名函数单元测试覆盖时区、清理和冲突序号；
- 迁移契约测试覆盖表、RLS、索引与 Runtime ACL；
- PostgreSQL 集成测试覆盖 personal 路径查询、稳定 Blob 复用和跨 Tenant 不可见；
- ResourceFS HTTP 测试覆盖历史目录、隐藏 Thread 路径、GET/HEAD/Range/ETag 与写方法拒绝；
- Worker 测试覆盖 personal 固定入口、team 跳过、命令失败关闭和可信 Thread 路径；
- 配置、格式、Lint、TypeScript 构建与单元测试作为合并 Gate。

## 可逆性与回退

关闭 `HISTORY_FILESYSTEM_ENABLED` 即停止新增关系、ResourceFS 投影和 Worker 入口。已有表和关系保留，原 Resource 与 Blob 不受
影响。迁移可以在确认没有消费者依赖后执行 down；生产中已暴露路径后优先采用关闭开关并保留数据的可恢复回退。

## 后续工作

- 增加低成本标题 outbox/consumer 与 Web 异步标题更新；
- 支持 UI 改名后的新目录和旧路径兼容别名；
- 完成真实 Cube `find/rg` 黑盒与 10,000 目录性能 Gate；
- 按吞吐和故障域决定是否把历史 Catalog/HTTP 路由拆成独立子模块或服务；
- 团队能力启动前另立成员可见性与 personal → team 发布 ADR。
