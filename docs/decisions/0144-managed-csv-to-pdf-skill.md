# ADR-0144：固定模板依赖与受管 CSV 转 PDF Skill

- 状态：已接受（试验版）
- 日期：2026-08-10
- 决策者：Runtime 维护者
- 关联任务/PR：团队任务附件转换为 PDF
- 替代关系：补充 ADR-0095、ADR-0097、ADR-0112 与 ADR-0139

## 背景

团队任务已经可以把文件附件和已启用 Skill 固化进 Run，但开发 Sandbox 模板只安装
`libreoffice-impress`。模型收到 CSV 后即使正确读取附件，也没有受管的转换指令、Calc 后端或可靠的输出校验，
容易临时拼接裸 `soffice` 命令，甚至在转换失败后交付旧文件。原模板还从滚动 Debian 仓库安装系统包，基础镜像虽以
摘要固定，构建结果仍会随仓库时间变化。

## 决策驱动因素

- 系统依赖必须在不可变 Sandbox 模板中提供，Run 内不得临时安装；
- CSV 是不可信输入，不能把以公式前缀开头的单元格交给 Calc 执行；
- 附件文件名和完整路径是用户可控数据，不能由模型插值到 shell 命令；
- 并发 Run 不能共享 LibreOffice 用户配置或锁文件；
- 转换成功必须由实际 PDF 字节证明，不能只依据进程退出码；
- 团队 Skill 仍由 Owner/Admin 显式启用，新 Run 读取团队安装事实，发布器不能越权代装；
- development fixture 必须固定文件清单、内容摘要和精确版本，可重复发布但不能覆盖漂移内容。

## 备选方案

### 方案 A：只在提示词中让模型运行裸 `soffice`

实现最少，但缺少 Calc 依赖、隔离 profile、输入上限和 PDF 完整性校验；模型还可能为每个任务临时选择不同参数。

### 方案 B：固定系统仓库快照，并发布 first-party 转换 Skill

模板锁定 Debian snapshot 和 LibreOffice Calc 版本；Skill 提供单一 wrapper，对 CSV/TSV 规范化后转换并校验 PDF，
再明确要求模型调用 `deliver_file`。Skill 继续走受管目录、团队启用和 Run 快照链路。

### 方案 C：在 API 或 Worker 宿主进程直接转换

可以绕开模型执行，但会让应用进程解析不可信 Office 输入、引入宿主命令和文件系统权限，违背工具路由与 Sandbox
边界，且扩大常驻进程攻击面。

## 选择

采用方案 B，并限定如下：

1. `agent-sandbox-pptx` 基础镜像摘要不变，把 Debian 与 security 源锁定到
   `20260202T000000Z` snapshot，安装 `libreoffice-calc` 与 `libreoffice-impress`
   `4:7.4.7-1+deb12u10`；其余 APT 依赖也由同一不可变 snapshot 解析。
2. 模板构建必须真实执行一次包含中文的 CSV→PDF 转换并验证非空输出；仅检查 `soffice` 可执行文件存在不算就绪。
3. first-party 包固定为 `csv-to-pdf@1.1.0`，规范包摘要为
   `4c14b62df37308eb6f8cdea5a4d37b0da2dc42bee9094ff3149ff1775ed7fad6`，只包含
   `SKILL.md`、内部许可证说明和 `scripts/csv_to_pdf.py`。
4. wrapper 的命令参数只接受完全匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$` 的 `resourceId` 与
   `versionId`。它自行进入 `/resources/<resourceId>/<versionId>/`，要求其中恰好一个非符号链接的普通
   `.csv`/`.tsv`；用户文件名和完整路径不进入 shell 参数。
5. wrapper 只接受 UTF-8（可带 BOM）的表格正文，先以 Python 标准库解析，再以全部字段加引号的规范 CSV
   交给 Calc，并启用 quoted-as-text，防止公式前缀被解释。输入限制为 25 MiB、100000 行、1024 列、
   2000000 个单元格。
6. 每次执行创建独立 `UserInstallation` 与临时目录，固定 locale、时区和导入/导出 filter；输出名只由两个
   受限 ID 的 SHA-256 派生，并强制位于 `/workspace/output`。输出必须非空且同时具有 `%PDF-` 文件头和尾部
   `%%EOF`，之后才原子移动到目标路径。
   这里保证确定的输入解释和成功语义，不承诺不同 LibreOffice 版本生成逐字节相同的 PDF。
7. Skill 指令只能把经过同一正则验证的两个 ID 传给 wrapper，并要求以 wrapper stdout 返回的固定路径调用既有
   `deliver_file`，同时省略用户可控展示名；转换脚本本身不访问 Runtime API、不持有凭据，也不能
   绕过 Artifact 发布事务。
8. development publisher 只接受仓库固定目录和固定摘要，使用 Migrator 数据库连接与独立 Skill publisher S3
   凭据幂等写入受管目录。它不自动创建 `tenant_skill_installations`；团队 Owner/Admin 仍通过既有 Skill Center
   启用，之后创建的新 Run 由现有 `createRunSkillSnapshot` 固化该精确版本。

## 理由

方案 B 把 Office 解析留在已有 Sandbox 故障域，同时让转换参数、失败语义和交付顺序成为可审阅的固定 Skill。
固定 snapshot 比仅固定顶层包版本更完整，因为 APT 的传递依赖也从同一不可变索引解析。保留显式团队启用避免
development 发布动作拥有团队管理权限，也保证已创建 Run 不因之后安装或停用而漂移。

## 影响

### 正面影响

- 团队启用后，新 Run 能看到并加载精确 CSV 转 PDF Skill；
- 模板在发布前证明 Calc 数据面可用，失败不会被误当成交付成功；
- 并发转换隔离 LibreOffice profile，CSV 公式注入和资源耗尽风险被收窄；
- Skill 内容与系统依赖都有固定版本和可审计摘要。

### 负面影响与成本

- Sandbox 镜像增加 LibreOffice Calc 及其依赖，构建和分发体积上升；
- 首版只接受 UTF-8 CSV/TSV，不处理 XLS/XLSX/ODS、旧编码、密码文件或复杂打印布局；
- Calc PDF 的分页仍受内容宽度影响，固定 wrapper 不等于版式编辑器；
- Debian snapshot 需要在构建网络中可访问，镜像更新必须显式选择新 snapshot 并发布新模板/Skill 版本。

### 安全、数据与运维影响

- CSV 在 Sandbox 内解析，wrapper 不读取凭据、不访问网络，不把单元格正文写入日志；
- LibreOffice 仍属于复杂解析器，必须继续依赖 Sandbox 隔离、命令时限和镜像漏洞更新流程；
- publisher 持有高权限数据库连接，只允许 `RUNTIME_ENV=development` 显式运行，普通 API/Worker 不获得目录写权限；
- 新模板必须使用新的不可变镜像标签和 CubeSandbox Template ID，旧模板保留到真实团队 Run 冒烟通过后再回收。

## 验证

- publisher 单元测试固定元数据、文件清单、仅 ID 的入口命令、隔离 profile、包摘要并拒绝任意字节漂移；
- persistence build/typecheck、直接 Vitest、Biome format/lint 与 `git diff --check` 通过；
- Docker 构建从固定 snapshot 安装精确 Calc/Impress，并执行真实中文 CSV→PDF 冒烟；PDF 文本必须仍包含
  `=1+1`，证明公式前缀没有被 Calc 求值；输入文件名同时包含 `$()` 与反引号，构建断言对应命令不会执行；
- PostgreSQL/MinIO 集成测试真实发布固定包，断言重复发布幂等且目录发布者漂移被拒绝；团队 Owner 安装后新建
  Run 的 `run_skill_snapshot_items` 精确包含 `csv-to-pdf@1.1.0`；
- 新 Template 注册后，必须以真实团队附件任务验证 wrapper 成功后产生非空 PDF Artifact，失败场景不出现
  `deliver_file` 成功事实；该端到端门禁不能由本地镜像构建或目录发布结果替代。

## 可逆性与回退

可以停止发布新模板并回到旧 Template ID；这会同时失去 CSV 转换能力。目录版本一旦被团队安装或 Run 快照引用，
不能直接删除，应先将版本撤销以阻止新安装，再保留不可变文件供历史事实读取。已经发布的 PDF Artifact 是合法用户
事实，不随 Skill 或模板回退删除。

## 实施记录

- 2026-08-10：加入固定 Debian snapshot、LibreOffice Calc、构建时转换冒烟、first-party wrapper 与
  development publisher。
