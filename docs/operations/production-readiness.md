# 生产就绪说明

本页区分“仓库静态与容器 Gate 已通过”和“目标环境已经可以生产发布”。前者是必要条件，但不能替代真实基础设施、身份、容量、观测和回滚验收。

## 当前可以由仓库证明的内容

- API、Scheduler、Worker 使用独立 production 装配，不回退到 development 身份、Fake Sandbox 或内存队列。
- production 配置拒绝 development 变量、明文依赖端点、错误 TLS/角色和未声明环境键。
- 三个核心进程使用 runtime-only、非 root 容器闭包。
- 基础镜像固定到记录的 digest，pnpm 版本和 registry integrity 固定。
- 依赖闭包可以离线生成确定排序的 CycloneDX 1.6 SBOM。
- registry 与 vendor 许可证执行默认拒绝策略。
- vendored 源码保留上游版本、许可证、来源、patch 和 canonical tree 证据。
- 静态发布清单校验镜像、迁移、回滚窗口和所需证据字段。
- 容器 Gate 验证只读 root filesystem、独立 `/tmp`、运行 UID 权限和秘密脱敏。

## 仓库不能替目标环境证明的内容

- 真实 PostgreSQL、S3、Sandbox、模型和代理的联合 readiness。
- Web/OIDC 产品身份、账号恢复、会话撤销和组织级权限。
- 完整跨 Tenant 越权矩阵和运维人员访问审计。
- CDN/S3 的 CORS、`nosniff`、CSP、缓存与专用下载 origin。
- 容量、性能、限流、配额、成本阈值和依赖故障预算。
- 备份恢复、集群回滚、跨版本兼容和破坏性迁移演练。
- 部署平台 admission policy、entrypoint/command 防覆盖和网络策略。

## Production 配置

`deploy/production.env.example` 是多个服务字段的合集，不是一个可以整包注入所有容器的共享秘密文件。

| 服务 | 应获得 | 不应获得 |
| --- | --- | --- |
| API | PG、S3、JWT/身份、TLS、公开 origin | 模型、Sandbox 执行、迁移器、MinIO root |
| Scheduler | PG、Cube/E2B 生命周期、可选标题模型 | S3、主模型、API JWT 私钥 |
| Worker | PG、S3、Sandbox、主模型 | API 身份私钥、Skill Admin 管理凭据 |
| Skill Admin | 独立身份、PG 与对象存储凭据 | 普通 Runtime 全量秘密 |

production 入口对非空 `NODE_*` 默认拒绝，只允许镜像固定的 `NODE_ENV`、`NODE_VERSION` 和私有 CA 通道 `NODE_EXTRA_CA_CERTS`；同时拒绝环境代理和 OpenSSL CA/config/provider 覆盖。该边界不能抵抗有权替换镜像 entrypoint 或 command 的部署者，必须由平台策略补足。

`API_PUBLIC_ORIGIN` 是浏览器/API 对外 origin；`S3_PUBLIC_ENDPOINT` 必须使用不同的专用对象 origin，禁止通过应用同源路径代理对象正文。

## 静态与容器 Gate

```powershell
corepack pnpm config:check:production
corepack pnpm supply-chain:check
corepack pnpm license:check
corepack pnpm release:check
corepack pnpm test:production-api:container
corepack pnpm test:production-scheduler:container
corepack pnpm test:production-worker:container
```

也可以执行：

```powershell
corepack pnpm check:production
```

镜像 builder 只在锁定的 fetch 阶段联网，后续 offline 安装、编译、deploy 和裁剪使用无网络构建步骤。最终镜像不应包含源码、测试、development entry、Python、npm/npx、Corepack/pnpm 或开发工具。这证明锁定依赖后的断网解析和编译，不表示整个 Docker build 在完全无缓存环境中离线可用。

API Gate 会在最终镜像中使用真实 AWS SDK 验证与 Worker 一致的 stable prefix HEAD、GET 和预签名下载路径。Scheduler 在启动循环前探测 PostgreSQL 角色和 Sandbox，并拒绝接收不使用的 S3 密钥。

## 发布前必须完成

1. 从受保护分支的绿色 CI 提交构建一次镜像并记录不可变 digest。
2. 填写 `deploy/production-release-manifest.example.json` 的正式副本，记录代码、镜像、SBOM、锁文件、迁移和回滚边界。
3. 在 Linux 预生产环境使用最小权限角色连接真实 PG、S3、Sandbox 与模型。
4. 验证 API、Scheduler、Worker 的启动、readiness、排空和关闭。
5. 验证身份、Membership、Tenant/RLS、Artifact 预览下载和对象 origin 越权矩阵。
6. 验证 CDN/S3 的 CORS、CSP、`nosniff`、缓存和响应头。
7. 完成备份与恢复演练，确认 migrationFrom、migrationTo 和 rollbackCompatibleThrough。
8. 定义容量、错误率、队列、租约、外部依赖和资源增长的观察阈值。
9. 执行灰度、停止扩容、应用回滚和必要时只读/停服的演练。
10. 由发布负责人签署[生产发布清单](../../deploy/production-release-checklist.md)。

## 发布原则

- 先执行向前兼容迁移，再灰度不可变镜像 digest。
- 禁止在目标环境现场重新构建镜像。
- 必要探针失败时停止扩容，不通过放宽 TLS、角色、JWT 或 Tenant 边界救火。
- 数据库 down 只在迁移明确可逆且备份已验证时执行。
- 无法证明 Workspace→Revision→Artifact 闭环时，进入只读或停服应急状态。
- 发布证据不得包含连接串、JWT、API Key、私钥和用户正文。

## 供应链说明

`supply-chain:check` 根据 production installed closure 离线生成无时间戳、确定排序的 SBOM，并与已提交文件逐字比较。`license:check` 重算 registry 与 vendor 许可证策略、本地派生 vendor 的上游 commit、patch 和 canonical tree hash；exact patch 还需通过反向应用检查。

第三方许可证和来源见仓库根目录 `THIRD_PARTY_NOTICES.md`。基础镜像 digest 的现有证据来自记录的 Docker `RepoDigests`；网络不可达时不能宣称已经重新验证远端 digest。
