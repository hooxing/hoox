# CubeSandbox Node SDK 来源

本目录是上游 Node SDK 的原样快照，Runtime 通过 `packages/sandbox` 隔离其接口，禁止在此目录打补丁。

- 上游仓库：`https://github.com/TencentCloud/CubeSandbox`
- 上游版本：`v0.6.0`
- 固定提交：`8721dd151971ce3c2966482bbd32904ad98f378e`
- 子目录：`sdk/node`
- SDK 包版本：`0.3.0`
- 上游许可证：Apache-2.0

## 同步规则

1. 克隆上游并检出上述固定提交，而不是浮动的 `master`。
2. 机械复制 `sdk/node` 全部内容和仓库根 `LICENSE` 到本目录。
3. 比较源目录与本目录；仅允许 `SOURCE.md` 是本地新增文件。
4. 运行 `pnpm vendor:build`、类型检查、契约测试和显式真实冒烟。
5. 更新固定提交时必须新增 ADR，说明行为差异及回退方式。

本次导入已通过 `git ls-remote` 和本地 `rev-parse` 双重确认标签指向上述提交。
