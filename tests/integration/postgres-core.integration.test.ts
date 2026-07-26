import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  releaseWorkspaceLease,
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
  type Membership,
  type Tenant,
  type Thread,
  type User,
  type Workspace,
} from "@cube-runtime/domain";
import type { CoreRepositories, TenantScope, WorkspaceWriteScope } from "@cube-runtime/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  PgArchiveThreadCommand,
  PgCoreRepositories,
} from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import {
  createPostgresPool,
  withTenantTransaction,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { bootstrapRuntimeAccess } from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";
import { createApiApp } from "../../runtime-ts/apps/api/src/app.js";
import { createThreadCursorCodec } from "../../runtime-ts/apps/api/src/cursor.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`PostgreSQL 集成测试缺少 ${name}；不会输出配置值`);
  }
  return value;
}

const runtimeDatabaseUrl = requiredEnvironment("DATABASE_URL");
const bootstrapDatabaseUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const migrationDatabaseUrl = requiredEnvironment("MIGRATION_DATABASE_URL");
const runtimeRole = requiredEnvironment("DATABASE_RUNTIME_ROLE");
const configuredMigratorRole = requiredEnvironment("DATABASE_MIGRATOR_ROLE");

const schema = `it_${process.pid}_${Date.now()}`;
const databaseOwnerRole = new URL(bootstrapDatabaseUrl).username;
const databaseName = new URL(bootstrapDatabaseUrl).pathname.slice(1);
const migratorRole = `it_mg_${process.pid}_${Date.now().toString(36)}`;
const migratorPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseOwnerRole)) {
  throw new Error("数据库 Owner 角色名称无效");
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("测试数据库名称无效");
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;
const sourceMigrationDirectory = fileURLToPath(
  new URL("../../runtime-ts/packages/persistence/migrations/", import.meta.url),
);
let administrativePool!: Pool;
let migratorPool!: Pool;
let runtimePool!: Pool;
let repositories!: CoreRepositories;
let schemaCreated = false;
let migratorCreated = false;
let concurrentMigrationVersions: readonly number[] = [];
let isolatedMigrationCounter = 0;

interface Fixture {
  readonly scope: TenantScope;
  readonly writeScope: WorkspaceWriteScope;
  readonly tenant: Tenant;
  readonly user: User;
  readonly membership: Membership;
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
  expect(await repositories.threads.create(scope, thread)).toEqual({
    outcome: "created",
    version: 0n,
  });
  const queued = createRun({ id: runId(`run_${suffix}`), thread, now: timestamp(2) });
  const run = transitionRun(queued, "running", timestamp(3));
  expect(await repositories.runs.create(scope, run)).toEqual({ outcome: "created", version: 0n });
  const workspace = createWorkspace({
    id: workspaceId(`workspace_${suffix}`),
    thread,
    now: timestamp(4),
  });
  expect(await repositories.workspaces.create(scope, workspace)).toEqual({ outcome: "created" });
  return {
    scope,
    writeScope: { tenantId: scope.tenantId, rootRunId: run.id },
    tenant: personal.tenant,
    user,
    membership: personal.ownerMembership,
    thread,
    run,
    workspace,
  };
}

async function acquireLease(fixture: Fixture): Promise<Workspace> {
  const leased = acquireWorkspaceLease({
    workspace: fixture.workspace,
    rootRun: fixture.run,
    epoch: 1,
    expiresAt: timestamp(50),
    now: timestamp(5),
  });
  expect(
    await repositories.workspaces.compareAndSetLease(fixture.writeScope, fixture.workspace, leased),
  ).toEqual({ outcome: "committed" });
  return leased;
}

interface IsolatedMigrationTarget {
  readonly pool: Pool;
  readonly connectionString: string;
  readonly context: {
    readonly runtimeRole: string;
    readonly migratorRole: string;
    readonly schema: string;
  };
  close(): Promise<void>;
}

async function createIsolatedMigrationTarget(suffix: string): Promise<IsolatedMigrationTarget> {
  isolatedMigrationCounter += 1;
  const isolatedSuffix = `${process.pid}_${isolatedMigrationCounter}`;
  const isolatedRole = `it_mg_${isolatedSuffix}`;
  const isolatedSchema = `it_${suffix}_${isolatedSuffix}`;
  const password = randomBytes(24).toString("hex");
  const url = new URL(migrationDatabaseUrl);
  url.username = isolatedRole;
  url.password = password;
  await administrativePool.query(
    `CREATE ROLE "${isolatedRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${isolatedRole}";
     CREATE SCHEMA "${isolatedSchema}" AUTHORIZATION "${isolatedRole}"`,
  );
  const pool = createPostgresPool({
    connectionString: url.toString(),
    schema: isolatedSchema,
    maxConnections: 2,
  });
  let closed = false;
  return {
    pool,
    connectionString: url.toString(),
    context: { runtimeRole, migratorRole: isolatedRole, schema: isolatedSchema },
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
      await administrativePool.query(
        `DROP SCHEMA "${isolatedSchema}" CASCADE;
         REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${isolatedRole}";
         DROP ROLE "${isolatedRole}"`,
      );
    },
  };
}

beforeAll(async () => {
  administrativePool = createPostgresPool({
    connectionString: bootstrapDatabaseUrl,
    maxConnections: 2,
  });
  await administrativePool.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}";
     CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
  );
  migratorCreated = true;
  schemaCreated = true;
  migratorPool = createPostgresPool({
    connectionString: testMigrationUrl.toString(),
    schema,
    maxConnections: 4,
  });
  runtimePool = createPostgresPool({
    connectionString: runtimeDatabaseUrl,
    schema,
    maxConnections: 8,
  });
  const concurrent = await Promise.all([
    migrateUp(migratorPool, migrationSecurity),
    migrateUp(migratorPool, migrationSecurity),
  ]);
  concurrentMigrationVersions = concurrent.flatMap((records) =>
    records.map((record) => record.version),
  );
  repositories = new PgCoreRepositories(runtimePool);
});

afterAll(async () => {
  if (runtimePool !== undefined) await runtimePool.end();
  if (migratorPool !== undefined) await migratorPool.end();
  if (!schema.startsWith(`it_${process.pid}_`)) throw new Error("拒绝删除非测试 Schema");
  if (schemaCreated) await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await administrativePool.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (administrativePool !== undefined) await administrativePool.end();
});

describe("PostgreSQL 迁移与强权限边界", () => {
  it("HTTP API 经真实 PostgreSQL RLS 隔离 Thread/Run 并完成取消", async () => {
    const left = await createFixture("api_left");
    const right = await createFixture("api_right");
    const principals = new Map([
      ["Bearer pg-left", left.scope],
      ["Bearer pg-right", right.scope],
    ]);
    const app = createApiApp(
      {
        auth: {
          resolve: async ({ authorization }) =>
            authorization === undefined ? undefined : principals.get(authorization),
        },
        repositories,
        archiveThread: new PgArchiveThreadCommand(runtimePool),
        cursorCodec: createThreadCursorCodec({
          activeKid: "integration-key",
          keys: [
            {
              kid: "integration-key",
              secret: Buffer.alloc(32, 11).toString("base64url"),
            },
          ],
          clock: { now: () => timestamp(20) },
          ttlMilliseconds: 60_000,
          maximumTtlMilliseconds: 60_000,
        }),
        readiness: { probe: () => runtimePool.query("SELECT 1").then(() => undefined) },
        clock: { now: () => timestamp(20) },
        ids: {
          thread: () => threadId("thread_api_unused"),
          run: () => runId("run_api_unused"),
          workspace: () => workspaceId("workspace_api_unused"),
        },
      },
      { logger: false },
    );
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      const ownThread = await app.inject({
        method: "GET",
        url: `/v1/threads/${left.thread.id}`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(ownThread.statusCode).toBe(200);
      expect(ownThread.json().data.id).toBe(left.thread.id);
      const page = await app.inject({
        method: "GET",
        url: "/v1/threads?limit=10",
        headers: { authorization: "Bearer pg-left" },
      });
      expect(page.json().data.items.map((item: { id: string }) => item.id)).toEqual([
        left.thread.id,
      ]);
      const crossTenant = await app.inject({
        method: "GET",
        url: `/v1/threads/${left.thread.id}/runs/${left.run.id}`,
        headers: {
          authorization: "Bearer pg-right",
          "x-tenant-id": left.scope.tenantId,
        },
      });
      expect(crossTenant.statusCode).toBe(404);
      expect(crossTenant.json().error.code).toBe("NOT_FOUND");

      const cancelled = await app.inject({
        method: "DELETE",
        url: `/v1/threads/${left.thread.id}/runs/${left.run.id}`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().data.status).toBe("cancelled");
      const archived = await app.inject({
        method: "DELETE",
        url: `/v1/threads/${left.thread.id}`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().data.status).toBe("archived");
    } finally {
      await app.close();
    }
  });

  it("归档命令等待 Membership 行锁，并在降权提交后拒绝归档", async () => {
    const fixture = await createFixture("archive_membership_race");
    const command = new PgArchiveThreadCommand(runtimePool);
    const blocker = await administrativePool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT role FROM "${schema}".memberships
          WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [fixture.scope.tenantId, fixture.scope.userId],
      );
      const pending = command.archiveThread({
        scope: fixture.scope,
        threadId: fixture.thread.id,
      });
      // 先持有 Membership 锁，再提交降权，确保命令必须读取锁后的授权事实。
      await blocker.query(
        `UPDATE "${schema}".memberships SET role = 'member'
          WHERE tenant_id = $1 AND user_id = $2`,
        [fixture.scope.tenantId, fixture.scope.userId],
      );
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ outcome: "not_authorized" });
      const stored = await withTenantTransaction(runtimePool, fixture.scope, (client) =>
        client.query<{ status: string }>(
          "SELECT status FROM threads WHERE tenant_id = $1 AND id = $2",
          [fixture.scope.tenantId, fixture.thread.id],
        ),
      );
      expect(stored.rows[0]?.status).toBe("active");
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
  });

  it("Runtime 不能修改 Membership 的 status、role 或其他授权字段", async () => {
    const fixture = await createFixture("membership_acl");
    for (const statement of [
      "UPDATE memberships SET status = 'revoked' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET role = 'member' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET id = id || '_changed' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET user_id = user_id || '_changed' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET tenant_id = tenant_id || '_changed' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET created_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2",
    ]) {
      await expect(
        withTenantTransaction(runtimePool, fixture.scope, (client) =>
          client.query(statement, [fixture.scope.tenantId, fixture.scope.userId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("归档等待 Thread 锁后使用数据库时间，并保持 updated_at 单调", async () => {
    const fixture = await createFixture("archive_database_time");
    const command = new PgArchiveThreadCommand(runtimePool);
    const blocker = await administrativePool.connect();
    let pendingSettled = false;
    try {
      await blocker.query(
        `UPDATE "${schema}".threads
            SET updated_at = clock_timestamp() - interval '1 day'
          WHERE tenant_id = $1 AND id = $2`,
        [fixture.scope.tenantId, fixture.thread.id],
      );
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT status FROM "${schema}".threads
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [fixture.scope.tenantId, fixture.thread.id],
      );
      const pending = command
        .archiveThread({ scope: fixture.scope, threadId: fixture.thread.id })
        .finally(() => {
          pendingSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(pendingSettled).toBe(false);
      const lowerBound = await blocker.query<{ current_time: Date }>(
        "SELECT clock_timestamp() AS current_time",
      );
      await blocker.query("COMMIT");
      const result = await pending;
      expect(result.outcome).toBe("archived");
      const stored = await withTenantTransaction(runtimePool, fixture.scope, (client) =>
        client.query<{ status: string; updated_at: Date }>(
          "SELECT status, updated_at FROM threads WHERE tenant_id = $1 AND id = $2",
          [fixture.scope.tenantId, fixture.thread.id],
        ),
      );
      const updatedAt = stored.rows[0]?.updated_at;
      const releasedAt = lowerBound.rows[0]?.current_time;
      if (updatedAt === undefined || releasedAt === undefined)
        throw new Error("测试数据库时间缺失");
      expect(stored.rows[0]?.status).toBe("archived");
      expect(updatedAt.valueOf()).toBeGreaterThanOrEqual(releasedAt.valueOf());
      if (result.outcome === "archived")
        expect(result.entity.updatedAt).toBe(updatedAt.toISOString());
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
  });

  it("并发迁移串行化且重复执行结果一致", async () => {
    expect(concurrentMigrationVersions).toEqual([1, 2, 3, 1, 2, 3]);
    expect(await migrateUp(migratorPool, migrationSecurity)).toHaveLength(3);
  });

  it("checksum 同时绑定 down SQL，并拒绝孤立和重复版本", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "cube-pg-migration-"));
    const orphan = await mkdtemp(join(tmpdir(), "cube-pg-orphan-"));
    try {
      await Promise.all([
        copyFile(
          join(sourceMigrationDirectory, "0001_core.up.sql"),
          join(temporary, "0001_core.up.sql"),
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_core.down.sql"),
          join(temporary, "0001_core.down.sql"),
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_core.up.sql"),
          join(orphan, "0001_core.up.sql"),
        ),
      ]);
      await writeFile(join(temporary, "0001_core.down.sql"), "SELECT 'down 已被篡改';\n", "utf8");
      await expect(
        migrateUp(migratorPool, { ...migrationSecurity, directory: temporary }),
      ).rejects.toMatchObject({
        code: "MIGRATION_MISMATCH",
      });
      await expect(loadMigrations({ directory: orphan })).rejects.toThrow("未成对");
      await Promise.all([
        copyFile(
          join(sourceMigrationDirectory, "0001_core.up.sql"),
          join(orphan, "0001_other.up.sql"),
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_core.down.sql"),
          join(orphan, "0001_other.down.sql"),
        ),
      ]);
      await expect(loadMigrations({ directory: orphan })).rejects.toThrow("版本 1 重复");
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(orphan, { recursive: true, force: true });
    }
  });

  it("down 的 DDL 与 ACL 收敛失败时整体回滚", async () => {
    await administrativePool.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${runtimeRole}"`,
    );
    try {
      await expect(
        migrateDown(migratorPool, {
          allowDestructive: true,
          environment: "test",
          ...migrationSecurity,
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const state = await migratorPool.query<{ threads: string | null; migration_count: string }>(
        `SELECT to_regclass('threads')::text AS threads,
                (SELECT count(*)::text FROM runtime_schema_migrations) AS migration_count`,
      );
      expect(state.rows[0]).toMatchObject({ threads: "threads", migration_count: "3" });
    } finally {
      await administrativePool.query(
        `GRANT CONNECT ON DATABASE "${databaseName}" TO "${runtimeRole}"`,
      );
    }
  });

  it("down 只有显式 test 授权可执行并能再次向前", async () => {
    await expect(
      migrateDown(migratorPool, {
        allowDestructive: false as true,
        environment: "test",
        ...migrationSecurity,
      }),
    ).rejects.toThrow("禁止破坏性");
    expect(
      await migrateDown(migratorPool, {
        allowDestructive: true,
        environment: "test",
        ...migrationSecurity,
      }),
    ).toEqual([]);
    const usageAfterDown = await migratorPool.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege($1, current_schema(), 'USAGE') AS allowed",
      [runtimeRole],
    );
    expect(usageAfterDown.rows[0]?.allowed).toBe(false);
    const downPrivileges = await migratorPool.query<{ privilege: string; allowed: boolean }>(
      `SELECT requested.privilege,
              has_table_privilege($1, 'runtime_schema_migrations', requested.privilege) AS allowed
         FROM unnest($2::text[]) AS requested(privilege)`,
      [runtimeRole, ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]],
    );
    expect(downPrivileges.rows.every((entry) => !entry.allowed)).toBe(true);
    const routineState = await migratorPool.query<{
      routine_count: string;
      default_acl_count: string;
    }>(
      `SELECT (SELECT count(*)::text FROM pg_proc
                WHERE pronamespace = current_schema()::regnamespace) AS routine_count,
              (SELECT count(*)::text
                 FROM pg_default_acl defaults
                WHERE defaults.defaclrole = $1::regrole
                  AND defaults.defaclobjtype = 'f') AS default_acl_count`,
      [migratorRole],
    );
    expect(routineState.rows[0]).toEqual({ routine_count: "0", default_acl_count: "0" });
    expect(await migrateUp(migratorPool, migrationSecurity)).toHaveLength(3);
  });

  it("Runtime 角色不安全时在任何迁移 DDL 之前失败", async () => {
    const unsafeParentRole = `it_unsafe_parent_${process.pid}`;
    const unsafeChildRole = `it_unsafe_child_${process.pid}`;
    const unsafeTableOwnerRole = `it_unsafe_table_${process.pid}`;
    await administrativePool.query(
      `CREATE ROLE "${unsafeParentRole}" NOLOGIN CREATEDB;
       CREATE ROLE "${unsafeChildRole}" NOLOGIN NOINHERIT;
       CREATE ROLE "${unsafeTableOwnerRole}" NOLOGIN;
       GRANT "${unsafeParentRole}" TO "${unsafeChildRole}"`,
    );
    try {
      const cases = [
        { suffix: "inherited", role: unsafeChildRole },
        { suffix: "database_owner", role: databaseOwnerRole },
        { suffix: "table_owner", role: unsafeTableOwnerRole },
      ] as const;
      for (const unsafe of cases) {
        const target = await createIsolatedMigrationTarget(unsafe.suffix);
        if (unsafe.suffix === "table_owner") {
          await administrativePool.query(
            `CREATE TABLE "${target.context.schema}".owned_seed(id integer);
             ALTER TABLE "${target.context.schema}".owned_seed OWNER TO "${unsafeTableOwnerRole}"`,
          );
        }
        try {
          await expect(
            migrateUp(target.pool, { ...target.context, runtimeRole: unsafe.role }),
          ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
          const migrationTable = await target.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          );
          expect(migrationTable.rows[0]?.name).toBeNull();
          if (unsafe.suffix === "inherited") {
            await expect(
              migrateDown(target.pool, {
                allowDestructive: true,
                environment: "test",
                ...target.context,
                runtimeRole: unsafe.role,
              }),
            ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
            expect(
              (
                await target.pool.query<{ name: string | null }>(
                  "SELECT to_regclass('runtime_schema_migrations')::text AS name",
                )
              ).rows[0]?.name,
            ).toBeNull();
          }
        } finally {
          await target.close();
        }
      }

      const ownerTarget = await createIsolatedMigrationTarget("schema_owner");
      try {
        await expect(
          migrateUp(ownerTarget.pool, {
            ...ownerTarget.context,
            runtimeRole: ownerTarget.context.migratorRole,
          }),
        ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
        expect(
          (
            await ownerTarget.pool.query<{ name: string | null }>(
              "SELECT to_regclass('runtime_schema_migrations')::text AS name",
            )
          ).rows[0]?.name,
        ).toBeNull();
      } finally {
        await ownerTarget.close();
      }
    } finally {
      await administrativePool.query(
        `REVOKE "${unsafeParentRole}" FROM "${unsafeChildRole}";
         DROP ROLE "${unsafeChildRole}";
         DROP ROLE "${unsafeParentRole}";
         DROP ROLE "${unsafeTableOwnerRole}"`,
      );
    }
  });

  it("up/down 在 Runtime 有 Schema CREATE 或数据库 TEMP 时不产生任何 DDL", async () => {
    const upTarget = await createIsolatedMigrationTarget("runtime_schema_create");
    try {
      await administrativePool.query(
        `GRANT CREATE ON SCHEMA "${upTarget.context.schema}" TO PUBLIC`,
      );
      await expect(migrateUp(upTarget.pool, upTarget.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const upObjects = await upTarget.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
          WHERE relnamespace = current_schema()::regnamespace
            AND relname IN ('runtime_schema_migrations', 'threads', 'runs', 'workspaces')`,
      );
      expect(upObjects.rows[0]?.count).toBe("0");
    } finally {
      await administrativePool.query(
        `REVOKE CREATE ON SCHEMA "${upTarget.context.schema}" FROM PUBLIC`,
      );
      await upTarget.close();
    }

    const downTarget = await createIsolatedMigrationTarget("runtime_database_temp");
    await administrativePool.query(
      `GRANT TEMPORARY ON DATABASE "${databaseName}" TO "${runtimeRole}"`,
    );
    try {
      await expect(
        migrateDown(downTarget.pool, {
          ...downTarget.context,
          allowDestructive: true,
          environment: "test",
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const downObjects = await downTarget.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
          WHERE relnamespace = current_schema()::regnamespace
            AND relname IN ('runtime_schema_migrations', 'threads', 'runs', 'workspaces')`,
      );
      expect(downObjects.rows[0]?.count).toBe("0");
    } finally {
      await administrativePool.query(
        `REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM "${runtimeRole}"`,
      );
      await downTarget.close();
    }
  });

  it("首次 up 的 ACL 白名单失败时回滚全部业务 DDL", async () => {
    const target = await createIsolatedMigrationTarget("atomic_up");
    try {
      await target.pool.query("CREATE TABLE unexpected_seed(id integer)");
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const objects = await target.pool.query<{
        migration_table: string | null;
        business_table: string | null;
        seed_table: string | null;
      }>(
        `SELECT to_regclass('runtime_schema_migrations')::text AS migration_table,
                to_regclass('threads')::text AS business_table,
                to_regclass('unexpected_seed')::text AS seed_table`,
      );
      expect(objects.rows[0]).toEqual({
        migration_table: null,
        business_table: null,
        seed_table: "unexpected_seed",
      });
    } finally {
      await target.close();
    }
  });

  it("migration SQL 创建 routine 时整次 up 回滚", async () => {
    const target = await createIsolatedMigrationTarget("migration_routine");
    const temporary = await mkdtemp(join(tmpdir(), "cube-pg-routine-migration-"));
    try {
      const originalUp = await readFile(join(sourceMigrationDirectory, "0001_core.up.sql"), "utf8");
      await Promise.all([
        writeFile(
          join(temporary, "0001_core.up.sql"),
          `${originalUp}\nCREATE FUNCTION forbidden_migration() RETURNS integer LANGUAGE sql AS 'SELECT 1';\n`,
          "utf8",
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_core.down.sql"),
          join(temporary, "0001_core.down.sql"),
        ),
      ]);
      await expect(
        migrateUp(target.pool, { ...target.context, directory: temporary }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const objects = await target.pool.query<{
        migration_table: string | null;
        business_table: string | null;
        routine: string | null;
      }>(
        `SELECT to_regclass('runtime_schema_migrations')::text AS migration_table,
                to_regclass('threads')::text AS business_table,
                to_regprocedure('forbidden_migration()')::text AS routine`,
      );
      expect(objects.rows[0]).toEqual({
        migration_table: null,
        business_table: null,
        routine: null,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await target.close();
    }
  });

  it("Migrator 不得拥有目标以外 Schema 或跨 Schema 对象", async () => {
    const target = await createIsolatedMigrationTarget("migrator_ownership");
    const extraSchema = `${target.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${target.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await administrativePool.query(
        `ALTER SCHEMA "${extraSchema}" OWNER TO "${databaseOwnerRole}";
         CREATE TABLE "${extraSchema}".foreign_owned(id integer);
         ALTER TABLE "${extraSchema}".foreign_owned OWNER TO "${target.context.migratorRole}"`,
      );
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const migrationTable = await target.pool.query<{ name: string | null }>(
        "SELECT to_regclass('runtime_schema_migrations')::text AS name",
      );
      expect(migrationTable.rows[0]?.name).toBeNull();
    } finally {
      await administrativePool.query(`DROP SCHEMA "${extraSchema}" CASCADE`);
      await target.close();
    }
  });

  it("目标 SECURITY DEFINER 与跨 Schema routine 均在首个 DDL 前拒绝", async () => {
    const targetRoutine = await createIsolatedMigrationTarget("target_routine");
    try {
      await targetRoutine.pool.query(
        `CREATE FUNCTION forbidden_target() RETURNS integer
           LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
      );
      await expect(migrateUp(targetRoutine.pool, targetRoutine.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const targetObjects = await targetRoutine.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
          WHERE relnamespace = current_schema()::regnamespace
            AND relname IN ('runtime_schema_migrations', 'threads', 'runs')`,
      );
      expect(targetObjects.rows[0]?.count).toBe("0");
    } finally {
      await targetRoutine.close();
    }

    const crossRoutine = await createIsolatedMigrationTarget("cross_routine");
    const extraSchema = `${crossRoutine.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${databaseOwnerRole}";
       CREATE FUNCTION "${extraSchema}".forbidden_cross() RETURNS integer
         LANGUAGE sql AS 'SELECT 1';
       ALTER FUNCTION "${extraSchema}".forbidden_cross()
         OWNER TO "${crossRoutine.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(crossRoutine.pool, crossRoutine.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await crossRoutine.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await administrativePool.query(`DROP SCHEMA "${extraSchema}" CASCADE`);
      await crossRoutine.close();
    }
  });

  it("目标与跨 Schema 的 Migrator-owned 独立 type 均在首个 DDL 前拒绝", async () => {
    const targetType = await createIsolatedMigrationTarget("target_type");
    try {
      await targetType.pool.query("CREATE TYPE forbidden_target_type AS ENUM ('blocked')");
      await expect(migrateUp(targetType.pool, targetType.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await targetType.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await targetType.close();
    }

    const crossType = await createIsolatedMigrationTarget("cross_type");
    const extraSchema = `${crossType.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${databaseOwnerRole}";
       CREATE TYPE "${extraSchema}".forbidden_cross_type AS ENUM ('blocked');
       ALTER TYPE "${extraSchema}".forbidden_cross_type
         OWNER TO "${crossType.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(crossType.pool, crossType.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await crossType.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await administrativePool.query(`DROP SCHEMA "${extraSchema}" CASCADE`);
      await crossType.close();
    }
  });

  it("任意 routine 默认 ACL 记录都在首个 DDL 前拒绝", async () => {
    const localTarget = await createIsolatedMigrationTarget("local_default_acl");
    try {
      await localTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${localTarget.context.schema}"
           GRANT EXECUTE ON ROUTINES TO PUBLIC, "${runtimeRole}"`,
      );
      await expect(migrateUp(localTarget.pool, localTarget.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await localTarget.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await localTarget.close();
    }

    const thirdPartyRole = `it_acl_grantee_${process.pid}`;
    const thirdPartyTarget = await createIsolatedMigrationTarget("third_default_acl");
    await administrativePool.query(`CREATE ROLE "${thirdPartyRole}" NOLOGIN`);
    try {
      await thirdPartyTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${thirdPartyTarget.context.schema}"
           GRANT EXECUTE ON ROUTINES TO "${thirdPartyRole}"`,
      );
      await expect(
        migrateUp(thirdPartyTarget.pool, thirdPartyTarget.context),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    } finally {
      await thirdPartyTarget.close();
      await administrativePool.query(`DROP ROLE "${thirdPartyRole}"`);
    }

    const globalTarget = await createIsolatedMigrationTarget("global_default_acl");
    try {
      await globalTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${globalTarget.context.migratorRole}"
           REVOKE EXECUTE ON ROUTINES FROM PUBLIC`,
      );
      await expect(migrateUp(globalTarget.pool, globalTarget.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
    } finally {
      await globalTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${globalTarget.context.migratorRole}"
           GRANT EXECUTE ON ROUTINES TO PUBLIC`,
      );
      await globalTarget.close();
    }
  });

  it("Migrator 对无关 Schema 的有效 CREATE 在首个 DDL 前拒绝", async () => {
    const target = await createIsolatedMigrationTarget("foreign_schema_create");
    const extraSchema = `${target.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${databaseOwnerRole}";
       GRANT CREATE ON SCHEMA "${extraSchema}" TO "${target.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await target.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await administrativePool.query(
        `REVOKE CREATE ON SCHEMA "${extraSchema}" FROM "${target.context.migratorRole}";
         DROP SCHEMA "${extraSchema}" CASCADE`,
      );
      await target.close();
    }
  });

  it("Migrator 或 search_path 不安全时在任何迁移 DDL 之前失败", async () => {
    const parentRole = `it_migrator_parent_${process.pid}`;
    const target = await createIsolatedMigrationTarget("migrator_guard");
    await administrativePool.query(
      `CREATE ROLE "${parentRole}" NOLOGIN;
       GRANT "${parentRole}" TO "${target.context.migratorRole}"`,
    );
    const wrongSearchPathPool = createPostgresPool({
      connectionString: target.connectionString,
      maxConnections: 2,
    });
    const databaseOwnerPool = createPostgresPool({
      connectionString: bootstrapDatabaseUrl,
      schema: target.context.schema,
      maxConnections: 2,
    });
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await administrativePool.query(
        `REVOKE "${parentRole}" FROM "${target.context.migratorRole}"`,
      );
      await expect(migrateUp(wrongSearchPathPool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await administrativePool.query(
        `ALTER SCHEMA "${target.context.schema}" OWNER TO "${databaseOwnerRole}"`,
      );
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await expect(
        migrateUp(databaseOwnerPool, {
          runtimeRole,
          migratorRole: databaseOwnerRole,
          schema: target.context.schema,
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const migrationTable = await administrativePool.query<{ name: string | null }>(
        "SELECT to_regclass(format('%I.runtime_schema_migrations', $1::text))::text AS name",
        [target.context.schema],
      );
      expect(migrationTable.rows[0]?.name).toBeNull();
    } finally {
      await wrongSearchPathPool.end();
      await databaseOwnerPool.end();
      await administrativePool.query(
        `REVOKE "${parentRole}" FROM "${target.context.migratorRole}";
         DROP ROLE "${parentRole}"`,
      );
      await target.close();
    }
  });

  it("bootstrap 先拒绝上游角色，再清除 PUBLIC 残留授权", async () => {
    const parentRole = `it_runtime_parent_${process.pid}`;
    await administrativePool.query(`CREATE ROLE "${parentRole}" NOLOGIN`);
    await migratorPool.query(
      `GRANT ALL PRIVILEGES ON SCHEMA "${schema}" TO PUBLIC;
       GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schema}" TO PUBLIC;
       GRANT ALL PRIVILEGES ON TABLE "${schema}".threads TO "${parentRole}"`,
    );
    await administrativePool.query(`GRANT "${parentRole}" TO "${runtimeRole}"`);
    try {
      await expect(bootstrapRuntimeAccess(migratorPool, migrationSecurity)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const publicBefore = await migratorPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(relation.relacl) acl
          WHERE relation.relnamespace = current_schema()::regnamespace
            AND relation.relkind IN ('r', 'p') AND acl.grantee = 0`,
      );
      // 若 preflight 之后才检查成员关系，这里的 PUBLIC 攻击性授权会已被错误修改。
      expect(Number(publicBefore.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await administrativePool.query(`REVOKE "${parentRole}" FROM "${runtimeRole}"`);
      await migratorPool.query(
        `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schema}" FROM "${parentRole}"`,
      );
      await administrativePool.query(`DROP ROLE "${parentRole}"`);
    }
    await bootstrapRuntimeAccess(migratorPool, migrationSecurity);
    const publicAfter = await migratorPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_class relation
         CROSS JOIN LATERAL aclexplode(
           COALESCE(relation.relacl, acldefault('r'::"char", relation.relowner))
         ) acl
        WHERE relation.relnamespace = current_schema()::regnamespace
          AND relation.relkind IN ('r', 'p') AND acl.grantee = 0`,
    );
    expect(publicAfter.rows[0]?.count).toBe("0");
  });

  it("空 routine manifest 令 Runtime 与 PUBLIC 的 EXECUTE 集合自然为空", async () => {
    const privileges = await migratorPool.query<{
      routine_count: string;
      runtime_execute_count: string;
      public_execute_count: string;
    }>(
      `SELECT count(*)::text AS routine_count,
              count(*) FILTER (
                WHERE has_function_privilege($1, routine.oid, 'EXECUTE')
              )::text AS runtime_execute_count,
              count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM aclexplode(
                    COALESCE(routine.proacl, acldefault('f'::"char", routine.proowner))
                  ) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                )
              )::text AS public_execute_count
         FROM pg_proc routine
        WHERE routine.pronamespace = current_schema()::regnamespace`,
      [runtimeRole],
    );
    expect(privileges.rows[0]).toEqual({
      routine_count: "0",
      runtime_execute_count: "0",
      public_execute_count: "0",
    });
  });

  it("Runtime 角色不能 DDL、创建 Schema 或绕过 RLS 跨租户写", async () => {
    const roles = await administrativePool.query<{
      migrator_schema_owner: string;
      database_owner: string;
      runtime_super: boolean;
      runtime_bypass_rls: boolean;
      runtime_can_create_database: boolean;
    }>(
      `SELECT pg_get_userbyid(n.nspowner) AS migrator_schema_owner,
              pg_get_userbyid(d.datdba) AS database_owner,
              r.rolsuper AS runtime_super,
              r.rolbypassrls AS runtime_bypass_rls,
              has_database_privilege($1, current_database(), 'CREATE') AS runtime_can_create_database
         FROM pg_database d CROSS JOIN pg_roles r CROSS JOIN pg_namespace n
        WHERE d.datname = current_database() AND r.rolname = $1 AND n.nspname = $2`,
      [runtimeRole, schema],
    );
    expect(roles.rows[0]).toMatchObject({
      migrator_schema_owner: migratorRole,
      database_owner: databaseOwnerRole,
      runtime_super: false,
      runtime_bypass_rls: false,
      runtime_can_create_database: false,
    });
    expect(roles.rows[0]?.database_owner).not.toBe(migratorRole);
    expect(roles.rows[0]?.migrator_schema_owner).not.toBe(runtimeRole);
    const expectedPolicy = new Map<string, ReadonlySet<string>>([
      ["app_users", new Set(["SELECT", "INSERT"])],
      ["tenants", new Set(["SELECT", "INSERT"])],
      ["memberships", new Set(["SELECT", "INSERT"])],
      ["threads", new Set(["SELECT", "INSERT", "UPDATE"])],
      ["runs", new Set(["SELECT", "INSERT", "UPDATE"])],
      ["workspaces", new Set(["SELECT", "INSERT", "UPDATE"])],
      ["workspace_revisions", new Set(["SELECT", "INSERT"])],
      ["workspace_write_leases", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
      ["blob_lifecycles", new Set(["SELECT", "INSERT"])],
      ["blob_incarnations", new Set(["SELECT", "INSERT"])],
      ["blob_allocations", new Set(["SELECT", "INSERT"])],
      ["blob_commits", new Set(["SELECT", "INSERT"])],
      ["promotion_authorizations", new Set(["SELECT", "INSERT"])],
      ["promotion_executions", new Set(["SELECT", "INSERT"])],
      ["blob_gc_claims", new Set(["SELECT", "INSERT"])],
      ["retired_blob_tombstones", new Set(["SELECT", "INSERT"])],
      ["blob_references", new Set(["SELECT", "INSERT"])],
      ["runtime_schema_migrations", new Set()],
    ]);
    const allPrivileges = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ];
    const privilegeMatrix = await migratorPool.query<{
      table_name: string;
      privilege: string;
      allowed: boolean;
    }>(
      `SELECT target.table_name, requested.privilege,
              has_table_privilege(
                $1, format('%I.%I', current_schema()::text, target.table_name), requested.privilege
              ) AS allowed
         FROM unnest($2::text[]) AS target(table_name)
         CROSS JOIN unnest($3::text[]) AS requested(privilege)`,
      [runtimeRole, [...expectedPolicy.keys()], allPrivileges],
    );
    expect(privilegeMatrix.rows).toHaveLength(expectedPolicy.size * allPrivileges.length);
    for (const entry of privilegeMatrix.rows) {
      expect(entry.allowed, `${entry.table_name}:${entry.privilege}`).toBe(
        expectedPolicy.get(entry.table_name)?.has(entry.privilege),
      );
    }
    const expectedColumnUpdates = new Map<string, ReadonlySet<string>>([
      [
        "blob_lifecycles",
        new Set([
          "state",
          "current_incarnation_id",
          "generation",
          "current_claim_id",
          "lease_expires_at",
          "updated_at",
        ]),
      ],
      ["blob_incarnations", new Set(["state", "retired_at"])],
      ["blob_commits", new Set(["status", "version", "snapshot", "updated_at"])],
      [
        "promotion_authorizations",
        new Set(["state", "current_execution_id", "execution_generation", "updated_at"]),
      ],
      ["promotion_executions", new Set(["phase", "proof_status", "updated_at"])],
      ["blob_gc_claims", new Set(["phase", "updated_at"])],
      [
        "retired_blob_tombstones",
        new Set(["generation", "scrub_lease_expires_at", "next_scrub_at", "last_scrubbed_at"]),
      ],
      [
        "blob_references",
        new Set(["state", "lifecycle_id", "incarnation_id", "physical_object_key", "updated_at"]),
      ],
    ]);
    const columnMatrix = await migratorPool.query<{
      table_name: string;
      column_name: string;
      allowed: boolean;
    }>(
      `SELECT column_state.table_name, column_state.column_name,
              has_column_privilege(
                $1,
                format('%I.%I', current_schema()::text, column_state.table_name),
                column_state.column_name,
                'UPDATE'
              ) AS allowed
         FROM information_schema.columns column_state
        WHERE column_state.table_schema = current_schema()
          AND column_state.table_name = ANY($2::text[])`,
      [runtimeRole, [...expectedColumnUpdates.keys()]],
    );
    for (const entry of columnMatrix.rows) {
      expect(entry.allowed, `${entry.table_name}.${entry.column_name}:UPDATE`).toBe(
        expectedColumnUpdates.get(entry.table_name)?.has(entry.column_name),
      );
    }
    const effectiveBoundary = await migratorPool.query<{
      schema_usage: boolean;
      schema_create: boolean;
      database_connect: boolean;
      database_create: boolean;
      database_temporary: boolean;
    }>(
      `SELECT has_schema_privilege($1, current_schema(), 'USAGE') AS schema_usage,
              has_schema_privilege($1, current_schema(), 'CREATE') AS schema_create,
              has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
              has_database_privilege($1, current_database(), 'CREATE') AS database_create,
              has_database_privilege($1, current_database(), 'TEMP') AS database_temporary`,
      [runtimeRole],
    );
    expect(effectiveBoundary.rows[0]).toEqual({
      schema_usage: true,
      schema_create: false,
      database_connect: true,
      database_create: false,
      database_temporary: false,
    });
    const sequenceCount = await migratorPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'S'",
    );
    expect(sequenceCount.rows[0]?.count).toBe("0");
    await expect(
      runtimePool.query("CREATE TABLE forbidden_runtime_ddl(id integer)"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(runtimePool.query(`CREATE SCHEMA "${schema}_forbidden"`)).rejects.toMatchObject({
      code: "42501",
    });
    const left = await createFixture("rls_left");
    const right = await createFixture("rls_right");
    await expect(
      withTenantTransaction(runtimePool, left.scope, (client) =>
        client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
           VALUES ($1,'cross_tenant_write',$2,'越权','active',clock_timestamp(),clock_timestamp())`,
          [right.scope.tenantId, right.scope.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgreSQL Repository 与并发条件", () => {
  it("双方 Membership 活动时可恢复不同 Tenant/Thread 创建者", async () => {
    const teamTenantId = tenantId("tenant_team_mapping");
    const tenantCreatorId = userId("user_team_creator");
    const threadCreatorId = userId("user_thread_creator");
    await withTenantTransaction(
      runtimePool,
      { tenantId: teamTenantId, userId: tenantCreatorId },
      async (client) => {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, $2)", [
          tenantCreatorId,
          timestamp(0),
        ]);
        await client.query(
          `INSERT INTO tenants(id,kind,display_name,created_by_user_id,created_at)
           VALUES ($1,'team','映射测试团队',$2,$3)`,
          [teamTenantId, tenantCreatorId, timestamp(0)],
        );
        await client.query(
          `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
           VALUES ($1,'membership_team_creator',$2,'owner','active',$3)`,
          [teamTenantId, tenantCreatorId, timestamp(0)],
        );
      },
    );
    await withTenantTransaction(
      runtimePool,
      { tenantId: teamTenantId, userId: threadCreatorId },
      async (client) => {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, $2)", [
          threadCreatorId,
          timestamp(1),
        ]);
        await client.query(
          `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
           VALUES ($1,'membership_thread_creator',$2,'member','active',$3)`,
          [teamTenantId, threadCreatorId, timestamp(1)],
        );
        await client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
           VALUES ($1,'thread_team_mapping',$2,'团队任务','active',$3,$3)`,
          [teamTenantId, threadCreatorId, timestamp(2)],
        );
      },
    );
    const restored = await repositories.threads.get(
      { tenantId: teamTenantId, userId: threadCreatorId },
      threadId("thread_team_mapping"),
    );
    expect(restored?.entity).toMatchObject({
      tenantId: teamTenantId,
      createdByUserId: threadCreatorId,
      title: "团队任务",
    });
  });

  it("TenantScope 让跨租户实体不可见", async () => {
    const left = await createFixture("scope_left");
    const right = await createFixture("scope_right");
    expect(await repositories.threads.get(left.scope, right.thread.id)).toBeUndefined();
    expect(await repositories.runs.get(left.scope, right.run.id)).toBeUndefined();
    expect(await repositories.workspaces.getById(left.scope, right.workspace.id)).toBeUndefined();
    expect((await repositories.workspaces.getById(right.scope, right.workspace.id))?.id).toBe(
      right.workspace.id,
    );
  });

  it("相同时间戳和 version 的 Thread/Run CAS 都只有一个更新成功", async () => {
    const threadFixture = await createFixture("thread_version");
    const archived = archiveThread(threadFixture.thread, timestamp(10));
    const threadResults = await Promise.all([
      repositories.threads.update(threadFixture.scope, archived, 0n),
      repositories.threads.update(threadFixture.scope, archived, 0n),
    ]);
    expect(threadResults.map((result) => result.outcome).sort()).toEqual(["conflict", "updated"]);
    expect(
      (await repositories.threads.get(threadFixture.scope, threadFixture.thread.id))?.version,
    ).toBe(1n);

    const runFixture = await createFixture("run_version");
    const waiting = transitionRun(runFixture.run, "waiting", timestamp(10));
    const runResults = await Promise.all([
      repositories.runs.update(runFixture.scope, waiting, 0n),
      repositories.runs.update(runFixture.scope, waiting, 0n),
    ]);
    expect(runResults.map((result) => result.outcome).sort()).toEqual(["conflict", "updated"]);
    expect((await repositories.runs.get(runFixture.scope, runFixture.run.id))?.version).toBe(1n);
  });

  it("Run 更新拒绝合法 wrong-parent 碰撞 id，并保持数据库真实父级", async () => {
    const fixture = await createFixture("run_wrong_parent");
    const otherThread = createThread({
      id: threadId("thread_run_wrong_parent_other"),
      tenant: fixture.tenant,
      user: fixture.user,
      membership: fixture.membership,
      title: "另一个合法任务",
      now: timestamp(8),
    });
    expect(await repositories.threads.create(fixture.scope, otherThread)).toMatchObject({
      outcome: "created",
    });
    const collidingQueued = createRun({
      id: fixture.run.id,
      thread: otherThread,
      now: timestamp(9),
    });
    const collidingRunning = transitionRun(collidingQueued, "running", timestamp(10));
    const collidingWaiting = transitionRun(collidingRunning, "waiting", timestamp(11));
    expect(await repositories.runs.update(fixture.scope, collidingWaiting, 0n)).toEqual({
      outcome: "conflict",
    });
    const stored = await repositories.runs.get(fixture.scope, fixture.run.id);
    expect(stored).toMatchObject({
      version: 0n,
      entity: { threadId: fixture.thread.id, status: "running" },
    });
  });

  it("真实父 Thread 归档与 Run 更新按 Thread→Run 固定锁序完成", async () => {
    const fixture = await createFixture("run_archive_race");
    const archived = archiveThread(fixture.thread, timestamp(12));
    const waiting = transitionRun(fixture.run, "waiting", timestamp(12));
    const [archiveResult, runResult] = await Promise.all([
      repositories.threads.update(fixture.scope, archived, 0n),
      repositories.runs.update(fixture.scope, waiting, 0n),
    ]);
    expect(archiveResult.outcome).toBe("updated");
    expect(runResult.outcome).toBe("updated");
    expect((await repositories.runs.get(fixture.scope, fixture.run.id))?.entity).toMatchObject({
      threadId: fixture.thread.id,
      status: "waiting",
    });
  });

  it("Thread 归档后拒绝创建 Run 和 Workspace", async () => {
    const fixture = await createFixture("archived_parent");
    const archived = archiveThread(fixture.thread, timestamp(12));
    expect(await repositories.threads.update(fixture.scope, archived, 0n)).toMatchObject({
      outcome: "updated",
    });
    const queued = createRun({
      id: runId("run_after_archive"),
      thread: fixture.thread,
      now: timestamp(13),
    });
    expect(await repositories.runs.create(fixture.scope, queued)).toEqual({ outcome: "conflict" });
    const workspace = createWorkspace({
      id: workspaceId("workspace_after_archive"),
      thread: fixture.thread,
      now: timestamp(13),
    });
    expect(await repositories.workspaces.create(fixture.scope, workspace)).toEqual({
      outcome: "conflict",
    });
  });

  it("Thread 归档与 Run 创建竞态按父行锁串行化", async () => {
    const fixture = await createFixture("archive_race");
    const archived = archiveThread(fixture.thread, timestamp(19));
    const candidate = createRun({
      id: runId("run_archive_race_candidate"),
      thread: fixture.thread,
      now: timestamp(19),
    });
    const [archiveResult, createResult] = await Promise.all([
      repositories.threads.update(fixture.scope, archived, 0n),
      repositories.runs.create(fixture.scope, candidate),
    ]);
    expect(archiveResult.outcome).toBe("updated");
    expect(["created", "conflict"]).toContain(createResult.outcome);
    expect((await repositories.threads.get(fixture.scope, fixture.thread.id))?.entity.status).toBe(
      "archived",
    );
  });

  it("Run 终态后拒绝 Lease、Revision 与 Release", async () => {
    const beforeLease = await createFixture("terminal_before_lease");
    const failed = transitionRun(beforeLease.run, "failed", timestamp(14));
    expect(await repositories.runs.update(beforeLease.scope, failed, 0n)).toMatchObject({
      outcome: "updated",
    });
    const staleLease = acquireWorkspaceLease({
      workspace: beforeLease.workspace,
      rootRun: beforeLease.run,
      epoch: 1,
      expiresAt: timestamp(50),
      now: timestamp(15),
    });
    expect(
      await repositories.workspaces.compareAndSetLease(
        beforeLease.writeScope,
        beforeLease.workspace,
        staleLease,
      ),
    ).toEqual({ outcome: "lease_lost" });

    const afterLease = await createFixture("terminal_after_lease");
    const leased = await acquireLease(afterLease);
    const failedAfterLease = transitionRun(afterLease.run, "failed", timestamp(16));
    expect(await repositories.runs.update(afterLease.scope, failedAfterLease, 0n)).toMatchObject({
      outcome: "updated",
    });
    const revision = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: afterLease.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("revision_terminal"),
      objectKey: "terminal/revision.tar.zst",
      digest: sha256Digest("c".repeat(64)),
      now: timestamp(17),
    });
    expect(await repositories.workspaces.commitRevision(afterLease.writeScope, revision)).toEqual({
      outcome: "lease_lost",
    });
    const released = releaseWorkspaceLease({
      workspace: leased,
      rootRun: afterLease.run,
      epoch: 1,
      now: timestamp(18),
    });
    expect(
      await repositories.workspaces.compareAndSetLease(afterLease.writeScope, leased, released),
    ).toEqual({ outcome: "lease_lost" });
  });

  it("Run 终态与 Revision 提交竞态按 Run 行锁串行化", async () => {
    const fixture = await createFixture("run_revision_race");
    const leased = await acquireLease(fixture);
    const revision = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: fixture.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("revision_run_race"),
      objectKey: "race/revision.tar.zst",
      digest: sha256Digest("d".repeat(64)),
      now: timestamp(20),
    });
    const failed = transitionRun(fixture.run, "failed", timestamp(20));
    const [runResult, revisionResult] = await Promise.all([
      repositories.runs.update(fixture.scope, failed, 0n),
      repositories.workspaces.commitRevision(fixture.writeScope, revision),
    ]);
    expect(runResult.outcome).toBe("updated");
    expect(["committed", "lease_lost"]).toContain(revisionResult.outcome);
  });

  it("相同 parent/revision/epoch 并发提交恰好一个成功", async () => {
    const fixture = await createFixture("revision_cas");
    const leased = await acquireLease(fixture);
    const commands = ["left", "right"].map((side) =>
      prepareWorkspaceRevision({
        workspace: leased,
        rootRun: fixture.run,
        leaseEpoch: 1,
        revisionId: workspaceRevisionId(`revision_${side}`),
        objectKey: `revision/${side}.tar.zst`,
        digest: sha256Digest(side === "left" ? "a".repeat(64) : "b".repeat(64)),
        now: timestamp(18),
      }),
    );
    const [left, right] = commands;
    if (left === undefined || right === undefined) throw new Error("测试命令构造失败");
    const outcomes = await Promise.all([
      repositories.workspaces.commitRevision(fixture.writeScope, left),
      repositories.workspaces.commitRevision(fixture.writeScope, right),
    ]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "committed",
      "revision_conflict",
    ]);
    const rows = await withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1",
        [fixture.workspace.id],
      ),
    );
    expect(rows.rows[0]?.count).toBe("1");
    await expect(
      withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
        client.query(
          "UPDATE workspace_revisions SET object_key = 'forbidden' WHERE workspace_id = $1",
          [fixture.workspace.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
        client.query("DELETE FROM workspace_revisions WHERE workspace_id = $1", [
          fixture.workspace.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("数据库时钟拒绝过期、错误 root Run 和错误 epoch", async () => {
    const fixture = await createFixture("lease_checks");
    const leased = await acquireLease(fixture);
    const renewal = renewWorkspaceLease({
      workspace: leased,
      rootRun: fixture.run,
      epoch: 1,
      expiresAt: timestamp(55),
      now: timestamp(6),
    });
    await withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
      client.query(
        "UPDATE workspace_write_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE workspace_id = $1",
        [fixture.workspace.id],
      ),
    );
    expect(
      await repositories.workspaces.compareAndSetLease(fixture.writeScope, leased, renewal),
    ).toEqual({ outcome: "lease_lost" });
    expect(
      await repositories.workspaces.compareAndSetLease(
        { tenantId: fixture.scope.tenantId, rootRunId: runId("wrong_root") },
        leased,
        renewal,
      ),
    ).toEqual({ outcome: "lease_lost" });
    await withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
      client.query("UPDATE workspace_write_leases SET epoch = 2 WHERE workspace_id = $1", [
        fixture.workspace.id,
      ]),
    );
    expect(
      await repositories.workspaces.compareAndSetLease(fixture.writeScope, leased, renewal),
    ).toEqual({ outcome: "lease_lost" });
  });

  it("事务中途失败完整回滚", async () => {
    const fixture = await createFixture("rollback");
    await expect(
      withTenantTransaction(runtimePool, fixture.scope, async (client) => {
        await client.query("UPDATE threads SET title = '不应提交' WHERE id = $1", [
          fixture.thread.id,
        ]);
        throw new Error("注入事务失败");
      }),
    ).rejects.toThrow("注入事务失败");
    expect((await repositories.threads.get(fixture.scope, fixture.thread.id))?.entity.title).toBe(
      fixture.thread.title,
    );
  });
});
