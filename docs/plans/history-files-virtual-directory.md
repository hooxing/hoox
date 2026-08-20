# 个人历史任务文件虚拟目录实施方案

> [!NOTE]
> 本文是实施计划或阶段拆解。当前行为以代码、自动化测试、当前架构文档和未被替代的 ADR 为准。


- 文档性质：跨 Domain、PostgreSQL、ResourceFS、Sandbox、Worker、标题服务和 Web 的实施总计划
- 状态：核心虚拟目录与低成本标题模型已实现；`test/cloud-drive-history-files` 增加 Web 云盘与 `@` 文件引用试验；可变目录别名和规模性能 Gate 后续实施
- 日期：2026-08-07
- 核心决策：[ADR-0118](../decisions/0118-history-files-virtual-directory-and-task-ownership.md)、[ADR-0119](../decisions/0119-personal-history-files-first-release-scope.md)、[ADR-0120](../decisions/0120-personal-history-filesystem-implementation-slice.md)、[ADR-0121](../decisions/0121-low-cost-thread-title-generation.md)、[ADR-0130](../decisions/0130-personal-history-file-library-and-composer-reference.md)
- 相关决策：ADR-0005、ADR-0077、ADR-0079、ADR-0103、ADR-0107

## 1. 目标

在继续使用每 Tenant 一个 Cube Volume 的前提下，只为 `tenant.kind=personal` 的任务提供接近本地只读目录的历史文件体验：

```text
/history       当前个人 Tenant 最近六个月有文件的历史任务
/thread-files  当前个人 Thread 的稳定历史文件入口
/resources     ResourceFS 底层只读资源与 Skill 视图
/workspace     当前 Thread 可写 Workspace
```

目录必须支持普通 POSIX 工具和应用读取，不复制未使用文件，不暴露 Thread/Resource/Version ID 作为主要路径，也不把动态历史
目录注入 system/developer prompt。

本期只实现个人历史目录。`team` Tenant 不获得 `/history` 投影，不做团队任务目录、成员可见性、个人转团队或跨 Tenant 文件转移。
数据模型和端口继续以 `tenant_id` 为隔离边界，避免未来增加团队能力时重做资源身份、RLS、路径解析和 Volume 契约。

### 1.1 本次实际交付切片

当前已落地虚拟目录与低成本标题主链路：

- 迁移 `0036_personal_history_filesystem` 创建个人历史目录、文件关系、RLS、最小 ACL 和已有 receipt 回填；
- 迁移 `0037_thread_title_generation` 创建 personal Thread 标题 Outbox、claim fencing、pending 目录状态与最小 ACL；
- API 在首条 durable 输入事务内幂等写标题 Outbox，Scheduler 使用独立低成本模型异步生成标题并以 CAS 更新 Thread；
- Web 在 Run 轮询期间读取最新 Thread，使模型标题异步替换确定性标题；
- durable Thread 输入接受附件时，在同一事务内幂等维护历史关系；
- ResourceFS 增加 `/resources/history/...` 和 WebDAV/FUSE 可遍历的隐藏
  `/resources/.thread-files/<threadId>/files/...`；dot 根只用于父目录解析，Agent-facing 路径仍不暴露 Thread ID；
- ResourceFS 为全部 personal Thread 预声明空的稳定 `files` 目录，使首个附件只新增文件节点，不改变 rclone 已缓存的父目录拓扑；
- Worker 始终把 `/thread-files` 映射到稳定远端路径；旧 Sandbox 遗留的本地空目录会原地升级为软链接；
- Worker 仅依据领取事务提供的可信 `tenantKind=personal` 创建 `/history` 与 `/thread-files` 固定只读入口；
- `/history` 只枚举最近六个月目录，但已经知道的旧语义路径仍可精确读取，避免历史消息中的路径立即失效；
- 使用一个 `HISTORY_FILESYSTEM_ENABLED` 开关同时控制 API 关系写入、ResourceFS 投影和 Worker 入口准备；
- System Prompt 仅增加字节稳定的固定目录说明，不注入 Tenant、Thread、目录名或文件名等请求级事实。

以下能力继续后置：
- UI 改名后的新目录与旧路径兼容别名；
- `hasRecentHistory` 条件挂载与 Session generation 升级。当前 Skill 文件系统已经要求同一 Tenant ResourceFS Volume，历史目录
  直接复用该挂载，不新增 Volume、FUSE 进程或 Blob 副本；
- 10,000 目录性能 Gate、真实 Cube `find/rg` 黑盒和产品 UI 验收。

ResourceFS 历史路径当前与既有 ResourceFS HTTP 装配在同一进程内；接口边界保持独立，后续若吞吐或故障域需要，可拆成独立
子模块或服务，不改变 `/history`、`/thread-files` 和 Tenant Volume 契约。

### 1.2 Web 云盘与 `@` 文件引用试验切片

`test/cloud-drive-history-files` 在不改变 Sandbox 虚拟目录、数据库 Schema 和对象存储布局的前提下，复用个人历史关系增加用户侧入口：

- `GET /v1/me/history-files` 默认列出最近六个日历月有文件的个人任务，按 `lastFileAt + threadId` 游标分页；
- 支持任务标题、目录入口文件名和 Resource 原名的子串搜索；
- “加载更早任务”以当前窗口起点作为下一窗口上界，允许按需浏览六个月以前的个人历史，但 `/history` 的目录枚举窗口仍保持最近六个月；
- 下载只为当前 personal Tenant 已存在的历史关系签发 300 秒地址，DTO 不返回对象键或存储凭据；
- 技能中心增加“云盘”标签，按月份和语义任务组织文件；
- 输入框末尾输入 `@查询` 时按需搜索，选中结果以 `resourceId + versionId` 结构化附件提交；
- 历史文件与新上传文件使用同一个 Thread Input 附件协议，Agent 继续通过固定 ResourceFS 路径按需读取；
- 动态文件名、目录、ID、路径和查询结果不进入 System/developer Prompt 或工具 Schema。

该试验切片的接口、安全、性能和回退边界见 ADR-0130。未来若把 ResourceFS 查询拆为独立服务，Web API 与附件契约保持不变。

## 2. 非目标

本期不实现：

- `team` Tenant 的历史任务目录；
- 团队成员角色、共享/私有任务或成员级目录过滤；
- personal → team 发布、复制、转移、lineage、授权 API 或 UI；
- 跨多个 Tenant 聚合当前用户的历史文件；
- `/history` 目录枚举超过最近六个月的全生命周期历史；Web 云盘试验允许用户显式加载更早记录，但不扩大全局挂载目录；
- 独立 `search_history_files`、全文索引或向量检索工具；
- 对所有 Office/PDF 文件进行预解析或 OCR；
- 每用户或每 Thread Cube Volume；
- UI 标题变化立即重命名历史目录。

## 3. 已验证现状

### 3.1 ResourceFS

- Cubelet 使用 Tenant 级 host-volume capability 挂载只读 ResourceFS；
- Sandbox 通过 Cube Volume 在 `/resources` 看到普通文件系统；
- rclone 使用 `--read-only`、30 秒目录缓存和完整 VFS 读取缓存；
- 当前资源路径为 `/resources/<resourceId>/<versionId>/<safeFileName>`；
- 当前 ResourceFS 普通目录查询会先加载 Tenant 全部可见 ResourceVersion，再在内存中解析路径，不能直接扩展到大规模历史目录。

### 3.2 Thread 与附件

- Thread 已持久化 `created_by_user_id`、`title`、`created_at` 和 `updated_at`；
- 首条标题当前由 Web 对用户输入做确定性截断；
- durable `thread_input_receipts.input_attachments` 保存 Resource/Version 身份和顺序；
- 上传接口本身不绑定 Thread，只有附件随 Thread 输入提交后才形成“用户把文件用于这个任务”的事实。

### 3.3 Tenant 与未来扩展边界

- Tenant 已区分 `personal` 与 `team`；
- 所有核心聚合、RLS 和 Blob 引用都以 `tenant_id` 为边界；
- 当前 host-volume capability 只有 Tenant 身份，没有用户身份；
- 本期 Feature Gate 必须读取可信的 Tenant 类型，只允许 `personal` Tenant 创建和枚举历史目录；
- `team` Tenant 继续保留现有附件与 ResourceFS 行为，但本功能不为其生成 `/history` 或 `/thread-files` 历史投影。

这些约束只用于保证本期边界和未来兼容性，不代表本期已经实现团队任务、成员隔离或个人转团队能力。

## 4. 产品语义

### 4.1 `/history`

`/history` 是当前 Sandbox 所属个人 Tenant 的滚动历史发现视图：

```text
/history/
├── 2026-08-07_14-32-08_采购合同风险审查/
│   └── files/
│       ├── 2026-08-07_14-33-10_采购合同.docx
│       └── 2026-08-07_14-35-42_修改意见.xlsx
└── 2026-07-18_09-10-03_区域销量分析/
    └── files/
        └── 2026-07-18_09-11-16_销售数据.xlsx
```

只枚举同一 `personal` Tenant 中满足以下条件的任务：

```text
file_count > 0
last_file_at >= 数据库当前时间 - 6个月
```

Thread 创建时间决定目录名前缀，`last_file_at` 只决定是否出现在滚动视图中。旧 Thread 最近新增文件后会重新出现，但路径
不会移动。目录不会跨 Tenant 聚合；`team` Tenant 在本期没有 `/history` 投影。

### 4.2 `/thread-files`

`/thread-files` 始终代表当前 Thread，不受以下变化影响：

- UI 标题改变；
- `/history` 六个月窗口变化；
- Thread 在历史根目录中的语义别名变化；
- rclone 对历史根目录的短期缓存。

它不得只实现为指向可变标题路径的普通软链接。可选实现为：

1. Runtime 在 Sandbox 的临时运行目录生成当前 Thread 文件软链接集合，再把固定 `/thread-files` 指向该集合；
2. ResourceFS 提供不参与普通目录枚举的稳定内部 Thread handle，Sandbox 固定入口绑定该 handle；
3. Cube 后续提供受控子目录 bind 时，用 Thread 稳定内部视图替换上述实现。

无论选择哪一种，Agent-facing 路径不能要求模型拼接 Thread ID。

### 4.3 运行中改名的影响

如果直接把 `/history/旧标题` 改为 `/history/新标题`，运行中 Sandbox 会受到影响：

- 已打开的文件描述符通常可以继续读取；
- 新打开旧路径会在 rclone 目录缓存失效后返回不存在；
- 以旧目录为当前工作目录的进程可能得到陈旧或不可重新解析的路径；
- 若 `/thread-files` 直接指向旧标题目录，它会随之断开。

第一阶段因此不移动已分配目录。用户修改 UI 标题只改变 `threads.title`；当前 Sandbox 和旧历史路径不受影响。

后续改名 TODO 必须满足：

```text
先创建新语义别名
→ 新目录进入枚举
→ 旧目录停止枚举但继续可解析
→ 至少跨过全部活跃 Sandbox 和 rclone 缓存窗口
→ 再按明确保留策略退休旧别名
```

`/thread-files` 始终走稳定 Thread 视图，不参与标题别名切换。

### 4.4 本期 personal 范围

历史目录不做“当前登录用户跨所有 Tenant 聚合”。本期唯一启用形态为：

| 当前任务位置 | `/history` 内容 | `/thread-files` 内容 |
|---|---|---|
| personal Tenant | 该个人 Tenant 最近半年有文件的任务 | 当前个人任务文件 |
| team Tenant | 不由本功能创建或暴露 | 不由本功能创建历史投影 |

`personal` Tenant 仍通过现有 owner 关系归属于用户，但 Agent-facing 路径不包含 userId、tenantId 或 threadId。未来团队任务继续使用
独立 `team` Tenant；若产品支持“个人任务转团队”，应创建 Team Tenant 中的新任务副本并保留来源，不能原地修改来源 Thread 的
`tenant_id`。该规则只是扩展约束，不在本期实现。

## 5. 命名规则

### 5.1 标题模型

标题生成是独立后台能力，不修改主 Agent Prompt：

```text
首条用户输入 durable 提交
→ 写 title-generation outbox
→ 低成本模型读取用户原文与附件文件名
→ 返回严格结构化短标题
→ 校验与清理
→ 原子更新 UI 标题并分配历史目录
```

输入边界：

- 最多使用首条用户原文的受限字节窗口；
- 附件只提供原始展示文件名和媒体类型；
- 不读取附件正文、历史上下文、system prompt、工具输出或秘密；
- 原文中的指令只视为待概括文本，标题模型无工具和外部副作用能力。

输出边界：

- 严格 JSON，例如 `{ "title": "采购合同风险审查" }`；
- 标题正文建议 4～24 个中文字符或等价长度，硬上限 60 Unicode code points；
- 删除路径分隔符、控制字符、双点段、结尾点/空格和保留名称；
- 禁止模型输出时间前缀，时间只能来自服务端事实；
- 超时、拒绝、解析失败或校验失败时使用现有确定性标题派生作为回退。

标题结果不得覆盖已经由用户明确修改的标题。实现需要记录 `title_source`：

```text
deterministic | model | user
```

### 5.2 目录名称

统一格式：

```text
YYYY-MM-DD_HH-mm-ss_<safeTitle>
```

时间由服务端根据 Thread `created_at` 和创建时固化的展示时区生成；实现不得依赖进程当前本地时区。系统尚无用户时区时，
首版使用显式部署配置，并把时区标识写入历史目录事实，后续时区变化不重命名旧目录。

极端同一秒、同标题冲突时：

```text
2026-08-07_14-32-08_合同审查
2026-08-07_14-32-08_合同审查-2
```

数字仅作为极端兜底，正常重名由时间提供信息增量。

### 5.3 文件名称

统一格式：

```text
YYYY-MM-DD_HH-mm-ss_<safeOriginalName>
```

时间使用该 ResourceVersion 第一次随 durable Thread 输入提交的时间，而不是临时上传完成时间。同一 ResourceVersion 在同一
Thread 重复发送时不创建新目录项，只更新次数和最后使用时间。不同版本或不同 Blob 即使原始文件名相同，也分配独立名称。

## 6. 数据模型草案

精确迁移编号由实施时确定。所有表必须包含 RLS、最小 Runtime ACL、复合外键和可回退 Gate。

### 6.1 Thread 标题状态

可以在 `threads` 增加：

```text
title_source              text: deterministic | model | user
title_generated_at        timestamptz nullable
title_generation_version  integer
```

也可以建立独立标题事实表；实施切片需要根据现有 Thread update 并发模型选择，并在专项 ADR 冻结 CAS 规则。

### 6.2 `thread_history_directories`

```text
tenant_id                text
thread_id                text
directory_name           text
directory_timestamp      timestamptz
directory_time_zone      text
naming_state             pending | ready | fallback
first_file_at            timestamptz
last_file_at             timestamptz
file_count               bigint
version                  bigint
created_at               timestamptz
updated_at               timestamptz
```

建议约束：

```text
PRIMARY KEY (tenant_id, thread_id)
UNIQUE (tenant_id, directory_name)
FOREIGN KEY (tenant_id, thread_id) REFERENCES threads
file_count >= 0
ready/fallback 时 directory_name 非空
```

建议索引：

```text
(tenant_id, last_file_at DESC, thread_id)
(tenant_id, directory_name)
```

本期只为 `tenant.kind=personal` 写入和查询该表，个人归属继续由 personal Tenant 的现有 owner 关系表达。表内仍保留 `tenant_id`
作为身份、唯一约束和 RLS 边界，不增加仅适用于个人目录的 `user_id`，也不建立尚无法执行的 Team 成员级安全边界。

### 6.3 `thread_history_file_entries`

```text
tenant_id
thread_id
resource_id
resource_version_id
relation_type             user_attachment，后续可扩展 artifact
directory_entry_name
first_receipt_id
first_attached_at
last_attached_at
attachment_count
created_at
updated_at
```

建议约束：

```text
PRIMARY KEY (tenant_id, thread_id, resource_id, resource_version_id, relation_type)
UNIQUE (tenant_id, thread_id, directory_entry_name)
FOREIGN KEY (tenant_id, thread_id) REFERENCES threads
FOREIGN KEY (tenant_id, resource_id, resource_version_id) REFERENCES resource_versions
FOREIGN KEY (tenant_id, thread_id, first_receipt_id) REFERENCES thread_input_receipts
attachment_count > 0
```

目录关系在输入 receipt durable 接受的事务中建立。Run 后续失败或取消不删除该关系，因为用户已经把文件提交给该任务；在 API
校验阶段被拒绝、没有形成 durable receipt 的上传不进入历史任务目录，只保留在 Resource Library。

### 6.4 标题生成 Outbox

本节为后续阶段设计，本次未创建标题 outbox 或调用模型。迁移只预留 Thread 标题来源和生成版本字段，目录分配使用当前已有
`threads.title`，确定性标题记为 `fallback`。

标题请求至少需要：

```text
tenant_id
thread_id
source_receipt_id
request_digest
state
claim/fencing 字段
attempt_count
available_at
created_at
updated_at
```

同一 Thread 只能有一个生效的首次标题生成请求；重复投递必须按 digest 收敛。模型调用完成后以 Thread version 或标题来源 CAS
提交，防止覆盖用户修改。

### 6.5 未来标题别名

TODO 表草案：

```text
thread_history_directory_aliases
--------------------------------
tenant_id
thread_id
directory_name
state                    current | legacy
created_at
retired_at
```

第一阶段不创建也可以，但 `thread_history_directories.directory_name` 不能成为 Thread 的业务主键。

## 7. ResourceFS 改造

### 7.1 路径命名空间

保留既有路径兼容，新增保留段：

```text
/resources/skills/...
/resources/history/<semanticThreadDirectory>/files/<semanticFileName>
/resources/<resourceId>/<versionId>/<safeFileName>
```

Sandbox 固定入口：

```text
/history -> /resources/history
```

`history` 必须成为显式保留根段，不能与 Resource ID 解析混淆。

### 7.2 Catalog 端口

当前全量 `list({ tenantId })` 需要拆成路径定向端口，例如：

```ts
interface HistoryFilesystemCatalog {
  hasRecentHistory(input: { tenantId; now }): Promise<boolean>;
  listRecentThreads(input: { tenantId; since }): Promise<readonly HistoryDirectory[]>;
  resolveThreadDirectory(input: { tenantId; directoryName }): Promise<HistoryDirectory | undefined>;
  listThreadFiles(input: { tenantId; threadId }): Promise<readonly HistoryFileEntry[]>;
  resolveThreadFile(input: {
    tenantId;
    directoryName;
    fileName;
  }): Promise<ResourceFilesystemFile | undefined>;
}
```

普通 Resource 路径也应逐步改为 `listDirectory/resolveFile`，但历史功能不能以一次加载全部 Tenant Resource 为前提。

### 7.3 WebDAV 行为

- `PROPFIND /history` 只查询最近六个月目录摘要，不 join 文件与 Blob；
- `PROPFIND /history/<task>/files` 才查询该 Thread 文件；
- `GET/HEAD/Range` 复用现有 Blob 完整性和 ETag 逻辑；
- `PUT/POST/DELETE/MOVE/COPY/MKCOL` 全部拒绝；
- 标题尚未 ready 的 Thread 不进入 `/history`，当前轮附件继续使用现有 canonical `/resources` 路径；
- 六个月窗口由数据库时间计算，不接受 Cubelet 或 Sandbox 提交的当前时间。

### 7.4 原生工具体验

功能 Gate：

```bash
find /history -type f
rg --files /history
fd --type f 合同 /history   # 模板安装 fd 时
```

正文搜索会读取文件内容：

```bash
rg '违约责任' /history
```

它可能下载大量历史文本文件并占用 rclone 2 GiB VFS cache。静态 Agent 指令只需要说明先按路径/文件名缩小范围，再对少量目标
执行正文搜索；不新增动态目录内容到 Prompt。

## 8. Sandbox 与 Worker

### 8.1 Volume 需求

当前 Skill 市场已经让需要 Sandbox 的任务复用 Tenant 级 ResourceFS Volume，因此本次历史目录不再新增第二套 Volume 或
`hasRecentHistory` attach 判断：

```text
现有 Tenant ResourceFS Volume
  ├── /resources/skills
  ├── /resources/history
  └── /resources/.thread-files/<trustedThreadId>/files
```

这意味着历史能力只增加目录元数据查询，不增加每 Tenant Volume 数、FUSE/rclone 进程数和未读取 Blob 下载。纯文本响应仍不创建
Sandbox；只有工具调用需要 Sandbox 时才 acquire。若未来 Skill 不再默认依赖 ResourceFS，才恢复 `hasRecentHistory` 的索引
`EXISTS` 需求信号和 Session generation 升级设计。

### 8.2 固定入口准备

当可信 Tenant 类型为 `personal`，且 Sandbox acquire 成功、ResourceFS 已挂载后：

1. 验证 `/resources/history` 是只读目录；
2. 在 Sandbox 临时运行区域准备 `/history` 固定入口；
3. 根据当前 Thread 的稳定内部身份准备 `/thread-files`；
4. 验证两个入口均不能写入；
5. 不把入口或软链接写入 `/workspace`，避免进入 Workspace Revision。

准备失败必须失败关闭，不能继续让模型相信历史目录存在。`team` Tenant 不执行这组历史入口准备逻辑。

### 8.3 生命周期

- pause/resume 保留入口；
- Sandbox 冷建时从数据库关系重新建立，不依赖旧 guest 状态；
- 当前 Thread 新增附件后，在下一安全点刷新 `/thread-files` 视图；
- `/history` 依赖 rclone 30 秒目录缓存，新增或过期目录允许短暂最终一致；
- `/thread-files` 的当前轮附件必须在模型尝试读取前可见，不能只依赖 30 秒历史目录缓存。

## 9. 标题服务实施

本节已按 ADR-0121 实现。`0037_thread_title_generation` 增加单 Thread Outbox、claim fencing 与 pending 目录状态；API 在
首条 durable 输入事务中幂等创建任务，Scheduler 使用独立低成本模型异步生成标题，Web 在 Run 轮询期间读取最新 Thread。

标题生成只服务 personal 历史目录和同一任务的 UI 标题，当前作为现有 Scheduler 中的独立 consumer 运行，不立即拆新服务；
边界通过 `@hoox/thread-title` 端口隔离，后续吞吐、限流或故障域需要时可以独立部署。

处理规则：

1. personal Tenant 的 durable 首条输入提交后写 outbox；
2. consumer claim 后读取受限原文和附件名；
3. 调用配置的低成本文本模型；
4. 保存脱敏的模型、延迟、token 数与结果分类指标，不保存完整请求正文；
5. 校验结果并分配时间语义目录；
6. CAS 更新 Thread title，仅当 `title_source` 仍为 deterministic；
7. 标记目录 ready；
8. 失败按有界重试，最终写 fallback，不能让历史目录永久 pending。

UI 不等待标题模型完成：先显示确定性标题，收到 Thread 更新后替换。目录只在模型标题或 fallback 已经确定后出现。`team` Tenant
不由本功能创建标题 outbox 或历史目录事实。

## 10. 未来团队扩展约束（不在本期实施范围）

本期不创建任何团队相关表、角色、授权、发布 API、跨 Tenant Saga、Web UI、指标或后台任务。为了避免个人版本形成未来障碍，
当前实现只需遵守以下稳定约束：

- 历史目录、文件关系、ResourceVersion 和 Blob 引用始终以 `tenant_id` 为安全与身份边界；
- Agent-facing 路径不编码“个人”专用的 userId，也不把 Thread ID 作为主要目录名；
- Domain 和 ResourceFS 端口显式接收 Tenant 上下文，不从路径文字推导授权；
- Feature Gate 对 `tenant.kind=personal` 明确开放、对 `tenant.kind=team` 明确关闭；
- 不增加跨 Tenant 普通外键、隐式读取或可被未来误用的共享 capability；
- 个人任务未来转为团队任务时，采用向目标 Team Tenant 创建新任务副本并保留来源的语义，不原地修改 `tenant_id`。

团队能力启动前必须另立 ADR，冻结成员角色、私有/共享任务、双 Tenant 授权、复制范围、Blob 策略、lineage、审计、回滚和 UI
确认流程；这些内容不进入本期估算、迁移或验收。

## 11. 性能与资源预算

### 11.1 不增加的成本

- Cube Volume 数量：仍为每 Tenant 一个；
- 未读取文件的 MinIO 字节：不复制；
- 主模型 Prompt：不注入历史目录列表；
- Sandbox 工作区：历史入口不进入 Workspace Revision。

### 11.2 增加的成本

- 每个个人 Thread/ResourceVersion 关系一条 PostgreSQL 元数据；
- `/history` PROPFIND 返回当前 personal Tenant 最近六个月全部有文件任务目录；
- 文件打开后占用 rclone VFS cache；
- 历史目录复用既有 ResourceFS attach，只增加路径定向元数据查询；
- 每个新 personal Thread 产生一次标题任务；模型失败时按配置有界重试，输入只含受限首条原文与附件名称/媒体类型，不读取
  Blob 正文。

本期不产生 Team Tenant 历史索引、团队成员映射或跨 Tenant 文件复制成本。

### 11.3 查询约束

- 根目录查询只读 `thread_history_directories` 覆盖索引字段；
- 进入 Thread 后才 join `thread_history_file_entries` 与 Resource/Blob；
- exact GET 通过唯一目录名和文件名解析；
- 禁止 N+1 按 Thread 查询文件计数，`file_count/last_file_at` 在关系写事务中维护；
- 使用数据库 `clock_timestamp()` 或等价可信时间确定六个月窗口；
- rclone 目录缓存保持短窗口，不能把它当授权事实源。

### 11.4 性能 Gate

至少构造：

| 场景 | 数据量 | 必测项 |
|---|---:|---|
| 普通个人历史 | 1,000 个半年任务，每任务 5 文件 | 根 PROPFIND 延迟、响应大小、内存 |
| 重度个人历史 | 10,000 个半年任务，每任务 5 文件 | 根目录可用性与告警阈值 |
| 大 Thread | 单任务 1,000 文件 | 文件目录 PROPFIND 与 `rg --files` |
| 冷缓存读取 | 16 MiB 文件 | 首次读取、Range、VFS 占用 |
| 热缓存读取 | 同文件重复读取 | API/MinIO 命中变化 |

首版不设置任意静默条数上限。若 10,000 目录无法达到目标，必须以真实 Gate 结果重新审议分层或分页替代，不能悄悄漏目录。

## 12. 可观测性

新增建议指标：

```text
history_directory_propfind_duration_ms
history_directory_entry_count
history_thread_file_count
history_file_read_bytes_total
history_resourcefs_attach_required_total{reason}
history_title_generation_total{outcome,model}
history_title_generation_duration_ms
history_title_generation_tokens_total
history_directory_collision_total
history_stale_alias_read_total          # TODO 改名阶段
```

关键指标应带受控的 `tenantKind` 或结果分类维度，用来验证 personal 请求被启用、team 请求被 Gate 拒绝；不得使用 tenantId、userId、
threadId、标题或文件名作为高基数标签。

日志只记录 Tenant/Thread 的受控内部标识、计数、耗时和结果分类，不记录完整标题模型输入、文件正文、签名 URL 或对象键。

## 13. 实施阶段

截至 2026-08-07 的完成状态：

- 阶段 0：已完成 Feature Flag、固定路径与静态 Prompt 契约；性能基线后续补充；
- 阶段 1：已完成迁移、personal Gate、事务双写和一次性迁移回填；分批回填工具后续按生产数据规模决定；
- 阶段 2：已完成标题 Outbox、低成本模型、CAS 更新、pending 目录就绪与 fallback；
- 阶段 3：已完成路径定向 Catalog、WebDAV 列举/精确读取、Range/ETag 复用和 team 关闭；
- 阶段 4：已完成固定入口和可信 Tenant Gate；因为现有 Skill Volume 已常驻，未实现 `hasRecentHistory` 条件挂载；
- 阶段 5：已完成字节稳定的静态 Prompt 说明与 Web 异步标题刷新；真实 Cube 黑盒和规模性能 Gate 后续实施。

下面保留完整目标阶段，未完成项继续作为后续验收清单。


### 阶段 0：ADR、性能基线和 Feature Flag

- 接受 ADR-0118，并以 ADR-0119 收窄首期范围；
- 增加 `HISTORY_FILESYSTEM_ENABLED` 与标题生成配置契约；
- Feature Gate 同时要求开关开启且可信 `tenant.kind=personal`；
- 对当前 ResourceFS PROPFIND 和 Volume attach 建立基线；
- 冻结 Agent-facing `/history`、`/thread-files` 和时间命名规则。

验收：配置关闭或 Tenant 类型为 `team` 时，行为与当前完全一致。

### 阶段 1：规范化个人历史关系

- 增加历史目录和文件关系迁移、RLS、ACL、回退 Gate；
- 仅对 personal Tenant 的 Thread 输入提交事务幂等写关系；
- 维护 `file_count/first_file_at/last_file_at`；
- 只为已有 personal receipt 做分批、可暂停、可重跑回填。

验收：重复附件、取消/失败 Run、personal Tenant 隔离和回填重跑全部收敛，team 数据不产生历史关系。

### 阶段 2：个人标题生成

- 增加 title outbox、consumer、严格模型适配器和 fallback；
- 只为 personal Tenant 触发历史标题生成；
- Web 接收异步标题更新；
- 标题和目录分配使用 CAS，不覆盖用户标题；
- 标题模型 wire trace 默认关闭或严格脱敏。

验收：模型超时、非法输出、重复消费、用户并发改名和 Provider 不可用均有确定结果。

### 阶段 3：ResourceFS 个人历史目录

- 新增 `history` 根段与路径定向 catalog；
- 只对 personal Tenant 实现最近六个月目录、Thread 文件目录和 exact file read；
- 复用 Range、ETag、Blob 完整性和只读方法限制；
- 删除历史路径上的全 Tenant `catalog.list` 依赖。

验收：协议测试、PostgreSQL 集成测试、10,000 目录性能 Gate，并证明 team Tenant 不暴露历史根。

### 阶段 4：Sandbox 固定入口与需求信号

- 仅在可信 `tenant.kind=personal` 时按 `hasRecentHistory` 决定 ResourceFS 能力；
- 创建 `/history` 与稳定 `/thread-files`；
- 处理 Thread Session 无挂载到有挂载 generation 升级；
- 验证 pause/resume、冷建、当前轮新增附件和只读权限。

验收：新个人 Thread 可用旧历史、标题变化不破坏 `/thread-files`、无历史 personal Tenant 的普通工具任务不 attach，team Tenant
不会因历史功能新增 attach。

### 阶段 5：Web 与原生工具体验

- Web 展示 personal 任务的模型标题及 fallback 状态；
- Web 云盘试验按月份/任务浏览、搜索、加载更早、下载并加入当前输入；
- 输入框 `@` 选择历史文件后沿用统一结构化附件协议；
- Sandbox 模板 Gate 验证 `find`、`rg`，决定是否加入 `fd`；
- 静态 Prompt 只说明固定目录与先按文件名缩小范围，不注入动态内容；
- 增加黑盒 E2E：上传 → 新个人 Thread → `find/rg --files` → 读取历史文件。

验收：模型无需 ID 或专用搜索工具即可定位并读取个人历史文件。

标题改名兼容别名和团队能力均不属于本期实施阶段，分别在后续 ADR 中排期。

## 14. 测试矩阵

### Domain

- 时间语义目录与文件名清理；
- 同秒冲突分配；
- 标题 source 状态与用户修改优先级；
- 同 ResourceVersion 去重和 attachment count；
- 六个月边界；
- 非 personal Tenant 不创建历史事实。

### Persistence

- personal 关系写入与 receipt 同事务；
- RLS 和复合外键；
- 覆盖索引查询计划；
- personal 回填幂等且跳过 team 数据；
- directory summary 并发更新；
- 标题 outbox claim/fencing/CAS。

### API/ResourceFS

- WebDAV PROPFIND depth 0/1；
- 保留段与旧 Resource 路径兼容；
- 文件 GET/HEAD/Range/ETag；
- 未授权 Tenant 404；
- 历史文件列表默认六个月、游标成对校验、旧窗口加载与响应脱敏；
- 历史文件下载短期签名、签名前后双重授权和跨 Tenant 404；
- team Tenant 不暴露本功能的历史根；
- 标题 pending、过期历史和 exact path；
- 所有写方法失败。

### Worker/Sandbox

- personal Tenant 有/无历史时的 Volume 需求；
- team Tenant 不因历史功能 attach，当前附件行为不回归；
- `/history` 与 `/thread-files` 只读；
- pause/resume 与冷恢复；
- 当前输入新增附件立即可见；
- UI 标题更新不影响运行中 `/thread-files`；
- `find`、`rg --files`、可选 `fd`。

### E2E

```text
上传文件并提交到个人任务
→ 标题生成并出现语义目录
→ 新建个人任务且不上传新文件
→ Agent 通过 /history 找到旧文件
→ 读取成功、写入失败
→ 超过/模拟六个月后不再枚举
→ Web 云盘搜索旧文件并通过 @ 选择到新任务
→ 结构化附件进入当前 user turn，Agent 从固定路径读取
→ 原 Resource 与当前 Thread 稳定入口仍符合约定
```

另加负向 E2E：相同 Feature Flag 下，team Tenant 不出现 personal 历史目录，也不能借该功能跨 Tenant 读取文件。

## 15. 灰度与回滚

建议开关顺序：

```text
personal history relation dual-write
→ shadow query 对比 personal receipt
→ ResourceFS history root 仅内部 Gate
→ development 黑盒
→ 小比例 personal Tenant 可见
→ personal Tenant 默认开启
```

回滚顺序：

1. 停止 personal `/history` 和 `/thread-files` 投影；
2. Worker 恢复只按当前附件请求 ResourceFS；
3. 保留个人历史关系 dual-write 或停止新增，但不删除数据；
4. 标题服务可独立关闭并回退确定性标题；
5. 旧 canonical Resource 路径继续工作；
6. `team` Tenant 不需要回滚，因为本期未启用团队历史功能。

## 16. 待后续 ADR 冻结的事项

与个人历史目录直接相关，但不属于本期首发：

- UI 手动改名后的别名保留时长与运行中 Sandbox 兼容；
- 个人展示时区来源和变更策略；
- 10,000 半年任务性能 Gate 未达标时采用分层、流式 readdir 还是受控上限；
- Artifact 是否进入 `files`，还是增加 `artifacts` 子目录。

未来团队扩展另立 ADR，不进入本期实现计划：

- Team Tenant 的成员角色、私有/共享 Thread 和成员级可见性；
- 团队 `/history` 的授权与目录投影方式；
- personal → team 发布是完整 Context、摘要还是用户选择内容；
- 跨 Tenant Blob 使用 server-side copy 还是受控全局内容去重；
- 发布 lineage、审计、幂等、失败补偿、回滚和 UI 确认流程。
