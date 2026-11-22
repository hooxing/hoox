# Third-party notices

## CubeSandbox Node SDK

`runtime-ts/vendor/cubesandbox-sdk/` 来源于 TencentCloud/CubeSandbox，使用 Apache License 2.0。源码固定为标签 `v0.6.0`、提交 `8721dd151971ce3c2966482bbd32904ad98f378e` 下的 `sdk/node`；上游 SDK 包版本为 `0.3.0`，本地安全补丁版本为 `0.3.0-cube.local.1`。完整上游许可证（含上游组件归属）、来源和补丁记录见该目录的 [LICENSE](runtime-ts/vendor/cubesandbox-sdk/LICENSE)、[SOURCE.md](runtime-ts/vendor/cubesandbox-sdk/SOURCE.md) 和 [PATCHES](runtime-ts/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.md)。

## Pi Agent Core 与 Pi AI

当前依赖为 `@earendil-works/pi-agent-core@0.82.1` 与 `@earendil-works/pi-ai@0.82.1`，不是 `pi-coding-agent`。两包的安装元数据均声明来源为 `earendil-works/pi`、许可证为 MIT；版权人为 Mario Zechner，依赖图由 pnpm lockfile 固定。

完整 MIT 许可证保存在 [third_party/pi/LICENSE](third_party/pi/LICENSE)。现有 [SOURCE.md](third_party/pi/SOURCE.md) 以 `pi-coding-agent` 名义记录同仓库 `v0.82.1` 标签及提交 `b4f293684bba718d59cc1157679bcf6157b3a7f5`；复核仅确认了当前依赖元数据与保留的许可文本，未重新向上游验证标签，不能把旧包名当成当前依赖清单。

## DeepSeek Harness 增量 Markdown

`runtime-ts/vendor/deepseek-markdown/` 保存 DeepSeek Harness `packages/client/ui-primitives/src/markdown/incremental.ts` 的固定源码，来源提交为 `76fda729799fe9b3848dbe2c211d4b231032b81e`，许可证为 MIT，版权人为 DeepSeek。完整许可证与来源见该目录的 `LICENSE` 和 `SOURCE.md`。该解析器进入用户 Web 的正文渲染，不引入 DeepSeek Harness 会话服务或其他 UI 组件。

## DeepSeek V4 Tokenizer

`runtime-ts/vendor/deepseek-v4-tokenizer/` 保存 DeepSeek V4 官方 tokenizer 的固定源码资源快照，来源提交为 `a7aaed80dd2df27620eb534454253ea25eb11c7a`，许可证为 MIT。完整许可证、来源与固定文件摘要见该目录的 `LICENSE`、`SOURCE.md` 及运行时校验代码；Worker 生产闭包与镜像会同时携带资源和许可证证据。

上游 `LICENSE` 原始字节摘要为 `f2c6c602815669d292889e5be8c802f2ed950653b77999b1584e8e6aed25d040`，与固定上游版本一致；由于上游使用 CRLF、仓库 `.gitattributes` 将文本归一化为 LF，仓库副本摘要为 `1c8f573e830ca9b3ebfeb7ace1823146e22b66f99ee223840e7637c9e745e1c7`。正文逐字一致，两个摘要及归一化原因见 tokenizer 的 [SOURCE.md](runtime-ts/vendor/deepseek-v4-tokenizer/SOURCE.md)。

## 文件类型图标

文件类型图标使用现有精确版本依赖 `lucide-react@0.544.0`（ISC）。仅导入应用实际使用的 Lucide 图标组件，按需随 Web 应用打包；无额外图标资源包或运行时 CDN 请求。许可证及版本由依赖包和 `pnpm-lock.yaml` 固定。
