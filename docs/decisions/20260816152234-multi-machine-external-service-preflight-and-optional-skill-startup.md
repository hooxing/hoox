# ADR-20260816152234：多机开发外部服务预检与可选 Skill 启动

- 状态：已接受
- 日期：2026-08-16
- 决策者：Runtime 维护者
- 关联任务/PR：Windows development 非首次启动脚本多机适配
- 替代关系：替代 [ADR-20260816110030](../archive/decisions/20260816110030-windows-development-one-click-startup.md)

## 背景

非首次启动脚本会在多台开发电脑使用。各电脑的 PostgreSQL、S3/MinIO、CubeSandbox 和模型 Provider 可能由本机容器、虚拟机、局域网服务或其他编排方式提供，脚本不能假定它们属于当前仓库的 Compose 项目。原脚本主动执行 Compose 会在已有 MinIO 使用相同宿主端口时创建重复容器并失败。

Skill 管理面不是核心 Runtime 日常开发的必需组件，默认同时启动 Skill Admin API 和 Admin Web 会增加窗口、端口与配置依赖。

## 决策驱动因素

- 同一脚本必须适用于外部服务部署方式不同的多台 Windows 开发电脑；
- `.env` 是外部服务位置和凭据的唯一配置真源；
- 非首次启动不能创建、停止或修改外部服务；
- 外部依赖不可用时必须在启动应用进程前失败关闭；
- 核心 Runtime 应一键启动，Skill 管理面应按需开启；
- 自动化调用必须能够避免交互。

## 备选方案

### 方案 A：继续由脚本启动仓库 Compose

本机首次体验简单，但会与其他 Compose 项目、原生服务或远端服务冲突，无法可靠支持多机差异。

### 方案 B：完全依赖 `.env` 并执行只读预检

脚本不管理外部服务，只构建代码并运行 Worker development preflight。预检验证 PostgreSQL、S3、CubeSandbox 和模型 Provider；任一失败即停止。该方案要求开发者自行管理外部服务，但边界清晰且可移植。

### 方案 C：为每种外部服务增加自动发现和启动适配器

能够覆盖更多部署方式，但会把本地基础设施编排职责引入应用启动脚本，权限、兼容性和维护成本过高。

## 选择

采用方案 B。`scripts/start-development.ps1` 不再调用 Docker 或 Compose，也不检查固定的 MinIO 宿主端口。脚本使用仓库已构建的 Worker preflight，从 `.env` 验证 PostgreSQL、S3、CubeSandbox 与模型 Provider；失败时输出稳定的外部服务预检错误并停止。

核心启动范围固定为 API、Agent Worker、Scheduler 和 Web。Skill Admin API 与 Skill Admin Web 默认不启动；普通交互运行会询问“是否启动 Skill Admin API 和 Skill Admin Web？[y/N]”，空输入为否。`-IncludeSkill` 显式启用 Skill 管理面，`-CoreOnly` 显式禁用询问并只启动核心 Runtime，两者互斥。

已运行且健康的应用进程继续复用，只启动缺失应用。端口已占用但对应健康端点不可用时失败关闭，不自动终止进程。

## 理由

外部服务的部署所有权不属于应用启动脚本。复用 Worker preflight 可以保证检查逻辑与真实 Worker 装配一致，避免在 PowerShell 中复制数据库权限、S3 凭据、CubeSandbox 模板和模型能力判断。Skill 管理面默认关闭可保持核心开发路径最小，同时保留交互和非交互开启方式。

## 影响

### 正面影响

- 同一脚本可用于本机容器、虚拟机、局域网或远端开发依赖；
- 不会因其他项目已占用 MinIO 端口而创建重复容器；
- 外部依赖错误会在应用进程启动前暴露；
- 日常默认只启动四个核心进程。

### 负面影响与成本

- 开发者必须在运行脚本前自行启动 `.env` 指向的外部服务；
- 默认交互运行需要回答一次 Skill 启动问题；
- Worker preflight 依赖当前构建产物，因此默认仍先执行工作区构建。

### 安全、数据与运维影响

- 脚本不调用 Docker、不创建容器、不修改外部服务；
- 预检只读取 `.env`，不得输出秘密值；
- 不执行迁移、身份初始化或角色 bootstrap；
- 不终止已有进程。

## 验证

- Windows PowerShell 5.1 AST 解析通过；
- `tests/start-development-script.test.ts` 验证脚本不包含 Compose 启动、使用 Worker preflight、Skill 空回答默认关闭、显式参数和进程复用边界；
- `corepack pnpm format:check`、`corepack pnpm lint`、`corepack pnpm typecheck` 通过；
- 人工验证 `.env` 指向的 MinIO 健康时无需启动或接管其容器。

## 可逆性与回退

如需恢复仓库管理的 Compose 启动，必须新增替代 ADR 并重新明确外部服务所有权。代码回退只涉及 PowerShell 脚本、测试与文档，不包含数据迁移。

## 后续工作

- 如 Skill 管理面增加独立预检入口，可在用户选择启动 Skill 后复用该入口。

## 实施记录

- 2026-08-16：移除启动脚本的 Docker/Compose 管理职责，加入默认否的 Skill 交互选择和非交互参数。
