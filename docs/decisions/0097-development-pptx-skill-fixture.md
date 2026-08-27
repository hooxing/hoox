# ADR-0097：development PPTX Skill 测试目录发布

- 状态：已替代
- 日期：2026-08-03
- 决策者：Runtime 维护者
- 关联任务/PR：本地 Skill Center 安装测试
- 替代关系：细化 ADR-0094 与 ADR-0095 的受信发布边界；已被 ADR-20260827174210 替代

## 背景

Skill Center 与 Skill Runtime 已具备目录、用户安装、Run 快照、后端指令读取和按需 Sandbox 物化能力，但本地开发数据库没有真实 Skill 版本，无法纵向验证安装流程。测试目标指定 Anthropic `skills/pptx` 的固定上游目录。该内容带专有许可证，因此本决策只覆盖本地 development fixture，不把它解释为生产分发授权。

## 决策驱动因素

- 测试条目必须包含完整 `SKILL.md`、脚本、校验器和 Schema，安装后能够被 Runtime 读取及物化；
- 目录元数据必须在 PostgreSQL，文件正文必须在私有 S3/MinIO，不能建立空条目；
- 导入必须固定上游提交、保留许可证并可重复校验；
- 普通 API 与 Worker 不能获得目录发布权限；
- 开发服务启动不能隐式改写受管目录。

## 备选方案

### 方案 A：显式 development publisher

保留固定 vendor 副本，由只允许 development 的运维命令读取、校验和哈希文件，幂等上传稳定对象，再使用 Migrator 连接原子发布目录版本。正常 API 仍只读目录。

### 方案 B：在数据库迁移中插入目录元数据

实现简单，但迁移不能原子写入 S3/MinIO 正文，容易产生安装成功而运行失败的空目录项。

### 方案 C：API 启动时自动导入

使用方便，但会让普通 Runtime 获得发布能力，并使服务启动包含宿主文件读取和目录写入副作用。

## 选择

采用方案 A，并限定如下：

1. vendor 固定为提交 `b29e7cf65e5cb78a5ac33d582270551bc74a14eb`，保留上游 `LICENSE.txt`；
2. `SOURCE.md` 只记录仓库来源，不进入运行时 Skill 包；其余 56 个文件全部进入文件清单；
3. publisher 仅在 `RUNTIME_ENV=development` 运行，使用 `MIGRATION_DATABASE_URL` 和私有 S3 配置；
4. 目录键为 `pptx`，默认调用名同为 `pptx`，安全状态标记为 `restricted`；
5. 文件对象按内容摘要使用确定性稳定键幂等写入，任何已有对象或目录行不一致都失败关闭；
6. API、Worker 和生产启动路径不调用 publisher，生产发布也不包含自动导入动作。

## 理由

方案 A 保持 ADR-0094 的受信发布边界，同时提供可运行的完整测试包。方案 B 会破坏 Blob/S3 正文边界；方案 C 会把开发便利转化为常驻服务权限和启动副作用。

## 影响

### 正面影响

- Skill Center 能显示、安装和卸载真实 PPTX 测试技能；
- 新 Run 可读取固定 `SKILL.md`，首次 Sandbox 工具调用可物化完整资源；
- 重复发布不会创建浮动版本或覆盖不一致内容。

### 负面影响与成本

- 仓库增加约 1.2 MiB 的受限 vendor fixture；
- 开发环境首次发布需要上传 56 个文件和一个规范包清单；
- 更新上游提交需要重新审阅许可证、摘要和兼容性。

### 安全、数据与运维影响

- 发布命令持有 Migrator 与对象存储写权限，只能由本地开发者显式执行；
- 普通用户 API 仍只能安装目录中的固定版本，不能发布内容；
- fixture 标记为 `restricted`，并明确排除生产授权与发布路径。

## 验证

- 单元测试固定提交、文件数量、入口、许可证、关键脚本及 Schema；
- 执行 publisher 后通过 `/v1/skills` 验证目录投影；
- 通过 Web 技能中心完成安装，并通过 `/v1/me/skills` 验证用户关联；
- 新建 Run 后验证 Skill 快照与运行时内容读取不返回 `SKILL_CONTENT_UNAVAILABLE`。

## 可逆性与回退

代码回退可删除显式发布命令和 vendor fixture。开发数据库中的固定目录版本需要由受信运维操作先撤销目录状态、确认没有安装或 Run 快照引用后再清理；既有 Run 快照保持不可变，不能通过覆盖版本回退。

## 后续工作

- 正式技能中心上线前建立独立的生产发布审批、许可证证据和签名包流程。

## 实施记录

- 2026-08-03：导入固定 PPTX fixture，增加 development publisher 与包完整性测试。
