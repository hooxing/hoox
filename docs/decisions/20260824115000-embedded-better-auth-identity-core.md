# ADR-20260824115000：在 Hoox 进程内嵌 Better Auth 身份核心

## 状态

已接受，2026-08-24。替代“为基础登录能力部署独立 Casdoor 服务”的方向；不改变当前生产 JWT 验证边界，后续接线必须通过新的行为 ADR 收口。

## 背景

Hoox 需要邮箱密码、Google、GitHub、微信、QQ 和手机号等注册登录方式，并希望由后台配置启用。为此额外运行身份服务会增加部署、数据库、升级和故障域成本；继续扩展自研密码与 OAuth 状态机又会重复承担协议安全工作。

## 选择

新增 `@hoox/identity` 边界包并固定 Better Auth `1.7.1`：

1. Better Auth 与 Hoox API 同进程运行，不增加常驻服务；
2. 支持邮箱密码、Google、GitHub、微信，以及通过 Generic OAuth 适配的 QQ；手机号能力通过 Phone Number 插件和可配置 HTTPS 短信 Webhook 接入；
3. Provider Secret 不进入公开配置，使用部署级 Better Auth Secret 经 HKDF 派生的 AES-256-GCM 密钥加密；
4. Provider 配置只允许固定身份源，短信 Webhook 拒绝明文、带凭据和明显本地地址，避免后台配置变成任意出网入口；
5. Better Auth 表名和核心字段映射到 Hoox 的 snake_case 数据库约定，OAuth Token 启用框架内置加密；
6. 当前提交只建立可测试的身份核心与配置安全边界。数据库迁移、后台配置 API/UI、现有账号映射和生产装配在同一功能分支继续完成，完成前不得合并。

## 影响

- 不再需要 Casdoor 容器或其管理面；
- 新增 MIT 许可的 Better Auth 运行依赖；
- 部署最终只需保留一个至少 32 字节的 Better Auth Secret 作为不可在后台修改的根秘密；
- QQ 使用服务端固定端点和适配逻辑，微信使用 Better Auth 内置 Website App Provider；
- 本 ADR 尚不声明用户可见登录方式已经切换。

## 验证

- 单元测试覆盖默认关闭外部 Provider、秘密保留与替换、配置完整性、AES-GCM 往返和短信 Webhook 边界；
- `@hoox/identity` 已执行 typecheck、测试和构建。

## 可逆性

在尚未写入 Better Auth 数据前可删除该包和依赖。完成数据库接线后，回退必须先停止新身份写入，并由后续行为 ADR 定义账号与 Session 的迁移策略。
