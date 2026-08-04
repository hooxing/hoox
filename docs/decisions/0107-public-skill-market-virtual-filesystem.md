# ADR-0107：公开 Skill 市场虚拟文件系统

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联任务/PR：Sandbox 直接浏览公开 Skill 市场
- 替代关系：局部替代 ADR-0095、ADR-0103

## 背景

现有 Skill Runtime 只把已安装且已调用的精确版本复制到 `/skills/<invocationName>`。这种按 Run 物化方式会重复
传输同一市场内容，也让模型无法在 `AVAILABLE_SKILLS` 没有合适项时发现公开市场中的其他 Skill。`/resources`
已经由只读 ResourceFS Volume 虚拟进入 Sandbox，适合承载同样来自 PostgreSQL 与私有 Blob/S3 的市场视图。

用户确认：公开市场 Skill 即使没有安装，也可以作为模型可浏览、可读取的内容；安装关系只决定 Prompt 预选目录、
调用别名、`skill` 工具许可和 Run 快照，不作为文件系统可见性的边界。

## 备选方案

### 继续按调用复制到 `/skills`

保持安装即发现边界，但每个 Sandbox 重复传输文件，无法支持市场探索，且需要维护物化、增量补齐和只读封装逻辑。

### 新增独立 `/skills` Volume

能提供虚拟视图，但增加第二套 Volume、能力、挂载与运维故障面，并与已有 ResourceFS 数据面重复。

### 在现有 `/resources/skills` 投影公开市场

复用 ResourceFS、Tenant 能力和只读挂载；目录查询按需读取元数据，文件打开时才读取 Blob，不提前复制市场内容。

## 选择

选择第三种方案：

- 每个具备 Sandbox 工具能力的 Sandbox 挂载现有 `/resources`；公开市场投影位于
  `/resources/skills/<canonicalKey>/<exactVersion>/...`。
- `/resources/skills/<canonicalKey>/_metadata.json` 提供推荐版本和可用精确版本；版本目录不使用可变的
  `latest`，避免指令与脚本在恢复或并发发布时错配。
- 目录只展示 active Skill 和 available 版本；硬撤销版本不再可读。旧版本只要仍被安装、Run 快照、调用或审计
  引用就继续保留；未来可以回收没有引用且超过保留期的版本。
- `AVAILABLE_SKILLS` 仍只注入本次 Run 已安装且启用的快照项。固定 Prompt 允许目录中没有合适项且任务确有需要时
  浏览公开市场目录。
- `skill` 工具仍只接受 `AVAILABLE_SKILLS` 中的精确安装名称。未安装 Skill 可以作为普通市场文件被模型读取，
  但不能借此获得调用别名或改写 Run 快照。
- 显式调用和 `skill` 工具继续由后端直接加载已固定版本的 `SKILL.md`，保持零 Sandbox；工具结果中的
  `package_root` 改为公开市场中的精确版本目录。
- 删除每次 Sandbox 调用前复制 Skill 包及 `/skills` 目录封装；ResourceFS 在文件打开时读取并校验 Skill Blob。
- 普通 Resource 上传仍限制为 16 MiB。Skill 文件沿用发布端 32 MiB 上限，ResourceFS 通过独立 Skill Blob 读取
  配置保留该边界，不扩大普通上传配额。

## 理由

同一只读虚拟数据面能避免把市场复制到每个 Sandbox，并让市场发布立即形成统一目录视图。精确版本目录把模型读到的
`SKILL.md`、引用资源和脚本绑定在同一不可变版本；安装与文件可见性分离后，现有用户选择和 Run 可恢复语义仍然成立。

## 影响

### 正面影响

- 未安装公开 Skill 可被模型按需发现和读取，不需要先传输或安装；
- 已安装 Skill 的 Prompt、别名、工具调用和 Run 快照语义保持不变；
- 市场文件只在目录查询或打开时读取，不按 Sandbox 复制；
- 不新增数据库表、第二个 Volume 或新的信任子系统。

### 负面影响与成本

- 所有会使用 Sandbox 工具的一次性 Sandbox 都依赖 ResourceFS，而不再只有带附件的任务依赖它；这扩大了
  ResourceFS 故障域，局部替代 ADR-0103 的按附件挂载结论。
- 市场目录允许模型看到用户未安装的 Skill，Prompt 目录不再是发现全集；产品与审计必须区分“浏览”和“安装/调用”。
- 市场上架内容可能包含恶意指令或脚本。首版不引入发布者信任等级或未安装 Skill 的差异化执行权限，仍由现有
  Platform Harness、工具许可、网络与 Sandbox 边界约束执行。

### 安全、数据与运维影响

- ResourceFS 能力继续限定 Tenant 和只读访问；响应不得暴露 Blob 引用、签名 URL、数据库 ID 或存储错误。
- Skill 文件读取必须校验声明大小、32 MiB 上限和 SHA-256 摘要；普通 Resource 继续使用原有 16 MiB 上限。
- 硬撤销必须使新目录查询和文件读取失败关闭。已经进入 Cubelet/rclone 缓存的字节需要通过短缓存、失效机制或
  运维重挂载控制撤销窗口。
- 上架阶段的恶意内容检测、脚本静态/行为分析和发布者信任等级记为后续 TODO，不阻塞本次虚拟文件系统。

## 验证

- 单元测试覆盖目录规范化、精确版本路径、Prompt 市场浏览规则、`skill` 工具仍拒绝未安装名称；
- ResourceFS 测试覆盖根目录投影、递归目录、元数据、Range/HEAD、摘要校验和 Blob 引用不泄漏；
- PostgreSQL 集成测试证明不同 Tenant 均可浏览同一公开市场、未安装也可读取，并能访问保留的旧精确版本；
- Worker 测试证明 Sandbox 工具要求 ResourceFS，且不再执行 Skill 包复制、删除或 chmod；
- 全仓类型检查、单元测试、集成测试与文档 Gate 通过。

## 可逆性与回退

没有数据库迁移。回退时恢复按调用物化和 `/skills/<invocationName>`，移除 ResourceFS 的 `skills` 投影并回退
Prompt 版本即可。回退前必须确认没有 Skill 指令只引用新的 `/resources/skills` 路径；市场 Blob 和精确版本元数据
继续保留，不需要删除。

## 后续工作

- 在 Skill 上架流程增加恶意内容检测、脚本静态/行为分析和发布者信任策略；
- 定义无安装、无 Run/Invocation/审计引用旧版本的保留期与垃圾回收作业；
- 明确硬撤销的 ResourceFS/rclone 缓存失效时限并增加运维演练。
