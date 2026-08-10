import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCycloneDx,
  canonicalizeProductionPlatformComponents,
  canonicalVendorTreeSha256,
  evaluateLicensePolicy,
  productionSbomTargets,
  validateProductionSupplyChain,
  validateVendorEvidence,
  verifyReverseApplicablePatch,
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
    const policy = JSON.parse(
      readFileSync(new URL("../supply-chain/license-policy.json", import.meta.url), "utf8"),
    );
    expect(validateVendorEvidence(policy)).toEqual([]);
    for (const target of productionSbomTargets) {
      const bom = JSON.parse(
        readFileSync(new URL(`../supply-chain/sbom/${target.fileName}`, import.meta.url), "utf8"),
      );
      expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 });
      const vendor = bom.components.find(
        (component: { readonly name: string }) => component.name === "@cubesandbox/sdk",
      );
      expect(vendor).toMatchObject({ version: "0.3.0-cube.local.1" });
      expect(
        Object.fromEntries(
          vendor.properties.map(
            ({ name, value }: { readonly name: string; readonly value: string }) => [name, value],
          ),
        ),
      ).toEqual(
        expect.objectContaining({
          "cube:upstream-source-commit": policy.vendorEvidence["@cubesandbox/sdk"].upstreamCommit,
          "cube:local-modified": "true",
          "cube:local-patch-id": "CUBE-LOCAL-0001",
          "cube:local-patch-sha256": policy.vendorEvidence["@cubesandbox/sdk"].patchSha256,
          "cube:patched-tree-sha256": policy.vendorEvidence["@cubesandbox/sdk"].patchedTreeSha256,
        }),
      );
    }
  }, 60_000);

  it("vendor patch 或 canonical tree 哈希漂移时失败关闭", () => {
    const policy = JSON.parse(
      readFileSync(new URL("../supply-chain/license-policy.json", import.meta.url), "utf8"),
    );
    const evidence = policy.vendorEvidence["@cubesandbox/sdk"];
    expect(
      validateVendorEvidence({
        ...policy,
        vendorEvidence: {
          ...policy.vendorEvidence,
          "@cubesandbox/sdk": { ...evidence, patchSha256: "0".repeat(64) },
        },
      }),
    ).toContain("vendor 补丁哈希不匹配：@cubesandbox/sdk");
    expect(
      validateVendorEvidence({
        ...policy,
        vendorEvidence: {
          ...policy.vendorEvidence,
          "@cubesandbox/sdk": { ...evidence, patchedTreeSha256: "0".repeat(64) },
        },
      }),
    ).toContain("vendor patched tree 不匹配：@cubesandbox/sdk");
    expect(
      validateVendorEvidence({
        ...policy,
        vendorEvidence: {
          ...policy.vendorEvidence,
          "@cubesandbox/sdk": { ...evidence, patchedFiles: ["runtime-ts/vendor/other.ts"] },
        },
      }),
    ).toContain("vendor 补丁哈希不匹配：@cubesandbox/sdk");
  });

  it("canonical tree 只排除 vendor 根级生成目录", () => {
    const directory = mkdtempSync(join(tmpdir(), "cube-vendor-tree-"));
    try {
      mkdirSync(join(directory, "dist"));
      mkdirSync(join(directory, "src", "dist"), { recursive: true });
      writeFileSync(join(directory, "dist", "generated.js"), "ignored-one");
      writeFileSync(join(directory, "src", "dist", "controlled.ts"), "controlled-one");
      const initial = canonicalVendorTreeSha256(directory);
      writeFileSync(join(directory, "dist", "generated.js"), "ignored-two");
      expect(canonicalVendorTreeSha256(directory)).toBe(initial);
      writeFileSync(join(directory, "src", "dist", "controlled.ts"), "controlled-two");
      expect(canonicalVendorTreeSha256(directory)).not.toBe(initial);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exact patch 必须能从当前受控 vendor tree 反向应用", () => {
    const patchPath = fileURLToPath(
      new URL(
        "../runtime-ts/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.patch",
        import.meta.url,
      ),
    );
    expect(verifyReverseApplicablePatch(patchPath)).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "cube-invalid-patch-"));
    try {
      const invalidPatchPath = join(directory, "invalid.patch");
      writeFileSync(invalidPatchPath, "Subject: [PATCH] invalid\n\nnot a unified diff\n");
      expect(verifyReverseApplicablePatch(invalidPatchPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("宿主平台 native optional 包规范化为 Linux x64 生产闭包", () => {
    const normalized = canonicalizeProductionPlatformComponents([
      component("@mariozechner/clipboard", "MIT"),
      component("@mariozechner/clipboard-win32-x64-msvc", "MIT"),
      component("portable", "Apache-2.0"),
    ]);

    expect(normalized.map((item) => item.name).sort()).toEqual([
      "@mariozechner/clipboard",
      "@mariozechner/clipboard-linux-x64-gnu",
      "@mariozechner/clipboard-linux-x64-musl",
      "portable",
    ]);
    expect(() =>
      canonicalizeProductionPlatformComponents([
        component("@mariozechner/clipboard-win32-x64-msvc", "MIT"),
        {
          ...component("@mariozechner/clipboard-linux-x64-gnu", "MIT"),
          version: "0.0.2",
        },
      ]),
    ).toThrow("PRODUCTION_SBOM_PLATFORM_COMPONENT_CONFLICT");
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
