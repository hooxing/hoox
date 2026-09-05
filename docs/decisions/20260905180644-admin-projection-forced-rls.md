# 后台投影在 FORCE RLS 下的读取策略

- 状态：已接受
- 日期：2026-09-05
- 决策者：Runtime 维护者
- 关系：补充 [独立后台控制面](20260819165254-independent-admin-control-plane.md)和[运营统计与用户治理边界](20260821004057-industrial-admin-operations-and-user-governance.md)，保留两者的受限投影及权限隔离结论。

## 背景

部署测试中，已有 Thread 和 Run 的后台统计仍为零。聚合视图的拥有者 Migrator 不是超级用户，也没有 BYPASSRLS；底表启用 FORCE RLS 后，仅按 Tenant 过滤的策略使没有 Tenant 上下文的后台聚合读不到事实。用户目录计数与模型用量也受同一机制影响。

## 备选与选择

关闭 FORCE RLS 或给角色 BYPASSRLS 会扩大隔离例外；给控制服务业务底表权限会破坏受限投影边界。另建统计事实表需要新的写入、回填和一致性机制。选择保留原有视图，为其实际拥有者添加显式、只读的角色专属策略。

Migration 0058 为聚合涉及的十二张受限表添加仅面向当前 Migrator 的 SELECT 策略，并要求 `app.user_id` 对应有效平台操作者。用户会话策略另要求 admin。统计视图自身也检查有效操作者，避免其他按 Tenant 的宽松策略通过 OR 组合绕过操作者闸门；用户目录继续使用原有 admin 闸门。数据库引导将这些策略重新绑定至当前 Migrator，以支持导入和角色更换。

## 影响与可逆性

普通 Runtime 不获得跨 Tenant 读取能力；Admin Control 保持原有视图与账号治理所需有限列权限，不新增底表授权。视图不返回对话正文、密码材料或 Session 摘要。Migrator 仍是受信任的 DDL 角色，其凭据不得交给运行进程。

新增 down migration 删除这些策略并恢复原投影，回滚不会删除业务数据，但会恢复统计缺失问题。既有 migration 保持不可变。

## 验证

PostgreSQL 集成用例覆盖跨两个 Tenant 的统计和最近 24 小时 Token、viewer/operator/admin 与停用身份、目录角色限制、Runtime 租户隔离、底表完整读取拒绝，以及 up/down/up 和角色重绑定。必须在真实 PostgreSQL 上执行这些用例；静态复审不能替代权限验证。当前运行边界见[架构总览](../architecture/overview.md)。
