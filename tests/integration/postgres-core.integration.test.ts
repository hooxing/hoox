import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type Thread,
  type Workspace,
} from "@cube-runtime/domain";
import type { CoreRepositories, TenantScope, WorkspaceWriteScope } from "@cube-runtime/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgCoreRepositories } from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import {
  createPostgresPool,
  withTenantTransaction,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { bootstrapRuntimeAccess } from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";

const runtimeDatabaseUrl = process.env.DATABASE_URL;
const bootstrapDatabaseUrl = process.env.DATABASE_BOOTSTRAP_URL;
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;
const migratorRole = process.env.DATABASE_MIGRATOR_ROLE;
if (
  runtimeDatabaseUrl === undefined ||
  bootstrapDatabaseUrl === undefined ||
  migrationDatabaseUrl === undefined ||
  runtimeRole === undefined ||
  migratorRole === undefined
) {
  throw new Error("PostgreSQL 集成测试需要 Runtime/Migrator 双连接配置；不会输出配置值");
}

const schema = `it_${process.pid}_${Date.now()}`;
const databaseOwnerRole = new URL(bootstrapDatabaseUrl).username;
const databaseName = new URL(bootstrapDatabaseUrl).pathname.slice(1);
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(migratorRole)) throw new Error("Migrator 角色名称无效");
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
let concurrentMigrationVersions: readonly number[] = [];

interface Fixture {
  readonly scope: TenantScope;
  readonly writeScope: WorkspaceWriteScope;
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

beforeAll(async () => {
  administrativePool = createPostgresPool({
    connectionString: bootstrapDatabaseUrl,
    maxConnections: 2,
  });
  await administrativePool.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`);
  schemaCreated = true;
  migratorPool = createPostgresPool({
    connectionString: migrationDatabaseUrl,
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
  await bootstrapRuntimeAccess(migratorPool, migrationSecurity);
  repositories = new PgCoreRepositories(runtimePool);
});

afterAll(async () => {
  if (runtimePool !== undefined) await runtimePool.end();
  if (migratorPool !== undefined) await migratorPool.end();
  if (!schema.startsWith(`it_${process.pid}_`)) throw new Error("拒绝删除非测试 Schema");
  if (schemaCreated) await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (administrativePool !== undefined) await administrativePool.end();
});

describe("PostgreSQL 迁移与强权限边界", () => {
  it("并发迁移串行化且重复执行结果一致", async () => {
    expect(concurrentMigrationVersions).toEqual([1, 1]);
    expect(await migrateUp(migratorPool, migrationSecurity)).toHaveLength(1);
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
      `GRANT TEMPORARY ON DATABASE "${databaseName}" TO "${runtimeRole}"`,
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
      expect(state.rows[0]).toMatchObject({ threads: "threads", migration_count: "1" });
    } finally {
      await administrativePool.query(
        `REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM "${runtimeRole}"`,
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
    expect(await migrateUp(migratorPool, migrationSecurity)).toHaveLength(1);
    await bootstrapRuntimeAccess(migratorPool, migrationSecurity);
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
        { suffix: "schema_owner", role: migratorRole },
        { suffix: "database_owner", role: databaseOwnerRole },
        { suffix: "table_owner", role: unsafeTableOwnerRole },
      ] as const;
      for (const unsafe of cases) {
        const unsafeSchema = `${schema}_${unsafe.suffix}`;
        await administrativePool.query(
          `CREATE SCHEMA "${unsafeSchema}" AUTHORIZATION "${migratorRole}"`,
        );
        if (unsafe.suffix === "table_owner") {
          await administrativePool.query(
            `CREATE TABLE "${unsafeSchema}".owned_seed(id integer);
             ALTER TABLE "${unsafeSchema}".owned_seed OWNER TO "${unsafeTableOwnerRole}"`,
          );
        }
        const unsafePool = createPostgresPool({
          connectionString: migrationDatabaseUrl,
          schema: unsafeSchema,
          maxConnections: 2,
        });
        try {
          await expect(
            migrateUp(unsafePool, {
              runtimeRole: unsafe.role,
              migratorRole,
              schema: unsafeSchema,
            }),
          ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
          const migrationTable = await unsafePool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          );
          expect(migrationTable.rows[0]?.name).toBeNull();
          if (unsafe.suffix === "inherited") {
            await expect(
              migrateDown(unsafePool, {
                allowDestructive: true,
                environment: "test",
                runtimeRole: unsafe.role,
                migratorRole,
                schema: unsafeSchema,
              }),
            ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
            expect(
              (
                await unsafePool.query<{ name: string | null }>(
                  "SELECT to_regclass('runtime_schema_migrations')::text AS name",
                )
              ).rows[0]?.name,
            ).toBeNull();
          }
        } finally {
          await unsafePool.end();
          await administrativePool.query(`DROP SCHEMA "${unsafeSchema}" CASCADE`);
        }
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

  it("Migrator 或 search_path 不安全时在任何迁移 DDL 之前失败", async () => {
    const parentRole = `it_migrator_parent_${process.pid}`;
    const parentSchema = `${schema}_migrator_parent`;
    const ownerSchema = `${schema}_wrong_owner`;
    await administrativePool.query(
      `CREATE ROLE "${parentRole}" NOLOGIN;
       CREATE SCHEMA "${parentSchema}" AUTHORIZATION "${migratorRole}";
       CREATE SCHEMA "${ownerSchema}" AUTHORIZATION "${databaseOwnerRole}";
       GRANT "${parentRole}" TO "${migratorRole}"`,
    );
    const parentPool = createPostgresPool({
      connectionString: migrationDatabaseUrl,
      schema: parentSchema,
      maxConnections: 2,
    });
    const wrongOwnerPool = createPostgresPool({
      connectionString: migrationDatabaseUrl,
      schema: ownerSchema,
      maxConnections: 2,
    });
    const wrongSearchPathPool = createPostgresPool({
      connectionString: migrationDatabaseUrl,
      maxConnections: 2,
    });
    const databaseOwnerPool = createPostgresPool({
      connectionString: bootstrapDatabaseUrl,
      schema: ownerSchema,
      maxConnections: 2,
    });
    try {
      await expect(
        migrateUp(parentPool, { runtimeRole, migratorRole, schema: parentSchema }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      await administrativePool.query(`REVOKE "${parentRole}" FROM "${migratorRole}"`);
      await expect(
        migrateUp(wrongOwnerPool, { runtimeRole, migratorRole, schema: ownerSchema }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      await expect(
        migrateUp(wrongSearchPathPool, { runtimeRole, migratorRole, schema: parentSchema }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      await expect(
        migrateUp(databaseOwnerPool, {
          runtimeRole,
          migratorRole: databaseOwnerRole,
          schema: ownerSchema,
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const migrationTables = await administrativePool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_class relation JOIN pg_namespace schema_state
             ON schema_state.oid = relation.relnamespace
          WHERE schema_state.nspname IN ($1, $2)
            AND relation.relname = 'runtime_schema_migrations'`,
        [parentSchema, ownerSchema],
      );
      expect(migrationTables.rows[0]?.count).toBe("0");
    } finally {
      await parentPool.end();
      await wrongOwnerPool.end();
      await wrongSearchPathPool.end();
      await databaseOwnerPool.end();
      await administrativePool.query(
        `REVOKE "${parentRole}" FROM "${migratorRole}";
         DROP SCHEMA "${parentSchema}" CASCADE;
         DROP SCHEMA "${ownerSchema}" CASCADE;
         DROP ROLE "${parentRole}"`,
      );
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
