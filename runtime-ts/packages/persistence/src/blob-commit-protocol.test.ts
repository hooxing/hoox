import { describe, expect, it } from "vitest";
import {
  BlobCommitTransitionError,
  type BlobCommitSnapshot,
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
    state = transitionBlobCommit(state, { type: "cleanup_requested" });
    state = transitionBlobCommit(state, { type: "cleanup_succeeded" });

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
    state = transitionBlobCommit(state, { type: "cleanup_succeeded" });
    expect(state.status).toBe("abandoned");
  });

  it("stable 标记未知时保留对象与引用并等待解析", () => {
    let state = referenceCommittedState();
    state = transitionBlobCommit(state, { type: "promotion_succeeded", stable });
    state = transitionBlobCommit(state, { type: "stable_mark_result_unknown" });
    expect(state.status).toBe("stable_mark_unknown");
    expect(() => transitionBlobCommit(state, { type: "cleanup_requested" })).toThrow(
      BlobCommitTransitionError,
    );
    state = transitionBlobCommit(state, { type: "stable_mark_resolved", marked: true });
    expect(state.status).toBe("stable");
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
