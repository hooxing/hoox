# ADR-20260902172021：删除已退役的 Artifact 模型工具链

- 状态：已接受
- 日期：2026-09-02
- 决策者：Runtime 维护者
- 部分替代：[ADR-0058](0058-simple-deliver-file-tool.md) 中暂留旧模型工具源码的结论
- 被替代：无

## 背景

ADR-0058 已将新 Session 的文件交付入口收敛为 `deliver_file(path, name?)`，并从生产和恢复装配中删除
`declare_deliverables`、`publish_artifact` 接线。为避免过早破坏历史事实，当时暂留了旧工具和旧 intent 表。

后续实现已经证明模型工具源码不再承担兼容职责：旧 Pi Schema、Tool Router 及 PostgreSQL ResourceVersion
桥接器没有生产消费者，两个 Worker 纵向用例也已被标记为跳过。当前 Faux 纵向测试明确断言 Session 只暴露
`deliver_file`，不暴露两个旧工具。与此同时，数据库迁移、Artifact Repository、历史工具事件展示和下载读侧仍在
读取既有持久事实。

继续保留不可达的模型协议会让维护者误以为存在两套可用交付入口，还需同步维护参数 Schema、授权端口、错误投影、
ResourceVersion 准备端口和专用测试。`NoDeclaredArtifactCompletionGate` 同样没有消费者，且 ADR-0048 已明确禁止生产
装配使用该无操作回退。

## 约束

- 安全与租户边界：当前 `deliver_file` 的执行许可、Sandbox 文件读取和发布授权不得放宽。
- 数据与迁移：已执行迁移不可修改；旧 intent、Artifact、ResourceVersion 和工具事件必须继续可读。
- 兼容性：工作区包均为私有包，不承诺旧 Router 或 Pi Schema 的仓库外调用兼容；历史事件名称不是本次删除对象。
- 运维与故障恢复：现有下载、Blob 回收、Artifact 读侧和历史投影必须保持不变。
- 性能与成本：不以运行时性能为目标，只减少无人拥有的维护表面。

## 备选方案

### 方案 A：继续保留全部旧工具源码

不产生改动风险，但生产不可达的协议、端口和测试仍会与当前 `deliver_file` 并存，未来修改安全边界时容易误维护或误接线。

### 方案 B：连同旧持久化事实一起删除

删除量最大，但会破坏已发布迁移和既有历史数据的读取兼容，也无法仅靠静态引用证明数据已经排空。

### 方案 C：只删除不可达的模型工具层

删除旧 Pi Schema、Tool Router、自引用测试、跳过测试、无消费者桥接器和无操作完成门；保留持久化与读侧兼容。

## 决策

采用方案 C。

- `@hoox/pi-adapter` 不再导出或维护 `declare_deliverables`、`publish_artifact` 的模型参数 Schema 和 Pi 工具创建器。
- `@hoox/tool-router` 不再导出或维护旧 Artifact Router、ResourceVersion 准备端口及其专用测试。
- Agent Worker 删除从未接入装配的 PostgreSQL Artifact Resource 桥接器、两个已跳过的旧链路测试，以及被生产决策明确
  禁止的无操作完成门。
- `deliver_file` Router、Artifact 发布与下载服务、数据库 Repository、迁移、历史工具名展示和持久化集成测试继续保留。

## 理由

消融前的全仓引用追踪显示，旧模型工具源码只被自己的测试、一个从未导入的桥接器和两段跳过测试消费；三个相关包均为
`private`。删除这些源码后，当前 Session 工具清单、`deliver_file` 纵向链路、受影响包类型检查及全仓静态检查能够直接验证
现行行为不依赖它们。

这一证据足以删除运行时代码，但不足以证明历史数据库事实可删除，因此持久化兼容边界保持不变。

## 影响

### 正面影响

- 模型交付协议只剩一个事实拥有者，不再存在可被误接回生产的第二套路由。
- 删除旧参数 Schema、授权适配、准备端口及专用测试，降低跨包同步成本。
- 代码与 ADR-0058 已经生效的生产工具清单保持一致。

### 负面影响

- 如需恢复旧模型工具，必须从版本历史恢复源码，不能再直接重新接线。
- Artifact 领域服务仍包含读取和处理历史发布事实所需的旧语义，不能仅凭本次消融继续机械删除。

### 安全与隐私

本决策不新增网络、文件系统或凭据能力。当前 `deliver_file` 的授权、路径和租户校验不变。

### 数据、兼容与迁移

不新增、不修改、不回退任何迁移。既有工具事件、Artifact、ResourceVersion、intent 和下载行为保持兼容。

### 运维与可观测性

进程入口、配置、指标和日志均不变。历史轨迹仍能把旧工具名投影为可读动作。

## 验证

- 消融前运行 `@hoox/tool-router` 测试和 Worker `pi-session-factory` 定向测试，建立绿色基线。
- 消融后重新搜索旧 Router、Pi 创建器、桥接器和无操作门，确认只剩 ADR、历史协议字面量及持久化兼容引用。
- 运行 `@hoox/pi-adapter`、`@hoox/tool-router`、`@hoox/agent-worker` 类型检查，以及当前 `deliver_file` 定向测试。
- 运行 `pnpm format:check`、`pnpm lint` 和 `git diff --check`。

## 可逆性

代码删除可通过单提交回退恢复，不涉及数据回写。若未来确需恢复旧工具，必须新增决策并重新验证模型协议、安全授权与生产接线；
不得复用无操作完成门或假定旧 intent 数据已经排空。

## 后续验证

- 由 Pull Request CI 执行全量工程基线与生产容器 Gate。
