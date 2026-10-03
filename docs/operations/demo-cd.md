# Demo 单机持续部署

本页供维护者在受控演示环境发布 Hoox。该路径用于功能测试和演示，不是生产发布替代品；生产上线仍必须遵守[生产就绪说明](production-readiness.md)和[生产发布清单](../../deploy/production-release-checklist.md)。

## 当前拓扑

- GitHub Actions 只接受本仓库 `main` push 的成功“持续集成”自动触发，也允许维护者在 `main` 手工重试。两种入口都要求发布 SHA 仍是 `main` 当前提交，且该 SHA 最新的 `ci.yml` push 运行已经成功；手工入口不能绕过 CI。
- 镜像推送到 GHCR，并以不可变 digest 交给目标主机；目标主机不从 Git 仓库现场构建。
- 单机 Docker Compose 运行 PostgreSQL、MinIO、API、Web、Admin Control、Admin Web、Trajectory、Scheduler 和 Worker。PostgreSQL 与 MinIO 端口只绑定宿主机回环地址。
- API、Web、Admin Control、Admin Web 与 Trajectory 使用 host network，并分别只监听 `127.0.0.1:3001`、`127.0.0.1:4173`、`127.0.0.1:3003`、`127.0.0.1:4174` 和 `127.0.0.1:4188`。
- 宿主机 Nginx 在 `hoox.aisay.cc` 提供 TLS。`/api/` 转发用户 API，`/agent-runtime-demo/` 转发 Demo 对象桶，其余普通路径转发用户 Web；`/admin/` 提供后台静态页面，`/v1/admin/` 通过内部 `auth_request` 校验 Hoox 会话后转发统一后台 API；`/trajectory/` 提供轨迹页面外壳，`/trajectory/api/` 只允许 Demo 管理员会话访问。
- Admin Web 与 Trajectory 页面从同源工作台的 `hoox.auth-session.v2` 读取未过期 Hoox access token。Nginx 仅在会话属于配置的 Demo 管理员用户时放行后台和轨迹 API；后台 API 的上游 `Authorization` 会由 root-only 配置覆盖为 Admin Control development Token，轨迹 API 则在鉴权后清空 `Authorization`，查看器进程不会接收 Hoox Session。
- Worker 与 Trajectory 共享固定数据 epoch 的跨发布轨迹卷：Worker 可写，查看器只读。应用发布、回滚和旧 release 目录清理都继续挂载并保留同一轨迹历史。
- Demo 使用 development 装配以复用单机入口，但必须同时设置 `DEMO_PUBLIC_ACCESS_ENABLED=true`、`DEMO_PUBLIC_ORIGIN=https://hoox.aisay.cc`、`DEMO_ADMIN_USER_ID=<Demo 管理员用户 ID>` 和 `DEV_AUTH_ENABLED=false`。固定开发身份、缺失管理员用户、明文 origin 和非回环 API 监听都会在解析期失败。

## 用户 Web 入口

- `/` 为公开介绍页，不读取登录状态，不请求用户 API。
- `/app` 与 `/app/` 为工作台入口；登录、OAuth 回调与同源身份存储沿用工作台契约。旧根路径带 `error` 的登录回调仍进入工作台。
- 首页与工作台使用同一个 Vite 构建和 Demo 镜像，静态服务通过 SPA 回退提供工作台路径；Nginx 与发布流程无需额外服务或路由配置。
- 安装后的 PWA 从 `/app` 启动。既有身份存储键不变，首页不会清除会话、草稿或任务。
- 《国富论》展示使用真实工作台组件与经授权的任务、文件名称及编辑摘要，不加载线上任务，不保存原始生产响应、账户信息或模型日志；交付卡片为只读，没有指向私有文件的下载链接。

入口选择及兼容取舍见 [ADR-20261003184949](../decisions/20261003184949-public-home-and-workspace-entry.md)。

## 首次主机准备

Demo 的部署类型以服务端 `RUNTIME_ENV` 为准，不能由前端 production 构建推断。数据库、身份和 S3 仍由部署配置管理；沙箱供应商与运行策略可在后台管理，环境配置保留为未托管实例的回退连接。配置项存在不等于外部服务可达，仍需完成部署预检；模型、记忆与沙箱的生效边界见[配置参考](../reference/configuration.md)。

启用后台沙箱配置前，`admin-control.env`、`worker.env` 和 `scheduler.env` 必须具有相同的稳定 `MODEL_CREDENTIAL_ENCRYPTION_KEY`。部署不得生成新的随机值覆盖已有加密根，否则旧实例凭据和配置将无法恢复。

发布脚本在迁移前核对 Admin Control 与 Worker 的现有有效加密根，并为缺失显式配置的进程固化同一个原值，包括 Scheduler。已有值不一致时失败关闭，不轮换密钥；该维护容器禁用网络，只挂载三个配置文件，日志不输出凭据。

目标主机必须预装 Docker Engine、Docker Compose、Nginx 和 Certbot。部署用户必须可直接访问 Docker socket，并可无密码执行 `nginx -t`、安装 Nginx 配置和 reload。

1. 创建 `/opt/hoox-demo/releases` 与 `/opt/hoox-demo/shared`，归部署用户所有；`shared` 权限设为 `0700`。
2. 确认 Nginx 的 `http` 块包含 `include /etc/nginx/conf.d/*.conf;`，不得删除同机既有 server block。
3. 创建 `/var/www/letsencrypt`，先用仅监听 80 的临时 server block 完成 ACME HTTP-01，再为 `hoox.aisay.cc` 签发证书。
4. 在 GitHub `demo` Environment 或仓库 Actions Secrets 中配置：
   - `DEMO_SSH_HOST`：目标主机；
   - `DEMO_SSH_USER`：部署用户；
   - `DEMO_SSH_PRIVATE_KEY`：部署专用私钥；
   - `DEMO_SSH_KNOWN_HOSTS`：经人工核对指纹后的完整 known-hosts 行；
   - `DEMO_GHCR_TOKEN`：具备 `write:packages` 的部署专用令牌，用于发布和目标主机拉取 GHCR 镜像。
5. 在 `/opt/hoox-demo/shared` 创建 `infra.env`、`migration.env`、`api.env`、`admin-control.env`、`scheduler.env`、`worker.env` 和 `demo-account.env`，全部设为 `0600`。真实密码、连接串、Admin Control Token 和 Provider Key 只能存在于目标主机秘密文件或 GitHub Secrets，不得进入仓库和发布日志。
6. `admin-control.env` 必须使用 Admin Control 与 Skill Publisher 两个最小权限数据库连接，复用 API 的 `BETTER_AUTH_SECRET`，使用回环 MinIO endpoint 和独立 Skill Publisher S3 用户，并配置随机、URL 安全且不少于 32 字符的 `DEV_ADMIN_CONTROL_TOKEN`。字段归属以 `deploy/demo/admin-control.env.example` 为准。

`deploy/demo/*.env.example` 只说明字段归属，不能直接作为凭据文件。API、Admin Control、Scheduler 和 Worker 必须各自只获得其进程需要的配置；MinIO root 与 PostgreSQL bootstrap 密码不得注入应用容器。

## 发布顺序

`.github/workflows/cd-demo.yml` 执行以下步骤：

1. 检出触发事件对应的实际提交，通过 GitHub API 核对 `main` 当前 SHA 和同提交最新 CI，再在 GitHub 托管 ARM64 Runner 上使用固定 commit 的 Action 构建镜像并推送 GHCR。构建后、配置 SSH 前再次核对；排队、重跑或构建期间已过期的发布会跳过后续远端操作，GitHub API 不可用或最新 CI 未通过时失败关闭。
2. 上传 `deploy/demo` 中的 Compose、初始化、Nginx 和远程发布契约到新的 release 目录。
3. 目标主机拉取 digest，启动 PostgreSQL 与 MinIO，幂等创建对象桶，再执行只向前的数据库迁移。
4. 以现有管理员用户 ID 或安全占位值启动 API、用户 Web 与只读 Trajectory，验证本机探针后生成 root-only Admin Control Bearer Token 配置，再原子安装不含 HTTP Basic 的 Nginx 配置。
5. 通过公开 HTTPS Better Auth 路径注册 Demo 账号。该账号是部署脚本托管的固定演示管理员，脚本在受限数据库连接中将其邮箱状态幂等标记为已验证，再使用同一账号登录并交换 Hoox Session；普通用户仍必须通过 SMTP 验证码完成邮箱验证。随后查询其用户与个人 Tenant，将用户幂等提升为有效平台控制管理员和 Skill 发布管理员。发布脚本只在 `0600` 临时 curl 配置中保存本次验收使用的 Hoox access token。
6. 将实际管理员用户同时注入 API 与 Admin Control，将个人 Tenant 注入 Scheduler 与 Worker，并强制重建这些应用容器及 Trajectory。API 以该用户 ID 作为 Demo 后台与轨迹会话闸门；Worker 默认把诊断镜像写入跨发布共享轨迹卷。
7. 检查七个应用服务持续运行、用户端 readiness、后台 readiness、后台与轨迹页面外壳、无会话后台及轨迹 API 的 `401`，以及带管理员 Hoox 会话的后台概览和轨迹列表 API，再切换 `/opt/hoox-demo/current`。只保留最近五个 release 目录；轨迹卷不随 release 目录清理。

发布工作流串行执行，不会为新提交取消正在迁移或恢复的发布。提交新鲜度以发布前最后一次 GitHub API 核验为准；核验后到发布完成期间仍可能出现新提交，新提交通过 CI 后再发布。首次引入门禁前的旧 SHA 不包含门禁脚本，重跑对应旧工作流可能直接失败，应等待当前 `main` CI 或从 `main` 手工重试。

目标主机拉取镜像的凭据只保存于按 workflow run 和 attempt 隔离的 `0700` Docker 配置目录。登录前预置无秘密的 GHCR auth 条目，禁止自动使用宿主机凭据 helper；无论发布成功或失败，工作流都会尝试 logout 并删除该目录中的凭据，同时删除 Runner 上的 SSH 私钥。SSH 使用严格主机校验、连接超时与断连探测，HTTP 探针和账号初始化请求都有单次超时；无响应的外部服务不会无限占用发布步骤。

## 验证

发布成功后至少检查：

```bash
curl --fail https://hoox.aisay.cc/
curl --fail https://hoox.aisay.cc/api/ready
curl --fail https://hoox.aisay.cc/admin/
curl --fail https://hoox.aisay.cc/trajectory/
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://hoox.aisay.cc/v1/admin/control/overview)" = "401"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://hoox.aisay.cc/trajectory/api/threads)" = "401"
docker compose --project-name hoox-demo \
  --env-file /opt/hoox-demo/shared/compose.env \
  -f /opt/hoox-demo/current/docker-compose.yml ps
```

未登录访问 `/admin/` 与 `/trajectory/` 应成功加载不含敏感数据的页面外壳；未携带 Hoox Bearer 的 `/v1/admin/` 与 `/trajectory/api/` 必须返回 `401`。在同源工作台使用 Demo 管理员账号登录后，再打开 `/admin/` 和 `/trajectory/`，后台应能读取管理数据，轨迹页应能读取稳定轨迹数据 epoch 中自启用后的 Run/Attempt。还应创建 Thread、触发一次 Run，并确认 Worker 能消费同一 Tenant 的 dispatch，且轨迹页出现对应记录。账号密码保存在运维人员的受限凭据文件中，不得复制到 issue、PR、Actions 日志或本页。

## 失败与回滚

- 发布开始前缺失契约或共享配置时直接退出，不改变运行中的应用。远程脚本进入发布阶段后，命令失败和显式验收失败都会由主 shell 执行一次恢复：停止候选应用容器，并在存在上一 release 时恢复上一镜像和应用进程，继续挂载同一稳定轨迹卷。上一 release 不含后台或 Trajectory 服务时，只恢复其实际声明的服务；恢复中的清理失败不会阻止其余恢复动作，也不会覆盖原始失败退出码。
- Nginx 候选配置失败时恢复上一站点配置；Admin Control Token 文件继续留在 root-only 路径并由后续成功发布覆盖。旧版 htpasswd 可能为回滚到仍使用 HTTP Basic 的上一 release 而暂时保留，但现行配置不会引用它。
- 数据库迁移只向前执行，脚本绝不自动运行 down；若新迁移与旧镜像不兼容，必须停服并按该迁移的 ADR 和备份方案处理。
- PostgreSQL、MinIO 和轨迹数据卷都不随应用回滚或旧 release 目录清理删除。轨迹卷固定为 `hoox-demo-trajectory-data-20260903`；未来只能通过显式数据 epoch 切换执行受控轮换，自动发布不得删除。
- 需要一次性舍弃 Demo 测试数据时，只能在 Compose 中把 PostgreSQL 与 MinIO 命名卷成对切换到同一个新数据 epoch。
  旧卷必须保留到候选 release 完成全部验收，以便失败时由上一 release 重新挂载；新版本稳定并处理外部 Sandbox 残留后，
  才可按确切卷名清理旧卷。发布脚本在候选和回滚时都必须显式强制重建 PostgreSQL 与 MinIO，不能依赖 Compose 自动
  识别顶层卷名变化；自动发布不得无条件执行 `down --volumes`。
- 首次发布没有上一版本可恢复；失败后数据库和对象存储可保留用于诊断，但公开应用进程必须保持停止，修正配置后重新发布。
- 主机断连、Runner 被强制终止或主机进程被强制杀死时，自动恢复和凭据清理无法保证完成。应先检查 Actions 的失败步骤及目标主机状态；凭据清理失败时，检查对应 `/opt/hoox-demo/shared/.docker-<run_id>-<run_attempt>` 目录并清理该次发布的凭据，不要删除其他发布或运维账号的 Docker 配置。
