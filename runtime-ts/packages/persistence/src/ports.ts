import type {
  Membership,
  Run,
  Tenant,
  TenantId,
  Thread,
  ThreadId,
  User,
  UserId,
  Workspace,
  WorkspaceId,
  WorkspaceRevisionCommitPort,
  WorkspaceWriteScope,
} from "@cube-runtime/domain";
import type { ResourceAttachmentReference } from "@cube-runtime/resource";
import type { StableBlobRef } from "./blob-store.js";

/** 由认证/授权层构造；Repository 不接受裸 tenantId 作为业务查询上下文。 */
export interface TenantScope {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface TenantBundle {
  readonly user: User;
  readonly tenant: Tenant;
  readonly membership: Membership;
}

export interface Versioned<T> {
  readonly entity: T;
  readonly version: bigint;
}

export interface ThreadListCursor {
  readonly updatedAt: Thread["updatedAt"];
  readonly id: ThreadId;
}

export interface ThreadListPage {
  readonly items: readonly Versioned<Thread>[];
  readonly nextCursor?: ThreadListCursor;
}

export interface ThreadContextMessageView {
  readonly sequence: number;
  readonly runId?: string;
  readonly role: "user" | "assistant" | "runtime";
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadContextReadPort {
  listMessages(input: {
    readonly scope: TenantScope;
    readonly threadId: ThreadId;
    readonly after: number;
    readonly limit: number;
  }): Promise<
    | {
        readonly outcome: "found";
        readonly items: readonly ThreadContextMessageView[];
        readonly hasMore: boolean;
      }
    | { readonly outcome: "not_found" }
  >;
}

export interface ThreadContinuityStatusView {
  readonly boundary: "new_thread" | "legacy_anchor" | "manual" | "unmigrated";
  readonly readMode: "legacy" | "v2";
  readonly anchorState: "none" | "completed";
  readonly queueDepth: number;
  readonly contextSequence: number;
  readonly compactionWindow: number;
  readonly sandboxState?: "running" | "pausing" | "paused" | "resuming" | "terminated" | "unknown";
}

export interface ThreadContinuityReadPort {
  getStatus(input: {
    readonly scope: TenantScope;
    readonly threadId: ThreadId;
  }): Promise<
    | { readonly outcome: "found"; readonly status: ThreadContinuityStatusView }
    | { readonly outcome: "not_found" }
  >;
}

export type ThreadInputMode = "auto" | "steer" | "follow_up";
export type ThreadInputDisposition =
  | "pending_steer"
  | "steered"
  | "queued"
  | "cancelled"
  | "rejected";
export type ThreadInputRejectionCode =
  | "no_active_turn"
  | "expected_run_mismatch"
  | "expected_turn_mismatch"
  | "unsupported_phase"
  | "target_run_finished";

export interface ThreadInputReceiptEventView {
  readonly sequence: number;
  readonly kind: "accepted" | "disposition_changed";
  readonly disposition: ThreadInputDisposition;
  readonly targetRunId?: string;
  readonly targetTurnId?: string;
  readonly queuedRunId?: string;
  readonly queueSequence?: number;
  readonly rejectionCode?: ThreadInputRejectionCode;
  readonly createdAt: string;
}

export interface ThreadInputReceiptView {
  readonly receiptId: string;
  readonly inputSequence: number;
  readonly requestedMode: ThreadInputMode;
  readonly disposition: ThreadInputDisposition;
  readonly targetRunId?: string;
  readonly targetTurnId?: string;
  readonly queuedRunId?: string;
  readonly queueSequence?: number;
  readonly appliedContextSequence?: number;
  readonly rejectionCode?: ThreadInputRejectionCode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: readonly ThreadInputReceiptEventView[];
}

export type ThreadInputSubmitResult =
  | {
      readonly outcome: "accepted" | "replayed";
      readonly receipt: ThreadInputReceiptView;
      readonly queuedRun?: Run;
    }
  | { readonly outcome: "key_conflict" | "parent_inactive" | "not_authorized" }
  | { readonly outcome: "legacy_drain_required" };

/** 统一输入、receipt、可选 Run 与 FIFO item 必须在同一 Thread-head 事务中提交。 */
export interface ThreadInputRoutingPort {
  submit(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    /** 只在进入 follow-up（含 terminal fallback）时使用，不能提前创建。 */
    readonly fallbackRun: Run;
    readonly inputText: string;
    readonly attachments: readonly ResourceAttachmentReference[];
    readonly mode: ThreadInputMode;
    readonly expectedRunId?: string;
    readonly expectedTurnId?: string;
    readonly fallbackToFollowUp: boolean;
    readonly idempotency: IdempotentCommand;
  }): Promise<ThreadInputSubmitResult>;
  get(input: {
    readonly scope: TenantScope;
    readonly threadId: ThreadId;
    readonly receiptId: string;
  }): Promise<ThreadInputReceiptView | undefined>;
}

export type CreateResult = { readonly outcome: "created" } | { readonly outcome: "conflict" };

export type VersionedCreateResult =
  | { readonly outcome: "created"; readonly version: bigint }
  | { readonly outcome: "conflict" };

export type VersionedUpdateResult =
  | { readonly outcome: "updated"; readonly version: bigint }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "not_found" };

export interface IdempotentCommand {
  readonly key: string;
  readonly requestHash: string;
}

export type IdempotentCreateResult<T> =
  | { readonly outcome: "created" | "replayed"; readonly entity: T }
  | { readonly outcome: "key_conflict" }
  | { readonly outcome: "parent_inactive" }
  | { readonly outcome: "not_authorized" };

export type IdempotentRunEnqueueResult<T> =
  | IdempotentCreateResult<T>
  | { readonly outcome: "legacy_drain_required" };

/** Thread、空 Workspace、幂等记录和有效 Membership 重验必须共用事务。 */
export interface ThreadCreationPort {
  createThread(input: {
    readonly scope: TenantScope;
    /** 重放时必须从已验证的认证上下文重建领域实体，不能相信数据库裸文本。 */
    readonly tenant: Tenant;
    readonly user: User;
    readonly membership: Membership;
    readonly thread: Thread;
    readonly workspace: Workspace;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Thread>>;
}

/** Run、durable follow-up（或 legacy outbox）、幂等记录和 Membership 重验必须共用事务。 */
export interface EnqueueOutboxPort {
  /**
   * 在创建候选 Run 前按原始幂等键读回。父 Thread 可以已归档，但同键同载荷仍必须返回
   * 已提交的 Run；不同摘要只返回冲突，不泄漏任何其他用户或租户的记录。
   */
  replayQueuedRun(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentRunEnqueueResult<Run> | { readonly outcome: "not_found" }>;
  createQueuedRun(input: {
    readonly scope: TenantScope;
    readonly run: Run;
    /** 用于回放时以经过领域校验的父 Thread 重建 Run，不接受裸 threadId。 */
    readonly thread: Thread;
    /** 已由 API 按 UTF-8 字节上限验证，持久层仍必须以数据库约束兜底。 */
    readonly inputText: string;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentRunEnqueueResult<Run>>;
}

export type ArchiveThreadResult =
  | { readonly outcome: "archived" | "already_archived"; readonly entity: Thread }
  | { readonly outcome: "not_authorized" | "not_found" };

/** 归档必须在同一事务中锁定 Membership→Thread，再重验角色与 active 状态。 */
export interface ArchiveThreadCommandPort {
  archiveThread(input: {
    readonly scope: TenantScope;
    readonly threadId: ThreadId;
  }): Promise<ArchiveThreadResult>;
}

export interface TenantRepository {
  createPersonal(bundle: TenantBundle): Promise<CreateResult>;
  get(scope: TenantScope): Promise<TenantBundle | undefined>;
}

export interface ThreadRepository {
  create(scope: TenantScope, thread: Thread): Promise<VersionedCreateResult>;
  get(scope: TenantScope, id: ThreadId): Promise<Versioned<Thread> | undefined>;
  list(
    scope: TenantScope,
    input: { readonly limit: number; readonly cursor?: ThreadListCursor },
  ): Promise<ThreadListPage>;
  update(
    scope: TenantScope,
    thread: Thread,
    expectedVersion: bigint,
  ): Promise<VersionedUpdateResult>;
}

/**
 * Run 的领域状态与执行器恢复状态分层。该字段只在最新 Attempt 已持久化
 * recovery_required 时出现，不能据此改写 Domain Run 或伪造业务 failed。
 */
export interface RunReadSnapshot extends Versioned<Run> {
  readonly executionStatus?: "recovery_required";
}

export interface RunRepository {
  create(scope: TenantScope, run: Run): Promise<VersionedCreateResult>;
  get(scope: TenantScope, id: Run["id"]): Promise<RunReadSnapshot | undefined>;
  /** 返回一次读取快照中的最新窗口；排序固定为 updatedAt、createdAt、id 倒序。 */
  listByThread(
    scope: TenantScope,
    threadId: ThreadId,
    input: { readonly limit: number },
  ): Promise<readonly RunReadSnapshot[]>;
  update(scope: TenantScope, run: Run, expectedVersion: bigint): Promise<VersionedUpdateResult>;
}

export interface WorkspaceRepository extends WorkspaceRevisionCommitPort {
  create(scope: TenantScope, workspace: Workspace): Promise<CreateResult>;
  getById(scope: TenantScope, id: WorkspaceId): Promise<Workspace | undefined>;
  getByThread(scope: TenantScope, id: ThreadId): Promise<Workspace | undefined>;
}

export interface CoreRepositories {
  readonly tenants: TenantRepository;
  readonly threads: ThreadRepository;
  readonly runs: RunRepository;
  readonly workspaces: WorkspaceRepository;
}

/** 面向已认证用户的 Run 体验读取投影；实现必须在每次读取时重验 Membership。 */
export interface RunExperienceReadPort {
  listEvents(input: {
    readonly scope: TenantScope;
    readonly runId: Run["id"];
    readonly after: number;
    readonly limit: number;
  }): Promise<
    | {
        readonly outcome: "found";
        readonly attemptId?: string;
        readonly events: readonly {
          readonly sequence: number;
          readonly kind: string;
          readonly payload: Readonly<Record<string, unknown>>;
          readonly occurredAt: string;
        }[];
        /** true 表示同一 Attempt 仍有 sequence 大于本页末尾的事件。 */
        readonly hasMore: boolean;
      }
    | { readonly outcome: "not_found" }
  >;
  listArtifacts(input: { readonly scope: TenantScope; readonly runId: Run["id"] }): Promise<
    | {
        readonly outcome: "found";
        readonly artifacts: readonly RunExperienceArtifact[];
      }
    | { readonly outcome: "not_found" }
  >;
  getArtifact(input: {
    readonly scope: TenantScope;
    readonly runId: Run["id"];
    readonly artifactId: string;
  }): Promise<
    | { readonly outcome: "found"; readonly artifact: RunExperienceArtifact }
    | { readonly outcome: "not_found" }
  >;
}

/** 仅暴露已完成的用户交付物和它已固定的 stable Blob 身份。 */
export interface RunExperienceArtifact {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly runId: Run["id"];
  readonly threadId: ThreadId;
  readonly resourceVersionId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Membership 与发布终态的组合修订，用于预签名后的二次确认。 */
  readonly authorizationRevision: string;
  readonly blob: StableBlobRef;
}

export type { WorkspaceWriteScope };
