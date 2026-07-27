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
