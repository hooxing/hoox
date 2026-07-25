import {
  acquireWorkspaceLease,
  archiveThread,
  createPersonalTenant,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  isoTimestamp,
  membershipId,
  prepareWorkspaceRevision,
  renewWorkspaceLease,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  transitionRun,
  userId,
  workspaceId,
  workspaceRevisionId,
  type Run,
  type Thread,
  type Workspace,
} from "@cube-runtime/domain";
import {
  createPostgresPool,
  migrateDown,
  migrateUp,
  PgCoreRepositories,
  withTransaction,
  type Pool,
  type TenantScope,
} from "@cube-runtime/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("PostgreSQL 集成测试需要 DATABASE_URL；连接信息不会写入测试日志");
}

const schema = `it_${process.pid}_${Date.now()}`;
let administrativePool!: Pool;
let pool!: Pool;
let repositories!: PgCoreRepositories;
let schemaCreated = false;

interface Fixture {
  readonly scope: TenantScope;
  readonly thread: Thread;
  readonly run: Run;
  readonly workspace: Workspace;
}

function timestamp(second: number): ReturnType<typeof isoTimestamp> {
  return isoTimestamp(`2099-07-26T08:00:${second.toString().padStart(2, "0")}.000Z`);
}

async function createFixture(suffix: string): Promise<Fixture> {
  const user = createUser(userId(`user_${suffix}`), timestamp(0));
  const personal = createPersonalTenant({
    id: tenantId(`tenant_${suffix}`),
    ownerMembershipId: membershipId(`membership_${suffix}`),
    owner: user,
    createdAt: timestamp(0),
  });
  const scope: TenantScope = { tenantId: personal.tenant.id, userId: user.id };
  expect(
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    }),
  ).toEqual({ outcome: "created" });
  const thread = createThread({
    id: threadId(`thread_${suffix}`),
    tenant: personal.tenant,
    user,
    membership: personal.ownerMembership,
    title: `任务 ${suffix}`,
    now: timestamp(1),
  });
  expect(await repositories.threads.create(scope, thread)).toEqual({ outcome: "created" });
  const queued = createRun({ id: runId(`run_${suffix}`), thread, now: timestamp(2) });
  const run = transitionRun(queued, "running", timestamp(3));
  expect(await repositories.runs.create(scope, run)).toEqual({ outcome: "created" });
  const workspace = createWorkspace({
    id: workspaceId(`workspace_${suffix}`),
    thread,
    now: timestamp(4),
  });
  expect(await repositories.workspaces.create(scope, workspace)).toEqual({ outcome: "created" });
  return { scope, thread, run, workspace };
}

async function acquireLease(fixture: Fixture, second = 5): Promise<Workspace> {
  const leased = acquireWorkspaceLease({
    workspace: fixture.workspace,
    rootRun: fixture.run,
    epoch: 1,
    expiresAt: timestamp(50),
    now: timestamp(second),
  });
  expect(await repositories.workspaces.compareAndSetLease(fixture.workspace, leased)).toEqual({
    outcome: "committed",
  });
  return leased;
}

beforeAll(async () => {
  administrativePool = createPostgresPool({ connectionString: databaseUrl, maxConnections: 2 });
  await administrativePool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  pool = createPostgresPool({ connectionString: databaseUrl, schema, maxConnections: 8 });
  repositories = new PgCoreRepositories(pool);
  await migrateUp(pool);
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
  // 测试只删除本进程创建且通过固定前缀验证的隔离 Schema。
  if (!schema.startsWith(`it_${process.pid}_`)) throw new Error("拒绝删除非测试 Schema");
  if (schemaCreated) await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (administrativePool !== undefined) await administrativePool.end();
});

describe("PostgreSQL 核心持久化", () => {
  it("迁移可重复执行、可完整回退并再次向前执行", async () => {
    const first = await migrateUp(pool);
    const second = await migrateUp(pool);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);

    expect(await migrateDown(pool)).toEqual([]);
    const absent = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('workspaces')::text AS table_name",
    );
    expect(absent.rows[0]?.table_name).toBeNull();
    expect(await migrateUp(pool)).toHaveLength(1);
  });

  it("TenantScope 让跨租户实体对调用者不可见", async () => {
    const left = await createFixture("scope_left");
    const right = await createFixture("scope_right");

    expect(await repositories.threads.get(left.scope, right.thread.id)).toBeUndefined();
    expect(await repositories.runs.get(left.scope, right.run.id)).toBeUndefined();
    expect(await repositories.workspaces.getById(left.scope, right.workspace.id)).toBeUndefined();
    expect(await repositories.workspaces.getById(right.scope, right.workspace.id)).toMatchObject({
      id: right.workspace.id,
      tenantId: right.scope.tenantId,
    });
  });

  it("Thread 与 Run 更新使用 updatedAt 乐观条件并可重新装载", async () => {
    const fixture = await createFixture("updates");
    const archived = archiveThread(fixture.thread, timestamp(10));
    expect(
      await repositories.threads.update(fixture.scope, archived, fixture.thread.updatedAt),
    ).toEqual({ outcome: "updated" });
    expect(
      await repositories.threads.update(fixture.scope, archived, fixture.thread.updatedAt),
    ).toEqual({ outcome: "conflict" });
    expect(await repositories.threads.get(fixture.scope, fixture.thread.id)).toMatchObject({
      status: "archived",
      updatedAt: timestamp(10),
    });

    const waiting = transitionRun(fixture.run, "waiting", timestamp(11));
    expect(await repositories.runs.update(fixture.scope, waiting, fixture.run.updatedAt)).toEqual({
      outcome: "updated",
    });
    expect(await repositories.runs.get(fixture.scope, fixture.run.id)).toMatchObject({
      status: "waiting",
      updatedAt: timestamp(11),
    });
  });

  it("相同 revision 与 lease epoch 的并发 CAS 恰好一个成功", async () => {
    const fixture = await createFixture("cas");
    const leased = await acquireLease(fixture);
    const left = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: fixture.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("revision_cas_left"),
      objectKey: "tenant_cas/workspaces/1-left.tar.zst",
      digest: sha256Digest("a".repeat(64)),
      now: timestamp(6),
    });
    const right = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: fixture.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("revision_cas_right"),
      objectKey: "tenant_cas/workspaces/1-right.tar.zst",
      digest: sha256Digest("b".repeat(64)),
      now: timestamp(6),
    });

    const outcomes = await Promise.all([
      repositories.workspaces.commitRevision(left),
      repositories.workspaces.commitRevision(right),
    ]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "committed",
      "revision_conflict",
    ]);
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_revisions WHERE tenant_id = $1 AND workspace_id = $2",
      [fixture.scope.tenantId, fixture.workspace.id],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("数据库时钟拒绝已过期和错误持有者的租约", async () => {
    const expiredFixture = await createFixture("expired");
    const expiredLease = await acquireLease(expiredFixture);
    const renewal = renewWorkspaceLease({
      workspace: expiredLease,
      rootRun: expiredFixture.run,
      epoch: 1,
      expiresAt: timestamp(55),
      now: timestamp(6),
    });
    await pool.query(
      `UPDATE workspace_write_leases SET expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND workspace_id = $2`,
      [expiredFixture.scope.tenantId, expiredFixture.workspace.id],
    );
    expect(await repositories.workspaces.compareAndSetLease(expiredLease, renewal)).toEqual({
      outcome: "lease_lost",
    });
    const takeoverQueued = createRun({
      id: runId("run_expired_takeover"),
      thread: expiredFixture.thread,
      now: timestamp(7),
    });
    const takeoverRun = transitionRun(takeoverQueued, "running", timestamp(8));
    expect(await repositories.runs.create(expiredFixture.scope, takeoverRun)).toEqual({
      outcome: "created",
    });
    const takeover = acquireWorkspaceLease({
      workspace: expiredLease,
      rootRun: takeoverRun,
      epoch: 2,
      expiresAt: timestamp(59),
      now: timestamp(51),
    });
    expect(await repositories.workspaces.compareAndSetLease(expiredLease, takeover)).toEqual({
      outcome: "committed",
    });

    const wrongFixture = await createFixture("wrong_owner");
    const wrongLease = await acquireLease(wrongFixture);
    const otherQueued = createRun({
      id: runId("run_wrong_owner_other"),
      thread: wrongFixture.thread,
      now: timestamp(7),
    });
    const other = transitionRun(otherQueued, "running", timestamp(8));
    expect(await repositories.runs.create(wrongFixture.scope, other)).toEqual({
      outcome: "created",
    });
    await pool.query(
      `UPDATE workspace_write_leases SET root_run_id = $3
        WHERE tenant_id = $1 AND workspace_id = $2`,
      [wrongFixture.scope.tenantId, wrongFixture.workspace.id, other.id],
    );
    const wrongRenewal = renewWorkspaceLease({
      workspace: wrongLease,
      rootRun: wrongFixture.run,
      epoch: 1,
      expiresAt: timestamp(55),
      now: timestamp(9),
    });
    expect(await repositories.workspaces.compareAndSetLease(wrongLease, wrongRenewal)).toEqual({
      outcome: "lease_lost",
    });
    await pool.query(
      `UPDATE workspace_write_leases SET root_run_id = $3, epoch = 2
        WHERE tenant_id = $1 AND workspace_id = $2`,
      [wrongFixture.scope.tenantId, wrongFixture.workspace.id, wrongFixture.run.id],
    );
    expect(await repositories.workspaces.compareAndSetLease(wrongLease, wrongRenewal)).toEqual({
      outcome: "lease_lost",
    });
  });

  it("事务失败会完整回滚且不会留下半条数据", async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, clock_timestamp())", [
          "rollback_user",
        ]);
        throw new Error("注入事务中途失败");
      }),
    ).rejects.toThrow("注入事务中途失败");
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app_users WHERE id = 'rollback_user'",
    );
    expect(result.rows[0]?.count).toBe("0");
  });
});
