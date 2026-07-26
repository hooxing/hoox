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
