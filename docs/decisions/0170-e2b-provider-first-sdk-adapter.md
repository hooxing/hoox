# ADR-0170：E2B Provider 首期 SDK 适配与生产启用边界

- 状态：已接受（首期适配）
- 日期：2026-08-14
- 决策者：项目维护者
- 关联任务/PR：`feature/e2b-sandbox-provider`
- 替代关系：无

## 背景

多 Sandbox Provider 实施计划把 E2B 列为首批目标，并规定 Provider Adapter 不得绕过共享 Workspace、安全错误映射、创建结果未知对账和持久 Provider 身份边界。当前仓库尚未完成 `providerKey` 持久化、Provider Router、Scheduler cleanup 路由与 ResourceFS 投影，因此直接在生产入口通过环境变量切换 E2B，会使裸 `providerSandboxId` 无法确定归属，并可能由 Cube cleanup 错误处理。

已核对并固定 E2B JavaScript SDK `e2b@2.39.0` 的公开类型与本地安装产物。该版本提供 create/connect/getInfo/list、commands、files、内存 pause、kill、metadata 查询和 Volume mount；基础 `e2b` 包不提供与现有 Cube `runCode` 完全同构的 Code Interpreter 结果。

## 决策驱动因素

- 创建超时或取消可能发生在 E2B 已接受请求之后，必须避免双重创建和无人回收实例；
- API Key 只能由显式配置注入，不能读取 SDK ambient 环境或进入日志、测试快照与提交；
- `/workspace` 的路径、符号链接、配额和 generation 校验必须复用单一安全实现；
- 当前持久化仍以裸 Sandbox ID 表示身份，不能安全开放生产 Provider 切换；
- 首期需要可独立运行的真实 E2B 冒烟入口，为后续 Provider Router Gate 提供证据。

## 备选方案

### 方案 A：直接在 Worker/Scheduler 增加 E2B 条件分支

优点是可以尽快通过环境变量切换生产创建。缺点是绕过实施计划中的 Provider Key、Router 和 cleanup 路由前置条件；已有暂停 Session、UNKNOWN cleanup 和跨 Provider ID 冲突均无法可靠处理，因此拒绝。

### 方案 B：先完成 E2B SDK Adapter，但不接入生产 Router

在 `@cube-runtime/sandbox` 内实现 E2B Gateway、Handle、错误映射、共享 Workspace Backend、配置解析和真实冒烟；生产 Worker 与 Scheduler 继续只装配 Cube。待 Provider 身份和 Router 完成后再启用 E2B。

### 方案 C：等待所有多 Provider 基础设施完成后再写 E2B 代码

风险最低，但无法提前验证 SDK 契约、错误语义、创建对账和真实环境能力，会把 Provider 特有风险推迟到集成阶段。

## 选择

选择方案 B。

1. 固定依赖 `e2b@2.39.0` 并提交锁文件；
2. 新增 `E2BSandboxGateway` 和可注入的 `E2BSdkFacade`，实现 create/connect/inspect/probe、command、files、pause/kill；
3. 创建请求写入随机 metadata request ID。非确定性失败后按 metadata 有界查询，找到实例即清理；无法证明不存在时返回稳定 `UNKNOWN` 并记录生命周期事件；
4. 把 Workspace SDK 边界和错误映射参数化，Cube 与 E2B 复用同一安全扫描与快照实现，同时保留旧 Cube 导出别名；
5. 基础包的 `runCode` 采用无状态 command 包装，仅声明 Python/JavaScript；不伪装 TypeScript，也不承诺 notebook 状态、富媒体结果或变量连续性；
6. 提供 `E2B_API_KEY`、`E2B_DOMAIN`、`E2B_TEMPLATE_ID` 的真实冒烟配置解析和 `pnpm test:e2b:real`；
7. 本切片不修改生产 Worker、Scheduler、数据库和持久事件，不允许以此分支直接把默认 Provider 切到 E2B。

## 理由

该选择允许在不破坏持久身份与 cleanup 正确性的前提下，尽早冻结 E2B SDK 适配边界和真实 Gate。共享 Workspace 实现避免复制最敏感的路径与符号链接防护逻辑；可注入 Facade 允许覆盖超时、取消、对账和协议异常。生产启用继续受 Provider Key/Router 前置 Gate 约束，不以临时禁用 Session reuse 等方式掩盖身份缺失。

## 影响

### 正面影响

- Sandbox 包具备可测试的 E2B Gateway 与 Handle；
- Cube Workspace 安全算法成为 Provider 无关实现，现有导入保持兼容；
- E2B 创建结果未知有 metadata 对账和告警事实；
- 后续 Provider Router 可直接装配，不需要重写 SDK 边界。

### 负面影响与成本

- 新增 E2B SDK 及其传递依赖，增加安装体积和供应链审计项；
- `runCode` 仅为无状态兼容层，能力弱于专用 Code Interpreter；
- 在 Provider Router 完成前，E2B 只能通过单元测试与显式真实冒烟使用，不能作为生产默认 Provider；
- E2B ResourceFS 只完成 SDK Volume 参数映射，尚未证明只读语义、Tenant 隔离和恢复行为。

### 安全、数据与运维影响

- API Key 由构造参数显式传给 SDK，错误消息和生命周期事件不回显该值；
- 示例只包含明显占位值，真实 Key 不进入仓库；
- Provider 不成为 Workspace 或 Thread Context 事实源；
- 真实冒烟创建的实例在 `finally` 中销毁，但进程被强制终止时仍依赖五分钟 TTL 回收；
- 生产配置、数据库数据和 cleanup 消费语义保持 Cube-only。

## 验证

- E2B 配置单元测试：必填字段、裁剪和不回显秘密；
- E2B Gateway 单元测试：显式凭据、TTL/lifecycle/env/volume、command/files/runCode、inspect、取消后清理、metadata 对账和 UNKNOWN 告警；
- 原有 Sandbox 与 Workspace 测试：证明 Cube 行为和安全算法没有回归；
- `pnpm --filter @cube-runtime/sandbox typecheck` 与 build；
- `pnpm format:check`、`pnpm lint`、配置示例契约和供应链检查；
- 人工设置本地 `E2B_API_KEY` 与 `E2B_TEMPLATE_ID` 后运行 `pnpm test:e2b:real`，验证 create/command/files/inspect/pause/connect/kill。真实凭据不得出现在命令参数或测试输出中。

## 可逆性与回退

删除 E2B 导出、SDK 依赖、冒烟入口和参数化 Workspace 扩展即可回退；旧 `CubeSandboxWorkspacePort` 别名允许调用方无迁移回退。由于本切片不写入 E2B 生产身份和数据库事实，回退不涉及数据迁移。真实冒烟遗留实例按显式 kill 或创建 TTL 回收。

## 后续工作

- 完成 `SandboxProviderKey`、能力/Profile 类型和共享契约测试；
- 完成 Provider 身份数据库迁移、摘要、capability 绑定和 down 拒绝；
- 完成 Worker/Scheduler Provider Registry、cleanup/recovery 路由与 readiness；
- 真实验证 E2B Template 中 Node、Python、LibreOffice、Poppler、pptxgenjs；
- 为 ResourceFS 选择并验证 E2B 原生只读 Volume 或受控物化方案；
- 若需要 notebook 状态或富输出，单独评估 E2B Code Interpreter SDK，不扩张基础 `runCode` 语义。

## 实施记录

- 2026-08-14：在 `feature/e2b-sandbox-provider` 完成首期 SDK Adapter、共享 Workspace Backend、配置与测试；生产 Router 保持关闭。
