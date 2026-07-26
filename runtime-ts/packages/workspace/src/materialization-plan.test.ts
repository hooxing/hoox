import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceManifestError } from "./errors.js";
import { createWorkspaceManifest, type WorkspaceManifestPolicy } from "./manifest.js";
import { planWorkspaceMaterialization } from "./materialization-plan.js";
import { resolveWorkspaceTargetPath } from "./path.js";

const POLICY: WorkspaceManifestPolicy = { maxFiles: 50, maxTotalBytes: 50_000 };
const INCARNATION = "11111111-1111-4111-8111-111111111111";

function file(path: string, body: string) {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    type: "file",
    path,
    content: { sha256, size: Buffer.byteLength(body) },
    object: {
      tenantId: "tenant-a",
      purpose: "workspace",
      incarnationId: INCARNATION,
      physicalObjectKey: `runtime/stable/tenant-a/workspace/sha256/${sha256}/incarnations/${INCARNATION}`,
    },
  } as const;
}

function manifest(entries: readonly unknown[], tenantId = "tenant-a") {
  return createWorkspaceManifest({ tenantId, entries }, POLICY);
}

describe("Workspace 物化计划", () => {
  it("从空目录生成浅到深建目录和固定文件顺序，且目标不能逃逸", () => {
    const target = manifest([file("z.txt", "z"), file("a/b/c.txt", "c")]);
    const plan = planWorkspaceMaterialization({ root: "/workspace", target });
    expect(plan.ensureDirectories.map((item) => item.relativePath)).toEqual(["a", "a/b"]);
    expect(plan.materializeFiles.map((item) => item.relativePath)).toEqual(["a/b/c.txt", "z.txt"]);
    expect(plan.materializeFiles[0]?.targetPath).toBe("/workspace/a/b/c.txt");
    expect(plan.removeFiles).toEqual([]);
    expect(plan.previousManifestDigest).toBeUndefined();
  });

  it("相对前一清单确定删除、保留、目录替换和同内容复用候选", () => {
    const previous = manifest([
      file("keep", "same"),
      file("old/deep/a", "move"),
      file("gone", "gone"),
    ]);
    const target = manifest([
      file("keep", "same"),
      file("old", "now-file"),
      file("new/place", "move"),
    ]);
    const plan = planWorkspaceMaterialization({ root: "/work", previous, target });

    expect(plan.removeFiles.map((item) => item.relativePath)).toEqual(["gone", "old/deep/a"]);
    expect(plan.removeDirectories.map((item) => item.relativePath)).toEqual(["old/deep", "old"]);
    expect(plan.ensureDirectories.map((item) => item.relativePath)).toEqual(["new"]);
    const moved = plan.materializeFiles.find((item) => item.relativePath === "new/place");
    expect(moved?.reuseCandidates).toEqual([
      {
        relativePath: "old/deep/a",
        targetPath: "/work/old/deep/a",
        requiresAuthorizationAndIntegrityCheck: true,
      },
    ]);
    const kept = plan.materializeFiles.find((item) => item.relativePath === "keep");
    expect(kept?.existingTargetCandidate).toEqual({
      relativePath: "keep",
      targetPath: "/work/keep",
      requiresAuthorizationAndIntegrityCheck: true,
    });
    expect(kept?.object).toEqual(target.entries.find((entry) => entry.path === "keep")?.object);
  });

  it("相同输入的计划逐字段相等，输入清单不能用篡改 digest 绕过", () => {
    const target = manifest([file("a", "1")]);
    const first = planWorkspaceMaterialization({ root: "/workspace", target });
    const second = planWorkspaceMaterialization({ root: "/workspace", target });
    expect(first).toEqual(second);
    expect(() =>
      planWorkspaceMaterialization({
        root: "/workspace",
        target: { ...target, digest: "0".repeat(64) },
      }),
    ).toThrowError(WorkspaceManifestError);
  });

  it("拒绝把其他 Tenant 的前一清单伪装成可复用来源", () => {
    const target = manifest([file("a", "1")]);
    const previous = manifest([], "tenant-b");
    expect(() => planWorkspaceMaterialization({ root: "/workspace", target, previous })).toThrow(
      expect.objectContaining({ code: "TENANT_SCOPE_MISMATCH" }),
    );
  });

  it.each(["../escape", "/escape", "C:/escape", "a\\escape"])(
    "纯 POSIX 目标解析拒绝 %s",
    (relativePath) => {
      expect(() => resolveWorkspaceTargetPath("/workspace", relativePath)).toThrowError(
        WorkspaceManifestError,
      );
    },
  );

  it("拒绝未经规范化的根目录，不读取或创建宿主路径", () => {
    expect(() => resolveWorkspaceTargetPath("/workspace/../tmp", "a")).toThrowError(
      WorkspaceManifestError,
    );
    expect(() => resolveWorkspaceTargetPath("C:\\workspace", "a")).toThrowError(
      WorkspaceManifestError,
    );
  });
});
