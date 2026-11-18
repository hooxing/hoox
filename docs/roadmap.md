# 项目路线

本页只描述 Hoox 尚未完成的战略方向，不维护实施任务复选框。已经具备的能力和生产缺口以[项目状态](project-status.md)为准，具体实施顺序只有在形成有效计划后才进入[实施计划](plans/README.md)。历史阶段路线以 Git 历史为准。

## 生产验证

- 在目标 Linux 集群中完成 PostgreSQL、S3、Sandbox、模型、网络代理和最小权限 Runtime 角色的联合 readiness、关闭、故障与回滚验收。
- 建立容量基线、故障阈值、监控告警、备份恢复和多副本滚动发布证据。
- 完成对象存储与下载边界的真实 CORS、CSP、`nosniff` 和专用 origin 验收。

## 身份与治理

- 将 development 本地账号替换为面向公开产品的身份和账号生命周期。
- 补齐 Tenant 越权矩阵、配额、限流、审计访问和运营权限模型。
- 现有团队协作基线见[团队协作](architecture/team-collaboration.md)；邀请、成员完整生命周期、资产治理和运营策略完成后，相关能力才能进入正式发布范围。

## 管理面

- 后台提供运行配置导出与导入：模型、运行设置和沙箱配置导出为可移植文件，凭证保持加密，用于换服务器或清库后恢复。Demo 目前由发布脚本自动备份和恢复，见 [Demo 持续部署](operations/demo-cd.md)。

## 运行质量

- 用真实流量校准 Context compaction、Sandbox retention、恢复延迟和外部副作用 UNKNOWN 的阈值。
- 持续验证 Provider 故障、数据库迁移、Scheduler/Worker 多副本和破坏性回滚演练。
- 新能力只有在当前说明、失败语义、自动化证据和运维入口同时具备后才视为完成。
