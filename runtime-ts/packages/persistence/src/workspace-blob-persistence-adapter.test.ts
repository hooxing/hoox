import { createHash } from "node:crypto";
import { WorkspaceDependencyError } from "@cube-runtime/workspace";
import { describe, expect, it } from "vitest";
import type { BlobCommitSnapshot } from "./blob-commit-protocol.js";
import type { BlobStore } from "./blob-store.js";
import {
  DurableWorkspaceCandidateBlobWriter,
  type WorkspaceBlobCommitRepository,
} from "./workspace-blob-persistence-adapter.js";

const tenantId = "tenant-workspace-writer";
const sha256 = createHash("sha256").update("workspace").digest("hex");
const incarnationId = "00000000-0000-4000-8000-000000000014";
const physicalObjectKey = `runtime/stable/${tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`;

function blockedSnapshot(): BlobCommitSnapshot {
  return {
    operationId: "workspace-commit-blocked",
    scope: { tenantId },
    status: "stable_mark_gc_blocked",
    version: 9,
    referenceId: "reference-blocked",
    allocation: {
      tenantId,
      purpose: "workspace",
      sha256,
      size: 9,
      lifecycleId: "10000000-0000-4000-8000-000000000014",
      incarnationId,
      physicalObjectKey,
      allocationId: "20000000-0000-4000-8000-000000000014",
      generation: 1,
      mode: "active_reuse",
    },
    staged: {
      kind: "staging",
      tenantId,
      purpose: "workspace",
      sha256,
      size: 9,
      mediaType: "application/octet-stream",
      uploadId: "upload-blocked",
    },
    stable: {
      kind: "stable",
      tenantId,
      purpose: "workspace",
      sha256,
      size: 9,
      mediaType: "application/octet-stream",
      incarnationId,
      physicalObjectKey,
    },
  };
}

function writer(lifecycle: Awaited<ReturnType<WorkspaceBlobCommitRepository["resolveLifecycle"]>>) {
  const repository = {
    compareAndSet: async (input: { readonly next: BlobCommitSnapshot }) => {
      void input;
      return true;
    },
    resolveLifecycle: async () => lifecycle,
  } as unknown as WorkspaceBlobCommitRepository;
  return new DurableWorkspaceCandidateBlobWriter(repository, {} as BlobStore, 1024);
}

describe("Workspace candidate Blob 的 GC 阻塞恢复", () => {
  it("GC 已删除旧 incarnation 时丢弃旧 target，回到 reference_committed 以重新分配", async () => {
    const service = writer({
      status: "deleted",
      retiredIncarnationId: incarnationId,
      retiredPhysicalObjectKey: physicalObjectKey,
    });
    const result = await (
      service as unknown as {
        advance(
          snapshot: BlobCommitSnapshot,
          body: Uint8Array,
          uploadId: string,
        ): Promise<{ readonly kind: "next"; readonly snapshot: BlobCommitSnapshot }>;
      }
    ).advance(blockedSnapshot(), new Uint8Array(), "unused");

    expect(result.snapshot).toMatchObject({
      status: "reference_committed",
      retiredIncarnationId: incarnationId,
      retiredPhysicalObjectKey: physicalObjectKey,
    });
    expect(result.snapshot.stable).toBeUndefined();
  });

  it("GC claim 已释放时回到 stable_object_ready，随后重新执行 stable mark", async () => {
    const service = writer({ status: "active" });
    const result = await (
      service as unknown as {
        advance(
          snapshot: BlobCommitSnapshot,
          body: Uint8Array,
          uploadId: string,
        ): Promise<{ readonly kind: "next"; readonly snapshot: BlobCommitSnapshot }>;
      }
    ).advance(blockedSnapshot(), new Uint8Array(), "unused");

    expect(result.snapshot.status).toBe("stable_object_ready");
    expect(result.snapshot.stable).toMatchObject({ incarnationId, physicalObjectKey });
  });

  it.each(["pre_delete", "deleting"] as const)(
    "%s 中的 GC 是已知可重试竞争，不被误报为 unknown",
    async (status) => {
      const service = writer({ status });
      await expect(
        (
          service as unknown as {
            advance(
              snapshot: BlobCommitSnapshot,
              body: Uint8Array,
              uploadId: string,
            ): Promise<{ readonly kind: "next"; readonly snapshot: BlobCommitSnapshot }>;
          }
        ).advance(blockedSnapshot(), new Uint8Array(), "unused"),
      ).rejects.toEqual(new WorkspaceDependencyError("known", "BLOB_GC_IN_PROGRESS"));
    },
  );
});
