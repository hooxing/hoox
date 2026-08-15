# ADR-20260815193622：内部无损 Session 轨迹与 DeepSeek Trajectory 适配

## 状态

已接受，2026-08-15。替代 ADR-20260815182655 中“由公开 Runtime Event 近似轨迹”的数据方案；回环地址、本地敏感诊断和不进入用户产品面的安全边界继续有效。

## 背景

旧查看器读取 `RuntimeEventV1`。该协议是面向用户体验和 durable 状态机的有损投影：thinking delta 会合并，工具参数、完整工具结果、Pi 的 `turn_start` / `turn_end`、user/toolResult message、模型 usage 与准确事件时刻均不会保留。用文件 mtime 推导耗时、用相邻 UI 事件猜测模型步骤，会把排障视图变成不可靠的二次解释。

DeepSeek Harness Trajectory 以完整 Session Event ledger 为事实来源，再投影 Turn、Input、Model、Tools、调用耗时和详情检查器。其 UI 包采用 MIT License，但直接依赖 DeepSeek 的 Cordis、Conversation Runtime、UI Primitives、Compaction 与工具协议，不能作为 Cube Runtime 的运行时依赖直接安装。

## 决策

1. `@cube-runtime/pi-adapter` 在公开 `RuntimeAgentEvent` 投影之前新增内部原始订阅。它逐个观察 Pi `AgentSessionEvent`，不参与用户事件协议，也不改变原有 thinking 合并和 durable Run Event 语义。
2. `@cube-runtime/trajectory` 定义 `InternalTrajectoryEventV1`：
   - 每个 root/subagent Session 独立严格递增 `sequence`；
   - 记录 ISO wall clock 与同一 Session 的 monotonic offset；
   - 保存完整原始事件，包括 turn/message/tool 生命周期、工具 args/result、assistant content、usage、队列、重试和压缩事件；
   - 普通 JSON 数据保持原形；`undefined`、二进制、BigInt、非有限数字、Error、Map/Set 和循环引用使用显式 `$cubeInternalType` 标签，禁止静默丢字段或截断。
3. `PiWorkerSessionFactory` 在 Session 创建后立即安装原始订阅，并补充 `session_created`、`prompt`、`steer` 三类 Runtime 边界事件。记录器使用独立串行 Promise 链，保持接收顺序；诊断写入失败被隔离，不得改变模型、工具或 Run 终态。
4. development 且 `MODEL_WIRE_TRACE_ENABLED=true` 时，`ProjectInternalTrajectoryMirror` 把事件逐条写入：
   - root：`model-wire-traces/<run>/<attempt>/trajectory-event-<sequence>.json`
   - subagent：`model-wire-traces/<run>/<attempt>/subagents/<agentThread>/<agentTurn>/trajectory-event-<sequence>.json`
   文件仍使用既有受信根、逐级拒绝链接和同目录 hard-link 原子发布；相同事件可幂等重放，不同正文不得覆盖。
5. 固定保存 DeepSeek Harness `packages/client/ui-trajectory` 在提交 `47f943859bef60e4160492346772ded9b24f765a` 的源码快照到 `runtime-ts/vendor/deepseek-trajectory`，保留 MIT License、来源和上游 README。运行时不加载其 DeepSeek 内部依赖。
6. 查看器通过 Cube adapter 把无损事件映射为 DeepSeek 的 Turn / Input / Model / Tools 账本语义，并迁移其核心交互：三泳道 Overview、Turn 分组、紧凑事件表、搜索、局部检查器、模型 wire 联查和 Session log 下载。旧 Run 只有有损事件时必须显示明确提示，不再伪装为准确轨迹。
7. 能力只通过 `dev:trajectory` 在 `127.0.0.1` 启动；不加入用户 Web、公开 API、production 进程或普通租户授权面。

## 取舍

- 选择完整事件而不是摘要后，诊断目录可能明显增大，且包含用户输入、思考、工具参数、stdout/stderr、文件内容和图片 Base64。该风险由显式敏感诊断开关、development-only 装配、回环监听和人工保留窗口承担。
- 当前权威 Run 状态仍在 PostgreSQL；内部轨迹是不可变、best-effort 的维护者诊断账本。轨迹写入失败不会把成功 Run 改成失败，避免诊断能力成为生产控制面。
- 不直接编译 DeepSeek TSX，避免引入整套 DeepSeek 客户端容器。固定 vendor 快照用于许可证合规、交互对照和后续增量同步；Cube adapter 是唯一数据与宿主集成层。
- 模型 request/response 仍由既有 Model Wire Trace 保存；内部轨迹不复制 HTTP headers 或认证材料。

## 安全

- 禁止把 `model-wire-traces` 提交到 Git、放入共享盘、反向代理或端口转发。
- 事件捕获不得新增 Authorization、Cookie、API key 或 Provider secret 字段；模型网络层继续使用既有敏感 header 排除规则。
- viewer 文件访问继续限制在固定 root/run/attempt 和模型报文文件白名单内，并拒绝符号链接、junction 与路径逃逸。
- production 即使打开模型诊断配置，也不会创建宿主机内部轨迹镜像或启动查看器。

## 验证

- 无损值快照测试覆盖普通对象、undefined、二进制、BigInt、非有限数字和循环引用。
- 记录器测试覆盖严格 sequence、wall/monotonic 时间、串行持久化与失败隔离。
- 文件镜像测试覆盖 root/subagent 隔离、规范 JSON、幂等冲突和 development-only 装配。
- DeepSeek adapter 测试覆盖真实 turn、reasoning、工具 args/result、失败工具、usage 和准确工具耗时。
- 查看器测试与本地启动验证覆盖 Run 发现、回环绑定、旧数据提示及模型 wire 安全读取。

## 可逆性

删除内部原始订阅、trajectory 事件镜像、DeepSeek adapter/vendor 快照和查看器改动即可回退。没有数据库迁移、公开 API 变化或用户协议变化；已生成的 JSON 诊断文件可按既有保留策略直接删除。
