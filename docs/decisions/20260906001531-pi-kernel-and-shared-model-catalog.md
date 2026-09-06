# ADR-20260906001531：Pi 内核收敛与共享模型目录

- 状态：已接受
- 日期：2026-09-06
- 替代关系：部分替代 [ADR-0004](0004-typescript-pi-cubesandbox-boundary.md)、[ADR-0032](0032-runtime-rollout-pi-recovery-projection.md)、[ADR-0040](0040-development-worker-windows-and-model-readiness.md) 中的 Pi Session 装配方式，以及 [Pi 目录初始值](20260820095113-pi-catalog-seeds-admin-model-metadata.md)、[浏览器目录独立降级](20260820101805-browser-bundled-pi-catalog-degrades-independently.md) 中的目录生成与加载位置。
- 当前说明：[Thread 连续上下文](../architecture/thread-continuity.md)、[仓库导览](../architecture/repository-map.md)、[维护者开发边界](../maintainers/runtime-development-boundaries.md)。
- 供应链替代关系：替代 [ADR-0148](0148-production-sbom-platform-normalization.md) 的 clipboard 平台规范化特例；pnpm 版本仍只由 `packageManager` 提供，供应链复现与许可证要求保留。

## 背景

Runtime 已经拥有持久上下文、压缩、授权、工具观察和恢复协议，却仍通过 `pi-coding-agent` 装配 `AgentSession`、设置、资源加载器和内存 Session 树。内建工具、自动压缩、自动重试和宿主资源发现均不属于已启用能力；这些上层对象仍增加了依赖、状态同步和回滚维护成本。仅替换 Session 仍不足以移除该包，因为 Provider 装配还使用它的 `ModelRuntime`，工具也通过它定义。

模型目录存在另一处重复：浏览器消费生成快照，控制 API 在运行时加载 Pi 目录并独立查询。同一份公开元数据不需要两套装配和排序实现，也不应使后台目录依赖模型执行 SDK。

## 备选方案

1. 保留完整 `pi-coding-agent`，继续关闭未使用功能。改动最小，但保留两层状态、资源加载装配及与服务端执行无关的依赖。
2. 直接使用 `pi-ai` 与 `pi-agent-core`，Runtime 保留自己的可靠性边界；目录在构建时生成并共享。减少上层装配，但必须显式保留原先由它传递的 Provider 默认值与提示词字节。
3. 完全移除 Pi，直接装配 Provider SDK 并自写工具循环。需要自行维护流式工具参数、消息配对、thinking、usage、steer 和中断协议，当前没有足够收益证明这一成本。

## 选择与边界

采用方案 2，两个 Pi 包继续锁定为 `0.82.1`。

- Worker 经 `pi-adapter` 使用 `pi-ai` 的 `Models`、Provider 与内存凭据，按已发布 Revision 装配启用模型；保留协议适配、凭据解析、thinking、usage 和模型绑定复核。无需 `pi-coding-agent` 的模型运行时、设置和资源发现。
- 模型循环直接使用 `pi-agent-core` 的 `Agent`。Runtime 从受审上下文构造有序消息，替代 `AgentSession`、`SessionManager`、Session entry/leaf 和分支树；删除 `SettingsManager` 与 `EmptyResourceLoader`。窄控制器继续负责 prompt、steer、abort、事件和诊断。
- 删除无生产消费者的控制器 `followUp()`。Thread FIFO 后续输入及子 Agent 的 `followup_task` 仍由 Runtime 持久事实驱动，不能改成 Pi 内存队列。
- 工具直接符合 `AgentTool`，保留模型可见 schema、描述、执行顺序、`prepareArguments` 参数纠正和受控失败回执。读取截断由本地完整行算法承担，保持 2,000 行、50KB、UTF-8 和续读提示语义；不注册任何 Pi 宿主工具。
- Runtime 独占上下文预算、durable `turn_end` 安全点和持久压缩。进入 Provider 前重新检查预算、真实能力清单和可信模型绑定；输入、附件、Skill 等请求级事实不能进入稳定 system prompt。
- Runtime 在 Provider 调用前产生的预算、绑定或受控续轮拒绝仍按当前调用 generation 归属，回滚该次内存消息及未消费 steer。`agent_end` 不能作为空闲屏障：底层执行和 Runtime 回滚完成后才发布 `agent.settled`，`abort()` 等待其捕获的事务完成，屏障期间禁止 prompt 重入。持久工具事实不随内存回滚删除。
- 保留原 Linux 实际发送的固定后缀 `\nCurrent working directory: /workspace`，Windows 也使用相同逻辑标签；它不是宿主文件系统能力。Provider 的 `sessionId` 每个内核实例随机生成、跨轮稳定，仅作为请求选项传递，不进入 prompt。思考级别仍按模型声明的能力裁剪。Provider 流默认超时仍为 300,000ms，重试等待上限仍为 60,000ms；不额外启用上层自动重试。
- `RuntimeAgentEvent` 保留历史 `queue.updated` 与 `compaction.forbidden` 成员，供既有轨迹与协议消费者读取；新内核不产生这些 Pi 上层事件。不能借移除生产器之机破坏历史数据消费。
- 生成器从精确锁定的 `pi-ai` 生成公开静态目录。生成物与查询实现在 `@hoox/protocol/pi-model-catalog` 窄入口供管理 Web 和控制 API 共用；Protocol 根入口不载入整份快照。生成器是 Pi 目录读取者，两个目录消费者不再在运行时加载 Pi Provider。
- 目录仍只提供可覆盖的草稿初始值，仅收录 Worker 已支持的 `openai-completions` 模型。后台认证、401/403 不降级、连接失败或可重试 5xx 的浏览器降级、保存失败关闭、显式 Revision 和 Run 快照语义全部保留。

## 理由与影响

该边界保留成熟模型协议和工具循环，把 Runtime 已经承担的持久状态与业务保证收回到唯一实现。去掉会话树并不降低恢复要求；相反，适配层必须直接证明消息顺序、失败回滚与同步屏障。统一静态目录消除前后端数据装配与查询规则漂移，窄入口避免让普通 Protocol 消费者承担目录体积。

不改变数据库结构、Rollout 格式、Thread 历史、工具 schema 或已发布模型 Revision。删除 `pi-coding-agent` 后，生产闭包不再需要它带入的终端界面及 CLI 支撑依赖；仍需按锁文件重新生成供应链证据并通过生产容器 Gate，不能用单包导入耗时替代实际性能验收。

clipboard 平台包退出生产闭包后，删除 SBOM 生成器的 `canonicalizeProductionPlatformComponents` 特例及其专用测试，不再合成不存在的 Linux clipboard 组件。SBOM 继续从真实生产安装闭包生成，保持字节级复现、许可证策略及 vendor 来源检查。未来重新引入平台相关原生依赖时必须按实际生产目标重新审查，不能恢复一个没有消费者的旧包族特例。

本记录只替代旧 ADR 的内核装配、内存恢复目标和目录加载位置。全 TypeScript、受控 Sandbox、Runtime 事实源、双栅栏、工具 provenance、Windows 开发与 Linux 生产边界、模型能力显式配置、目录草稿语义及故障降级继续有效；既有后续 ADR 对这些主题的细化也保持有效。

## 验证

- 工具定向测试覆盖参数纠正、durable 回执、副作用授权、取消信号和截断边界；65 个测试通过。159 个确定性读取案例与原 `0.82.1` 截断输出的差分探针一致。
- 内核契约验证完整工具循环、Provider 失败归属、消息回滚、abort/settled 屏障、安全点、预算、schema 和凭据/模型绑定；对实际 Provider 请求检查固定 cwd 后缀、实例级 session ID 和超时默认值。
- 目录验证生成漂移、共享排序/过滤/返回上限、API 与浏览器结果一致、故障降级及权限错误不降级。
- 合并前执行受影响包 typecheck、定向及跨包测试、格式、lint 和生产闭包检查；真实外部依赖验证依赖既有远端服务，不在本机启动替代基础设施。

2026-09-06 本地实施验证：`pnpm check` 通过，236 个测试文件通过、1 个跳过，1,850 个测试通过、4 个跳过。最终调整后的构建类型检查、格式、lint、内核兼容与供应链定向测试通过。目录差分覆盖 25 个 Provider、936 组查询，结果一致。真实 PG 开发黑盒 Gate 通过；生产 SBOM 组件数由 Worker 206 降为 184、Scheduler 203 降为 181、API 253 降为 232。这些数字衡量依赖闭包，不代表延迟或资源占用收益。

外部验证仍有限制：PG+S3 durable dispatch 用例因本机时钟比远端 PG 快约 1,347 秒，Tenant assignment 尚未到数据库领取时间而停在 queued，未进入 PI；需对齐两端时钟后重跑。真实 Cube smoke 在创建 Sandbox 时发生 `ECONNRESET`，尚未验证工具执行。Docker Linux Engine 不可用，生产容器 Gate 留给可用环境与 PR CI；上述未完成项不计为通过。

## 可逆性与回退

可在适配层恢复旧装配和精确依赖，无需数据库迁移或改写已保存事实。回退必须保留相同工具协议、提示词与模型能力身份，并重新执行恢复和屏障契约；不得以回退为由启用 Pi 宿主工具、内存 follow-up 或本地 Session 文件恢复。共享目录也可独立回退为前后端各自读取，但已发布模型和 Run 不得重新从目录推导。
