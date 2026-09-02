# ADR-20260816002622：项目身份迁移为 AISay Runtime

## 状态

已替代，2026-08-18 由 [ADR-20260818144124](../../decisions/20260818144124-unify-project-identity-as-hoox.md) 替代。本文保留当时的项目身份迁移背景；CubeSandbox、E2B 等 Sandbox Provider 技术边界继续有效。

## 背景

仓库在内部开发阶段沿用了 `CubeSandbox Agent Runtime`、`Cube Runtime`、`cubesandbox-agent-runtime` 与 `@cube-runtime/*` 等临时名称。它们把项目自身身份与首个 Sandbox Provider 混在一起：对外容易被理解为 CubeSandbox 的附属项目，代码中的一方品牌又与支持多个 Sandbox Provider 的现状不一致。

项目准备以 `aisay.cc` 为品牌入口并在后续开源。当前尚未发布公共 npm 包，也没有需要维持的外部包依赖方；此时一次性完成破坏式迁移，比公开后长期维护别名和双命名成本更低。

## 决策驱动因素

- 项目品牌必须独立于任一 Sandbox Provider；
- 仓库、包命名空间、界面和模型可见 Harness 应使用同一身份；
- Provider 的 SDK、环境变量、类型和运维目录必须继续准确表达真实上游；
- 已接受 ADR 是历史决策记录，不能为制造表面一致性而改写；
- Prompt 固定字节发生变化时必须推进版本，不能沿用旧版本标识；
- 内部阶段允许直接切断旧 JWT audience 和本地 Compose 资源名。

## 备选方案

### 方案 A：只修改 README 和界面品牌

变更最小，但包名、部署身份与文档会继续暴露旧名称，开源后仍需第二次迁移，也无法消除项目与 CubeSandbox 的身份混淆。

### 方案 B：全局把所有 Cube 字样替换为 AISay

表面最统一，但会错误修改 `@cubesandbox/sdk`、`CUBESANDBOX_*`、`CubeSandboxGateway`、供应链证据和运维目录，破坏真实 Provider 契约。

### 方案 C：按所有权边界迁移项目身份

一次性替换所有第一方项目标识，同时保留 CubeSandbox 专有名和历史 ADR。迁移面较大，但边界明确，可由构建、契约测试和残留扫描验证。

## 选择

采用方案 C，并规定：

1. 对外英文品牌统一为 **AISay Runtime**，中文品牌使用 **爱说 AISay**；仓库和根包名使用 `aisay-runtime`。
2. 第一方 Workspace 包统一从 `@cube-runtime/*` 迁移到 `@aisay/*`，不提供旧 scope 的兼容包或路径别名。
3. 用户界面和固定 Platform Harness 使用 `AISay` / `AISay Runtime`；本次 Harness 字节变化将 `runtime-system-prompt.v10` 推进到 `runtime-system-prompt.v11`。
4. 生产 JWT audience 样例切换为 `aisay-runtime`；旧 audience 不再接受，部署方必须同步签发配置。
5. Docker Compose 项目和持久卷示例切换为 `aisay-runtime-*`。旧本地卷不会自动迁移；需要旧数据时由维护者显式复制，禁止运行时猜测或静默复用。
6. 第一方 SBOM 属性命名空间切换为 `aisay:*`，AJV 格式名、浏览器偏好键、数据库连接应用名和临时文件前缀同步切换为 AISay 身份。
7. `CubeSandbox`、`@cubesandbox/sdk`、`CUBESANDBOX_*`、CubeSandbox 适配类、供应链来源证据及 Provider 运维目录保持不变。通用的 `agent_runtime` 数据库名称、领域类型和协议名也不为品牌改名。
8. 已经形成持久数据或摘要域的不透明身份不原地改名：PostgreSQL migration advisory lock `cube_runtime_schema_migrations_v1`、已发布 CSV Skill 主键 `skill_cube_csv_to_pdf`，以及 CubeSandbox Workspace snapshot 域保持原值。CSV Skill 通过不可变 `1.2.0` 新版本表达新的发布者、兼容性和许可证身份。
9. 已接受 ADR 保留其落地时使用的旧项目名称；当前 README、开发文档、代码、测试、锁文件和生成制品更新为新名称。

## 影响

- 第一方包的模块说明符全部变化，任何未同步的 import、构建过滤器或部署裁剪规则都会立即失败；这是本次刻意选择的失败关闭行为。
- 使用旧 audience 签发的 JWT 会失效，需要部署配置同步切换。
- Compose 会创建新的项目资源名；内部开发环境依赖外部端口映射时不受本地服务数据迁移影响。
- 浏览器本地的旧侧栏展开偏好不迁移，用户首次进入新品牌版本时使用默认值。
- CubeSandbox 和 E2B 的配置、持久 Provider 身份及运行数据语义不变，不需要数据库迁移。
- 仓库远端改名属于代码合并后的托管平台操作，不在代码提交内自动执行。

## 验证

- 新增项目身份契约测试，固定根包、Workspace scope、Compose 名和生产 audience，并证明 CubeSandbox SDK 契约仍存在。
- 更新 Prompt 和界面测试，验证 `AISay Runtime` 与 `runtime-system-prompt.v11`。
- 重新生成 `pnpm-lock.yaml` 与生产 SBOM，运行格式检查、Lint、类型检查、直接测试和配置契约检查。
- 对已跟踪的非历史文件扫描 `@cube-runtime`、`cubesandbox-agent-runtime`、`Cube Runtime` 与 `Cube Agent` 残留。

## 可逆性

在公共包发布、仓库改名和新 audience 上线前，可以整体回退本提交。公共包发布后不能复用相同版本号发布旧 scope；生产开始签发新 audience 后，回退还需要重新切换签发方与验证方。Compose 新旧卷都不会被自动删除，回退时可显式重新选择旧资源。
