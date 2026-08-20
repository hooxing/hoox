# 项目状态

Hoox 目前处于 `0.x` 开发阶段。本页只描述仓库当前能够证明的能力和仍需外部验收的缺口；阶段目标见[实施路线](roadmap.md)，具体历史取舍见[架构决策](decisions/README.md)。

## 已实现的核心能力

- Tenant、Membership、Thread、Run、ExecutionAttempt、Workspace、Resource、Artifact 与 SandboxSession 等领域边界。
- PostgreSQL 持久化、事务、迁移、最小权限角色与行级安全策略。
- 开发 HTTP API、本地账号会话、固定隔离测试身份和 Web 工作台。
- Agent Worker 执行循环、持久事件、租约、恢复协调、可中断输入与连续 Thread 上下文。
- Workspace 版本、Resource 提升、Artifact 发布与 S3/MinIO Blob 生命周期。
- CubeSandbox 与 E2B Provider 路由，以及受 Tool Router 约束的沙箱能力。
- Scheduler 清理、恢复、定时任务与 Thread 标题生成。
- Skill 管理、发布目录和独立管理面。
- 内部无损轨迹、逻辑会话查看和受控模型报文诊断。
- API、Scheduler、Worker 的生产配置契约、非 root runtime-only 容器 Gate、SBOM、许可证与发布清单。

这些能力由不同层级的单元测试、跨包测试、真实 PostgreSQL 黑盒、显式外部服务冒烟或容器 Gate 覆盖。测试入口见[命令参考](reference/commands.md)。

## 当前最适合的用途

- 研究和开发可靠的 Agent Runtime 状态机。
- 在专用开发环境中验证 PostgreSQL、对象存储、模型与 Sandbox 的完整链路。
- 开发多轮对话、工具调用、文件工作区、交付物和 Skill 能力。
- 评估多租户隔离、外部副作用幂等、故障恢复与供应链门禁设计。

## 尚未完成的生产验收

仓库当前不能仅凭静态 Gate 宣称完整生产就绪，主要缺口包括：

- 面向公开产品的 Web/OIDC 身份系统和完整账号生命周期。
- 在目标 Linux 集群中连接真实 PostgreSQL、S3、Sandbox、模型和网络代理的联合 readiness。
- 完整 Tenant 越权矩阵、配额、限流、审计访问和运营权限模型。
- 对象存储/CDN 的真实 CORS、`nosniff`、CSP 与专用下载 origin 验收。
- 容量基线、故障阈值、观测告警、备份恢复与集群级回滚演练。
- 多副本 Scheduler/Worker、滚动发布和破坏性数据库迁移的生产演练。

生产使用前必须完成[生产就绪说明](operations/production-readiness.md)和目标环境自己的发布记录。

## 兼容性

- 当前版本为 `0.0.0`，公共 API、数据库 Schema 和部署契约仍可能在 ADR 与迁移说明下变化。
- 旧 Python 原型不是依赖，也不承诺数据或接口兼容。
- development 身份、回环网络限制、固定测试租户和本地账号端点不属于 production 契约。
- vendored 源码和受限开发素材适用各自许可证，不能因为位于本仓库就自动进入生产制品。

## 状态文档的维护

发生以下变化时应同步更新本页：

- 新增或删除一个可部署进程或外部依赖；
- 某项生产缺口完成真实环境验收；
- 项目开始承诺稳定 API 或发布首个正式版本；
- README 中的成熟度说明不再准确。
