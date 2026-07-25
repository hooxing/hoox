# Python 原型参考行为清单

## 使用边界

旧仓库 `cubesandbox-agent-lab` 是教学原型，只用于理解已经探索过的行为和风险。本仓库不修改、调用或打包其 Python 代码，不读取旧 JSON/JSONL 数据，不迁移旧 Run/Artifact，也不解析 `workspace.tar.gz`。

下表中的“保留”表示保留用户可观察语义或安全原则，并用全新 TypeScript 领域模型重新实现；不表示复制 Python 类型、事件名、目录布局或测试代码。

## 行为取舍

| 原型行为 | 结论 | 新实现处理 | 目标验证 |
|---|---|---|---|
| Agent 按“规划—工具—Observation—再规划”循环直到完成 | 保留 | 由 Pi AgentSession 承担通用工具循环，Runtime 保存执行事实 | Fake Provider 多轮工具场景 |
| 动作参数白名单、未知工具和多余字段被拒绝 | 保留 | 工具 Schema 加 Runtime 运行时校验，模型不能扩大权限 | 工具契约与模糊测试 |
| 最大步骤预算耗尽后明确失败 | 保留 | 升级为 Run/Agent 预算，形成稳定错误和审计事件 | 预算边界测试 |
| 生命周期和工具事件按顺序流式展示 | 重新设计 | 使用版本化 Rollout/Event Schema、序列号和可恢复 SSE 游标 | 断线重连与顺序测试 |
| 工具异常作为受限 Observation 回给模型 | 保留 | 按错误分类决定可修正、可重试、等待用户或失败；完整错误进入受控 Trace | 错误映射和敏感信息扫描 |
| Shell 固定在 Sandbox Workspace 中运行 | 保留 | 所有代码和文件工具经过 Tool Router 与 CubeSandbox SDK；不注册宿主机工具 | 宿主机逃逸与工作目录测试 |
| 路径拒绝绝对路径、`..`、反斜线逃逸和空路径 | 保留 | 使用统一安全相对路径类型，并在 API、工具、归档/上传边界重复校验 | 路径穿越参数化测试 |
| Shell、单次写入、工具输出和事件内容有硬上限 | 重新设计 | 限额归入 Tool Policy；模型可见截断与完整 Trace Blob 分离 | 大输出、Blob 完整性测试 |
| 用户取消会在规划和工具边界检查，并尝试 kill Sandbox | 重新设计 | Pi abort + Tool Call 状态 + Sandbox kill；取消幂等且区分结果未知 | 调用前/中/后取消故障注入 |
| 事件对 Worker 异常只暴露安全化错误 | 保留 | 公开错误码与内部 Trace 分开，日志清除密钥和环境变量 | API 错误一致性测试 |
| 非终态 Run 在进程重启后统一标记 interrupted | 重新设计 | 使用持久 Lease/心跳进入 interrupted/recovering，再按工具和检查点判断 | 双 Worker 接管测试 |
| 取消 queued Run 不启动 Worker；重复取消幂等 | 保留 | 通过条件状态迁移和请求幂等键保证 | 并发取消测试 |
| Run 状态和事件写到本地 JSON/JSONL | 放弃 | PostgreSQL 保存状态、索引和追加式 Rollout；不提供兼容读取 | 依赖/格式扫描 |
| 以 Run ID 目录作为全部数据顶层 | 放弃 | Tenant → Thread → Run/Workspace 的领域所有权 | 所有权契约测试 |
| 每个 Run 一开始就创建一个 Sandbox | 重新设计 | 纯文本 Run 为零 Sandbox，第一次文件或代码工具时按需创建 | Sandbox 调用次数断言 |
| 每个 Run 结束后销毁 Sandbox | 重新设计 | 同 Thread 安全点可 pause 并保温 10 分钟；失败或 Revision 失效则重建 | pause/connect/recreate 测试 |
| `workspace.tar.gz` 定期导出、校验并用于恢复 | 放弃 | 使用不可变 WorkspaceManifest/WorkspaceRevision 和逐对象哈希 | 任意 Revision 重建测试 |
| tar 路径、成员类型、文件数和大小防护 | 保留 | 不保留 tar 格式，但将同类路径、数量、单文件和总量限制用于上传/物化 | 恶意文件树测试 |
| 从失败/取消 Run 新建子 Run 并恢复步骤和归档 | 重新设计 | 新消息恢复 waiting Run 或在 Thread 下建新 Run；从 Rollout 与 Revision 恢复 | 状态机和恢复测试 |
| LocalArtifactStore 与 S3ArtifactStore 可切换 | 重新设计 | 生产语义只有 PostgreSQL + 私有 S3；单测使用契约 Fake，不做本地文件持久化后端 | BlobStore 契约测试 |
| Artifact 文件名白名单、私有对象和短期预签名下载 | 保留 | 下载前再次 Tenant 授权；Artifact 指向不可变 ResourceVersion | 越权、过期和响应头测试 |
| 自动保存 `trace.json` 与整个 Workspace 归档为 Artifact | 放弃 | Diagnostic 与 Deliverable 分开；过程文件不自动成为 Artifact | UI 与生命周期测试 |
| 同名 Artifact 写入会替换记录/内容 | 放弃 | 发布后不可原地修改；重复调用幂等，内容变化产生新版本 | Artifact 版本测试 |
| Agent 只用 finish 摘要，不显式声明文件交付 | 重新设计 | `publish_artifact` + 结构化 `deliverables[]`；必需文件发布失败不能完成 | 完成协议测试 |
| SSE 断线后可按 sequence 获取终态历史 | 保留 | Rollout 游标支持重连，授权绑定 Tenant/Thread/Run | SSE 重连和越权测试 |
| 前端使用安全 DOM API 渲染不可信文本 | 保留 | Web 组件禁止不可信 HTML 注入并增加内容类型防护 | DOM/XSS 测试 |
| 上下文按字符裁剪旧步骤并保留最近步骤 | 重新设计 | 自有 Token Context Policy、窗口链和持久 Compacted Checkpoint | 多次压缩/恢复测试 |
| 长期记忆使用本地 JSONL、词项匹配、用户 opt-in | 放弃 | 首版不接 Memory；发布后通过 Tenant-aware 外部 Gateway 单独决策 | Feature Flag 与隔离测试 |
| Memory 内容带“不可信历史数据”提示 | 保留 | 未来接入时仍将检索内容视为不可信数据，不得覆盖系统指令 | Prompt 注入测试 |
| 同步、不可嵌套的受限子 Agent，共享执行器 | 重新设计 | 每个子 Agent 独立 Pi Session/Rollout，通过 Agent Control 通信，共享 Root Run 工作副本 | 上下文隔离和并发测试 |
| 子 Agent 默认关闭且需要显式启用 | 保留 | 首版默认 `explicit_request_only`，受并发、深度和预算限制 | 策略与配额测试 |
| OpenAI 兼容模型支持 Tool Call 和 JSON fallback | 重新设计 | Provider/协议由 Pi 承担，Runtime 只依赖规范化事件；不把 JSON fallback 固定为业务协议 | Provider 契约测试 |
| 模型看到完整历史步骤和工具结果 | 放弃 | 只投影活动上下文，完整执行事实保留在 Rollout/Trace | Prompt 大小断言 |

## 不形成新契约的原型常量

原型中的最大步数、1 MB 单次写入、20,000 字符输出、归档文件数/大小、固定目录名和具体事件名称都只是风险提示，不自动成为首版默认值。每项正式限制应在 Tool Policy、配额或协议任务中根据真实 CubeSandbox、模型窗口和产品需求重新确定并记录理由。

## 参考完成标准

- 新测试不得导入 `cube_agent_lab` 或调用 Python；
- 被标记“保留”的行为至少对应一个 TypeScript 场景或契约测试；
- 被标记“重新设计”的行为必须引用目标 ADR/任务，不兼容旧格式；
- 被标记“放弃”的格式和调用链必须由依赖扫描证明未进入生产包。
