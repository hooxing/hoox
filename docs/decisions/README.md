# 架构决策索引与记录规则

本目录保存会影响多个模块、持久数据、安全边界、公开协议或后续迁移成本的决策。ADR 是实现约束，不是一次讨论的会议纪要；决策改变时新增替代 ADR，不直接改写已经执行过的历史结论。

## 已确认决策

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [ADR-0001](0001-typescript-engineering-baseline.md) | TypeScript 工程与质量基线 | 已接受 | 2026-07-26 |
| [ADR-0002](0002-domain-ownership-and-immutability.md) | 领域对象、所有权与不可变性 | 已接受 | 2026-07-26 |
| [ADR-0003](0003-postgresql-and-object-storage.md) | PostgreSQL 与 S3/MinIO 持久化边界 | 已接受 | 2026-07-26 |
| [ADR-0004](0004-typescript-pi-cubesandbox-boundary.md) | 全 TypeScript、Pi 与 CubeSandbox 技术边界 | 已接受 | 2026-07-26 |
| [ADR-0005](0005-workspace-resource-artifact.md) | Thread Workspace、Resource 与 Artifact | 已接受 | 2026-07-26 |
| [ADR-0006](0006-runtime-context-policy.md) | 禁用 Pi 默认 Compaction 并使用自有 Context Policy | 已接受 | 2026-07-26 |
| [ADR-0007](0007-first-release-scope.md) | 首个可发布版本范围与后置能力 | 已接受 | 2026-07-26 |
| [ADR-0008](0008-cubesandbox-sdk-supply-chain.md) | CubeSandbox Node SDK vendoring 与供应链 | 已接受 | 2026-07-26 |
| [ADR-0009](0009-postgresql-core-schema-and-concurrency.md) | PostgreSQL 核心 Schema、迁移与并发写入 | 已接受 | 2026-07-26 |
| [ADR-0010](0010-object-storage-sdk-selection.md) | 对象存储客户端 SDK 选择 | 已接受 | 2026-07-26 |
| [ADR-0011](0011-run-worker-reliability-boundary.md) | Run Worker 双栅栏、ExecutionAttempt 与恢复 Saga | 已接受 | 2026-07-26 |
| [ADR-0012](0012-postgresql-blob-lifecycle.md) | PostgreSQL Stable Blob 生命周期与副作用证明 | 已接受 | 2026-07-26 |
| [ADR-0013](0013-fastify-http-api-and-trusted-context.md) | Fastify HTTP API 与可信 Tenant Context | 已接受 | 2026-07-26 |
| [ADR-0014](0014-postgresql-run-worker-state.md) | PostgreSQL Run Worker 事实源与事务实现 | 已接受 | 2026-07-26 |
| [ADR-0015](0015-process-lifecycle-and-strict-configuration.md) | 进程生命周期、严格配置与薄装配入口 | 已接受 | 2026-07-26 |
| [ADR-0016](0016-run-input-and-dispatch-outbox.md) | Run 输入与 Dispatch Outbox | 已接受 | 2026-07-26 |
| [ADR-0017](0017-sandbox-cleanup-outbox-consumer.md) | Sandbox Cleanup Outbox 消费与恢复协调 | 已接受 | 2026-07-26 |
| [ADR-0018](0018-development-blackbox-e2e-gate.md) | 开发黑盒纵向 Gate 与 Thread 原子创建 | 已接受 | 2026-07-26 |
| [ADR-0019](0019-workspace-manifest-and-materialization-plan.md) | Workspace 清单与安全物化计划核心 | 已接受 | 2026-07-26 |
| [ADR-0020](0020-resource-library-discovery-preview-import-core.md) | Resource Library 发现、局部预览与显式导入核心 | 已接受 | 2026-07-26 |
| [ADR-0021](0021-artifact-publication-completion-and-download.md) | Artifact 发布、完成门与授权下载核心 | 已接受 | 2026-07-26 |
| [ADR-0022](0022-workspace-materialization-and-publication-orchestration.md) | Workspace 安全物化与可验证发布编排 | 已接受 | 2026-07-26 |
| [ADR-0023](0023-resource-library-postgresql-persistence.md) | Resource Library PostgreSQL 目录与显式提升提交 | 已接受 | 2026-07-26 |
| [ADR-0024](0024-artifact-tool-authorization-and-production-gaps.md) | Artifact 工具授权、ResourceVersion 准备与生产缺口 | 已接受 | 2026-07-26 |
| [ADR-0025](0025-clean-workspace-topological-gate.md) | 全工作区清理与拓扑构建门禁 | 已接受 | 2026-07-27 |
| [ADR-0026](0026-development-api-persistent-assembly.md) | 开发 API 使用真实 PostgreSQL 的最小常驻装配 | 已接受 | 2026-07-28 |
| [ADR-0027](0027-artifact-postgresql-persistence.md) | Artifact PostgreSQL 不可变发布与下载双重授权 | 已接受 | 2026-07-28 |
| [ADR-0028](0028-cubesandbox-workspace-adapter-boundary.md) | CubeSandbox Workspace 可信适配边界 | 已接受 | 2026-07-28 |
| [ADR-0029](0029-trusted-prompt-and-session-capability-manifest.md) | 可信 Prompt 分层与 Session 能力清单 | 已接受 | 2026-07-28 |
| [ADR-0030](0030-runtime-rollout-checkpoint-fact-source.md) | Runtime Rollout 与 Checkpoint 事实源 | 已接受 | 2026-07-28 |
| [ADR-0031](0031-blob-backed-tool-observation.md) | Blob-backed Tool Observation 截断切片 | 已接受 | 2026-07-28 |
| [ADR-0032](0032-runtime-rollout-pi-recovery-projection.md) | Runtime Rollout 到 Pi 的恢复投影 | 已接受 | 2026-07-28 |
| [ADR-0033](0033-waiting-sandbox-recovery.md) | waiting 与 SandboxSession 恢复安全边界 | 已接受 | 2026-07-28 |
| [ADR-0034](0034-m4-runtime-dependency-build-gate.md) | M4 黑盒运行时依赖构建门禁 | 已接受 | 2026-07-28 |
| [ADR-0035](0035-model-aware-context-budget.md) | 模型感知的 Context Budget | 已接受 | 2026-07-28 |
| [ADR-0036](0036-waiting-recovery-proof-derived-facts.md) | waiting 恢复事实由已完成副作用证明推导 | 已替代 | 2026-07-28 |
| [ADR-0037](0037-waiting-recovery-capability-and-append-only-rollback.md) | waiting 恢复能力回执与只追加回退边界 | 已接受 | 2026-07-28 |
| [ADR-0038](0038-production-worker-fail-closed-workspace-boundary.md) | 生产 Worker 的 Workspace 失败关闭边界 | 已接受 | 2026-07-28 |
| [ADR-0039](0039-web-local-agent-workbench.md) | 本地 Agent 工作台与公开 API 边界 | 已接受 | 2026-07-28 |
| [ADR-0040](0040-development-worker-windows-and-model-readiness.md) | 开发 Worker 的 Windows 运行与模型就绪边界 | 已接受 | 2026-07-28 |
| [ADR-0041](0041-worker-stop-and-tool-rejection-fail-closed.md) | Worker 停机与工具拒绝的失败关闭边界 | 已接受 | 2026-07-28 |
| [ADR-0042](0042-local-web-experience-read-contract.md) | 本地 Web 体验的 Run 事件与 Artifact 读取契约 | 已接受 | 2026-07-28 |
| [ADR-0043](0043-cubesandbox-proxy-default-routing.md) | CubeSandbox 数据面缺省路由 | 已接受 | 2026-07-28 |
| [ADR-0044](0044-agent-workbench-information-architecture.md) | Agent 工作台三段式信息架构 | 已接受 | 2026-07-28 |
| [ADR-0045](0045-thread-latest-run-recovery-contract.md) | Thread 最新 Run 恢复读取契约 | 已接受 | 2026-07-28 |
| [ADR-0046](0046-workspace-manifest-runtime-closure.md) | Workspace manifest Runtime 闭环 | 部分接受（Worker 发布延期） | 2026-07-29 |
| [ADR-0047](0047-workspace-candidate-atomic-handoff.md) | Workspace candidate 原子交接与开发 Worker 启用 | 已接受 | 2026-07-29 |
| [ADR-0048](0048-workspace-artifact-runtime-closure.md) | Workspace Revision 到 Artifact 的原子发布闭环 | 已接受 | 2026-07-29 |
| [ADR-0049](0049-audited-production-worker-assembly.md) | 受审生产进程装配与 Worker 运行边界 | 已替代 | 2026-07-29 |
| [ADR-0050](0050-production-api-jwt-authentication.md) | 生产 API 的 JWT 身份、租户选择与网络装配 | 已接受 | 2026-07-29 |
| [ADR-0051](0051-workspace-materialization-safe-diagnostics.md) | Workspace 物化安全诊断 | 已接受 | 2026-07-30 |
| [ADR-0052](0052-artifact-permit-version-monotonicity.md) | Artifact 工具许可与 Attempt 版本的单调边界 | 已接受 | 2026-07-30 |
| [ADR-0053](0053-workspace-artifact-preview-media.md) | Workspace Artifact 的受限预览媒体类型 | 已接受 | 2026-07-30 |
| [ADR-0054](0054-production-transport-and-reproducible-release.md) | 生产传输、进程边界与可复现发布制品 | 已接受 | 2026-07-30 |
| [ADR-0055](0055-model-wire-trace-diagnostics.md) | 模型网络报文诊断 | 已接受 | 2026-07-30 |
| [ADR-0056](0056-model-wire-trace-safe-reading.md) | 模型网络报文诊断的安全读取与原始字节呈现 | 已接受 | 2026-07-30 |
| [ADR-0057](0057-single-exec-command-model-observation.md) | 单一 exec_command 与模型可见真实执行结果 | 已接受 | 2026-07-30 |
| [ADR-0058](0058-simple-deliver-file-tool.md) | 面向模型的单一文件交付工具 | 已接受 | 2026-07-30 |
| [ADR-0059](0059-inline-artifact-delivery-in-conversation.md) | 在 Agent 对话中内联交付 Artifact | 已接受 | 2026-07-30 |
| [ADR-0060](0060-safe-markdown-model-output.md) | 模型输出的安全 Markdown 展示边界 | 已接受 | 2026-07-30 |
| [ADR-0061](0061-user-focused-running-experience.md) | 面向用户的运行状态体验 | 已接受 | 2026-07-30 |
| [ADR-0062](0062-simplify-web-workspace-scrolling.md) | 简化 Web 工作台滚动与交付入口 | 已接受 | 2026-07-31 |
| [ADR-0063](0063-thread-writer-and-durable-follow-up-queue.md) | Thread 单写者与持久 Follow-up 队列 | 已接受 | 2026-07-31 |
| [ADR-0064](0064-thread-context-fact-stream-and-active-history.md) | Thread Context 事实流与活动历史 | 已接受（阶段 2） | 2026-07-31 |
| [ADR-0065](0065-runtime-compaction-checkpoint-and-replacement-history.md) | Runtime Compaction 检查点与 Replacement History | 提议 | 2026-07-31 |
| [ADR-0066](0066-thread-sandbox-session-lifecycle.md) | Thread Sandbox Session 生命周期 | 已替代 | 2026-07-31 |
| [ADR-0067](0067-durable-steer-and-unified-thread-input.md) | Durable Steer 与统一 Thread 输入协议 | 已接受（阶段 3） | 2026-07-31 |
| [ADR-0068](0068-runtime-owned-persistent-compaction.md) | Runtime 持久 Compaction 实施边界 | 已接受（阶段 4） | 2026-07-31 |
| [ADR-0069](0069-thread-sandbox-session-lifecycle-implementation.md) | Thread Sandbox Session 生命周期实施边界 | 已接受（阶段 5） | 2026-07-31 |
| [ADR-0070](0070-legacy-thread-anchor-and-continuity-rollout.md) | 旧 Thread 证据式 Anchor 与连续上下文灰度 | 已接受（阶段 6，生产数据 Gate 待完成） | 2026-07-31 |
| [ADR-0071](0071-default-on-continuity-native-steer-and-conversation-ui.md) | 连续性能力默认开启、原生安全点 Steer 与对话式 UI | 已接受 | 2026-08-01 |
| [ADR-0072](0072-reasoning-stream-continuity-and-disclosure.md) | 模型思考流的连续性持久化与折叠展示 | 已接受 | 2026-08-01 |
| [ADR-0073](0073-numeric-cursor-ordering-after-text-projection.md) | 数值游标文本投影后的数据库排序边界 | 已接受 | 2026-08-01 |
| [ADR-0074](0074-development-scheduler-and-sandbox-lifecycle-timeout.md) | 开发 Scheduler 常驻与 Sandbox lifecycle 专用超时 | 已接受 | 2026-08-01 |
| [ADR-0075](0075-capability-aware-conversation-workspace.md) | 能力感知的对话工作台信息层级 | 已接受 | 2026-08-01 |
| [ADR-0076](0076-compact-work-status-track.md) | 紧凑工作状态轨道与对话视觉去重 | 已接受 | 2026-08-01 |
| [ADR-0077](0077-resource-upload-and-lazy-virtual-filesystem.md) | 文件上传与按需只读虚拟目录 | 已接受 | 2026-08-01 |
| [ADR-0078](0078-direct-vision-user-attachments.md) | 视觉模型当前轮图片直传 | 已接受 | 2026-08-02 |
| [ADR-0079](0079-cube-resource-volume-plugin.md) | Cube 宿主机 ResourceFS Volume Plugin | 已接受 | 2026-08-02 |
| [ADR-0084](0084-runtime-direct-answer-and-explicit-execution-boundary.md) | Runtime 直接回答与显式执行授权边界 | 已接受 | 2026-08-02 |
| [ADR-0085](0085-live-thinking-disclosure.md) | 运行中思考正文的实时披露 | 已接受 | 2026-08-02 |
| [ADR-0086](0086-parallel-tool-call-durable-rollout-serialization.md) | 并行工具调用的 Durable Rollout 串行化边界 | 已接受 | 2026-08-02 |
| [ADR-0087](0087-development-run-event-file-diagnostics.md) | 开发环境 Run 事件文件诊断 | 已接受 | 2026-08-02 |
| [ADR-0088](0088-recovery-required-public-terminal-projection.md) | recovery_required 的公开终止投影 | 已接受 | 2026-08-03 |
| [ADR-0089](0089-conversation-thinking-and-current-status-only.md) | 思考归入对话与单一当前状态 | 已接受 | 2026-08-03 |
| [ADR-0091](0091-sandbox-read-edit-write-tools.md) | 为 Agent 增加受控 read、edit、write 文件工具 | 已接受 | 2026-08-03 |
| [ADR-0092](0092-lazy-sandbox-acquisition.md) | 按附件与工具信号延迟创建 Sandbox | 已接受 | 2026-08-03 |
| [ADR-0093](0093-resourcefs-attach-data-plane-readiness.md) | ResourceFS Attach 验证真实数据面 | 已接受 | 2026-08-03 |
| [ADR-0094](0094-skill-center-user-installation.md) | Skill Center 全局用户安装与受管目录边界 | 已接受 | 2026-08-03 |
| [ADR-0095](0095-skill-runtime-snapshot-and-lazy-materialization.md) | Skill Runtime 快照、后端注入与延迟物化 | 已接受 | 2026-08-03 |
| [ADR-0096](0096-skill-center-primary-navigation-placement.md) | Skill Center 主导航入口位置 | 已接受 | 2026-08-03 |
| [ADR-0097](0097-development-pptx-skill-fixture.md) | development PPTX Skill 测试目录发布 | 已接受 | 2026-08-03 |
| [ADR-0098](0098-worker-skill-blob-size-boundary.md) | Worker Skill Blob 读取上限与预检一致性 | 已接受 | 2026-08-04 |
| [ADR-0099](0099-skill-recovery-stable-ordering.md) | Skill 恢复查询的 PostgreSQL 稳定排序 | 已接受 | 2026-08-04 |
| [ADR-0100](0100-provider-visible-history-and-deepseek-tokenizer.md) | Provider 可见历史与 DeepSeek Tokenizer | 已接受 | 2026-08-04 |
| [ADR-0101](0101-sandbox-lifecycle-acquire-timeout.md) | Sandbox lifecycle 获取超时 | 已接受 | 2026-08-04 |
| [ADR-0102](0102-definitive-sandbox-create-failure.md) | 确定性 Sandbox 创建失败直接终止 Run | 已接受 | 2026-08-04 |
| [ADR-0103](0103-resource-volume-demand-signal.md) | 一次性 Sandbox 按附件需求挂载 Resource Volume | 已接受 | 2026-08-04 |
| [ADR-0104](0104-active-sandbox-lifetime-and-exec-circuit-breaker.md) | 活跃 Sandbox 存活窗口与命令数据面熔断 | 已接受 | 2026-08-04 |
| [ADR-0105](0105-development-resourcefs-https-sidecar.md) | 开发环境 ResourceFS 最小 HTTPS Sidecar | 已接受 | 2026-08-04 |
| [ADR-0106](0106-expired-attempt-convergence-and-long-running-sandbox.md) | 过期 Attempt 自动收敛与长任务 Sandbox 时限 | 已接受 | 2026-08-04 |
| [ADR-0107](0107-public-skill-market-virtual-filesystem.md) | 公开 Skill 市场虚拟文件系统 | 已接受 | 2026-08-04 |
| [ADR-0112](0112-managed-skill-admin-publication.md) | 受管 Skill 管理发布与独立权限面 | 已接受 | 2026-08-05 |
| [ADR-0113](0113-agent-todo-writer-and-run-progress.md) | Agent Todo Writer 与运行进度清单 | 已接受 | 2026-08-05 |
| [ADR-0114](0114-skill-frontmatter-metadata-prefill.md) | Skill Front Matter 元数据预填 | 已接受 | 2026-08-05 |
| [ADR-0115](0115-system-compatibility-optional-provenance-and-skills-cli.md) | 系统兼容性、可选上游来源与 Skills CLI 导入边界 | 已接受 | 2026-08-05 |
| [ADR-0116](0116-long-user-request-layout-boundary.md) | 超长用户请求的对话布局边界 | 已接受 | 2026-08-06 |
| [ADR-0117](0117-long-user-request-default-collapse.md) | 超长用户请求默认折叠 | 已接受 | 2026-08-06 |
| [ADR-0118](0118-history-files-virtual-directory-and-task-ownership.md) | 历史任务文件虚拟目录与个人/团队任务归属 | 已接受 | 2026-08-07 |
| [ADR-0119](0119-personal-history-files-first-release-scope.md) | 个人历史文件虚拟目录首期范围 | 已接受 | 2026-08-07 |
| [ADR-0120](0120-personal-history-filesystem-implementation-slice.md) | 个人历史文件虚拟目录实现切片 | 已接受 | 2026-08-07 |
| [ADR-0121](0121-low-cost-thread-title-generation.md) | personal Thread 低成本标题 Outbox 与异步目录就绪 | 已接受 | 2026-08-07 |
| [ADR-0122](0122-shared-sandbox-subagent-control-plane.md) | 共享 Sandbox 的 SubAgent 控制面 | 已接受 | 2026-08-05 |
| [ADR-0123](0123-subagent-tool-call-identity-and-durable-lifecycle.md) | SubAgent 工具调用身份与持久生命周期 | 已接受 | 2026-08-06 |
| [ADR-0124](0124-subagent-control-serializable-retry.md) | SubAgent 执行链路事务并发冲突重试 | 已接受 | 2026-08-06 |
| [ADR-0125](0125-subagent-history-inheritance-single-source.md) | SubAgent 历史继承的单一来源 | 已接受 | 2026-08-06 |
| [ADR-0126](0126-root-child-run-event-sequencing.md) | Root 与 Child 的 Run 事件共享编码队列 | 已接受 | 2026-08-06 |
| [ADR-0127](0127-thread-scoped-subagent-conversation.md) | Thread 级 SubAgent 对话与 Run 级执行 | 已接受 | 2026-08-07 |
| [ADR-0128](0128-resourcefs-hidden-thread-parent-traversal.md) | ResourceFS 隐藏 Thread 父目录的 WebDAV 可遍历性 | 已接受 | 2026-08-07 |
| [ADR-0129](0129-predeclared-thread-filesystem-entrypoint.md) | 预声明 Thread 文件系统稳定入口 | 已接受 | 2026-08-07 |
| [ADR-0130](0130-personal-history-file-library-and-composer-reference.md) | 个人历史文件云盘与输入框引用 | 已接受（试验分支） | 2026-08-07 |
| [ADR-0131](0131-independent-cloud-drive-semantic-paths.md) | 独立云盘语义路径 | 已接受（试验分支） | 2026-08-08 |
| [ADR-0132](0132-agent-deliverables-in-history.md) | Agent 正式交付物进入个人历史云盘 | 已接受（试验分支） | 2026-08-08 |
| [ADR-0133](0133-auto-compaction-full-window-and-incoming-projection.md) | 自动压缩采用整窗摘要与入站输入投影 | 已接受（试验分支） | 2026-08-09 |
| [ADR-0134](0134-compaction-output-budget-and-terminal-parsing.md) | 压缩沿用模型输出预算并容忍推理终态 | 已接受（试验分支） | 2026-08-09 |
| [ADR-0135](0135-model-output-limit-continuation-and-sandbox-retention.md) | 主模型输出上限有界续跑与失败现场保留 | 已接受（试验分支） | 2026-08-09 |
| [ADR-0136](0136-failure-reply-and-runtime-terminal-fallback.md) | 失败回注 Agent 与 Runtime 用户终态兜底 | 已接受（部分已替代） | 2026-08-10 |
| [ADR-0137](0137-durable-tool-failure-model-adaptation.md) | Durable 工具失败保留能力并回传模型自适应 | 已接受（试验分支） | 2026-08-10 |
| [ADR-0138](0138-deepseek-v4-flash-official-pi-profile.md) | DeepSeek V4 Flash 0731 官方 Pi 模型配置 | 已接受（试验分支） | 2026-08-10 |
| [ADR-0139](0139-team-workspace-and-snapshot-boundary.md) | 团队工作空间、任务分支与跨空间文件快照 | 已接受（试验版） | 2026-08-09 |
| [ADR-0140](0140-dual-task-navigation-and-team-center.md) | 个人与团队双任务导航及团队中心边界 | 已接受（试验版） | 2026-08-09 |
| [ADR-0141](0141-tabbed-cloud-drive-and-cross-scope-search.md) | 标签式云盘与跨空间范围搜索 | 已接受（试验版） | 2026-08-09 |
| [ADR-0142](0142-dynamic-worker-tenant-assignment.md) | 动态 Worker Tenant 分配与团队任务调度 | 已接受（试验版） | 2026-08-10 |
| [ADR-0143](0143-upload-resource-name-canonicalization.md) | 上传资源名称规范化与幂等边界 | 已接受（试验版） | 2026-08-10 |
| [ADR-0144](0144-managed-csv-to-pdf-skill.md) | 固定模板依赖与受管 CSV 转 PDF Skill | 已接受（试验版） | 2026-08-10 |
| [ADR-0145](0145-thread-sandbox-resourcefs-data-plane-recovery.md) | Thread Sandbox 复用时 ResourceFS 数据面自检与单次冷恢复 | 已接受（试验版） | 2026-08-10 |
| [ADR-0146](0146-team-directory-personal-scope-recovery.md) | 团队目录个人作用域与失效 Tenant 自愈 | 已接受（试验版） | 2026-08-10 |
| [ADR-0147](0147-team-coordinator-database-role.md) | 团队协作使用独立数据库协调角色 | 已接受（试验版） | 2026-08-10 |
| [ADR-0148](0148-production-sbom-platform-normalization.md) | 生产 SBOM 规范化宿主平台原生可选依赖 | 已接受 | 2026-08-10 |
| [ADR-0150](0150-heartbeat-transient-persistence-retry.md) | Worker 心跳瞬时持久层故障有界重试 | 已接受 | 2026-08-12 |
| [ADR-0151](0151-development-worker-self-build.md) | 开发 Worker 启动前自编译应用入口 | 已接受 | 2026-08-12 |
| [ADR-0152](0152-development-mem0-platform-boundary.md) | 开发阶段使用 Mem0 Platform 的异步记忆边界 | 已接受 | 2026-08-12 |
| [ADR-0153](0153-mem0-durable-ingestion-and-user-turn-retrieval.md) | Mem0 持久写入与 User Turn 检索闭环 | 已接受 | 2026-08-12 |
| [ADR-0166](0166-team-navigation-browser-preference.md) | 团队任务导航的浏览器偏好与空会话切换边界 | 已接受（试验版） | 2026-08-12 |
| [ADR-0167](0167-mobile-cloud-drive-space-selection-layout.md) | 移动云盘空间与团队选择布局 | 已接受（试验版） | 2026-08-12 |
| [ADR-0168](0168-personalization-settings-and-run-snapshot.md) | 个人与团队个性化使用 Run 级低信任偏好快照 | 已接受 | 2026-08-12 |
| [ADR-0169](0169-team-member-read-only-authorization-snapshot.md) | 团队成员读取在只读事务中使用无锁授权快照 | 已接受 | 2026-08-12 |
| [ADR-0170](0170-gaia-native-runtime-evaluation.md) | 以普通 Thread/Run 接入 GAIA 原生能力评测 | 已接受 | 2026-08-13 |
| [ADR-0171](0171-reconcile-published-migration-lineage.md) | 对已发布的 Mem0 迁移执行受限谱系换号 | 已接受 | 2026-08-13 |
| [ADR-0172](0172-runtime-failure-causality-and-cancellation-convergence.md) | 运行失败根因与取消信号必须有界收敛 | 已接受 | 2026-08-13 |
| [ADR-0173](0173-external-effect-permit-consumption-recovery.md) | 外部副作用许可消费中断恢复 | 已接受 | 2026-08-13 |
| [ADR-0174](0174-durable-mutation-transient-unavailable-retry.md) | Durable Mutation 瞬时不可用有界重试 | 已接受 | 2026-08-13 |
| [ADR-0175](0175-durable-mutation-retry-window-covers-port-mapping-recovery.md) | Durable Mutation 重试窗口覆盖端口映射恢复 | 已接受 | 2026-08-14 |
| [ADR-0176](0176-e2b-provider-first-sdk-adapter.md) | E2B Provider 首期 SDK 适配与生产启用边界 | 已接受（首期适配） | 2026-08-14 |
| [ADR-0177](0177-sandbox-provider-persistence-and-routing.md) | Sandbox Provider 身份持久化与失败关闭路由 | 已接受 | 2026-08-14 |
| [ADR-0178](0178-e2b-resourcefs-controlled-snapshot.md) | E2B ResourceFS 受控快照物化 | 已接受 | 2026-08-14 |
| [ADR-20260815182655](20260815182655-local-internal-trajectory-viewer.md) | 使用本地不可变诊断镜像提供内部轨迹查看器 | 已接受 | 2026-08-15 |
| [ADR-20260815193622](20260815193622-lossless-internal-trajectory-and-deepseek-adapter.md) | 内部无损 Session 轨迹与 DeepSeek Trajectory 适配 | 已接受 | 2026-08-15 |
| [ADR-20260815214527](20260815214527-internal-events-and-logical-trajectory-records.md) | 内部无损事件与逻辑轨迹记录分层 | 已接受 | 2026-08-15 |
| [ADR-20260815232211](20260815232211-internal-trajectory-title-and-performance-metrics.md) | 内部轨迹标题与性能统计语义 | 已接受 | 2026-08-15 |
| [ADR-20260816002622](20260816002622-aisay-runtime-project-identity.md) | 项目身份迁移为 AISay Runtime | 已接受 | 2026-08-16 |

## 何时必须记录

满足任一条件，就必须在合并代码前新增 ADR 或补充一条实施决策记录：

- 改变 Tenant、Thread、Run、Workspace、Resource 或 Artifact 的所有权和生命周期；
- 改变 PostgreSQL、对象存储、Rollout 或外部副作用的事实源和事务边界；
- 引入新的宿主机可执行代码、凭据流向、网络出口或第三方依赖；
- 改变公开 API、事件、工具协议、错误码、恢复或幂等语义；
- 在两个都合理的实现间选择，且错误选择会造成数据迁移、跨模块返工或安全风险；
- 偏离已经接受的 ADR，或需要把首版后置能力提前。

局部命名和可在单个提交内无损修改的实现细节，可以只写在提交说明或代码注释中。

## 决策记录流程

1. 复制 [ADR 模板](adr-template.md)，使用下一个四位编号和中文短标题。
2. 写清楚背景和约束，不把偏好的方案伪装成唯一方案。
3. 至少列出两个备选；“暂不实现”通常也是一个备选。
4. 记录选择、理由以及没有选择其他方案的原因。
5. 明确正面影响、负面影响、迁移/运维成本和安全影响。
6. 为结论指定可执行的验证证据，例如契约测试、故障注入、指标或人工审阅。
7. 标明可逆性：回退窗口、回退方法，以及一旦写入生产数据后哪些部分不可逆。
8. 在本索引追加记录，并在相关任务、Pull Request 和提交中引用 ADR 编号。

未决事项使用“提议”状态，不能被实现者当成已授权结论。实现中发现新事实时，应更新仍处于“提议”的 ADR；对于“已接受”ADR，应新增“替代”ADR保留历史。

## 状态定义

| 状态 | 含义 |
|---|---|
| 提议 | 正在收集证据，尚不能作为实现约束 |
| 已接受 | 已完成审阅，实现必须遵守 |
| 已拒绝 | 方案被明确否决，保留原因供后续参考 |
| 已替代 | 结论被新 ADR 替代，旧记录仍保留 |
| 已废弃 | 对应能力已移除，不再适用于新实现 |

## 实施决策日志

ADR 下面的细化选择也必须可追踪。无法单独形成 ADR 时，在 Pull Request 描述和提交说明中使用以下最小结构，并在相关 ADR 的“实施记录”中追加链接：

```text
背景：触发这个选择的事实和限制
备选：至少两个可行方案及其代价
选择：采用的方案
理由：为什么此时选择它
影响：接口、数据、安全、运维和后续任务变化
验证：已有证据和合并后要观察的指标
可逆性：如何回退，何时会变得难以回退
```

只写“采用某方案”不构成合格的决策记录。
