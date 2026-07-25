# CubeSandbox Node SDK 来源

本项目不从 npm 的 `master` 浮动安装 CubeSandbox SDK。正式接入时只允许使用以下固定来源：

- 上游仓库：`https://github.com/TencentCloud/CubeSandbox`
- 上游版本：`v0.6.0`
- 固定提交：`8721dd151971ce3c2966482bbd32904ad98f378e`
- 子目录：`sdk/node`
- SDK 包版本：`0.3.0`
- 上游许可证：Apache-2.0

当前目录只记录供应链来源，尚未复制 SDK 源码。执行正式 SDK 接入任务时，必须同时复制固定提交下的 `sdk/node` 与上游许可证，记录内容哈希，并通过代码审查后提交；不得从 `master` 更新。
