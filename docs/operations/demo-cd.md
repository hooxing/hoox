# Demo 单机持续部署

本页供维护者在受控演示环境发布 Hoox。该路径用于功能测试和演示，不是生产发布替代品；生产上线仍必须遵守[生产就绪说明](production-readiness.md)和[生产发布清单](../../deploy/production-release-checklist.md)。

## 当前拓扑

- GitHub Actions 只在 `main` 的“持续集成”成功后自动构建 `linux/arm64` 镜像，也允许维护者手工选择 ref。
- 镜像推送到 GHCR，并以不可变 digest 交给目标主机；目标主机不从 Git 仓库现场构建。
- 单机 Docker Compose 运行 PostgreSQL、MinIO、API、Web、Admin Control、Admin Web、Scheduler 和 Worker。PostgreSQL 与 MinIO 端口只绑定宿主机回环地址。
- API、Web、Admin Control 与 Admin Web 使用 host network，并分别只监听 `127.0.0.1:3001`、`127.0.0.1:4173`、`127.0.0.1:3003` 和 `127.0.0.1:4174`。
- 宿主机 Nginx 在 `hoox.aisay.cc` 提供 TLS。`/api/` 转发用户 API，`/agent-runtime-demo/` 转发 Demo 对象桶，其余普通路径转发用户 Web；`/admin/` 直接提供后台静态页面，`/v1/admin/` 通过内部 `auth_request` 校验 Hoox 会话后转发统一后台 API。
- Admin Web 从同源工作台的 `hoox.auth-session.v2` 读取未过期 Hoox access token；没有会话时只展示前往工作台登录的提示。Nginx 仅在会话属于配置的 Demo 管理员用户时放行后台 API，再从 root-only 配置覆盖上游 `Authorization` 为 Admin Control development Token。该 Token 不进入浏览器、静态资源或 Hoox 会话。
- Demo 使用 development 装配以复用单机入口，但必须同时设置 `DEMO_PUBLIC_ACCESS_ENABLED=true`、`DEMO_PUBLIC_ORIGIN=https://hoox.aisay.cc`、`DEMO_ADMIN_USER_ID=<Demo 管理员用户 ID>` 和 `DEV_AUTH_ENABLED=false`。固定开发身份、缺失管理员用户、明文 origin 和非回环 API 监听都会在解析期失败。

## 首次主机准备

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

1. 检出通过 CI 的实际提交，在 GitHub 托管 ARM64 Runner 上使用固定 commit 的 Action 构建镜像并推送 GHCR。
2. 上传 `deploy/demo` 中的 Compose、初始化、Nginx 和远程发布契约到新的 release 目录。
3. 目标主机拉取 digest，启动 PostgreSQL 与 MinIO，幂等创建对象桶，再执行只向前的数据库迁移。
4. 以现有管理员用户 ID 或安全占位值启动 API 与用户 Web，验证本机探针后生成 root-only Admin Control Bearer Token 配置，再原子安装不含 HTTP Basic 的 Nginx 配置。
5. 通过公开 HTTPS Better Auth 路径注册 Demo 账号。该账号是部署脚本托管的固定演示管理员，脚本在受限数据库连接中将其邮箱状态幂等标记为已验证，再使用同一账号登录并交换 Hoox Session；普通用户仍必须通过 SMTP 验证码完成邮箱验证。随后查询其用户与个人 Tenant，将用户幂等提升为有效平台控制管理员和 Skill 发布管理员。发布脚本只在 `0600` 临时 curl 配置中保存本次验收使用的 Hoox access token。
6. 将实际管理员用户同时注入 API 与 Admin Control，将个人 Tenant 注入 Scheduler 与 Worker，并强制重建这些应用容器。API 以该用户 ID 作为 Demo 后台会话闸门。
7. 检查六个应用服务持续运行、用户端 readiness、后台 readiness、无需认证即可加载的后台静态页面、无会话后台 API 的 `401`，以及带管理员 Hoox 会话的后台概览 API，再切换 `/opt/hoox-demo/current`。只保留最近五个 release 目录。

## 验证

发布成功后至少检查：

```bash
curl --fail https://hoox.aisay.cc/
curl --fail https://hoox.aisay.cc/api/ready
curl --fail https://hoox.aisay.cc/admin/
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://hoox.aisay.cc/v1/admin/control/overview)" = "401"
docker compose --project-name hoox-demo \
  --env-file /opt/hoox-demo/shared/compose.env \
  -f /opt/hoox-demo/current/docker-compose.yml ps
```

未登录访问 `/admin/` 应成功加载静态页面并展示工作台登录提示；未携带 Hoox Bearer 的 `/v1/admin/` 必须返回 `401`。在同源工作台使用 Demo 管理员账号登录后，再打开 `/admin/`，后台应能读取概览、用户治理、配置和 Skill 发布页面。还应创建 Thread、触发一次 Run，并确认 Worker 能消费同一 Tenant 的 dispatch。账号密码保存在运维人员的受限凭据文件中，不得复制到 issue、PR、Actions 日志或本页。

## 失败与回滚

- 任一步失败时，远程脚本停止候选应用容器，并在存在上一 release 时恢复上一镜像和应用进程。上一 release 不含后台服务时，只恢复原有四个应用服务。
- Nginx 候选配置失败时恢复上一站点配置；Admin Control Token 文件继续留在 root-only 路径并由后续成功发布覆盖。旧版 htpasswd 可能为回滚到仍使用 HTTP Basic 的上一 release 而暂时保留，但现行配置不会引用它。
- 数据库迁移只向前执行，脚本绝不自动运行 down；若新迁移与旧镜像不兼容，必须停服并按该迁移的 ADR 和备份方案处理。
- PostgreSQL 和 MinIO 数据卷不随应用回滚删除。清理卷属于破坏性操作，不能作为普通发布恢复手段。
- 需要一次性舍弃 Demo 测试数据时，只能在 Compose 中把 PostgreSQL 与 MinIO 命名卷成对切换到同一个新数据 epoch。
  旧卷必须保留到候选 release 完成全部验收，以便失败时由上一 release 重新挂载；新版本稳定并处理外部 Sandbox 残留后，
  才可按确切卷名清理旧卷。发布脚本在候选和回滚时都必须显式强制重建 PostgreSQL 与 MinIO，不能依赖 Compose 自动
  识别顶层卷名变化；自动发布不得无条件执行 `down --volumes`。
- 首次发布没有上一版本可恢复；失败后数据库和对象存储可保留用于诊断，但公开应用进程必须保持停止，修正配置后重新发布。
