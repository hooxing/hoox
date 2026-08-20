# Hoox 文档中心

本目录描述 Hoox 的**当前行为和维护方式**。历史 ADR、实施计划与验证记录用于解释演进过程，不应替代当前架构、开发或运维文档。

## 按角色阅读

### 使用者与集成者

1. [项目状态](project-status.md)：确认当前成熟度和已知缺口。
2. [架构总览](architecture/overview.md)：理解 Hoox 解决的问题和核心运行链路。
3. [开发环境准备](development.md)：在本地启动完整 development 链路。
4. [配置参考](reference/configuration.md)：按服务配置 PostgreSQL、对象存储、Sandbox 与模型。
5. [开发 API 契约](reference/development-api.md)：了解本地 Web 和集成入口。

### 贡献者

1. 仓库根目录的[贡献指南](../CONTRIBUTING.md)。
2. [仓库导览](architecture/repository-map.md)：确定改动应落在哪个应用或包。
3. [命令参考](reference/commands.md)：选择与改动范围相符的验证命令。
4. [架构决策规则](decisions/README.md)：只在触及长期边界时新增 ADR。
5. [项目路线图](roadmap.md)：了解阶段目标，不把未勾选计划误认为当前承诺。

### 维护者与运维者

1. [生产就绪说明](operations/production-readiness.md)。
2. [生产发布清单](../deploy/production-release-checklist.md)。
3. [内部诊断指南](maintainers/diagnostics.md)。
4. [Thread 连续上下文运维](operations/thread-continuity.md)。
5. [供应链证据](../supply-chain/README.md)。
6. [首次公开发布检查清单](maintainers/open-source-release-checklist.md)。

## 文档类型

| 类型 | 目录或文件 | 权威范围 |
| --- | --- | --- |
| 当前说明 | `architecture/`、`reference/`、`operations/`、`development.md` | 描述当前代码与操作方式，发现漂移必须优先修正 |
| 项目状态 | `project-status.md`、`roadmap.md` | 前者描述当前成熟度，后者描述阶段目标 |
| 规范 | `specs/` | 跨模块功能的目标契约 |
| 架构决策 | `decisions/` | 记录为什么选择当前方案以及替代关系 |
| 实施计划 | `plans/` | 任务拆解和迁移顺序，可能被后续 ADR 或实现替代 |
| 验证记录 | `verification/`、`spikes/`、`gaia-native-evaluation.md` | 某次实验或验收的时间点证据，不自动代表持续保证 |
| 历史参考 | `archive/` | 不再作为当前实现入口，只保留追溯价值 |


## 分类入口

- [架构](architecture/README.md)
- [开发专题](development/README.md)
- [参考](reference/README.md)
- [运维](operations/README.md)
- [维护者](maintainers/README.md)
- [功能规范](specs/README.md)
- [实施计划](plans/README.md)
- [架构决策](decisions/README.md)
- [Spike](spikes/README.md)
- [验证与评测](verification/README.md)
- [历史资料](archive/README.md)
## 文档维护原则

- 根 README 只负责项目定位、最短启动路径和导航。
- 当前行为写入主题文档，不要求读者通过 ADR 拼装现状。
- ADR 一经接受不改写历史结论；改变结论时新增替代 ADR。
- 实施计划完成、废弃或被替代后，应保留历史标记并从主要导航降级。
- 命令、路径、端口和环境变量必须能从仓库当前文件验证。
- 不在文档、示例、日志或截图中写入真实凭据、生产数据和内部服务秘密。

## 快速索引

- [项目状态](project-status.md)
- [开发指南](development.md)
- [架构总览](architecture/overview.md)
- [仓库导览](architecture/repository-map.md)
- [配置参考](reference/configuration.md)
- [命令参考](reference/commands.md)
- [开发 API 契约](reference/development-api.md)
- [生产就绪说明](operations/production-readiness.md)
- [诊断指南](maintainers/diagnostics.md)
- [架构决策](decisions/README.md)
- [实施路线](roadmap.md)
- [历史资料说明](archive/README.md)
- [项目治理](../GOVERNANCE.md)
- [变更记录](../CHANGELOG.md)
