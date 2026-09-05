# 验证记录

本目录保存特定提交、环境和时间点的验收证据。需要判断当前行为时先读对应架构、参考或运维文档；持续保证由自动化测试和 CI 提供。

| 文档 | 何时使用 | 证据范围 |
| --- | --- | --- |
| [部署版本体验与功能测试](2026-09-05-deployment-ux-test.md) | 复查工作台、管理端的布局、交互、配置与真实任务验收问题 | 2026-09-05 部署时点、实测范围和待复核项 |
| [Workspace Artifact 端到端验证](2026-07-30-workspace-artifact-e2e.md) | 追溯 Workspace 到 Artifact 纵向链路的早期验收 | 文档记录的提交与环境 |
| [GAIA Runtime 原生评测](gaia-native-evaluation.md) | 比较特定模型、工具和 Runtime 配置下的 GAIA 结果 | 文档记录的评测配置，不代表未来版本持续结果 |
| [Spike 记录](../spikes/README.md) | 查找实现前的能力实验和风险验证 | 对应实验时点 |
