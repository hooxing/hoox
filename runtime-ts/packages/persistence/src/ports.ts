import type {
  Membership,
  Run,
  RunPersonalizationSnapshot,
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
} from "@hoox/domain";
import type { ResourceAttachmentReference } from "@hoox/resource";
import type { ExplicitSkillInvocation } from "@hoox/skill";
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
  readonly phase?: "commentary" | "final_answer";
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
        readonly hasClientToolHistory?: boolean;
      }
    | { readonly outcome: "not_found" }
  >;
}

export interface ThreadContinuityStatusView {
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
  | {
      readonly outcome:
        | "key_conflict"
        | "parent_inactive"
        | "not_authorized"
        | "skill_not_available"
        | "agent_revision_unavailable";
    }
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
    readonly skillInvocation?: ExplicitSkillInvocation;
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
  | {
      readonly outcome:
        | "legacy_drain_required"
        | "skill_not_available"
        | "agent_revision_unavailable";
    };

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
    readonly origin?: "normal" | "api";
    /** 用于回放时以经过领域校验的父 Thread 重建 Run，不接受裸 threadId。 */
    readonly thread: Thread;
    /** 已由 API 按 UTF-8 字节上限验证，持久层仍必须以数据库约束兜底。 */
    readonly inputText: string;
    readonly skillInvocation?: ExplicitSkillInvocation;
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

export type RenamePersonalThreadResult =
  | { readonly outcome: "renamed"; readonly entity: Thread }
  | { readonly outcome: "not_authorized" | "not_found" };

/** 个人任务改名必须锁定 Membership→Thread，并把标题来源切换为 user 防止异步标题覆盖。 */
export interface RenamePersonalThreadCommandPort {
  renamePersonalThread(input: {
    readonly scope: TenantScope;
    readonly threadId: ThreadId;
    readonly title: string;
  }): Promise<RenamePersonalThreadResult>;
}

export interface TenantRepository {
  createPersonal(bundle: TenantBundle): Promise<CreateResult>;
  get(scope: TenantScope): Promise<TenantBundle | undefined>;
}

export interface TeamSummaryView {
  readonly id: TenantId;
  readonly displayName: string;
  readonly role: "owner" | "admin" | "member";
  readonly joinedAt: string;
}

export interface TeamMemberView {
  readonly membershipId: string;
  readonly userId: UserId;
  readonly role: "owner" | "admin" | "member";
  readonly joinedAt: string;
}

export interface PersonalPersonalizationView {
  readonly content: string;
  readonly applyToTeamTasks: boolean;
  readonly version: number;
  readonly updatedAt?: string;
}

export interface TeamPersonalizationView {
  readonly teamId: TenantId;
  readonly content: string;
  readonly version: number;
  readonly canEdit: boolean;
  readonly updatedAt?: string;
}

export type PersonalizationUpdateResult<T> =
  | { readonly outcome: "succeeded"; readonly value: T }
  | { readonly outcome: "conflict" | "not_found" | "not_authorized" };

export interface PersonalizationSettingsPort {
  getPersonal(input: { readonly scope: TenantScope }): Promise<PersonalPersonalizationView>;
  updatePersonal(input: {
    readonly scope: TenantScope;
    readonly content: string;
    readonly applyToTeamTasks: boolean;
    readonly expectedVersion: number;
  }): Promise<PersonalizationUpdateResult<PersonalPersonalizationView>>;
  getTeam(input: { readonly scope: TenantScope }): Promise<TeamPersonalizationView | undefined>;
  updateTeam(input: {
    readonly scope: TenantScope;
    readonly content: string;
    readonly expectedVersion: number;
  }): Promise<PersonalizationUpdateResult<TeamPersonalizationView>>;
}

/** Worker 只拿到当前用户与当前 Tenant 可见的合并快照，不能取得设置写能力。 */
export interface RunPersonalizationReadPort {
  resolveForRun(input: { readonly scope: TenantScope }): Promise<RunPersonalizationSnapshot>;
}

export type TeamMutationResult<T> =
  | { readonly outcome: "succeeded"; readonly value: T }
  | {
      readonly outcome:
        | "not_found"
        | "not_authorized"
        | "conflict"
        | "last_owner"
        | "user_not_found";
    };

/** 团队目录可跨 Tenant 枚举；具体读写仍在目标团队 Membership 与 RLS 下二次授权。 */
export interface TeamCollaborationPort {
  listForUser(input: { readonly scope: TenantScope }): Promise<readonly TeamSummaryView[]>;
  create(input: {
    readonly scope: TenantScope;
    readonly teamId: TenantId;
    readonly membershipId: Membership["id"];
    readonly displayName: string;
    readonly createdAt: string;
  }): Promise<TeamMutationResult<TeamSummaryView>>;
  listMembers(input: {
    readonly scope: TenantScope;
  }): Promise<readonly TeamMemberView[] | undefined>;
  addMember(input: {
    readonly scope: TenantScope;
    readonly targetUserId: UserId;
    readonly membershipId: Membership["id"];
    readonly role: "admin" | "member";
    readonly createdAt: string;
  }): Promise<TeamMutationResult<TeamMemberView>>;
  changeRole(input: {
    readonly scope: TenantScope;
    readonly targetUserId: UserId;
    readonly role: "owner" | "admin" | "member";
  }): Promise<TeamMutationResult<TeamMemberView>>;
  removeMember(input: {
    readonly scope: TenantScope;
    readonly targetUserId: UserId;
  }): Promise<TeamMutationResult<undefined>>;
  dissolve(input: { readonly scope: TenantScope }): Promise<TeamMutationResult<undefined>>;
}

export interface ForkedThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadForkPort {
  seed(input: {
    readonly scope: TenantScope;
    readonly childThreadId: ThreadId;
    readonly sourceTenantId: TenantId;
    readonly sourceThreadId: ThreadId;
    readonly kind: "branch" | "team_publish";
    readonly messages: readonly ForkedThreadMessage[];
    readonly hasClientToolHistory: boolean;
  }): Promise<"seeded" | "not_authorized" | "not_found" | "conflict">;
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
  /** 只提示重新读取；通知可重复或丢失，调用方必须保留定时补读与逐次授权。 */
  watchEvents?(
    input: { readonly scope: TenantScope; readonly runId: Run["id"] },
    wake: () => void,
  ): () => void;
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
  readonly resourceId?: string;
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
