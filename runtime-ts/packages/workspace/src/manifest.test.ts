import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkspaceManifestError } from "./errors.js";
import {
  createWorkspaceManifest,
  parseWorkspaceManifest,
  type WorkspaceManifestPolicy,
} from "./manifest.js";

const POLICY: WorkspaceManifestPolicy = {
  maxFiles: 100,
  maxTotalBytes: 10_000,
  maxSingleFileBytes: 1_000,
  maxPathUtf8Bytes: 200,
};
const INCARNATION_A = "11111111-1111-4111-8111-111111111111";
const INCARNATION_B = "22222222-2222-4222-8222-222222222222";

function sha(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function file(path: string, body: string, incarnationId = INCARNATION_A) {
  const digest = sha(body);
  return {
    type: "file",
    path,
    content: { sha256: digest, size: Buffer.byteLength(body) },
    object: {
      tenantId: "tenant-a",
      purpose: "workspace",
      incarnationId,
      physicalObjectKey: `runtime/stable/tenant-a/workspace/sha256/${digest}/incarnations/${incarnationId}`,
    },
  } as const;
}

function manifest(
  entries: readonly unknown[],
  policy: WorkspaceManifestPolicy = POLICY,
  tenantId = "tenant-a",
) {
  return createWorkspaceManifest({ tenantId, entries }, policy);
}

function expectCode(operation: () => unknown, code: WorkspaceManifestError["code"]): void {
  try {
    operation();
    throw new Error("预期操作失败");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceManifestError);
    expect((error as WorkspaceManifestError).code).toBe(code);
  }
}

describe("WorkspaceManifest canonical 契约", () => {
  it("entry 顺序不影响 canonical digest，输出固定按 UTF-8 排序", () => {
    const left = manifest([file("文档/甲.txt", "甲"), file("a.txt", "a")]);
    const right = manifest([file("a.txt", "a"), file("文档/甲.txt", "甲")]);
    expect(left.digest).toBe(right.digest);
    expect(left.entries.map((entry) => entry.path)).toEqual(["a.txt", "文档/甲.txt"]);
  });

  it("任意安全路径排列都产生相同摘要", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}\.txt$/u), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 10_000 }),
        (paths, seed) => {
          const entries = paths.map((path, index) => file(path, `${seed}-${index}`));
          const reversed = [...entries].reverse();
          expect(manifest(entries).digest).toBe(manifest(reversed).digest);
        },
      ),
    );
  });

  it("内容改一字节或路径变化都会改变摘要", () => {
    const base = manifest([file("a.txt", "abc")]);
    expect(manifest([file("a.txt", "abd")]).digest).not.toBe(base.digest);
    expect(manifest([file("b.txt", "abc")]).digest).not.toBe(base.digest);
  });

  it("对象身份绑定 incarnation 与物理键，不能只靠逻辑摘要", () => {
    const first = manifest([file("a", "same", INCARNATION_A)]);
    const second = manifest([file("a", "same", INCARNATION_B)]);
    expect(first.digest).not.toBe(second.digest);

    const mismatched = file("a", "same", INCARNATION_B);
    const forged = {
      ...mismatched,
      object: {
        ...mismatched.object,
        physicalObjectKey: file("a", "same", INCARNATION_A).object.physicalObjectKey,
      },
    };
    expectCode(() => manifest([forged]), "INVALID_OBJECT_IDENTITY");
  });

  it.each([
    ["/etc/passwd", "INVALID_PATH"],
    ["C:/temp/a", "INVALID_PATH"],
    ["../a", "INVALID_PATH"],
    ["a/./b", "INVALID_PATH"],
    ["a//b", "INVALID_PATH"],
    ["a\\b", "INVALID_PATH"],
    ["a\0b", "INVALID_PATH"],
    ["e\u0301.txt", "PATH_NOT_CANONICAL"],
  ] as const)("拒绝越界或非规范路径 %s", (path, code) => {
    expectCode(() => manifest([file(path, "x")]), code);
  });

  it("拒绝重复、大小写冲突及目录-文件前缀冲突", () => {
    expectCode(() => manifest([file("a", "1"), file("a", "2")]), "DUPLICATE_PATH");
    expectCode(() => manifest([file("Readme", "1"), file("README", "2")]), "DUPLICATE_PATH");
    expectCode(() => manifest([file("A", "1"), file("a/b", "2")]), "PATH_CONFLICT");
    expectCode(() => manifest([file("dir", "1"), file("dir/a", "2")]), "PATH_CONFLICT");
  });

  it("首版拒绝 symlink、目录和特殊文件 entry", () => {
    for (const type of ["symlink", "directory", "fifo", "device"]) {
      expectCode(() => manifest([{ ...file("a", "x"), type }]), "INVALID_MANIFEST");
    }
  });

  it("文件数、单文件、总字节和路径限制完全由调用方策略决定", () => {
    expectCode(
      () => manifest([file("a", "1"), file("b", "2")], { ...POLICY, maxFiles: 1 }),
      "LIMIT_EXCEEDED",
    );
    expectCode(
      () => manifest([file("a", "123")], { ...POLICY, maxSingleFileBytes: 2 }),
      "LIMIT_EXCEEDED",
    );
    expectCode(
      () =>
        manifest([file("a", "12"), file("b", "34")], {
          ...POLICY,
          maxTotalBytes: 3,
        }),
      "LIMIT_EXCEEDED",
    );
    expectCode(
      () => manifest([file("中文", "x")], { ...POLICY, maxPathUtf8Bytes: 5 }),
      "LIMIT_EXCEEDED",
    );
  });

  it("网络/持久化边界拒绝未知字段、篡改 digest 与超限既有清单", () => {
    const value = manifest([file("a", "123")]);
    expectCode(
      () => parseWorkspaceManifest({ ...value, unknown: true }, "tenant-a", POLICY),
      "INVALID_MANIFEST",
    );
    expectCode(
      () => parseWorkspaceManifest({ ...value, digest: "0".repeat(64) }, "tenant-a", POLICY),
      "INVALID_MANIFEST",
    );
    expectCode(
      () => parseWorkspaceManifest(value, "tenant-a", { ...POLICY, maxTotalBytes: 2 }),
      "LIMIT_EXCEEDED",
    );
  });

  it("清单绑定可信 Tenant，并拒绝混入其他 Tenant 的 stable 对象", () => {
    const value = manifest([file("a", "1")]);
    expectCode(() => parseWorkspaceManifest(value, "tenant-b", POLICY), "TENANT_SCOPE_MISMATCH");
    expectCode(() => manifest([file("a", "1")], POLICY, "tenant-b"), "TENANT_SCOPE_MISMATCH");
  });
});
