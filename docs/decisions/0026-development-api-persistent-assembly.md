# ADR-0026：开发 API 使用真实 PostgreSQL 的最小常驻装配

## 状态

已接受。

## 背景

HTTP API 已有协议和 PostgreSQL 适配器，但进程入口缺少可以在本机持续运行的装配。直接把测试 Fake 接到 listener 会让健康检查看似可用，却无法证明 RLS、事务和关闭顺序。另一方面，生产认证、部署网络和遥测尚未完成，不能把本机身份选择器包装成生产服务。

## 备选

1. 用内存 Repository 快速启动；操作简单，但与真实事务和 RLS 脱节。
2. 同时实现 development 与 production 装配；会在认证和部署边界未确定时过早固化生产行为。
3. 只实现 development 的真实 PG 最小装配，并让 production 继续 fail closed。

## 决策

选择方案 3。API 在 `RUNTIME_ENV=development` 且 `DEV_AUTH_ENABLED=true` 时，默认装配真实 PG Repository、原子 Thread/Run 创建端口、归档命令、HMAC 游标、固定开发身份和 Fastify TCP listener。production 不选择该装配，缺少受审装配器时仍拒绝启动。

固定开发 token 不具备生产认证能力，因此 listener 只接受字面值 `127.0.0.1`、`::1` 或 `localhost`（大小写不敏感）。`localhost` 在监听前规范化为 `127.0.0.1`，校验和监听都不执行 DNS 解析；通配地址、其他 `127/8` 地址、局域网地址或其他 hostname 全部拒绝，避免名称解析和主机配置变化把固定凭据暴露到非预期网络。进程配置和装配器各自失败关闭，防止绕过入口直接调用装配器。

A/B fixture 在 API 启动、身份初始化配置解析和实际 provision 前复用同一隔离约束：两者必须同时具有不同 `userId` 和不同 `tenantId`。任一维度重复都会在连接 listener 或写数据库之前失败，避免服务和初始化命令产生不同授权语义。

开发启动不会创建 Tenant、User 或 Membership。身份数据属于显式开发准备步骤，避免一次进程重启静默改写授权关系。健康语义区分 HTTP 存活与 PG 就绪；关闭顺序固定为停止并排空 HTTP，再关闭连接池。日志只输出稳定状态，不输出配置或底层驱动消息。

## 影响与验证

- 本地可以用 `pnpm dev:api` 观察真实 API；仍没有产品 Web UI。
- `.env.example` 和配置契约新增监听地址与端口。
- 单元测试覆盖 development/production 选择边界、端口校验、字面回环白名单、A/B 身份隔离和密钥环脱敏解析；现有 PostgreSQL M4 黑盒继续覆盖真实 API/RLS 行为。
- 未来生产装配可独立替换身份、网络和遥测，不需要兼容开发 token。

## 可逆性

开发装配由进程入口封闭选择，没有改变公开 HTTP 契约或数据库 Schema。可删除默认选择并恢复强制注入，不影响领域与持久层实现。
