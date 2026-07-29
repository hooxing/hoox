# CubeSandbox Node SDK 来源

本目录以上游 Node SDK 固定提交为基线，Runtime 通过 `packages/sandbox` 隔离其接口。下述已登记安全补丁是唯一允许的
本地差异；不得加入未记录改动。

- 上游仓库：`https://github.com/TencentCloud/CubeSandbox`
- 上游版本：`v0.6.0`
- 固定提交：`8721dd151971ce3c2966482bbd32904ad98f378e`
- 子目录：`sdk/node`
- SDK 上游包版本：`0.3.0`
- Runtime 本地派生版本：`0.3.0-cube.local.1`
- 上游许可证：Apache-2.0

## 本地安全补丁

- `CUBE-LOCAL-0001`（`.patch` 为精确 unified diff，`.md` 为审计说明）：`src/config.ts`、`src/sandbox.ts` 的
  `Sandbox.create({ config: Config })` 必须复制已经解析的 `apiKey`（包括显式
  `null`），不能重新回退 `CUBE_API_KEY`/`E2B_API_KEY`。否则生产显式 Config 与宿主环境冲突时会把 create 请求发往
  注入凭据对应的账户。`test/sandbox.test.ts` 固定验证 Authorization 使用声明 key，显式 null 也不读取 ambient key。
- 上游基线仍是下列固定提交；该补丁尚未被表述为上游已合入，更新 vendor 前必须重新核对并决定保留或删除。

## 同步规则

1. 克隆上游并检出上述固定提交，而不是浮动的 `master`。
2. 机械复制 `sdk/node` 全部内容和仓库根 `LICENSE` 到本目录。
3. 比较源目录与本目录；仅允许 `SOURCE.md` 及“本地安全补丁”列出的精确差异。
4. 运行 `pnpm vendor:build`、类型检查、契约测试和显式真实冒烟。
5. 更新固定提交时必须新增 ADR，说明行为差异及回退方式。

本次导入已通过 `git ls-remote` 和本地 `rev-parse` 双重确认标签指向上述提交。
