# ADR-0049：受审生产进程装配与 Worker 运行边界

- 状态：已替代（当前生产装配边界见 [ADR-0054](../../decisions/0054-production-transport-and-reproducible-release.md)）
- 日期：2026-07-29
- 决策者：M7 生产 Gate 实施审阅
- 关联任务：M7 production Worker、运行角色与部署 Gate
- 替代关系：曾细化 ADR-0015、ADR-0038、ADR-0047、ADR-0048；production capability 结论已由 ADR-0054 替代

> 2026-07-30 安全复审：同一进程内已执行代码可调用公开 factory，JS 包边界不能提供调用方 ACL。本文关于 WeakSet/
> capability “不可伪造”的安全声明不成立，相关实现已移除。保留本文仅记录历史；当前约束以 ADR-0054 为准：
> `process-runtime` 是受信代码编排工具，production 安全边界位于各服务拒绝外部 assembler 的公开 `start*Process`。

## 背景

`startServiceProcess` 原先有意拒绝所有 production assembler，避免调用方把测试 Fake 伪装成真实服务。
此后 Scheduler 曾以把 production 配置复制为 development 的方式绕过该下限，而 Agent Worker 则仍固定抛出
`PRODUCTION_ASSEMBLY_UNAVAILABLE`。两种状态都不能构成生产边界：前者丢失真实环境语义，后者无法部署已经具备
PostgreSQL、S3、CubeSandbox、Workspace candidate、Artifact intent 和 Pi 依赖闭环的 Worker。

同时，生产部署必须证明进程使用最小权限 Runtime 数据库角色，不能依赖 Migrator、数据库 owner 或可 `SET ROLE`
的上游身份；development 固定身份变量一旦遗留在 production 环境，也不能被解释为“关闭的开发开关”。模型、对象
存储及携带 Cube API Key 的控制面若经明文 HTTP 发送，会直接扩大秘密泄露面。

## 决策驱动因素

- 普通调用方注入的 assembler、对象字面量和 TypeScript 断言不能解锁 production；
- 真实生产 assembler 必须收到未改写的 `runtimeEnvironment: production` 配置；
- Worker 只能消费明确 Tenant 分片，且 Workspace→Revision→Artifact 继续遵守 ADR-0047/0048 的原子事实；
- Runtime 登录角色、开发身份变量和秘密传输必须在建立外部连接前失败关闭；
- 共享进程生命周期仍需保持原有排空、readiness 与脱敏错误语义。

## 备选方案

### 方案 A：继续拒绝所有 production

安全下限简单，但 Worker 无法部署，且无法验证既有真实持久化闭环。

### 方案 B：将 production 配置伪装为 development

可复用生命周期代码，但错误分类、日志、可观测性与策略判断均可能错误地沿用 development；这也会让后续
development-only 旁路重新进入生产。

### 方案 C：共享框架引入不可伪造的受审 production capability

应用模块在初始化时封闭创建真实 assembler capability；框架以 WeakSet 验证 capability 并把原始 production
配置传入。应用公开入口仍拒绝调用方提供的普通 assembler。代价是每个启用生产的应用都必须显式拥有并审阅
自己的依赖图。

## 选择

采用方案 C。

1. `@cube-runtime/process-runtime` 提供 `createAuditedProductionAssembly`。其 capability 使用模块私有
   WeakSet 签发和验证，并在创建时绑定 assembler 方法；普通 `assembler` 在 production 仍返回
   `PRODUCTION_ASSEMBLY_UNAVAILABLE`，缺少任何 assembler 仍返回 `ASSEMBLER_MISSING`。
2. Agent Worker 和 Scheduler 将真实 assembler 封闭在各自模块内，公开 `start*Process` 的 production 分支
   不接受调用方注入。Worker 不再抛出 `PRODUCTION_ASSEMBLY_UNAVAILABLE`，而是装配真实 PG/S3/CubeSandbox/Pi、
   candidate Workspace Runtime、Artifact Router 和 completion gate；不复用 development 身份或明文 Artifact
   下载配置。
3. Worker 的 production 模式要求 Linux。它保持严格 `/models` 上下文窗口与最大输出元数据匹配，并把
   `AGENT_WORKER_TENANT_ID` 作为单一 durable dispatch 分片边界，而不是客户端可声明的租户。
4. 所有服务配置 `DATABASE_RUNTIME_ROLE`，连接就绪探针比较 PostgreSQL `current_user` 与该声明值；不匹配时只
   返回稳定错误，不输出实际角色或连接串。
5. production 拒绝任何 `DEV_AUTH_*` 变量（包括 `DEV_AUTH_ENABLED=false`）。Worker 对模型、S3 及配置了
   Cube API Key 的控制面要求无 URL 凭据的 HTTPS；数据面 Proxy 必须由部署配置明确为 HTTPS。

## 理由

WeakSet capability 不能被 JSON、对象字面量或 `as any` 重建，同时应用入口没有接收该 capability 的参数，因此
部署调用方无法用测试 Fake 取代真实依赖。与环境降级相比，框架和 assembler 都可以依据真实 production
语义作出严格判断。复用现有 candidate 与 Artifact 闭环避免出现“生产入口能启动但文件或交付物静默丢失”的
第二套实现。

## 影响

### 正面影响

- `startWorkerProcess` 可在 Linux production 中使用受审真实依赖图启动；
- Scheduler 移除 production→development 配置伪装；
- Runtime 角色误配、开发 fixture 遗留和明文秘密端点均在副作用前拒绝；
- Workspace 和 Artifact 仍由同一 PostgreSQL 原子事实链约束。

### 负面影响与成本

- 每个生产应用都要明确维护 capability 和依赖关闭顺序；
- 模型、S3 和带 Cube Key 的端点必须提供 TLS，现有明文内部部署需要先完成 TLS 迁移；
- Worker 仅支持 Linux，Windows 继续只用于 development/测试。

### 安全、数据与运维影响

- `DATABASE_RUNTIME_ROLE` 是运行时验证，不替代 ADR-0015 的数据库 bootstrap、NOINHERIT 与最小 ACL 审计；
- production 的 Tenant 只来自部署 Worker 分片，不能由模型、HTTP 请求或开发配置改变；
- 启动与 readiness 仍只公开稳定服务/探针名称，秘密、URL 凭据和实际数据库角色不写入输出；
- 完整生产容器、身份、配额、生命周期、SBOM 和容量 Gate 由后续 M7 部署切片继续验证，不能据此宣称外部基础设施已通过。

## 验证

- `service-process` 测试证明受审 capability 收到同一 production 配置，普通 Fake 与伪造 capability 均被拒绝；
- Worker 入口测试覆盖调用方 Fake 拒绝、development 身份变量拒绝、TLS、Tenant/角色格式和 production 模型元数据；
- Worker polling、Workspace capability 和 fail-closed revision 现有测试继续通过；
- Scheduler 入口测试证明 production Fake 拒绝且不再改写 runtimeEnvironment；
- 后续部署 Gate 必须在真实 Linux 中以 Runtime 角色、PG/S3/Cube/模型依赖执行 `/ready`，缺任一依赖不得报告 ready。

## 可逆性与回退

未写入新业务数据前可以停止生产 Worker、移除受审 capability 并恢复 fail-closed 不启动状态。不能回退为
production 配置伪装 development，也不能为了回退放宽 candidate、Artifact 或 Runtime 角色事实。已经由
ADR-0047/0048 提交的 Revision 和 Artifact 按其各自回退规则保留。

## 后续工作

- 接入生产 API 身份解析与同一受审启动路径；
- 提供非 root 容器、秘密注入和外部依赖失败关闭 Gate；
- 补齐 M7 配额、对象生命周期、观测、SBOM/License、回滚和容量验收。

## 实施记录

- 2026-07-29：新增受审 production capability，启用 Agent Worker 真实生产 assembler，移除 Scheduler
  environment 降级，并增加 Runtime 角色、开发身份和 TLS 配置门禁。
- 2026-07-29：新增独立 production 配置契约与非 root Linux Worker 容器 Gate；Gate 验证 build context 不带
  `.env` canary、镜像无 Python/旧数据目录，以及依赖不可用或遗留 development 身份时只会失败关闭且不泄露秘密。
  它不替代真实 PostgreSQL/S3/CubeSandbox/模型 readiness 或完整 M7 发布验收。
