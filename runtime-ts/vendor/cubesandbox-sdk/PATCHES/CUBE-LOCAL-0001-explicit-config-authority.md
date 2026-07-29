# CUBE-LOCAL-0001：保留显式 Config 身份与路由

本文件是 patch manifest；同目录 `.patch` 保存相对固定仓库基线的精确 unified diff。实际修改文件再由下列清单、
`patchSha256` 与包含全部受控源文件的 `patchedTreeSha256` 共同固定。

- 上游基线：`8721dd151971ce3c2966482bbd32904ad98f378e`
- 补丁基线：本仓库提交 `2251984` 中经上游固定提交校验的 vendor 快照
- 本地版本：`0.3.0-cube.local.1`
- 修改文件：`SOURCE.md`、`package.json`、`package-lock.json`、`src/config.ts`、`src/sandbox.ts`、
  `test/config.test.ts`、`test/sandbox.test.ts`
- 回归证据：`test/config.test.ts`、`test/sandbox.test.ts`、Runtime `packages/sandbox/src/sandbox.test.ts`

## 风险

上游 `Sandbox.create({ config: Config })` 重建 Config 时没有复制 `apiKey`；显式 `null` 也因 nullish fallback 再次读取
`CUBE_API_KEY`/`E2B_API_KEY`。生产 create 因而可能使用宿主注入凭据，而不是已经审核的 Config 身份。

## 修补

重建 Config 时复制 `apiKey`；`apiKey`、`templateId` 与 `proxyNodeIp` 仅在值为 `undefined` 时读取环境，显式 `null`
保持封闭。测试验证声明 key 决定 Authorization，显式 null 不读取 ambient key，Gateway 的声明代理也不漂移。

## 回退与上游同步

在上游提供并验证等价修复前不得删除本补丁。更新 vendor 基线时逐项重放测试；若上游已覆盖，删除本补丁必须同时更新
本文件、`SOURCE.md`、license policy、canonical patched-tree digest 和三份 SBOM。
