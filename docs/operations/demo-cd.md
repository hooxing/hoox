# Demo 单机持续部署

本页供维护者在受控演示环境发布 Hoox。该路径用于功能测试和演示，不是生产发布替代品；生产上线仍必须遵守[生产就绪说明](production-readiness.md)和[生产发布清单](../../deploy/production-release-checklist.md)。

## 当前拓扑

- GitHub Actions 只在 `main` 的“持续集成”成功后自动构建 `linux/arm64` 镜像，也允许维护者手工选择 ref。
- 镜像推送到 GHCR，并以不可变 digest 交给目标主机；目标主机不从 Git 仓库现场构建。
- 单机 Docker Compose 运行 PostgreSQL、MinIO、API、Web、Scheduler 和 Worker。PostgreSQL 与 MinIO 端口只绑定宿主机回环地址。
- API 与 Web 使用 host network，但分别只监听 `127.0.0.1:3001` 和 `127.0.0.1:4173`。宿主机 Nginx 在 `hoox.aisay.cc` 提供 TLS，`/api/` 转发 API，`/agent-runtime-demo/` 转发 Demo 对象桶，其余路径转发 Web。
- Demo 使用 development 装配以复用单机入口，但必须同时设置 `DEMO_PUBLIC_ACCESS_ENABLED=true`、`DEMO_PUBLIC_ORIGIN=https://hoox.aisay.cc` 和 `DEV_AUTH_ENABLED=false`。固定开发身份、明文 origin 和非回环 API 监听都会在解析期失败。

## 首次主机准备

目标主机必须预装 Docker Engine、Docker Compose、Nginx 和 Certbot。部署用户必须可直接访问 Docker socket，并可无密码执行 `nginx -t`、安装 Nginx 配置和 reload。

1. 创建 `/opt/hoox-demo/releases` 与 `/opt/hoox-demo/shared`，归部署用户所有；`shared` 权限设为 `0700`。
2. 确认 Nginx 的 `http` 块包含 `include /etc/nginx/conf.d/*.conf;`，不得删除同机既有 server block。
3. 创建 `/var/www/letsencrypt`，先用仅监听 80 的临时 server block 完成 ACME HTTP-01，再为 `hoox.aisay.cc` 签发证书。
4. 在 GitHub `demo` Environment 或仓库 Actions Secrets 中配置：
   - `DEMO_SSH_HOST`：目标主机；
   - `DEMO_SSH_USER`：部署用户；
   - `DEMO_SSH_PRIVATE_KEY`：部署专用私钥；
   - `DEMO_SSH_KNOWN_HOSTS`：经人工核对指纹后的完整 known-hosts 行。
5. 在 `/opt/hoox-demo/shared` 创建 `infra.env`、`migration.env`、`api.env`、`scheduler.env`、`worker.env` 和 `demo-account.env`，全部设为 `0600`。真实密码、连接串和 Provider Key 只能存在于目标主机秘密文件或 GitHub Secrets，不得进入仓库和发布日志。

`deploy/demo/*.env.example` 只说明字段归属，不能直接作为凭据文件。API、Scheduler 和 Worker 必须各自只获得其进程需要的配置；MinIO root 与 PostgreSQL bootstrap 密码不得注入应用容器。

## 发布顺序

`.github/workflows/cd-demo.yml` 执行以下步骤：

1. 检出通过 CI 的实际提交，使用固定 commit 的 GitHub Action 构建 ARM64 镜像并推送 GHCR。
2. 上传 `deploy/demo` 中的 Compose、初始化、Nginx 和远程发布契约到新的 release 目录。
3. 目标主机拉取 digest，启动 PostgreSQL 与 MinIO，幂等创建对象桶，再执行只向前的数据库迁移。
4. 启动 API 与 Web，验证本机探针后原子安装 Nginx 配置。
5. 通过公开 HTTPS Better Auth 路径注册或登录 Demo 账号，交换 Hoox Session，并把其个人 Tenant 注入 Scheduler 与 Worker。
6. 检查四个应用服务持续运行及内外 readiness，再切换 `/opt/hoox-demo/current`。只保留最近五个 release 目录。

## 验证

发布成功后至少检查：

```bash
curl --fail https://hoox.aisay.cc/
curl --fail https://hoox.aisay.cc/api/ready
docker compose --project-name hoox-demo \
  --env-file /opt/hoox-demo/shared/compose.env \
  -f /opt/hoox-demo/current/docker-compose.yml ps
```

还应使用 Demo 账号完成邮箱登录、创建 Thread、触发一次 Run，并确认 Worker 能消费同一 Tenant 的 dispatch。账号密码保存在运维人员的受限凭据文件中，不得复制到 issue、PR、Actions 日志或本页。

## 失败与回滚

- 任一步失败时，远程脚本停止候选应用容器，并在存在上一 release 时恢复上一镜像和应用进程。
- 数据库迁移只向前执行，脚本绝不自动运行 down；若新迁移与旧镜像不兼容，必须停服并按该迁移的 ADR 和备份方案处理。
- PostgreSQL 和 MinIO 数据卷不随应用回滚删除。清理卷属于破坏性操作，不能作为普通发布恢复手段。
- 首次发布没有上一版本可恢复；失败后数据库和对象存储可保留用于诊断，但公开应用进程必须保持停止，修正配置后重新发布。
