# 配置参考

Hoox 对配置采用“声明键、严格解析、失败关闭”的原则。development 和 production 使用不同契约；示例文件只允许明显占位值。

## 配置文件

| 文件 | 用途 | 是否可直接上线 |
| --- | --- | --- |
| `.env.example` | 完整 development 配置契约 | 否，只能复制为本机 `.env` 后填写 |
| `.env` | 开发者本机真实配置 | 不得提交 |
| `deploy/production.env.example` | API、Scheduler、Worker 和统一 Admin API 的 production 字段合集 | 否，必须由部署平台按服务拆分注入 |
| `docker-compose.dev.yml` | 只管理 development MinIO | 否，不包含完整 Runtime |

配置校验脚本分别读取 `scripts/env-contract.mjs` 和 `scripts/production-env-contract.mjs`。新增、删除或重命名变量时，示例和契约必须同步更新。

## Development 配置分组

`.env.example` 包含完整开发链路，不表示每个进程都应读取全部变量。

### PostgreSQL

- Runtime、迁移器、Worker Coordinator、Team Coordinator、Admin Control 和 Skill Publisher 使用不同连接或角色。
- `DATABASE_URL` 面向本机 Runtime 进程；Docker 内访问使用单独 endpoint。
- bootstrap 和 migration 连接只用于初始化，不能注入普通 API、Worker 或 Scheduler。
- 只对专用开发数据库执行角色 bootstrap、迁移和黑盒测试。

### API 与身份

- `RUNTIME_ENV=development` 才允许启用开发身份。
- API development 监听必须保持在字面回环地址。
- 固定 `dev-user-a` / `dev-user-b` 只用于隔离夹具。
- Web 默认使用 API 进程内嵌的 Better Auth；development 可以显式保留旧本地账号端点和固定身份夹具。
- `BETTER_AUTH_SECRET` 至少 32 字节，API 与 Admin Control 必须使用同值；它不能进入后台配置、Git 或日志。
- `BETTER_AUTH_TRUSTED_ORIGINS` 是允许发起身份请求的逗号分隔 origin 列表；production 至少包含 Web 对外 origin。
- 游标签名、ResourceFS 签名等密钥必须使用本机随机值，不能复用示例占位符。

### 对象存储

- 本地 MinIO 由 Compose 管理，默认宿主端口为 `19000`，控制台为 `19001`。
- API/Worker 使用的 S3 凭据与 Skill Publisher 凭据必须分离。
- 面向浏览器的 `S3_PUBLIC_ENDPOINT` 必须和 API/Web origin 隔离。
- 不要执行 `docker compose down -v`，除非明确要删除本地 MinIO 数据。

### Sandbox Provider

- `SANDBOX_DEFAULT_PROVIDER` 指定默认 Provider。
- `SANDBOX_ENABLED_PROVIDERS` 声明可用 Provider 集合。
- CubeSandbox 和 E2B 各自需要独立 endpoint、凭据和模板。
- Scheduler 只获得生命周期管理所需字段；Worker 才获得执行所需字段。
- Sandbox 内不得注入宿主机数据库、S3、模型或管理面通用凭据。

### 模型与上下文

- `MODEL_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_ID` 定义没有 active 后台配置时的兼容回退模型。
- 日常 Provider 密钥在后台模型页面写入并按 Revision 加密托管；`MODEL_CREDENTIAL_ENCRYPTION_KEY` 是 Admin API 与 Worker 共享的稳定加密根，production 至少 32 字节且不能用于调用模型。
- Context window、最大输出和图片能力是显式可信配置，不能只依赖模型名称猜测。
- Thread Context、Compaction、Sandbox 复用和 Subagent 功能使用独立 feature flag。
- 标题生成可以使用独立低成本模型，且只接收受限输入。

### Scheduler 与 Worker

- development Scheduler 和 Worker 都按明确 Tenant 分片。
- Worker ID、轮询、Dispatch lease、Run lease 和超时必须符合测试覆盖的范围。
- Scheduler 的清理 lease 和轮询不能被配置为绕过 Tenant/RLS 扫描。

### 后台管理

- 统一 Admin API 默认监听 `127.0.0.1:3003`，模型、记忆、身份、配置、统计与 Skill 路由共用管理身份。
- “身份与登录”配置保存后按版本动态生效；Provider 与短信秘密只返回已配置状态，不回显明文。
- 模型 Provider 的 API Key 是写入型字段：首次配置必填，编辑时可保留旧密钥或替换；探测和新 Run 都使用目标 Revision 绑定的密钥。
- 进程内仍使用 Admin Control 与 Skill Publisher 两套数据库连接和角色，Skill Publisher 对象存储凭据不能复用普通 API/Worker 身份。
- 开发发布 fixture 不等于生产 Skill 目录。
- vendored Anthropic PPTX Skill 仅用于本地 development 测试，受其专有许可证约束。

### 诊断

- 模型报文诊断默认关闭，因为请求和响应可能包含用户内容。
- 轨迹和报文目录只允许写入被 Git 忽略的本地路径。
- 保留天数和单条大小必须显式限制。

## Production 秘密矩阵

production 示例是字段合集，不是共享 env 文件。部署平台应至少按下表分片：

| 服务 | 必需类别 | 不应获得 |
| --- | --- | --- |
| API | PostgreSQL、Better Auth 根秘密、JWT 兼容身份、S3 下载签名、TLS/公开 origin | 模型密钥、Sandbox 执行密钥、MinIO root、迁移器凭据 |
| Scheduler | PostgreSQL、Sandbox 生命周期、标题模型（启用时） | S3 读写密钥、主模型密钥、API JWT 私钥 |
| Agent Worker | PostgreSQL、S3、Sandbox、主模型 | API 身份签名私钥、Admin 管理凭据 |
| Admin API | 独立管理身份、Admin Control PG、与 API 同值的 Better Auth 根秘密、Skill Publisher PG 与发布对象存储凭据 | 普通 Runtime 的其他全量秘密 |

生产进程拒绝 development 变量、环境代理、危险 `NODE_*` 和 OpenSSL 配置覆盖；私有 CA 只能通过明确允许的通道注入。

## 初始化顺序

1. 从 `.env.example` 创建不提交的 `.env`。
2. 准备专用 PostgreSQL 数据库和最小权限角色。
3. 启动 MinIO，并准备 Sandbox 与模型服务。
4. 加载本机环境变量。
5. 执行数据库迁移。
6. 显式初始化 development 身份。
7. 执行 Worker 外部依赖预检。
8. 启动核心 Runtime。

具体命令见[开发指南](../development.md)。

## 安全检查

```powershell
corepack pnpm config:check
corepack pnpm config:check:production
```

配置错误只能输出变量名和稳定分类，不得输出值。提交前确认 `git status` 中没有 `.env`、证书、私钥、报文轨迹、数据库导出或对象存储数据。
