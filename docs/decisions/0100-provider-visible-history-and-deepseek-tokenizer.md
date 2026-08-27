# ADR-0100：Provider 可见历史过滤与 DeepSeek V4 精确 Tokenizer

- 状态：部分已替代（16K 主模型输出配置已由 ADR-0138 替代；未知模型失败关闭由 ADR-20260827110606 替代；Provider 可见历史过滤与 DeepSeek V4 精确 tokenizer 继续有效）
- 日期：2026-08-04
- 决策者：Runtime 维护者
- 关联任务/PR：Agent 上下文误判与无效审计消息修复
- 替代关系：细化模型预算和 Thread Context 的 Provider 投影边界；未知模型失败关闭由 ADR-20260827110606 替代

## 背景

Thread Context 会持久化“本次运行未产生 Workspace revision”这一审计事实。此前投影器把所有
`runtimeNotice` 都伪装成 user 消息，导致 `workspace_unchanged` 出现在后续模型上下文、预算输入及
压缩摘要中。该事实对后续回答没有语义帮助，也不是用户原话。

同时，Worker 把 UTF-8 字节数当作 token 数。该算法是安全上界，但对中文、工具 JSON 和长历史会
产生数倍放大；当前 DeepSeek V4 实际支持 1,048,576 token 上下文，却可能在约 25K Provider
prompt token 时被本地 128K 配置和字节估算提前拒绝。

## 决策驱动因素

- 审计事实必须继续持久保存且可查询，不能为减少上下文而删除；
- Provider 可见消息、预算和压缩输入必须采用同一过滤规则；
- 当前 Worker 必须使用与 DeepSeek V4 匹配的离线 tokenizer，运行时不联网；
- 第三方模型资源必须固定版本、校验内容并保留许可证；
- 未知模型不能静默套用错误 tokenizer；
- 预算诊断必须能解释 system、工具、历史、输出保留和安全余量各自占用。

## 备选方案

### 方案 A：继续使用 UTF-8 字节安全上界

实现简单且不会低估，但会显著浪费大窗口模型的上下文，并制造错误的
`CONTEXT_TOO_LARGE`。

### 方案 B：仅根据 Provider usage 修正下一轮预算

不需要模型资源，但首轮没有 usage；不同消息增量无法稳定归因，失败请求也可能没有 usage，无法作为
请求前的 admission gate。

### 方案 C：固定并离线加载模型官方 tokenizer

请求前即可对最终上下文计数；需要维护模型到 tokenizer 的可信注册表和固定第三方资源。

## 选择

采用方案 C，并同时建立 Provider 可见历史过滤边界：

1. `workspace_unchanged` 继续存在于 durable `ThreadActiveHistoryV1`，但在进入 Pi Session、Provider
   预算、Runtime compaction token 计数和 compactor 输入前统一过滤；其他可影响恢复的
   `runtimeNotice` 仍按既有低信任形式投影。
2. Worker 根据模型 ID 从可信注册表加载 DeepSeek V4 官方 tokenizer。资源固定到
   `deepseek-ai/DeepSeek-V4-Flash` 提交
   `a7aaed80dd2df27620eb534454253ea25eb11c7a`，保存在 `runtime-ts/vendor` 并在加载时校验
   SHA-256。
3. 当前开发模型的 `MODEL_CONTEXT_WINDOW` 使用官方 1,048,576；应用仍可把最大输出限制保留在
   16,384，无需为 Provider 的 384K 理论上限预留全部输出。
4. 每次 admission 与真正 Provider 请求都会刷新 `PiSessionDiagnostics.contextBudget`，记录 tokenizer
   identity、模型窗口以及全部预算分项。
5. 未注册 tokenizer 的模型在 Worker 装配时失败关闭；包内测试入口仍可显式注入测试 tokenizer，
   通用单元测试的旧 UTF-8 上界绑定不进入实际 Worker 装配。

## 理由

过滤 durable 审计事实而非删除它，保持了审计完整性，也避免改变已存数据 schema。统一过滤函数能防止
“模型看不到但预算仍计数”或“正常请求过滤但压缩摘要再次泄漏”的分叉。官方 tokenizer 能在 Provider
调用前给出稳定、可复现的 token 数；固定资源和摘要校验避免上游内容漂移。未知模型失败关闭比使用错误
分词器后产生不可解释的 admission 决策更安全。

## 影响

- 后续模型请求不再包含 `workspace_unchanged` 伪 user 消息；
- DeepSeek V4 上下文预算从 UTF-8 字节估算切换为官方 tokenizer 计数；
- Worker 启动时会一次性读取约 6.4 MB tokenizer 资源，不会为每次 Run 重复下载或创建 Sandbox；
- 新增精确依赖 `@huggingface/tokenizers@0.1.3`；
- 若切换到未注册的新模型，Worker 会明确报 `MODEL_TOKENIZER_UNSUPPORTED`，需先增加并验证对应
  tokenizer。

## 验证

- 单元测试校验固定 DeepSeek V4 tokenizer 的中英文、emoji 和探针 token 数；
- Pi Session 测试证明 `workspace_unchanged` 不进入 Provider，而 `run_failed` 仍可见；
- Runtime compaction 测试证明审计事实不参与 token 计数或摘要输入；
- Pi 诊断测试校验完整预算分项；
- Pi Adapter、Agent Worker typecheck 及相关回归测试通过。

## 可逆性与回退

代码和 tokenizer 资源可一并回退；durable Thread Context 无需迁移。回退会重新暴露无效审计消息并恢复
UTF-8 字节误判，因此只应作为短期故障处置。模型窗口是本地未提交配置，可独立调整。

## 实施记录

- 2026-08-04：加入 Provider 可见历史过滤、DeepSeek V4 固定 tokenizer、预算诊断和回归测试。
