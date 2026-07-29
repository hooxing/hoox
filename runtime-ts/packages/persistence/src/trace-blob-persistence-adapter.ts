import { createHash } from "node:crypto";
import type {
  StableTraceBlobIdentity,
  TraceBlobPersistencePort,
  TraceBlobPersistenceResult,
} from "@cube-runtime/context-policy";
import {
  type BlobCommitSnapshot,
  type BlobCommitStatePort,
  type BlobReferenceCommitPort,
  transitionBlobCommit,
} from "./blob-commit-protocol.js";
import type { StableBlobLifecycleAllocationPort } from "./blob-store.js";
import {
  type BlobStore,
  BlobStoreError,
  type StableBlobGcClaimPort,
  type StableBlobRef,
} from "./blob-store.js";

export type TraceBlobCommitRepository = BlobCommitStatePort &
  BlobReferenceCommitPort &
  StableBlobLifecycleAllocationPort &
  Pick<StableBlobGcClaimPort, "resolveLifecycle">;

/**
 * 生产 Trace adapter 复用唯一的 Blob commit/promotion 状态机。每一步先落 PG 状态，
 * 重启只会从 snapshot 继续；S3 写与 Rollout 写之间不建立伪事务。
 */
export class DurableTraceBlobPersistenceAdapter implements TraceBlobPersistencePort {
  constructor(
    private readonly repository: TraceBlobCommitRepository,
    private readonly blobs: BlobStore,
  ) {}

  async persistTrace(
    input: Parameters<TraceBlobPersistencePort["persistTrace"]>[0],
  ): Promise<TraceBlobPersistenceResult> {
    const operationId = normalizeOperationId(input.idempotencyKey);
    const scope = { tenantId: input.tenantId };
    const uploadId = `trace-${operationId}`;
    try {
      let snapshot = await this.repository.load(scope, operationId);
      if (snapshot === undefined) {
        try {
          await this.repository.create({
            operationId,
            scope,
            status: "upload_pending",
            version: 0,
            expectedPurpose: "trace",
            expectedSha256: input.sha256,
            expectedSize: input.body.byteLength,
          });
        } catch {
          // 并发 create 可能由另一执行者获胜；只允许从 PG 读回继续。
        }
        snapshot = await this.repository.load(scope, operationId);
        if (snapshot === undefined) return { outcome: "unknown" };
      }
      for (let step = 0; step < 32; step += 1) {
        if (!matchesTraceCommand(snapshot, input.tenantId, input.sha256, input.body.byteLength)) {
          return { outcome: "conflict" };
        }
        const result = await this.advance(snapshot, input.body, input.sha256, uploadId);
        if ("outcome" in result) return result;
        snapshot = result;
      }
      return { outcome: "unknown" };
    } catch (error) {
      return mapTraceFailure(error);
    }
  }

  private async advance(
    snapshot: BlobCommitSnapshot,
    body: Uint8Array,
    sha256: string,
    uploadId: string,
  ): Promise<BlobCommitSnapshot | TraceBlobPersistenceResult> {
    const scope = snapshot.scope;
    switch (snapshot.status) {
      case "upload_pending": {
        const staged = await this.blobs.putStaging({
          scope,
          purpose: "trace",
          uploadId,
          body,
          mediaType: "text/plain; charset=utf-8",
          expectedSha256: sha256,
          expectedSize: body.byteLength,
        });
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "stage_verified", staged }),
        );
      }
      case "staged":
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "reference_commit_started" }),
        );
      case "reference_commit_pending": {
        if (snapshot.staged === undefined) return { outcome: "conflict" };
        try {
          const reference = await this.repository.commitStagedReference({
            operationId: snapshot.operationId,
            scope,
            staged: snapshot.staged,
          });
          return await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, {
              type: "reference_commit_succeeded",
              referenceId: reference.referenceId,
            }),
          );
        } catch {
          return await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "reference_commit_result_unknown" }),
          );
        }
      }
      case "reference_commit_unknown": {
        const resolved = await this.repository.resolveReferenceCommit(scope, snapshot.operationId);
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, {
            type: "reference_commit_resolved",
            committed: resolved.status === "committed",
            ...(resolved.status === "committed" ? { referenceId: resolved.referenceId } : {}),
          }),
        );
      }
      case "reference_committed": {
        if (snapshot.staged === undefined || snapshot.referenceId === undefined)
          return { outcome: "conflict" };
        const allocation = await this.repository.reserve({
          scope,
          staged: snapshot.staged,
          operationId: snapshot.operationId,
          referenceId: snapshot.referenceId,
        });
        const stable: StableBlobRef = {
          kind: "stable",
          tenantId: allocation.tenantId,
          purpose: "trace",
          sha256: allocation.sha256,
          size: allocation.size,
          mediaType: snapshot.staged.mediaType,
          incarnationId: allocation.incarnationId,
          physicalObjectKey: allocation.physicalObjectKey,
        };
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "allocation_reserved", allocation, stable }),
        );
      }
      case "allocation_reserved": {
        if (snapshot.allocation === undefined) return { outcome: "conflict" };
        await this.repository.startPromotion({
          scope,
          operationId: snapshot.operationId,
          expectedSnapshotVersion: snapshot.version,
          allocationId: snapshot.allocation.allocationId,
        });
        return (await this.repository.load(scope, snapshot.operationId)) ?? { outcome: "unknown" };
      }
      case "promotion_started": {
        if (snapshot.staged === undefined || snapshot.promotionAuthorization === undefined)
          return { outcome: "conflict" };
        const stable = await this.blobs.promote(
          scope,
          snapshot.staged,
          snapshot.promotionAuthorization,
        );
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "promotion_succeeded", stable }),
        );
      }
      case "stable_object_ready": {
        if (snapshot.stable === undefined || snapshot.referenceId === undefined)
          return { outcome: "conflict" };
        const head = await this.blobs.head(scope, snapshot.stable);
        if (head === undefined) return { outcome: "unknown" };
        const marked = await this.repository.markReferenceStable({
          operationId: snapshot.operationId,
          scope,
          referenceId: snapshot.referenceId,
          stable: snapshot.stable,
        });
        return await this.cas(
          snapshot,
          transitionBlobCommit(
            snapshot,
            marked === "marked"
              ? { type: "stable_mark_succeeded" }
              : { type: "stable_mark_gc_blocked" },
          ),
        );
      }
      case "stable":
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "cleanup_requested", target: "staging" }),
        );
      case "completed":
        return completed(snapshot);
      case "stable_mark_unknown": {
        const status = await this.repository.resolveStableMark(scope, snapshot.operationId);
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "stable_mark_resolved", status }),
        );
      }
      case "cleanup_pending": {
        if (snapshot.staged === undefined) return { outcome: "conflict" };
        await this.blobs.deleteStaging(scope, snapshot.staged);
        return await this.cas(
          snapshot,
          transitionBlobCommit(snapshot, { type: "cleanup_succeeded", target: "staging" }),
        );
      }
      case "stable_mark_gc_blocked": {
        if (snapshot.stable === undefined) return { outcome: "conflict" };
        const lifecycle = await this.repository.resolveLifecycle({
          scope,
          blob: snapshot.stable,
        });
        if (lifecycle.status === "pre_delete" || lifecycle.status === "deleting") {
          // GC 状态是可重试的已知竞争，不可降级成 unknown。
          return { outcome: "unavailable" };
        }
        const event =
          lifecycle.status === "deleted"
            ? {
                type: "stable_gc_lifecycle_resolved" as const,
                status: "deleted" as const,
                retiredIncarnationId: lifecycle.retiredIncarnationId,
                retiredPhysicalObjectKey: lifecycle.retiredPhysicalObjectKey,
              }
            : {
                type: "stable_gc_lifecycle_resolved" as const,
                status: "active" as const,
              };
        return await this.cas(snapshot, transitionBlobCommit(snapshot, event));
      }
      case "abandoned":
        return { outcome: "unavailable" };
      default:
        return { outcome: "unknown" };
    }
  }

  private async cas(
    current: BlobCommitSnapshot,
    next: BlobCommitSnapshot,
  ): Promise<BlobCommitSnapshot> {
    if (
      await this.repository.compareAndSet({
        scope: current.scope,
        operationId: current.operationId,
        expectedVersion: current.version,
        next,
      })
    )
      return next;
    return (await this.repository.load(current.scope, current.operationId)) ?? current;
  }
}

function matchesTraceCommand(
  snapshot: BlobCommitSnapshot,
  tenantId: string,
  sha256: string,
  size: number,
): boolean {
  if (
    snapshot.scope.tenantId !== tenantId ||
    snapshot.expectedPurpose !== "trace" ||
    snapshot.expectedSha256 !== sha256 ||
    snapshot.expectedSize !== size
  )
    return false;
  for (const blob of [snapshot.staged, snapshot.stable]) {
    if (
      blob !== undefined &&
      (blob.tenantId !== tenantId ||
        blob.purpose !== "trace" ||
        blob.sha256 !== sha256 ||
        blob.size !== size)
    )
      return false;
  }
  const allocation = snapshot.allocation;
  return (
    allocation === undefined ||
    (allocation.tenantId === tenantId &&
      allocation.purpose === "trace" &&
      allocation.sha256 === sha256 &&
      allocation.size === size)
  );
}

function completed(snapshot: BlobCommitSnapshot): TraceBlobPersistenceResult {
  const blob = snapshot.stable;
  if (
    blob === undefined ||
    snapshot.referenceId === undefined ||
    blob.kind !== "stable" ||
    blob.purpose !== "trace"
  )
    return { outcome: "conflict" };
  const identity: StableTraceBlobIdentity = {
    kind: "stable",
    tenantId: blob.tenantId,
    purpose: "trace",
    sha256: blob.sha256,
    size: blob.size,
    incarnationId: blob.incarnationId,
    physicalObjectKey: blob.physicalObjectKey,
  };
  return {
    outcome: "persisted",
    referenceId: snapshot.referenceId,
    blob: identity,
  };
}

function normalizeOperationId(value: string): string {
  return `trace-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function mapTraceFailure(error: unknown): TraceBlobPersistenceResult {
  if (error instanceof BlobStoreError) {
    if (error.code === "BLOB_IDEMPOTENCY_CONFLICT" || error.code === "BLOB_PRECONDITION_FAILED")
      return { outcome: "conflict" };
    if (error.code === "BLOB_RESULT_UNKNOWN") return { outcome: "unknown" };
  }
  return { outcome: "unavailable" };
}

/** 受审生产装配：PG repository 同时承担 commit state、reference 与 lifecycle 端口。 */
export function createDurableTraceBlobPersistence(
  repository: TraceBlobCommitRepository,
  blobs: BlobStore,
): TraceBlobPersistencePort {
  return new DurableTraceBlobPersistenceAdapter(repository, blobs);
}
