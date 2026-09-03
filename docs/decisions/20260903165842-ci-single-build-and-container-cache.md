# ADR-20260903165842：CI 单次构建复用与容器缓存

- 状态：已接受
- 日期：2026-09-03
- 决策者：工程团队
- 替代关系：替代 ADR-0025 中完整工程 Gate 重复构建的实施方式，保留其 clean workspace 验收条件

## 背景

完整工程 Gate 会先删除全部 Workspace `dist`，随后在 `typecheck`、`test` 和最终 `build` 阶段三次执行全工作区构建。GitHub Actions 的近期成功运行中，工程基线校验稳定占用约十八分钟，其中重复构建是主要耗时。Pi Prompt 容器 Gate 还会在独立镜像内重新安装依赖并构建全部 Workspace，但实际只运行五个测试文件。

ADR-0025 已允许在保留 clean Gate 语义的前提下复用一次性构建产物。本决策落实该后续方向，不改变生产协议、数据语义或容器安全断言。

## 决策驱动因素

- 必须继续证明全新检出在没有历史 `dist` 时能够按依赖拓扑完成构建；
- 不得因为提速而跳过根测试代码、Vite 应用、vendor SDK 或额外脚本配置的类型检查；
- 单独执行 `test` 和 `typecheck` 时继续自行准备所需构建产物，避免改变开发者入口；
- Pi Prompt Gate 必须继续在无网络、非 root 容器中运行；
- `main` 的 CI 不因新提交而中断，PR 的过期运行可以取消。

## 备选方案

### 方案 A：保留三次构建，只增加依赖缓存

依赖安装已经稳定命中 pnpm 缓存，无法消除 TypeScript、Vite 和测试前重复构建，收益有限。

### 方案 B：把类型检查、构建和测试拆成独立 Job

能够并行缩短墙钟时间，但需要上传和下载完整构建产物，并增加跨 Job 产物完整性与必需检查管理成本。总计算量也不会自然下降。

### 方案 C：一次 clean build，后续检查复用同一 Job 的产物

先执行全工作区拓扑构建，再运行根配置和未由常规 `tsc` build 覆盖的补充类型检查，最后直接运行 Vitest。容器 Gate 独立保留，并通过 BuildKit 缓存和目标闭包过滤减少重复工作。

## 选择

选择方案 C：

1. `check:clean-workspace` 仍先删除所有 Workspace `dist`。
2. `check` 只执行一次全工作区 `build`。使用 `tsc -p` 构建的包以该次编译同时承担类型检查；Vite 应用、ui-theme 和 persistence 脚本配置通过第一方包的 `typecheck:built` 执行补充类型检查；根测试配置和只读 vendor SDK 由根命令显式检查。
3. `test:built` 直接运行 Vitest；独立的 `test` 和 `typecheck` 命令保留原有自构建语义。
4. CI 使用 Buildx 构建并缓存 Pi Prompt Gate 镜像，运行脚本可以接收已加载镜像；本地未提供镜像时仍自行构建并清理。镜像只构建五个测试目标所需的 Workspace 依赖闭包。
5. 同一 PR 的新提交取消旧 CI，`main` 运行不取消。
6. 聚合 Production Gate 只执行一次同时覆盖供应链和许可证的扫描脚本，保留 `license:check` 独立兼容入口。

## 理由

一次真实拓扑构建仍会解析 Workspace manifest、生成声明文件并验证包的 `exports` 与 `types`，因此保留 ADR-0025 的核心失败检测能力。对使用 `tsc -p` 构建的包再次执行相同配置的 `tsc --noEmit` 不会增加独立边界；补充检查名单只包含构建器不负责完整类型检查或存在额外 tsconfig 的项目。

Pi Prompt Gate 的安全价值来自镜像构建契约、非 root 用户、运行时断网和目标测试，而不是构建无关的 Web、Scheduler 等应用。BuildKit 缓存只复用由锁文件和源码内容寻址的层，不复用宿主机 `dist`。

## 影响

### 正面影响

- 完整工程 Gate 从三次全工作区构建降为一次；
- 普通测试不再在同一聚合 Gate 内重复构建；
- Pi Prompt 镜像依赖层可以跨 CI 运行复用，源码构建范围缩小；
- 快速连续推送 PR 时不会继续消耗过期运行的 Runner；
- Production 聚合 Gate 不再重复执行同一供应链脚本。

### 负面影响与成本

- `typecheck:built` 必须在已有当前构建产物后运行，不是独立开发入口；
- 新增采用非 `tsc -p` 构建器或额外 tsconfig 的 Workspace 时，必须将其加入补充类型检查；
- Pi Prompt CI 增加 Buildx 初始化和缓存导出步骤，首次冷缓存运行不一定更快。

### 安全、数据与运维影响

容器仍使用固定 Node.js 镜像 digest，以 UID/GID `1000:1000` 运行，并在测试阶段禁用网络。缓存键由 BuildKit 内容寻址，不包含生产凭据。数据库迁移、生产发布和运行时权限边界不受影响。

## 验证

- 从无 Workspace `dist` 状态执行 `pnpm check:clean-workspace`；
- 执行 CI 工作流契约测试，确认聚合 Gate 只有一次 build；
- 构建并运行 Pi Prompt Gate 镜像，确认过滤后的依赖闭包足以完成五个目标测试；
- 执行 `pnpm format:check`、`pnpm lint`、相关类型检查和 `git diff --check`；
- 通过后续 GitHub Actions 运行比较工程基线校验与 Pi Prompt Gate 的实际耗时。

## 可逆性与回退

该决策不涉及持久化数据和公开协议。若补充类型检查遗漏新构建器，可先恢复对应包的显式 typecheck；若 Buildx 缓存不稳定，可移除预构建步骤，运行脚本会回退到本地 Docker build。完整回退时恢复 ADR-0025 的重复构建调用链即可。
