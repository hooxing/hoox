# ADR-20260818144124：统一项目身份为 Hoox

## 状态

已接受，2026-08-18。替代 ADR-20260816002622 与 ADR-20260816114151 中“项目技术底座继续命名为 AISay Runtime”的当前约束；两份旧 ADR 作为历史记录保留原文。

## 背景

项目在内部开发阶段先后使用过 `CubeSandbox Agent Runtime`、`cubesandbox-agent-runtime`、`AISay Runtime` 和 Hoox。ADR-20260816002622 曾把第一方技术身份迁移到 AISay Runtime，ADR-20260816114151 又把用户面对的 Agent 产品命名为 Hoox、同时保留 AISay Runtime 作为技术底座。团队现已确认 Hoox 是唯一项目名称，继续维持产品名与仓库、包、部署身份分离会增加认知、发布和排障成本。

本次迁移发生在项目尚未公开发布第一方 npm 包的阶段，可以一次性切断 `@aisay/*` 等内部身份。但仓库已经存在本地开发数据、历史任务、外部 Provider 配置和不可变 Skill 版本，不能把所有旧字符串机械替换。

## 决策驱动因素

- 用户界面、模型身份、仓库、包作用域、部署标识和供应链证据使用同一名称；
- 不把第一方项目品牌与 CubeSandbox、E2B 等第三方 Provider 名称混淆；
- 历史 ADR、持久主键和已生成外部数据保持可解释、可恢复；
- 目录改名不能导致 Codex 历史任务或另一台开发机无法定位仓库；
- Prompt 固定字节发生变化时必须推进版本；
- 迁移必须能通过项目身份契约、构建、测试和供应链 Gate 验证。

## 备选方案

### 方案 A：只继续使用 Hoox 作为页面品牌

改动最少，但会永久保留 `AISay Runtime`、`@aisay/*` 和 Hoox 三套身份，文档、部署、包依赖和诊断信息仍然割裂。

### 方案 B：对所有 Cube/AISay 字符串做机械替换

表面最彻底，但会错误修改 `@cubesandbox/sdk`、`CUBESANDBOX_*`、Provider 运维目录、历史 ADR、数据库迁移锁和已经发布的持久主键。

### 方案 C：按所有权和持久性边界统一为 Hoox

一次性迁移所有第一方当前身份，保留第三方专有名、历史记录和不透明持久标识，并提供目录及多机恢复手册。

## 选择

采用方案 C，并规定：

1. 对外产品名、技术项目名、仓库名和英文品牌统一为 **Hoox**。
2. 根包名改为 `hoox`；第一方 Workspace 包统一由 `@aisay/*` 迁移为 `@hoox/*`，不提供双 scope 兼容层。
3. Docker Compose、JWT audience、PostgreSQL `application_name`、临时文件前缀、Mem0 source、浏览器偏好键和供应链属性统一使用 `hoox`。
4. 用户界面、内部管理页面和固定 Platform Harness 只使用 Hoox；Prompt 版本从 `runtime-system-prompt.v14` 升级到 `runtime-system-prompt.v15`。
5. `hoox.aisay.cc` 暂时作为既有计划入口保留。该字符串只表达当前域名基础设施，不再代表项目技术名称；确定新域名后另行 ADR 迁移。
6. `CubeSandbox`、`@cubesandbox/sdk`、`CUBESANDBOX_*`、CubeSandbox 适配类、`deploy/cubesandbox` 和相关供应链来源证据保持不变。
7. PostgreSQL advisory lock `cube_runtime_schema_migrations_v1`、Skill 主键 `skill_cube_csv_to_pdf` 等已经形成持久语义的不透明标识保持原值。
8. CSV 转 PDF Skill 的发布者、兼容性和许可证身份通过新的不可变版本表达，不原地伪装已经发布的旧版本。
9. 本机主仓库目录由 `D:\hopesoft-hooxing\project\agent runtime\cubesandbox-agent-runtime` 迁移为 `D:\hopesoft-hooxing\project\agent runtime\hoox`；过渡期允许旧路径使用 Windows Junction 指向新目录。
10. GitHub 仓库改名和远端 URL 更新是代码提交之外的托管平台操作；未完成远端改名时不得提前把本地 `origin` 指向不存在的地址。
11. 已接受 ADR 保留其形成时的名称，不进行追溯改写；当前代码、配置、非历史文档、测试、锁文件和生成制品使用 Hoox。

## 影响

- 所有第一方包模块说明符发生破坏式变化，任何遗漏的 import、pnpm filter、构建别名或部署裁剪规则都会失败关闭。
- 旧 JWT audience 不再被新配置接受，签发方和验证方必须同步切换。
- Compose 项目名和卷名变化会创建新资源；需要旧 MinIO 数据时必须显式复制或回退名称。
- 浏览器团队切换器偏好会恢复默认值；认证会话已经使用 `hoox.*` 键，不受本次修改影响。
- Mem0 中已经写入的 `source=aisay-runtime` 记录保持原值，新记录使用 `source=hoox`，统计时需允许历史值共存。
- 本地 Codex 对话正文存储在仓库外，但历史任务可能保存旧绝对路径；目录 Junction 和恢复手册用于降低继续历史任务的风险。
- `hoox.aisay.cc` 暂时仍包含历史组织域名，后续域名变化不能通过本次改名擅自推断。

## 验证

- 项目身份契约固定根包、28 个第一方 Workspace 包、Compose、JWT audience、协议格式、浏览器键、数据库连接名、供应链属性和 Prompt 身份。
- 扫描当前非历史文件中的 `@aisay/`、`AISay Runtime`、第一方 `Cube Runtime` 和 `aisay-runtime` 残留。
- 重新生成 `pnpm-lock.yaml` 和三个生产 SBOM。
- 执行 `pnpm format:check`、`pnpm lint`、受影响包 typecheck、项目身份测试、Prompt 测试、配置契约和供应链检查。
- 目录迁移后验证新路径 Git 状态、旧 Junction 解析结果和父目录 `AGENTS.md` 的主仓库路径。

## 可逆性与恢复

代码身份可以整体回退本 ADR 对应提交，但写入新 JWT audience、Compose 卷、Mem0 source 或新 Skill 版本后，不得通过修改历史数据伪造旧身份。目录和多机恢复步骤记录在 `docs/operations/hoox-project-rename-recovery.md`；发生问题时优先恢复目录 Junction 或远端 URL，不直接编辑 Codex SQLite 和 Session 文件。
