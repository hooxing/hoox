import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCycloneDx,
  evaluateLicensePolicy,
  productionSbomTargets,
  validateProductionSupplyChain,
} from "../scripts/production-supply-chain.mjs";

function component(name: string, license: string) {
  const reference = `pkg:npm/${name}@1.0.0`;
  return {
    type: "library",
    "bom-ref": reference,
    name,
    version: "1.0.0",
    purl: reference,
    licenses: [{ license: { id: license } }] as const,
    properties: [{ name: "cube:origin", value: "registry" }] as const,
  };
}

describe("生产供应链契约", () => {
  it("锁文件安装闭包可离线复现已提交 CycloneDX SBOM", () => {
    expect(validateProductionSupplyChain()).toEqual([]);
    for (const target of productionSbomTargets) {
      const bom = JSON.parse(
        readFileSync(new URL(`../supply-chain/sbom/${target.fileName}`, import.meta.url), "utf8"),
      );
      expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 });
    }
  }, 30_000);

  it("组件输入顺序不影响确定性输出", () => {
    const first = component("alpha", "MIT");
    const second = component("zeta", "Apache-2.0");
    const left = buildCycloneDx({
      root: { name: "@cube-runtime/api", version: "0.0.0" },
      components: [second, first],
      lockfileSha256: "a".repeat(64),
    });
    const right = buildCycloneDx({
      root: { name: "@cube-runtime/api", version: "0.0.0" },
      components: [first, second],
      lockfileSha256: "a".repeat(64),
    });
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it("deny-list 与未知许可证都失败关闭", () => {
    const issues = evaluateLicensePolicy(
      [component("copyleft", "GPL-3.0-only"), component("unknown", "Custom-1.0")],
      { allowed: ["MIT"], denied: ["GPL-3.0-only"] },
    );
    expect(issues).toEqual([
      "许可证明确禁止：copyleft@1.0.0:GPL-3.0-only",
      "许可证未经允许：unknown@1.0.0:Custom-1.0",
    ]);
  });
});
