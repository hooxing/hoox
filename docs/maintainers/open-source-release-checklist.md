# 首次公开发布检查清单

本清单用于把“仓库已经整理为开源形态”和“GitHub 组织已经完成公开发布设置”分开。仓库内项目完成后，仍需由拥有组织权限的维护者执行平台项。

## 仓库内容

- [x] 根 README 只保留定位、能力、成熟度、最短启动路径和文档导航。
- [x] 添加项目级 Apache License 2.0、NOTICE 和第三方许可证说明。
- [x] 添加贡献指南、安全策略、行为准则、支持说明和治理规则。
- [x] 添加 Bug、Feature Request 和 PR 模板。
- [x] 建立架构、参考、开发、运维、维护者、计划和验证文档分层。
- [x] 根 `package.json` 包含 description、license、repository、homepage、bugs 和 keywords。
- [x] README 中明确 `0.x` 成熟度和未完成的生产验收。
- [x] 设计约束统一维护在 `docs/architecture` 现状文档，不另建 ADR 目录。
- [x] 文档本地文件链接与锚点检查通过。
- [x] development 与 production 配置契约校验通过。

## 本地敏感信息与历史

- [x] `.env`、`.arts`、`.tmp`、`model-wire-traces` 和构建产物由 Git 忽略。
- [x] 当前受跟踪文件的常见凭据模式结果只包含明确占位值、测试夹具和 canary。
- [x] Git 对象路径未发现历史 `.env`、私钥文件或本地诊断目录。
- [x] 最大历史 Blob 已复核；当前最大项是约 6 MiB 的固定 tokenizer 资源，不是用户或生产数据。
- [ ] 使用专用秘密扫描器对全部 Git 历史执行最终扫描，并由维护者复核结果。
- [ ] 检查提交作者邮箱、Issue/PR 历史、Release 附件和 GitHub Actions 日志是否适合公开。
- [ ] 若发现秘密，先撤销/轮换，再重写历史；不能只删除当前分支文件。
- [ ] 重写 Git 历史统一提交作者身份并强制推送 `main`（维护者已批准，待进行中的工作包合并后执行）。
- [x] 移除来源与许可证评估未完成的第三方 `refactoring-ui` Skill。
- [x] 精简根 `AGENTS.md`，移除内部智能体与 Demo 交付约定，使公开贡献者看到的规则与[贡献指南](../../CONTRIBUTING.md)一致。

## GitHub 组织设置

- [ ] 确认仓库描述、Topics、主页地址和社交预览图。
- [ ] 启用 Private Vulnerability Reporting。
- [ ] 为 `main` 配置 ruleset/分支保护，要求适用 CI job、评审和线性历史策略。
- [ ] 禁止管理员无记录绕过必需检查。
- [ ] 确认 Issue、Discussion、Wiki、Projects 和 Releases 的启用范围。
- [ ] 配置默认 Issue labels、维护者通知和安全联系人。
- [x] 当前 GitHub Actions 显式使用只读 `contents: read` 权限。
- [x] 当前第三方 Actions 固定到明确 commit，并在注释中记录版本。

## 首个公开版本

- [ ] 确定首个公开 tag、版本说明和兼容性承诺。
- [ ] 从受保护提交执行 clean install、完整 CI 和所需真实外部 Gate。
- [ ] 复核许可证和第三方来源证据；如需对外发布镜像，补充 SBOM。
- [ ] 发布版本说明，明确已知限制、升级方式、安全渠道和生产就绪边界。
- [ ] 验证匿名用户可以阅读 README、文档、许可证、Issue 模板和安全入口。

## 对外表述

在真实外部基础设施、身份、容量和回滚演练完成前，不使用“生产就绪”“企业级可直接上线”或类似无条件表述。可以准确说明已经实现和自动验证的工程边界，并链接[项目状态](../project-status.md)与[生产就绪说明](../operations/production-readiness.md)。
