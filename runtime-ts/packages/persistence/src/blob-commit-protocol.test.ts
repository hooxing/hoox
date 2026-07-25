import { describe, expect, it } from "vitest";
import {
  BlobCommitTransitionError,
  type BlobCommitSnapshot,
  type BlobCommitStatePort,
  type StableBlobRef,
  type StagedBlobRef,
  transitionBlobCommit,
} from "./index.js";

describe("Blob 补偿状态协议", () => {
  it("按 staging、业务引用、stable 和清理顺序完成", () => {
    let state = initialState();
    state = transitionBlobCommit(state, { type: "stage_verified", staged });
    state = transitionBlobCommit(state, { type: "reference_commit_started" });
    state = transitionBlobCommit(state, {
      type: "reference_commit_succeeded",
      referenceId: "ref-1",
    });
    state = transitionBlobCommit(state, { type: "promotion_succeeded", stable });
    state = transitionBlobCommit(state, { type: "stable_mark_succeeded" });
    state = transitionBlobCommit(state, { type: "cleanup_requested", target: "staging" });
    state = transitionBlobCommit(state, { type: "cleanup_succeeded", target: "staging" });

    expect(state).toMatchObject({ status: "completed", version: 7, referenceId: "ref-1" });
  });

  it("引用提交结果未知时必须先解析，不能直接复制", () => {
    let state = transitionBlobCommit(initialState(), { type: "stage_verified", staged });
    state = transitionBlobCommit(state, { type: "reference_commit_started" });
    state = transitionBlobCommit(state, { type: "reference_commit_result_unknown" });

    expect(() => transitionBlobCommit(state, { type: "promotion_succeeded", stable })).toThrow(
      BlobCommitTransitionError,
    );
    state = transitionBlobCommit(state, {
      type: "reference_commit_resolved",
      committed: true,
      referenceId: "ref-1",
    });
    expect(state.status).toBe("reference_committed");
  });

  it("确认引用没有提交后进入孤儿清理", () => {
    let state = transitionBlobCommit(initialState(), { type: "stage_verified", staged });
    state = transitionBlobCommit(state, { type: "reference_commit_started" });
    state = transitionBlobCommit(state, { type: "reference_commit_result_unknown" });
    state = transitionBlobCommit(state, { type: "reference_commit_resolved", committed: false });
    expect(state.status).toBe("cleanup_pending");
    state = transitionBlobCommit(state, { type: "cleanup_succeeded", target: "staging" });
    expect(state.status).toBe("abandoned");
  });

  it("stable 标记未知时保留对象与引用并等待解析", () => {
    let state = referenceCommittedState();
    state = transitionBlobCommit(state, { type: "promotion_succeeded", stable });
    state = transitionBlobCommit(state, { type: "stable_mark_result_unknown" });
    expect(state.status).toBe("stable_mark_unknown");
    expect(() =>
      transitionBlobCommit(state, { type: "cleanup_requested", target: "staging" }),
    ).toThrow(BlobCommitTransitionError);
    state = transitionBlobCommit(state, { type: "stable_mark_resolved", status: "marked" });
    expect(state.status).toBe("stable");
  });

  it("stable 正在被 GC claim 时记录阻塞且不新增引用", () => {
    let state = referenceCommittedState();
    state = transitionBlobCommit(state, { type: "promotion_succeeded", stable });
    const blocked = transitionBlobCommit(state, { type: "stable_mark_gc_blocked" });

    expect(blocked.status).toBe("stable_mark_gc_blocked");
    expect(blocked.version).toBe(state.version + 1);
    expect(blocked.referenceId).toBe("ref-1");
    expect(() => transitionBlobCommit(blocked, { type: "promotion_succeeded", stable })).toThrow(
      BlobCommitTransitionError,
    );
    expect(() => transitionBlobCommit(blocked, { type: "stable_mark_succeeded" })).toThrow(
      BlobCommitTransitionError,
    );
    const stillDeleting = transitionBlobCommit(blocked, {
      type: "stable_gc_lifecycle_resolved",
      status: "deleting",
    });
    expect(stillDeleting.status).toBe("stable_mark_gc_blocked");
    const deleted = transitionBlobCommit(stillDeleting, {
      type: "stable_gc_lifecycle_resolved",
      status: "deleted",
    });
    expect(deleted.status).toBe("reference_committed");
    expect(transitionBlobCommit(deleted, { type: "promotion_succeeded", stable }).status).toBe(
      "stable_object_ready",
    );

    const unknown = transitionBlobCommit(state, { type: "stable_mark_result_unknown" });
    const resolvedBlocked = transitionBlobCommit(unknown, {
      type: "stable_mark_resolved",
      status: "gc_in_progress",
    });
    expect(resolvedBlocked.status).toBe("stable_mark_gc_blocked");
  });

  it("拒绝把其他 Tenant 或不同内容的对象接入状态链", () => {
    const otherTenant = { ...staged, tenantId: "tenant_b" };
    expect(() =>
      transitionBlobCommit(initialState(), { type: "stage_verified", staged: otherTenant }),
    ).toThrow(BlobCommitTransitionError);

    const changedStable = { ...stable, sha256: "b".repeat(64) };
    expect(() =>
      transitionBlobCommit(referenceCommittedState(), {
        type: "promotion_succeeded",
        stable: changedStable,
      }),
    ).toThrow(BlobCommitTransitionError);
  });

  it("相同 operationId 在不同 Tenant 下互不覆盖", async () => {
    const port = new InMemoryCommitStatePort();
    const tenantA = initialState();
    const tenantB = { ...initialState(), scope: { tenantId: "tenant_b" } };
    await port.create(tenantA);
    await port.create(tenantB);

    await expect(port.load(tenantA.scope, tenantA.operationId)).resolves.toEqual(tenantA);
    await expect(port.load(tenantB.scope, tenantB.operationId)).resolves.toEqual(tenantB);
    await expect(port.load({ tenantId: "tenant_c" }, tenantA.operationId)).resolves.toBeUndefined();

    const tenantANext = transitionBlobCommit(tenantA, { type: "stage_verified", staged });
    await expect(
      port.compareAndSet({
        scope: tenantB.scope,
        operationId: tenantA.operationId,
        expectedVersion: tenantA.version,
        next: tenantANext,
      }),
    ).resolves.toBe(false);
    await expect(port.load(tenantA.scope, tenantA.operationId)).resolves.toEqual(tenantA);
    await expect(port.load(tenantB.scope, tenantB.operationId)).resolves.toEqual(tenantB);
  });
});

const staged: StagedBlobRef = {
  kind: "staging",
  tenantId: "tenant_a",
  purpose: "artifact",
  uploadId: "upload-1",
  sha256: "a".repeat(64),
  size: 4,
  mediaType: "text/plain",
};

const stable: StableBlobRef = {
  kind: "stable",
  tenantId: "tenant_a",
  purpose: "artifact",
  sha256: staged.sha256,
  size: staged.size,
  mediaType: staged.mediaType,
  incarnationId: "00000000-0000-4000-8000-000000000001",
  physicalObjectKey: `agent-runtime/stable/tenant_a/artifact/sha256/${staged.sha256}/incarnations/00000000-0000-4000-8000-000000000001`,
};

function initialState(): BlobCommitSnapshot {
  return {
    operationId: "operation-1",
    scope: { tenantId: "tenant_a" },
    status: "upload_pending",
    version: 0,
  };
}

function referenceCommittedState(): BlobCommitSnapshot {
  return {
    operationId: "operation-1",
    scope: { tenantId: "tenant_a" },
    status: "reference_committed",
    version: 3,
    staged,
    referenceId: "ref-1",
  };
}

class InMemoryCommitStatePort implements BlobCommitStatePort {
  private readonly tenants = new Map<string, Map<string, BlobCommitSnapshot>>();

  async load(
    scope: { readonly tenantId: string },
    operationId: string,
  ): Promise<BlobCommitSnapshot | undefined> {
    return this.tenants.get(scope.tenantId)?.get(operationId);
  }

  async create(snapshot: BlobCommitSnapshot): Promise<void> {
    const operations = this.tenants.get(snapshot.scope.tenantId) ?? new Map();
    if (operations.has(snapshot.operationId)) {
      throw new Error("联合唯一冲突");
    }
    operations.set(snapshot.operationId, snapshot);
    this.tenants.set(snapshot.scope.tenantId, operations);
  }

  async compareAndSet(input: {
    readonly scope: { readonly tenantId: string };
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly next: BlobCommitSnapshot;
  }): Promise<boolean> {
    const operations = this.tenants.get(input.scope.tenantId);
    const current = operations?.get(input.operationId);
    if (
      current === undefined ||
      current.version !== input.expectedVersion ||
      input.next.scope.tenantId !== input.scope.tenantId ||
      input.next.operationId !== input.operationId
    ) {
      return false;
    }
    operations?.set(input.operationId, input.next);
    return true;
  }
}
