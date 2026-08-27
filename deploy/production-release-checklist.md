# 生产发布与回滚清单

本清单约束可复现制品的交接，不代表真实 PostgreSQL、S3、CubeSandbox、模型、容量或故障演练已经通过。每次发布必须复制
`production-release-manifest.example.json` 到部署系统的不可变发布记录中，填写实际值后由双人复核；不得把真实凭据提交仓库。

## 发布前

1. 记录 release ID、Git commit、API/Scheduler/Worker 镜像 digest，确认部署引用 `sha256:`，不使用 tag 或 `latest`。
2. 运行 `config:check:production`、`security:audit:production`、`supply-chain:check`、`license:check`、`release:check`、三个服务的容器 Gate；保存日志与
   CycloneDX SBOM SHA-256。Gate 只能证明静态边界和外部依赖缺失时失败关闭。
3. 部署声明必须启用 `readOnlyRootFilesystem`（只读 root filesystem），仅挂载受控的 `/tmp` tmpfs，并由 admission policy 拒绝覆盖镜像
   entrypoint/command；运行 UID 1000 不得写入应用、node_modules、SBOM 或 vendor 证据目录。
4. 复核镜像内 Hoox `LICENSE`/`NOTICE`/第三方通知、Pi 与 vendor `LICENSE`/`SOURCE.md`、DeepSeek tokenizer 运行资源、Node base manifest digest、pnpm lock hash，以及 License allow/deny 结果；禁止 `dlx`、
   `npx` 或任何未锁定的临时下载。
5. 为 API、Scheduler、Worker 分别只注入其声明的秘密；禁止把共享 env 文件整包注入。Scheduler 只需要 PG/Cube，不接收
   S3 或模型密钥。在隔离预生产 Linux 环境以最小权限 Runtime 角色连接真实 PG/S3/CubeSandbox/模型，验证三个服务的
   readiness、关闭、JWT/Tenant 越权矩阵和秘密脱敏。Web/OIDC 是外部产品身份前置，未接通时不得声称浏览器生产闭环。
   同时确认对象存储使用与 `API_PUBLIC_ORIGIN` 不同的专用 origin，CORS 只允许受信 Web origin；逐响应验证 CDN 的
   `nosniff`/CSP，不能把未受代码控制的外部响应头视为已由本 Gate 证明。
6. 记录数据库 migrationFrom、migrationTo 和 rollbackCompatibleThrough；先完成备份/恢复演练，并确认旧镜像读取新 Schema 的
   兼容窗口。破坏性迁移必须单独发布，不能与应用切换合并。

## 发布

1. 先按 migration 计划执行向前兼容迁移，再按部署平台能力灰度 API、Scheduler 与 Worker 的镜像 digest；禁止现场重新构建镜像。
2. 观察 readiness、5xx、dispatch lease、Run 终态、S3/Cube/模型依赖错误与资源增长；阈值必须来自发布记录，不在本清单猜测。
3. 灰度达到记录的观察窗口后再扩大；任何必要探针失败立即停止扩容，不得以临时放宽 TLS、角色、JWT 或 Tenant 边界救火。

## 回滚触发

出现发布记录中定义的错误率、readiness、数据一致性或安全阈值，或无法证明 Workspace→Revision→Artifact 闭环时，触发回滚。
容量门槛和真实外部故障阈值尚未完成 M7 验收，不能用本静态 Gate 代替。

## 回滚执行

1. 停止扩大流量与新 Worker 领取，保存 request/run/release ID 等非秘密证据；不得输出连接串、JWT、API key 或私钥。
2. 将 API、Scheduler 与 Worker 都切回发布记录中的上一组镜像 digest，保持 Runtime 数据库角色、TLS 与 Tenant/RLS 约束不变。
3. 只有 migration 明确标记可逆且已验证备份时才执行 down；否则保留向前兼容 Schema，回滚应用而不猜测数据变更。
4. 重新验证真实依赖 readiness、Run 恢复和 Artifact 下载授权。若失败，进入停服/只读应急状态并升级处理，不回退到 development。
5. 封存实际镜像/SBOM digest、时间线、数据库版本和恢复证据，补充事故复盘与下一次发布阻断项。

## 完成条件

只有发布记录、真实环境验收、观察窗口和回滚证据均签字完成，单次发布才可结束。M7 的容量、全量故障与真实基础设施 Gate
在 roadmap 勾选前仍保持未完成。
