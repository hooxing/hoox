# ADR-0154：隔离集群级数据库角色并固定开发配置真源

- 状态：已接受
- 日期：2026-08-12
- 决策者：Runtime 团队
- 关联任务/PR：修复两台开发机共享 PostgreSQL 时团队目录反复返回 500
- 替代关系：补充 ADR-0009、ADR-0142、ADR-0147；替代 ADR-0151 中 development Node 命令直接使用 `--env-file-if-exists` 的部分，不改变 Worker 启动前编译决策

## 背景

两台开发机连接同一 PostgreSQL 集群中的不同数据库，却复用了相同的 Runtime、Migrator、Skill Publisher、Worker Coordinator 和 Team Coordinator 角色名。PostgreSQL 登录角色及其密码是集群级对象；一台机器为自己的数据库重置同名角色密码后，另一台机器已建立的连接暂时可用，但连接池下次建连会收到 `28P01`。本次故障因此表现为 API `/live` 正常、`/ready` 返回 503，而团队目录在 Team Coordinator 新建连接时返回 500。

同时，Node 的 `--env-file-if-exists` 不会覆盖进程已经继承的同名环境变量。本机 `.env` 缺失 Team Coordinator URL 时，长驻终端中的旧 URL 仍能让进程启动，掩盖本地配置不完整并继续使用过期凭据。

更换数据库专属角色还暴露出一个既有缺口：0032 与 0042 迁移把部分 RLS policy 绑定到迁移当时的具体角色，重复 ACL bootstrap 只重建 GRANT，没有把 policy 和 Skill Publisher 权限重绑定到当前显式角色。

## 备选方案

### 方案 A：继续跨数据库共享角色并约定所有机器使用同一密码

操作最少，但任何一次凭据轮换都必须同步所有数据库和机器；遗漏会再次造成延迟故障，也扩大单个凭据的影响范围。

### 方案 B：只修本机密码和 `.env`

可以恢复当前接口，但没有阻止另一台机器再次旋转同名集群角色，不能消除复发条件。

### 方案 C：每个数据库使用独立角色，并在迁移与开发入口强制边界

为每个数据库分配独立的五角色集合；迁移通过 `pg_shdepend` 在 DDL 前拒绝跨数据库复用；ACL bootstrap 重绑定角色定向 policy；development 入口由根 `.env` 覆盖继承环境。

## 选择

采用方案 C：

1. 同一 PostgreSQL 集群中的不同数据库必须使用不同的五角色集合，角色名应带数据库或部署后缀；
2. migration preflight 和独立 ACL bootstrap 都查询 `pg_shdepend`，任一配置角色被其他数据库依赖时失败关闭；
3. ACL bootstrap 在同一事务中把 Skill Publisher、Migrator 与动态 Worker policy 重绑定到当前角色，并重新构建 Skill Publisher 最小权限；
4. API、Worker、Scheduler 与 Skill Admin 的 development 入口主动读取仓库根 `.env`，文件值覆盖继承值；production 入口不读取本地文件；
5. `.env.example` 与 production 示例使用带环境后缀的角色名，避免新环境复制通用集群角色名。

## 理由

数据库专属角色同时收窄凭据爆炸半径和 ACL 影响范围。`pg_shdepend` 是 PostgreSQL 对角色跨数据库依赖的集群事实，比检查角色名格式或依赖人工约定可靠。开发文件覆盖继承环境让被 Git 忽略的本地配置成为确定真源；缺失或空值随后由现有严格配置契约在任何外部连接前拒绝。

## 影响

### 正面影响

- 其他开发库重置自己的角色密码不再影响本数据库；
- 跨数据库角色复用在迁移 DDL 前被自动拒绝；
- 角色更换后 RLS policy 与 ACL 不再停留在旧角色；
- 重启 development 进程不会继续吃到长驻终端里的旧数据库 URL。

### 负面影响与成本

- 已复用角色的数据库必须由管理员创建独立角色、转移 Schema ownership、重跑 ACL bootstrap 并撤销旧角色在本数据库的权限；
- 多数据库部署需要维护更多独立凭据；
- 直接依赖终端覆盖 `.env` 的本地调试方式不再生效，必须修改 `.env` 或使用 production 入口的显式注入方式。

### 安全、数据与兼容影响

不迁移或改写业务数据。角色 ownership 与 ACL 切换可在事务中完成；旧角色不会自动删除，以免影响同集群其他数据库。迁移新增跨数据库依赖门禁，复用角色的旧部署会明确失败，必须先完成角色隔离。

## 验证

- 单元测试证明 `.env` 覆盖继承的旧 Team Coordinator URL，显式空值继续触发严格配置失败；
- 单元测试证明任一角色存在其他数据库依赖或角色缺失时门禁失败；
- 静态迁移契约证明 Skill Publisher 与 Worker policy 可重复重绑定；
- 对真实开发库创建数据库专属角色、重跑 `pnpm db:migrate:up`，验证五个身份与 `/ready`；
- 重启 API 后验证 `GET /v1/me/teams` 返回 200 且团队目录可见。

## 可逆性与回退

代码可回退，但回退会重新允许跨数据库角色复用和继承环境覆盖 `.env`，不建议。数据库侧可由管理员把 Schema ownership 和 ACL 重绑定回旧角色；回退前必须确认旧角色密码没有被其他数据库旋转，并停止所有使用新角色的进程。旧角色的删除不属于本决策自动步骤。
