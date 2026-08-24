# ADR-20260824125500：内嵌身份会话交换与后台配置边界

## 状态

已接受，2026-08-24。完成 [ADR-20260824115000](20260824115000-embedded-better-auth-identity-core.md) 预留的数据库、管理面、账号映射和生产接线；替代 [ADR-20260816165004](20260816165004-development-local-account-authentication.md) 关于用户可见邮箱注册登录入口的结论，固定开发身份仍保留。

## 背景

Better Auth 身份核心只有在不增加独立服务、能够安全持久化配置、映射 Hoox 用户并签发既有 Runtime 会话后，才能替代开发期本地账号入口。后台配置同时包含 Provider Secret 和短信 Webhook Secret，不能回显或以明文进入审计、协议和浏览器状态。Hoox 的 Tenant、Membership 和业务授权仍依赖现有会话与 PostgreSQL RLS，不能让第三方 Cookie 直接成为业务授权事实。

## 选择

1. Better Auth 与 API 共进程并复用 PostgreSQL，迁移固定其 User、Session、Account、Verification 和 Rate Limit 表；Runtime 身份边界拥有这些表，其他业务进程不获得访问权。
2. Better Auth 登录成功后，`POST /v1/auth/exchange` 验证其同源 Cookie Session，再按 Better Auth User ID 或规范化邮箱映射 `user_accounts`。已有邮箱账号原子绑定，新身份原子创建 User、个人 Tenant、owner Membership，并签发 Hoox 不透明会话令牌。
3. 浏览器业务请求继续使用 Hoox 会话令牌。Better Auth Cookie 只用于身份建立和 OAuth 回调恢复；TenantScope 仍由 Hoox User、Membership 与 RLS 重建。
4. production 不暴露旧 `/v1/auth/register` 和 `/v1/auth/login`；development 明确保留它们作为兼容与测试入口。生产 JWT 解析器继续作为非浏览器调用方的兼容后备，不替代内嵌身份入口。
5. Admin Control 提供版本化身份配置读写。写操作要求管理员身份、幂等键、请求摘要、期望版本和变更原因；Provider 与短信秘密使用部署级 `BETTER_AUTH_SECRET` 派生的 AES-256-GCM 密钥加密，响应只返回 `secretConfigured`。
6. 配置按版本动态加载，保存后无需重启 API。可启用邮箱密码与注册、手机号短信验证码、Google、GitHub、微信和 QQ；“允许新用户注册”同时约束邮箱、OAuth 和手机号隐式注册，关闭后所有入口只能登录既有身份；外部 Provider 未同时具备 Client ID 与 Secret 时拒绝启用。
7. 禁用 Hoox 用户时同时删除 Hoox Session 和对应 Better Auth Session。回退迁移检测到身份、映射、配置、命令或审计事实后失败关闭。
8. Better Auth 1.7.1 的框架、ORM、Telemetry 与 Vitest optional peer 默认会从 workspace 根被解析。Hoox 通过受版本约束的 `.pnpmfile.cjs` 只保留实际使用的 PostgreSQL peer，并在供应链生成器中排除已经由 workspace/vendor 组件建模的注入式 `file:` 包，避免生产 deploy 携带 React、Vitest、Vite 和宿主平台 CSS 工具链。

## 影响

- 部署不增加 Casdoor 或其他常驻身份服务；API 与 Admin Control 必须注入同一个至少 32 字节的 `BETTER_AUTH_SECRET`。
- Provider Secret、OAuth Token 和短信秘密不会进入公开配置、浏览器响应或普通日志。
- OAuth Provider 的控制台仍需配置指向 Hoox 对外 origin 的 Better Auth 回调地址；是否启用由 Hoox 管理界面控制。
- `BETTER_AUTH_TRUSTED_ORIGINS` 接受逗号分隔的无凭据 HTTPS origin；生产配置契约拒绝路径、查询、片段、明文 HTTP 或空项。
- 按邮箱绑定让已有账号可以在首次完成 Better Auth 身份验证后保留原 User、Tenant 和数据；不同 Better Auth 身份争用同一邮箱时失败关闭。

## 验证

- 单元和契约测试覆盖身份配置归一化、加密、框架 Schema、迁移/RLS、管理 API、管理 Web、账号映射、进程配置、生产 origin 校验和生产依赖闭包。
- 在隔离 PostgreSQL 数据库中执行 1–55 全量迁移，并验证 Better Auth 邮箱注册、Cookie Session、Hoox 账号映射、会话交换，以及 Admin Control 配置加密写入和动态读取。

## 可逆性

尚无身份事实时可执行 0055 down 并恢复旧账号列约束。存在 Better Auth User、账号映射、身份配置、幂等命令或审计时禁止自动回退；必须先停止新登录、导出并制定显式迁移方案，不能删除表来“恢复”。
