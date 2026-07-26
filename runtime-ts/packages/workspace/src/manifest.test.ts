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

function incarnationFor(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function file(path: string, body: string, requestedIncarnationId?: string) {
  const digest = sha(body);
  const incarnationId = requestedIncarnationId ?? incarnationFor(digest);
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

  it("Unicode canonical golden vector 固定，反转输入不改变结果", () => {
    const entries = [file("文档/甲.txt", "甲"), file("emoji/😀.txt", "ok")];
    const forward = manifest(entries);
    const reversed = manifest([...entries].reverse());
    expect(forward.digest).toBe("7190cedbff708b8be6c0062708f4b353693fe8a260336dafc5bd2f558f8feae6");
    expect(reversed.digest).toBe(forward.digest);
    expect(forward.entries.map((entry) => entry.path)).toEqual(["emoji/😀.txt", "文档/甲.txt"]);
  });

  it("空清单 canonical golden vector 固定", () => {
    expect(manifest([], { maxFiles: 0, maxTotalBytes: 0 }).digest).toBe(
      "8070fd9fe52237051cca75466470615590c22969b82d6a14a2e786765e120647",
    );
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

    const firstEntry = first.entries[0];
    if (firstEntry === undefined) {
      throw new Error("测试清单缺少文件");
    }
    const malformedUnicodeKey = {
      ...firstEntry,
      object: {
        ...firstEntry.object,
        physicalObjectKey: `bad\ud800/${firstEntry.object.physicalObjectKey}`,
      },
    };
    expectCode(() => manifest([malformedUnicodeKey]), "INVALID_OBJECT_IDENTITY");
  });

  it.each([
    ["/etc/passwd", "INVALID_PATH"],
    ["C:/temp/a", "INVALID_PATH"],
    ["../a", "INVALID_PATH"],
    ["a/./b", "INVALID_PATH"],
    ["a//b", "INVALID_PATH"],
    ["a\\b", "INVALID_PATH"],
    ["a\0b", "INVALID_PATH"],
    [`a${String.fromCharCode(0x0085)}b`, "INVALID_PATH"],
    ["a\u200db", "INVALID_PATH"],
    ["bad\ud800.txt", "INVALID_PATH"],
    ["bad\udc00.txt", "INVALID_PATH"],
    ["e\u0301.txt", "PATH_NOT_CANONICAL"],
  ] as const)("拒绝越界或非规范路径 %s", (path, code) => {
    expectCode(() => manifest([file(path, "x")]), code);
  });

  it("拒绝重复、大小写冲突及目录-文件前缀冲突", () => {
    expectCode(() => manifest([file("a", "1"), file("a", "2")]), "DUPLICATE_PATH");
    expectCode(() => manifest([file("Readme", "1"), file("README", "2")]), "DUPLICATE_PATH");
    expectCode(() => manifest([file("A", "1"), file("a/b", "2")]), "PATH_CONFLICT");
    expectCode(() => manifest([file("A/b", "1"), file("a", "2")]), "PATH_CONFLICT");
    expectCode(() => manifest([file("a", "2"), file("A/b", "1")]), "PATH_CONFLICT");
    expectCode(() => manifest([file("dir", "1"), file("dir/a", "2")]), "PATH_CONFLICT");
  });

  it("schema v1 大小写键只折叠 ASCII，非 ASCII 大小写保持不同路径", () => {
    const value = manifest([file("Ä.txt", "1"), file("ä.txt", "2")]);
    expect(value.entries).toHaveLength(2);
  });

  it.each([
    "CON",
    "con.txt",
    "dir/LpT1.log",
    "AUX.json",
    "COM9",
    "COM¹",
    "com².txt",
    "CoM³.log",
    "LPT¹",
    "lpt².txt",
    "LpT³.log",
    "nul",
    "conin$",
    "name.",
    "name ",
    "a<b",
    "a>b",
    'a"b',
    "a:b",
    "a|b",
    "a?b",
    "a*b",
  ])("拒绝 Windows 保留或歧义路径 %s", (path) => {
    expectCode(() => manifest([file(path, "x")]), "INVALID_PATH");
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
    expectCode(
      () => manifest([file("a", "x")], { ...POLICY, maxTotalBytes: -0 }),
      "INVALID_MANIFEST",
    );
    expectCode(
      () =>
        manifest([
          {
            ...file("a", ""),
            content: { ...file("a", "").content, size: -0 },
          },
        ]),
      "INVALID_MANIFEST",
    );
  });

  it("拒绝伪造 length 的 Proxy，普通数组超限时也不读取元素", () => {
    const base = [file("a", "1")];
    let elementDescriptorReads = 0;
    let lengthDescriptorReads = 0;
    let ownKeysCalls = 0;
    let directReads = 0;
    const oversized = new Proxy(base, {
      get() {
        directReads += 1;
        throw new Error("不应直接读取数组字段");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("超限前不应枚举元素");
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") {
          lengthDescriptorReads += 1;
          return { ...Reflect.getOwnPropertyDescriptor(target, property), value: 0 };
        }
        elementDescriptorReads += 1;
        throw new Error("拒绝 Proxy 前不应读取元素 descriptor");
      },
    });
    expectCode(() => manifest(oversized, { ...POLICY, maxFiles: 0 }), "INVALID_MANIFEST");
    expect({ directReads, ownKeysCalls, elementDescriptorReads, lengthDescriptorReads }).toEqual({
      directReads: 0,
      ownKeysCalls: 0,
      elementDescriptorReads: 0,
      lengthDescriptorReads: 0,
    });

    let ordinaryGetterCalls = 0;
    const ordinaryOversized: unknown[] = [];
    Object.defineProperty(ordinaryOversized, "0", {
      enumerable: true,
      get() {
        ordinaryGetterCalls += 1;
        return file("ordinary.txt", "x");
      },
    });
    ordinaryOversized.length = 1;
    expectCode(() => manifest(ordinaryOversized, { ...POLICY, maxFiles: 0 }), "LIMIT_EXCEEDED");
    expect(ordinaryGetterCalls).toBe(0);
  });

  it("同一 Tenant/purpose/incarnation 不能绑定不同内容或物理键", () => {
    expectCode(
      () => manifest([file("a", "one", INCARNATION_A), file("b", "two", INCARNATION_A)]),
      "INVALID_OBJECT_IDENTITY",
    );
    const same = file("a", "one", INCARNATION_A);
    expect(manifest([same, { ...same, path: "b" }]).entries).toHaveLength(2);
  });

  it("拒绝 accessor 和所有 Proxy，且不执行动态字段", () => {
    let getterCalls = 0;
    const accessorEntry = { ...file("a", "x") } as Record<string, unknown>;
    Object.defineProperty(accessorEntry, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "a";
      },
    });
    expectCode(() => manifest([accessorEntry]), "INVALID_MANIFEST");
    expect(getterCalls).toBe(0);

    const accessorEntries: unknown[] = [];
    Object.defineProperty(accessorEntries, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return file("array.txt", "x");
      },
    });
    accessorEntries.length = 1;
    expectCode(() => manifest(accessorEntries), "INVALID_MANIFEST");
    expect(getterCalls).toBe(0);

    const descriptorCalls = new Map<PropertyKey, number>();
    let directReads = 0;
    const proxyEntry = new Proxy(file("proxy.txt", "safe"), {
      get() {
        directReads += 1;
        throw new Error("不应直接读取 Proxy 字段");
      },
      getOwnPropertyDescriptor(target, property) {
        descriptorCalls.set(property, (descriptorCalls.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expectCode(() => manifest([proxyEntry]), "INVALID_MANIFEST");
    expect(directReads).toBe(0);
    expect(descriptorCalls.size).toBe(0);

    const revoked = Proxy.revocable(file("revoked.txt", "x"), {});
    revoked.revoke();
    expectCode(() => manifest([revoked.proxy]), "INVALID_MANIFEST");
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
