# ADR-0139：Thread Sandbox 复用时 ResourceFS 数据面自检与单次冷恢复

- 状态：已接受（试验版）
- 日期：2026-08-10
- 决策者：Runtime 团队
- 关联任务/PR：`codex/team-edition-prototype`
- 替代关系：细化 ADR-0066、ADR-0107、ADR-0129；不改变 ResourceFS 授权、Thread Sandbox 生命周期状态机与 Workspace 事实源

## 背景

`thread_sandbox_sessions.resource_filesystem_mounted=true` 只能证明创建该 generation 时请求过 Tenant ResourceFS Volume，不能证明暂停、恢复或重新连接后的 Sandbox 中仍存在可读挂载。测试环境出现过数据库能力事实仍为 `true`，但复用 Sandbox 内 `/resources/history` 已消失的情况。Worker 随后在准备 `/history` 固定入口时以 `exit_71` 失败；同一 Thread 冷建 Sandbox 后路径可读，说明数据库资源关系和对象本身没有丢失，失效的是复用 generation 的数据面。

仅依赖控制面能力位会把陈旧挂载交给模型。反过来，遇到任意命令错误就无限冷建会掩盖 Provider、权限或数据库故障，并制造 generation 风暴。当前输入的直接附件还可能通过 `/resources/<resourceId>/<versionId>/<name>` 使用，即使 `/history` 根存在，也不能据此推断附件文件可读。

## 决策驱动因素

- 控制面 `resource_filesystem_mounted` 与 Sandbox 内真实数据面必须同时成立才能复用；
- 自检必须覆盖 `/resources/history`、当前 Thread 稳定目录和本轮直接附件，而不是只检查挂载根；
- 失效 generation 必须通过既有 durable terminate effect 退役，不能直接忘记数据库行或私自 kill；
- 一个 Run 最多只允许一次冷恢复，第二次缺失必须失败关闭；
- API 追加到最新 user turn 的附件路径事实仍是请求级动态数据，不能进入 system/developer prompt 或 Session 控制面表；
- API 与 Worker 必须继续使用同一个 `HISTORY_FILESYSTEM_ENABLED` 契约，不能新增一套只影响自检的独立开关。

## 备选方案

### 方案 A：继续信任数据库能力位

不增加 Sandbox 命令延迟，但能力位无法表达恢复后的 FUSE/rclone 数据面状态，已经被真实 `exit_71` 反例推翻。

### 方案 B：发现缺失后刷新或重新挂载现有 Sandbox

理论上可保留内存状态，但 Worker 没有 Cubelet Volume Plugin 的热挂载/缓存失效控制面。对同一 generation 原地修复也缺少 durable intent 和 receipt，无法区分修复成功、响应未知与迟到执行。

### 方案 C：复用前自检，明确缺失时退役并仅冷建一次

把 Sandbox 当作可丢弃缓存：先验证真实路径；明确缺失时用当前 lease 退役旧 generation，再通过 lifecycle acquire 创建更高 generation、重新挂载并复验。命令异常、未知 terminate、非冷恢复或第二次缺失均失败关闭。

## 选择

采用方案 C，并遵守以下规则。

### 自检范围

Worker 只对 `running_handoff` 或 `paused_resumed` 来源执行复用自检。命令至少验证：

1. `/resources` 是目录；
2. `HISTORY_FILESYSTEM_ENABLED=true` 时，`/resources/history` 与 `/resources/.thread-files/<可信 threadId>/files` 都是目录；
3. 当前 Run 的直接附件若带有 API 追加的结构化路径事实，则每个可信 `(resourceId, versionId)` 对应的完整文件路径都是普通文件。

附件路径从最新 user turn 最后一个受支持的附件事实区提取，并必须以 claim 中相同的 `resourceId/versionId` 前缀开头；文件名禁止额外 `/` 和控制/格式/代理码位。老 Run 只有附件 ID、没有路径事实时保持兼容，不猜测文件名。路径只进入当前 Sandbox 命令，不写日志、生命周期表或静态 prompt。

自检使用稳定退出分类：`70` 表示挂载根缺失，`71` 表示历史根缺失，`72` 表示当前 Thread 目录缺失，`75` 表示直接附件缺失。上述明确缺失允许进入一次冷恢复；其他非零退出、命令异常或超时只失败关闭，不把未知故障解释为“旧挂载已失效”。

### 单次冷恢复

明确缺失时执行以下有界流程：

1. 从当前执行上下文移除旧 lease；heartbeat 记录 renew 发出时的精确 lease 对象身份；
2. 调用 `ThreadSandboxSessionLifecyclePort.terminate`，reason 固定为 `resource_filesystem_data_plane_missing`；
3. 只有 terminate 明确返回 `settled` 才再次 acquire；`unknown` 与 `lease_lost` 都不得冷建；
4. 第二次 acquire 必须返回 `cold_created`、更高 generation、不同 sessionId、`resourceFilesystemMounted=true` 且 `requiresMaterialization=true`；
5. 在 Workspace 物化和模型启动前，对冷建 Session 复验完全相同的路径；复验失败时按既有 cleanup 退役新 Session，并把 Run 置为需要恢复，不创建第三个 generation；
6. 复验成功后才物化 Workspace、提交 materialization attestation 并准备 `/history`、`/thread-files` 固定入口。

并发 heartbeat 若已经携带旧 lease 发出 renew，其迟到的 `lease_lost` 不能把主动冷恢复后的新 generation 标为 fence lost：只有 renew 返回时该 lease 仍是执行上下文中的同一对象，失败才可投影为 `fence_lost/unavailable`。旧对象已被移除或替换时忽略其迟到结果；新 generation lease 即使仍处于冷恢复窗口，renew 失败也必须立即失败关闭。acquire、terminate 和复验任一步本身同样严格失败关闭。

### Flag 与失败边界

不新增 ResourceFS 自检开关。`THREAD_SANDBOX_SESSION_REUSE_ENABLED` 关闭时仍走一次性 Sandbox 路径；开启时所有复用 Session 都至少验证 `/resources`。历史路径只由既有 `HISTORY_FILESYSTEM_ENABLED` 控制，API 与 Worker 部署必须保持该值一致：API 开启而 Worker 关闭会漏掉历史路径自检，Worker 开启而 API 关闭会因历史命名空间不存在而失败关闭，readiness/部署配置应把二者视为同一契约。

本决策不允许全局 fail-open：数据库能力位、第一次探测成功、历史根存在或附件父目录存在，都不能替代所需路径的真实检查；也不允许因测试环境可丢弃而绕过 durable generation 退役。

## 影响

### 正面影响

- 恢复后挂载丢失会在模型和工具执行前被发现，并自动收敛到一个新 generation；
- `/resources/history` 正常但当前 Thread/附件路径失效时也能被识别；
- 冷恢复有明确上限，不会因持续故障形成无限 create/terminate 循环；
- Workspace、Thread Context、资源关系和 Blob 继续是事实源，Sandbox 仅作为可重建缓存。

### 成本与限制

- 每次 Session 复用增加一次最多 30 秒的 Sandbox 命令；正常情况只执行轻量 `stat` 类判断；
- 数据面异常会丢失旧 Sandbox 中未进入 Workspace/Context 事实源的临时内存与进程状态，这是严格恢复的预期代价；
- 老 Run 没有结构化完整路径时只能检查挂载根和历史稳定目录，无法验证带文件名的直接附件路径；
- 自检证明的是检查时刻状态，随后发生的数据面故障仍由既有工具错误和 cleanup 语义处理。

### 安全与运维

- 日志只记录稳定 category，不输出 Tenant、Thread、文件名、完整路径、Provider ID 或 lease token；
- 附件路径经过 claim 身份前缀与单段文件名校验，再用 POSIX 单引号转义进入命令，不能把用户文件名解释为 shell 代码；
- 应监控 `RESOURCEFS_REUSE_PROBE_FAILED` 分类、`resource_filesystem_data_plane_missing` 退役次数和同 Run 冷恢复失败率；持续 `exit_71/72/75` 表示 Sidecar、Volume Plugin 或目录投影仍有系统性问题。

## 验证

- Worker 单元测试证明复用路径会同时检查历史根、当前 Thread 目录与直接附件完整路径；
- `exit_71` 测试证明旧 generation 被 terminate，第二次 acquire 必须为更高 generation 的 cold create，随后重新物化并 attestation；
- 冷建复验再次 `exit_71` 时不发起第三次 acquire、不启动模型，并按 `SANDBOX_FAILED` 失败关闭；
- 并发测试证明旧 lease 的迟到 renew 失败不误伤新 generation，而新 lease 在冷恢复窗口内 renew 失败仍返回 `fence_lost`；
- 既有 Thread Sandbox handoff、pause/resume、Workspace materialization、历史固定入口与非复用 Sandbox 测试继续通过；
- 真实 Cube 黑盒应补充 pause → resume 后卸载/丢失 ResourceFS 的故障注入，确认旧 generation 退役、新 generation 挂载和附件读取闭环。

## 可逆性与回退

该变更不新增数据库列、状态或环境变量。代码回退会停止数据面自检与自动冷恢复，但已经退役/新建的 generation 都是既有生命周期合法事实，不需要数据迁移。若正常环境探测成本过高，应先调整探测实现或 Provider 能力，不得回退为信任数据库能力位后静默复用。
