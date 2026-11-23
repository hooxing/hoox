# Demo 单机持续部署

本页供维护者在受控演示环境发布 Hoox。该路径用于功能测试和演示，不是生产发布替代品；生产上线仍必须完成[生产就绪说明](production-readiness.md)中的目标环境验收。

## 当前拓扑

- GitHub Actions 只接受本仓库 `main` push 的成功“持续集成”自动触发，也允许维护者在 `main` 手工重试。两种入口都要求发布 SHA 仍是 `main` 当前提交，且该 SHA 最新的 `ci.yml` push 运行已经成功；手工入口不能绕过 CI。
- 镜像推送到 GHCR，并以不可变 digest 交给目标主机；目标主机不从 Git 仓库现场构建。
- 单机 Docker Compose 运行 PostgreSQL、MinIO、API、Web、Admin Control、Admin Web、Scheduler 和 Worker。PostgreSQL 与 MinIO 端口只绑定宿主机回环地址。
- API、Web、Admin Control 与 Admin Web 使用 host network，分别只监听 `127.0.0.1:3001`、`127.0.0.1:4173`、`127.0.0.1:3003` 和 `127.0.0.1:4174`。
- 宿主机 Nginx 在 `hoox.aisay.cc` 提供 TLS。`/api/` 转发用户 API，`/agent-runtime-demo/` 转发 Demo 对象桶，其余普通路径转发用户 Web；`/admin/` 提供后台静态页面，`/v1/admin/` 通过内部 `auth_request` 校验 Hoox 会话后转发统一后台 API；旧 `/trajectory` 与 `/trajectory/` 返回 `308 /admin/runs`。
- Admin Web 从同源工作台的 `hoox.auth-session.v2` 读取未过期 Hoox access token。Nginx 仅在会话属于配置的 Demo 管理员用户时放行后台 API；上游 `Authorization` 由 root-only 配置覆盖为 Admin Control development Token。
- Worker 可把 development 诊断镜像写入容器本地文件系统以支持容器内排障；Demo 不持久化该镜像，也不运行 Trajectory Web 服务。后台运行记录通过受限 PostgreSQL 投影读取持久 Run 事件。升级时 Compose 使用 `--remove-orphans` 清除旧版独立轨迹容器，但不删除数据库或对象存储数据卷。
- Demo 使用 development 装配以复用单机入口，但必须同时设置 `DEMO_PUBLIC_ACCESS_ENABLED=true`、`DEMO_PUBLIC_ORIGIN=https://hoox.aisay.cc`、`DEMO_ADMIN_USER_ID=<Demo 管理员用户 ID>` 和 `DEV_AUTH_ENABLED=false`。固定开发身份、缺失管理员用户、明文 origin 和非回环 API 监听都会在解析期失败。

## 用户 Web 入口

- `/` 为公开介绍页，不读取登录状态，不请求用户 API。
- 首页面向搭建、部署 Agent 的开发者与技术团队，展示执行方式、沙箱生命周期、团队分支、服务接入与执行轨迹。模式、空闲策略和供应商切换只改变本地机制演示，不写入真实配置，不触发任务或请求外部服务。PTC 标注实验状态与内部工具串行边界，团队分支说明文本快照与独立推进，记忆说明当前 Mem0 可选接入。
- 执行光路、代码调用链、沙箱形态变化、分支快照与轨迹分镜在各自进入可见区域后有限播放，可独立暂停或重播；离屏、后台标签页与人工暂停均不推进分镜。播放完成后停止动画；系统减少动态效果偏好下直接呈现完整结果，并关闭景深跟随。
- `/app` 与 `/app/` 为工作台入口；登录、OAuth 回调与同源身份存储沿用工作台契约。旧根路径带 `error` 的登录回调仍进入工作台。
- 首页与工作台使用同一个 Vite 构建和 Demo 镜像，静态服务通过 SPA 回退提供工作台路径；Nginx 与发布流程无需额外服务或路由配置。
- 安装后的 PWA 从 `/app` 启动。既有身份存储键不变，首页不会清除会话、草稿或任务。
- 《国富论》展示使用真实工作台组件与经授权的任务、文件名称及编辑摘要，不加载线上任务，不保存原始生产响应、账户信息或模型日志；案例以本地流式回放呈现，进入可见区域后播放一次，可暂停或重播；离屏或切换标签页时暂停，减少动态效果偏好下直接展示结果。交付卡片为只读，没有指向私有文件的下载链接。

入口选择及兼容取舍见 [Workspace、Resource 与交付物](../architecture/workspace-and-files.md)。

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
6. `admin-control.env` 必须使用 Admin Control 与 Skill Publisher 两个最小权限数据库连接，复用 API 的 `BETTER_AUTH_SECRET`，使用回环 MinIO endpoint，分别配置轨迹读取的 `S3_*` 与独立 Skill Publisher 的 `SKILL_PUBLISHER_S3_*`，并配置随机、URL 安全且不少于 32 字符的 `DEV_ADMIN_CONTROL_TOKEN`。字段归属以 `deploy/demo/admin-control.env.example` 为准。

`deploy/demo/*.env.example` 只说明字段归属，不能直接作为凭据文件。API、Admin Control、Scheduler 和 Worker 必须各自只获得其进程需要的配置；MinIO root 与 PostgreSQL bootstrap 密码不得注入应用容器。

## 首次部署操作指南

以下步骤对应仓库现有的 `demo` GitHub Actions 工作流，目标是受控 ARM64 单机演示环境。工作流中的镜像名、目录、域名和桶名是固定值；要用于其他环境，须先修改并验证工作流、反向代理及相应配置，不能只修改本机环境变量。该工作流不是通用 production 安装器。

### 1. 准备主机、域名和证书

1. 准备可从 GitHub Actions 经 SSH 访问的 Linux ARM64 主机，安装 Docker Engine、Compose v2、Nginx、Certbot、curl、Python 3 和 sudo；确认部署用户可运行 `docker compose version`、访问 Docker socket，并能无交互地安装及重载 Nginx 配置。
2. 将 `hoox.aisay.cc` 的 DNS 指向目标主机，开放公网 TCP 80、443；SSH 访问按部署网络限制。确认宿主机的 3001、3003、4173、4174、15432、19000、19001 端口未被占用。PostgreSQL、MinIO 和应用监听回环地址，不要将其端口直接开放到公网。
3. 以有权限的账号创建目录，再将其所有权交给部署用户：

   ```bash
   sudo install -d -m 0755 /opt/hoox-demo/releases
   sudo install -d -m 0700 /opt/hoox-demo/shared
   sudo chown -R <部署用户>:<部署用户组> /opt/hoox-demo
   sudo install -d -m 0755 /var/www/letsencrypt
   ```

   将尖括号及内容替换为真实的本机用户和组，勿直接复制占位符执行。保留已有 Nginx 站点并确认 `http` 块加载 `conf.d/*.conf`。
4. 配置只监听 80 且允许 `/.well-known/acme-challenge/` 从 `/var/www/letsencrypt` 读取的临时站点，执行 `sudo nginx -t` 并重载后，使用 Certbot 的 webroot 模式为域名申请证书。确认 `/etc/letsencrypt/live/hoox.aisay.cc/` 下存在 `fullchain.pem` 和 `privkey.pem`，并配置和验证证书自动续期及续期后的 Nginx 重载。正式站点由发布脚本安装；首次发布前必须已有证书。

### 2. 准备共享配置

在目标主机以部署用户创建 `/opt/hoox-demo/shared` 下的七个文件，权限均设为 `0600`。以下是文件职责；具体变量和校验以[配置参考](../reference/configuration.md)、`.env.example`、`deploy/demo/*.env.example` 和各进程配置契约为准。示例是字段参考，不能原样投入运行，也不能将完整 `.env` 分发给每个服务。

| 文件 | 所需内容和关系 |
| --- | --- |
| `infra.env` | PostgreSQL 初始化账号、数据库及各独立角色和密码（含 Webhook Dispatcher 与轨迹目录角色），MinIO root、运行时与 Skill 发布账号，以及桶名；从 `infra.env.example` 起草。PostgreSQL 初始化脚本在新数据卷初始化时执行，每次发布也会幂等补齐缺失角色；已有角色不会被修改，修改此文件不会自动轮换已有数据库角色密码。 |
| `migration.env` | 迁移连接 `MIGRATION_DATABASE_URL`、schema 和迁移角色等迁移契约；连接指向宿主机回环 `127.0.0.1:15432`，身份与 `infra.env` 中的 migrator 一致。 |
| `api.env` | 从 `api.env.example` 起草，补齐运行时数据库、身份、游标和 S3 等 API 必需配置；数据库和 S3 身份对应 `infra.env` 的运行时账号，S3 内部地址使用 `127.0.0.1:19000`。 |
| `admin-control.env` | 从同名示例起草，使用独立 Admin Control、Skill Publisher 数据库角色；轨迹读取须配置六项 `S3_*`，Skill 发布另用独立的 `SKILL_PUBLISHER_S3_*` 账号；`BETTER_AUTH_SECRET` 与 API 相同，设置独立的 `DEV_ADMIN_CONTROL_TOKEN` 和稳定加密根。 |
| `scheduler.env` | Scheduler 所需数据库角色、进程身份和稳定加密根，以及 Webhook Dispatcher 角色、连接与 `WEBHOOK_SECRET_ENCRYPTION_KEY`（从 `scheduler.env.example` 起草）；租户 ID 由发布脚本注入。配置与 Worker 同 bucket 的轨迹清理 S3 凭据；禁止注入 Worker Coordinator 或主模型调用密钥。 |
| `worker.env` | Worker 所需数据库角色、S3 运行时账号、进程身份和稳定加密根；租户 ID 由发布脚本注入。 |
| `demo-account.env` | `DEMO_ACCOUNT_DISPLAY_NAME`、`DEMO_ACCOUNT_EMAIL`、`DEMO_ACCOUNT_PASSWORD`，供脚本创建或登录固定 Demo 管理员。文件由 shell `source` 读取，值须是有效 shell 赋值；已有账号不会因修改文件而自动改密码。 |

`scheduler.env` 与 `admin-control.env` 都必须显式包含 `S3_ENDPOINT=http://127.0.0.1:19000`、`S3_BUCKET=agent-runtime-demo`、`S3_REGION=us-east-1`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 和 `S3_FORCE_PATH_STYLE=true`。端点与桶必须指向 Worker 的同一存储；Demo 当前使用 `infra.env` 中运行时 S3 用户的凭据，不能误填 Skill Publisher 或 MinIO root 凭据。这六项必须写成不加引号、无空白、无行尾注释、不含 `$` 的单行 `KEY=值`（LF 换行），每个键恰好出现一次；预检不执行 env 文件，也不实现 dotenv/Compose 的完整语法，其他写法一律以格式无效拒绝，以免预检与运行时解析不一致。`minio-init` 当前为运行时与 Skill Publisher 用户绑定通用 `readwrite` 策略，尚未自动创建 Scheduler/Admin Control 的受限用户。生产应按[配置参考](../reference/configuration.md#对象存储)分别授权，而不是照搬 Demo 的宽权限。

发布脚本在拉取镜像、改写 `compose.env` 或停止现有容器之前校验这两个文件的六项 `S3_*`：缺失、空值或非法路径风格布尔值均以退出码 2 失败，只报告文件与变量名，不输出值。其他格式和服务权限仍由进程解析与实际依赖检查校验。Scheduler 启动时的环境解析错误输出变量名和 `MISSING`/`INVALID` 等稳定分类，不输出配置值或底层异常。

仓库目前只为 `infra.env`、`api.env`、`admin-control.env` 和 `scheduler.env` 提供 Demo 局部示例，其余文件需要按当前进程契约准备。生成密码和密钥时避免出现在命令历史、终端录屏、日志或提交中；连接串中的特殊字符需按 URL 规则编码。`infra.env` 同样被 shell 读取，必须同时满足 shell 与 Compose env 文件解析。完成后核对权限及文件存在性，避免打印文件内容：

```bash
chmod 0700 /opt/hoox-demo/shared
chmod 0600 /opt/hoox-demo/shared/{infra,migration,api,admin-control,scheduler,worker,demo-account}.env
ls -ld /opt/hoox-demo/shared
ls -l /opt/hoox-demo/shared/*.env
```

`MODEL_CREDENTIAL_ENCRYPTION_KEY` 在 Admin Control、Worker 和 Scheduler 中必须一致且稳定并安全备份。`BETTER_AUTH_SECRET` 在 API 和 Admin Control 中必须一致。模型和沙箱可以在后台配置；尚未就绪时 Worker 不领取业务任务，因此服务启动不代表可以执行 Run。Demo 发布仍会初始化固定管理员，和通用安装的首次管理员创建流程不同。

### 3. 配置发布并触发

在 GitHub 仓库的 `demo` Environment 或 Actions Secrets 中填写上一节列出的五项 Secrets，使用人工核验过的 SSH host key；确保部署令牌可推送和拉取该 GHCR 包。保护 Environment 时还需满足其审批规则。将变更通过必需 CI 合并到 `main`：该提交的 push CI 成功后自动触发 Demo CD；也可在 Actions 中选择“Demo 持续部署”，从 `main` 手动运行。手动运行同样要求当前 `main` 的最新 push CI 成功。

查看 Actions 的构建、发布和验证步骤；确认工作流实际执行发布而非因提交过期跳过。成功后按下方“验证”完成浏览器、管理员、Run 和轨迹验收。进入同源后台后配置并测试模型和沙箱、应用沙箱分配，再创建新的 Run；保存配置不等于外部依赖可达。配置与运行快照的生效边界见[配置参考](../reference/configuration.md)。

### 4. 常见故障定位

- SSH 或镜像拉取失败：检查 Actions Secret、主机指纹、网络、GHCR 包权限及令牌；不要在日志中打印密钥。
- 证书或 Nginx 失败：检查 DNS、80/443、证书路径、`sudo nginx -t` 和站点冲突；发布失败会尝试恢复原站点。
- 迁移或数据库连接失败：检查数据库健康状态、各角色和 schema、连接地址及迁移日志；checksum 不一致时停止，勿修改已执行迁移或迁移记录。
- API 正常但任务不运行：查看 Worker、Scheduler 容器状态与日志，检查后台模型和沙箱配置、分配及实际依赖连通性；Worker 未就绪会停止领取任务。
- 管理页面无法访问数据：先从同源工作台以固定 Demo 管理员登录，检查会话、管理员授权及 Nginx 配置；不要公开后台 Token。

定位时可使用上一节验证命令中的 Compose 参数加 `logs --tail=100 <服务名>`。日志可能包含运行信息，应在受控环境查看并在分享前脱敏。

## 保留数据卷升级

PostgreSQL 数据卷保留时，Docker 不会重新执行初始化脚本。发布脚本因此在迁移前以容器内 `infra.env` 幂等执行 `postgres-init.sh`：只创建缺失的角色、授予 CONNECT 并确保 Schema 存在，不修改已有角色的密码或属性；角色安全属性仍由迁移前置检查失败关闭。

发布前必须在服务器共享配置中补齐 Scheduler 的 Webhook 投递与轨迹目录身份，否则发布在拉取镜像前以退出码 2 失败，不改动当前版本：

1. `infra.env`：`DATABASE_WEBHOOK_DISPATCHER_ROLE` 与 `DATABASE_WEBHOOK_DISPATCHER_PASSWORD`（随机强密码），以及独立的 `DATABASE_TRAJECTORY_DIRECTORY_ROLE` 与 `DATABASE_TRAJECTORY_DIRECTORY_PASSWORD`。
2. `migration.env`：与 `infra.env` 相同的 `DATABASE_WEBHOOK_DISPATCHER_ROLE` 和 `DATABASE_TRAJECTORY_DIRECTORY_ROLE`。
3. `scheduler.env`：目录身份使用 `DATABASE_TRAJECTORY_DIRECTORY_ROLE` 和 `DATABASE_TRAJECTORY_DIRECTORY_URL`（与投递连接相同的主机和数据库，不同角色和口令）；移除 `DATABASE_WORKER_COORDINATOR_URL` 和 `DATABASE_WORKER_COORDINATOR_ROLE`。投递使用相同的 `DATABASE_WEBHOOK_DISPATCHER_ROLE`，用户名、密码和数据库名与 `infra.env` 一致、指向 `127.0.0.1:15432` 的 `WEBHOOK_DISPATCHER_DATABASE_URL`，以及不少于 32 字节的 `WEBHOOK_SECRET_ENCRYPTION_KEY`。
4. `api.env`：与 `scheduler.env` 完全相同的 `WEBHOOK_SECRET_ENCRYPTION_KEY`。该加密根必须稳定并安全备份，更换会使已登记的 Webhook 密钥无法解密。

发布成功后，可在工作台注册指向受控 HTTPS 接收端的 Webhook，触发一次 Run 并确认接收端收到可验签的事件，作为保留数据卷升级路径的投递烟测。

## 发布顺序

`.github/workflows/cd-demo.yml` 执行以下步骤：

1. 检出触发事件对应的实际提交，通过 GitHub API 核对 `main` 当前 SHA 和同提交最新 CI，再在 GitHub 托管 ARM64 Runner 上使用固定 commit 的 Action 构建镜像并推送 GHCR。构建后、配置 SSH 前再次核对；排队、重跑或构建期间已过期的发布会跳过后续远端操作，GitHub API 不可用或最新 CI 未通过时失败关闭。
2. 上传 `deploy/demo` 中的 Compose、初始化、Nginx 和远程发布契约到新的 release 目录。
3. 目标主机先核对 Webhook Dispatcher 配置（见“保留数据卷升级”），不一致时在改动任何发布状态前失败；随后拉取 digest，启动 PostgreSQL 与 MinIO，经 TCP 确认 PostgreSQL 就绪后幂等执行初始化脚本补齐缺失的受限角色，并验证 Dispatcher 能以配置的凭据登录，再幂等创建对象桶并执行只向前的数据库迁移。
4. 以现有管理员用户 ID 或安全占位值启动 API、用户 Web 和 Admin Control，验证本机探针后生成 root-only Admin Control Bearer Token 配置，再原子安装不含 HTTP Basic 的 Nginx 配置。
5. 在受限数据库连接中检查固定 Demo 账号是否已存在，仅在缺失时通过公开 HTTPS Better Auth 路径注册；已有账号继续使用原凭据。该账号是部署脚本托管的固定演示管理员，脚本将其邮箱状态幂等标记为已验证，再使用同一账号登录并交换 Hoox Session；普通用户仍必须通过 SMTP 验证码完成邮箱验证。账号查询结果无效、初始化失败或登录失败均终止发布并恢复上一应用版本，HTTP 失败只记录状态码，不输出响应正文。随后查询其用户与个人 Tenant，将用户幂等提升为有效平台控制管理员和 Skill 发布管理员。发布脚本只在 `0600` 临时 curl 配置中保存本次验收使用的 Hoox access token。
6. 将实际管理员用户同时注入 API 与 Admin Control，将个人 Tenant 注入 Scheduler 与 Worker，并强制重建应用容器。API 以该用户 ID 作为 Demo 后台会话闸门；Worker 将完整逻辑轨迹写入共享对象存储，Scheduler 负责按保留期清理，不需要本地诊断轨迹卷。
7. 检查应用服务持续运行，并确认 Worker 无重启且已完成依赖探测、启动消费循环；Worker 启动失败或超过两分钟仍未完成时触发应用镜像回退，API readiness 成功不能替代 Worker 验收。随后检查用户端 readiness、后台 readiness、后台页面、无会话后台 API 的 `401`，以及带管理员 Hoox 会话的后台概览，再切换 `/opt/hoox-demo/current`。只保留最近五个 release 目录；Worker 诊断卷不随 release 目录清理。

发布工作流串行执行，不会为新提交取消正在迁移或恢复的发布。提交新鲜度以发布前最后一次 GitHub API 核验为准；核验后到发布完成期间仍可能出现新提交，新提交通过 CI 后再发布。首次引入门禁前的旧 SHA 不包含门禁脚本，重跑对应旧工作流可能直接失败，应等待当前 `main` CI 或从 `main` 手工重试。

目标主机拉取镜像的凭据只保存于按 workflow run 和 attempt 隔离的 `0700` Docker 配置目录。登录前预置无秘密的 GHCR auth 条目，禁止自动使用宿主机凭据 helper；无论发布成功或失败，工作流都会尝试 logout 并删除该目录中的凭据，同时删除 Runner 上的 SSH 私钥。SSH 使用严格主机校验、连接超时与断连探测，HTTP 探针和账号初始化请求都有单次超时；无响应的外部服务不会无限占用发布步骤。

## 验证

发布成功后至少检查：

```bash
curl --fail https://hoox.aisay.cc/
curl --fail https://hoox.aisay.cc/app
curl --fail https://hoox.aisay.cc/api/ready
curl --fail https://hoox.aisay.cc/admin/
curl --fail --location https://hoox.aisay.cc/trajectory/
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://hoox.aisay.cc/v1/admin/control/overview)" = "401"
docker compose --project-name hoox-demo \
  --env-file /opt/hoox-demo/shared/compose.env \
  -f /opt/hoox-demo/current/docker-compose.yml ps
```

`/` 展示公开介绍页，首页的工作台入口应跳转到 `/app`；两条路径均应支持直接访问和刷新。未登录访问 `/admin/` 应成功加载不含敏感数据的页面外壳；旧 `/trajectory/` 应重定向到 `/admin/runs`。未携带 Hoox Bearer 的 `/v1/admin/` 必须返回 `401`。在同源工作台使用 Demo 管理员账号登录后，后台应能读取管理数据与运行记录。还应创建 Thread、触发一次 Run，并确认 Worker 能消费同一 Tenant 的 dispatch，Run 出现在后台运行记录中。账号密码保存在运维人员的受限凭据文件中，不得复制到 issue、PR、Actions 日志或本页。

## 失败与回滚

- 发布开始前缺失契约或共享配置时直接退出，不改变运行中的应用。远程脚本进入发布阶段后，命令失败和显式验收失败都会由主 shell 执行一次恢复：停止候选应用容器，并在存在上一 release 时恢复上一镜像和应用进程；恢复中的清理失败不会阻止其余恢复动作，也不会覆盖原始失败退出码。
- 上一镜像从发布前的 `shared/compose.env` 读取；回滚重新原子写入上一镜像、release 目录、release ID 和既有 Demo 身份，再以旧 Compose 强制重建 PostgreSQL、MinIO、API、Web、Scheduler、Worker，以及旧版存在的 Admin Control、Admin Web 或独立轨迹服务。所有 Compose 调用均屏蔽调用方的镜像、发布目录和 Demo 身份插值变量，只使用 `compose.env`，避免新镜像环境覆盖回滚配置；运维检查必须核对容器实际镜像，不能仅凭 `current` 软链或“已尝试恢复”日志判断回滚成功。
- Nginx 候选配置失败时恢复上一站点配置；Admin Control Token 文件继续留在 root-only 路径并由后续成功发布覆盖。旧版 htpasswd 可能为回滚到仍使用 HTTP Basic 的上一 release 而暂时保留，但现行配置不会引用它。
- 数据库迁移只向前执行，脚本绝不自动运行 down；若新迁移与旧镜像不兼容，必须停服并按该迁移说明和备份方案处理。
- PostgreSQL 与 MinIO 数据卷不随应用回滚或旧 release 目录清理删除。Worker 诊断镜像不再写入共享卷，因此不作为升级保留数据。
- 需要一次性舍弃 Demo 测试数据时，只能在 Compose 中把 PostgreSQL 与 MinIO 命名卷成对切换到同一个新数据 epoch。2026-11 迁移基线压缩后，数据卷切换到 `20261118` epoch：新卷由初始化脚本重建角色与 Schema，再执行基线迁移；旧 `20260826` 卷保留给回滚到压缩前镜像。2026-11-20 因修复迁移回退依赖顺序（down 文件变化导致 checksum 变化），切换到 `20261120` epoch；旧 `20261118` 卷保留给回滚，确认后由运维人员手工删除。
  旧卷必须保留到候选 release 完成全部验收，以便失败时由上一 release 重新挂载；新版本稳定并处理外部 Sandbox 残留后，
  才可按确切卷名清理旧卷。发布脚本在候选和回滚时都必须显式强制重建 PostgreSQL 与 MinIO，不能依赖 Compose 自动
  识别顶层卷名变化；自动发布不得无条件执行 `down --volumes`。
- 模型、运行设置和沙箱配置不会随数据 epoch 切换丢失。发布脚本会在重建 PostgreSQL 之前、以及发布成功之后，把这些全局配置导出到 `/opt/hoox-demo/shared/runtime-config/latest.sql`，并保留最近 10 份带时间戳的快照（目录 `0700`，文件 `0600`）。迁移完成后，如果新库里还没有任何模型或沙箱配置，脚本会在启动应用之前用单事务恢复这份备份；新库里已有配置时绝不覆盖。
  - 备份范围：`admin_control_config_revisions`、`admin_control_active_configs`、`sandbox_provider_profiles`、`sandbox_profile_probes`、`sandbox_routing_revisions`、`sandbox_routing_targets`、它们引用的 `app_users` ID，以及两个配置代数（generation）指针。不包含 Tenant、账号、Thread、Run 或文件。
  - 凭证在备份里仍是数据库中的密文，只有共享 env 里的模型与沙箱加密密钥不变时才能解密。轮换密钥后，恢复出来的配置需要在后台重新填写凭证。
  - 备份失败或恢复失败只输出告警，不阻断发布；恢复失败时数据库保持原样。需要手工恢复时，在服务器上执行 `docker exec -i hoox-demo-postgres-1 psql -U <POSTGRES_USER> -d <POSTGRES_DB> -v ON_ERROR_STOP=1 --single-transaction < /opt/hoox-demo/shared/runtime-config/latest.sql`，前提同样是新库里尚无这些配置。
- 首次发布没有上一版本可恢复；失败后数据库和对象存储可保留用于诊断，但公开应用进程必须保持停止，修正配置后重新发布。
- 主机断连、Runner 被强制终止或主机进程被强制杀死时，自动恢复和凭据清理无法保证完成。应先检查 Actions 的失败步骤及目标主机状态；凭据清理失败时，检查对应 `/opt/hoox-demo/shared/.docker-<run_id>-<run_attempt>` 目录并清理该次发布的凭据，不要删除其他发布或运维账号的 Docker 配置。
