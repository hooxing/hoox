import { createHash } from "node:crypto";
import {
  type BlobCommitSnapshot,
  type BlobCommitStatePort,
  type BlobReferenceCommitPort,
  transitionBlobCommit,
} from "./blob-commit-protocol.js";
import type {
  BlobStore,
  StableBlobGcClaimPort,
  StableBlobLifecycleAllocationPort,
  StableBlobRef,
} from "./blob-store.js";

export type ResourceBlobCommitRepository = BlobCommitStatePort &
  BlobReferenceCommitPort &
  StableBlobLifecycleAllocationPort &
  Pick<StableBlobGcClaimPort, "resolveLifecycle">;

export interface PersistResourceBlobResult {
  readonly referenceId: string;
  readonly blob: StableBlobRef & { readonly purpose: "resource" };
}

/** 为 deliver_file 持久化 resource-purpose 字节；每一步都可从 PG snapshot 幂等恢复。 */
export class DurableResourceBlobWriter {
  constructor(
    private readonly repository: ResourceBlobCommitRepository,
    private readonly blobs: BlobStore,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new TypeError("Resource Blob 配额无效");
  }

  async persist(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly body: Uint8Array;
    readonly sha256: string;
    readonly mediaType: string;
  }): Promise<PersistResourceBlobResult> {
    if (!(input.body instanceof Uint8Array) || input.body.byteLength > this.maxBytes) {
      throw new Error("RESOURCE_BLOB_LIMIT_EXCEEDED");
    }
    const actual = createHash("sha256").update(input.body).digest("hex");
    if (actual !== input.sha256) throw new Error("RESOURCE_BLOB_INTEGRITY_MISMATCH");
    const digest = createHash("sha256")
      .update(`${input.tenantId}\0${input.idempotencyKey}`, "utf8")
      .digest("hex");
    const operationId = `deliver-${digest}`;
    const uploadId = `deliver-${digest}`;
    const scope = { tenantId: input.tenantId };
    let snapshot = await this.repository.load(scope, operationId);
    if (snapshot === undefined) {
      await this.repository
        .create({
          operationId,
          scope,
          status: "upload_pending",
          version: 0,
          expectedPurpose: "resource",
          expectedSha256: input.sha256,
          expectedSize: input.body.byteLength,
        })
        .catch(() => undefined);
      snapshot = await this.repository.load(scope, operationId);
    }
    if (snapshot === undefined) throw new Error("RESOURCE_BLOB_STATE_UNAVAILABLE");
    for (let step = 0; step < 32; step += 1) {
      if (!matches(snapshot, input)) throw new Error("RESOURCE_BLOB_IDEMPOTENCY_CONFLICT");
      const result = await this.advance(snapshot, input.body, input.mediaType, uploadId);
      if ("result" in result) return result.result;
      snapshot = result.snapshot;
    }
    throw new Error("RESOURCE_BLOB_STATE_STALLED");
  }

  private async advance(
    snapshot: BlobCommitSnapshot,
    body: Uint8Array,
    mediaType: string,
    uploadId: string,
  ): Promise<
    { readonly snapshot: BlobCommitSnapshot } | { readonly result: PersistResourceBlobResult }
  > {
    const scope = snapshot.scope;
    switch (snapshot.status) {
      case "upload_pending": {
        const staged = await this.blobs.putStaging({
          scope,
          purpose: "resource",
          uploadId,
          body,
          mediaType,
          ...(snapshot.expectedSha256 === undefined
            ? {}
            : { expectedSha256: snapshot.expectedSha256 }),
          ...(snapshot.expectedSize === undefined ? {} : { expectedSize: snapshot.expectedSize }),
        });
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, { type: "stage_verified", staged }),
        );
      }
      case "staged":
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, { type: "reference_commit_started" }),
        );
      case "reference_commit_pending": {
        if (snapshot.staged === undefined) throw new Error("RESOURCE_BLOB_STATE_INVALID");
        try {
          const reference = await this.repository.commitStagedReference({
            operationId: snapshot.operationId,
            scope,
            staged: snapshot.staged,
          });
          return this.next(
            snapshot,
            transitionBlobCommit(snapshot, {
              type: "reference_commit_succeeded",
              referenceId: reference.referenceId,
            }),
          );
        } catch {
          return this.next(
            snapshot,
            transitionBlobCommit(snapshot, { type: "reference_commit_result_unknown" }),
          );
        }
      }
      case "reference_commit_unknown": {
        const resolved = await this.repository.resolveReferenceCommit(scope, snapshot.operationId);
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, {
            type: "reference_commit_resolved",
            committed: resolved.status === "committed",
            ...(resolved.status === "committed" ? { referenceId: resolved.referenceId } : {}),
          }),
        );
      }
      case "reference_committed": {
        if (snapshot.staged === undefined || snapshot.referenceId === undefined) {
          throw new Error("RESOURCE_BLOB_STATE_INVALID");
        }
        const allocation = await this.repository.reserve({
          scope,
          staged: snapshot.staged,
          operationId: snapshot.operationId,
          referenceId: snapshot.referenceId,
        });
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, {
            type: "allocation_reserved",
            allocation,
            stable: {
              kind: "stable",
              tenantId: allocation.tenantId,
              purpose: "resource",
              sha256: allocation.sha256,
              size: allocation.size,
              mediaType: snapshot.staged.mediaType,
              incarnationId: allocation.incarnationId,
              physicalObjectKey: allocation.physicalObjectKey,
            },
          }),
        );
      }
      case "allocation_reserved": {
        if (snapshot.allocation === undefined) throw new Error("RESOURCE_BLOB_STATE_INVALID");
        await this.repository.startPromotion({
          scope,
          operationId: snapshot.operationId,
          expectedSnapshotVersion: snapshot.version,
          allocationId: snapshot.allocation.allocationId,
        });
        const reloaded = await this.repository.load(scope, snapshot.operationId);
        if (reloaded === undefined) throw new Error("RESOURCE_BLOB_STATE_UNAVAILABLE");
        return { snapshot: reloaded };
      }
      case "promotion_started": {
        if (snapshot.staged === undefined || snapshot.promotionAuthorization === undefined) {
          throw new Error("RESOURCE_BLOB_STATE_INVALID");
        }
        const stable = await this.blobs.promote(
          scope,
          snapshot.staged,
          snapshot.promotionAuthorization,
        );
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, { type: "promotion_succeeded", stable }),
        );
      }
      case "stable_object_ready": {
        if (snapshot.stable === undefined || snapshot.referenceId === undefined) {
          throw new Error("RESOURCE_BLOB_STATE_INVALID");
        }
        if ((await this.blobs.head(scope, snapshot.stable)) === undefined) {
          throw new Error("RESOURCE_BLOB_HEAD_UNAVAILABLE");
        }
        const marked = await this.repository.markReferenceStable({
          operationId: snapshot.operationId,
          scope,
          referenceId: snapshot.referenceId,
          stable: snapshot.stable,
        });
        return this.next(
          snapshot,
          transitionBlobCommit(
            snapshot,
            marked === "marked"
              ? { type: "stable_mark_succeeded" }
              : { type: "stable_mark_gc_blocked" },
          ),
        );
      }
      case "stable_mark_unknown": {
        const status = await this.repository.resolveStableMark(scope, snapshot.operationId);
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, { type: "stable_mark_resolved", status }),
        );
      }
      case "stable_mark_gc_blocked": {
        if (snapshot.stable === undefined) throw new Error("RESOURCE_BLOB_STATE_INVALID");
        const lifecycle = await this.repository.resolveLifecycle({ scope, blob: snapshot.stable });
        if (lifecycle.status !== "active") throw new Error("RESOURCE_BLOB_GC_IN_PROGRESS");
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, {
            type: "stable_gc_lifecycle_resolved",
            status: "active",
          }),
        );
      }
      case "stable":
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, { type: "cleanup_requested", target: "staging" }),
        );
      case "cleanup_pending": {
        if (snapshot.staged === undefined) throw new Error("RESOURCE_BLOB_STATE_INVALID");
        await this.blobs.deleteStaging(scope, snapshot.staged);
        return this.next(
          snapshot,
          transitionBlobCommit(snapshot, { type: "cleanup_succeeded", target: "staging" }),
        );
      }
      case "completed": {
        const stable = snapshot.stable;
        if (
          stable === undefined ||
          stable.purpose !== "resource" ||
          snapshot.referenceId === undefined
        ) {
          throw new Error("RESOURCE_BLOB_STATE_INVALID");
        }
        return {
          result: Object.freeze({
            referenceId: snapshot.referenceId,
            blob: Object.freeze({ ...stable, purpose: "resource" as const }),
          }),
        };
      }
      default:
        throw new Error("RESOURCE_BLOB_STATE_UNAVAILABLE");
    }
  }

  private async next(current: BlobCommitSnapshot, desired: BlobCommitSnapshot) {
    if (
      await this.repository.compareAndSet({
        scope: current.scope,
        operationId: current.operationId,
        expectedVersion: current.version,
        next: desired,
      })
    ) {
      return { snapshot: desired };
    }
    return {
      snapshot: (await this.repository.load(current.scope, current.operationId)) ?? current,
    };
  }
}

function matches(
  snapshot: BlobCommitSnapshot,
  input: { readonly tenantId: string; readonly body: Uint8Array; readonly sha256: string },
): boolean {
  return (
    snapshot.scope.tenantId === input.tenantId &&
    snapshot.expectedPurpose === "resource" &&
    snapshot.expectedSha256 === input.sha256 &&
    snapshot.expectedSize === input.body.byteLength
  );
}
