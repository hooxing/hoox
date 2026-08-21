# 维护者文档

| 文档 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- |
| [Runtime 开发边界](runtime-development-boundaries.md) | 修改进程装配、数据库权限、Skill 发布或内部 HTTP 边界时 | 哪些实现不变量、真实基础设施测试和最小权限要求必须保留 |
| [Development 诊断指南](diagnostics.md) | 排查模型报文、工具调用或内部轨迹时 | 如何受控启用诊断，敏感数据如何限制、查看和清理 |
| [首次公开发布检查清单](open-source-release-checklist.md) | 准备首次公开仓库和 GitHub 组织设置时 | 哪些仓库内 Gate 已完成，哪些平台操作仍需维护者执行 |

这些文档包含普通使用者不需要的装配、权限、失败和诊断细节。首次配置和日常启动见[开发环境准备](../development.md)，公开接口见[Development API](../reference/development-api.md)。
