# 供应链证据

本目录保存 production 依赖闭包的许可证策略和确定性 SBOM 证据。

```text
license-policy.json
sbom/
  api.cdx.json
  scheduler.cdx.json
  worker.cdx.json
```

## 验证

```powershell
corepack pnpm supply-chain:check
corepack pnpm license:check
```

校验器根据 pnpm production installed closure 离线生成无时间戳、确定排序的 CycloneDX 1.6 SBOM，并与已提交文件逐字比较。许可证策略默认拒绝未声明或不允许的 registry/vendor 闭包。

vendored 源码还会核对固定上游 commit、许可证、来源、patch 与 canonical tree hash。项目级许可证见根目录 `LICENSE`；第三方组件说明见 `THIRD_PARTY_NOTICES.md`。

这些文件证明仓库提交与生产闭包满足既定供应链契约，不证明基础镜像远端仓库、部署平台或运行时外部服务当前可信。完整边界见 [`docs/operations/production-readiness.md`](../docs/operations/production-readiness.md)。
