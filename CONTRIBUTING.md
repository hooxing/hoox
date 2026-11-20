# 贡献指南

感谢你帮助改进 Hoox。项目欢迎问题复现、文档、测试、Provider、工具与边界清晰的功能贡献。

## 开始之前

- 阅读[项目状态](docs/project-status.md)，不要把尚未完成的生产能力当作既有保证。
- 阅读[仓库导览](docs/architecture/repository-map.md)，确认改动属于应用、共享包还是适配器。
- 搜索已有 Issue、PR 和[架构文档](docs/architecture/README.md)，避免重复或违反现有约束。
- 大型功能、公共协议、持久化、安全边界或跨包重构应先创建 Issue，说明问题、范围、备选和验证方式。
- 安全漏洞不要创建公开 Issue，按[安全策略](SECURITY.md)私下报告。

## 开发环境

```powershell
corepack pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

完整依赖、数据库角色和启动步骤见[开发指南](docs/development.md)。普通单元测试不访问网络；真实 PostgreSQL、MinIO、CubeSandbox、E2B 和模型测试必须显式开启。

## 分支和提交

- 从最新目标分支创建职责单一的分支。
- 不提交 `.env`、令牌、证书、私钥、生产数据、模型报文、数据库导出或构建产物。
- 不覆盖或回退他人已合并的修改，在现有设计上增量开发。
- Git 提交信息可以使用中文或英文，说明完成的行为而不是罗列文件；维护者的提交通常使用中文。
- 一个提交应尽量只有一个可审阅职责；重命名、机械格式化和行为修改尽量分开。

推荐分支前缀：

```text
feature/<主题>
fix/<主题>
docs/<主题>
refactor/<主题>
```

## 代码和文档约定

- Issue、讨论和 Pull Request 可以使用中文或英文；维护者的文档和代码注释主要使用中文，公共标识符、协议字段和既有技术名词保持英文。
- 代码只在关键边界、不变量、失败语义和无法从实现直接看出的取舍处写注释，中英文均可。
- 应用入口只负责装配，领域规则进入边界清晰的共享包。
- 应用和共享包不能绕过 `tool-router` 直接执行宿主机命令或读写宿主机工作目录。
- 新第三方源码只能进入 `runtime-ts/vendor`，必须固定来源版本并保留许可证与来源说明。
- 依赖使用精确版本，并提交对应 `pnpm-lock.yaml`。

## 测试要求

每个改变外部行为、数据语义或兼容边界的改动必须增加自动化测试。提交前至少执行与改动范围相符的检查：

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
```

仅修改 Markdown 时仍需执行格式检查、链接检查和 Git diff 审阅。跨工作区依赖、构建、发布配置或影响不明确时执行：

```powershell
corepack pnpm check:clean-workspace
```

真实外部服务测试的适用范围见[命令参考](docs/reference/commands.md)。测试不得打印秘密值；集成测试必须使用隔离资源并在 `finally` 中清理。

## 架构文档

改动影响架构边界（行为、数据、安全、协议或兼容边界）时，在同一 PR 中更新 [`docs/architecture`](docs/architecture/README.md) 下对应的现状文档：

1. 以仓库 HEAD 的视角描述新的约束、不变量和失败语义，不写变更过程。
2. 没有合适文档时，在 `docs/architecture` 新增主题文档并加入索引。
3. 在 PR 描述中说明备选方案、选择理由、验证方式和可逆性；历史讨论以 PR 与 Git 历史为准。

## Pull Request

PR 应包含：

- 问题和目标；
- 范围与明确不做的内容；
- 关键设计与已更新的架构文档；
- 测试与验证命令；
- 配置、迁移、兼容性和安全影响；
- 回滚方式；
- UI 改动的截图或录屏，且不得包含敏感数据。

维护者可能要求拆分职责、补充故障测试或先形成设计决策。CI 失败时不得通过放宽安全边界、删除断言或绕过必需检查来获得绿色状态。

## 文档贡献

- 根 README 只保留项目定位、最短启动路径和导航。
- 当前事实写入 `docs/architecture`、`docs/reference`、`docs/operations` 或 `docs/development.md`。
- 实施计划写入 `docs/plans`，并明确它不是当前契约。
- 设计约束与不变量写入 `docs/architecture` 的现状文档，不另建 ADR 或归档目录。
- 链接使用仓库相对路径；命令、端口和环境变量必须能从当前仓库验证。

## 行为准则

参与项目即表示同意遵守[社区行为准则](CODE_OF_CONDUCT.md)。
