import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkspaceManifestError } from "./errors.js";
import { createWorkspaceManifest, type WorkspaceManifestPolicy } from "./manifest.js";
import { planWorkspaceMaterialization } from "./materialization-plan.js";
import { resolveWorkspaceTargetPath } from "./path.js";

const POLICY: WorkspaceManifestPolicy = { maxFiles: 50, maxTotalBytes: 50_000 };
function file(path: string, body: string) {
  const sha256 = createHash("sha256").update(body).digest("hex");
  const incarnationId = `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-4${sha256.slice(13, 16)}-8${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`;
  return {
    type: "file",
    path,
    content: { sha256, size: Buffer.byteLength(body) },
    object: {
      tenantId: "tenant-a",
      purpose: "workspace",
      incarnationId,
      physicalObjectKey: `runtime/stable/tenant-a/workspace/sha256/${sha256}/incarnations/${incarnationId}`,
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
    expect(plan.phases.map((phase) => phase.kind)).toEqual([
      "verify_existing",
      "remove_files",
      "remove_directories",
      "ensure_directories",
      "materialize_files",
    ]);
    expect(plan.phases[3].paths.map((item) => item.relativePath)).toEqual(["a", "a/b"]);
    expect(plan.phases[4].files.map((item) => item.relativePath)).toEqual(["a/b/c.txt", "z.txt"]);
    expect(plan.phases[4].files[0]?.targetPath).toBe("/workspace/a/b/c.txt");
    expect(plan.phases[1].paths).toEqual([]);
    expect(plan.previousManifestDigest).toBeUndefined();
  });

  it("先验证同路径候选，再删除、替换目录并用 stable fallback 物化", () => {
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

    expect(plan.phases[1].paths.map((item) => item.relativePath)).toEqual(["gone", "old/deep/a"]);
    expect(plan.phases[2].paths.map((item) => item.relativePath)).toEqual(["old/deep", "old"]);
    expect(plan.phases[3].paths.map((item) => item.relativePath)).toEqual(["new"]);
    const moved = plan.phases[4].files.find((item) => item.relativePath === "new/place");
    expect(moved?.existingTargetCandidate).toBeUndefined();
    expect(moved?.object).toEqual(
      target.entries.find((entry) => entry.path === "new/place")?.object,
    );
    const kept = plan.phases[4].files.find((item) => item.relativePath === "keep");
    expect(kept?.existingTargetCandidate).toEqual({
      relativePath: "keep",
      targetPath: "/work/keep",
      requiresAuthorizationAndIntegrityCheck: true,
      content: kept?.content,
    });
    expect(plan.phases[0].candidates).toEqual([kept?.existingTargetCandidate]);
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
    expect(() => resolveWorkspaceTargetPath("/workspace/", "a")).toThrowError(
      WorkspaceManifestError,
    );
    expect(resolveWorkspaceTargetPath("/", "a")).toBe("/a");
  });
});
