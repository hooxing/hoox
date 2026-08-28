# ADR-20260816203749：内部轨迹以 Thread 作为对话 Session 聚合边界

## 状态

已接受，2026-08-16。补充 ADR-20260815193622、ADR-20260815214527 与 ADR-20260815232211；不改变 Run、Attempt 或内部无损事件的持久化边界。

## 背景

Runtime 的领域模型使用 Thread 表达长期对话，使用 Run 表达一次可独立恢复、重试和审计的执行。Run 结束后，用户在同一 Thread 中发送 follow-up 会创建新的 Run；Run 活跃期间的 steer 则可能继续形成同一 Run 内的后续模型 Turn。

内部轨迹查看器首版直接枚举 `model-wire-traces/<runId>/<attemptId>`，因此把每个 Run 当成一个 DeepSeek Session。补充 Thread 标题后，同一 Thread 的多个 Run 在左侧显示成多个同名项目，而且每个 Run 的投影都从 Turn 1 重新编号。原始记录没有丢失，但展示语义错误：DeepSeek Session 更接近 Runtime Thread，而不是 Runtime Run。

## 决策驱动因素

- 一条已接受的用户输入应在完整对话中对应一个连续 Turn；
- Run 和 Attempt 必须继续作为恢复、重试、模型报文及原始 sequence 的审计边界；
- 不复制或改写已有无损轨迹文件；
- 同一 Thread 的 Run 必须按服务端创建时间稳定排序，不能依赖文件系统枚举顺序；
- Runtime API 不可用时仍需保留以单个 Run 为退化 Session 的离线查看能力；
- 组合后的记录必须能反查原始 Run、Attempt 和 sequence，并读取正确的 model wire 文件。

## 备选方案

### 方案 A：改变 Runtime，使同一 Thread 永远只使用一个 Run

可以让查看器自然连续，但会破坏 Run 独立恢复、状态机、队列和审计语义，影响面远超诊断展示，因此不采用。

### 方案 B：仍按 Run 展示，只把第二个 Run 标为“Turn 2”

编号看似连续，但左侧仍重复同一对话，搜索、统计和 Session log 仍被拆开，而且无法表达一个 Run 内已有多个 steer Turn，因此不采用。

### 方案 C：Thread 级 Session、Run/Attempt 级来源

查看器服务端按 Runtime API 返回的 `threadId` 聚合 Run；每个 Run 继续读取自己的最新 Attempt 投影；共享 trajectory 包按 Run 创建时间组合投影并增加来源定位，页面默认展示完整 Thread，同时允许切换到具体 Run/Attempt。

## 选择

采用方案 C：

1. 新增 `/api/threads` 和 `/api/threads/:threadId` 诊断接口，左侧列表按 `threadId` 聚合标题、Run 数、Attempt 数、事件数和错误数。
2. Runtime 元数据映射增加 Run `createdAt`；同一 Thread 的 Run 按 `createdAt` 升序组合，缺少元数据时使用轨迹目录时间，并退化为一个 Run 一个 Session。
3. `combineDeepSeekTrajectoryProjections` 只组合逻辑投影：非零 Turn 使用前序 Turn 数作为偏移连续编号；Turn 0 的 SYSTEM 记录合并到统一 SYSTEM 区域。
4. 组合后的记录保留原始 `sequence/sequenceEnd`，并增加 `{runId,attemptId}` 来源；记录 ID 使用来源命名空间避免不同 Run 的相同 sequence 冲突。
5. 时间线使用各 Run 活跃时长首尾拼接，不把用户两次输入之间的空闲等待算作模型运行时长；token、缓存和工具统计按各 Run 最新 Attempt 求和后重新计算比率。
6. Thread 详情默认显示每个 Run 的最新 Attempt；下拉框仍允许维护者切换到任一具体 Run/Attempt进行重试诊断。
7. 检查器根据记录来源读取对应 Run/Attempt 的 model wire；Thread Session log 下载以带来源包装的原始事件数组导出。
8. 保留原 `/api/runs` 和 `/api/runs/:runId`，避免已有诊断调用立即失效。

## 理由

该方案同时尊重产品对话和执行审计两种边界：Thread 负责用户看到的连续对话，Run/Attempt 负责执行生命周期。修复只发生在只读投影和查看器，不改变 Worker 写入、数据库 schema、队列、恢复或 Provider 协议。

## 影响

### 正面影响

- 同一 Thread 不再在左侧出现多个同名项目；
- Run 结束后的第二条用户消息会显示为 Turn 2，而不是另一个 Session 的 Turn 1；
- 同一 Run 内 steer 产生的多个 Turn 与跨 Run follow-up 使用同一连续编号；
- 仍可定位每条逻辑记录的 Run、Attempt、原始 sequence 和模型报文。

### 负面影响与成本

- Thread 详情需要读取该 Thread 多个 Run 的轨迹，响应体和初次渲染成本高于单 Run；
- 默认聚合只选每个 Run 的最新 Attempt，旧 Attempt 需要通过下拉框单独查看；
- 活跃时长拼接后的时间线不表达用户消息之间的真实墙钟空闲间隔，这是为了避免长时间闲置压缩有效模型步骤。

## 安全与数据

不新增写接口、数据库权限或生产依赖。Thread/Run 映射仍只通过回环 development API 获取，浏览器不会收到 development Authorization。组合记录只增加 Run/Attempt ID，不增加新的模型正文或用户正文采集。

## 验证

- trajectory 单元测试覆盖两个 Run 的 Turn 1 合并为 Thread Turn 1、Turn 2，并验证来源、时间偏移及统计求和；
- trajectory-web 测试覆盖两个 Run 聚合为一个 Thread 列表项、按 createdAt 排序，以及详情中的连续 Turn；
- 保留原 Run API 测试，验证兼容路径；
- 对生成后的内联脚本执行 JavaScript 语法检查，并通过真实本地 Runtime API 验证重复标题 Thread 已聚合。

## 可逆性

可让前端恢复调用 `/api/runs` 并删除 Thread 组合接口与共享组合函数；原始轨迹文件、Runtime 数据和 Run/Attempt schema 均未改变，无需数据迁移。已导出的 Thread Session log 是只读诊断文件，不影响回退。
