# 部署测试已复核问题的修复验证

本文记录 2026-09-05 在 `codex/fix-deployment-reviewed-issues` 分支对[部署体验测试](2026-09-05-deployment-ux-test.md)中用户指定问题的修复证据，不代表线上已部署或重新验收。

## 范围与结果

- 文字草稿刷新恢复、发送失败或拒绝后保留、账号与空间隔离，以及退出清理。
- 团队中心展示可选择复制的用户 ID；同名定时任务目标使用创建时间与完整 ID 区分。
- 个性化弹窗支持 Esc、焦点循环与关闭后恢复焦点。
- 后台以服务端部署类型判断身份配置适用性；已启用托管模型但未启用长期记忆时，不将 Mem0 密钥计入就绪分母。
- Migration 0058 恢复 FORCE RLS 下的受限跨 Tenant 统计和用户目录计数，不增加控制角色底表权限。决策见[后台投影与 FORCE RLS](../decisions/20260905180644-admin-projection-forced-rls.md)。

交互与配置修复分别提交为 `f299c9d`、`946be3d`。相关单元与界面测试累计 119 项通过；构建、类型、格式、lint 与 diff 检查通过。

## PostgreSQL 验证

使用 uu 端口映射连接真实 PostgreSQL，在集成测试创建的独立 Schema 和角色中验证。新增两个用例通过，覆盖统计与 Token 时间窗口、平台操作者状态、目录管理员限制、Runtime 租户隔离、底表完整读取拒绝、角色重绑定及 up/down/up。

完整运行 `tests/integration/postgres-core.integration.test.ts`：43 项中 41 项通过，1 项回滚场景超过默认 30 秒，1 项既有错误码断言失败。回滚场景单独使用 `--testTimeout 90000` 复跑通过，测试本体耗时约 23.4 秒。

剩余失败是“Runtime 角色不安全时在任何迁移 DDL 之前失败”：将 Runtime 与 Migrator 配为同一角色时，预期 `CONSTRAINT_VIOLATION`，实际返回 `UNEXPECTED`（角色作用域检查结果不完整）。使用 `946be3d` 的迁移入口、角色检查代码与原测试临时副本，同一断言仍失败；该检查发生在迁移 DDL 之前。未修改这一既有问题，临时副本已清理。

因此累计验证了 42 个通过的 PostgreSQL 核心用例，不能将完整套件记为全绿。其余原报告问题未修复，本分支未推送或部署。
