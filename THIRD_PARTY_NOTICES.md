# Third-party notices

## Anthropic PPTX Skill（仅 development fixture）

`runtime-ts/vendor/anthropic-skills-pptx/` 从 Anthropic `skills/pptx` 的固定提交 `b29e7cf65e5cb78a5ac33d582270551bc74a14eb` 导入，仅供本地 development Skill Center 测试。其许可证为专有条款，完整许可证、来源和禁止生产发布的约束见该目录的 `LICENSE.txt` 与 `SOURCE.md`。

## CubeSandbox Node SDK

已 vendoring 的 CubeSandbox Node SDK 来源于 TencentCloud/CubeSandbox，使用 Apache License 2.0。源码固定为标签 `v0.6.0`、提交 `8721dd151971ce3c2966482bbd32904ad98f378e` 下的 `sdk/node`；许可证、来源和同步要求见 `runtime-ts/vendor/cubesandbox-sdk/`。

## Pi Coding Agent

`@earendil-works/pi-coding-agent@0.82.1` 来源于 `earendil-works/pi` 的 `v0.82.1` 标签（提交 `b4f293684bba718d59cc1157679bcf6157b3a7f5`），上游采用 MIT License，版权人为 Mario Zechner。仓库保留的完整许可证和来源记录见 `third_party/pi/`；依赖图由 pnpm lockfile 固定。

## DeepSeek Harness Trajectory（仅内部 development 诊断）

`runtime-ts/vendor/deepseek-trajectory/` 保存 DeepSeek Harness `packages/client/ui-trajectory` 的固定源码快照，来源提交为 `47f943859bef60e4160492346772ded9b24f765a`，上游包版本为 `0.1.0-rc.5`，许可证为 MIT，版权人为 DeepSeek。完整许可证、来源和集成边界见该目录的 `LICENSE` 与 `SOURCE.md`。该源码不进入用户产品面，也不引入 DeepSeek Harness 的运行时服务依赖。
