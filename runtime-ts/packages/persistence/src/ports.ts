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

/** queued Run、enqueue outbox、幂等记录和有效 Membership 重验必须共用事务。 */
export interface EnqueueOutboxPort {
  /**
   * 在创建候选 Run 前按原始幂等键读回。父 Thread 可以已归档，但同键同载荷仍必须返回
   * 已提交的 Run；不同摘要只返回冲突，不泄漏任何其他用户或租户的记录。
   */
  replayQueuedRun(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Run> | { readonly outcome: "not_found" }>;
  createQueuedRun(input: {
    readonly scope: TenantScope;
    readonly run: Run;
    /** 用于回放时以经过领域校验的父 Thread 重建 Run，不接受裸 threadId。 */
    readonly thread: Thread;
    /** 已由 API 按 UTF-8 字节上限验证，持久层仍必须以数据库约束兜底。 */
    readonly inputText: string;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Run>>;
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

export interface RunRepository {
  create(scope: TenantScope, run: Run): Promise<VersionedCreateResult>;
  get(scope: TenantScope, id: Run["id"]): Promise<Versioned<Run> | undefined>;
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

export type { WorkspaceWriteScope };
