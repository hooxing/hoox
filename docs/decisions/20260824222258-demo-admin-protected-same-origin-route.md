# ADR-20260824222258：Demo 后台使用同源受保护路由

## 状态

已接受，2026-08-24；HTTP Basic 入口保护、发布验收和相关运维契约已于 2026-08-25 被 [ADR-20260825145416](20260825145416-demo-admin-uses-hoox-session-gate.md) 部分替代。补充 [ADR-20260824163556](20260824163556-single-node-demo-continuous-deployment.md) 的单机 Demo 拓扑，不改变生产后台身份、TLS 与发布契约。

## 背景

单机 Demo 已持续部署用户 Web、API、Scheduler 与 Worker，但后台 Web 和统一 Admin Control API 仍只存在于源码和本地开发环境。直接把 development Admin Control Token 编入 Vite 静态资源会向任何访问者公开平台管理身份；直接开放 3003 端口也会绕过宿主机 TLS 与入口控制。另一方面，为演示环境新增独立管理域名、证书和生产 JWT 签发链会显著增加免费单机的配置面，并把 Demo 误装配为生产边界。

Admin Control 已按照 [ADR-20260821115221](20260821115221-unified-admin-api-process.md) 合并控制面和 Skill 发布路由，但进程内部仍要求两个最小权限 PostgreSQL 角色与 Skill Publisher S3 凭据。部署需要保持这种资源隔离，同时让浏览器只看到一个同源后台入口。

## 选择

1. Admin Web 以 Vite base `/admin/` 构建，使用 Router basename 支持深层路由；同一 Demo 镜像同时包含用户端、后台端和统一 Admin Control API。
2. Admin Web 与 Admin Control 只监听宿主机回环地址 `127.0.0.1:4174` 和 `127.0.0.1:3003`，不直接发布容器或云防火墙端口。
3. Nginx 在现有 HTTPS 域名下提供 `/admin/` 与 `/v1/admin/`。两组路径都要求 HTTP Basic；用户名和密码复用受限 Demo 账号，仅用于测试和演示入口保护。
4. 浏览器请求后台 API 时不携带 Admin Control development Token。Nginx 从 `/etc/nginx/hoox-demo-admin-token.conf` 覆盖上游 `Authorization`，该文件由 root 拥有并设为 `0600`；Basic 密码散列文件由 root 拥有、Nginx 组只读。
5. 目标主机单独保存 `admin-control.env`，其中 Admin Control 与 Skill Publisher 使用各自数据库连接，Skill Publisher 使用其 S3 用户，`BETTER_AUTH_SECRET` 与用户 API 一致。真实值不得进入镜像、仓库或 Actions 日志。
6. 每次发布在 Better Auth 登录和 Session 交换后查询 Demo 用户 ID，将该用户幂等写入 `platform_control_operators` 与 `platform_skill_operators` 为有效管理员，再通过 Compose 注入 `DEV_ADMIN_CONTROL_USER_ID`。个人 Tenant 仍独立注入 Scheduler 与 Worker。
7. 发布成功必须同时验证六个应用容器、本机 Admin Control readiness、带 Basic 凭据的后台页面和后台概览 API。回滚检测上一 Compose 是否包含后台服务，以兼容启用后台前的 release。

## 放弃的方案

- **把 development Token 注入前端构建**：静态 JavaScript、浏览器网络记录和缓存都会泄漏平台管理凭据。
- **公网暴露 3003 并让浏览器直连**：绕过现有 TLS 与 Nginx，且 development Token 成为唯一公网身份边界。
- **为 Demo 建立生产 JWT、独立管理域名和证书**：安全边界更接近生产，但超出测试演示目标，并会让单机 development 装配看起来具备不存在的生产保证。
- **只保护后台页面，不保护后台 API**：访问者可以绕过 UI 直接调用管理接口，入口控制不完整。
- **继续不部署后台**：无法演示当前统一管理页面、用户治理、配置和 Skill 发布能力。

## 影响

- Demo 可以从同一域名演示完整后台，后台 Token 不进入浏览器或镜像；数据库与对象存储最小权限边界保持不变。
- HTTP Basic 与 development Token 是演示环境的叠加保护，不是生产级身份方案。Demo 账号泄漏后，攻击者可进入后台入口；应轮换账号密码和 Admin Control Token，并限制该服务器仅承载测试数据。
- Nginx reload 现在依赖 root-only Token include 与 htpasswd 文件。部署用户的 sudo 权限和这些文件的所有权、模式成为发布契约的一部分。
- Admin Control readiness 同时依赖 Control PG、Publisher PG 与 S3；任一后台依赖失败会使后台整体发布失败，但不自动回退数据库迁移。

## 验证

- Admin Web 单元测试覆盖根路径与 `/admin/` basename 转换以及非法 base 拒绝。
- Demo 部署契约测试覆盖镜像构建、两个后台服务、同源 Nginx 路由、双路径 Basic 保护、root-only Token、管理员幂等初始化、六服务验收和旧 release 回滚兼容。
- 目标环境验收未认证后台请求返回 `401`，带 Demo Basic 凭据的 `/admin/` 与 `/v1/admin/control/overview` 返回成功，且 Admin Control 和 Admin Web 容器持续运行。

## 可逆性

可从 Compose、镜像构建和 Nginx 模板移除 Admin Control 与 Admin Web，并删除服务器上的 `admin-control.env`、htpasswd 与 Token include。撤销后台部署不需要删除数据库表、管理员记录或 Skill 对象；若要撤销管理员身份，应单独将 `platform_control_operators` 记录停用或删除。回退到旧 release 时脚本不会尝试启动旧 Compose 中不存在的后台服务。
