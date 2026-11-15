# 独立后台控制面与版本化运行配置

- 被部分替代：[首次运行管理员与模型配置](20261115122045-first-run-administrator-and-model-setup.md)。初始化授权、管理会话与本地账号绑定边界以新决策为准；其他结论继续有效。
- 状态：部分已替代（日常配置流程与运行参数真源；剩余有效范围见替代关系）
- 日期：2026-08-19
- 决策者：Runtime 维护者
- 关联任务/PR：统一后台管理模型、记忆、Skill、统计与动态配置
- 替代关系：扩展 ADR-0112；其中双管理 API 进程/JWT/listener 决策已被 ADR-20260821115221 替代，模型 Provider 日常配置流程已被 ADR-20260825180549 部分替代，独立数据库权限面、记忆配置持久事实和已有 Run 快照继续有效

- 被部分替代：[ADR-20260906195752](20260906195752-admin-task-oriented-configuration-and-publication.md)。日常草稿/原因步骤、记忆保存门禁、后台运行参数真源和部署配置地图由新决策替代；独立权限面、聚合统计、不可变模型/记忆配置及已有 Run 快照继续有效。

## 背景

现有 `admin-web` 与 `skill-admin-api` 只覆盖 Skill 提交、复核、发布和撤销。模型与 Mem0
配置仍由 Agent Worker 在启动时从单套环境变量读取；运行统计分散在 Runtime 事实表中；开发和生产样例分别已有
一百余项环境变量。把这些变量直接暴露成通用键值编辑器，会把数据库、JWT、TLS、对象存储等引导秘密带入浏览器
权限面，也无法定义多进程配置何时生效、正在执行的 Run 是否漂移以及失败后如何回滚。

Skill 发布已经使用专用 PostgreSQL/S3 身份。若直接把模型配置与全局统计能力加入 `skill-admin-api`，该进程将同时
获得内容发布、平台配置写入和 Runtime 数据读取权限，扩大任一入口失陷后的横向影响。

## 决策驱动因素

- 普通用户 Web、Skill 发布面和平台控制面必须维持不同的部署与凭据边界；
- 动态配置必须是有类型、可校验、可审计、可回滚的事实，不能是任意 ENV 键值；
- 新配置不得改变已经开始执行的 Run，进程重启后也必须恢复同一配置版本；
- Provider 凭据不得从读取 API 或审计记录返回，首版不在数据库保存明文秘密；
- 统计面只能看到预定义聚合，不获得 Prompt、模型正文、Tenant 业务行或对象存储内容；
- PostgreSQL、Sandbox 与 MinIO 等引导连接不能依赖其自身管理的动态配置。

## 备选方案

### 方案 A：在普通 Web/API 增加管理员路由

复用部署单元最少，但普通 Runtime 将获得平台级写权限和跨 Tenant 统计权限，条件渲染不能缩小进程权限，故不采用。

### 方案 B：扩展 Skill 管理 API 为单体超级后台

前端接入简单，但破坏 ADR-0112 的专用发布角色与最小 S3 权限；统计和 Provider 配置故障还会影响 Skill 发布，故不采用。

### 方案 C：统一管理 Web，按能力拆分管理 API

保留一个独立部署的 `admin-web` 作为页面外壳。Skill 模块继续调用 `skill-admin-api`；模型、记忆、动态设置和聚合统计
调用新的 `admin-control-api`。身份网关可按路由注入各自 audience 的短期 JWT，两个 API 使用不同 PostgreSQL 登录角色。

## 选择

采用方案 C，并固定以下边界：

1. `admin-web` 提供仪表盘、模型供应商、记忆供应商、Skill 和运行配置五个模块，但不保存任何 Token，也不把开发
   Token 编译进静态资源。
2. `admin-control-api` 使用独立 `admin_control` PostgreSQL 身份。控制面 operator 分为 `viewer`、`operator`、
   `admin`：viewer 只读；operator 可创建草稿和执行连接测试；只有 admin 可发布配置或回滚。角色初始化不提供自助
   提权 API。
3. 模型与记忆配置采用不可变 revision。草稿可以修改；发布会原子切换 active revision 并递增全局 generation。
   运行设置只允许协议内声明的白名单键和类型。所有写入要求幂等键、预期版本和变更原因。
4. Provider 凭据只保存受限 `secretRef`。首版仅允许引用 Worker 已由严格环境契约加载的部署秘密；API、列表、统计、
   审计和错误响应不返回秘密值。后续接入 KMS/Vault 时保持 `secretRef` 协议不变。
5. Worker 领取新 Run 时在同一 Tenant 事务中读取 active revision，并首次写入 `run_runtime_config_snapshots`。同一 Run
   的重试、恢复和进程重启只能使用该快照指向的不可变 revision；active 切换只影响尚未建立快照的新 Run。
6. 环境变量仍负责数据库连接/角色、JWT、TLS、监听端口、S3、Sandbox、配置秘密和进程关闭时限。管理页面只读展示
   这些配置的名称、来源和“需要重新部署”状态，不展示值，也不能修改。
7. 平台统计通过固定聚合视图暴露：Run 状态、近 24 小时执行结果、Dispatch 积压、Sandbox 状态、记忆消费状态、
   定时任务状态和 Skill 发布/安装计数。控制面角色不获得底层 Runtime 表的直接 SELECT。
8. Provider 连接测试是有界、无业务正文的显式操作，不会自动发布草稿。生产只允许无凭据 HTTPS URL；失败响应只
   返回稳定类别。
9. 所有进入持久化状态机的发布、回滚和连接测试写入追加式审计，失败的 Provider 连接测试也必须留痕。未通过认证、
   格式校验或 CAS 的请求只写净化后的服务日志。审计包含 actor、对象、revision、动作、原因、时间和稳定结果，不包含
   Provider 响应正文或 secretRef 解析后的值。

## 理由

统一 Web 保持运营体验一致，多 API 与多数据库角色则把浏览器的一致性和服务端最小权限解耦。不可变 revision 加
Run 快照让“页面发布成功”具有可验证的生效语义，也避免长任务在中途换模型或记忆作用域。受限 secretRef 为现有
部署秘密和未来 KMS 留出同一协议，而不引入自制明文秘密仓库。聚合视图提供运营可见性，但不让后台成为跨 Tenant
数据导出入口。

## 影响

### 正面影响

- 管理员可以在一个独立控制台查看系统状态并管理模型、记忆、Skill 和安全的动态设置；
- Provider 配置具有草稿、验证、发布、回滚、审计和确定的 Run 生效边界；
- Skill 发布角色继续对 Runtime 业务表保持零权限；
- 引导配置与动态配置的责任边界可由页面和配置契约共同解释。

### 负面影响与成本

- 新增一个 API 部署单元、数据库角色、JWT audience、迁移表和 Run 快照读取；
- 首版 Provider secretRef 只能引用部署时声明的秘密，新增独立密钥仍需要部署系统配合；
- 聚合统计为即时查询，规模增长后需要转为预聚合或外部指标系统；
- 发布配置不能改变已经建立快照的 Run，紧急切换需要显式取消并创建新 Run。

### 安全与运维影响

- 生产身份网关必须分别为 Skill 和 Control 路由注入匹配 audience 的 JWT，并剥离客户端 Authorization；
- `admin_control` 角色只能读写控制面表并读取聚合视图，Runtime 角色只能读取已发布 revision 和自己的 Run 快照；
- Provider 探针必须有超时、响应大小限制和地址校验，日志只记录稳定失败分类与 request ID；
- 配置页面必须明确标记 dynamic、restart-required 和 deployment-only，禁止通用 ENV 写入端点。

## 验证

- 领域测试覆盖配置规范化、secretRef 白名单、revision 状态机、CAS、幂等与回滚；
- API 测试覆盖角色矩阵、重复 Header、错误信封、Provider 探针失败净化和统计只读；
- 持久化测试覆盖 RLS/ACL、active 唯一性、审计追加、Run 快照稳定性和聚合视图不泄漏业务正文；
- Worker 测试覆盖新 Run 读取 active、旧 Run 固定 revision、无动态配置时回退部署配置；
- 管理 Web 测试覆盖五个模块、秘密遮蔽、生效语义与 Skill 原流程；
- 执行格式、lint、受影响包 typecheck/test/build、配置契约和迁移测试。

## 可逆性与回退

可先停止 `admin-control-api` 并让 Worker 回退到部署配置；已存在的 revision、审计和 Run 快照保持只读。迁移 down
只有在不存在控制面配置、审计或 Run 快照时才允许删除表。已经开始的 Run 不因控制面下线改变模型。回退管理 Web
不会改变 Skill 发布 API 或普通用户 Web。
