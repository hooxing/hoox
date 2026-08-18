import { createHash } from "node:crypto";
import {
  type WorkspaceCandidateBlob,
  type WorkspaceCandidateBlobWritePort,
  type WorkspaceCandidateIdentity,
  WorkspaceDependencyError,
} from "@hoox/workspace";
import {
  type BlobCommitSnapshot,
  type BlobCommitStatePort,
  type BlobReferenceCommitPort,
  transitionBlobCommit,
} from "./blob-commit-protocol.js";
import {
  type BlobStore,
  BlobStoreError,
  type StableBlobGcClaimPort,
  type StableBlobLifecycleAllocationPort,
  type StableBlobRef,
} from "./blob-store.js";

export type WorkspaceBlobCommitRepository = BlobCommitStatePort &
  BlobReferenceCommitPort &
  StableBlobLifecycleAllocationPort &
  Pick<StableBlobGcClaimPort, "resolveLifecycle"> & {
    markWorkspaceCandidateReferenceStable(input: {
      readonly operationId: string;
      readonly scope: { readonly tenantId: string };
      readonly referenceId: string;
      readonly stable: StableBlobRef;
      readonly candidate: WorkspaceCandidateIdentity;
      readonly relativePath: string;
    }): Promise<"marked" | "gc_in_progress">;
  };

/**
 * 逐文件 Workspace 上传必须走与 Trace 相同的 Blob lifecycle 状态机；这里仅把受控字节流
 * 转成 workspace purpose 的 stable incarnation，绝不返回或持久化裸 objectKey。
 */
export class DurableWorkspaceCandidateBlobWriter implements WorkspaceCandidateBlobWritePort {
  constructor(
    private readonly repository: WorkspaceBlobCommitRepository,
    private readonly blobs: BlobStore,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new TypeError("Workspace Blob 配额无效");
  }

  async putCandidate(
    input: Parameters<WorkspaceCandidateBlobWritePort["putCandidate"]>[0],
  ): Promise<WorkspaceCandidateBlob> {
    if (input.candidate === undefined) throw unavailable("WORKSPACE_CANDIDATE_IDENTITY_REQUIRED");
    const body = await collectExact(
      input.body,
      input.expectedContent.sha256,
      input.expectedContent.size,
      this.maxBytes,
    );
    const operationId = `workspace-${digestKey(input.operationKey)}`;
    const uploadId = `workspace-${digestKey(`${input.operationKey}\0${input.relativePath}`)}`;
    const scope = { tenantId: input.scope.tenantId };
    try {
      let snapshot = await this.repository.load(scope, operationId);
      if (snapshot === undefined) {
        await this.repository
          .create({
            operationId,
            scope,
            status: "upload_pending",
            version: 0,
            expectedPurpose: "workspace",
            expectedSha256: input.expectedContent.sha256,
            expectedSize: input.expectedContent.size,
          })
          .catch(() => undefined);
        snapshot = await this.repository.load(scope, operationId);
      }
      if (snapshot === undefined) throw unavailable("BLOB_COMMIT_ABSENT");
      for (let step = 0; step < 32; step += 1) {
        if (
          !matches(
            snapshot,
            input.scope.tenantId,
            input.expectedContent.sha256,
            input.expectedContent.size,
          )
        ) {
          throw unavailable("BLOB_COMMIT_CONFLICT");
        }
        const next = await this.advance(
          snapshot,
          body,
          uploadId,
          input.candidate,
          input.relativePath,
        );
        if (next.kind === "done") return next.blob;
        snapshot = next.snapshot;
      }
      throw unknown("BLOB_COMMIT_STALLED");
    } catch (error) {
      if (error instanceof WorkspaceDependencyError) throw error;
      if (error instanceof BlobStoreError) {
        throw new WorkspaceDependencyError(
          error.result === "unknown" ? "unknown" : "known",
          error.code,
        );
      }
      throw unavailable("BLOB_DEPENDENCY_FAILED");
    }
  }

  async headCandidate(input: Parameters<WorkspaceCandidateBlobWritePort["headCandidate"]>[0]) {
    const stable = stableFor(input.blob, "application/octet-stream");
    try {
      const result = await this.blobs.head({ tenantId: input.scope.tenantId }, stable);
      return result === undefined
        ? ({ status: "not_found" } as const)
        : ({ status: "exists", blob: input.blob } as const);
    } catch (error) {
      if (error instanceof BlobStoreError) {
        throw new WorkspaceDependencyError(
          error.result === "unknown" ? "unknown" : "known",
          error.code,
        );
      }
      throw unavailable("BLOB_HEAD_FAILED");
    }
  }

  private async advance(
    snapshot: BlobCommitSnapshot,
    body: Uint8Array,
    uploadId: string,
    candidate?: WorkspaceCandidateIdentity,
    relativePath?: string,
  ): Promise<
    | { readonly kind: "next"; readonly snapshot: BlobCommitSnapshot }
    | { readonly kind: "done"; readonly blob: WorkspaceCandidateBlob }
  > {
    const scope = snapshot.scope;
    switch (snapshot.status) {
      case "upload_pending": {
        const staged = await this.blobs.putStaging({
          scope,
          purpose: "workspace",
          uploadId,
          body,
          mediaType: "application/octet-stream",
          ...(snapshot.expectedSha256 === undefined
            ? {}
            : { expectedSha256: snapshot.expectedSha256 }),
          ...(snapshot.expectedSize === undefined ? {} : { expectedSize: snapshot.expectedSize }),
        });
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "stage_verified", staged }),
          ),
        );
      }
      case "staged":
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "reference_commit_started" }),
          ),
        );
      case "reference_commit_pending": {
        if (snapshot.staged === undefined) throw unavailable("BLOB_COMMIT_INVALID");
        try {
          const reference = await this.repository.commitStagedReference({
            operationId: snapshot.operationId,
            scope,
            staged: snapshot.staged,
          });
          return next(
            await this.cas(
              snapshot,
              transitionBlobCommit(snapshot, {
                type: "reference_commit_succeeded",
                referenceId: reference.referenceId,
              }),
            ),
          );
        } catch {
          return next(
            await this.cas(
              snapshot,
              transitionBlobCommit(snapshot, { type: "reference_commit_result_unknown" }),
            ),
          );
        }
      }
      case "reference_commit_unknown": {
        const resolved = await this.repository.resolveReferenceCommit(scope, snapshot.operationId);
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, {
              type: "reference_commit_resolved",
              committed: resolved.status === "committed",
              ...(resolved.status === "committed" ? { referenceId: resolved.referenceId } : {}),
            }),
          ),
        );
      }
      case "reference_committed": {
        if (snapshot.staged === undefined || snapshot.referenceId === undefined)
          throw unavailable("BLOB_COMMIT_INVALID");
        const allocation = await this.repository.reserve({
          scope,
          staged: snapshot.staged,
          operationId: snapshot.operationId,
          referenceId: snapshot.referenceId,
        });
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, {
              type: "allocation_reserved",
              allocation,
              stable: {
                kind: "stable",
                tenantId: allocation.tenantId,
                purpose: "workspace",
                sha256: allocation.sha256,
                size: allocation.size,
                mediaType: snapshot.staged.mediaType,
                incarnationId: allocation.incarnationId,
                physicalObjectKey: allocation.physicalObjectKey,
              },
            }),
          ),
        );
      }
      case "allocation_reserved": {
        if (snapshot.allocation === undefined) throw unavailable("BLOB_COMMIT_INVALID");
        await this.repository.startPromotion({
          scope,
          operationId: snapshot.operationId,
          expectedSnapshotVersion: snapshot.version,
          allocationId: snapshot.allocation.allocationId,
        });
        const reloaded = await this.repository.load(scope, snapshot.operationId);
        if (reloaded === undefined) throw unknown("BLOB_PROMOTION_UNKNOWN");
        return next(reloaded);
      }
      case "promotion_started": {
        if (snapshot.staged === undefined || snapshot.promotionAuthorization === undefined)
          throw unavailable("BLOB_COMMIT_INVALID");
        const stable = await this.blobs.promote(
          scope,
          snapshot.staged,
          snapshot.promotionAuthorization,
        );
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "promotion_succeeded", stable }),
          ),
        );
      }
      case "stable_object_ready": {
        if (snapshot.stable === undefined || snapshot.referenceId === undefined)
          throw unavailable("BLOB_COMMIT_INVALID");
        const head = await this.blobs.head(scope, snapshot.stable);
        if (head === undefined) throw unknown("BLOB_STABLE_HEAD_UNKNOWN");
        if (candidate === undefined || relativePath === undefined)
          throw unavailable("WORKSPACE_CANDIDATE_IDENTITY_REQUIRED");
        const marked = await this.repository.markWorkspaceCandidateReferenceStable({
          operationId: snapshot.operationId,
          scope,
          referenceId: snapshot.referenceId,
          stable: snapshot.stable,
          candidate,
          relativePath,
        });
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(
              snapshot,
              marked === "marked"
                ? { type: "stable_mark_succeeded" }
                : { type: "stable_mark_gc_blocked" },
            ),
          ),
        );
      }
      case "stable":
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "cleanup_requested", target: "staging" }),
          ),
        );
      case "cleanup_pending": {
        if (snapshot.staged === undefined) throw unavailable("BLOB_COMMIT_INVALID");
        await this.blobs.deleteStaging(scope, snapshot.staged);
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "cleanup_succeeded", target: "staging" }),
          ),
        );
      }
      case "completed": {
        if (
          snapshot.stable === undefined ||
          snapshot.stable.purpose !== "workspace" ||
          snapshot.referenceId === undefined
        )
          throw unavailable("BLOB_COMMIT_INVALID");
        return {
          kind: "done",
          blob: Object.freeze({
            content: Object.freeze({ sha256: snapshot.stable.sha256, size: snapshot.stable.size }),
            object: Object.freeze({
              tenantId: snapshot.stable.tenantId,
              purpose: "workspace",
              incarnationId: snapshot.stable.incarnationId,
              physicalObjectKey: snapshot.stable.physicalObjectKey,
            }),
            referenceId: snapshot.referenceId,
          }),
        };
      }
      case "stable_mark_unknown": {
        const status = await this.repository.resolveStableMark(scope, snapshot.operationId);
        return next(
          await this.cas(
            snapshot,
            transitionBlobCommit(snapshot, { type: "stable_mark_resolved", status }),
          ),
        );
      }
      case "stable_mark_gc_blocked": {
        if (snapshot.stable === undefined) throw unavailable("BLOB_COMMIT_INVALID");
        // GC 租约可能已经释放、进入 deleting 或完成删除。每次恢复都从生命周期事实收敛：
        // active 回到 mark，deleted 重新 reserve 新 incarnation，仍在删除则保留阻塞状态。
        const lifecycle = await this.repository.resolveLifecycle({
          scope,
          blob: snapshot.stable,
        });
        if (lifecycle.status === "pre_delete" || lifecycle.status === "deleting") {
          // GC 尚持有租约时结果确定为“稍后重试”，不能靠 32 次本地空转把它误报为 unknown。
          throw unavailable("BLOB_GC_IN_PROGRESS");
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
        return next(await this.cas(snapshot, transitionBlobCommit(snapshot, event)));
      }
      default:
        throw unknown("BLOB_COMMIT_UNKNOWN");
    }
  }

  private async cas(
    current: BlobCommitSnapshot,
    nextSnapshot: BlobCommitSnapshot,
  ): Promise<BlobCommitSnapshot> {
    if (
      await this.repository.compareAndSet({
        scope: current.scope,
        operationId: current.operationId,
        expectedVersion: current.version,
        next: nextSnapshot,
      })
    )
      return nextSnapshot;
    return (await this.repository.load(current.scope, current.operationId)) ?? current;
  }
}

function next(snapshot: BlobCommitSnapshot) {
  return { kind: "next" as const, snapshot };
}

async function collectExact(
  source: AsyncIterable<Uint8Array>,
  sha256: string,
  expectedSize: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const hash = createHash("sha256");
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array) || size > maxBytes - chunk.byteLength) {
      throw unavailable("WORKSPACE_BLOB_SIZE_INVALID");
    }
    size += chunk.byteLength;
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (size !== expectedSize || hash.digest("hex") !== sha256)
    throw unavailable("WORKSPACE_BLOB_INTEGRITY_MISMATCH");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function stableFor(blob: WorkspaceCandidateBlob, mediaType: string): StableBlobRef {
  return {
    kind: "stable",
    tenantId: blob.object.tenantId,
    purpose: "workspace",
    sha256: blob.content.sha256,
    size: blob.content.size,
    mediaType,
    incarnationId: blob.object.incarnationId,
    physicalObjectKey: blob.object.physicalObjectKey,
  };
}

function matches(
  snapshot: BlobCommitSnapshot,
  tenantId: string,
  sha256: string,
  size: number,
): boolean {
  return (
    snapshot.scope.tenantId === tenantId &&
    snapshot.expectedPurpose === "workspace" &&
    snapshot.expectedSha256 === sha256 &&
    snapshot.expectedSize === size
  );
}

function digestKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unavailable(code: string): WorkspaceDependencyError {
  return new WorkspaceDependencyError("known", code);
}

function unknown(code: string): WorkspaceDependencyError {
  return new WorkspaceDependencyError("unknown", code);
}
