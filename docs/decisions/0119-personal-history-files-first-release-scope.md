# ADR-0119：个人历史文件虚拟目录首期范围

- 状态：已接受
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：个人历史任务文件虚拟目录
- 替代关系：收窄 ADR-0118 的首期实施范围；不替代其长期兼容方向

## 背景

ADR-0118 同时记录了历史文件虚拟目录以及个人任务、团队任务、个人发布到团队的长期归属方向。当前产品尚未实施团队任务，
团队角色、Thread 可见性、跨 Tenant 发布内容和 Blob 转移策略也没有完成专项设计。

当前交付目标仅是个人用户历史文件的只读虚拟目录。如果把团队能力、跨 Tenant Saga、双侧授权和发布 UI 纳入同一次实现，会扩大
数据迁移、安全审阅和测试范围，并延迟个人目录价值交付。另一方面，个人实现不能写死成未来无法扩展到 Team Tenant 的结构。

## 决策驱动因素

- 本次只交付 personal Tenant 中的历史任务文件目录；
- 继续每 Tenant 一个 Cube Volume；
- 不引入任何团队 API、角色、迁移、跨 Tenant 事务或发布后台任务；
- 数据表、端口和路径必须保持 Tenant 相对语义，未来 Team Tenant 可以复用而无需迁移个人数据；
- 团队设计仍需保留安全提醒，但不能出现在当前阶段、验收和运行成本预算中。

## 备选方案

### 方案 A：个人与团队能力一次实现

目标完整，但会同时引入团队授权模型、跨 Tenant Blob/Context/Workspace 转移、发布 Saga 和 UI 确认，超出当前需求且风险集中。

### 方案 B：只实现个人目录，保留 Tenant 相对扩展点

仅对 personal Tenant 开启 `/history` 和 `/thread-files`。关系表继续以 `tenant_id` 为第一边界，ResourceFS 端口只依赖 Tenant 上下文，
但不实现 team Tenant 分支和个人发布到团队。

### 方案 C：完全忽略团队方向

实现最少，但容易把表名、目录路径和授权写成 userId 特例，未来 Team Tenant 需要重新迁移和改协议。

## 选择

采用方案 B：

1. 本次功能只对 `tenant.kind=personal` 生效。Team Tenant 即使存在测试 fixture，也不暴露历史目录，不执行历史标题、关系回填或
   历史 Volume 需求升级。
2. `/history` 表示当前 personal Tenant 最近六个月有文件的任务；`/thread-files` 表示当前个人 Thread 的稳定文件视图。
3. 数据表继续使用 `(tenant_id, thread_id, ...)` 作为身份和 RLS 边界，不增加“当前用户历史目录”专用 userId 分区。personal
   Tenant 的 `owner_user_id` 已表达个人归属。
4. 当前实现不新增 task scope、team role、share grant、transfer intent、跨 Tenant service role、团队发布 API、UI 或指标。
5. 个人发布到团队只保留为未来兼容约束：不得假设所有 Tenant 都是 personal，不得把 `/history` 路径编码为 `/personal-history`，
   不得把 Thread ID 或 userId 暴露为 Agent-facing 目录名。
6. 标题生成、时间语义目录、最近六个月窗口、路径定向 ResourceFS、原生文件查找、稳定 `/thread-files` 和标题改名 TODO 仍属于
   当前虚拟目录实施范围。
7. 团队能力开始前必须新增专项 ADR，重新确认 Team Tenant 可见性、角色权限、个人到团队发布语义和跨 Tenant 数据转移。

## 理由

当前 personal Tenant 已经把用户所有权映射到成熟的 Tenant/RLS/Blob/Cube Volume 边界，个人历史目录无需再增加 userId 能力。
保持端口和表的 Tenant 相对语义，又足以让未来 team Tenant 复用相同目录协议。

将团队能力移出当前计划，可以避免为尚未确定的产品语义提前创建跨 Tenant 高权限角色和不可逆数据路径，同时不会牺牲未来
扩展：团队实现只需决定哪些 Team Thread 进入同一 Tenant 的 `/history`，以及个人任务如何显式复制或发布到目标 Tenant。

## 影响

### 正面影响

- 当前改动集中在历史关系、标题、ResourceFS 和 Sandbox；
- 不增加跨 Tenant 权限面和对象复制；
- 性能 Gate、E2E 和灰度只需覆盖 personal Tenant；
- 未来团队目录可以沿用 `/history`、`/thread-files` 和 Tenant 级 Volume。

### 负面影响与成本

- Team Tenant 暂时没有历史目录；
- 个人任务不能在当前版本中发布为团队任务；
- 未来团队功能仍需要独立迁移、威胁模型和端到端实现。

### 安全、数据与运维影响

- Feature Gate 必须在可信 Tenant 查询后确认 `kind=personal`，不能相信客户端声明；
- Team Tenant 请求不得部分写入个人历史表或创建看似可用但未授权的目录；
- 数据模型不得把 personal owner userId 复制到每条目录关系作为新的授权事实源；
- 当前没有双 Tenant Runtime 角色或跨 Tenant Blob 访问。

## 验证

- personal Tenant 可创建、枚举和读取最近历史；
- team Tenant 不写历史关系、不生成历史标题、不暴露 `/history`；
- personal Tenant 之间继续由 RLS 和 capability 隔离；
- Feature Flag 关闭时保持现有行为；
- 数据表、端口和路径不存在要求 Tenant 永远为 personal 的名称或约束；
- 当前测试矩阵中不存在团队发布、跨 Tenant Saga 或目标团队 Blob 复制 Gate。

## 可逆性与回退

可以关闭 personal history Feature Flag，停止投影和关系写入，保留已生成元数据；原 Resource、Thread 和 canonical 路径不受影响。
未来启用团队能力时新增 ADR 和增量迁移，不修改已产生的个人目录身份。

## 后续工作

- 按修订后的实施计划交付个人历史虚拟目录；
- 标题目录可变改名继续作为独立 TODO；
- 团队功能启动时重新评审 ADR-0118 的长期方向并新增专项 ADR。

## 实施记录

- 2026-08-07：明确当前只实施 personal Tenant 历史虚拟目录，团队相关内容退出本次范围。
