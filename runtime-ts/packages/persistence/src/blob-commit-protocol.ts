import {
  type StableBlobRef,
  type StableBlobLifecycleAllocation,
  type PromotionAuthorizationRef,
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
  | "allocation_reserved"
  | "promotion_started"
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
  readonly allocation?: StableBlobLifecycleAllocation;
  readonly promotionAuthorization?: PromotionAuthorizationRef;
  readonly retiredIncarnationId?: string;
  readonly retiredPhysicalObjectKey?: string;
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
  | {
      readonly type: "allocation_reserved";
      readonly allocation: StableBlobLifecycleAllocation;
      readonly stable: StableBlobRef;
    }
  | {
      readonly type: "promotion_started";
      readonly authorization: PromotionAuthorizationRef;
    }
  | { readonly type: "promotion_succeeded"; readonly stable: StableBlobRef }
  | { readonly type: "promotion_failed" }
  | { readonly type: "promotion_result_unknown" }
  | { readonly type: "promotion_resolved"; readonly promoted: boolean }
  | { readonly type: "stable_mark_succeeded" }
  | { readonly type: "stable_mark_failed" }
  | { readonly type: "stable_mark_gc_blocked" }
  | {
      readonly type: "stable_gc_lifecycle_resolved";
      readonly status: "active" | "pre_delete" | "deleting";
    }
  | {
      readonly type: "stable_gc_lifecycle_resolved";
      readonly status: "deleted";
      readonly retiredIncarnationId: string;
      readonly retiredPhysicalObjectKey: string;
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
  /**
   * 数据库必须以 (tenant_id, operation_id) 建立联合唯一约束和查询条件。
   * `promotion_started` 的状态 CAS 与完整规范授权行必须在同一 PostgreSQL 事务中签发；
   * 仅预留 allocation、但尚未提交该事务的状态不能被 BlobStore 解析为授权。
   */
  load(scope: TenantBlobScope, operationId: string): Promise<BlobCommitSnapshot | undefined>;
  create(snapshot: BlobCommitSnapshot): Promise<void>;
  compareAndSet(input: {
    readonly scope: TenantBlobScope;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly next: BlobCommitSnapshot;
  }): Promise<boolean>;
  /**
   * 调用方只提供不含 mode/target/auth 的最小命令。Repository 必须在同一 PG 事务中读取
   * 当前 snapshot、allocation、lifecycle 与永久 retired 历史，自行派生 canonical target/auth，
   * 再 CAS 到 promotion_started。普通 compareAndSet 必须拒绝 next.status=promotion_started。
   */
  startPromotion(input: {
    readonly scope: TenantBlobScope;
    readonly operationId: string;
    readonly expectedSnapshotVersion: number;
    readonly allocationId: string;
  }): Promise<
    | {
        readonly status: "started";
        readonly authorization: PromotionAuthorizationRef;
        readonly snapshotVersion: number;
      }
    | { readonly status: "version_conflict" | "invalid_state" | "allocation_unavailable" }
  >;
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
      if (event.type === "allocation_reserved") {
        assertAllocationTarget(current, event.allocation, event.stable);
        return {
          ...base(current),
          status: "allocation_reserved",
          staged: requireStaged(current),
          stable: event.stable,
          allocation: event.allocation,
          referenceId: requireReferenceId(current),
          ...(current.retiredIncarnationId === undefined
            ? {}
            : {
                retiredIncarnationId: current.retiredIncarnationId,
                retiredPhysicalObjectKey: current.retiredPhysicalObjectKey,
              }),
        };
      }
      break;
    case "allocation_reserved":
      if (event.type === "promotion_started") {
        assertPromotionAuthorization(current, event.authorization);
        return copyPromotion(current, "promotion_started", event.authorization);
      }
      break;
    case "promotion_started":
      if (event.type === "promotion_succeeded") {
        assertStableEqualsTarget(current, event.stable);
        return copyPromotion(current, "stable_object_ready");
      }
      if (event.type === "promotion_result_unknown") {
        return copyPromotion(current, "promotion_unknown");
      }
      if (event.type === "promotion_failed") {
        return copyPromotion(current, "allocation_reserved", null);
      }
      break;
    case "promotion_unknown":
      if (event.type === "promotion_resolved") {
        return copyPromotion(
          current,
          event.promoted ? "stable_object_ready" : "allocation_reserved",
          event.promoted ? current.promotionAuthorization : null,
        );
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
          const stable = requireStable(current);
          if (
            event.retiredIncarnationId !== stable.incarnationId ||
            event.retiredPhysicalObjectKey !== stable.physicalObjectKey
          ) {
            throw new BlobCommitTransitionError("retired incarnation 与被 GC 阻塞的物理对象不一致");
          }
          // 旧 incarnation retired 后丢弃旧 target；必须先持久化新 allocation 才能再次 promote。
          return {
            ...base(current),
            status: "reference_committed",
            staged: requireStaged(current),
            referenceId: requireReferenceId(current),
            retiredIncarnationId: event.retiredIncarnationId,
            retiredPhysicalObjectKey: event.retiredPhysicalObjectKey,
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

function requireAllocation(current: BlobCommitSnapshot): StableBlobLifecycleAllocation {
  if (current.allocation === undefined) {
    throw new BlobCommitTransitionError("状态缺少 stable allocation");
  }
  return current.allocation;
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
    allocation: requireAllocation(current),
    ...(current.promotionAuthorization === undefined
      ? {}
      : { promotionAuthorization: current.promotionAuthorization }),
    referenceId: requireReferenceId(current),
  };
}

function copyPromotion(
  current: BlobCommitSnapshot,
  status: "allocation_reserved" | "promotion_started" | "promotion_unknown" | "stable_object_ready",
  authorization: PromotionAuthorizationRef | null | undefined = current.promotionAuthorization,
): Omit<BlobCommitSnapshot, "version"> {
  return {
    ...base(current),
    status,
    staged: requireStaged(current),
    stable: requireStable(current),
    allocation: requireAllocation(current),
    ...(authorization == null ? {} : { promotionAuthorization: authorization }),
    referenceId: requireReferenceId(current),
    ...(current.retiredIncarnationId === undefined
      ? {}
      : {
          retiredIncarnationId: current.retiredIncarnationId,
          retiredPhysicalObjectKey: current.retiredPhysicalObjectKey,
        }),
  };
}

function assertPromotionAuthorization(
  current: BlobCommitSnapshot,
  authorization: PromotionAuthorizationRef,
): void {
  if (
    authorization.tenantId !== current.scope.tenantId ||
    authorization.operationId !== current.operationId ||
    !UUID_V4_PATTERN.test(authorization.authorizationId)
  ) {
    throw new BlobCommitTransitionError("promotion 授权与 Tenant、operation 或授权格式不一致");
  }
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

function assertAllocationTarget(
  current: BlobCommitSnapshot,
  allocation: StableBlobLifecycleAllocation,
  stable: StableBlobRef,
): void {
  assertStableMatchesStaged(current, stable);
  const retired = current.retiredIncarnationId;
  if (
    !UUID_V4_PATTERN.test(allocation.lifecycleId) ||
    !UUID_V4_PATTERN.test(allocation.allocationId) ||
    !Number.isSafeInteger(allocation.generation) ||
    allocation.generation < 1 ||
    allocation.tenantId !== stable.tenantId ||
    allocation.purpose !== stable.purpose ||
    allocation.sha256 !== stable.sha256 ||
    allocation.size !== stable.size ||
    allocation.incarnationId !== stable.incarnationId ||
    allocation.physicalObjectKey !== stable.physicalObjectKey ||
    (allocation.mode !== "active_reuse" && allocation.mode !== "new_after_deleted") ||
    (retired !== undefined &&
      (allocation.incarnationId === retired ||
        allocation.physicalObjectKey === current.retiredPhysicalObjectKey))
  ) {
    throw new BlobCommitTransitionError(
      "allocation 与 stable target 或本 operation 的 retired target 不一致",
    );
  }
}

function assertStableEqualsTarget(current: BlobCommitSnapshot, stable: StableBlobRef): void {
  const target = requireStable(current);
  if (
    stable.tenantId !== target.tenantId ||
    stable.purpose !== target.purpose ||
    stable.sha256 !== target.sha256 ||
    stable.size !== target.size ||
    stable.incarnationId !== target.incarnationId ||
    stable.physicalObjectKey !== target.physicalObjectKey
  ) {
    throw new BlobCommitTransitionError("promotion 结果不是已持久化的精确物理 target");
  }
}

export function assertBlobOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(operationId)) {
    throw new BlobCommitTransitionError("operationId 格式无效");
  }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
