# ADR-0054：生产传输、进程边界与可复现发布制品

- 状态：已接受
- 日期：2026-07-30
- 决策者：M7 生产安全与供应链复审
- 关联任务：生产 API/Scheduler/Worker 容器、PG/Cube/S3 安全边界、SBOM/License 与发布回滚 Gate
- 替代关系：替代 ADR-0049 中“process-runtime capability 不可伪造”的结论；细化 ADR-0008、ADR-0015、ADR-0050

## 背景

生产 API、Worker 与 Scheduler 已有真实依赖图，但复审发现五类不能靠类型或部署约定弥补的缺口：PostgreSQL URL
可以通过 query 降低 TLS 或覆盖会话参数；只比较 `current_user` 不能发现 `SET ROLE`、superuser 或 BYPASSRLS；Scheduler
可能在角色探针前产生远端清理副作用；API 读侧与 Worker 写侧的 S3 prefix 可能漂移；镜像、许可证、SBOM 和回滚步骤
还没有由同一锁文件与静态 Gate 约束。

此前 ADR-0049 把共享 JS 包导出的 factory 与 WeakSet 称为“不可伪造的 production capability”。同一进程内已经取得
执行权的代码可以导入公开 factory，JS 包边界也不是调用方 ACL；该表述会给出不存在的安全保证。

## 决策驱动因素

- 所有生产连接必须验证 PostgreSQL 证书链和主机名，URL 不能覆盖 TLS、`search_path` 或应用身份；
- 任何消费循环、远端 cleanup、HTTP listener 或模型调用前先证明数据库角色没有 RLS 绕过能力；
- 服务公开入口不能接受 production assembler，但通用生命周期库不伪装成进程内权限系统；
- API 与 Worker 对同一 stable Blob 必须使用一个代码级、迁移敏感的 prefix 契约；
- API/Scheduler/Worker 制品必须从锁文件离线复现依赖证据，以非 root、runtime-only 形式运行；
- 自动 Gate 的证明边界必须与真实基础设施、容量和故障验收严格区分。

## 备选方案

### 方案 A：保留灵活连接 URL、tag 镜像和人工发布记录

部署方便，但 URL 参数、基础层和临时工具下载均可绕过代码审阅；人工记录也不能证明 SBOM 与实际安装闭包一致。

### 方案 B：继续使用共享 capability factory 限制 production assembler

可以约束普通 API 使用方式，却不能限制同一进程内的任意已执行代码。继续宣称不可伪造会把代码组织误写成安全边界。

### 方案 C：服务入口固定装配，严格传输与角色探针，锁定并审计发布闭包

应用的 `startApiProcess`、`startWorkerProcess`、`startSchedulerProcess` 在 production 分支拒绝调用方 assembler，固定选择
本服务真实依赖图；`process-runtime` 只负责受信代码的生命周期编排。数据库、对象存储和制品再由独立、可执行契约约束。

## 选择

采用方案 C，并实施以下规则：

1. production `DATABASE_URL` 必须是 PostgreSQL URL，query 必须且只能出现一次 `sslmode=verify-full`。重复参数、大小写
   同义写法、`options`、`search_path`、`application_name`、`sslrootcert` 等所有其他 query 一律拒绝。传给 `pg` 前移除
   query，并显式设置 `ssl.rejectUnauthorized=true`；证书链与主机名使用 Node 系统信任库及进程启动时的
   `NODE_EXTRA_CA_CERTS`，URL 不承载证书路径。
   三个 production 入口在配置投影前对非空 `NODE_*` 默认拒绝，只允许镜像的 `NODE_ENV`/`NODE_VERSION` 与明示 CA
   扩展 `NODE_EXTRA_CA_CERTS`；同时按 ASCII 大小写不敏感语义拒绝 HTTP(S)/ALL/NO proxy、`SSL_CERT_FILE`、
   `SSL_CERT_DIR` 及 OpenSSL config/provider/engine 覆盖。最终镜像的非 Node entrypoint 在 Node 读取已知危险
   `NODE_OPTIONS`/TLS/代理/CA 变量前以换行安全的固定参数展开拒绝，再 `exec` 固定 CMD；其余未来 `NODE_*` 和 vendor
   `CUBE_*` 回退由最早 JS 配置边界默认拒绝。
2. production probe 同时要求 `current_user=session_user=DATABASE_RUNTIME_ROLE`，并从 `pg_roles` 验证 `rolsuper=false`
   和 `rolbypassrls=false`。错误只暴露 mismatch/unsafe 稳定类别，不输出实际角色。Scheduler 必须在构造 Cube gateway、
   cleanup consumer 与启动 loop 前完成该 probe；gateway 构造后还必须先执行 Cube probe，readiness 同时登记 PG/Cube。
   API 与 Worker 首次启动同样先独占完成 PG 角色证明，成功后才运行 S3/Cube/模型远端 probe 或启动 listener/loop；后续
   readiness 可独立重验各依赖。Scheduler 不使用 S3，因而不声明或投影任何 S3 变量；生产 API/Worker 的 S3 与各服务
   Cube 端点必须使用无凭据 HTTPS。
   Vendored Cube SDK 的 `Sandbox.create({config: Config})` 必须原样保留显式 `apiKey`/`null`，禁止重新读取 ambient
   `CUBE_API_KEY`/`E2B_API_KEY`；production 继承环境门禁同时对所有 `CUBE_*` 和 `E2B_API_KEY` 失败关闭。
3. JS 包不提供调用方 ACL。`process-runtime` 包根不导出任何创建或登记 production factory；它是受信服务代码可使用的
   通用编排器。安全边界位于三个服务公开 `start*Process`：production 分支拒绝 `input.assembler` 并固定本模块真实图。
4. `RUNTIME_BLOB_OBJECT_PREFIX` 是 Worker 写侧、数据库 `physicalObjectKey` 与 API 读侧的共享持久数据契约。生产 API 和
   Worker 均显式使用 `agent-worker`；改变它必须先迁移现存对象与数据库引用，不能通过环境变量临时漂移。
5. JWT 增加显式 `API_JWT_MAX_LIFETIME_SECONDS`，只允许 60–86400 秒，且 `exp-iat` 不得超过它。轮换时先加入新 kid，
   等待旧 token 最大寿命加 clock skew 后再删除旧 kid；回退也必须保留仍可能有效的旧 key。
6. API、Scheduler 与 Worker 的 build/runtime 两阶段都固定到
   `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`。
   该值来自本地 Docker `RepoDigests` 证据；当前网络不可达时不宣称已远端重新验证。静态 Gate 拒绝 tag-only 或值漂移。
7. `packageManager` 同时固定 pnpm 版本和 registry integrity。builder 唯一允许联网的依赖阶段是
   `pnpm fetch --frozen-lockfile`；随后 `pnpm install --offline --frozen-lockfile`、编译、`pnpm deploy --prod` 与裁剪均在
   `RUN --network=none` 中完成。最终镜像只保留单服务闭包，以 UID/GID 1000 运行真实 `dist/production-main.js`；应用、
   node_modules、SBOM 与 vendor 证据归 root:root 且没有任何 group/world write 位，不含源码、测试、development entry、
   sourcemap、声明文件、Python、npm/npx/Corepack/pnpm 或 Biome/TypeScript/tsx/Vitest。容器 Gate 用只读 root filesystem 与
   单独 `/tmp` tmpfs 启动；真实部署必须配置等价的 `readOnlyRootFilesystem`，不能只依赖镜像文件 mode。
8. SBOM 生成器只读取当前 pnpm production installed closure 与 `pnpm-lock.yaml`，强制 offline，不使用浮动临时执行器；
   输出排序、无时间戳的 CycloneDX 1.6，并记录 lock SHA-256。许可证默认失败关闭：仅 allow-list 可通过，deny-list 与
   未知许可证均失败；本地派生 vendor SDK 使用 `0.3.0-cube.local.1`，其上游 commit、patch ID/file/SHA-256 与排除
   根级 dist/node_modules/临时构建物后的 canonical patched-tree SHA-256 都由 Gate 重算，并由固定参数的
   `git apply --reverse --check` 证明 exact patch 与当前受控文件一致。Canonical tree 是包含 `PATCHES` 自身的完整证据快照；
   它不声称单个 patch 能从基线自描述地重建 patch manifest/patch 文件本身。`LICENSE`、`SOURCE.md`、`PATCHES` 和固定
   来源/差异证据同时进入 API、Scheduler、Worker 镜像。
9. 发布记录必须保存 API/Scheduler/Worker 镜像 digest、SBOM digest、迁移兼容窗口、必需 Gate 和上一组回滚 digest；清单约束灰度、
   回滚触发、停止领取、Schema down 条件与证据封存。发布只能引用已构建 digest，不能现场以 tag 重建。
10. 三个服务分别投影声明环境并分片秘密：API 使用 PG/S3/JWT/TLS，Scheduler 只使用 PG/Cube，Worker 使用
    PG/S3/Cube/模型。部署不得把合集 env 文件整包注入。外部 Web/OIDC 产品身份尚未接通，不能用 API JWT 单元边界
    宣称浏览器生产闭环。
11. `API_PUBLIC_ORIGIN` 显式声明浏览器/API 对外 origin；`S3_PUBLIC_ENDPOINT` 必须是不同的无凭据 HTTPS origin，禁止
    通过应用同源路径代理对象正文。对象存储/CDN CORS 只允许受信 Web origin。外部 `nosniff`/CSP 响应头不受本仓库代码
    控制，容器 Gate 不声称已经证明它们存在，真实部署必须逐响应验收。

## 影响

### 正面影响

- URL 不能把代码中的 TLS、会话路径和应用身份降级；高权限角色在副作用前失败关闭；
- 服务入口的真实保证与 JS 能力边界一致，不再依赖可公开铸造的“能力”；
- API 的 Artifact HEAD/GET/预签名路径与 Worker stable key 使用同一 prefix；
- 镜像基础层、运行闭包、SBOM、许可证和回滚信息都能由仓库内 Gate 复核。

### 成本与限制

- 私有 CA 必须通过部署平台配置 Node 信任库，不能塞入数据库 URL；
- prefix 将来变更需要对象与数据库引用迁移；
- 三个 Docker Gate 会分别构建镜像，SBOM/License 变更必须随 lockfile 更新；
- 锁定的 fetch 阶段仍需网络和包仓库可用；断网的依赖解析/编译证据不等于完整离线 Docker build；
- 镜像 entrypoint 与 JS 入口的继承环境拒绝是部署误配置 Gate；有权覆盖镜像 entrypoint、命令或镜像内容的恶意部署者仍
  不在该边界内，集群 admission policy/镜像启动策略、只读 root filesystem 与受控 `/tmp` tmpfs 仍是 M7 外部前置条件；
- 本地 `RepoDigests` 和断网安装/编译证据不等于镜像仓库签名、来源证明或真实环境验收。

## 验证

- 单元测试覆盖 PG query 覆盖通道、显式 SSL、角色/session/superuser/BYPASSRLS、Scheduler probe 顺序与 HTTPS；
- API/Worker/Scheduler 高层入口测试覆盖 production Fake 拒绝，process-runtime 包根负向测试覆盖无 production factory；
- API JWT 测试覆盖最大寿命；生产 API 装配测试断言共享 S3 prefix；
- API 容器 Gate 在最终安装闭包中使用真实 AWS SDK 对本地协议端点执行同一 stable key 的 HEAD、GET 与预签名下载路径，
  并验证缺失 PG/S3、development 变量、明文端点、TLS/代理/PG 配置错误均失败关闭且不泄密；Scheduler Gate 覆盖
  PG/Cube 缺失、Cube 凭据/HTTP/角色误配与无 S3 secret 投影；Worker Gate 验证同类制品边界；
- `supply-chain:check`、`license:check` 与 `release:check` 验证确定性 SBOM、许可证证据、镜像 digest 和回滚字段。

以上 Gate 没有连接真实 PostgreSQL、S3、CubeSandbox、模型或生产代理，也没有执行容量、长时运行、故障注入、镜像签名与
集群回滚演练；这些项目仍是 M7 未完成条件，不能据此宣称整体 production ready。

## 可逆性与回退

未新增数据库迁移。可以停止 API/Scheduler/Worker 并回退到上一组已记录镜像 digest，保留向前兼容 Schema；不能通过放宽 TLS、角色、
RLS、JWT 寿命、prefix 或恢复 development 入口回退。若已经改变对象 prefix，必须先执行经验证的双读/迁移方案，不能直接
切回旧字符串。基础镜像或许可证策略回退仍须产生新的、可复现的 SBOM 与发布记录。

## 后续工作

- 在联网发布环境用 registry manifest/signature/provenance 复核基础镜像并保存证据；
- 在真实最小权限 PG/S3/CubeSandbox/模型/代理环境执行 readiness、故障、回滚与越权矩阵；
- 完成配额、对象生命周期、可观测性、容量和长时资源增长验收。
