# ADR-20260825145416：Demo 后台使用 Hoox 会话闸门

## 状态

已接受，2026-08-25。部分替代 [ADR-20260824222258](20260824222258-demo-admin-protected-same-origin-route.md) 中 HTTP Basic 入口保护、发布验收和相关运维契约；后台同源路由、回环监听、root-only Admin Control Token 与最小权限资源边界继续有效。

## 背景

HTTP Basic 能在免费单机 Demo 上快速保护后台，但浏览器会在加载任何页面内容前弹出原生认证挑战。Codex 内置浏览器等受控浏览器不能安全接管该挑战，导致后台无法用于自动化测试和演示。直接移除所有认证会让任何访问者调用平台控制与 Skill 发布接口；把 Admin Control development Token 交给前端同样会泄漏服务器级管理身份。

用户工作台已经通过 Better Auth 建立身份并交换为 Hoox 不透明会话，浏览器把该会话存放在同源 `hoox.auth-session.v2`。Demo 发布脚本也能确定唯一受限 Demo 管理员的 Hoox 用户 ID，因此可以复用现有会话而不新增第二套浏览器密码协议。

## 选择

1. `/admin/` 不再使用 HTTP Basic，允许浏览器加载后台静态资源。Admin Web 只在检测到未过期 Hoox access token 时进入管理界面；否则展示工作台登录提示。
2. Admin Web 调用 `/v1/admin/` 时携带当前 Hoox Bearer。该令牌只承担 Nginx 前置会话校验，不直接传给 Admin Control。
3. Demo API 新增仅在显式配置 `DEMO_ADMIN_USER_ID` 时存在的 `GET /v1/auth/demo-admin-access`。端点解析本地 Hoox 会话，并且只在会话用户 ID 与配置值完全相同时返回 `204`，其他情况返回 `401`。
4. Nginx 对 `/v1/admin/` 使用内部 `auth_request` 调用该端点，转发浏览器原始 `Authorization`。校验成功后，Nginx 再用 root-only include 覆盖上游 `Authorization` 为 Admin Control development Token。
5. 公开 Demo 必须配置合法 `DEMO_ADMIN_USER_ID`；production 和未开启公开 Demo 的 development 配置均拒绝该变量。Compose 先使用安全占位值启动首次 API，账号初始化完成后写入真实用户 ID，并强制重建 API、Admin Control、Admin Web、Scheduler 和 Worker。
6. 发布验收要求 `/admin/` 无认证可加载、无 Hoox 会话的后台 API 返回 `401`、Demo 管理员 Hoox 会话可以读取后台概览。临时验收 token 只保存在权限为 `0600` 的临时 curl 配置中，发布结束或失败时删除。

## 放弃的方案

- **完全公开后台 API**：适合一次性本地截图，不适合公网 Demo，任何人都能修改身份、模型、用户状态和 Skill 发布事实。
- **把 Admin Control Token 放进 localStorage 或静态构建**：会把服务器级管理凭据暴露给浏览器、缓存和网络记录。
- **保留 HTTP Basic 并让自动化浏览器注入凭据**：受控浏览器策略不保证支持原生认证挑战，也会继续形成独立于 Hoox 身份的第二套登录状态。
- **立即引入完整 production 管理 JWT**：安全属性更强，但超出单机测试演示范围；生产后台仍应遵循独立生产身份和发布契约。

## 影响

- Codex 内置浏览器可以直接打开 `/admin/`；未登录时看到可操作的工作台登录入口，不再被原生密码框阻断。
- 后台静态资源本身公开，但所有管理数据和写操作仍由 Hoox 会话用户 ID、Nginx 内部校验和 Admin Control Token 三段边界保护。前端会话提示不是安全边界，服务端 `auth_request` 才是放行依据。
- Demo 管理员账号一旦泄漏，攻击者可获得该演示环境后台权限；该主机只能承载测试数据，账号、Hoox Session 与 Admin Control Token 必须可轮换。
- 旧 htpasswd 文件可以暂时保留以兼容回滚到上一 release，但现行 Nginx 配置不再引用它。

## 验证

- Admin Web 单元测试覆盖会话解析、过期与损坏会话拒绝、登录提示，以及两个后台客户端携带 Hoox Bearer。
- API 单元测试覆盖 Demo 管理员会话返回 `204`，缺失会话和其他用户返回 `401`；进程配置测试覆盖必填、格式、Demo 开关依赖与 production 禁止。
- 部署契约测试覆盖无 HTTP Basic、内部 `auth_request`、root-only Token 覆盖、API 强制重建，以及无会话和管理员会话的发布验收。

## 可逆性

可以恢复上一版 Nginx 的 HTTP Basic 配置并停止向 API 注入 `DEMO_ADMIN_USER_ID`。回退不需要修改数据库管理员记录或 Admin Control Token；若完全撤销后台部署，继续按被部分替代 ADR 的可逆性说明移除后台服务和路由。
