# ADR-0152：SubAgent 控制命令参数摘要由规范化参数派生

- 状态：已接受
- 日期：2026-08-12
- 决策者：Cube Runtime 维护者
- 关联任务/PR：`fix/subagent-control-contract`
- 替代关系：补充 ADR-0122 与 ADR-0127

## 背景

`interrupt_agent` 的模型工具契约只接收 `target`，但 Supervisor 曾把目标 Agent ID 直接传给 `sha256Digest()` 作为命令参数摘要。Agent ID 不是 64 位十六进制摘要，因此每次中断都会在持久命令写入前失败，并向模型返回“摘要必须是 SHA-256”。同一控制面中的 spawn、send message 与 follow-up 已经使用 canonical JSON 计算参数摘要。

## 决策驱动因素

- 模型工具 schema 与运行时实现必须一致，调用方不得提供内部幂等摘要；
- 相同 call ID 和相同参数必须可重放，不同参数必须稳定冲突；
- 摘要必须绑定命令的完整业务参数，而不是把业务标识误当成摘要；
- 修复不能改变模型可见的 `interrupt_agent` 输入契约。

## 备选方案

### 方案 A：在工具 schema 中增加摘要参数

由模型计算并传入摘要。该方案把内部幂等与完整性责任交给低信任调用方，且模型无法可靠生成规范摘要，不采用。

### 方案 B：继续把 Agent ID 当作摘要

无法通过领域校验，功能始终不可用，不采用。

### 方案 C：由 Runtime 对规范化业务参数计算摘要

以 canonical JSON 对 `{ target: agentThreadId }` 计算 SHA-256，并把结果写入持久命令记录。

## 选择

采用方案 C。所有 Agent 控制命令的 `argsDigest` 必须由 Runtime 对完整、规范化后的业务参数调用 `digestCanonical()` 生成。模型工具 schema 不暴露摘要字段。

## 理由

Runtime 已拥有规范化后的目标 Agent ID，也负责命令幂等和持久化边界。由 Runtime 计算摘要可以保持协议简单，并使相同 call ID 的重放与冲突判定保持确定性。

## 影响

### 正面影响

- `interrupt_agent` 可以实际中断运行中的子 Agent；
- 工具 schema 与实现恢复一致；
- 中断命令与其他 Agent 控制命令采用同一摘要规则。

### 负面影响与成本

- 需要增加 Supervisor 回归测试；
- 若未来中断命令新增参数，必须同步扩展 canonical 摘要输入。

### 安全、数据与运维影响

不新增权限、配置或数据列。已有失败命令没有写入持久命令表，无需迁移或修复历史数据。

## 验证

- Supervisor 测试验证运行中 Agent 可被中断；
- 测试断言持久层收到 `digestCanonical({ target })`；
- 测试验证相同 call ID 的重复中断不会重复调用 Session abort；
- 执行 Agent Worker 受影响测试、类型检查、格式和 lint。

## 可逆性与回退

可直接回退代码与测试；回退会重新导致中断不可用，但不涉及数据迁移。

## 后续工作

- 无。

## 实施记录

- 2026-08-12：修复中断命令摘要计算并增加回归测试。
