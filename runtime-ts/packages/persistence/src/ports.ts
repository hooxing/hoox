import type {
  IsoTimestamp,
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

export type CreateResult = { readonly outcome: "created" } | { readonly outcome: "conflict" };

export type UpdateResult =
  | { readonly outcome: "updated" }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "not_found" };

export interface TenantRepository {
  createPersonal(bundle: TenantBundle): Promise<CreateResult>;
  get(scope: TenantScope): Promise<TenantBundle | undefined>;
}

export interface ThreadRepository {
  create(scope: TenantScope, thread: Thread): Promise<CreateResult>;
  get(scope: TenantScope, id: ThreadId): Promise<Thread | undefined>;
  update(
    scope: TenantScope,
    thread: Thread,
    expectedUpdatedAt: IsoTimestamp,
  ): Promise<UpdateResult>;
}

export interface RunRepository {
  create(scope: TenantScope, run: Run): Promise<CreateResult>;
  get(scope: TenantScope, id: Run["id"]): Promise<Run | undefined>;
  update(scope: TenantScope, run: Run, expectedUpdatedAt: IsoTimestamp): Promise<UpdateResult>;
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
