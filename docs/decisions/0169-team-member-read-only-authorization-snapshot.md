# ADR-0169：团队成员读取在只读事务中使用无锁授权快照

- 状态：已接受
- 日期：2026-08-12

## 背景

团队成员列表通过 `withTenantTransaction(..., { readOnly: true })` 执行，但复用了为写操作设计的 `actorRole`，后者固定追加 `FOR SHARE`。PostgreSQL 在 `READ ONLY` 事务中拒绝显式行锁并返回 SQLSTATE `25006`，最终使 `GET /v1/teams/:teamId/members` 稳定返回 500。

约束包括：成员读取仍必须在目标 Tenant 的 RLS 上下文中验证活跃 Membership；写操作继续需要行锁保护角色授权与后续修改之间的一致性；不能为了规避错误而把纯读取事务改成可写事务。

## 备选

1. 移除成员列表事务的 `readOnly`。实现简单，但扩大数据库事务能力，不符合最小权限与只读查询语义。
2. 所有 `actorRole` 查询统一移除 `FOR SHARE`。可以修复读取，但会削弱添加成员、改角色、移除成员和解散团队等写操作的授权锁定边界。
3. 让 `actorRole` 显式区分锁定与无锁读取；成员列表使用无锁快照，写操作保持默认行锁。

## 决策

采用方案 3。`actorRole` 默认继续使用 `FOR SHARE`，只有 `listMembers` 在只读事务中显式传入无锁选项。该读取接受当前 PostgreSQL 语句/事务快照中的活跃 Membership 事实；RLS 与 API 认证仍在同一目标 Tenant 下执行。

## 影响

- 团队成员 GET 不再触发 PostgreSQL `25006`，恢复 200 响应。
- 写操作的行锁和授权时序不变。
- 共享辅助函数的调用意图更明确；新增锁定型调用时默认安全，新增只读调用必须显式选择无锁。

## 验证

- Repository 回归测试模拟 `READ ONLY` 中执行 `FOR SHARE` 会失败，并断言成员列表授权 SQL 不包含行锁。
- 执行 persistence 定向测试、类型检查、格式和 lint。
- 使用本地真实 API 创建/读取团队，确认成员端点返回 200。

## 可逆性

代码改动可直接回退；不涉及 Schema、迁移或持久数据。回退会重新引入团队成员端点 500。
