# 统一后台 API 进程并保留发布资源隔离

- 状态：已接受
- 日期：2026-08-21
- 决策者：Runtime 维护者
- 关联任务/PR：将 Skills 与平台控制面合并到一个后台 API 进程
- 替代关系：替代 ADR-20260819165254 中“按能力拆分两个管理 API 进程、JWT audience 与监听端口”的部分；不替代其版本化配置、审计和数据库最小权限决策

## 背景

统一管理页面此前把模型、记忆、配置和统计请求发送到 `admin-control-api:3003`，把 Skill 提交与发布请求发送到
`skill-admin-api:3002`。页面虽然只有一套导航，却依赖两个进程、两个开发 Token 和两套路由代理；任一进程未启动都会
让单个后台模块报 500。本地实际故障即由 3002 未运行而 3003 正常引起。

Skill 发布的独立 PostgreSQL 角色与 S3 凭据仍有明确安全价值。需要统一的是浏览器可见的 HTTP、身份和进程边界，
而不是把 Skill Publisher 的数据库授权合并进 Admin Control 角色。

## 备选方案

### 方案 A：继续运行两个公开管理 API

资源隔离最强，但保留两个进程、两个 Token、两套健康检查和代理配置，不能满足单进程后台的运维与产品预期。

### 方案 B：增加一个 BFF，内部继续运行两个进程

浏览器只有一个入口，但部署单元从两个增加为三个；3002 下线时 Skills 仍不可用，也没有降低本地启动复杂度。

### 方案 C：合并为一个进程，内部保留两个数据库 pool

`admin-control-api` 同时注册控制面和 Skill 发布路由，共用 listener、TLS、JWT 与开发 Token。进程内部继续使用
`ADMIN_CONTROL_DATABASE_URL` 和 `SKILL_PUBLISHER_DATABASE_URL` 创建两个有独立预期角色的 pool，并只让发布
Repository 持有 `SKILL_PUBLISHER_S3_*` 客户端。

## 选择

采用方案 C，并固定以下边界：

1. 浏览器所有 `/v1/admin/*` 请求只发送到 `admin-control-api` 的 3003 listener，开发 Vite 代理只注入
   `DEV_ADMIN_CONTROL_TOKEN`。
2. Skill HTTP 实现保留为可复用路由模块，但删除其 development/production main、进程配置、独立 listener、TLS、JWT
   和启动脚本；仓库不再提供可独立运行的 3002 服务。
3. 统一进程必须同时配置 Admin Control 与 Skill Publisher 两个数据库连接。生产启动时分别验证
   `DATABASE_ADMIN_CONTROL_ROLE` 与 `DATABASE_SKILL_PUBLISHER_ROLE`，任何角色不匹配都不得监听端口。
4. Skill Publisher 的 S3 客户端只注入 Skill Publication Repository。readiness 按 Control PG、Publisher PG、S3
   顺序执行；Publisher PG 探针失败时不得再携带 S3 凭据访问对象存储。
5. 单个管理 JWT 对两组路由生效。细粒度授权仍由 `platform_control_operators` 与
   `platform_skill_operators` 分别判定，共用身份不等于共用领域角色。
6. Skill 包创建路由保留 48 MiB HTTP 正文上限，其余控制面路由继续使用较小的默认正文上限；统一进程采用发布流程所需
   的 60 秒请求与 handler 超时。

## 理由

方案 C 直接消除故障来源和重复运维面，又不需要把两个 PostgreSQL 角色合成超级用户。相比 BFF，它只有一个常驻后台
进程，健康检查可以同时反映控制面数据库、发布数据库与对象存储是否可用。代价是该进程同时持有两组数据库连接与
S3 发布凭据，因此进程级失陷的影响面大于双进程；领域授权、独立 pool、独立数据库 ACL、日志脱敏和路由正文限制是
必须保留的补偿控制。

## 影响

### 正面影响

- 后台页面、开发代理、身份网关和部署系统只有一个管理 API 地址与管理 Token；
- Skills 不再因遗漏启动 3002 而单独报错；
- readiness、关闭顺序和本地启动脚本覆盖完整后台能力；
- Skill Publisher 对 Runtime 与 Admin Control 表的数据库零权限保持不变。

### 负面影响与成本

- 3003 进程必须同时持有 Admin Control PG、Skill Publisher PG 和 S3 发布凭据；
- 任一强依赖 readiness 失败会使统一后台整体标记为不可用；
- 管理 JWT 泄漏时，攻击者可以尝试两组管理路由，但仍需通过各自数据库 operator 授权。

## 验证

- API 测试证明同一 Fastify 实例同时提供控制面与 Skill 路由并复用认证主体；
- 进程配置测试证明统一入口只投影两套后台数据库与 S3 配置，拒绝 Runtime/Migrator 凭据；
- 装配测试证明只创建一个 listener、两个独立 PG pool，并在 Publisher PG 失败时跳过 S3 探针；
- Skill 发布路由原有状态机、幂等、正文上限和错误净化测试继续通过；
- Admin Web 测试与配置契约校验证明不再引用 3002、`DEV_SKILL_ADMIN_TOKEN` 或 `SKILL_ADMIN_JWT_*`。

## 可逆性与回退

如需恢复进程级隔离，可从本决策前版本恢复 Skill 独立进程和代理路由；数据库表、发布对象、两个数据库角色与 S3 凭据
格式均未改变，无需数据迁移。回退前必须重新配置独立 Skill JWT、listener 与身份网关路由。
