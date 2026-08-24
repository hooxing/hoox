# 身份、账号与会话

本文面向接入登录方式、维护账号映射、配置 OAuth/SMS 或排查会话问题的开发与运维人员，描述 Hoox 当前身份边界。

## 运行关系

```mermaid
flowchart LR
    Browser[Web] --> Auth[API 内嵌 Better Auth]
    Auth --> IdentityTables[(Better Auth 表)]
    Browser --> Exchange[Hoox Session Exchange]
    Exchange --> Accounts[(User / Tenant / Membership)]
    Exchange --> Sessions[(Hoox Sessions)]
    Admin[Admin Control] --> Config[(加密身份配置)]
    Config --> Auth
```

Better Auth 与 Hoox API 同进程运行，不需要独立身份服务。它负责邮箱密码、OAuth 和手机号验证码协议；Hoox 负责账号、Tenant、Membership、业务会话和最终授权。Better Auth Cookie 不能直接访问业务路由。

## 登录和账号映射

1. Web 读取 `GET /v1/auth/config`，只展示后台已启用的登录方式。“允许新用户注册”是全局开关：关闭后邮箱、OAuth 和手机号都不能隐式创建 Better Auth User。
2. 邮箱、OAuth 或手机号流程进入 `/api/auth/*`，成功后获得同源 Better Auth Cookie Session。
3. Web 调用 `POST /v1/auth/exchange`。API 验证 Cookie 中的 Better Auth Session，再按 `better_auth_user_id` 或规范化邮箱查找 Hoox 账号。
4. 已有邮箱账号绑定 Better Auth User ID 并保留原 User、个人 Tenant、Membership 和数据；新身份原子创建这些事实。
5. API 返回 Hoox 不透明会话令牌。后续业务请求继续使用 `Authorization: Bearer <Hoox session>`，并由 Membership 与 RLS 重建 TenantScope。

同一 Hoox 账号不能绑定两个不同 Better Auth User ID。账号被禁用时，两类 Session 都被删除；旧令牌不能继续访问业务数据。

## 可配置登录方式

管理台“身份与登录”页面按基础访问策略、短信服务连接和第三方身份源分区展示，并可以立即启用或关闭：

- 邮箱密码登录和新用户注册；
- Google；
- GitHub；
- 微信 Website App；
- QQ Generic OAuth；
- E.164 格式手机号和 HTTPS 短信 Webhook 验证码。

外部 Provider 只有在 Client ID 与 Client Secret 都已配置时才能启用。短信登录要求公网 HTTPS Webhook；明显的本地、私网、带凭据或带 fragment 地址会被拒绝。秘密输入留空表示保留现值，管理 API 只返回是否已配置。

## 配置与秘密

`BETTER_AUTH_SECRET` 是部署级根秘密，API 与 Admin Control 必须使用相同值且至少 32 字节。它同时用于 Better Auth 会话签名和身份配置秘密加密，不能通过管理界面修改、不能进入 Git，也不能跨环境复用。

身份配置使用版本号、期望版本、幂等键和审计原因写入。Provider Secret 与短信 Webhook Secret 以 AES-256-GCM 密文持久化；OAuth Token 使用 Better Auth 的加密能力。配置按版本动态加载，保存后不需要重启 API。

## 兼容边界

production Web 使用内嵌身份入口，旧 `/v1/auth/register` 和 `/v1/auth/login` 不对外注册。development 可以显式保留旧本地账号端点和固定开发身份，用于夹具与兼容测试。生产 JWT 验证仍作为非浏览器调用方的后备，但不会绕过 Hoox 的 User、Membership 和 RLS 授权。
