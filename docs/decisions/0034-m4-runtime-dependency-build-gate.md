# ADR-0034：M4 黑盒运行时依赖构建门禁

- 状态：已接受
- 日期：2026-07-28
- 决策者：M4 Linux CI 修复

## 背景

M4 PostgreSQL 黑盒测试直接执行应用源码，但其运行时会通过 workspace 包的公开 `exports` 加载 JavaScript `dist`。2026-07-28 的 GitHub Actions run `30318584374` 只预构建了 CubeSandbox SDK；测试加载 Pi Adapter 时，尚未生成的 Prompt Builder `dist` 导致模块解析失败。独立 Job 不能依赖其他 Job 的构建产物或开发机残留。

## 决策

新增 `build:m4-runtime-dependencies`。它以 API、Agent Worker 和 Scheduler 三个 M4 实际加载入口为根，使用 pnpm 的 `^...` 依赖闭包过滤和拓扑顺序构建；不构建入口应用自身，也不执行无关的全工作区构建。`test:integration:m4` 必须先运行该命令。

新增 `test:integration:m4:clean`，先删除全部 workspace `dist` 再执行 M4 命令；Linux M4 CI 使用此命令作为回归门禁。

## 备选方案

1. 继续只构建 `@cubesandbox/sdk`：无法覆盖 Pi Adapter、Prompt Builder 等已声明的运行时依赖，已证明不可用。
2. 对 M4 一律执行根 `pnpm build`：可行但构建 Web 等不参与黑盒的包，增加时间并弱化 M4 的运行边界。
3. 在脚本中维护每个依赖包名单：包依赖演进时容易遗漏，且重复 manifest 已有的依赖事实。

## 理由与影响

pnpm 以 package manifest 为唯一依赖图，入口依赖的新增或删除会自动反映到 M4 构建闭包。M4 仍只构建其运行时所需依赖；若测试未来直接加载新的应用入口，必须将该入口加入过滤根并更新本 ADR。该变更不改变生产协议和数据，仅修复 CI 构建顺序；可通过还原三个脚本/CI 配置提交回退。

## 验证

1. 删除全部 workspace `dist` 后运行 `pnpm build:m4-runtime-dependencies`，确认必要公开入口均已生成。
2. 在配置真实 PostgreSQL 的环境运行 `pnpm test:integration:m4:clean`。
3. GitHub Linux M4 Job 使用同一 clean 命令，确保不由其他 Job 或缓存托底。
