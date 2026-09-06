import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCycloneDx,
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
    properties: [{ name: "hoox:origin", value: "registry" }] as const,
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
      const componentNames = bom.components.map(
        (component: { readonly name: string }) => component.name,
      );
      expect(
        componentNames.filter((name: string) =>
          /^(?:@earendil-works\/pi-(?:coding-agent|tui)|@mariozechner\/clipboard(?:-.+)?|@silvia-odwyer\/photon-node)$/u.test(
            name,
          ),
        ),
      ).toEqual([]);
      expect(componentNames).not.toEqual(
        expect.arrayContaining(["react", "react-dom", "vite", "vitest", "lightningcss"]),
      );
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
          "hoox:upstream-source-commit": policy.vendorEvidence["@cubesandbox/sdk"].upstreamCommit,
          "hoox:local-modified": "true",
          "hoox:local-patch-id": "CUBE-LOCAL-0001",
          "hoox:local-patch-sha256": policy.vendorEvidence["@cubesandbox/sdk"].patchSha256,
          "hoox:patched-tree-sha256": policy.vendorEvidence["@cubesandbox/sdk"].patchedTreeSha256,
        }),
      );
      if (target.id === "worker") {
        const tokenizerVendor = bom.components.find(
          (component: { readonly name: string }) =>
            component.name === "@hoox/vendor-deepseek-v4-tokenizer",
        );
        expect(tokenizerVendor).toMatchObject({
          version: "0.0.0-a7aaed80",
          licenses: [{ license: { id: "MIT" } }],
        });
        expect(
          Object.fromEntries(
            tokenizerVendor.properties.map(
              ({ name, value }: { readonly name: string; readonly value: string }) => [name, value],
            ),
          ),
        ).toEqual(
          expect.objectContaining({
            "hoox:origin": "vendor",
            "hoox:local-modified": "false",
            "hoox:upstream-source-commit":
              policy.vendorEvidence["@hoox/vendor-deepseek-v4-tokenizer"].upstreamCommit,
            "hoox:source-tree-sha256":
              policy.vendorEvidence["@hoox/vendor-deepseek-v4-tokenizer"].sourceTreeSha256,
          }),
        );
      }
    }
  }, 120_000);

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

  it("所有 vendor 目录都必须登记，未修改快照必须固定 source tree", () => {
    const policy = JSON.parse(
      readFileSync(new URL("../supply-chain/license-policy.json", import.meta.url), "utf8"),
    );
    const withoutTokenizer = { ...policy.vendorEvidence };
    Reflect.deleteProperty(withoutTokenizer, "@hoox/vendor-deepseek-v4-tokenizer");
    expect(validateVendorEvidence({ ...policy, vendorEvidence: withoutTokenizer })).toContain(
      "vendor 目录未登记：runtime-ts/vendor/deepseek-v4-tokenizer",
    );
    expect(
      validateVendorEvidence({
        ...policy,
        vendorEvidence: {
          ...policy.vendorEvidence,
          "@hoox/vendor-deepseek-v4-tokenizer": {
            ...policy.vendorEvidence["@hoox/vendor-deepseek-v4-tokenizer"],
            sourceTreeSha256: "0".repeat(64),
          },
        },
      }),
    ).toContain("vendor source tree 不匹配：@hoox/vendor-deepseek-v4-tokenizer");
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
      writeFileSync(join(directory, "src", "dist", "controlled.ts"), "line-one\r\nline-two\r\n");
      const crlf = canonicalVendorTreeSha256(directory);
      writeFileSync(join(directory, "src", "dist", "controlled.ts"), "line-one\nline-two\n");
      expect(canonicalVendorTreeSha256(directory)).toBe(crlf);
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
      root: { name: "@hoox/api", version: "0.0.0" },
      components: [second, first],
      lockfileSha256: "a".repeat(64),
    });
    const right = buildCycloneDx({
      root: { name: "@hoox/api", version: "0.0.0" },
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
