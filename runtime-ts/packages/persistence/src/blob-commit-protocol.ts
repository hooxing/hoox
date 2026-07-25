import {
  type StableBlobRef,
  type StagedBlobRef,
  type TenantBlobScope,
  assertBlobRef,
  assertTenantScope,
} from "./blob-store.js";

/**
 * 此状态必须持久化在 PostgreSQL。BlobStore 本身无法证明业务引用已经提交，
 * 因此稳定对象和 staging 清理都只能由持有该状态的协调器驱动。
 */
export type BlobCommitStatus =
  | "upload_pending"
  | "staged"
  | "reference_commit_pending"
  | "reference_commit_unknown"
  | "reference_committed"
  | "promotion_unknown"
  | "stable_object_ready"
  | "stable_mark_gc_blocked"
  | "stable_mark_unknown"
  | "stable"
  | "cleanup_pending"
  | "completed"
  | "abandoned";

export interface BlobCommitSnapshot {
  readonly operationId: string;
  readonly scope: TenantBlobScope;
  readonly status: BlobCommitStatus;
  readonly version: number;
  readonly staged?: StagedBlobRef;
  readonly stable?: StableBlobRef;
  readonly referenceId?: string;
  readonly cleanupTarget?: "staging";
}

export type BlobCommitEvent =
  | { readonly type: "stage_verified"; readonly staged: StagedBlobRef }
  | { readonly type: "reference_commit_started" }
  | { readonly type: "reference_commit_succeeded"; readonly referenceId: string }
  | { readonly type: "reference_commit_failed" }
  | { readonly type: "reference_commit_result_unknown" }
  | {
      readonly type: "reference_commit_resolved";
      readonly committed: boolean;
      readonly referenceId?: string;
    }
  | { readonly type: "promotion_succeeded"; readonly stable: StableBlobRef }
  | { readonly type: "promotion_failed" }
  | { readonly type: "promotion_result_unknown" }
  | { readonly type: "promotion_resolved"; readonly stable?: StableBlobRef }
  | { readonly type: "stable_mark_succeeded" }
  | { readonly type: "stable_mark_failed" }
  | { readonly type: "stable_mark_gc_blocked" }
  | {
      readonly type: "stable_gc_lifecycle_resolved";
      readonly status: "active" | "pre_delete" | "deleting" | "deleted";
    }
  | { readonly type: "stable_mark_result_unknown" }
  | {
      readonly type: "stable_mark_resolved";
      readonly status: "marked" | "not_marked" | "gc_in_progress";
    }
  | { readonly type: "cleanup_requested"; readonly target: "staging" }
  | { readonly type: "cleanup_succeeded"; readonly target: "staging" };

export class BlobCommitTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobCommitTransitionError";
  }
}

export interface BlobReferenceCommitPort {
  /** operationId 是幂等键；超时不能被调用方当成未提交。 */
  commitStagedReference(input: {
    readonly operationId: string;
    readonly scope: TenantBlobScope;
    readonly staged: StagedBlobRef;
  }): Promise<{ readonly referenceId: string }>;

  resolveReferenceCommit(
    scope: TenantBlobScope,
    operationId: string,
  ): Promise<
    { readonly status: "committed"; readonly referenceId: string } | { readonly status: "absent" }
  >;

  /**
   * 只有 stable 对象经 HEAD 校验后才能切换引用。实现必须在 PG 事务中读取 stable
   * 生命周期行；若 GC 已 claim 为 deleting，必须返回 gc_in_progress，不能新增引用。
   * 若生命周期为 deleted，只有 stable 已重新 promote 且 HEAD 验证后，才能原子恢复 active 并新增引用。
   */
  markReferenceStable(input: {
    readonly operationId: string;
    readonly scope: TenantBlobScope;
    readonly referenceId: string;
    readonly stable: StableBlobRef;
  }): Promise<"marked" | "gc_in_progress">;

  resolveStableMark(
    scope: TenantBlobScope,
    operationId: string,
  ): Promise<"marked" | "not_marked" | "gc_in_progress">;
}

export interface BlobCommitStatePort {
  /** 数据库必须以 (tenant_id, operation_id) 建立联合唯一约束和查询条件。 */
  load(scope: TenantBlobScope, operationId: string): Promise<BlobCommitSnapshot | undefined>;
  create(snapshot: BlobCommitSnapshot): Promise<void>;
  compareAndSet(input: {
    readonly scope: TenantBlobScope;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly next: BlobCommitSnapshot;
  }): Promise<boolean>;
}

export function transitionBlobCommit(
  current: BlobCommitSnapshot,
  event: BlobCommitEvent,
): BlobCommitSnapshot {
  assertBlobOperationId(current.operationId);
  assertTenantScope(current.scope);
  const next = applyTransition(current, event);
  return { ...next, version: current.version + 1 };
}

function applyTransition(
  current: BlobCommitSnapshot,
  event: BlobCommitEvent,
): Omit<BlobCommitSnapshot, "version"> {
  switch (current.status) {
    case "upload_pending":
      if (event.type === "stage_verified") {
        assertStagedMatchesScope(current, event.staged);
        return { ...base(current), status: "staged", staged: event.staged };
      }
      break;
    case "staged":
      if (event.type === "reference_commit_started") {
        return {
          ...base(current),
          status: "reference_commit_pending",
          staged: requireStaged(current),
        };
      }
      if (event.type === "cleanup_requested" && event.target === "staging") {
        return {
          ...base(current),
          status: "cleanup_pending",
          staged: requireStaged(current),
          cleanupTarget: "staging",
        };
      }
      break;
    case "reference_commit_pending":
      if (event.type === "reference_commit_succeeded") {
        return {
          ...base(current),
          status: "reference_committed",
          staged: requireStaged(current),
          referenceId: event.referenceId,
        };
      }
      if (event.type === "reference_commit_result_unknown") {
        return {
          ...base(current),
          status: "reference_commit_unknown",
          staged: requireStaged(current),
        };
      }
      if (event.type === "reference_commit_failed") {
        return {
          ...base(current),
          status: "cleanup_pending",
          staged: requireStaged(current),
          cleanupTarget: "staging",
        };
      }
      break;
    case "reference_commit_unknown":
      if (event.type === "reference_commit_resolved") {
        if (event.committed && event.referenceId !== undefined) {
          return {
            ...base(current),
            status: "reference_committed",
            staged: requireStaged(current),
            referenceId: event.referenceId,
          };
        }
        if (!event.committed) {
          return {
            ...base(current),
            status: "cleanup_pending",
            staged: requireStaged(current),
            cleanupTarget: "staging",
          };
        }
      }
      break;
    case "reference_committed":
      if (event.type === "promotion_succeeded") {
        assertStableMatchesStaged(current, event.stable);
        return {
          ...base(current),
          status: "stable_object_ready",
          staged: requireStaged(current),
          stable: event.stable,
          referenceId: requireReferenceId(current),
        };
      }
      if (event.type === "promotion_result_unknown") {
        return {
          ...base(current),
          status: "promotion_unknown",
          staged: requireStaged(current),
          referenceId: requireReferenceId(current),
        };
      }
      if (event.type === "promotion_failed") {
        // 明确失败可以安全重试复制；业务引用已经提交，不能退回并清理 staging。
        return {
          ...base(current),
          status: "reference_committed",
          staged: requireStaged(current),
          referenceId: requireReferenceId(current),
        };
      }
      break;
    case "promotion_unknown":
      if (event.type === "promotion_resolved") {
        if (event.stable !== undefined) {
          assertStableMatchesStaged(current, event.stable);
        }
        return event.stable === undefined
          ? {
              ...base(current),
              status: "reference_committed",
              staged: requireStaged(current),
              referenceId: requireReferenceId(current),
            }
          : {
              ...base(current),
              status: "stable_object_ready",
              staged: requireStaged(current),
              stable: event.stable,
              referenceId: requireReferenceId(current),
            };
      }
      break;
    case "stable_object_ready":
      if (event.type === "stable_mark_succeeded") {
        return copyStable(current, "stable");
      }
      if (event.type === "stable_mark_gc_blocked") {
        // GC 的 deleting claim 会阻止新增引用；保留独立状态供恢复扫描识别。
        return copyStable(current, "stable_mark_gc_blocked");
      }
      if (event.type === "stable_mark_result_unknown") {
        return copyStable(current, "stable_mark_unknown");
      }
      if (event.type === "stable_mark_failed") {
        return copyStable(current, "stable_object_ready");
      }
      break;
    case "stable_mark_gc_blocked":
      if (event.type === "stable_gc_lifecycle_resolved") {
        if (event.status === "active") {
          return copyStable(current, "stable_object_ready");
        }
        if (event.status === "deleted") {
          // 只有明确 deleted 才允许退回复制步骤；staging 在 stable 标记成功前始终保留。
          return {
            ...base(current),
            status: "reference_committed",
            staged: requireStaged(current),
            referenceId: requireReferenceId(current),
          };
        }
        return copyStable(current, "stable_mark_gc_blocked");
      }
      break;
    case "stable_mark_unknown":
      if (event.type === "stable_mark_resolved") {
        return copyStable(
          current,
          event.status === "marked"
            ? "stable"
            : event.status === "gc_in_progress"
              ? "stable_mark_gc_blocked"
              : "stable_object_ready",
        );
      }
      break;
    case "stable":
      if (event.type === "cleanup_requested" && event.target === "staging") {
        return { ...copyStable(current, "cleanup_pending"), cleanupTarget: "staging" };
      }
      break;
    case "cleanup_pending":
      if (
        event.type === "cleanup_succeeded" &&
        event.target === "staging" &&
        current.cleanupTarget === "staging"
      ) {
        return current.stable === undefined
          ? { ...base(current), status: "abandoned" }
          : copyStable(current, "completed");
      }
      break;
    case "completed":
    case "abandoned":
      break;
  }
  throw new BlobCommitTransitionError(`不允许从 ${current.status} 应用事件 ${event.type}`);
}

function base(current: BlobCommitSnapshot): Pick<BlobCommitSnapshot, "operationId" | "scope"> {
  return { operationId: current.operationId, scope: current.scope };
}

function requireStaged(current: BlobCommitSnapshot): StagedBlobRef {
  if (current.staged === undefined) {
    throw new BlobCommitTransitionError("状态缺少 staging 引用");
  }
  return current.staged;
}

function requireStable(current: BlobCommitSnapshot): StableBlobRef {
  if (current.stable === undefined) {
    throw new BlobCommitTransitionError("状态缺少 stable 引用");
  }
  return current.stable;
}

function requireReferenceId(current: BlobCommitSnapshot): string {
  if (current.referenceId === undefined) {
    throw new BlobCommitTransitionError("状态缺少业务引用 ID");
  }
  return current.referenceId;
}

function copyStable(
  current: BlobCommitSnapshot,
  status:
    | "stable_object_ready"
    | "stable_mark_gc_blocked"
    | "stable_mark_unknown"
    | "stable"
    | "cleanup_pending"
    | "completed",
): Omit<BlobCommitSnapshot, "version"> {
  return {
    ...base(current),
    status,
    staged: requireStaged(current),
    stable: requireStable(current),
    referenceId: requireReferenceId(current),
  };
}

function assertStagedMatchesScope(current: BlobCommitSnapshot, staged: StagedBlobRef): void {
  try {
    assertBlobRef(current.scope, staged);
  } catch (error) {
    throw new BlobCommitTransitionError(
      `staging 引用与协调状态不一致：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}

function assertStableMatchesStaged(current: BlobCommitSnapshot, stable: StableBlobRef): void {
  const staged = requireStaged(current);
  try {
    assertBlobRef(current.scope, stable);
  } catch (error) {
    throw new BlobCommitTransitionError(
      `stable 引用与协调状态不一致：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
  if (
    stable.tenantId !== staged.tenantId ||
    stable.purpose !== staged.purpose ||
    stable.sha256 !== staged.sha256 ||
    stable.size !== staged.size ||
    stable.mediaType !== staged.mediaType
  ) {
    throw new BlobCommitTransitionError("stable 引用与 staging 内容描述不一致");
  }
}

export function assertBlobOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(operationId)) {
    throw new BlobCommitTransitionError("operationId 格式无效");
  }
}
