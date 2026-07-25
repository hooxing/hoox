# ADR-0008：CubeSandbox Node SDK vendoring 与供应链

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M0-04、M0-05、M7-04
- 替代关系：无

## 背景

CubeSandbox 服务端已经升级到 v0.6 系列，官方仓库提供 TypeScript/Node SDK，但 `@cubesandbox/sdk` 当前没有可依赖的公开 npm 发布。直接跟随上游 `master` 无法复现构建，也无法审计上线的确切代码。

## 决策驱动因素

- 构建、部署和回滚必须可复现；
- 业务代码不能散落依赖未稳定的上游 API；
- vendored 源码必须保留来源、许可证和完整性证据；
- 服务端升级不能自动等同于 SDK 升级。

## 备选方案

### 方案 A：从 GitHub `master` 直接安装

接入最快，但上游提交会漂移，供应链和回滚不可控。

### 方案 B：固定 v0.6.0 提交并 vendor `sdk/node`

需要维护源码副本和升级流程，但来源、哈希、许可证和构建均可审计。

### 方案 C：等待 npm 正式发布

供应链更常规，但会阻塞当前开发，且未来包是否发布没有确定时间。

## 选择

采用方案 B：

- 上游仓库：`TencentCloud/CubeSandbox`；
- 上游标签：`v0.6.0`；固定提交：`8721dd151971ce3c2966482bbd32904ad98f378e`；
- 只复制该提交的 `sdk/node`，包版本 `0.3.0`，并保留 Apache-2.0 许可证；
- 在 `runtime-ts/vendor/cubesandbox-sdk` 记录来源、文件清单、内容哈希、构建方式和本地补丁；
- 业务包只能依赖 `packages/sandbox` 的稳定接口，不能直接导入 vendor 路径；
- Lockfile、Node.js `24.18.0`、pnpm `10.15.1`、TypeScript `5.9.3` 和 Pi `0.82.1` 一并固定；生产镜像后续固定 Digest；
- 每次升级使用独立 ADR/PR，重新执行生命周期、文件、命令、暂停/连接、取消、错误映射和凭据泄漏契约。

## 理由

固定 vendoring 不等待外部发布，又避免主分支漂移。适配层把供应链选择与领域实现隔开，未来切换到可信 npm 包时不改变业务协议。

## 影响

### 正面影响

- 离线审阅时可以确定生产使用的确切 SDK 源码；
- 上游删除标签或修改主分支不会破坏历史构建；
- 升级可以用明确 diff 和契约证据审阅。

### 负面影响与成本

- 仓库体积和许可证维护成本增加；
- 安全修复不会自动进入，需要主动监控上游；
- 本地补丁必须单独记录，不能无痕修改 vendor 源码。

### 安全、数据与运维影响

CI 校验 vendor 哈希、Lockfile 和 License。构建不得下载未锁定执行代码。SDK 或服务端版本不兼容时，Sandbox 功能保持关闭或冒烟失败，不能自动回退到宿主机执行。

## 验证

- 对上游固定提交、复制文件和许可证生成可重复哈希清单；
- Clean install/build 在没有访问上游 `master` 的情况下成功；
- 真实 v0.6 环境完成 create、命令/代码、文件、pause、connect 和 kill 冒烟；
- Fake SDK 覆盖超时、不存在、断流、取消和状态未知；
- 依赖图证明只有 `packages/sandbox` 直接接触 vendor SDK。

## 可逆性与回退

在 `packages/sandbox` 契约稳定时，可以回退上一个 vendor 提交或切换到经过验证的 npm 包。若业务代码直接使用 SDK 类型，回退将变得困难，因此此类导入必须由 CI 阻断。

## 后续工作

- M0-05 执行真实 v0.6 冒烟并记录服务端/SDK兼容证据；
- 正式复制源码时补齐哈希清单、许可证和任何补丁记录；
- 建立上游安全更新监控和定期升级审阅。

## 实施记录

- CubeSandbox Node SDK 已按 `v0.6.0` 固定提交机械复制到 vendor；本次修复不改动任何上游文件。
- clean checkout 暴露出 `packages/sandbox` 类型检查早于 vendor build 时无法解析 `@cubesandbox/sdk/dist`。备选方案包括修改上游 `package.json` 让类型直接指向源码，或在根类型检查前精确构建 vendor；选择后者，以保持 vendor 文件逐字一致和上游发布契约不变。
- 根 `typecheck` 现在先构建 `@cubesandbox/sdk`，再执行仓库及工作区类型检查。CI 在冻结安装后主动删除 vendor `dist` 并运行完整 `check`，证明检查不依赖工作树残留。删除脚本使用仓库内固定绝对边界，不接受参数、通配符或环境变量目标。
