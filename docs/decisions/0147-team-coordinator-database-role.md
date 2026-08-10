# ADR-0147：团队协作使用独立数据库协调角色

- 状态：已接受（试验版）
- 日期：2026-08-10
- 决策者：仓库维护者
- 关联任务/PR：GitHub PR #1
- 替代关系：细化 ADR-0139 的团队成员变更权限边界

## 背景

团队协作 Repository 需要在同一事务中创建团队、调整成员角色、撤销成员并在解散团队时取消仍在运行或排队的工作。PR 初始实现把 `memberships.role`、`memberships.status` 和团队目录更新权限直接授予普通 Runtime 角色，这违反了既有不变量：Runtime 只能读取和插入 Membership，并仅能更新恒定为 `false` 的 `lock_marker`；成员授权状态必须由独立权限边界修改。

同时，当前迁移安全模型明确禁止目标 Schema 中出现 routine，routine manifest 仍为空，因此不能在本次合并中用 `SECURITY DEFINER` 函数隐藏成员变更。团队解散还需要与 Run、dispatch、线程执行状态和 Worker Tenant assignment 的收敛保持单事务原子性。

## 决策驱动因素

- 普通 API/Worker Runtime 凭据不能获得 Membership 授权列写权限；
- 团队创建、成员变更和解散必须维持现有 RLS、锁序与单事务语义；
- Worker 进程不得持有团队授权管理凭据；
- 数据库角色必须继续通过迁移前置安全检查、精确 ACL 白名单和 readiness 实际身份校验；
- 不为本次合并引入未经独立审查的数据库 routine。

## 备选方案

### 方案 A：扩大普通 Runtime 权限

把 `memberships.role/status` 和 `team_member_directory` 写权限直接授予 Runtime。实现最简单，也不需要新连接，但所有持有 Runtime 凭据的 API、Worker 和运维进程都会获得成员授权修改能力，直接破坏现有最小权限不变量，因此拒绝。

### 方案 B：使用 `SECURITY DEFINER` routine

Runtime 只获得受审函数的 EXECUTE 权限，由函数执行成员变更。该方案长期可进一步收窄 SQL 能力，但会改变当前“目标 Schema routine 集合为空”的安全基线，需要额外审查 owner、固定 `search_path`、参数、调用权限、迁移回退和 routine manifest，不适合作为本次团队试验版的附带变更。

### 方案 C：独立 Team Coordinator 角色与连接池

新增与 Runtime、Migrator、Skill Publisher、Worker Coordinator 均不同的 `NOINHERIT LOGIN` 角色。API 使用独立连接池，只把该连接注入团队协作 Repository；普通 Repository 和所有 Worker 继续只使用原有 Runtime/Worker Coordinator 连接。

## 选择

采用方案 C。

Team Coordinator 在团队协作迁移存在时获得 Runtime 等价的租户内业务白名单，以支持团队解散时原子取消 Thread/Run/dispatch；额外只获得：

- `team_member_directory` 的 `SELECT`、`INSERT`；
- `team_member_directory.role/status/updated_at` 的列级 `UPDATE`；
- `memberships.role/status` 的列级 `UPDATE`。

它不获得表级 `UPDATE`、`DELETE`、`TRUNCATE`、sequence、routine EXECUTE、Schema `CREATE`、数据库 `CREATE/TEMPORARY`、ownership 或角色成员关系。所有业务访问继续经过 Tenant 会话变量和 FORCE RLS。普通 Runtime 的 Membership 白名单保持不变。

API 配置新增 `DATABASE_TEAM_COORDINATOR_URL` 与 `DATABASE_TEAM_COORDINATOR_ROLE`。生产装配要求 TLS 连接并在 readiness 中核对实际登录角色；开发装配在提供角色名时也执行同一身份核对。该凭据不进入 Worker 进程。

## 理由

独立角色把新增授权能力限制在真正需要团队管理事务的 API Repository 中，不扩大 Worker 和其他 Runtime 进程的权限；同时可以复用现有 SQL、RLS、锁序和事务实现，避免在团队功能合并时同时引入 routine 安全模型。精确 ACL 重建和结束断言能让角色漂移失败关闭。

## 影响

### 正面影响

- 恢复普通 Runtime 不能修改成员角色/状态的不变量；
- 团队创建、成员管理和解散仍保持单事务原子性；
- Worker 无法使用新增凭据修改团队授权；
- 迁移、partial down、独立 bootstrap 和 M4 数据库准备都会验证第五个角色。

### 负面影响与成本

- API 需要额外 PostgreSQL 凭据和连接池，增加连接数、密钥轮换和部署配置成本；
- Team Coordinator 为支持解散事务拥有 Runtime 等价的租户内业务权限，尚未收窄为只调用少量受审命令；
- 团队协作 Repository 暂时不能在缺少独立连接时启用，配置错误会使进程启动或 readiness 失败关闭。

### 安全、数据与运维影响

- 五个数据库角色必须互异，且 Team Coordinator 必须为无继承、无成员、无 ownership、无 DDL/TEMP 的登录角色；
- Database Admin bootstrap 需只授予目标数据库 `CONNECT`，迁移 bootstrap 从空 ACL 重建 Team Coordinator 白名单；
- `DATABASE_TEAM_COORDINATOR_URL` 是秘密配置，不得写入仓库、日志或错误文本；
- 该变更不修改团队业务数据结构，只改变连接与 ACL 边界。

## 验证

- 单元契约断言迁移入口显式要求五个互异角色，并验证 Runtime 与 Team Coordinator 的白名单文本；
- API 配置测试拒绝非法 Team Coordinator 角色名及与 Runtime 角色复用；
- PostgreSQL 集成测试证明 Runtime 更新 `memberships.role/status` 返回 `42501`，独立 Team Coordinator 连接可更新授权列但不能更新 `created_at`；
- PostgreSQL 全量集成覆盖 up/down、partial down、PUBLIC 残留 ACL 清理、角色安全前置检查和团队解散事务；
- `lint`、全量 `typecheck`、单元测试、配置契约与生产容器门禁保持通过。

## 可逆性与回退

在未使用团队成员变更接口前，可回退 API 双连接装配和第五角色 ACL，并停用团队路由。已有团队数据不需要转换；回退不得删除团队、Membership 或审计事实。进入生产后若需更换方案，应先停止团队写流量，撤销 Team Coordinator 凭据，再部署替代的授权命令边界。未来可通过新的 ADR 将该角色收窄为仅执行受审 routine，但不能直接把权限重新并入普通 Runtime。

## 后续工作

- 评估以显式命令端口或受审 `SECURITY DEFINER` routine 进一步收窄 Team Coordinator 的 Runtime 等价权限；
- 为 Team Coordinator 连接池增加独立连接数预算、审计标签和密钥轮换手册；
- 在生产 ruleset 中保持 PostgreSQL/M4 与生产容器门禁为必需检查。

## 实施记录

- PR #1 合并核查中发现 Runtime Membership 权限越界，改为独立 Team Coordinator 角色与连接池，并补齐配置、迁移、M4 和 PostgreSQL 集成测试。