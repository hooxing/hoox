# ADR-0118：历史任务文件虚拟目录与个人/团队任务归属

- 状态：已接受
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：历史任务文件按需发现与个人任务发布到团队
- 替代关系：补充 ADR-0005、ADR-0077、ADR-0079、ADR-0103、ADR-0107

## 背景

ResourceFS 已经通过每 Tenant 一个 Cube Volume，把 Tenant 内 `searchable + stable` 的不可变
ResourceVersion 只读挂载到 Sandbox `/resources`。当前轮附件会把稳定 Resource 路径追加到最新 user turn，
但上下文压缩或长期使用后，Agent 缺少一个不依赖 Thread ID、Resource ID 或完整 Prompt 注入的历史文件发现入口。

产品方向进一步明确为两类任务：个人任务归个人所有，团队任务归团队 Tenant 所有；个人任务可以显式发布为团队任务。
当前数据模型已经区分 personal Tenant 与 team Tenant，且 ResourceFS host-volume capability 只绑定 Tenant。若在同一
Team Tenant 的共享 mount 内再虚构用户级私有目录，只能形成导航过滤，不能形成可靠安全隔离。

任务标题目前由 Web 从首条输入确定性截断。语义标题既可以改善任务列表，也可以作为历史目录的人类可读名称；但标题
变化、rclone 目录缓存和运行中 Sandbox 的稳定路径需要独立处理。

## 决策驱动因素

- Agent 使用普通 POSIX 路径、`find`、`rg --files` 和可选 `fd` 发现历史文件；
- 保持每 Tenant 一个 Cube Volume，不为用户或 Thread 创建独立 Volume；
- 不复制未读取文件，不把历史目录或动态文件名注入 system/developer prompt；
- Agent-facing 路径不得依赖 Thread ID、Resource ID 或 Version ID；
- 最近历史应可直接浏览，同时避免无界枚举全部生命周期数据；
- personal 与 team 的安全边界必须与 Tenant/RLS/Blob 引用边界一致；
- 个人任务发布到团队不能通过原地改写 `tenant_id` 破坏复合外键、审计和来源历史；
- UI 标题变化不得让当前 Thread 的固定文件入口或正在读取的文件突然失效。

## 备选方案

### 方案 A：每个 Thread 或用户一个 Cube Volume

可以天然限定视图，但 Volume、FUSE/rclone mount、缓存和恢复状态会随用户或 Thread 数量增长；同一 Blob 还可能在不同
mount 中重复缓存，不符合已确定的 Tenant 级 Volume 边界。

### 方案 B：Tenant Volume 上提供最近历史语义目录

保留单一 Tenant mount，在 ResourceFS 中投影最近六个月有文件的任务，以服务端时间加语义标题命名。Sandbox 提供固定
`/history` 和 `/thread-files`；目录和文件内容均按需读取。个人任务位于 personal Tenant，团队任务位于 team Tenant。

### 方案 C：只提供专用历史搜索工具

可以控制结果数量，但会让文件发现与读取采用两套接口，增加工具 Schema、审计和 Agent 路由复杂度；普通 shell 和第三方
库仍不能直接浏览历史目录。

### 方案 D：把个人和团队任务都放在 Team Tenant，再按 userId 过滤

导航上可行，但现有 host-volume capability 只有 Tenant 身份，同一个只读 mount 会让 Sandbox 仍可遍历 Tenant 根视图，
不能满足未来个人任务的保密语义。

## 选择

采用方案 B，并冻结以下边界：

1. personal Tenant 中的 Thread 是个人任务；team Tenant 中的 Thread 是团队任务。`/history` 始终表示当前 Sandbox
   所属 Tenant 最近六个月有文件的任务，不跨 Tenant 聚合。
2. 每 Tenant 继续只有一个 Cube Volume。个人用户加入多个 Team Tenant 后，个人历史与各团队历史分别位于各自 Tenant
   Volume；跨范围使用文件必须显式发布或导入。
3. `/history` 直接平铺最近六个月任务，不按年月再分层。只展示 `last_file_at >= now() - interval '6 months'` 的目录，
   但目录时间使用 Thread 创建时的可信时间快照，后续活动不移动路径。
4. 任务目录统一使用 `YYYY-MM-DD_HH-mm-ss_<语义标题>`；文件使用
   `YYYY-MM-DD_HH-mm-ss_<原始文件名>`。时间来自服务端事实，模型只生成标题正文；极端同秒重名再使用数字序号兜底。
5. 低成本标题模型在首条 durable 用户输入后异步运行，只读取用户原文和附件文件名，不读取文件正文，不进入主 Agent
   prompt。严格校验输出；失败时使用确定性标题回退。
6. 第一阶段目录名在分配后保持不变。UI 标题后续可以变化，但不自动移动目录。目录随标题变化列为 TODO；实现时必须采用
   新目录加旧路径兼容别名，且 `/thread-files` 始终解析到与标题无关的稳定当前 Thread 视图。
7. `/thread-files` 是当前任务的稳定入口，不得以可变标题路径作为唯一 target。运行中已打开的文件句柄可以继续读取；新路径
   解析不依赖 UI 标题是否改变。
8. Thread 与 ResourceVersion 的历史关系进入规范化 PostgreSQL 表；`thread_input_receipts.input_attachments` 继续作为
   不可变输入审计事实，不作为高频目录枚举索引。
9. ResourceFS 改为按目录路径查询，禁止为一次 PROPFIND 加载 Tenant 全部 ResourceVersion。目录本身作为首版发现接口，
   不新增专用历史搜索工具或预生成全量索引文件。
10. `find`、`rg --files` 和可选 `fd` 用于文件名发现；无界 `rg <正文> /history` 会打开大量远端文件，不作为推荐流程。
11. 个人任务“转为团队”定义为从 personal Tenant 向目标 team Tenant 显式发布不可变副本，而不是原地改变 Thread 的
    `tenant_id`。源个人任务继续保留；目标团队获得新的 Thread、Resource/Blob 引用、Workspace/Context 快照和 lineage。
12. 团队发布在团队功能正式实施前保持 Feature Flag 关闭；必须先完成双 Tenant 授权、显式确认、跨 Tenant Saga、失败补偿
    和泄漏审阅。

## 理由

Tenant 类型已经提供自然的个人/团队所有权边界，和现有 PostgreSQL RLS、对象存储引用、Cube Volume capability 完全对齐。
把个人私有任务放进 Team Tenant 后再依赖目录过滤，会让展示边界被误当成安全边界；使用 personal Tenant 则无需为未来团队
隔离推翻 ResourceFS。

最近六个月的平铺目录满足用户对直接浏览的偏好。时间前缀同时提供排序、重名消解和语义信息；路径定向 SQL 避免目录浏览
退化为全 Tenant 扫描。文件内容仍在首次打开时通过现有 BlobStore 读取，不增加持久字节副本。

个人发布到团队采用新建目标聚合而非原地迁移，是因为现有 Thread、Run、Workspace、Resource、Artifact 和 Blob 引用均以
`tenant_id` 参与主键、外键、RLS 和审计。保留源任务还能避免发布失败或误操作破坏个人历史。

## 影响

### 正面影响

- Agent 只需记住固定 `/history` 和 `/thread-files`，无需知道内部 ID；
- 目录可以被普通 shell、代码和第三方库读取；
- 未打开的历史文件不会下载到节点或 Sandbox；
- 个人与团队归属复用既有 Tenant 安全边界；
- 时间名称提升重复任务和同名文件的可理解性；
- 个人发布到团队保留完整来源和失败回退点。

### 负面影响与成本

- 用户只要当前 Tenant 最近半年存在历史文件，其需要 Sandbox 的任务会依赖 ResourceFS 可用性；
- `/history` 是滚动发现视图，过期任务会从目录枚举消失；稳定事实仍保留在 Resource/Thread 中；
- WebDAV PROPFIND 没有业务分页，半年内极高任务量仍可能形成大根目录，需要指标和阈值；
- 对整个 `/history` 执行正文 `rg` 会按需读取大量 Blob；
- 标题生成引入独立模型调用、重试、成本和输出治理；
- personal → team 发布是跨 Tenant Saga，复杂度显著高于同 Tenant 状态更新。

### 安全、数据与运维影响

- `/history` 的授权仍是当前 Tenant；不建立“同一 Team Tenant 内按 userId 过滤即私有”的伪安全边界；
- 标题输入和模型输出均为不可信文本，必须做长度、字符、路径和控制字符校验；
- 标题模型无工具、无文件正文、无系统秘密，日志不得记录完整用户输入；
- 跨 Tenant 发布必须由独立受控端口执行双侧授权，普通 Tenant Runtime 数据库角色不得绕过 RLS；
- 目标 Tenant 必须拥有独立 Resource/Blob 引用，不能复用来源 Tenant 的 capability 或对象授权；
- ResourceFS 仍只读，历史视图不能修改 Resource、Workspace 或 Artifact。

## 验证

- 目录契约测试验证时间命名、字符清理、同秒重名和最近六个月过滤；
- PostgreSQL 测试验证关系写入幂等、RLS、复合外键、个人/团队 Tenant 隔离和路径定向索引；
- ResourceFS HTTP 测试验证根目录不全量加载文件、任务目录按需列文件、Range/ETag 和写入拒绝；
- Sandbox 测试验证 `/history`、`/thread-files`、`find`、`rg --files` 和可选 `fd`；
- 故障测试验证标题服务失败回退、ResourceFS 失败关闭和运行中旧路径缓存行为；
- 性能 Gate 覆盖六个月 1 千、1 万任务，以及单任务 1 千文件的 PROPFIND 延迟和响应大小；
- 团队发布上线前验证双 Tenant 授权、源保留、目标原子可见、Blob 失败补偿和重复请求收敛。

## 可逆性与回退

历史目录是 Resource/Thread 的派生视图，可以关闭投影和 Sandbox 别名而不删除原始数据。标题生成可以回退到现有确定性标题；
已分配目录名继续保留，不做破坏性重命名。

规范化历史关系一旦用于生产目录，应停止新增写入、保留只读兼容后再迁移，不能先删表导致已知路径无法解析。个人发布到团队
在目标 Thread 对外可见后不能无痕回滚；只能归档目标并保留审计，源个人任务始终不删除。

## 后续工作

- 实施计划见 `docs/history-files-virtual-directory-implementation-plan.md`；
- 支持 UI 标题变化同步到新目录，并保留旧路径别名；
- 根据真实半年任务量决定是否增加分层或受控查询能力；
- 团队功能实施前新增个人发布到团队的专项 ADR 和威胁模型。

## 实施记录

- 2026-08-07：完成设计与阶段实施方案，尚未开始代码实现。
- 2026-08-07：按 ADR-0120 完成个人虚拟目录主链路；标题模型、可变别名和规模性能 Gate 后置。
