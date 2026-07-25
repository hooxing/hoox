# ADR-0002：领域对象、所有权与不可变性

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M0-02、M1、M2、M3、M4
- 替代关系：无

## 背景

新 Runtime 面向多个用户，未来可能支持团队，但首版只开放个人租户。旧原型以 Run 和本地目录为中心，没有 Tenant、Thread 或不可变文件版本，不能作为新系统的数据模型。

## 决策驱动因素

- 任何查询、执行和下载都必须有稳定的租户隔离边界；
- 同一 Thread 需要多轮连续工作，Run 又必须能够独立恢复和审计；
- 文件历史和交付物需要可追溯，不能被后续写入悄悄覆盖；
- 未来增加团队租户时，不能改变个人资源的既有归属。

## 备选方案

### 方案 A：以 User 直接拥有全部对象

首版简单，但加入团队后需要重写所有权和授权查询，个人文件也容易被隐式共享。

### 方案 B：统一 Tenant 所有权，Thread 和版本对象逐层继承

首版多一个 Tenant Context，但个人和未来团队共用同一隔离模型，授权和对象键可以从第一天稳定。

### 方案 C：继续以 Run 目录为顶层

能够快速复刻原型，但无法自然表达长期 Thread、跨 Thread Resource 和同 Thread Workspace 连续性。

## 选择

采用方案 B。所有业务对象必须直接或可验证地归属于一个 Tenant，所有权链如下：

| 对象 | 直接所有者/父对象 | 可变性 |
|---|---|---|
| User | 身份系统 | 资料可变，ID 不变 |
| Tenant | 顶层隔离对象 | 类型和 ID 不变；首版为个人租户 |
| Membership | User + Tenant | 关系可撤销，首版个人成员固定 |
| Thread | Tenant | 元数据可变，Tenant 不可变 |
| Workspace | Thread | latest 指针可变，Thread/Tenant 不可变 |
| Run | Thread | 仅按状态机迁移，归属不可变 |
| WorkspaceRevision | Workspace | 发布后不可变 |
| Resource | Tenant | 元数据可演进，归属不可变 |
| ResourceVersion | Resource | 创建后不可变 |
| Artifact | Tenant + 来源 Run | 发布记录不可原地改写，重发产生新版本 |
| SandboxSession | Thread | 临时状态可变，不是持久正确性来源 |
| Rollout Entry | Agent Thread/Run | 追加写入，不原地改写 |

Run 从 Thread 继承 Tenant。同一 Workspace 同时只允许一个 Root Run/Agent Tree 持有写入权；数据库锁只覆盖 Revision 的短事务提交。删除先做带 Tenant 的逻辑删除/不可见标记，只有引用检查通过后才能异步删除 Blob。

所有 ID 使用服务端生成的不透明 ID。Repository 查询必须同时接收可信 Tenant Context 和资源范围，不能把“知道裸 ID”等同于授权。

## 理由

方案 B 将未来团队能力的成本限制在 Membership 和产品界面，不需要迁移个人 Workspace。不可变 Revision/Version 让恢复、审计、缓存和 Artifact 引用都落在稳定内容上。

## 影响

### 正面影响

- 所有授权和对象键都有统一 Tenant 前缀；
- Thread 连续性和 Run 执行边界可以同时表达；
- 历史版本与交付物可重放和追溯。

### 负面影响与成本

- 即使首版只有个人用户，也必须创建 Tenant 和 Membership；
- Repository、事件和测试夹具都必须携带 Tenant Context；
- 删除需要引用检查和异步清理，不能直接级联物理删除。

### 安全、数据与运维影响

数据库约束只能防止部分归属错误，服务层仍需对每次读取、SSE、预览和下载重新授权。跨 Tenant 引用在 Schema 和代码评审中都属于阻断问题。

## 验证

- 两个固定测试租户执行完整越权矩阵，所有裸 ID 猜测返回不泄漏存在性的统一结果；
- 走查纯文本 Thread、同 Thread 连续修改、跨 Thread 导入并发布三个场景；
- Repository 契约测试证明归属创建后不能更改，Revision/Version/Artifact 不能原地更新；
- 并发测试证明落后 `base_revision` 不能覆盖最新 Revision。

## 可逆性与回退

业务数据写入前可以调整字段命名；一旦产生生产对象，改变顶层所有权或不可变版本语义将需要全量迁移，视为高成本不可逆。实施前必须先冻结 Schema ADR。

## 后续工作

- 在领域包中建立 branded ID、状态机和所有权断言；
- 在数据库 Schema 中增加组合外键或等价约束；
- 为逻辑删除和 Blob 清理另建生命周期策略。

## 实施记录

- 尚未实施；本 ADR 作为 M1 至 M4 的约束。
