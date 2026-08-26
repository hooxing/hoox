# Demo 数据 epoch 与 Provider 持久化读取边界

- 状态：已接受
- 日期：2026-08-26
- 决策者：Runtime 维护者
- 关联任务/PR：修复 Demo 持续部署的后台概览 500
- 替代关系：细化 ADR-20260825164722 的历史异常标识读取实现；不替代其新写入拒绝与响应脱敏边界

## 背景

Demo 部署数据库中存在把 API Key 形态误填为 `providerKey` 的测试 Revision。新写入入口已经拒绝这种标识，但
PostgreSQL repository 在读取历史 Revision 时复用了同一个写入规范化器，因而在控制服务执行既定脱敏前抛错。
带管理员会话的后台概览验收持续返回 500，候选发布随即回滚。

当前 Demo 只有可舍弃的测试数据。修复不应修改已发布迁移，也不需要为这些测试记录设计数据回填。

## 备选方案

### 方案 A：新增迁移修复历史对象键

对象键同时进入 Revision、active 指针、Run 快照和审计，原地改写会扩大迁移与一致性风险；测试数据没有保留价值，
不采用。

### 方案 B：读取时静默丢弃异常 Revision

列表可以恢复，但 active 指针与 Runtime 快照仍可能引用被隐藏记录，容易制造控制面和运行时不一致，不采用。

### 方案 C：只重置 Demo 数据

能够解除当前阻塞，但会让“持久化读取错误地执行新写入门禁”的代码缺口继续存在，不足以单独作为修复。

### 方案 D：拆分写入校验与持久化读取，并切换 Demo 数据 epoch

新命令继续拒绝疑似密钥的内部标识；持久化读取只验证稳定结构，使既有 Revision 能进入控制服务的脱敏投影和
Runtime 快照解析。Demo 的 PostgreSQL 与 MinIO 命名卷同时切换到新的 epoch，直接启用空测试数据；旧卷暂留供
候选发布失败时恢复上一 release。

## 选择

采用方案 D，并固定以下边界：

1. `normalizeModelProviderConfiguration` 与 `normalizeMemoryProviderConfiguration` 继续服务新写入命令并拒绝疑似密钥。
2. PostgreSQL hydration 使用独立的 stored normalizer，只放宽疑似密钥启发式；协议、URL、模型目录、预算和其他结构
   校验保持不变。原始异常标识不得越过 Admin Control 的列表、概览和审计脱敏投影。
3. 不新增、不修改 migration，也不回填测试 Revision。
4. Demo 的 PostgreSQL 与 MinIO 卷必须成对切换 epoch。旧卷不在候选发布前删除，确保现有 release 回滚仍能重新挂载
   旧状态；发布脚本必须在候选启动和上一 release 回滚时显式强制重建两个基础服务，不能依赖 Compose 对顶层卷名
   变化的隐式检测。新 release 验收通过并处理外部 Sandbox 残留后，才可精确清理旧卷。
5. 自动发布不会在每次执行时清卷；数据 epoch 只通过显式 Compose 变更推进。

## 理由

读写边界拆分修复了导致 500 的真实代码缺口，同时保留新写入门禁。双卷 epoch 切换直接满足测试数据可舍弃的前提，
又比 `down --volumes`、回退迁移或局部 `TRUNCATE` 更容易回滚，不会把清库变成每次部署的隐式副作用。

## 影响

- 当前 Demo 的账号会话、Thread、Run、Skill、控制配置与对象全部从新空卷重新开始；发布脚本会重新创建 Demo 账号、
  个人 Tenant 和管理员关系。
- 旧 PostgreSQL 与 MinIO 卷继续占用磁盘，需在新版本稳定后由运维人员按确切卷名清理。
- 删除数据库或对象不能撤销曾经泄露的 Provider 密钥；对应密钥仍需在 Provider 侧轮换。
- 生产和其他已有环境无需执行数据迁移，历史异常 Revision 的对外读取保持脱敏。

## 验证

- 领域测试证明新写入仍拒绝疑似密钥，而 stored normalizer 允许既有对象键进入后续投影。
- PostgreSQL 集成测试直接种入历史异常 Revision，经真实 repository 和控制服务读取列表与概览，响应只含固定占位符。
- Demo 部署契约测试证明 PostgreSQL 与 MinIO 使用同一新数据 epoch，候选和回滚都会显式重建两个基础服务，且旧无
  epoch 卷名不再被候选 release 引用。
- Demo CD 继续以带管理员 Hoox Session 的 `/v1/admin/control/overview` 作为最终验收。

## 可逆性与回退

代码可以恢复为上一读取实现，但重新挂载旧数据会再次触发后台概览失败。候选发布失败时，上一 release 的 Compose 会
重新挂载旧卷；新卷保留供诊断。新版本验收成功并删除旧卷后，测试数据不可恢复。
