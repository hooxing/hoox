# ADR-0050：生产 API 的 JWT 身份、租户选择与受审网络装配

- 状态：已接受
- 日期：2026-07-29
- 决策者：M7 生产 API 安全审阅
- 关联任务：生产 API JWT 认证、TLS/反向代理边界与真实 PG/S3 装配
- 替代关系：细化 ADR-0015、ADR-0026 与 ADR-0049；不改变既有 PostgreSQL Membership/RLS 事实

## 背景

开发 API 使用 `Bearer dev-user-a|dev-user-b` 固定 fixture，并将用户与租户一起绑定在进程配置中。该机制只能用于
字面 loopback 开发服务，不能成为生产认证协议。生产 API 此前也没有可启动的真实依赖图：共享生命周期会拒绝普通
production assembler，以防调用方注入内存 Fake。

生产访问令牌只能可靠地证明认证主体，而当前 API 路径没有把租户编码在 URL。把租户写入 JWT 会令签发时的成员关系、
撤销和 RLS 事实滞后；反之，直接相信客户端 `X-Tenant-Id` 又会形成跨租户旁路。API 同时会向浏览器交付预签名对象 URL，
因此 TLS 终止、反向代理转发头和对象存储公开入口都必须有明确、可审计的信任边界。

## 决策驱动因素

- JWT 验签必须支持 HS256 密钥轮换，但不能暴露 kid、签名或密钥内容；
- production principal 只能来自已验签 `sub`，而非 token 里的租户、角色或其他附加声明；
- 租户选择必须继续由 PostgreSQL active Membership 与 RLS 作为授权权威；
- API 公开生产入口必须固定模块内真实依赖图，不能接收调用方 Fake；通用生命周期库不承担进程内 ACL；
- 明文 API listener、泛化 `trustProxy` 和明文预签名对象 URL 都必须失败关闭。

## 备选方案

### 方案 A：把 tenant 作为 JWT claim 并直接构造 TenantScope

调用方便，但成员撤销、团队变更或签发错误会在 token 有效期内绕过数据库当前事实；也会把租户授权语义分裂到 IdP
与 PostgreSQL 两处，因此不采用。

### 方案 B：JWT 只给 user principal，`X-Tenant-Id` 作为不可信 selector，由 Membership/RLS 复核

API 先验证 JWT 的 `sub`，再用 `{ tenantId: X-Tenant-Id, userId: sub }` 调用既有 Tenant Repository。Header 缺失、重复、
数组或格式非法为 400；Membership/RLS 未找到、跨租户或已撤销统一为 404。它保留多租户切换能力，并让数据库保持授权
权威。

### 方案 C：由反向代理注入可信租户 Header

会把 API 授权正确性转移到代理配置，且一旦直连路径或代理规则漂移便难以证明没有伪造 Header，因此不采用。

## 选择

采用方案 B，并在生产 API 中实施以下边界：

1. Bearer token 只接受紧凑三段、长度受限且每段规范 base64url 的 HS256 JWT。严格验证 `alg`、`kid`、`iss`、单值
   `aud`、`sub`、整数 `iat`/`nbf`/`exp`，拒绝重复 JSON 键；时间顺序固定为 `iat <= nbf < exp`。clock skew 只允许
   1–300 秒，`now >= exp + skew` 时拒绝，并拒绝超出未来 skew 的 `iat` 或 `nbf`。显式最大 token 生命周期只允许
   60–86400 秒，`exp-iat` 超过部署值即拒绝。
2. `API_JWT_SIGNING_KEYS` 是 `kid:base64url-key` 密钥环；kid 必须唯一，原始 HMAC key 为 32–64 字节。未知 kid 仍以
   随机拒绝密钥完成同长度 HMAC，并以 `timingSafeEqual` 比较，避免用主验签路径枚举轮换状态。
3. 验签成功只生成 `{ userId: sub }`。`X-Tenant-Id` 以单值快照传入服务层；它从不进入 JWT principal，也不覆盖开发
   fixture 的固定 tenant。Repository 读取及后续命令仍在 PostgreSQL Membership/RLS 下复核 active 状态。
4. `startApiProcess` 的 production 分支拒绝任意 `input.assembler`，固定选择模块内 production assembler。该
   装配图创建真实 PostgreSQL Runtime role 探针、S3 Bucket 探针、HS256 resolver、正式 Repository 和 Fastify listener。
5. `API_TLS_MODE=direct` 必须提供独立绝对 PEM 文件路径，在监听前读取、限制文件类型/大小并解析证书与私钥；
   `API_TLS_MODE=proxy` 必须绑定 `127.0.0.1` 或 `::1`，且只信任 `API_TRUSTED_PROXY_CIDRS` 中的规范字面 CIDR。两种
   模式不能混用。production S3 endpoint 与 public endpoint 均要求无 URL 凭据的 HTTPS。
6. production 环境出现任意 `DEV_AUTH_*`（包括 `DEV_AUTH_ENABLED=false`）即拒绝；不接收固定 A/B 身份。

## 理由

JWT 签名证明的是用户身份，不是当前成员资格。将 Header 降格为 selector 后，攻击者即使伪造其他租户 ID，也只能触发
数据库以该 `sub` 查询并由 RLS/active Membership 拒绝；外部统一 404 不泄漏成员或租户存在性。固定 JSON/编码/长度/
时间检查消除了多义 token 解析和资源放大路径，而 key ring 让旧 token 可在有限重叠窗口中完成密钥轮换。

TLS 直连和 loopback-only proxy 两种模式分别把加密端点与明文内部跳点界定为可审核配置。公开服务入口保持
`runtimeEnvironment: production` 并固定真实依赖图，因此不会把 development fixture、宽松 listener 或 Fake 带入生产。

## 影响

### 正面影响

- production API 可启动真实 PG/S3/HTTP 依赖图，并在 PostgreSQL、对象存储任一不可用时不报告 ready；
- 令牌密钥可按 kid 轮换，JWT 中的租户/角色附加 claim 不具备授权效果；
- 租户切换保持现有 API 路径形态，同时继续由数据库 Membership/RLS 二次授权；
- TLS、代理来源、运行角色、开发 fixture 和对象存储公开 URL 都在产生网络副作用前受限。

### 负面影响与成本

- 客户端必须在生产请求中携带单一、合法的 `X-Tenant-Id`；
- 部署必须提供 JWT key ring、issuer/audience、Runtime 数据库角色以及 direct TLS 或 loopback proxy 配置；
- 旧的明文 S3、开放 listener 或模糊 proxy 配置需要迁移后才能启动。

### 安全、数据与运维影响

- 不新增业务表或迁移；Membership/RLS 仍是租户授权的最终事实；
- TLS 私钥和 JWT key 仅作为秘密配置读取，错误、日志与测试断言不输出其原文；
- 运行角色校验是启动探针，不替代 ADR-0015 的数据库 ACL、NOINHERIT 和迁移角色隔离；
- Header selector 不是授权 grant，代理也不得替客户端伪造其值。

## 验证

- `production-auth.test.ts` 覆盖有效 HS256、错误 alg/kid/签名、规范 base64url、重复 JSON 键、重复 kid、`iss/aud/sub`
  与 `iat/nbf/exp` 类型/顺序、exp+skew 边界和不读取 tenant claim；
- `app.test.ts` 覆盖 production-style user-only principal 的缺失/畸形/重复 tenant selector、跨租户 selector 与 inactive
  Membership 均失败关闭；
- `production-transport.test.ts` 覆盖 direct TLS 路径、凭据读取失败、loopback proxy、规范 CIDR 与配置混用拒绝；
- `production-assembly.test.ts` 覆盖模块私有 assembler 装配真实 PG/S3、Runtime role、JWT/proxy 与开发 token 拒绝；
- `process-entry.test.ts` 覆盖生产 Fake 注入拒绝、DEV_AUTH 变量拒绝、JWT/对象存储/运行角色配置门禁；
- 部署 Gate 还必须以真实 TLS、Runtime role、PG 与 S3 对 `/ready` 执行验收，任何依赖失败不得报告 ready。

## 可逆性与回退

未对业务数据做新迁移。可停止生产 API 并回退到“production 不启动”的安全状态；不能通过恢复开发固定 token、信任 token
tenant claim、开放 listener 或移除 Membership/RLS 复核来回退。JWT key 轮换回退应保留旧 kid 至其最大 token 生命周期和
clock skew 已过，再从 key ring 移除。

## 后续工作

- 在部署模板中维护生产 API 环境变量与 TLS secret 挂载说明；
- 在真实反向代理环境验证 CIDR、`X-Forwarded-*` 与证书轮换流程；
- 随团队 Tenant 创建入口上线，补充多 Membership 选择、撤销传播与审计指标的端到端 Gate。

## 实施记录

- 2026-07-29：新增生产 HS256 JWT resolver、tenant selector/Membership 二次授权、固定 API assembler、TLS/proxy
  边界和相应单元测试。
- 2026-07-30：新增显式最大 token 生命周期；轮换或回退都必须在旧 token 最大寿命加 clock skew 后才能移除旧 kid。
