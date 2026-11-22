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

发布复核发现：`tokenizer.json` 与 `tokenizer_config.json` 的 SHA-256 均匹配 `SOURCE.md`，但 `LICENSE` 不匹配。来源记录的摘要为 `f2c6c602815669d292889e5be8c802f2ed950653b77999b1584e8e6aed25d040`，仓库文件的实际摘要为 `1c8f573e830ca9b3ebfeb7ace1823146e22b66f99ee223840e7637c9e745e1c7`。当前文件包含完整 MIT 文本与 DeepSeek 版权声明；差异原因尚未确认，不能据此认定它与固定上游版本一致。公开发布前须由维护者核对上游原文及来源记录，不得仅替换记录摘要来消除告警。

## iconfont 文件类型图标

`runtime-ts/vendor/iconfont-file-types-33437/` 保存 iconfont 图库 33437「文件类型」的选取资源，作者为「就爱赖床576」（用户 ID 954114）。固定快照为 `iconfont-33437-20260908`；上游没有 Git commit，资源 ID 与逐文件 SHA-256 见 [source.json](runtime-ts/vendor/iconfont-file-types-33437/source.json)，来源见 [SOURCE.md](runtime-ts/vendor/iconfont-file-types-33437/SOURCE.md)。

该资源使用 `LicenseRef-Hoox-Iconfont-33437`，**不适用项目 Apache-2.0 许可证，也不是 MIT 等开放许可**。[LICENSE](runtime-ts/vendor/iconfont-file-types-33437/LICENSE) 仅记录维护者于 2026-09-08 确认已取得 Hoox 商用授权，没有支付凭证或独立验证声明；该确认不构成对其他项目的开放许可，也不允许直接用于图标交易。公开发布前，仍需维护者确认现有授权覆盖源码公开分发、制品分发及下游使用；不确定时不得将其表述为已获得开放再分发许可，第三方复用应另行向作者确认授权。

Hoox 自有封装包的发布版本不替代以上固定来源版本、快照标识和许可证边界。
