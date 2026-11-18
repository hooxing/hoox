# Third-party notices

## CubeSandbox Node SDK

已 vendoring 的 CubeSandbox Node SDK 来源于 TencentCloud/CubeSandbox，使用 Apache License 2.0。源码固定为标签 `v0.6.0`、提交 `8721dd151971ce3c2966482bbd32904ad98f378e` 下的 `sdk/node`；许可证、来源和同步要求见 `runtime-ts/vendor/cubesandbox-sdk/`。

## Pi Coding Agent

`@earendil-works/pi-coding-agent@0.82.1` 来源于 `earendil-works/pi` 的 `v0.82.1` 标签（提交 `b4f293684bba718d59cc1157679bcf6157b3a7f5`），上游采用 MIT License，版权人为 Mario Zechner。仓库保留的完整许可证和来源记录见 `third_party/pi/`；依赖图由 pnpm lockfile 固定。

## DeepSeek Harness 增量 Markdown

`runtime-ts/vendor/deepseek-markdown/` 保存 DeepSeek Harness `packages/client/ui-primitives/src/markdown/incremental.ts` 的固定源码，来源提交为 `76fda729799fe9b3848dbe2c211d4b231032b81e`，许可证为 MIT，版权人为 DeepSeek。完整许可证与来源见该目录的 `LICENSE` 和 `SOURCE.md`。该解析器进入用户 Web 的正文渲染，不引入 DeepSeek Harness 会话服务或其他 UI 组件。

## DeepSeek V4 Tokenizer

`runtime-ts/vendor/deepseek-v4-tokenizer/` 保存 DeepSeek V4 官方 tokenizer 的固定源码资源快照，来源提交为 `a7aaed80dd2df27620eb534454253ea25eb11c7a`，许可证为 MIT。完整许可证、来源与固定文件摘要见该目录的 `LICENSE`、`SOURCE.md` 及运行时校验代码；Worker 生产闭包与镜像会同时携带资源和许可证证据。
