import type {
  Run,
  Thread,
  Workspace,
  WorkspaceCommitResult,
  WorkspaceRevisionCommit,
  WorkspaceWriteScope,
} from "@hoox/domain";
import { archiveThread, isoTimestamp, renameThread } from "@hoox/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { createRunConfigurationSnapshots } from "./pg-run-agent-snapshot.js";
import {
  cancelThreadQueuedRun,
  lockThreadExecutionHead,
  settleActiveThreadRun,
} from "./pg-thread-run-queue.js";
import { enqueueRunStatusWebhook } from "./pg-webhooks.js";
import type {
  ArchiveThreadCommandPort,
  ArchiveThreadResult,
  CoreRepositories,
  CreateResult,
  RenamePersonalThreadCommandPort,
  RenamePersonalThreadResult,
  RunReadSnapshot,
  RunRepository,
  TenantBundle,
  TenantRepository,
  TenantScope,
  ThreadListPage,
  ThreadRepository,
  Versioned,
  VersionedCreateResult,
  VersionedUpdateResult,
  WorkspaceRepository,
} from "./ports.js";
import { withTenantTransaction } from "./postgres.js";
import { mapRun, mapTenant, mapTenantBundle, mapThread, mapWorkspace } from "./row-mappers.js";

const tenantColumns = `
  t.id AS tenant_id, t.kind AS tenant_kind, t.owner_user_id, t.display_name,
  t.created_by_user_id, t.created_at AS tenant_created_at,
  tenant_actor.id AS tenant_actor_id, tenant_actor.kind AS tenant_actor_kind,
  tenant_actor.created_at AS tenant_actor_created_at`;

const authColumns = `
  auth_user.id AS auth_user_id, auth_user.kind AS auth_user_kind,
  auth_user.created_at AS auth_user_created_at,
  auth.id AS auth_membership_id, auth.role AS auth_membership_role,
  auth.status AS auth_membership_status, auth.created_at AS auth_membership_created_at`;

const threadColumns = `
  th.id AS thread_id, th.created_by_user_id AS thread_created_by_user_id,
  th.agent_definition_id AS thread_agent_definition_id,
  th.title AS thread_title, th.status AS thread_status, th.version AS thread_version,
  th.created_at AS thread_created_at, th.updated_at AS thread_updated_at,
  thread_creator.id AS thread_creator_id, thread_creator.kind AS thread_creator_kind,
  thread_creator.created_at AS thread_creator_created_at,
  thread_creator_membership.id AS thread_creator_membership_id,
  thread_creator_membership.role AS thread_creator_membership_role,
  thread_creator_membership.status AS thread_creator_membership_status,
  thread_creator_membership.created_at AS thread_creator_membership_created_at`;

const threadJoins = `
  JOIN memberships auth
    ON auth.tenant_id = th.tenant_id AND auth.user_id = $2 AND auth.status = 'active'
  JOIN app_users auth_user ON auth_user.id = auth.user_id
  JOIN tenants t ON t.id = th.tenant_id
  JOIN app_users tenant_actor ON tenant_actor.id = COALESCE(t.owner_user_id, t.created_by_user_id)
  JOIN app_users thread_creator ON thread_creator.id = th.created_by_user_id
  JOIN memberships thread_creator_membership
    ON thread_creator_membership.tenant_id = th.tenant_id
   AND thread_creator_membership.user_id = th.created_by_user_id`;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

class ConditionalWriteAbort extends Error {
  constructor(readonly outcome: "revision_conflict" | "lease_lost") {
    super(outcome);
  }
}

async function findThread(
  client: PoolClient,
  scope: TenantScope,
  threadId: string,
): Promise<Versioned<Thread> | undefined> {
  const result = await client.query(
    `SELECT ${tenantColumns}, ${authColumns}, ${threadColumns}
       FROM threads th ${threadJoins}
      WHERE th.tenant_id = $1 AND th.id = $3`,
    [scope.tenantId, scope.userId, threadId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return { entity: mapThread(row, mapTenant(row)), version: BigInt(row.thread_version) };
}

async function findRun(
  client: PoolClient,
  scope: TenantScope,
  runId: string,
): Promise<RunReadSnapshot | undefined> {
  const result = await client.query(
    `SELECT ${tenantColumns}, ${authColumns}, ${threadColumns},
            r.id AS run_id, r.status AS run_status, r.version AS run_version,
            r.created_at AS run_created_at, r.updated_at AS run_updated_at,
            latest_attempt.status AS latest_attempt_status
       FROM runs r
       JOIN threads th ON th.tenant_id = r.tenant_id AND th.id = r.thread_id
       ${threadJoins}
       LEFT JOIN LATERAL (
         SELECT attempt.status FROM execution_attempts attempt
          WHERE attempt.tenant_id = r.tenant_id AND attempt.run_id = r.id
          ORDER BY attempt.created_at DESC, attempt.attempt_id DESC LIMIT 1
       ) latest_attempt ON true
      WHERE r.tenant_id = $1 AND r.id = $3`,
    [scope.tenantId, scope.userId, runId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const thread = mapThread(row, mapTenant(row));
  return mapRunReadSnapshot(row, thread);
}

function mapRunReadSnapshot(row: QueryResultRow, thread: Thread): RunReadSnapshot {
  return {
    entity: mapRun(row, thread),
    version: BigInt(row.run_version),
    // 只有显式 durable Attempt 事实才能覆盖“仍在执行”的公开投影；缺行或超时均不猜测。
    ...(row.run_status === "running" && row.latest_attempt_status === "recovery_required"
      ? { executionStatus: "recovery_required" as const }
      : {}),
  };
}

export class PgTenantRepository implements TenantRepository {
  constructor(private readonly pool: Pool) {}

  async createPersonal(bundle: TenantBundle): Promise<CreateResult> {
    if (bundle.tenant.kind !== "personal") throw new TypeError("只接受个人租户");
    const tenant = bundle.tenant;
    if (
      tenant.ownerUserId !== bundle.user.id ||
      bundle.membership.tenantId !== tenant.id ||
      bundle.membership.userId !== bundle.user.id ||
      bundle.membership.role !== "owner" ||
      bundle.membership.status !== "active"
    ) {
      throw new TypeError("个人租户聚合关联无效");
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: tenant.id, userId: bundle.user.id },
        async (client) => {
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
          return { outcome: "created" };
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: "conflict" };
      throw mapPersistenceError(error, "创建个人租户");
    }
  }

  async get(scope: TenantScope): Promise<TenantBundle | undefined> {
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query(
          `SELECT ${tenantColumns}, ${authColumns}
             FROM tenants t
             JOIN memberships auth
               ON auth.tenant_id = t.id AND auth.user_id = $2 AND auth.status = 'active'
             JOIN app_users auth_user ON auth_user.id = auth.user_id
             JOIN app_users tenant_actor
               ON tenant_actor.id = COALESCE(t.owner_user_id, t.created_by_user_id)
            WHERE t.id = $1`,
          [scope.tenantId, scope.userId],
        );
        const row = result.rows[0];
        return row === undefined ? undefined : mapTenantBundle(row);
      });
    } catch (error) {
      throw mapPersistenceError(error, "读取租户");
    }
  }
}

export class PgThreadRepository implements ThreadRepository {
  constructor(private readonly pool: Pool) {}

  async create(scope: TenantScope, thread: Thread): Promise<VersionedCreateResult> {
    if (scope.tenantId !== thread.tenantId || scope.userId !== thread.createdByUserId) {
      return { outcome: "conflict" };
    }
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query<{ version: string }>(
          `INSERT INTO threads(tenant_id, id, created_by_user_id, title, status, created_at, updated_at, agent_definition_id)
           SELECT $1, $3, $2, $4, $5, $6, $7, $8
            WHERE EXISTS (SELECT 1 FROM memberships
              WHERE tenant_id = $1 AND user_id = $2 AND status = 'active')
           ON CONFLICT DO NOTHING RETURNING version`,
          [
            scope.tenantId,
            scope.userId,
            thread.id,
            thread.title,
            thread.status,
            thread.createdAt,
            thread.updatedAt,
            thread.agentDefinitionId,
          ],
        );
        const version = result.rows[0]?.version;
        return version === undefined
          ? { outcome: "conflict" }
          : { outcome: "created", version: BigInt(version) };
      });
    } catch (error) {
      throw mapPersistenceError(error, "创建任务");
    }
  }

  async get(scope: TenantScope, id: Thread["id"]): Promise<Versioned<Thread> | undefined> {
    try {
      return await withTenantTransaction(this.pool, scope, (client) =>
        findThread(client, scope, id),
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取任务");
    }
  }

  async list(
    scope: TenantScope,
    input: Parameters<ThreadRepository["list"]>[1],
  ): Promise<ThreadListPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("任务分页大小必须在 1 到 100 之间");
    }
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query(
          `SELECT ${tenantColumns}, ${authColumns}, ${threadColumns}
             FROM threads th ${threadJoins}
            WHERE th.tenant_id = $1
              AND ($3::timestamptz IS NULL OR (th.updated_at, th.id) < ($3::timestamptz, $4))
            ORDER BY th.updated_at DESC, th.id DESC
            LIMIT $5`,
          [
            scope.tenantId,
            scope.userId,
            input.cursor?.updatedAt ?? null,
            input.cursor?.id ?? "",
            input.limit + 1,
          ],
        );
        const pageRows = result.rows.slice(0, input.limit);
        const items = pageRows.map((row) => ({
          entity: mapThread(row, mapTenant(row)),
          version: BigInt(row.thread_version),
        }));
        const last = items.at(-1);
        if (result.rows.length > input.limit && last !== undefined) {
          return {
            items,
            nextCursor: { updatedAt: last.entity.updatedAt, id: last.entity.id },
          };
        }
        return { items };
      });
    } catch (error) {
      throw mapPersistenceError(error, "列出任务");
    }
  }

  async update(
    scope: TenantScope,
    thread: Thread,
    expectedVersion: bigint,
  ): Promise<VersionedUpdateResult> {
    if (scope.tenantId !== thread.tenantId) return { outcome: "not_found" };
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query<{ version: string }>(
          `UPDATE threads th
              SET title = $4, status = $5, updated_at = $6, version = version + 1
            WHERE th.tenant_id = $1 AND th.id = $3 AND th.version = $7
              AND EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = th.tenant_id AND m.user_id = $2 AND m.status = 'active')
            RETURNING version`,
          [
            scope.tenantId,
            scope.userId,
            thread.id,
            thread.title,
            thread.status,
            thread.updatedAt,
            expectedVersion.toString(),
          ],
        );
        const version = result.rows[0]?.version;
        if (version !== undefined) return { outcome: "updated", version: BigInt(version) };
        return (await findThread(client, scope, thread.id)) === undefined
          ? { outcome: "not_found" }
          : { outcome: "conflict" };
      });
    } catch (error) {
      throw mapPersistenceError(error, "更新任务");
    }
  }
}

export class PgRunRepository implements RunRepository {
  constructor(private readonly pool: Pool) {}

  async create(scope: TenantScope, run: Run): Promise<VersionedCreateResult> {
    if (scope.tenantId !== run.tenantId) return { outcome: "conflict" };
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const parent = await client.query(
          `SELECT 1 FROM threads th
            WHERE th.tenant_id = $1 AND th.id = $2 AND th.status = 'active'
              AND EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = th.tenant_id AND m.user_id = $3 AND m.status = 'active')
            FOR SHARE`,
          [scope.tenantId, run.threadId, scope.userId],
        );
        if (parent.rowCount !== 1) return { outcome: "conflict" };
        const result = await client.query<{ version: string }>(
          `INSERT INTO runs(tenant_id, id, thread_id, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING RETURNING version`,
          [scope.tenantId, run.id, run.threadId, run.status, run.createdAt, run.updatedAt],
        );
        const version = result.rows[0]?.version;
        if (version === undefined) return { outcome: "conflict" };
        await createRunConfigurationSnapshots(client, {
          tenantId: scope.tenantId,
          userId: scope.userId,
          threadId: run.threadId,
          runId: run.id,
        });
        return { outcome: "created", version: BigInt(version) };
      });
    } catch (error) {
      throw mapPersistenceError(error, "创建运行");
    }
  }

  async get(scope: TenantScope, id: Run["id"]): Promise<RunReadSnapshot | undefined> {
    try {
      return await withTenantTransaction(this.pool, scope, (client) => findRun(client, scope, id));
    } catch (error) {
      throw mapPersistenceError(error, "读取运行");
    }
  }

  async listByThread(
    scope: TenantScope,
    requestedThreadId: Thread["id"],
    input: { readonly limit: number },
  ): Promise<readonly RunReadSnapshot[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("Run 最新窗口大小必须在 1 到 100 之间");
    }
    try {
      return await withTenantTransaction(
        this.pool,
        scope,
        async (client) => {
          // Membership、Thread 与 Run 同一条查询绑定；不存在或无权时返回空，供 API 先以 Thread 读取失败关闭。
          const result = await client.query(
            `SELECT ${tenantColumns}, ${authColumns}, ${threadColumns},
                    r.id AS run_id, r.status AS run_status, r.version AS run_version,
                    r.created_at AS run_created_at, r.updated_at AS run_updated_at,
                    latest_attempt.status AS latest_attempt_status
               FROM runs r
               JOIN threads th ON th.tenant_id = r.tenant_id AND th.id = r.thread_id
               ${threadJoins}
               LEFT JOIN LATERAL (
                 SELECT attempt.status FROM execution_attempts attempt
                  WHERE attempt.tenant_id = r.tenant_id AND attempt.run_id = r.id
                  ORDER BY attempt.created_at DESC, attempt.attempt_id DESC LIMIT 1
               ) latest_attempt ON true
              WHERE r.tenant_id = $1 AND r.thread_id = $3
              ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
              LIMIT $4`,
            [scope.tenantId, scope.userId, requestedThreadId, input.limit],
          );
          return result.rows.map((row) => {
            const thread = mapThread(row, mapTenant(row));
            return mapRunReadSnapshot(row, thread);
          });
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取任务最新 Run");
    }
  }

  async update(
    scope: TenantScope,
    run: Run,
    expectedVersion: bigint,
  ): Promise<VersionedUpdateResult> {
    if (scope.tenantId !== run.tenantId) return { outcome: "not_found" };
    try {
      return await withTenantTransaction(this.pool, scope, (client) =>
        updateRun(client, scope, run, expectedVersion),
      );
    } catch (error) {
      throw mapPersistenceError(error, "更新运行");
    }
  }
}

export function transactionRunRepository(
  client: PoolClient,
): Pick<RunRepository, "get" | "update"> {
  return {
    get: (scope, id) => findRun(client, scope, id),
    update: (scope, run, version) => updateRun(client, scope, run, version),
  };
}

async function updateRun(
  client: PoolClient,
  scope: TenantScope,
  run: Run,
  expectedVersion: bigint,
): Promise<VersionedUpdateResult> {
  // 先按 tenant+runId 只读发现数据库中的真实父级；thread_id 对业务不可变。
  const discovered = await client.query<{ thread_id: string }>(
    `SELECT r.thread_id FROM runs r
            WHERE r.tenant_id = $1 AND r.id = $2
              AND EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = r.tenant_id AND m.user_id = $3 AND m.status = 'active')`,
    [scope.tenantId, run.id, scope.userId],
  );
  const actualThreadId = discovered.rows[0]?.thread_id;
  if (actualThreadId === undefined) return { outcome: "not_found" };

  // 所有父子写固定按数据库真实关系锁 Thread→Run，不能让调用方伪造 threadId 改变锁序。
  const parent = await client.query(
    "SELECT 1 FROM threads WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [scope.tenantId, actualThreadId],
  );
  if (parent.rowCount !== 1) return { outcome: "not_found" };
  // V2 终态和 Worker 使用同一线性化锁序：Thread → execution head → Run。
  await lockThreadExecutionHead(client, scope.tenantId, actualThreadId);
  const locked = await client.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs
            WHERE tenant_id = $1 AND id = $2 AND thread_id = $3
            FOR UPDATE`,
    [scope.tenantId, run.id, actualThreadId],
  );
  if (locked.rows[0]?.thread_id !== actualThreadId) return { outcome: "conflict" };
  if (run.threadId !== actualThreadId) return { outcome: "conflict" };
  const result = await client.query<{ version: string }>(
    `UPDATE runs r SET status = $5, updated_at = $6, version = version + 1
            WHERE r.tenant_id = $1 AND r.id = $3 AND r.thread_id = $4 AND r.version = $7
              AND EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = r.tenant_id AND m.user_id = $2 AND m.status = 'active')
            RETURNING version`,
    [
      scope.tenantId,
      scope.userId,
      run.id,
      actualThreadId,
      run.status,
      run.updatedAt,
      expectedVersion.toString(),
    ],
  );
  const version = result.rows[0]?.version;
  if (version !== undefined) {
    // API 取消等外部终态在提交 Run 转换的同一事务内入队；版本条件失败时不会到达这里。
    await enqueueRunStatusWebhook(client, {
      tenantId: scope.tenantId,
      runId: run.id,
      status: run.status,
      runVersion: version,
      occurredAt: run.updatedAt,
    });
    if (run.status === "cancelled") {
      await cancelThreadQueuedRun(client, {
        tenantId: scope.tenantId,
        threadId: actualThreadId,
        runId: run.id,
      });
    } else if (run.status === "succeeded" || run.status === "failed") {
      const now = await client.query<{ readonly database_now: Date }>(
        "SELECT clock_timestamp() AS database_now",
      );
      const databaseNow = now.rows[0]?.database_now;
      if (databaseNow === undefined) throw new TypeError("数据库时钟缺失");
      await settleActiveThreadRun(client, {
        tenantId: scope.tenantId,
        threadId: actualThreadId,
        runId: run.id,
        runStatus: run.status,
        databaseNow: databaseNow.toISOString(),
      });
    }
    return { outcome: "updated", version: BigInt(version) };
  }
  return (await findRun(client, scope, run.id)) === undefined
    ? { outcome: "not_found" }
    : { outcome: "conflict" };
}

interface LockedWorkspaceRow extends QueryResultRow {
  readonly current_revision_number: number;
  readonly current_revision_id: string | null;
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
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const parent = await client.query(
          `SELECT 1 FROM threads th
            WHERE th.tenant_id = $1 AND th.id = $2 AND th.status = 'active'
              AND EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = th.tenant_id AND m.user_id = $3 AND m.status = 'active')
            FOR UPDATE`,
          [scope.tenantId, workspace.threadId, scope.userId],
        );
        if (parent.rowCount !== 1) return { outcome: "conflict" };
        const result = await client.query(
          `INSERT INTO workspaces(
             tenant_id, id, thread_id, current_revision_number, current_revision_id,
             lease_epoch, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            scope.tenantId,
            workspace.id,
            workspace.threadId,
            workspace.currentRevisionNumber,
            workspace.currentRevisionId ?? null,
            workspace.leaseEpoch,
            workspace.createdAt,
            workspace.updatedAt,
          ],
        );
        return result.rowCount === 1 ? { outcome: "created" } : { outcome: "conflict" };
      });
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
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query(
          `SELECT ${tenantColumns}, ${authColumns}, ${threadColumns},
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
             LEFT JOIN runs r ON r.tenant_id = l.tenant_id AND r.id = l.root_run_id
            WHERE w.tenant_id = $1 AND ${column} = $3`,
          [scope.tenantId, scope.userId, id],
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        const thread = mapThread(row, mapTenant(row));
        const writerRun = row.lease_root_run_id === null ? undefined : mapRun(row, thread);
        return mapWorkspace(row, thread, writerRun);
      });
    } catch (error) {
      throw mapPersistenceError(error, "读取工作区");
    }
  }

  async compareAndSetLease(
    scope: WorkspaceWriteScope,
    expected: Workspace,
    next: Workspace,
  ): Promise<WorkspaceCommitResult> {
    if (
      scope.tenantId !== expected.tenantId ||
      expected.id !== next.id ||
      expected.tenantId !== next.tenantId ||
      expected.threadId !== next.threadId ||
      expected.currentRevisionNumber !== next.currentRevisionNumber ||
      expected.currentRevisionId !== next.currentRevisionId
    ) {
      return { outcome: "revision_conflict" };
    }
    const oldLease = expected.writerLease;
    const newLease = next.writerLease;
    const acquiring = newLease !== undefined && newLease.epoch === expected.leaseEpoch + 1;
    const renewing =
      oldLease !== undefined &&
      newLease !== undefined &&
      oldLease.rootRunId === newLease.rootRunId &&
      oldLease.epoch === newLease.epoch;
    const releasing = oldLease !== undefined && newLease === undefined;
    if (
      (!acquiring && !renewing && !releasing) ||
      (newLease !== undefined && newLease.rootRunId !== scope.rootRunId) ||
      (newLease === undefined && oldLease?.rootRunId !== scope.rootRunId) ||
      next.leaseEpoch !== (acquiring ? expected.leaseEpoch + 1 : expected.leaseEpoch)
    ) {
      return { outcome: "lease_lost" };
    }
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const workspace = await this.lockWriteParents(client, scope, expected);
        if (workspace === undefined) return { outcome: "lease_lost" };
        if (workspace.current_revision_number !== expected.currentRevisionNumber) {
          return { outcome: "revision_conflict" };
        }
        if (Number(workspace.lease_epoch) !== expected.leaseEpoch) return { outcome: "lease_lost" };
        const lease = await this.lockLease(client, expected);

        if (acquiring && newLease !== undefined) {
          if (lease?.active === true) return { outcome: "lease_lost" };
          const inserted = await client.query(
            `INSERT INTO workspace_write_leases(
               tenant_id, workspace_id, thread_id, root_run_id, epoch, expires_at, updated_at
             ) SELECT $1,$2,$3,$4,$5,$6,clock_timestamp()
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
              scope.rootRunId,
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

        if (releasing && oldLease !== undefined) {
          if (!this.matchesActiveLease(lease, scope.rootRunId, oldLease.epoch)) {
            return { outcome: "lease_lost" };
          }
          const removed = await client.query(
            `DELETE FROM workspace_write_leases
              WHERE tenant_id = $1 AND workspace_id = $2 AND root_run_id = $3 AND epoch = $4
                AND expires_at > clock_timestamp()`,
            [expected.tenantId, expected.id, scope.rootRunId, oldLease.epoch],
          );
          if (removed.rowCount !== 1) return { outcome: "lease_lost" };
          await client.query(
            "UPDATE workspaces SET updated_at = $3 WHERE tenant_id = $1 AND id = $2",
            [expected.tenantId, expected.id, next.updatedAt],
          );
          return { outcome: "committed" };
        }

        if (renewing && oldLease !== undefined && newLease !== undefined) {
          if (!this.matchesActiveLease(lease, scope.rootRunId, oldLease.epoch)) {
            return { outcome: "lease_lost" };
          }
          const renewed = await client.query(
            `UPDATE workspace_write_leases SET expires_at = $5, updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND workspace_id = $2 AND root_run_id = $3 AND epoch = $4
                AND expires_at > clock_timestamp() AND $5::timestamptz > clock_timestamp()`,
            [expected.tenantId, expected.id, scope.rootRunId, oldLease.epoch, newLease.expiresAt],
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

  async commitRevision(
    scope: WorkspaceWriteScope,
    command: WorkspaceRevisionCommit,
  ): Promise<WorkspaceCommitResult> {
    const { workspace, revision } = command;
    if (
      scope.tenantId !== workspace.tenantId ||
      scope.rootRunId !== revision.createdByRunId ||
      workspace.writerLease?.rootRunId !== scope.rootRunId ||
      workspace.writerLease.epoch !== command.expectedLeaseEpoch ||
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
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const locked = await this.lockWriteParents(client, scope, workspace);
        if (locked === undefined) return { outcome: "lease_lost" };
        if (
          locked.current_revision_number !== command.expectedCurrentRevisionNumber ||
          locked.current_revision_id !== (revision.parentRevisionId ?? null)
        ) {
          return { outcome: "revision_conflict" };
        }
        if (Number(locked.lease_epoch) !== command.expectedLeaseEpoch) {
          return { outcome: "lease_lost" };
        }
        const lease = await this.lockLease(client, workspace);
        if (!this.matchesActiveLease(lease, scope.rootRunId, command.expectedLeaseEpoch)) {
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
            scope.rootRunId,
            revision.leaseEpoch,
            revision.objectKey,
            revision.digest,
            revision.createdAt,
          ],
        );
        const advanced = await client.query(
          `UPDATE workspaces
              SET current_revision_number = $3, current_revision_id = $4, updated_at = $5
            WHERE tenant_id = $1 AND id = $2 AND current_revision_number = $6
              AND current_revision_id IS NOT DISTINCT FROM $7 AND lease_epoch = $8`,
          [
            workspace.tenantId,
            workspace.id,
            workspace.currentRevisionNumber,
            workspace.currentRevisionId,
            workspace.updatedAt,
            command.expectedCurrentRevisionNumber,
            revision.parentRevisionId ?? null,
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

  /** 固定 Thread→Run→Workspace 锁序，并在锁内重验父状态。 */
  private async lockWriteParents(
    client: PoolClient,
    scope: WorkspaceWriteScope,
    workspace: Workspace,
  ): Promise<LockedWorkspaceRow | undefined> {
    const relation = await client.query<{ thread_id: string }>(
      "SELECT thread_id FROM workspaces WHERE tenant_id = $1 AND id = $2",
      [scope.tenantId, workspace.id],
    );
    const threadId = relation.rows[0]?.thread_id;
    if (threadId === undefined || threadId !== workspace.threadId) return undefined;
    const thread = await client.query<{ status: string }>(
      "SELECT status FROM threads WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [scope.tenantId, threadId],
    );
    if (thread.rows[0]?.status !== "active") return undefined;
    const run = await client.query<{ status: string; thread_id: string }>(
      "SELECT status, thread_id FROM runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [scope.tenantId, scope.rootRunId],
    );
    if (run.rows[0]?.status !== "running" || run.rows[0].thread_id !== threadId) return undefined;
    const result = await client.query<LockedWorkspaceRow>(
      `SELECT current_revision_number, current_revision_id, lease_epoch, thread_id
         FROM workspaces WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [scope.tenantId, workspace.id],
    );
    return result.rows[0];
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

/**
 * 个人任务标题是用户资产；命令在锁内重验 personal Tenant 与 owner Membership，
 * 并把标题来源切为 user，阻止已经排队的异步标题生成覆盖用户输入。
 */
export class PgRenamePersonalThreadCommand implements RenamePersonalThreadCommandPort {
  constructor(private readonly pool: Pool) {}

  async renamePersonalThread(
    input: Parameters<RenamePersonalThreadCommandPort["renamePersonalThread"]>[0],
  ): Promise<RenamePersonalThreadResult> {
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const membership = await client.query<{
          readonly kind: string;
          readonly role: string;
          readonly status: string;
        }>(
          `SELECT tenant.kind, membership.role, membership.status
             FROM tenants AS tenant
             JOIN memberships AS membership ON membership.tenant_id = tenant.id
            WHERE tenant.id = $1 AND membership.user_id = $2
            FOR SHARE OF tenant, membership`,
          [input.scope.tenantId, input.scope.userId],
        );
        const authorization = membership.rows[0];
        if (
          authorization?.kind !== "personal" ||
          authorization.status !== "active" ||
          authorization.role !== "owner"
        ) {
          return { outcome: "not_authorized" };
        }

        const locked = await client.query<{ readonly status: string }>(
          `SELECT status FROM threads
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE`,
          [input.scope.tenantId, input.threadId],
        );
        if (locked.rows[0]?.status !== "active") return { outcome: "not_found" };
        const current = await findThread(client, input.scope, input.threadId);
        if (current === undefined) return { outcome: "not_found" };
        const databaseClock = await client.query<{ readonly now: Date | string }>(
          "SELECT clock_timestamp() AS now",
        );
        const databaseTimestamp = databaseClock.rows[0]?.now;
        if (databaseTimestamp === undefined) throw new TypeError("任务改名未返回数据库时间");
        const renamed = renameThread(
          current.entity,
          input.title,
          isoTimestamp(
            databaseTimestamp instanceof Date
              ? databaseTimestamp.toISOString()
              : new Date(databaseTimestamp).toISOString(),
          ),
        );
        const updated = await client.query(
          `UPDATE threads
              SET title = $3, title_source = 'user', title_generated_at = $4,
                  title_generation_version = title_generation_version + 1,
                  updated_at = $4, version = version + 1
            WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
          [input.scope.tenantId, input.threadId, renamed.title, renamed.updatedAt],
        );
        if (updated.rowCount !== 1) return { outcome: "not_found" };
        return { outcome: "renamed", entity: renamed };
      });
    } catch (error) {
      throw mapPersistenceError(error, "个人任务改名");
    }
  }
}

/**
 * 归档是一个授权命令而非 Repository 的读改写组合。
 * 锁序固定为 Membership→Thread，使成员降权和归档之间存在明确串行化点。
 */
export class PgArchiveThreadCommand implements ArchiveThreadCommandPort {
  constructor(private readonly pool: Pool) {}

  async archiveThread(
    input: Parameters<ArchiveThreadCommandPort["archiveThread"]>[0],
  ): Promise<ArchiveThreadResult> {
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const membership = await client.query<{ readonly role: string; readonly status: string }>(
          `SELECT membership.role, membership.status
             FROM memberships AS membership
            WHERE membership.tenant_id = $1 AND membership.user_id = $2
            FOR SHARE OF membership`,
          [input.scope.tenantId, input.scope.userId],
        );
        const authorization = membership.rows[0];
        if (
          authorization?.status !== "active" ||
          (authorization.role !== "owner" && authorization.role !== "admin")
        ) {
          return { outcome: "not_authorized" };
        }

        const locked = await client.query<{ readonly status: string }>(
          `SELECT status FROM threads
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE`,
          [input.scope.tenantId, input.threadId],
        );
        const status = locked.rows[0]?.status;
        if (status === undefined) return { outcome: "not_found" };
        const current = await findThread(client, input.scope, input.threadId);
        if (current === undefined) return { outcome: "not_found" };
        if (status === "archived") return { outcome: "already_archived", entity: current.entity };

        const updated = await client.query<{ readonly updated_at: Date | string }>(
          `UPDATE threads
              SET status = 'archived',
                  updated_at = GREATEST(updated_at, clock_timestamp()),
                  version = version + 1
            WHERE tenant_id = $1 AND id = $2 AND status = 'active'
            RETURNING updated_at`,
          [input.scope.tenantId, input.threadId],
        );
        if (updated.rowCount !== 1) return { outcome: "not_found" };
        const databaseTimestamp = updated.rows[0]?.updated_at;
        if (databaseTimestamp === undefined) throw new TypeError("归档任务未返回数据库时间");
        const archived = archiveThread(
          current.entity,
          isoTimestamp(
            databaseTimestamp instanceof Date
              ? databaseTimestamp.toISOString()
              : new Date(databaseTimestamp).toISOString(),
          ),
        );
        return { outcome: "archived", entity: archived };
      });
    } catch (error) {
      throw mapPersistenceError(error, "归档任务");
    }
  }
}
