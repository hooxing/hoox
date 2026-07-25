# ADR-0006：禁用 Pi 默认 Compaction 并使用自有 Context Policy

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M0-05、M5-03、M5-04
- 替代关系：无

## 背景

Pi 的默认 Compaction 面向其自身产品会话，无法直接表达 Tenant 规范上下文、Runtime 外部副作用、Workspace 状态和可审计恢复检查点。本项目希望吸收 Codex 的活动历史与追加式 Rollout 思路，但不能让 Pi 的本地会话成为事实源。

## 决策驱动因素

- 压缩不得删除工具执行、Workspace 或 Artifact 等真实事实；
- 恢复后必须注入最新 Tenant、Run 和 Workspace World State；
- 完整 Trace 与模型可见截断必须分离；
- Pi 升级不能悄悄改变压缩时机或摘要内容。

## 备选方案

### 方案 A：完全使用 Pi 默认 Compaction

实现快，但触发和持久化语义不属于 Runtime，升级行为也难以锁定。

### 方案 B：Pi 执行压缩，Runtime 只保存结果

能保存检查点，但仍有两个策略来源，难以证明默认行为没有先发生。

### 方案 C：关闭 Pi 默认 Compaction，由 Runtime 独占 Context Policy

实现成本最高，但系统提示词、截断、压缩和恢复只有一个责任方。

## 选择

采用方案 C：

- 创建每个 Pi Session 时使用内存 SettingsManager，明确设置 `compaction.enabled = false`；
- Runtime 对外只返回窄 Controller，不暴露 `AgentSession` 或任何 `compact()` 入口；任何 Pi `compaction_start/end` 事件都映射为 `compaction.forbidden` 并视为不变量违规；
- Pi Session 使用固定逻辑 cwd `/workspace` 和零发现 `EmptyResourceLoader`；生产 Worker 仅支持 Linux，Windows 在 Session 创建前失败，防止平台路径改写把宿主盘符带入上下文；
- `prompt-builder` 负责分层系统提示词和规范上下文；`context-policy` 负责 Token 预算、工具输出截断、压缩触发和 `replacement_history`；
- Rollout 是追加式事实流，区分 `PiSessionEntry` 与 `RuntimeEntry`；压缩只追加带窗口链和兼容哈希的检查点，不删除旧事实；
- 恢复时从最新有效检查点加后续 Rollout 重建活动历史，再创建新的内存 Pi Session；
- 模型可见工具输出有硬上限，完整输出进入 Trace Blob。

## 理由

该选择以额外实现成本换取确定的恢复语义和可测试边界。Pi 仍负责模型与工具循环，但上下文的业务含义不会随依赖默认值漂移。

## 影响

### 正面影响

- 系统提示词、截断和压缩策略可以独立版本化与回归；
- Worker 本地文件丢失不影响恢复；
- 模型切换和策略升级可以通过兼容哈希解释。

### 负面影响与成本

- 需要 Token 估算、检查点 Schema、窗口链和摘要失败处理；
- 必须跟踪 Pi 消息格式和安全替换 Session 投影的 API；
- 首版长上下文测试工作量增加。

### 安全、数据与运维影响

压缩摘要按不可信派生数据处理，不能覆盖 Harness 安全边界。压缩失败不得静默删历史；窗口链损坏或兼容哈希不匹配时停止副作用执行并重建或明确失败。

## 验证

- 设置断言和事件禁止断言证明 Pi 默认 Compaction 没有运行；
- Golden Prompt 检查规范上下文层级和工具配对；
- 超长 Observation 模型可见部分稳定截断，Trace Blob 保持完整；
- 多次压缩、Worker 重启、模型窗口变小、检查点尾部损坏测试得到确定结果；
- 删除所有 Worker 本地 Session 文件后仍能从 Rollout 恢复等价投影。

## 可逆性与回退

在没有生产 Rollout 前可以调整检查点格式。投入生产后可以新增 Schema 版本并重建投影，但不能删除旧条目。重新启用 Pi 默认 Compaction 需要新的替代 ADR 和全套恢复迁移方案。

## 后续工作

- 在 M0-05 证明 Pi 0.82.1 的关闭设置和消息重建 hook 稳定；
- 在 M5 固定 Rollout/Checkpoint Schema 和压缩安全边界；
- 为不同模型窗口建立策略契约。

## 实施记录

- M0-05 已通过内存 SettingsManager 关闭 Pi Compaction，并用窄 Controller 隐藏原始 Session 与手工 compact 入口。
- Linux Faux Provider 测试验证逻辑 `/workspace`、零宿主路径、无 Compaction 入口/事件；Windows 测试验证平台保护在 Session 创建前失败。后续 M5 仍需实现 Runtime 自有检查点与恢复策略。
