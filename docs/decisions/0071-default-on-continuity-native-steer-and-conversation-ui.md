# ADR-0071：连续性能力默认开启、原生安全点 Steer 与对话式 UI

- 状态：已接受
- 日期：2026-08-01
- 关联：ADR-0063、ADR-0064、ADR-0067、ADR-0068、ADR-0069、ADR-0070
- 替代：ADR-0070 中“无 Tenant policy 默认旧读路径”和“生产样例默认关闭全部连续性能力”的发布默认值
- 范围：默认配置、Tenant 缺省策略、durable steer 注入时机、Web 对话呈现与 follow-up Run 跟踪

## 背景

阶段 1～6 的结构已经实现，但首次验收发现三个产品偏差：所有进程开关和 Tenant rollout 默认关闭，部署后
仍走旧单 Run 路径；Worker 只在整个 `session.runPrompt()` 返回后读取 steer，无法利用 Pi 在完整
assistant/tool turn 后、下一次 Provider 请求前提供的原生安全点；Web 只保存一个 `currentRequest`，后到
follow-up 会覆盖仍在执行的当前请求文字，也不会在旧 Run 终态后自动追踪被激活的新 Run。

## 备选

1. 保持默认关闭，由每个环境执行手工 SQL 和开关发布。回滚风险最低，但新安装和常规部署不会获得已经
   验收的核心产品能力，容易长期停留在旧行为，因此不采用。
2. Worker 等首个 prompt 完全结束后另发第二个 prompt。实现简单且持久化清晰，但无法满足用户纠偏的
   时效，也浪费 Pi 已有的 steering queue，因此不采用。
3. 默认开启全部连续性能力；保留环境开关和显式 Tenant policy 作为降级手段；在 turn 安全点先提交完整
   assistant/tool 事实，再原子消费 durable steer，并通过 Pi 原生 steering queue 触发同一活跃 prompt
   的下一次采样；Web 使用连续消息流展示持久和待处理输入。选择此方案。

## 选择

1. API、Worker、Scheduler 在对应变量缺省时均按 `true` 解析；development/production 示例也显式为
   `true`。显式写 `false` 仍是最高优先级 kill switch，依赖链校验保持不变。
2. `0027` 把新 Tenant policy 的 schema 默认值改为 `v2_read_enabled=true`、新 Thread 10000 基点、
   legacy anchor read=true，并给迁移时已存在但无 policy 的 Tenant 补齐全量策略。没有显式 policy 的
   新 Thread 也按 10000 基点固化 profile；显式 policy 仍能按 Tenant 关闭或缩量。
3. 旧 Thread 不因全局默认开启而被伪装成新 Thread。它们仍需证据式 anchor；没有 profile 的 Thread
   不进入 V2 read。`0026` 的旧历史安全边界保持不变。
4. `onTurnSafePoint` 先提交本 turn 的 assistant/tool 配对，再读取 pending steer，并以同一 writer fence
   原子追加真实 `user_message`。Context replacement 只重建到已完成 turn 的 sequence，随后把 steer
   正文放入 Pi 原生 steering queue，避免历史 replacement 与 queue 各注入一次造成重复。
5. 安全点查询没有命中时，Run 结束边界仍保留一次 durable 查询，覆盖“输入在安全点查询之后、Pi
   settled 之前到达”的窄竞态。此回退可以另发 prompt，但不是正常 steer 主路径。
6. Web 将持久 Thread Context 和本地已接受、尚未出现在 Context stream 中的输入合并成对话流。每条
   pending steer/follow-up 在自己的用户消息气泡中显示状态；通过正文出现次数与期望序号去重，支持用户
   连续发送相同文本。当前 Run 进入终态后，客户端发现最新 Run 已变化时自动继续轮询下一 Run，不清空
   Thread 对话。

## 影响与安全

- 正面：新安装默认获得跨 Run 上下文、steer、follow-up、压缩和 Sandbox pause/resume；纠偏在下一安全
  采样点生效；UI 不再把排队任务伪装成当前任务。
- 负面：默认资源和数据库写入量高于旧路径；首次启用前必须保证 0018～0027、Scheduler 和 CubeSandbox
  pause/resume 能力同时部署。
- 安全：steer 仍不打断 Provider stream，不插入 tool call/result 中间，也不抢占已授权副作用。迁移数据
  修复只在单一 DDL 事务和表锁内暂时关闭相关 RLS，并在提交前恢复 ENABLE + FORCE；迁移安全检查负责
  阻止未恢复状态提交。

## 验证

- Worker 单元测试证明完整 turn 持久化先于 steer read，且正常路径只调用一次首 prompt、把纠偏放进
  Session steer queue。
- Pi Adapter 既有 Faux Provider 契约证明 steering queue 在完整工具 turn 后进入下一 Provider 上下文。
- Web 组件测试证明历史消息、当前 Agent 回复与 queued follow-up 同时存在于对话流。
- 配置契约和进程入口测试证明缺省及示例均默认开启，同时显式错误依赖仍失败关闭。
- 真实 PostgreSQL 集成套件必须显式设置 `RUN_PG_RUN_WORKER_INTEGRATION=true`，验证迁移、单写者、FIFO、
  steer/terminal 竞态、Sandbox handoff/pause 和 RLS；测试被跳过不算通过。

## 可逆性

环境变量或 Tenant policy 可立即关闭新读取、输入路由、压缩和 Sandbox reuse，不删除任何已写事实。
`0027 down` 只恢复 schema 默认值，不覆盖运维显式 policy，也不删除 Context/profile；一旦生产产生事实，
不得用 down migration 作为功能回滚手段。Web pending 消息是本地派生状态，可独立回退，不影响服务端事实。
