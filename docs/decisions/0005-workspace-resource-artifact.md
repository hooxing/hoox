# ADR-0005：Thread Workspace、Resource 与 Artifact

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M2、M3、M4
- 替代关系：无

## 背景

多数新任务不需要自动加载历史文件；同一 Thread 又需要延续工作目录，跨 Thread 偶尔需要复用上传文件或既有成果。过程文件与用户最终交付物的体验和生命周期也不同。

## 决策驱动因素

- 避免把所有历史文件默认传给模型或 Sandbox；
- 同一 Thread 连续工作不应反复导入自己的文件；
- 跨 Thread 复用必须稳定、可审计且不改写来源历史；
- 用户需要直接看到和下载 Agent 选择的最终交付物。

## 备选方案

### 方案 A：Tenant 共享一个可写 Workspace

查找文件简单，但 Thread 互相污染，并发、权限和恢复边界不清楚。

### 方案 B：每个 Thread 一个 Workspace，Resource 负责跨 Thread，Artifact 负责正式交付

对象更多，但每种对象只有一个清晰职责。

### 方案 C：每个 Run 独立目录，完成后全部发布

隔离简单，但同 Thread 连续性差，临时文件会污染交付和跨 Thread 搜索。

## 选择

采用方案 B：

- 一个 Thread 持有一个逻辑 Workspace；其多次 Run 延续 latest WorkspaceRevision；
- 新 Thread 的 Workspace 为空，只有第一次文件/代码工具调用才物化 Sandbox 工作副本；
- Resource Library 是 Tenant 内跨 Thread 的发现和复用边界，不是共享可写目录；搜索先返回有限元数据，预览按需读取局部内容，导入后在目标 Workspace 形成独立版本；
- 用户上传和 FileSource 快照先生成 ResourceVersion；Artifact 发布自动关联 ResourceVersion；其他过程文件只有 Agent 显式调用 `promote_resource` 才进入跨 Thread 搜索；
- Artifact 是不可变发布记录，由 Agent 调用 `publish_artifact` 显式选择。必需 Artifact 发布失败时，Agent 修正并重试；未全部成功不能完成 Run；
- 首版保证私有、安全下载。在线预览、用户手动提升和真实 FileSource 连接器后置。

Sandbox 可以在同 Thread 内短期保温，首版默认 10 分钟、每 Thread 最多一个 warm Session；但正确性只依赖 Revision，不能依赖变量或进程仍存在。

## 理由

该选择把“当前任务工作状态”“跨任务可复用内容”“对用户正式交付”拆成三个生命周期，既避免自动加载历史，也保留连续工作和直接下载体验。

## 影响

### 正面影响

- 纯文本任务不创建 Sandbox 或传输文件；
- 普通过程文件不会污染跨 Thread 搜索和最终交付区域；
- 来源、导入、修改和发布形成清晰 lineage。

### 负面影响与成本

- 需要 Workspace/Resource/Artifact 三套元数据和服务；
- 导入、提升、发布都要处理幂等和跨存储补偿；
- Agent 提示词和工具契约必须教会模型显式发布。

### 安全、数据与运维影响

所有路径是 Workspace 内安全相对路径。Resource 搜索、预览、导入和 Artifact 下载每次都继承可信 Tenant Context。未提升过程文件仍保留在来源 Thread Revision，但不会出现在默认跨 Thread 结果。

## 验证

- 纯文本 Run 的 Sandbox 创建次数为零；
- 同 Thread 第二个 Run 可见前一 Revision，新 Thread 默认不可见；
- Thread B 导入 Thread A 的 ResourceVersion 后独立修改，不改变 A；
- 未提升过程文件搜索不到，显式提升后可找到；
- `publish_artifact` 路径穿越、幂等、版本和失败修正场景全部通过；
- 最终界面只展示 Deliverable，不混排 Trace 和 Workspace 检查点。

## 可逆性与回退

预览和提升 UI 可以按 Feature Flag 回退。Workspace 与 Resource 的所有权或 Artifact 不可变语义一旦产生生产数据就难以回退，必须在首个 Schema 前固定。

## 后续工作

- 确定 Manifest、对象键、路径规则和 lineage Schema；
- 建立上传、预览、导入、提升和发布工具契约；
- 用真实费用和命中率数据再优化 Sandbox TTL。

## 实施记录

- 尚未实施；首版范围由 ADR-0007 进一步约束。
