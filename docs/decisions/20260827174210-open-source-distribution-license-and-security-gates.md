# ADR-20260827174210：开源分发许可证与生产供应链门禁

- 状态：已接受
- 日期：2026-08-27
- 决策者：Runtime 团队
- 替代关系：替代 ADR-0097 的专有 development fixture 分发决策

## 背景

仓库已经采用 Apache License 2.0，但当前工作树仍包含受专有条款约束的 Anthropic PPTX development fixture；Demo 与三个 production 镜像没有统一随附 Hoox 的 `LICENSE`、`NOTICE` 和第三方通知；DeepSeek V4 tokenizer 通过源码相对路径读取，未形成可部署的 workspace 包、许可证证据和 SBOM 闭包。生产依赖扫描同时报告 8 个中高危漏洞，CI 也没有把 production advisory audit 作为发布门禁。公开示例还包含私网地址，README 的首次启动命令绕过了数据库角色 bootstrap。

## 决策

1. 从当前分发树删除 Anthropic PPTX fixture、对应发布器、命令和当前文档入口，不再把专有内容作为 development 例外保留在开源仓库。
2. Demo 镜像随附 Hoox 根级法律文件；API、Scheduler、Worker production 镜像在 `/opt/runtime/licenses/hoox/` 随附 `LICENSE`、`NOTICE` 与 `THIRD_PARTY_NOTICES.md`。三个 production 镜像还显式随附 Pi 的 `LICENSE` 与 `SOURCE.md`，Worker 额外随附 DeepSeek tokenizer 的 `LICENSE` 与 `SOURCE.md`。
3. 将 DeepSeek V4 tokenizer 声明为私有 workspace vendor 包，由 Pi Adapter 通过包导出解析运行资源。供应链策略登记其上游提交、MIT 许可证与 canonical source tree 摘要，Worker SBOM 必须包含该组件，容器 Gate 必须实际加载并计数。
4. 所有 `runtime-ts/vendor/*` 目录都必须在许可证策略中登记。未修改快照固定 source tree 摘要；本地修改的 vendor 必须固定可反向应用的补丁与 patched tree 摘要。
5. Fastify 固定升级到已修复版本，并用精确 pnpm override 修复仍由现有 Pi 依赖链引入的 `fast-uri`、`brace-expansion` 与 `undici` 漏洞。`security:audit:production` 使用 moderate 阈值扫描 production 闭包，并进入 CI、发布 manifest 与 `check:production`。
6. Demo 手工发布只允许 `main` 当前提交，不再接收任意 ref，避免重新构建仍含受限 fixture 的历史提交。远端旧镜像与 Git 历史必须由仓库管理员另行清理，不能通过普通工作树提交安全重写。
7. `.env.example` 使用保留的 `.invalid` 示例域名；README 首次启动统一使用 `db:setup`，先完成角色 bootstrap 再迁移。

## 备选方案

### 保留专有 fixture，只依赖 Docker 忽略规则

拒绝。Git clone、源码归档与手工历史构建仍会分发该内容，镜像排除不能解决开源仓库本身的授权问题。

### 继续用源码相对路径读取 tokenizer

拒绝。pnpm deploy 只保证声明的依赖闭包，相对路径资源可能缺失，也无法让 SBOM 和许可证策略表达真实运行依赖。

### 立即升级整个 Pi SDK 主版本

暂缓。当前漏洞可以用精确传递依赖修复消除；跨版本 API 迁移需要单独兼容性验证，不能与许可证止血合并。

## 影响

- 当前源码树与后续 Demo 发布不再包含 Anthropic 专有 fixture；相关本地测试命令被移除。
- production 镜像增添少量法律与来源文件，Worker 增添 tokenizer vendor 包资源；运行镜像仍保持 root 所有、只读和非 root 执行。
- 每次 production CI 都需要访问 pnpm advisory 数据源；审计服务不可用时门禁失败关闭。
- 所有新增 vendor 目录都必须同时补 package manifest、许可证、来源、策略证据和相应 SBOM 测试。

## 验证

- `corepack pnpm security:audit:production`
- `corepack pnpm supply-chain:check`
- `corepack pnpm license:check`
- `corepack pnpm release:check`
- production API、Scheduler、Worker 容器 Gate
- 格式、lint、类型检查和完整测试

## 可逆性

Fastify 与 override 可以通过锁文件提交回退，但会重新暴露已知漏洞。tokenizer 包装可以回退为其他显式 production asset 机制，但不得恢复未声明的相对路径依赖。Anthropic fixture 不得回加到公开分发树；如需彻底清除既有远端历史和旧镜像，应在备份、公告和协作者协调后执行独立的历史重写与制品删除流程。
