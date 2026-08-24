# 运维文档

| 文档 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- |
| [生产就绪说明](production-readiness.md) | 评估部署、上线或发布证据时 | 哪些仓库 Gate 已具备，哪些目标环境验收仍必须完成 |
| [Demo 单机持续部署](demo-cd.md) | 配置或排查测试演示环境的 CD 时 | 单机拓扑、首次准备、GitHub Secrets、发布顺序、验证与回滚边界 |
| [Thread 连续上下文运维](thread-continuity.md) | 发布 Thread/Run 相关迁移或排查恢复异常时 | 如何验证迁移、Feature Flag、Anchor、指标和异常状态 |
| [生产发布清单](../../deploy/production-release-checklist.md) | 准备一次真实生产发布时 | 发布前后必须留下哪些环境、迁移、回滚和审批证据 |

运维文档必须区分仓库静态 Gate、预生产验证和真实生产证据；静态检查通过不能替代目标环境验收。
