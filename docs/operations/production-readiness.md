# 生产就绪说明

本页说明仓库当前能证明的生产边界，以及正式生产发布前仍需在目标环境完成的验收。Hoox 处于 `0.x` 阶段，仓库目前只维护 [Demo 持续部署](demo-cd.md) 一条发布路径，不提供生产镜像、SBOM 或发布清单。

## 当前可以由仓库证明的内容

- API、Scheduler、Worker 使用独立 production 装配，不回退到 development 身份、Fake Sandbox 或内存队列。
- production 配置拒绝 development 变量、明文依赖端点、错误 TLS/角色和未声明环境键；`pnpm config:check:production` 校验示例与契约一致。
- 依赖使用精确版本并提交锁文件，pnpm 版本和 registry integrity 固定；CI 执行生产依赖漏洞审计。
- vendored 源码保留上游版本、许可证与来源说明。

## 仓库不能替目标环境证明的内容

- 生产容器镜像的 runtime-only 闭包、非 root 运行、只读文件系统与 SBOM。
- 真实 PostgreSQL、S3、Sandbox、模型和代理的联合 readiness。
- Web/OIDC 产品身份、账号恢复、会话撤销和组织级权限。
- 完整跨 Tenant 越权矩阵和运维人员访问审计。
- CDN/S3 的 CORS、`nosniff`、CSP、缓存与专用下载 origin。
- 容量、性能、限流、配额、成本阈值和依赖故障预算。
- 备份恢复、集群回滚、跨版本兼容和破坏性迁移演练。
- 部署平台 admission policy、entrypoint/command 防覆盖和网络策略。

## Production 配置

### 评测角色升级

从已应用 0031 的生产数据库升级时，发布负责人先安排数据库平台管理员（受控 PostgreSQL 超级用户）执行派生角色预置，再由数据库迁移身份执行 Schema 迁移：

1. 将既有 `DATABASE_BOOTSTRAP_URL`（受控超级用户连接）和 `DATABASE_RUNTIME_ROLE` 注入一次性运维任务；不向 API、Worker、Scheduler 或 Migrator 注入该超级用户凭据。
2. 使用发布版本执行 `pnpm db:evaluation-role:bootstrap`。该命令只创建或校验按数据库角色契约从 `DATABASE_RUNTIME_ROLE` 派生的评测角色，并建立 `INHERIT FALSE, SET TRUE, ADMIN FALSE` 的 Runtime 成员关系；不创建应用登录角色、不改密码，也不运行 Schema 迁移。
3. 预置成功后撤销/卸载超级用户凭据，再以受限 Migrator 配置 `MIGRATION_DATABASE_URL` 等既有迁移变量执行 `pnpm db:migrate:up`。
4. 若角色属性、已有成员关系或权限校验失败，预置事务回滚并输出不含凭据的诊断。由数据库管理员检查派生角色与授权，按变更管理流程修复不安全状态，再安全重试预置；预置成功而迁移失败时保留角色，先修复迁移失败原因，再重复 `pnpm db:migrate:up`。两条命令均可安全重试，不要把超级用户凭据交给 Migrator，也不要让 Runtime/Migrator 获得 `CREATEROLE`。

`pnpm db:migrate:up` 在角色缺失时会在 DDL 前终止，并给出以上预置命令提示。不得尝试以 `db:roles:bootstrap` 或 `db:setup` 代替该生产步骤；它们是开发入口并拒绝 production。

`deploy/production.env.example` 是多个服务字段的合集，不是一个可以整包注入所有容器的共享秘密文件。

| 服务 | 应获得 | 不应获得 |
| --- | --- | --- |
| API | PG、S3、JWT/身份、TLS、公开 origin | 模型、Sandbox 执行、迁移器、MinIO root |
| Scheduler | PG、轨迹对象存储清理凭据、Cube/E2B 生命周期、可选标题模型 | 主模型、API JWT 私钥、Worker Coordinator 身份 |
| Worker | PG、S3、Sandbox、主模型 | API 身份私钥、Admin 管理凭据 |
| Admin API | 独立管理身份、Admin Control PG、Skill Publisher PG、发布对象存储凭据及读取 Run 轨迹所需的 S3 凭据 | 普通 Runtime 全量秘密 |

Scheduler、Worker 与 Admin API 的轨迹存储配置必须指向同一个 bucket。Scheduler 使用专用只读目录连接枚举 Tenant ID，再逐 Tenant 经 Runtime RLS 清理；不复用 Worker Coordinator 身份。`RUN_TRAJECTORY_RETENTION_DAYS` 默认 30 天、允许 1–365 天。轨迹写入故障不影响 Run，但应监控不含正文的 `运行轨迹事件写入失败` 与 `运行轨迹保留清理失败` 日志。清理会先按 `blob_operation_id` 收敛 pending 提交、绑定稳定引用后再释放引用，再回收对象和移除索引；对象删除失败或提交仍在途时保留到期索引作为下一周期的重试锚点。

production 入口对非空 `NODE_*` 默认拒绝，只允许镜像固定的 `NODE_ENV`、`NODE_VERSION` 和私有 CA 通道 `NODE_EXTRA_CA_CERTS`；同时拒绝环境代理和 OpenSSL CA/config/provider 覆盖。该边界不能抵抗有权替换镜像 entrypoint 或 command 的部署者，必须由平台策略补足。

`API_PUBLIC_ORIGIN` 是浏览器/API 对外 origin；`S3_PUBLIC_ENDPOINT` 必须使用不同的专用对象 origin，禁止通过应用同源路径代理对象正文。

## 正式生产发布前必须完成

1. 为 API、Scheduler、Worker 建立生产镜像构建方式，从受保护分支的绿色 CI 提交构建一次并记录不可变 digest。
2. 在 Linux 预生产环境使用最小权限角色连接真实 PG、S3、Sandbox 与模型。
3. 验证 API、Scheduler、Worker 的启动、readiness、排空和关闭。
4. 验证身份、Membership、Tenant/RLS、Artifact 预览下载和对象 origin 越权矩阵。
5. 验证 CDN/S3 的 CORS、CSP、`nosniff`、缓存和响应头。
6. 完成备份与恢复演练，确认迁移前后版本与回滚兼容边界。
7. 定义容量、错误率、队列、租约、外部依赖和资源增长的观察阈值。
8. 执行灰度、停止扩容、应用回滚和必要时只读/停服的演练。

## 发布原则

- 先执行向前兼容迁移，再灰度不可变镜像 digest。
- 禁止在目标环境现场重新构建镜像。
- 必要探针失败时停止扩容，不通过放宽 TLS、角色、JWT 或 Tenant 边界救火。
- 数据库 down 只在迁移明确可逆且备份已验证时执行。
- 无法证明 Workspace→Revision→Artifact 闭环时，进入只读或停服应急状态。
- 发布证据不得包含连接串、JWT、API Key、私钥和用户正文。

## 依赖与许可证

安全修复通过精确直接依赖和限定版本线或父依赖的 override 固定版本；升级 Better Auth 时同步 `.pnpmfile.cjs` 的版本匹配，继续裁剪服务端未使用的框架、ORM 和测试 optional peer，避免开发工具进入生产闭包。第三方许可证和来源见仓库根目录 `THIRD_PARTY_NOTICES.md`。
