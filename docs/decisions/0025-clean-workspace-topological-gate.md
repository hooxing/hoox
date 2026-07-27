# ADR-0025：全工作区清理与拓扑构建门禁

- 状态：已接受
- 日期：2026-07-27
- 决策者：工程团队
- 关联任务/PR：2026-07-27 CI 稳定化
- 替代关系：扩展 ADR-0001 的工程质量门禁

## 背景

工作区包通过 `workspace:*` 相互依赖，包入口和类型声明均指向各自的 `dist`。2026-07-27 的 GitHub Actions run 30236852554 在全新检出中证明：根类型检查只预构建 vendor SDK 时，新加入的内部包没有 `dist`，TypeScript 无法解析其公开类型。原有 `check:clean-vendor` 只删除 vendor 生成物，本地其他包残留的 `dist` 会掩盖该缺陷。

## 决策驱动因素

- 全新检出与开发机必须执行相同的依赖准备顺序；
- 新增任何 workspace 包后不应继续维护硬编码包名单；
- 清理范围必须限制在仓库声明的 workspace 包内；
- 类型检查不能依赖缓存、历史构建或测试顺序偶然产生的文件。

## 备选方案

### 方案 A：继续逐个预构建缺失包

在类型检查命令中追加 `resource`、`tool-router` 等过滤器。改动小，但每次增加跨包依赖都可能再次遗漏，无法形成通用门禁。

### 方案 B：根 TypeScript 配置为所有内部包维护源码 paths

根检查可以直接读取源码，但需要复制 workspace 拓扑与子路径导出规则，容易和 package manifest 漂移，也不能验证实际发布入口的 `dist` 是否可用。

### 方案 C：先按 pnpm workspace 拓扑构建，再执行类型检查

使用 pnpm 从全部 workspace manifest 推导依赖顺序；clean Gate 在检查前删除全部 workspace `dist`。这同时验证真实包入口、声明产物与依赖拓扑。

## 选择

选择方案 C：根 `build` 显式启用递归拓扑排序；`typecheck` 先执行全 workspace 构建，再执行根和各包类型检查；CI 使用 `check:clean-workspace` 删除所有 workspace `dist` 后运行完整检查。旧的 `check:clean-vendor` 仅保留为兼容别名，并执行同一全量门禁。

## 理由

pnpm 已以 package manifest 为单一依赖事实源，拓扑构建不需要在脚本中维护包名单。先生成真实 `exports` 和 `types` 指向的产物，可以发现缺失依赖声明、错误构建顺序和不可发布声明，而不仅是让源码别名暂时通过编译。

## 影响

### 正面影响

- 本地完整检查能复现 fresh checkout 的构建条件；
- 新 workspace 包自动纳入构建与清理门禁；
- 类型检查验证实际包入口，不被历史 `dist` 托底。

### 负面影响与成本

- `pnpm check` 会在类型检查、测试和最终构建阶段重复构建，执行时间增加；
- 单独运行 `pnpm typecheck` 会生成 workspace `dist`，不再是纯只读检查。

### 安全、数据与运维影响

清理脚本只删除仓库 workspace 包直属的 `dist`，并在删除前校验路径边界，不接收参数、环境变量或通配符目标。门禁不访问生产数据和外部服务。

## 验证

- 执行 `node scripts/remove-workspace-dist.mjs` 后确认所有 workspace `dist` 均不存在；
- 在上述状态执行 `pnpm typecheck`，确认 pnpm 按 workspace 拓扑完成构建并通过根与各包类型检查；
- 执行 `pnpm check:clean-workspace`，确认完整工程门禁在无历史生成物条件下通过；
- CI 的 Linux fresh checkout 使用同一命令。

## 可逆性与回退

该决策不改变生产数据或公开协议，可直接回退脚本和 CI 配置。若未来改用 TypeScript project references 或统一构建器，应新增 ADR，并保持“删除所有 workspace 生成物后仍能完成完整检查”的验收条件。

## 后续工作

- 若重复构建显著影响 CI 时长，可在保留 clean Gate 语义的前提下引入可验证缓存或拆分一次性构建产物复用。

## 实施记录

- 2026-07-27：根类型检查接入全 workspace 拓扑构建，CI clean Gate 从仅清理 vendor 扩展为清理全部 workspace。
