import type {
  Run,
  Thread,
  Workspace,
  WorkspaceCommitResult,
  WorkspaceRevisionCommit,
} from "@cube-runtime/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type {
  CoreRepositories,
  CreateResult,
  RunRepository,
  TenantBundle,
  TenantRepository,
  TenantScope,
  ThreadRepository,
  UpdateResult,
  WorkspaceRepository,
} from "./ports.js";
import { withTransaction } from "./postgres.js";
import { mapRun, mapTenantBundle, mapThread, mapWorkspace } from "./row-mappers.js";

const tenantColumns = `
  t.id AS tenant_id, t.kind AS tenant_kind, t.owner_user_id, t.display_name,
  t.created_by_user_id, t.created_at AS tenant_created_at,
  creator.id AS user_id, creator.created_at AS user_created_at,
  creator_membership.id AS membership_id, creator_membership.role AS membership_role,
  creator_membership.status AS membership_status,
  creator_membership.created_at AS membership_created_at`;

const threadColumns = `
  th.id AS thread_id, th.created_by_user_id AS thread_created_by_user_id,
  th.title AS thread_title, th.status AS thread_status,
  th.created_at AS thread_created_at, th.updated_at AS thread_updated_at`;

const threadJoins = `
  JOIN memberships auth
    ON auth.tenant_id = th.tenant_id AND auth.user_id = $2 AND auth.status = 'active'
  JOIN tenants t ON t.id = th.tenant_id
  JOIN app_users creator ON creator.id = th.created_by_user_id
  JOIN memberships creator_membership
    ON creator_membership.tenant_id = th.tenant_id
   AND creator_membership.user_id = th.created_by_user_id`;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function created(): CreateResult {
  return { outcome: "created" };
}

class ConditionalWriteAbort extends Error {
  constructor(readonly outcome: "revision_conflict" | "lease_lost") {
    super(outcome);
  }
}

async function findThread(
  client: Pool | PoolClient,
  scope: TenantScope,
  threadId: string,
): Promise<Thread | undefined> {
  const result = await client.query(
    `SELECT ${tenantColumns}, ${threadColumns}
       FROM threads th ${threadJoins}
      WHERE th.tenant_id = $1 AND th.id = $3 AND creator_membership.status = 'active'`,
    [scope.tenantId, scope.userId, threadId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const bundle = mapTenantBundle(row);
  return mapThread(row, bundle.tenant, bundle.user, bundle.membership);
}

async function findRun(
  client: Pool | PoolClient,
  scope: TenantScope,
  runId: string,
): Promise<Run | undefined> {
  const result = await client.query(
    `SELECT ${tenantColumns}, ${threadColumns},
            r.id AS run_id, r.status AS run_status,
            r.created_at AS run_created_at, r.updated_at AS run_updated_at
       FROM runs r
       JOIN threads th ON th.tenant_id = r.tenant_id AND th.id = r.thread_id
       ${threadJoins}
      WHERE r.tenant_id = $1 AND r.id = $3 AND creator_membership.status = 'active'`,
    [scope.tenantId, scope.userId, runId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const bundle = mapTenantBundle(row);
  const thread = mapThread(row, bundle.tenant, bundle.user, bundle.membership);
  return mapRun(row, thread);
}

export class PgTenantRepository implements TenantRepository {
  constructor(private readonly pool: Pool) {}

  async createPersonal(bundle: TenantBundle): Promise<CreateResult> {
    if (bundle.tenant.kind !== "personal") {
      throw new TypeError("createPersonal 只接受个人租户");
    }
    const tenant = bundle.tenant;
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query(
          "INSERT INTO app_users(id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [bundle.user.id, bundle.user.createdAt],
        );
        await client.query(
          `INSERT INTO tenants(id, kind, owner_user_id, created_at)
           VALUES ($1, 'personal', $2, $3)`,
          [tenant.id, tenant.ownerUserId, tenant.createdAt],
        );
        await client.query(
          `INSERT INTO memberships(tenant_id, id, user_id, role, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            bundle.membership.tenantId,
            bundle.membership.id,
            bundle.membership.userId,
            bundle.membership.role,
            bundle.membership.status,
            bundle.membership.createdAt,
          ],
        );
        return created();
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: "conflict" };
      throw mapPersistenceError(error, "创建个人租户");
    }
  }

  async get(scope: TenantScope): Promise<TenantBundle | undefined> {
    try {
      const result = await this.pool.query(
        `SELECT ${tenantColumns}
           FROM tenants t
           JOIN memberships auth
             ON auth.tenant_id = t.id AND auth.user_id = $2 AND auth.status = 'active'
           JOIN app_users creator ON creator.id = COALESCE(t.owner_user_id, t.created_by_user_id)
           JOIN memberships creator_membership
             ON creator_membership.tenant_id = t.id AND creator_membership.user_id = creator.id
          WHERE t.id = $1 AND creator_membership.status = 'active'`,
        [scope.tenantId, scope.userId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : mapTenantBundle(row);
    } catch (error) {
      throw mapPersistenceError(error, "读取租户");
    }
  }
}

export class PgThreadRepository implements ThreadRepository {
  constructor(private readonly pool: Pool) {}

  async create(scope: TenantScope, thread: Thread): Promise<CreateResult> {
    if (scope.tenantId !== thread.tenantId || scope.userId !== thread.createdByUserId) {
      return { outcome: "conflict" };
    }
    try {
      const result = await this.pool.query(
        `INSERT INTO threads(tenant_id, id, created_by_user_id, title, status, created_at, updated_at)
         SELECT $1, $3, $2, $4, $5, $6, $7
         WHERE EXISTS (
           SELECT 1 FROM memberships
            WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
         )
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.userId,
          thread.id,
          thread.title,
          thread.status,
          thread.createdAt,
          thread.updatedAt,
        ],
      );
      return result.rowCount === 1 ? created() : { outcome: "conflict" };
    } catch (error) {
      throw mapPersistenceError(error, "创建任务");
    }
  }

  async get(scope: TenantScope, id: Thread["id"]): Promise<Thread | undefined> {
    try {
      return await findThread(this.pool, scope, id);
    } catch (error) {
      throw mapPersistenceError(error, "读取任务");
    }
  }

  async update(
    scope: TenantScope,
    thread: Thread,
    expectedUpdatedAt: string,
  ): Promise<UpdateResult> {
    if (scope.tenantId !== thread.tenantId) return { outcome: "not_found" };
    try {
      const result = await this.pool.query(
        `UPDATE threads th SET title = $4, status = $5, updated_at = $6
          WHERE th.tenant_id = $1 AND th.id = $3 AND th.updated_at = $7
            AND EXISTS (
              SELECT 1 FROM memberships m
               WHERE m.tenant_id = th.tenant_id AND m.user_id = $2 AND m.status = 'active'
            )`,
        [
          scope.tenantId,
          scope.userId,
          thread.id,
          thread.title,
          thread.status,
          thread.updatedAt,
          expectedUpdatedAt,
        ],
      );
      if (result.rowCount === 1) return { outcome: "updated" };
      return (await findThread(this.pool, scope, thread.id)) === undefined
        ? { outcome: "not_found" }
        : { outcome: "conflict" };
    } catch (error) {
      throw mapPersistenceError(error, "更新任务");
    }
  }
}

export class PgRunRepository implements RunRepository {
  constructor(private readonly pool: Pool) {}

  async create(scope: TenantScope, run: Run): Promise<CreateResult> {
    if (scope.tenantId !== run.tenantId) return { outcome: "conflict" };
    try {
      const result = await this.pool.query(
        `INSERT INTO runs(tenant_id, id, thread_id, status, created_at, updated_at)
         SELECT $1, $3, $4, $5, $6, $7
         WHERE EXISTS (
           SELECT 1 FROM memberships m
           JOIN threads th ON th.tenant_id = m.tenant_id AND th.id = $4
            WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'
         )
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.userId,
          run.id,
          run.threadId,
          run.status,
          run.createdAt,
          run.updatedAt,
        ],
      );
      return result.rowCount === 1 ? created() : { outcome: "conflict" };
    } catch (error) {
      throw mapPersistenceError(error, "创建运行");
    }
  }

  async get(scope: TenantScope, id: Run["id"]): Promise<Run | undefined> {
    try {
      return await findRun(this.pool, scope, id);
    } catch (error) {
      throw mapPersistenceError(error, "读取运行");
    }
  }

  async update(scope: TenantScope, run: Run, expectedUpdatedAt: string): Promise<UpdateResult> {
    if (scope.tenantId !== run.tenantId) return { outcome: "not_found" };
    try {
      const result = await this.pool.query(
        `UPDATE runs r SET status = $4, updated_at = $5
          WHERE r.tenant_id = $1 AND r.id = $3 AND r.updated_at = $6
            AND EXISTS (
              SELECT 1 FROM memberships m
               WHERE m.tenant_id = r.tenant_id AND m.user_id = $2 AND m.status = 'active'
            )`,
        [scope.tenantId, scope.userId, run.id, run.status, run.updatedAt, expectedUpdatedAt],
      );
      if (result.rowCount === 1) return { outcome: "updated" };
      return (await findRun(this.pool, scope, run.id)) === undefined
        ? { outcome: "not_found" }
        : { outcome: "conflict" };
    } catch (error) {
      throw mapPersistenceError(error, "更新运行");
    }
  }
}

interface LockedWorkspaceRow extends QueryResultRow {
  readonly current_revision_number: number;
  readonly lease_epoch: string;
  readonly thread_id: string;
}

interface LockedLeaseRow extends QueryResultRow {
  readonly root_run_id: string;
  readonly epoch: string;
  readonly active: boolean;
}

export class PgWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly pool: Pool) {}

  async create(scope: TenantScope, workspace: Workspace): Promise<CreateResult> {
    if (scope.tenantId !== workspace.tenantId || workspace.writerLease !== undefined) {
      return { outcome: "conflict" };
    }
    try {
      const result = await this.pool.query(
        `INSERT INTO workspaces(
           tenant_id, id, thread_id, current_revision_number, current_revision_id,
           lease_epoch, created_at, updated_at
         )
         SELECT $1, $3, $4, $5, $6, $7, $8, $9
         WHERE EXISTS (
           SELECT 1 FROM memberships m
           JOIN threads th ON th.tenant_id = m.tenant_id AND th.id = $4
            WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'
         )
         ON CONFLICT DO NOTHING`,
        [
          scope.tenantId,
          scope.userId,
          workspace.id,
          workspace.threadId,
          workspace.currentRevisionNumber,
          workspace.currentRevisionId ?? null,
          workspace.leaseEpoch,
          workspace.createdAt,
          workspace.updatedAt,
        ],
      );
      return result.rowCount === 1 ? created() : { outcome: "conflict" };
    } catch (error) {
      throw mapPersistenceError(error, "创建工作区");
    }
  }

  async getById(scope: TenantScope, id: Workspace["id"]): Promise<Workspace | undefined> {
    return this.findWorkspace(scope, "w.id", id);
  }

  async getByThread(scope: TenantScope, id: Workspace["threadId"]): Promise<Workspace | undefined> {
    return this.findWorkspace(scope, "w.thread_id", id);
  }

  private async findWorkspace(
    scope: TenantScope,
    column: "w.id" | "w.thread_id",
    id: string,
  ): Promise<Workspace | undefined> {
    try {
      const result = await this.pool.query(
        `SELECT ${tenantColumns}, ${threadColumns},
                w.id AS workspace_id, w.current_revision_number, w.current_revision_id,
                w.lease_epoch, w.created_at AS workspace_created_at,
                w.updated_at AS workspace_updated_at,
                l.root_run_id AS lease_root_run_id, l.epoch AS lease_row_epoch,
                l.expires_at AS lease_expires_at,
                r.id AS run_id, r.status AS run_status,
                r.created_at AS run_created_at, r.updated_at AS run_updated_at
           FROM workspaces w
           JOIN threads th ON th.tenant_id = w.tenant_id AND th.id = w.thread_id
           ${threadJoins}
           LEFT JOIN workspace_write_leases l
             ON l.tenant_id = w.tenant_id AND l.workspace_id = w.id
           LEFT JOIN runs r
             ON r.tenant_id = l.tenant_id AND r.id = l.root_run_id
          WHERE w.tenant_id = $1 AND ${column} = $3 AND creator_membership.status = 'active'`,
        [scope.tenantId, scope.userId, id],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const bundle = mapTenantBundle(row);
      const thread = mapThread(row, bundle.tenant, bundle.user, bundle.membership);
      const writerRun = row.lease_root_run_id === null ? undefined : mapRun(row, thread);
      return mapWorkspace(row, thread, writerRun);
    } catch (error) {
      throw mapPersistenceError(error, "读取工作区");
    }
  }

  async compareAndSetLease(expected: Workspace, next: Workspace): Promise<WorkspaceCommitResult> {
    if (
      expected.id !== next.id ||
      expected.tenantId !== next.tenantId ||
      expected.threadId !== next.threadId ||
      expected.currentRevisionNumber !== next.currentRevisionNumber ||
      expected.currentRevisionId !== next.currentRevisionId
    ) {
      return { outcome: "revision_conflict" };
    }
    try {
      return await withTransaction(this.pool, async (client) => {
        const workspace = await this.lockWorkspace(client, expected);
        if (workspace === undefined) return { outcome: "revision_conflict" };
        if (workspace.current_revision_number !== expected.currentRevisionNumber) {
          return { outcome: "revision_conflict" };
        }
        if (Number(workspace.lease_epoch) !== expected.leaseEpoch) return { outcome: "lease_lost" };
        const lease = await this.lockLease(client, expected);
        const oldLease = expected.writerLease;
        const newLease = next.writerLease;

        // takeover 也是 acquire：快照可保留旧 lease，但新持有者必须使用更高 epoch。
        if (newLease !== undefined && newLease.epoch === expected.leaseEpoch + 1) {
          if (lease?.active === true) {
            return { outcome: "lease_lost" };
          }
          const inserted = await client.query(
            `INSERT INTO workspace_write_leases(
               tenant_id, workspace_id, thread_id, root_run_id, epoch, expires_at, updated_at
             ) SELECT $1, $2, $3, $4, $5, $6, clock_timestamp()
               WHERE $6::timestamptz > clock_timestamp()
             ON CONFLICT (tenant_id, workspace_id) DO UPDATE
               SET root_run_id = EXCLUDED.root_run_id, epoch = EXCLUDED.epoch,
                   expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()
             WHERE workspace_write_leases.expires_at <= clock_timestamp()
               AND EXCLUDED.expires_at > clock_timestamp()`,
            [
              expected.tenantId,
              expected.id,
              expected.threadId,
              newLease.rootRunId,
              newLease.epoch,
              newLease.expiresAt,
            ],
          );
          if (inserted.rowCount !== 1) return { outcome: "lease_lost" };
          const advanced = await client.query(
            `UPDATE workspaces SET lease_epoch = $3, updated_at = $4
              WHERE tenant_id = $1 AND id = $2 AND lease_epoch = $5`,
            [expected.tenantId, expected.id, newLease.epoch, next.updatedAt, expected.leaseEpoch],
          );
          if (advanced.rowCount !== 1) throw new ConditionalWriteAbort("lease_lost");
          return { outcome: "committed" };
        }

        if (oldLease !== undefined && newLease === undefined) {
          if (!this.matchesActiveLease(lease, oldLease.rootRunId, oldLease.epoch)) {
            return { outcome: "lease_lost" };
          }
          const removed = await client.query(
            `DELETE FROM workspace_write_leases
              WHERE tenant_id = $1 AND workspace_id = $2 AND root_run_id = $3 AND epoch = $4
                AND expires_at > clock_timestamp()`,
            [expected.tenantId, expected.id, oldLease.rootRunId, oldLease.epoch],
          );
          if (removed.rowCount !== 1) return { outcome: "lease_lost" };
          await client.query(
            "UPDATE workspaces SET updated_at = $3 WHERE tenant_id = $1 AND id = $2",
            [expected.tenantId, expected.id, next.updatedAt],
          );
          return { outcome: "committed" };
        }

        if (oldLease !== undefined && newLease !== undefined) {
          if (
            oldLease.rootRunId !== newLease.rootRunId ||
            oldLease.epoch !== newLease.epoch ||
            !this.matchesActiveLease(lease, oldLease.rootRunId, oldLease.epoch)
          ) {
            return { outcome: "lease_lost" };
          }
          const renewed = await client.query(
            `UPDATE workspace_write_leases
                SET expires_at = $5, updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND workspace_id = $2 AND root_run_id = $3 AND epoch = $4
                AND expires_at > clock_timestamp() AND $5::timestamptz > clock_timestamp()`,
            [
              expected.tenantId,
              expected.id,
              oldLease.rootRunId,
              oldLease.epoch,
              newLease.expiresAt,
            ],
          );
          if (renewed.rowCount !== 1) return { outcome: "lease_lost" };
          await client.query(
            "UPDATE workspaces SET updated_at = $3 WHERE tenant_id = $1 AND id = $2",
            [expected.tenantId, expected.id, next.updatedAt],
          );
          return { outcome: "committed" };
        }

        return { outcome: "lease_lost" };
      });
    } catch (error) {
      if (error instanceof ConditionalWriteAbort) return { outcome: error.outcome };
      throw mapPersistenceError(error, "更新工作区租约");
    }
  }

  async commitRevision(command: WorkspaceRevisionCommit): Promise<WorkspaceCommitResult> {
    const { workspace, revision } = command;
    if (
      workspace.currentRevisionNumber !== command.expectedCurrentRevisionNumber + 1 ||
      workspace.currentRevisionId !== revision.id ||
      workspace.id !== revision.workspaceId ||
      workspace.tenantId !== revision.tenantId ||
      workspace.threadId !== revision.threadId ||
      revision.revisionNumber !== workspace.currentRevisionNumber ||
      revision.leaseEpoch !== command.expectedLeaseEpoch
    ) {
      return { outcome: "revision_conflict" };
    }
    try {
      return await withTransaction(this.pool, async (client) => {
        const locked = await this.lockWorkspace(client, workspace);
        if (
          locked === undefined ||
          locked.current_revision_number !== command.expectedCurrentRevisionNumber
        ) {
          return { outcome: "revision_conflict" };
        }
        if (Number(locked.lease_epoch) !== command.expectedLeaseEpoch) {
          return { outcome: "lease_lost" };
        }
        const lease = await this.lockLease(client, workspace);
        if (!this.matchesActiveLease(lease, revision.createdByRunId, command.expectedLeaseEpoch)) {
          return { outcome: "lease_lost" };
        }
        await client.query(
          `INSERT INTO workspace_revisions(
             tenant_id, workspace_id, id, thread_id, revision_number, parent_revision_id,
             created_by_run_id, lease_epoch, object_key, digest, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            revision.tenantId,
            revision.workspaceId,
            revision.id,
            revision.threadId,
            revision.revisionNumber,
            revision.parentRevisionId ?? null,
            revision.createdByRunId,
            revision.leaseEpoch,
            revision.objectKey,
            revision.digest,
            revision.createdAt,
          ],
        );
        const advanced = await client.query(
          `UPDATE workspaces
              SET current_revision_number = $3, current_revision_id = $4, updated_at = $5
            WHERE tenant_id = $1 AND id = $2
              AND current_revision_number = $6 AND lease_epoch = $7`,
          [
            workspace.tenantId,
            workspace.id,
            workspace.currentRevisionNumber,
            workspace.currentRevisionId,
            workspace.updatedAt,
            command.expectedCurrentRevisionNumber,
            command.expectedLeaseEpoch,
          ],
        );
        if (advanced.rowCount !== 1) throw new ConditionalWriteAbort("revision_conflict");
        return { outcome: "committed" };
      });
    } catch (error) {
      if (error instanceof ConditionalWriteAbort) return { outcome: error.outcome };
      if (isUniqueViolation(error)) return { outcome: "revision_conflict" };
      throw mapPersistenceError(error, "提交工作区版本");
    }
  }

  private async lockWorkspace(
    client: PoolClient,
    workspace: Workspace,
  ): Promise<LockedWorkspaceRow | undefined> {
    const result = await client.query<LockedWorkspaceRow>(
      `SELECT current_revision_number, lease_epoch, thread_id
         FROM workspaces WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [workspace.tenantId, workspace.id],
    );
    const row = result.rows[0];
    return row?.thread_id === workspace.threadId ? row : undefined;
  }

  private async lockLease(
    client: PoolClient,
    workspace: Workspace,
  ): Promise<LockedLeaseRow | undefined> {
    const result = await client.query<LockedLeaseRow>(
      `SELECT root_run_id, epoch, expires_at > clock_timestamp() AS active
         FROM workspace_write_leases
        WHERE tenant_id = $1 AND workspace_id = $2 FOR UPDATE`,
      [workspace.tenantId, workspace.id],
    );
    return result.rows[0];
  }

  private matchesActiveLease(
    lease: LockedLeaseRow | undefined,
    rootRunId: string,
    epoch: number,
  ): boolean {
    return (
      lease?.active === true && lease.root_run_id === rootRunId && Number(lease.epoch) === epoch
    );
  }
}

export class PgCoreRepositories implements CoreRepositories {
  readonly tenants: TenantRepository;
  readonly threads: ThreadRepository;
  readonly runs: RunRepository;
  readonly workspaces: WorkspaceRepository;

  constructor(pool: Pool) {
    this.tenants = new PgTenantRepository(pool);
    this.threads = new PgThreadRepository(pool);
    this.runs = new PgRunRepository(pool);
    this.workspaces = new PgWorkspaceRepository(pool);
  }
}
