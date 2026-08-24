# ADR-20260824163556：单机 Demo 使用受控 development 装配持续部署

## 状态

已接受，2026-08-24。仅适用于测试与演示环境，不改变生产发布契约。

## 背景

Hoox 需要在一台 ARM64 免费云主机上持续部署，用于验证邮箱登录、Thread、Run、Scheduler、Worker、Sandbox 和 Artifact 交付。现有 production 镜像和配置 Gate 假设独立对象 origin、生产 JWT/TLS、目标基础设施验收与严格进程拆分；为了单机演示而放宽这些生产约束，会让静态 Gate 给出错误保证。另一方面，直接暴露 development 固定 token、API 监听或 MinIO 端口会把本地测试便利扩展成公网身份绕过。

## 选择

1. 新增明确命名的 Demo 镜像、Compose 和 CD 工作流，不复用或修改三个 production gate 镜像。工作流只在 `main` 的既有 CI 成功后自动运行，镜像由 GitHub Actions 构建为 ARM64 并以 GHCR digest 发布。
2. 单机持久化 PostgreSQL 与 MinIO，分别只绑定宿主机回环端口；API、Web、Scheduler 和 Worker 使用同一应用镜像，容器使用只读 root filesystem、独立 `/tmp`、非 root UID、`no-new-privileges` 和 capability drop。
3. 宿主机 Nginx 保留既有站点，在 `hoox.aisay.cc` 新增 80/443 server。`/api/` 转发回环 API，`/agent-runtime-demo/` 转发回环 MinIO，其余路径转发回环 Web；TLS 由 Certbot 管理。
4. Demo API 仍使用 development 装配，但新增显式 `DEMO_PUBLIC_ACCESS_ENABLED` 与 `DEMO_PUBLIC_ORIGIN` 边界。公开 Demo 必须关闭固定开发身份，API 必须绑定字面回环地址，公开 origin、可信 origin 和对象公开端点必须使用 HTTPS，Demo origin 必须属于可信 origin。production 出现任何 Demo 变量都失败关闭。
5. 公开 Demo 不暴露旧本地密码注册登录路由。部署脚本通过公开 HTTPS Better Auth 邮箱路径初始化 Demo 身份，再交换 Hoox Session，使浏览器演示与实际身份路径一致。
6. 发布先执行只向前迁移，再切换应用。失败时只恢复上一应用镜像，不自动执行数据库 down，也不删除 PostgreSQL 或 MinIO volume。

## 放弃的方案

- **直接使用 production 部署契约**：单域名路径代理对象正文与单机依赖不满足生产对象 origin、网络和验收边界，不能伪装成生产就绪。
- **公网开放 development 固定 token 或 `0.0.0.0:3001`**：无需真实认证即可获得固定 Tenant 身份，风险不可接受。
- **目标主机从分支现场构建**：无法保证构建来源与 CI 提交一致，也不能稳定记录不可变镜像 digest。
- **失败时自动回滚迁移**：down 可能破坏已写入的新事实，且旧镜像兼容性不能由脚本推断。

## 影响

- Demo 可以低成本持续展示完整应用路径，但其单节点、同域对象代理、development 装配和本地持久卷均不构成生产证据。
- 新增的 Demo 环境变量属于受控开发配置；根 `.env.example` 默认关闭能力，服务器配置才提供真实公开 origin。
- GitHub 需要持有部署 SSH 秘密，目标用户需要 Docker socket 权限与受限 sudo Nginx 权限；known-hosts 必须在配置 Secrets 前核对。
- 初次发布仍需要人工完成主机目录、秘密文件、Nginx include 和 ACME 证书 bootstrap。

## 验证

- API 单元测试覆盖 Demo 与固定开发身份互斥、回环监听、HTTPS origin、可信 origin、对象端点和 production 禁止项。
- 部署契约测试覆盖绿色 CI 触发、Action commit 固定、digest 发布、回环端口、只读容器、Nginx 路由和无自动 migration down。
- 目标环境通过首页、外部 readiness、容器运行状态、Better Auth 登录和一次真实 Run 验收。

## 可逆性

删除 Demo 工作流和部署目录、停止 `hoox-demo` Compose 项目并移除对应 Nginx server 即可撤销应用层部署。保留数据时不得删除 volume；需要销毁数据时必须单独确认并备份。新增 API 配置边界可由后续 ADR 替代，但不得恢复公网固定开发身份。
