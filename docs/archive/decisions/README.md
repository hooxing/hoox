# 历史架构决策

本目录保存已经完全被替代，或从未被接受而后续方案已经落地的 ADR。它们保留当时的背景、备选和失败教训，只用于追溯，不再指导当前实现。

当前行为先查[架构说明](../../architecture/overview.md)和[完整决策目录](../../decisions/catalog.md)。若历史正文与当前说明或替代 ADR 不一致，以当前说明和替代记录为准。

| 历史记录 | 退出当前决策集的原因 | 当前入口 |
| --- | --- | --- |
| [ADR-0036：waiting 恢复事实由已完成副作用证明推导](0036-waiting-recovery-proof-derived-facts.md) | 普通 proof 不能证明受控适配器执行 | [ADR-0037](../../decisions/0037-waiting-recovery-capability-and-append-only-rollback.md) |
| [ADR-0049：受审生产进程装配与 Worker 运行边界](0049-audited-production-worker-assembly.md) | JavaScript 包内 capability 的安全声明不成立 | [ADR-0054](../../decisions/0054-production-transport-and-reproducible-release.md)与[ADR-0142](../../decisions/0142-dynamic-worker-tenant-assignment.md) |
| [ADR-0065：Runtime Compaction 候选语义](0065-runtime-compaction-checkpoint-and-replacement-history.md) | 提议未独立接受，后续实施 ADR 已收口 | [ADR-0068](../../decisions/0068-runtime-owned-persistent-compaction.md) |
| [ADR-0066：Thread Sandbox Session 生命周期候选](0066-thread-sandbox-session-lifecycle.md) | 阶段 0 候选由实施 ADR 收口 | [ADR-0069](../../decisions/0069-thread-sandbox-session-lifecycle-implementation.md) |
| [ADR-0097：development PPTX Skill 测试目录发布](0097-development-pptx-skill-fixture.md) | 专有 fixture 分发方案退出开源边界 | [ADR-20260827174210](../../decisions/20260827174210-open-source-distribution-license-and-security-gates.md) |
| [ADR-20260816002622：项目身份迁移为 AISay Runtime](20260816002622-aisay-runtime-project-identity.md) | AISay 技术身份被统一 Hoox 身份替代 | [ADR-20260818144124](../../decisions/20260818144124-unify-project-identity-as-hoox.md) |
| [ADR-20260816110030：Windows development 非首次一键启动](20260816110030-windows-development-one-click-startup.md) | 本机启动边界被多机外部依赖预检替代 | [ADR-20260816152234](../../decisions/20260816152234-multi-machine-external-service-preflight-and-optional-skill-startup.md) |
| [ADR-20260816114151：Hoox 产品名与 AISay 技术底座](20260816114151-hoox-agent-product-brand.md) | 产品名与技术底座的双重身份被统一 | [ADR-20260818144124](../../decisions/20260818144124-unify-project-identity-as-hoox.md) |
| [ADR-20260826164658：Provider 工具顶层 object Schema](20260826164658-provider-object-tool-schema.md) | 双层 Schema 方案先被单一 Schema 替代，随后重新按 Provider/Runtime 分层 | [ADR-20260828113059](../../decisions/20260828113059-automation-tool-schema-and-error-semantics.md) |

归档只改变导航和权威级别，不改写历史正文中的原始结论。新增替代记录时，应更新当前 ADR、被替代 ADR、本索引和完整目录。
