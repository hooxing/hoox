import { describe, expect, it } from "vitest";
import type { BlobStore, StableBlobGcPort } from "./blob-store.js";
import {
  DurableResourceBlobWriter,
  type PersistResourceBlobResult,
  type ResourceBlobCommitRepository,
} from "./resource-blob-persistence-adapter.js";

const persisted: PersistResourceBlobResult = {
  referenceId: "reference-delivery-cleanup",
  blob: {
    kind: "stable",
    tenantId: "tenant-delivery-cleanup",
    purpose: "resource",
    sha256: "a".repeat(64),
    size: 3,
    mediaType: "application/pdf",
    incarnationId: "00000000-0000-4000-8000-000000000088",
    physicalObjectKey: "agent-runtime/stable/resource/delivery-cleanup",
  },
};

describe("DurableResourceBlobWriter abandon", () => {
  it("先持久化 released，再以同一物理身份触发 stable GC", async () => {
    const events: string[] = [];
    const writer = createWriter(
      {
        releaseUnattachedResourceReference: async (input) => {
          events.push(`release:${input.referenceId}:${input.blob.physicalObjectKey}`);
          return "released";
        },
      },
      {
        collectIfUnreachable: async (_scope, blob) => {
          events.push(`gc:${blob.physicalObjectKey}`);
          return "deleted";
        },
      },
    );

    await expect(writer.abandon({ tenantId: persisted.blob.tenantId, persisted })).resolves.toBe(
      "released",
    );
    expect(events).toEqual([
      `release:${persisted.referenceId}:${persisted.blob.physicalObjectKey}`,
      `gc:${persisted.blob.physicalObjectKey}`,
    ]);
  });

  it("COMMIT 实际成功、规范引用已存在时不触发 GC", async () => {
    let gcCalls = 0;
    const writer = createWriter(
      { releaseUnattachedResourceReference: async () => "still_referenced" },
      {
        collectIfUnreachable: async () => {
          gcCalls += 1;
          return "deleted";
        },
      },
    );

    await expect(writer.abandon({ tenantId: persisted.blob.tenantId, persisted })).resolves.toBe(
      "still_referenced",
    );
    expect(gcCalls).toBe(0);
  });

  it("远端 GC 失败时 release 已先成为可恢复的持久事实", async () => {
    let released = false;
    const writer = createWriter(
      {
        releaseUnattachedResourceReference: async () => {
          released = true;
          return "released";
        },
      },
      { collectIfUnreachable: async () => Promise.reject(new Error("S3_UNAVAILABLE")) },
    );

    await expect(writer.abandon({ tenantId: persisted.blob.tenantId, persisted })).rejects.toThrow(
      "S3_UNAVAILABLE",
    );
    expect(released).toBe(true);
  });

  it("周期恢复会重新领取 released anchor，并在后续 GC 可用时收敛", async () => {
    let gcCalls = 0;
    const writer = createWriter(
      {
        releaseUnattachedResourceReference: async () => "released",
        claimPendingResourceBlobCleanup: async () => [persisted],
      },
      {
        collectIfUnreachable: async () => {
          gcCalls += 1;
          if (gcCalls === 1) throw new Error("S3_UNAVAILABLE");
          return "deleted";
        },
      },
    );

    await expect(writer.abandon({ tenantId: persisted.blob.tenantId, persisted })).rejects.toThrow(
      "S3_UNAVAILABLE",
    );
    await expect(writer.recoverPending({ tenantId: persisted.blob.tenantId })).resolves.toEqual({
      claimed: 1,
      converged: 1,
    });
    expect(gcCalls).toBe(2);
  });
});

function createWriter(
  repository: Pick<ResourceBlobCommitRepository, "releaseUnattachedResourceReference"> &
    Partial<Pick<ResourceBlobCommitRepository, "claimPendingResourceBlobCleanup">>,
  gc: StableBlobGcPort,
): DurableResourceBlobWriter {
  return new DurableResourceBlobWriter(
    {
      claimPendingResourceBlobCleanup: async () => [],
      ...repository,
    } as ResourceBlobCommitRepository,
    {} as BlobStore,
    1024,
    gc,
  );
}
