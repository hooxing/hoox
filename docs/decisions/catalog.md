# 架构决策目录

本目录按文件名列出全部历史决策。状态与替代关系以 ADR 正文为准；历史四位编号和重复编号不改名，新 ADR 统一使用北京时间时间戳。

| 决策 | 状态 | 日期 |
| --- | --- | --- |
| [ADR-0001：TypeScript 工程与质量基线](0001-typescript-engineering-baseline.md) | 已接受 | 2026-07-26 |
| [ADR-0002：领域对象、所有权与不可变性](0002-domain-ownership-and-immutability.md) | 已接受 | 2026-07-26 |
| [ADR-0003：PostgreSQL 与 S3/MinIO 持久化边界](0003-postgresql-and-object-storage.md) | 已接受 | 2026-07-26 |
| [ADR-0004：全 TypeScript、Pi 与 CubeSandbox 技术边界](0004-typescript-pi-cubesandbox-boundary.md) | 已接受 | 2026-07-26 |
| [ADR-0005：Thread Workspace、Resource 与 Artifact](0005-workspace-resource-artifact.md) | 已接受 | 2026-07-26 |
| [ADR-0006：禁用 Pi 默认 Compaction 并使用自有 Context Policy](0006-runtime-context-policy.md) | 已接受 | 2026-07-26 |
| [ADR-0007：首个可发布版本范围与后置能力](0007-first-release-scope.md) | 已接受 | 2026-07-26 |
| [ADR-0008：CubeSandbox Node SDK vendoring 与供应链](0008-cubesandbox-sdk-supply-chain.md) | 已接受 | 2026-07-26 |
| [ADR-0009：PostgreSQL 核心 Schema、迁移与并发写入](0009-postgresql-core-schema-and-concurrency.md) | 已接受 | 2026-07-26 |
| [ADR-0010：对象存储客户端 SDK 选择](0010-object-storage-sdk-selection.md) | 已接受 | 2026-07-26 |
| [ADR-0011：Run Worker 双栅栏、ExecutionAttempt 与恢复 Saga](0011-run-worker-reliability-boundary.md) | 已接受（2026-07-26 审查后重写） | 2026-07-26 |
| [ADR-0012：PostgreSQL Stable Blob 生命周期与副作用证明](0012-postgresql-blob-lifecycle.md) | 已接受 | 2026-07-26 |
| [ADR-0013：Fastify HTTP API 与可信 Tenant Context](0013-fastify-http-api-and-trusted-context.md) | 已接受 | 2026-07-26 |
| [ADR-0014：PostgreSQL Run Worker 事实源与事务实现](0014-postgresql-run-worker-state.md) | 已接受 | 2026-07-26 |
| [ADR-0015：进程生命周期、严格配置与薄装配入口](0015-process-lifecycle-and-strict-configuration.md) | 已接受 | 2026-07-26 |
| [ADR-0016：Run 输入与 Dispatch Outbox](0016-run-input-and-dispatch-outbox.md) | 已接受 | 2026-07-26 |
| [ADR-0017：Sandbox Cleanup Outbox 消费与恢复协调](0017-sandbox-cleanup-outbox-consumer.md) | 已接受 | 2026-07-26 |
| [ADR-0018：开发黑盒纵向 Gate 与 Thread 原子创建](0018-development-blackbox-e2e-gate.md) | 已接受 | 2026-07-26 |
| [ADR-0019：Workspace 清单与安全物化计划核心](0019-workspace-manifest-and-materialization-plan.md) | 已接受 | 2026-07-26 |
| [ADR-0020：Resource Library 发现、局部预览与显式导入核心](0020-resource-library-discovery-preview-import-core.md) | 已接受 | 2026-07-26 |
| [ADR-0021：Artifact 发布、完成门与授权下载核心](0021-artifact-publication-completion-and-download.md) | 已接受 | 2026-07-26 |
| [ADR-0022：Workspace 安全物化与可验证发布编排](0022-workspace-materialization-and-publication-orchestration.md) | 已接受 | 2026-07-26 |
| [ADR-0023：Resource Library PostgreSQL 目录与显式提升提交](0023-resource-library-postgresql-persistence.md) | 已接受 | 2026-07-26 |
| [ADR-0024：Artifact 工具授权、ResourceVersion 准备与生产缺口](0024-artifact-tool-authorization-and-production-gaps.md) | 已接受 | 2026-07-26 |
| [ADR-0025：全工作区清理与拓扑构建门禁](0025-clean-workspace-topological-gate.md) | 已接受 | 2026-07-27 |
| [ADR-0026：开发 API 使用真实 PostgreSQL 的最小常驻装配](0026-development-api-persistent-assembly.md) | 已接受 | 2026-07-28 |
| [ADR-0027：Artifact PostgreSQL 不可变发布与下载双重授权](0027-artifact-postgresql-persistence.md) | 已接受 | 2026-07-28 |
| [ADR-0028：CubeSandbox Workspace 可信适配边界](0028-cubesandbox-workspace-adapter-boundary.md) | 已接受 | 2026-07-28 |
| [ADR-0029：可信 Prompt 分层与 Session 能力清单](0029-trusted-prompt-and-session-capability-manifest.md) | 已接受 | 2026-07-28 |
| [ADR-0030：Runtime Rollout 与 Checkpoint 事实源](0030-runtime-rollout-checkpoint-fact-source.md) | 已接受 | 2026-07-28 |
| [ADR-0031：Blob-backed Tool Observation 截断切片](0031-blob-backed-tool-observation.md) | 已接受 | 2026-07-28 |
| [ADR-0032：Runtime Rollout 到 Pi 的恢复投影](0032-runtime-rollout-pi-recovery-projection.md) | 已接受 | 2026-07-28 |
| [ADR-0033：waiting 与 SandboxSession 恢复安全边界](0033-waiting-sandbox-recovery.md) | 已接受 | 2026-07-28 |
| [ADR-0034：M4 黑盒运行时依赖构建门禁](0034-m4-runtime-dependency-build-gate.md) | 已接受 | 2026-07-28 |
| [ADR-0035：模型感知的 Context Budget](0035-model-aware-context-budget.md) | 部分已替代（未知模型默认计数） | 2026-07-28 |
| [ADR-0036：waiting 恢复事实由已完成副作用证明推导](0036-waiting-recovery-proof-derived-facts.md) | 已替代（由 ADR-0037 替代普通 proof 信任边界） | 2026-07-28 |
| [ADR-0037：waiting 恢复能力回执与只追加回退边界](0037-waiting-recovery-capability-and-append-only-rollback.md) | 已接受 | 2026-07-28 |
| [ADR-0038：生产 Worker 的 Workspace 失败关闭边界](0038-production-worker-fail-closed-workspace-boundary.md) | 已接受 | 2026-07-28 |
| [ADR-0039：本地 Agent 工作台与公开 API 边界](0039-web-local-agent-workbench.md) | 已接受 | 2026-07-28 |
| [ADR-0040：开发 Worker 的 Windows 运行与模型就绪边界](0040-development-worker-windows-and-model-readiness.md) | 已接受 | 2026-07-28 |
| [ADR-0041：Worker 停机与工具拒绝的失败关闭边界](0041-worker-stop-and-tool-rejection-fail-closed.md) | 已接受 | 2026-07-28 |
| [ADR-0042：本地 Web 体验的 Run 事件与 Artifact 读取契约](0042-local-web-experience-read-contract.md) | 已接受 | 2026-07-28 |
| [ADR-0043：CubeSandbox 数据面缺省路由](0043-cubesandbox-proxy-default-routing.md) | 已接受 | 2026-07-28 |
| [ADR-0044：Agent 工作台三段式信息架构](0044-agent-workbench-information-architecture.md) | 已接受 | 2026-07-28 |
| [ADR-0045：Thread 最新 Run 恢复读取契约](0045-thread-latest-run-recovery-contract.md) | 已接受 | 2026-07-28 |
| [ADR-0046：Workspace manifest Runtime 闭环](0046-workspace-manifest-runtime-closure.md) | 部分接受（Worker 发布启用延期） | 2026-07-29 |
| [ADR-0047：Workspace candidate 原子交接与开发 Worker 启用](0047-workspace-candidate-atomic-handoff.md) | 已接受 | 2026-07-29 |
| [ADR-0048：Workspace Revision 到 Artifact 的原子发布闭环](0048-workspace-artifact-runtime-closure.md) | 已接受 | 2026-07-29 |
| [ADR-0049：受审生产进程装配与 Worker 运行边界](0049-audited-production-worker-assembly.md) | 已替代 | 2026-07-29 |
| [ADR-0050：生产 API 的 JWT 身份、租户选择与受审网络装配](0050-production-api-jwt-authentication.md) | 已接受 | 2026-07-29 |
| [ADR-0051：Workspace 物化失败的脱敏诊断](0051-workspace-materialization-safe-diagnostics.md) | 已接受 | 2026-07-29 |
| [ADR-0052：Artifact 工具许可与 Attempt 版本的单调边界](0052-artifact-permit-version-monotonicity.md) | 已接受 | 2026-07-30 |
| [ADR-0053：Workspace Artifact 的受限预览媒体类型](0053-workspace-artifact-preview-media.md) | 已接受 | 2026-07-30 |
| [ADR-0054：生产传输、进程边界与可复现发布制品](0054-production-transport-and-reproducible-release.md) | 已接受 | 2026-07-30 |
| [ADR-0055：模型网络报文诊断的受限保存](0055-model-wire-trace-diagnostics.md) | 已接受 | 2026-07-30 |
| [ADR-0056：模型网络报文诊断的安全读取与原始字节呈现](0056-model-wire-trace-safe-reading.md) | 已接受 | 2026-07-30 |
| [ADR-0057：单一 exec_command 与模型可见真实执行结果](0057-single-exec-command-model-observation.md) | 已接受 | 2026-07-30 |
| [ADR-0058：面向模型的单一文件交付工具](0058-simple-deliver-file-tool.md) | 已接受 | 2026-07-30 |
| [ADR-0059：在 Agent 对话中内联交付 Artifact](0059-inline-artifact-delivery-in-conversation.md) | 已接受 | 2026-07-30 |
| [ADR-0060：模型输出的安全 Markdown 展示边界](0060-safe-markdown-model-output.md) | 已接受 | 2026-07-30 |
| [ADR-0061：面向用户的运行状态体验](0061-user-focused-running-experience.md) | 已接受 | 2026-07-30 |
| [ADR-0062：简化 Web 工作台滚动与交付入口](0062-simplify-web-workspace-scrolling.md) | 已接受 | 2026-07-31 |
| [ADR-0063：Thread 单写者与持久 Follow-up 队列](0063-thread-writer-and-durable-follow-up-queue.md) | 已接受 | 2026-07-31 |
| [ADR-0064：Thread Context 事实流与活动历史](0064-thread-context-fact-stream-and-active-history.md) | 已接受（阶段 2） | 2026-07-31 |
| [ADR-0065：Runtime Compaction 检查点与 Replacement History](0065-runtime-compaction-checkpoint-and-replacement-history.md) | 提议 | 2026-07-31 |
| [ADR-0066：Thread Sandbox Session 生命周期](0066-thread-sandbox-session-lifecycle.md) | 已替代（由 ADR-0069 实施） | 2026-07-31 |
| [ADR-0067：Durable Steer 与统一 Thread 输入协议](0067-durable-steer-and-unified-thread-input.md) | 已接受（阶段 3） | 2026-07-31 |
| [ADR-0068：Runtime 持久 Compaction 实施边界](0068-runtime-owned-persistent-compaction.md) | 已接受（阶段 4） | 2026-07-31 |
| [ADR-0069：Thread Sandbox Session 生命周期实施边界](0069-thread-sandbox-session-lifecycle-implementation.md) | 已接受（阶段 5） | 2026-07-31 |
| [ADR-0070：旧 Thread 证据式 Anchor 与连续上下文灰度](0070-legacy-thread-anchor-and-continuity-rollout.md) | 已接受（阶段 6，生产数据 Gate 待完成） | 2026-07-31 |
| [ADR-0071：连续性能力默认开启、原生安全点 Steer 与对话式 UI](0071-default-on-continuity-native-steer-and-conversation-ui.md) | 已接受 | 2026-08-01 |
| [ADR-0072：模型思考流的连续性持久化与折叠展示](0072-reasoning-stream-continuity-and-disclosure.md) | 已接受 | 2026-08-01 |
| [ADR-0073：数值游标文本投影后的数据库排序边界](0073-numeric-cursor-ordering-after-text-projection.md) | 已接受 | 2026-08-01 |
| [ADR-0074：开发 Scheduler 常驻与 Sandbox lifecycle 专用超时](0074-development-scheduler-and-sandbox-lifecycle-timeout.md) | 已接受 | 2026-08-01 |
| [ADR-0075：能力感知的对话工作台信息层级](0075-capability-aware-conversation-workspace.md) | 已接受 | 2026-08-01 |
| [ADR-0076：紧凑工作状态轨道与对话视觉去重](0076-compact-work-status-track.md) | 已接受 | 2026-08-01 |
| [ADR-0077：文件上传与按需只读虚拟目录](0077-resource-upload-and-lazy-virtual-filesystem.md) | 已接受 | 2026-08-01 |
| [ADR-0078：视觉模型当前轮图片直传](0078-direct-vision-user-attachments.md) | 已接受 | 2026-08-02 |
| [ADR-0079：Cube 宿主机 ResourceFS Volume Plugin](0079-cube-resource-volume-plugin.md) | 已接受 | 2026-08-02 |
| [0080 API Blob 物理键前缀连续性](0080-api-blob-physical-key-prefix-continuity.md) | 已接受 | 2026-08-02 |
| [ADR-0081：ResourceFS 兼容 rclone 无媒体类型的 PROPFIND](0081-resourcefs-rclone-propfind-compatibility.md) | 已接受 | 2026-08-02 |
| [ADR-0082：ResourceFS rclone 进程隔离 Volume Hook 输出管道](0082-resourcefs-rclone-hook-pipe-isolation.md) | 已接受 | 2026-08-02 |
| [ADR-0083：ResourceFS Detach 只使用受信挂载根目录](0083-resourcefs-detach-trusted-path.md) | 已接受 | 2026-08-02 |
| [ADR-0084：Runtime 直接回答与显式执行授权边界](0084-runtime-direct-answer-and-explicit-execution-boundary.md) | 已接受 | 2026-08-02 |
| [ADR-0085：运行中思考正文的实时披露](0085-live-thinking-disclosure.md) | 已接受 | 2026-08-02 |
| [ADR-0086：并行工具调用的 Durable Rollout 串行化边界](0086-parallel-tool-call-durable-rollout-serialization.md) | 已接受 | 2026-08-02 |
| [ADR-0087：开发环境 Run 事件文件诊断](0087-development-run-event-file-diagnostics.md) | 已接受 | 2026-08-02 |
| [ADR-0088：recovery_required 的公开终止投影](0088-recovery-required-public-terminal-projection.md) | 已接受 | 2026-08-03 |
| [ADR-0089：思考归入对话与单一当前状态](0089-conversation-thinking-and-current-status-only.md) | 已接受 | 2026-08-03 |
| [ADR-0090：API 日志时间使用东八区可读时间](0090-api-log-timestamp-beijing.md) | 已接受 | 2026-08-03 |
| [ADR-0091：为 Agent 增加受控 read、edit、write 文件工具](0091-sandbox-read-edit-write-tools.md) | 已接受 | 2026-08-03 |
| [ADR-0092：按附件与工具信号延迟创建 Sandbox](0092-lazy-sandbox-acquisition.md) | 已接受 | 2026-08-03 |
| [ADR-0093：ResourceFS Attach 验证真实数据面](0093-resourcefs-attach-data-plane-readiness.md) | 已接受 | 2026-08-03 |
| [ADR-0094：Skill Center 全局用户安装与受管目录边界](0094-skill-center-user-installation.md) | 已接受 | 2026-08-03 |
| [ADR-0095：Skill Runtime 快照、后端注入与延迟物化](0095-skill-runtime-snapshot-and-lazy-materialization.md) | 已接受 | 2026-08-03 |
| [ADR-0096：Skill Center 主导航入口位置](0096-skill-center-primary-navigation-placement.md) | 已接受 | 2026-08-03 |
| [ADR-0097：development PPTX Skill 测试目录发布](0097-development-pptx-skill-fixture.md) | 已被 ADR-20260827174210 替代 | 2026-08-03 |
| [ADR-0098：Worker Skill Blob 读取上限与预检一致性](0098-worker-skill-blob-size-boundary.md) | 已接受 | 2026-08-04 |
| [ADR-0099：Skill 恢复查询的 PostgreSQL 稳定排序](0099-skill-recovery-stable-ordering.md) | 已接受 | 2026-08-04 |
| [ADR-0100：Provider 可见历史过滤与 DeepSeek V4 精确 Tokenizer](0100-provider-visible-history-and-deepseek-tokenizer.md) | 部分已替代（模型输出配置、未知模型失败关闭） | 2026-08-04 |
| [ADR-0101：Sandbox acquire 显式使用 Lifecycle 超时](0101-sandbox-lifecycle-acquire-timeout.md) | 已接受 | 2026-08-04 |
| [ADR-0102：确定性 Sandbox 创建失败直接终止 Run](0102-definitive-sandbox-create-failure.md) | 已接受 | 2026-08-04 |
| [ADR-0103：一次性 Sandbox 按附件需求挂载 Resource Volume](0103-resource-volume-demand-signal.md) | 已接受；Thread Session 限制已由 ADR-0107 取代 | 2026-08-04 |
| [ADR-0104：活跃 Sandbox 存活窗口与命令数据面熔断](0104-active-sandbox-lifetime-and-exec-circuit-breaker.md) | 已接受 | 2026-08-04 |
| [ADR-0105：开发环境 ResourceFS 最小 HTTPS Sidecar](0105-development-resourcefs-https-sidecar.md) | 已接受 | 2026-08-04 |
| [ADR-0106：过期 Attempt 自动收敛与长任务 Sandbox 时限](0106-expired-attempt-convergence-and-long-running-sandbox.md) | 已接受 | 2026-08-04 |
| [ADR-0107：托管开发 ResourceFS Sidecar 与 Thread Sandbox 按需能力](0107-managed-resourcefs-sidecar-and-thread-sandbox-capability.md) | 已接受 | 2026-08-04 |
| [ADR-0107：公开 Skill 市场虚拟文件系统](0107-public-skill-market-virtual-filesystem.md) | 已接受 | 2026-08-04 |
| [ADR-0108：终态原子 Mutation 的 SERIALIZABLE 有界重放](0108-serializable-terminal-mutation-retry.md) | 已接受 | 2026-08-04 |
| [ADR-0109：Agent 回合采用有序内容块投影](0109-agent-turn-ordered-blocks.md) | 已接受 | 2026-08-04 |
| [ADR-0110：Run 心跳同步续租 Thread Sandbox](0110-thread-sandbox-lease-heartbeat.md) | 已接受 | 2026-08-05 |
| [ADR-0111：Agent 默认使用中文回答](0111-default-chinese-agent-response.md) | 已接受 | 2026-08-05 |
| [ADR-0112：受管 Skill 管理发布与独立权限面](0112-managed-skill-admin-publication.md) | 已接受 | 2026-08-05 |
| [ADR-0113：Agent Todo Writer 与运行进度清单](0113-agent-todo-writer-and-run-progress.md) | 部分已替代（首次快照状态） | 2026-08-05 |
| [ADR-0114：Skill Front Matter 元数据预填](0114-skill-frontmatter-metadata-prefill.md) | 已接受 | 2026-08-05 |
| [ADR-0115：系统兼容性、可选上游来源与 Skills CLI 导入边界](0115-system-compatibility-optional-provenance-and-skills-cli.md) | 已接受 | 2026-08-05 |
| [ADR-0116：超长用户请求的对话布局边界](0116-long-user-request-layout-boundary.md) | 已接受 | 2026-08-06 |
| [ADR-0117：超长用户请求默认折叠](0117-long-user-request-default-collapse.md) | 已接受 | 2026-08-06 |
| [ADR-0118：历史任务文件虚拟目录与个人/团队任务归属](0118-history-files-virtual-directory-and-task-ownership.md) | 已接受 | 2026-08-07 |
| [ADR-0119：个人历史文件虚拟目录首期范围](0119-personal-history-files-first-release-scope.md) | 已接受 | 2026-08-07 |
| [ADR-0120：个人历史文件虚拟目录实现切片](0120-personal-history-filesystem-implementation-slice.md) | 已接受 | 2026-08-07 |
| [ADR-0121：personal Thread 低成本标题 Outbox 与异步目录就绪](0121-low-cost-thread-title-generation.md) | 已接受 | 2026-08-07 |
| [ADR-0122：共享 Sandbox 的 SubAgent 控制面](0122-shared-sandbox-subagent-control-plane.md) | 已接受 | 2026-08-05 |
| [ADR-0123：SubAgent 工具调用身份与持久生命周期](0123-subagent-tool-call-identity-and-durable-lifecycle.md) | 已接受 | 2026-08-06 |
| [ADR-0124：SubAgent 执行链路事务并发冲突重试](0124-subagent-control-serializable-retry.md) | 已接受 | 2026-08-06 |
| [ADR-0125：SubAgent 历史继承的单一来源](0125-subagent-history-inheritance-single-source.md) | 已接受 | 2026-08-06 |
| [ADR-0126：Root 与 Child 的 Run 事件共享编码队列](0126-root-child-run-event-sequencing.md) | 已接受 | 2026-08-06 |
| [ADR-0127：Thread 级 SubAgent 对话与 Run 级执行](0127-thread-scoped-subagent-conversation.md) | 已接受 | 2026-08-07 |
| [ADR-0128：ResourceFS 隐藏 Thread 父目录的 WebDAV 可遍历性](0128-resourcefs-hidden-thread-parent-traversal.md) | 已接受 | 2026-08-07 |
| [ADR-0129：预声明 Thread 文件系统稳定入口](0129-predeclared-thread-filesystem-entrypoint.md) | 已接受 | 2026-08-07 |
| [ADR-0130：个人历史文件云盘与输入框引用](0130-personal-history-file-library-and-composer-reference.md) | 已接受（试验分支） | 2026-08-07 |
| [ADR-0131：独立云盘入口、语义路径与无文本文件选择](0131-independent-cloud-drive-semantic-paths.md) | 已接受（试验分支） | 2026-08-08 |
| [ADR-0132：Agent 正式交付物进入个人历史云盘](0132-agent-deliverables-in-history.md) | 已接受（试验分支） | 2026-08-08 |
| [ADR-0133：自动压缩采用整窗摘要与入站输入投影](0133-auto-compaction-full-window-and-incoming-projection.md) | 已接受（试验分支） | 2026-08-09 |
| [ADR-0134：压缩沿用模型输出预算并容忍推理终态](0134-compaction-output-budget-and-terminal-parsing.md) | 已接受（试验分支） | 2026-08-09 |
| [ADR-0135：主模型输出上限有界续跑与失败现场保留](0135-model-output-limit-continuation-and-sandbox-retention.md) | 已接受（16K 主模型输出配置已由 ADR-0138 替代，长度续跑与 Sandbox 保留继续有效）（试验分支） | 2026-08-09 |
| [ADR-0136：失败回注 Agent 与 Runtime 用户终态兜底](0136-failure-reply-and-runtime-terminal-fallback.md) | 已接受（试验分支；“只回复模式”已由 ADR-0137 替代，Runtime/Web 兜底继续有效） | 2026-08-09 |
| [ADR-0137：Durable 工具失败保留能力并回传模型自适应](0137-durable-tool-failure-model-adaptation.md) | 已接受 | 2026-08-10 |
| [ADR-0138：DeepSeek V4 Flash 0731 官方 Pi 模型配置](0138-deepseek-v4-flash-official-pi-profile.md) | 部分已替代（能力固定值与装配门禁） | 2026-08-10 |
| [ADR-0139：团队工作空间、任务分支与跨空间文件快照](0139-team-workspace-and-snapshot-boundary.md) | 已接受（试验版） | 2026-08-09 |
| [ADR-0140：个人与团队双任务导航及团队中心边界](0140-dual-task-navigation-and-team-center.md) | 已接受（试验版） | 2026-08-09 |
| [ADR-0141：标签式云盘与跨空间范围搜索](0141-tabbed-cloud-drive-and-cross-scope-search.md) | 已接受（试验版） | 2026-08-09 |
| [ADR-0142：动态 Worker Tenant 分配与团队任务调度](0142-dynamic-worker-tenant-assignment.md) | 已接受（试验版） | 2026-08-10 |
| [ADR-0143：上传资源名称规范化与幂等边界](0143-upload-resource-name-canonicalization.md) | 已接受（试验版） | 2026-08-10 |
| [ADR-0144：固定模板依赖与受管 CSV 转 PDF Skill](0144-managed-csv-to-pdf-skill.md) | 已接受（试验版） | 2026-08-10 |
| [ADR-0145：Thread Sandbox 复用时 ResourceFS 数据面自检与单次冷恢复](0145-thread-sandbox-resourcefs-data-plane-recovery.md) | 已接受（试验版） | 2026-08-10 |
| [ADR-0146：团队目录个人作用域与失效 Tenant 自愈](0146-team-directory-personal-scope-recovery.md) | 已接受（试验版） | 2026-08-10 |
| [ADR-0147：团队协作使用独立数据库协调角色](0147-team-coordinator-database-role.md) | 已接受（试验版） | 2026-08-10 |
| [ADR-0148：生产 SBOM 规范化宿主平台原生可选依赖](0148-production-sbom-platform-normalization.md) | 已接受 | 2026-08-10 |
| [ADR-0149：区分 Sandbox 确定性不可用与结果未知，并执行开发数据面预检](0149-sandbox-create-unavailable-and-development-execution-probe.md) | 已接受 | 2026-08-11 |
| [ADR-0150：Worker 心跳瞬时持久层故障有界重试](0150-heartbeat-transient-persistence-retry.md) | 已接受 | 2026-08-12 |
| [ADR-0151：开发 Worker 启动前自编译应用入口](0151-development-worker-self-build.md) | 已接受 | 2026-08-12 |
| [ADR-0152：开发阶段使用 Mem0 Platform 的异步记忆边界](0152-development-mem0-platform-boundary.md) | 已接受 | 2026-08-12 |
| [ADR-0152：SubAgent 控制命令参数摘要由规范化参数派生](0152-subagent-control-command-canonical-digest.md) | 已接受 | 2026-08-12 |
| [ADR-0153：Mem0 持久写入与 User Turn 检索闭环](0153-mem0-durable-ingestion-and-user-turn-retrieval.md) | 已接受 | 2026-08-12 |
| [ADR-0153：SubAgent mailbox 显式携带终态与错误码](0153-subagent-mailbox-terminal-status.md) | 已接受 | 2026-08-12 |
| [ADR-0154：隔离集群级数据库角色并固定开发配置真源](0154-cluster-scoped-database-roles-and-development-env-source.md) | 已接受 | 2026-08-12 |
| [ADR-0154：SubAgent 摘要区分首次任务与当前任务](0154-subagent-initial-and-current-task.md) | 已接受 | 2026-08-12 |
| [ADR-0155：wait_agent 返回显式游标批次](0155-wait-agent-explicit-cursor-batch.md) | 已接受 | 2026-08-12 |
| [ADR-0156：spawn_agent 必须显式选择上下文 fork](0156-explicit-subagent-context-fork.md) | 已接受 | 2026-08-12 |
| [ADR-0157：list_agents 仅暴露稳定运行摘要](0157-list-agents-stable-runtime-summary.md) | 已接受 | 2026-08-12 |
| [ADR-0158：子 Agent 控制工具按顺序形成 Rollout 事实](0158-sequential-subagent-control-rollout.md) | 已接受 | 2026-08-12 |
| [ADR-0159：中断控制在 Turn 终态落地后返回](0159-interrupt-agent-waits-for-turn-settlement.md) | 已接受 | 2026-08-12 |
| [ADR-0160：wait_agent 强制显式传入 mailbox 游标](0160-wait-agent-required-cursor.md) | 已接受 | 2026-08-12 |
| [ADR-0161：控制工具非法参数标记必须跨结构化克隆保留](0161-clone-safe-agent-control-invalid-arguments.md) | 已接受 | 2026-08-12 |
| [ADR-0162：主动中断优先于 Pi 的 completed 收敛](0162-interrupt-precedes-pi-completed.md) | 已接受 | 2026-08-12 |
| [ADR-0163：子 Agent 控制错误分离机器码与可读说明](0163-readable-agent-control-errors.md) | 已接受 | 2026-08-12 |
| [ADR-0164：wait_agent 明确全局 mailbox 序号允许空洞](0164-wait-agent-global-mailbox-sequence-gaps.md) | 已接受 | 2026-08-12 |
| [ADR-0165：合并分支后的 Mem0 迁移顺延到 0045](0165-mem0-migration-version-after-branch-merge.md) | 已接受 | 2026-08-12 |
| [ADR-0166：团队任务导航的浏览器偏好与空会话切换边界](0166-team-navigation-browser-preference.md) | 已接受（试验版） | 2026-08-12 |
| [ADR-0167：移动云盘空间与团队选择布局](0167-mobile-cloud-drive-space-selection-layout.md) | 已接受（试验版） | 2026-08-12 |
| [ADR-0168：个人与团队个性化使用 Run 级低信任偏好快照](0168-personalization-settings-and-run-snapshot.md) | 已接受 | 2026-08-12 |
| [ADR-0169：团队成员读取在只读事务中使用无锁授权快照](0169-team-member-read-only-authorization-snapshot.md) | 已接受 | 2026-08-12 |
| [ADR-0170：以普通 Thread/Run 接入 GAIA 原生能力评测](0170-gaia-native-runtime-evaluation.md) | 已接受 | 2026-08-13 |
| [ADR-0171：对已发布的 Mem0 迁移执行受限谱系换号](0171-reconcile-published-migration-lineage.md) | 已接受 | 2026-08-13 |
| [ADR-0172：运行失败根因与取消信号必须有界收敛](0172-runtime-failure-causality-and-cancellation-convergence.md) | 已接受 | 2026-08-13 |
| [ADR-0173：外部效果许可消费的瞬时故障收敛](0173-external-effect-permit-consumption-recovery.md) | 已接受 | 2026-08-14 |
| [ADR-0174：Durable mutation 瞬时不可用的同命令重试](0174-durable-mutation-transient-unavailable-retry.md) | 已接受 | 2026-08-14 |
| [ADR-0175：扩大 durable mutation 对端口映射恢复的覆盖窗口](0175-durable-mutation-retry-window-covers-port-mapping-recovery.md) | 已接受 | 2026-08-14 |
| [ADR-0176：E2B Provider 首期 SDK 适配与生产启用边界](0176-e2b-provider-first-sdk-adapter.md) | 已接受（首期适配） | 2026-08-14 |
| [ADR-0177：Sandbox Provider 身份持久化与失败关闭路由](0177-sandbox-provider-persistence-and-routing.md) | 已接受 | 2026-08-14 |
| [ADR-0178：E2B ResourceFS 受控快照物化](0178-e2b-resourcefs-controlled-snapshot.md) | 已接受 | 2026-08-14 |
| [ADR-20260815182655：使用本地不可变诊断镜像提供内部轨迹查看器](20260815182655-local-internal-trajectory-viewer.md) | 已接受 | 2026-08-15 |
| [ADR-20260815193622：内部无损 Session 轨迹与 DeepSeek Trajectory 适配](20260815193622-lossless-internal-trajectory-and-deepseek-adapter.md) | 已接受 | 2026-08-15 |
| [ADR-20260815214527：内部无损事件与逻辑轨迹记录分层](20260815214527-internal-events-and-logical-trajectory-records.md) | 已接受 | 2026-08-15 |
| [ADR-20260815232211：内部轨迹标题与性能统计语义](20260815232211-internal-trajectory-title-and-performance-metrics.md) | 已接受 | 2026-08-15 |
| [ADR-20260816002622：项目身份迁移为 AISay Runtime](20260816002622-aisay-runtime-project-identity.md) | 已替代 | 2026-08-16 |
| [ADR-20260816110030：Windows development 非首次一键启动边界](20260816110030-windows-development-one-click-startup.md) | 已替代 | 2026-08-16 |
| [ADR-20260816114151：将用户面对的 Agent 产品命名为 Hoox](20260816114151-hoox-agent-product-brand.md) | 已替代 | 2026-08-16 |
| [ADR-20260816152234：多机开发外部服务预检与可选 Skill 启动](20260816152234-multi-machine-external-service-preflight-and-optional-skill-startup.md) | 已接受 | 2026-08-16 |
| [ADR-20260816160557：工作台本地账号入口与侧栏用户菜单边界](20260816160557-local-account-shell-and-sidebar-user-menu.md) | 已替代（账号认证部分） | 2026-08-16 |
| [ADR：使用阶段标志生成最终答复](20260816164334-final-answer-phase-marker.md) | 已被 [ADR 20260816202624](./20260816202624-optional-long-process-collapse-marker.md) 修订 | 2026-08-16 |
| [ADR-20260816165004：开发工作台使用服务端本地账号认证](20260816165004-development-local-account-authentication.md) | 已接受 | 2026-08-16 |
| [ADR：将最终答复阶段标志收窄为可选的长过程折叠工具](20260816202624-optional-long-process-collapse-marker.md) | 已接受 | 2026-08-16 |
| [ADR：Workspace Revision 排除 `node_modules` 依赖缓存](20260816232758-workspace-ignore-node-modules.md) | 已接受 | 2026-08-16 |
| [ADR：平台 Harness 显式允许长过程折叠工具](20260816233057-final-answer-harness-guidance.md) | 已接受 | 2026-08-16 |
| [ADR：同一安全点批量接纳 Durable Steer](20260817151138-safe-point-batched-durable-steer.md) | 已接受 | 2026-08-17 |
| [ADR-20260817181138：Thread 定时任务与按需 Sandbox 复用](20260817181138-thread-scheduled-tasks.md) | 已接受 | 2026-08-17 |
| [ADR-20260818001636：收敛模型网络诊断到内部轨迹查看器](20260818001636-converge-model-wire-diagnostics-to-internal-viewer.md) | 已接受 | 2026-08-18 |
| [ADR-20260818090007：定时 Run 在线发现与触发消息边界](20260818090007-scheduled-run-live-refresh-and-prompt-boundary.md) | 已接受 | 2026-08-18 |
| [ADR-20260818114734：模型可见 Prompt 元数据与工具指引去重](20260818114734-model-visible-prompt-metadata-and-tool-guidance-deduplication.md) | 已接受 | 2026-08-18 |
| [ADR-20260818140646：对话定时任务默认使用东八区](20260818140646-automation-default-timezone.md) | 已采纳 | 2026-08-18 |
| [ADR-20260818144124：统一项目身份为 Hoox](20260818144124-unify-project-identity-as-hoox.md) | 已接受 | 2026-08-18 |
| [ADR-20260819115118：思考生命周期在正文与工具边界收敛](20260819115118-thinking-lifecycle-boundary-convergence.md) | 已接受 | 2026-08-19 |
| [ADR-20260819142015：用户工作台隐藏 Workspace 未变化审计通知](20260819142015-hide-workspace-unchanged-runtime-notice.md) | 已接受 | 2026-08-19 |
| [ADR-20260819165254：独立后台控制面与版本化运行配置](20260819165254-independent-admin-control-plane.md) | 已接受（进程边界及模型配置流程已被部分替代） | 2026-08-19 |
| [ADR-20260820090402：Provider 拥有可启用的模型目录](20260820090402-provider-owned-model-catalog.md) | 部分已替代（管理页面多启用语义） | 2026-08-20 |
| [无团队成员关系时隐藏团队操作](20260820092801-hide-team-controls-without-membership.md) | 已采纳 | 2026-08-20 |
| [ADR-20260820095113：Pi 模型目录为后台配置提供可覆盖的初始值](20260820095113-pi-catalog-seeds-admin-model-metadata.md) | 已接受（模型配置流程已被部分替代） | 2026-08-20 |
| [ADR-20260820101805：浏览器内置 Pi 目录与后台配置服务独立降级](20260820101805-browser-bundled-pi-catalog-degrades-independently.md) | 已接受（模型配置流程已被部分替代） | 2026-08-20 |
| [ADR-20260820153000：项目采用 Apache License 2.0 并建立公开文档分层](20260820153000-open-source-license-and-documentation-boundary.md) | 已接受 | 2026-08-20 |
| [ADR-20260821004057：工业化后台的信息架构、运营统计与用户治理边界](20260821004057-industrial-admin-operations-and-user-governance.md) | 部分已替代（探针域名白名单展示） | 2026-08-21 |
| [ADR-20260821115221：统一后台 API 进程并保留发布资源隔离](20260821115221-unified-admin-api-process.md) | 已接受 | 2026-08-21 |
| [后台管理 Web 采用可路由的 Ant Design 应用外壳](20260824115942-admin-web-routable-ant-design-shell.md) | 已接受（模型页面工作流已被部分替代） | 2026-08-24 |
| [后台模型用量指标与开发轨迹入口边界](20260824150132-admin-model-usage-metrics-and-development-trajectory-link.md) | 已接受 | 2026-08-24 |
| [ADR-20260824222258：Demo 后台使用同源受保护路由](20260824222258-demo-admin-protected-same-origin-route.md) | 已接受（HTTP Basic 入口已被 ADR-20260825145416 部分替代） | 2026-08-24 |
| [ADR-20260825145416：Demo 后台使用 Hoox 会话闸门](20260825145416-demo-admin-uses-hoox-session-gate.md) | 已接受 | 2026-08-25 |
| [决策：领域聚合的一致性与修正语义](domain-aggregate-consistency.md) | 已接受 | 2026-07-26 |
| [决策：协议运行时 Schema 使用 TypeBox](domain-schema-library.md) | 已接受 | 2026-07-26 |
| [ADR-20260824115000：在 Hoox 进程内嵌 Better Auth 身份核心](20260824115000-embedded-better-auth-identity-core.md) | 已接受 | 2026-08-24 |
| [ADR-20260824125500：内嵌身份会话交换与后台配置边界](20260824125500-embedded-identity-session-exchange-and-admin-configuration.md) | 已接受 | 2026-08-24 |
| [ADR-20260824163556：单机 Demo 使用受控 development 装配持续部署](20260824163556-single-node-demo-continuous-deployment.md) | 已接受 | 2026-08-24 |
| [ADR-20260825093437：Thread 消息附件使用结构化展示投影](20260825093437-thread-message-attachment-projection.md) | 已接受 | 2026-08-25 |
| [ADR-20260825135525：Thread 图片预览按不可变附件身份保持稳定](20260825135525-stable-thread-attachment-preview.md) | 已接受 | 2026-08-25 |
| [ADR-20260825164722：Provider 内部标识防密钥误填与探测后启用门禁](20260825164722-provider-identifier-secret-guard-and-probe-activation-gate.md) | 部分已替代（模型启用门禁、页面流程与探针域名白名单） | 2026-08-25 |
| [ADR-20260825173500：模型 Provider 凭据按 Revision 加密托管](20260825173500-managed-model-provider-credentials.md) | 已接受（模型配置流程已被部分替代） | 2026-08-25 |
| [ADR-20260825180549：模型配置保存即启用并隐藏内部版本流程](20260825180549-direct-model-configuration-activation.md) | 部分已替代（单一页面流程） | 2026-08-25 |
| [模型页面只启用所选模型，已发布能力驱动运行](20260826000935-published-model-capabilities-are-runtime-facts.md) | 已接受 | 2026-08-26 |
| [Demo 数据 epoch 与 Provider 持久化读取边界](20260826091622-demo-data-epoch-and-stored-provider-read-boundary.md) | 已接受 | 2026-08-26 |
| [ADR-20260826115031：模型供应商采用列表、统一编辑器、真实测试与显式切换](20260826115031-model-provider-list-edit-test-switch.md) | 已接受 | 2026-08-26 |
| [ADR-20260826155935：自定义 Provider 探测直接使用已保存地址](20260826155935-custom-provider-probes-use-saved-url.md) | 已接受 | 2026-08-26 |
| [ADR-20260826164658：Provider 工具参数使用顶层 object Schema](20260826164658-provider-object-tool-schema.md) | 已替代 | 2026-08-26 |
| [ADR-20260826172009：Provider 工具 Schema 使用单一严格真源](20260826172009-single-source-provider-object-tool-schema.md) | 部分已替代（Provider/Runtime 分层） | 2026-08-26 |
| [ADR-20260827110606：未知模型使用自动 Token 估算而不阻断 Provider](20260827110606-unknown-model-token-estimator-fallback.md) | 已接受 | 2026-08-27 |
| [ADR-20260827143000：声明推理能力的模型默认启用思考](20260827143000-reasoning-model-default-thinking.md) | 已接受 | 2026-08-27 |
| [ADR-20260825105258：开发数据库角色 bootstrap](20260825105258-development-database-role-bootstrap.md) | 已接受 | 2026-08-25 |
| [ADR-20260827174210：开源分发许可证与生产供应链门禁](20260827174210-open-source-distribution-license-and-security-gates.md) | 已接受 | 2026-08-27 |
| [ADR-20260828113059：定时任务工具分离 Provider 形状与可纠正错误语义](20260828113059-automation-tool-schema-and-error-semantics.md) | 已接受 | 2026-08-28 |
| [ADR-20260828113100：Todo 首次快照允许原子进入执行状态](20260828113100-todo-initial-snapshot-can-start.md) | 已接受 | 2026-08-28 |
