# ADR-0103：一次性 Sandbox 按附件需求挂载 Resource Volume

- 状态：已接受；Thread Session 限制已由 [ADR-0107（托管 ResourceFS Sidecar）](0107-managed-resourcefs-sidecar-and-thread-sandbox-capability.md) 取代
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联任务/PR：无附件 Skill 工具调用被 ResourceFS 故障阻断

## 背景

Pi 输入边界已经区分两类 Sandbox 启动信号：`attachment` 表示当前输入存在不能直接发送给模型、必须从
`/resources` 读取的附件；`tool` 表示模型要执行 `exec_command`、写文件等 Sandbox 工具。Skill 指令和
Skill 包由 Runtime BlobStore 注入 `/skills`，不依赖 Tenant ResourceFS。

一次性 Sandbox Registry 过去忽略这个区别，每次 create 前都确保 Tenant Cube Volume 并挂到
`/resources`。结果是没有附件的普通工具任务也依赖远端 ResourceFS Volume Plugin；插件 endpoint 或 FUSE
故障会阻止本来可以独立执行的脚本任务。

## 备选方案

### 所有 Sandbox 始终挂载 ResourceFS

路径一致，但扩大了故障域和每次创建成本，与按需启动 Sandbox 的目标不一致。

### ResourceFS 失败后无条件重试无 Volume 创建

能提高可用性，但附件任务会得到一个缺失 `/resources` 的 Sandbox，形成静默数据不可用，不能接受。

### 将附件需求显式传到 Registry

调用方在首次 acquire 时声明是否需要 ResourceFS。需要时仍失败关闭；不需要时完全跳过 Volume ensure 和
mount。

## 决策

选择显式需求信号：

- `SandboxSessionRegistryPort.acquire` 增加必填 `requiresResourceFilesystem`；
- Run Worker 仅对 `ensureSandboxReady({ reason: "attachment" })` 传 `true`，对工具启动信号传 `false`；
- Cube Registry 在值为 `true` 时才确保 Tenant Volume 并注入唯一 `/resources` mount；值为 `false` 时不访问
  Volume API，也不把 Volume mount 传给 Cube；
- 该决策当前只应用于一次性 Sandbox。Thread Sandbox Session 的可复用状态尚未持久化“是否挂载
  ResourceFS”能力，因此启用 Thread Session reuse 时继续维持原有始终挂载行为，禁止把无挂载 Session
  错误复用于后续附件任务；
- 开发环境可在远端 ResourceFS 修复前关闭 Thread Session reuse，使无附件工具测试走一次性按需路径。
  附件任务不会降级，仍会明确失败。

## 理由

资源能力必须由真实输入需求决定。跳过无关依赖能缩小故障域，但不能以隐藏附件访问失败为代价。把信号放在
Port 契约中比 Registry 根据工具名或错误消息猜测更可验证，也保持 Sandbox 仍然只在附件或工具实际请求时
启动。

## 影响

- 无附件的 `exec_command`、write 等任务不再依赖 ResourceFS Volume Plugin；
- 含非视觉附件的任务行为不变，Volume attach 失败仍终止当前 Run；
- 当前开发环境关闭 Thread Session reuse 后不再复用暂停 Sandbox，会增加无附件多轮工具任务的创建开销；
- 后续若要让 Thread Session 同样按需挂载，需要在 session/lease 持久状态中记录 capability，并在 acquire
  时按需求选择兼容 Session；不能仅修改 Provider create。

## 验证

- 生产 Registry 单元测试分别验证 `true` 会 ensure 并挂载 `/resources`，`false` 不调用 Volume 且 create
  请求无 mount；
- Worker、契约和 PostgreSQL wrapper 的类型检查确保需求信号不会在适配层丢失；
- 既有附件输入测试继续通过，证明附件仍会在模型调用前触发 Sandbox 准备。

## 可逆性与回退

恢复 Registry 无条件 ensure/mount 并删除 Port 参数即可回到原行为，不涉及数据库迁移。开发环境可独立重新
启用 Thread Session reuse；在增加持久 capability 前，其行为仍是始终挂载 ResourceFS。
