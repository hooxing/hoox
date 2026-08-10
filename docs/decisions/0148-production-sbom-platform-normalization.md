# ADR-0148：生产 SBOM 规范化宿主平台原生可选依赖

- 状态：已接受
- 日期：2026-08-10
- 决策者：仓库维护者
- 关联任务/PR：PR #1 合并后的持续集成修复
- 替代关系：细化 ADR-0001 的跨平台质量基线与供应链复现要求

## 背景

生产 CycloneDX SBOM 由 `pnpm licenses list --prod --json` 的已安装闭包生成。该命令只报告当前宿主链接的 optional native 包：Windows 开发机生成 `@mariozechner/clipboard-win32-x64-msvc`，GitHub Linux Runner 则生成 `@mariozechner/clipboard-linux-x64-gnu` 与 `@mariozechner/clipboard-linux-x64-musl`。因此同一锁文件在不同宿主上不能字节级复现已提交 SBOM，合并后的 Production Gate 会失败。

生产 API、Scheduler 与 Worker 的受支持部署平台固定为 Linux x64；Windows 仅用于开发和进程骨架回归。SBOM 必须描述生产目标闭包，而不是生成命令恰好运行的开发宿主闭包。

## 决策驱动因素

- 相同提交必须在 Windows 开发机与 Linux CI 上复现同一 SBOM；
- 不能通过放宽字节级比较或忽略 native 包来掩盖供应链漂移；
- 生产目标平台是 Linux x64，需保留 glibc/musl 原生变体的许可证与组件证据；
- 新的平台相关依赖必须显式进入受审规范化逻辑，而不是静默改变 SBOM。

## 备选方案

### 方案 A：提交各宿主生成的不同 SBOM

分别维护 Windows 和 Linux 文件，或允许任一版本通过。该方案会让生产证据取决于执行环境，并扩大审阅与发布歧义，因此拒绝。

### 方案 B：从 SBOM 删除全部平台原生可选包

输出可以稳定，但会遗漏生产运行时实际加载的原生组件，削弱许可证和供应链覆盖，因此拒绝。

### 方案 C：安装所有支持架构的可选依赖

通过 `--force` 或全局 `supportedArchitectures` 让所有开发和 CI 安装包含全部平台包。该方案会显著增加安装体积与时间，并把非生产 macOS/Windows 二进制纳入生产闭包，因此暂不采用。

### 方案 D：将已知宿主变体规范化为生产平台闭包

在 SBOM 生成器中识别 `@mariozechner/clipboard-*` 平台包，验证版本与许可证一致后，统一输出 Linux x64 的 glibc 与 musl 组件；其余依赖保持原始精确闭包。

## 选择

采用方案 D。

生成器只有在发现 clipboard 平台组件时才执行规范化，并要求所有发现的变体版本与许可证完全一致；不一致时以 `PRODUCTION_SBOM_PLATFORM_COMPONENT_CONFLICT` 失败关闭。规范化后的生产组件固定为：

- `@mariozechner/clipboard-linux-x64-gnu`；
- `@mariozechner/clipboard-linux-x64-musl`。

同时，GitHub Actions 的 `pnpm/action-setup` 不再重复声明 `version`，只从 `package.json#packageManager` 的带 registry integrity 固定值解析 pnpm，避免新版 action 因双重版本来源拒绝启动。

## 理由

该方案让 SBOM 明确描述受支持的 Linux x64 生产平台，保留 native 组件证据，同时不会把所有非生产架构下载到每次安装中。显式冲突检查和单元测试可以防止依赖升级后无声地沿用错误版本。

## 影响

### 正面影响

- Windows 本地、Linux CI 和生产 Gate 生成相同 SBOM；
- 生产 SBOM 继续包含实际 Linux native 依赖；
- pnpm 安装动作只有一个版本事实源，保留 packageManager integrity 固定。

### 负面影响与成本

- 当前规范化逻辑对 clipboard 原生包族有显式知识；新增其他平台相关依赖时需要扩展受审规则；
- 生产平台若扩展到 ARM64 或其他操作系统，必须更新规范化闭包并重新生成 SBOM。

### 安全与运维影响

- SBOM 仍执行字节级复现、许可证 allow/deny、vendor patch 与 canonical tree 校验；
- 任何平台变体的版本或许可证分歧都会失败关闭；
- 该变更不改变应用运行依赖，只修正供应链证据的目标平台语义。

## 验证

- 单元测试用 Windows native 输入断言输出固定为两个 Linux x64 组件，并覆盖版本冲突失败；
- 在 Windows 上执行 `pnpm supply-chain:write` 与 `pnpm supply-chain:check`；
- 在 Linux Node.js 24 容器的全新冻结安装中生成 SBOM，并与 Windows 生成文件逐字节比较；
- GitHub Actions 的工程基线、M4、跨平台进程与 Production Gate 均能越过 pnpm 安装步骤并复现 SBOM。

## 可逆性与回退

可回退生成器、SBOM 和 workflow 三类文件，但回退后跨平台 Gate 会再次失败。若未来 pnpm 提供可直接查询指定目标平台且稳定输出许可证闭包的接口，可新增 ADR 替代本决策，并删除包族专用规范化逻辑。

## 后续工作

- 依赖升级时审查是否出现新的 `os/cpu/libc` 可选包族；
- 若生产支持 ARM64，先扩展生产平台矩阵和 SBOM 规范化测试，再发布对应镜像。

## 实施记录

- PR #1 合并提交触发的 CI 暴露 pnpm action 双版本冲突和宿主平台 SBOM 漂移；本 ADR 对两项问题建立单一、可复现的生产供应链边界。