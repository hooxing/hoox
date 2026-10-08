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

- `MODEL_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_ID` 定义没有 active 后台配置时的兼容回退模型。Worker 启动、预检与 readiness 探测当前已发布的后台模型；只有尚未发布模型时才探测部署回退。读取或解密已发布凭据失败时失败关闭，不使用旧部署凭据掩盖故障。
- 日常 Provider 密钥在后台模型页面写入；“保存并使用”由服务端一次原子保存并启用，列表中的“使用”切换已保存供应商。已有托管模型快照继续固定旧 Run 的配置与密钥，新配置只影响之后首次建立模型配置快照的 Run。`MODEL_CREDENTIAL_ENCRYPTION_KEY` 是 Admin API 与 Worker 共享的稳定加密根，production 至少 32 字节且不能用于调用模型。
- 后台“运行设置”可选工具调用模式：`native`（正常、默认）或 `ptc`（实验）。模式在 Worker 首次建立 Run 配置快照时固定，已有快照及该 Run 的子 Agent/恢复不受切换影响；缺字段的旧配置使用正常模式。PTC 的执行、审计和限制见[工具调用模式](../architecture/tool-calling-modes.md)。
- 后台工具选择使用 `enabledTools`：省略代表旧配置全启用，显式 `[]` 关闭全部业务工具；保存页面勾选会固定名单，新增工具需主动选择。工具选择与模式共享 Run 快照和保存审计，正常/PTC 及子 Agent 都遵守；不立即影响已有快照，不取消已创建的定时任务。保留 `exec_command` 时命令仍可读写文件，开关不能替代沙箱隔离。框架编排和展示机制不属于业务开关。
- Context window、最大输出和图片能力是显式可信配置，不能只依赖模型名称猜测。
- Thread Context、Compaction、Sandbox 复用和 Subagent 功能使用独立 feature flag。
- 新 Run 的压缩参数优先采用后台“运行设置”，未保存时使用 Worker 部署回退。部署字段分别为 `THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT`（默认 `80`）、`THREAD_CONTEXT_COMPACTION_TARGET_PERCENT`（默认 `55`）、`THREAD_CONTEXT_COMPACTION_RECENT_USER_TOKENS`（默认 `4096`）、`THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS`（省略时使用部署 `MODEL_MAX_OUTPUT_TOKENS`）、`THREAD_CONTEXT_COMPACTION_TIMEOUT_MS`（默认 `60000`）。示例文件的显式值是部署样例，不改变省略时的解析默认值。
- 压缩五项参数形成独立持久快照，执行输出预算按实际模型最大输出裁剪；恢复不改写原快照。部署回退输出预算在首次存储前也按当时模型上限裁剪。恢复和旧 Run 兼容边界见[Thread 连续上下文](../architecture/thread-continuity.md)。
- 首次运行快照固定是否使用托管模型与记忆，包括尚未配置的状态；后台新增配置不会改变已有空配置快照。部署回退模型的具体参数仍来自 `MODEL_*`，修改这些环境变量仍需重启，并应排空使用部署回退的在途 Run。升级前尚未建立快照的旧 Run 无法还原原部署状态。
- 标题生成可以使用独立低成本模型，且只接收受限输入。

### Scheduler 与 Worker

- Scheduler 仍按明确 Tenant 分片；Agent Worker 通过动态 Tenant assignment 发现可执行 Run，并始终在具体 Tenant RLS 中读取业务事实。
- `AGENT_WORKER_MAX_CONCURRENT_RUNS` 控制单 Worker 在途 Run 上限，默认 `20`；`AGENT_WORKER_USER_MAX_CONCURRENT_RUNS_PER_TENANT` 控制同一 Tenant 内单用户上限，默认 `2`。两者范围均为 `1..100`，作为启动回退值；后台“运行设置”保存后在后续调度读取，无需重启。读取失败保留上次有效值，初始失败采用启动回退。
- 单用户上限按 `(tenant_id,user_id)` 统计；同一 Thread 始终最多一个活跃 Run，不设置固定 Tenant 最大运行数。
- 调低上限不会取消在途 Run；新 dispatch 会等到 Worker 与用户活跃数低于新值后再领取。
- 新 dispatch 在提交 Worker Tenant assignment 的同一 PostgreSQL 事务中发送无载荷通知，Worker 使用独占连接立即唤醒 claim；通知重复、迟到、丢失或监听断线都不改变 durable 事实，定时轮询继续作为兜底。
- Worker ID、轮询、Dispatch lease、Run lease 和超时必须符合测试覆盖的范围；轮询间隔同时决定无通知时的最长兜底等待和监听断线后的重连节奏，不是正常 dispatch 的固定排队延迟。
- Scheduler 的清理 lease 和轮询不能被配置为绕过 Tenant/RLS 扫描。

### 后台管理

- 统一 Admin API 默认监听 `127.0.0.1:3003`，模型、记忆、身份、统计与 Skill 路由共用管理身份。“运行设置”在 `/settings` 配置工具调用模式、工具启用名单、并发和上下文压缩参数，一次保存生效；尚未保存时页面展示推荐默认值，并明确标识未保存。数据库、端口、部署角色与平台根秘密保留在部署配置。
- “身份与登录”配置保存后动态生效；页面不要求填写原因或理解版本，服务端仍执行并发检查并自动记录审计。Provider、SMTP 与短信秘密只返回已配置状态，不回显明文。
- 模型 Provider 的 API Key 是写入型字段：首次配置必填，编辑时可保留旧密钥或替换。多个已保存供应商可分别使用或测试；“测试已保存配置”只验证已保存的默认模型，不测试未保存输入。模型能力高级设置保留显式覆盖，页面不展示内部版本或原因输入。
- 记忆页可独立配置 Mem0 API Key、开关、地址与超时，不要求先配置模型。密钥加密保存、不回显，留空保留现有密钥；保存后对尚未建立运行快照的新任务生效，无需重启。新部署的作用域秘密由平台稳定主密钥独立派生；已有 `MEM0_SCOPE_HMAC_KEY` 优先沿用，接管 API Key 后仍必须保留，以免改变已有记忆标识。`MODEL_CREDENTIAL_ENCRYPTION_KEY` 同时保护模型和记忆密钥，必须稳定并备份。
- 模型、记忆和运行设置的日常保存使用 `PUT /v1/admin/control/model-providers/current`、`PUT /v1/admin/control/memory-providers/current`、`PUT /v1/admin/control/runtime-settings/current`，均要求控制面 admin、幂等键和内部 `expectedGeneration`。冲突返回 409 并保留当前配置，页面保留输入等待显式刷新。旧模型/记忆草稿与发布接口仅供兼容；详细边界见[维护者开发边界](../maintainers/runtime-development-boundaries.md)。
- 进程内仍使用 Admin Control 与 Skill Publisher 两套数据库连接和角色，Skill Publisher 对象存储凭据不能复用普通 API/Worker 身份。
- 开发发布 fixture 不等于生产 Skill 目录。

### 诊断

- 模型报文诊断默认关闭，因为请求和轨迹可能包含用户内容；只新增保存原始请求正文，不保存原始响应正文，详见[诊断指南](../maintainers/diagnostics.md)。
- 轨迹和报文目录只允许写入被 Git 忽略的本地路径。
- 保留天数和单条大小必须显式限制。

## Production 秘密矩阵

production 示例是字段合集，不是共享 env 文件。部署平台应至少按下表分片：

| 服务 | 必需类别 | 不应获得 |
| --- | --- | --- |
| API | PostgreSQL、Better Auth 根秘密、JWT 兼容身份、S3 下载签名、TLS/公开 origin | 模型密钥、Sandbox 执行密钥、MinIO root、迁移器凭据 |
| Scheduler | PostgreSQL、Sandbox 生命周期、托管沙箱共享加密根、标题模型（启用时） | S3 读写密钥、主模型调用密钥、API JWT 私钥 |
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

## 后台沙箱配置

后台“沙箱服务”支持管理 `cube`、`e2b`、`tencent-ags`，保存连接地址、密钥、模板和独立运行策略。E2B 与 AGS 的地址为不含协议和路径的域名；Cube 使用完整服务 URL。凭据留空可复用该供应商已有配置版本的密文，不回显密钥。

管理员保存版本、测试连接后，选择单供应商或按权重分配并点击“应用分配”；新实例开始使用新配置，旧实例保持创建时的版本。测试会真实创建并释放沙箱。策略包含 TTL、操作超时、创建/恢复超时、暂停保留时间和空闲暂停/销毁，边界见 [Sandbox Provider](../architecture/sandbox-providers.md#后台配置与分配)。

Admin Control API、Worker 和 Scheduler 必须使用同一个稳定的 `MODEL_CREDENTIAL_ENCRYPTION_KEY`。该根密钥同时保护模型、记忆和沙箱凭据，需要备份；Scheduler 不应接收主模型调用密钥作为替代。未配置加密根的 Scheduler 在需要读取加密沙箱配置时失败关闭。历史环境配置继续用于尚未托管的实例；从新建池移除供应商不应删除其历史连接配置。

## 腾讯云 AGS

将 `SANDBOX_ENABLED_PROVIDERS` 设为包含 `tencent-ags` 的逗号分隔列表；新建沙箱使用 `SANDBOX_DEFAULT_PROVIDER`。配置会在进程启动时读取，不支持请求级切换。

| 变量 | 使用进程 | 规则 |
| --- | --- | --- |
| `TENCENT_AGS_API_KEY` | Worker、Scheduler | 启用 AGS 时必填，不回退 E2B 凭据 |
| `TENCENT_AGS_DOMAIN` | Worker、Scheduler | 启用 AGS 时必填，仅域名，不含协议或路径 |
| `TENCENT_AGS_TEMPLATE_ID` | Worker | 启用 AGS 时必填，对应腾讯云沙箱工具名或受支持标识 |
| `TENCENT_AGS_SESSION_TTL_SECONDS` | Worker | 1–86400，默认 3600；有效上限还受腾讯云账号与工具限制 |

AGS 采用到期销毁与主动暂停策略；部署前须完成[Provider 验收](../architecture/sandbox-providers.md#接入与验收)。现有公共进程配置仍要求 Cube 配置字段通过格式校验；仅启用 AGS 时不会装配或探测 Cube 网关。
