# 项目路线

本页只描述 Hoox 尚未完成的战略方向，不维护实施任务复选框。已经具备的能力和生产缺口以[项目状态](project-status.md)为准，具体实施顺序只有在形成有效计划后才进入[实施计划](plans/README.md)。历史阶段路线以 Git 历史为准。

## Agent 工具与评测

- 补齐 HTTP 工具后台发布入口。当前后台只提供单端点声明和 OpenAPI 片段的导入预览，已有运行路径不等于可发布。见[外部工具注册边界](architecture/admin-control-plane.md#外部工具注册边界)。
- 扩展评测用例来源与评分方式。[评测管理](reference/admin-evaluations.md)已支持规则断言的批量运行和版本对比；从真实对话导入用例及评审模型打分尚未启用。

## 生产验证

- 在目标 Linux 集群中完成 PostgreSQL、S3、Sandbox、模型、网络代理和最小权限 Runtime 角色的联合 readiness、关闭、故障与回滚验收。
- 建立容量基线、故障阈值、监控告警、备份恢复和多副本滚动发布证据。
- 完成对象存储与下载边界的真实 CORS、CSP、`nosniff` 和专用 origin 验收。

## 身份与治理

- 在目标环境验证现有的 [Web 登录与会话](architecture/identity-and-session.md)，并补齐账号生命周期。
- 补齐 Tenant 越权矩阵、配额、限流、审计访问和运营权限模型。
- 现有团队协作基线见[团队协作](architecture/team-collaboration.md)；邀请、成员完整生命周期、资产治理和运营策略完成后，相关能力才能进入正式发布范围。

## 部署配置的备份与恢复

- 补齐部署级配置（模型、运行设置和沙箱）的可移植备份与恢复，凭据需保持加密。[Agent YAML](reference/agent-configuration.md)只保存 Agent 配置及其引用，不能恢复部署级配置；Demo 的全局配置由[发布脚本](operations/demo-cd.md)备份和恢复。

## 运行质量

- 用真实流量校准 Context compaction、Sandbox retention、恢复延迟和外部副作用 UNKNOWN 的阈值。
- 持续验证 Provider 故障、数据库迁移、Scheduler/Worker 多副本和破坏性回滚演练。
- 新能力只有在当前说明、失败语义、自动化证据和运维入口同时具备后才视为完成。
