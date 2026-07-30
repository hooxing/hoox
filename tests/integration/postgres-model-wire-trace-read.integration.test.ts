import { randomBytes } from "node:crypto";
import { runId, tenantId, threadId, userId, workspaceId } from "@cube-runtime/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgModelWireTraceReadRepository } from "../../runtime-ts/packages/persistence/src/model-wire-trace-read.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`模型网络诊断读取集成测试缺少 ${name}；不会输出配置值`);
  }
  return value;
}

const bootstrapDatabaseUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const runtimeDatabaseUrl = requiredEnvironment("DATABASE_URL");
const migrationDatabaseUrl = new URL(requiredEnvironment("MIGRATION_DATABASE_URL"));
const runtimeRole = requiredEnvironment("DATABASE_RUNTIME_ROLE");
const configuredMigratorRole = requiredEnvironment("DATABASE_MIGRATOR_ROLE");
const unique = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_wire_read_${unique}`;
const migratorRole = `it_wr_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const databaseName = new URL(bootstrapDatabaseUrl).pathname.slice(1);
if (migrationDatabaseUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
migrationDatabaseUrl.username = migratorRole;
migrationDatabaseUrl.password = migratorPassword;
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;

const ids = {
  tenant: tenantId(`wire_read_tenant_${unique}`),
  user: userId(`wire_read_user_${unique}`),
  thread: threadId(`wire_read_thread_${unique}`),
  run: runId(`wire_read_run_${unique}`),
  workspace: workspaceId(`wire_read_workspace_${unique}`),
  attempt: `wire_read_attempt_${unique}`,
  outsiderUser: userId(`wire_read_outsider_${unique}`),
  otherTenant: tenantId(`wire_read_other_tenant_${unique}`),
  otherUser: userId(`wire_read_other_user_${unique}`),
};
const scope = { tenantId: ids.tenant, userId: ids.user } as const;

let administrativePool!: Pool;
let migratorPool!: Pool;
let runtimePool!: Pool;
let schemaCreated = false;
let migratorCreated = false;

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
    connectionString: migrationDatabaseUrl.toString(),
    schema,
    maxConnections: 3,
  });
  runtimePool = createPostgresPool({
    connectionString: runtimeDatabaseUrl,
    schema,
    maxConnections: 4,
  });
  await migrateUp(migratorPool, migrationSecurity);

  await withTenantTransaction(runtimePool, scope, async (client) => {
    await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
      ids.user,
    ]);
    await client.query(
      `INSERT INTO tenants(id,kind,owner_user_id,created_at)
       VALUES($1,'personal',$2,clock_timestamp())`,
      [ids.tenant, ids.user],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES($1,$2,$3,'owner','active',clock_timestamp())`,
      [ids.tenant, `wire_read_membership_${unique}`, ids.user],
    );
    await client.query(
      `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
       VALUES($1,$2,$3,'Wire Read','active',clock_timestamp(),clock_timestamp())`,
      [ids.tenant, ids.thread, ids.user],
    );
    await client.query(
      `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
      [ids.tenant, ids.run, ids.thread],
    );
    await client.query(
      `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at)
       VALUES($1,$2,$3,clock_timestamp(),clock_timestamp())`,
      [ids.tenant, ids.workspace, ids.thread],
    );
    await client.query(
      `INSERT INTO run_execution_inputs(
         tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
         initial_projection,initial_projection_digest
       ) VALUES($1,$2,$3,$4,$2,'wire-read','{}'::jsonb,$5)`,
      [ids.tenant, ids.run, ids.thread, ids.workspace, "a".repeat(64)],
    );
    await client.query(
      `INSERT INTO execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage
       ) VALUES($1,$2,$3,$4,$5,$3,'running','model_execution_started')`,
      [ids.tenant, ids.attempt, ids.run, ids.thread, ids.workspace],
    );
    await client.query(
      `INSERT INTO model_wire_trace_records(
         tenant_id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
         model_turn,transport_attempt,part,command_digest,blob_operation_id,
         capture_status,capture_error_code,persistence_status,created_at,updated_at,expires_at
       ) VALUES
         ($1,$2,$3,$4,$5,$3,0,0,'request',$6,$7,'failed','BODY_UNREADABLE','not_captured',
          '2099-07-30T00:00:00.000123Z'::timestamptz,clock_timestamp(),'2100-01-01Z'),
         ($1,$2,$3,$4,$5,$3,1,0,'request',$8,$9,'failed','BODY_UNREADABLE','not_captured',
          '2099-07-30T00:00:00.000456Z'::timestamptz,clock_timestamp(),'2100-01-01Z')`,
      [
        ids.tenant,
        ids.thread,
        ids.run,
        ids.attempt,
        ids.workspace,
        "b".repeat(64),
        `trace-${"c".repeat(64)}`,
        "d".repeat(64),
        `trace-${"e".repeat(64)}`,
      ],
    );
  });
  await withTenantTransaction(
    runtimePool,
    { tenantId: ids.tenant, userId: ids.outsiderUser },
    (client) =>
      client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
        ids.outsiderUser,
      ]),
  );
  await withTenantTransaction(
    runtimePool,
    { tenantId: ids.otherTenant, userId: ids.otherUser },
    async (client) => {
      await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
        ids.otherUser,
      ]);
      await client.query(
        `INSERT INTO tenants(id,kind,owner_user_id,created_at)
         VALUES($1,'personal',$2,clock_timestamp())`,
        [ids.otherTenant, ids.otherUser],
      );
      await client.query(
        `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
         VALUES($1,$2,$3,'owner','active',clock_timestamp())`,
        [ids.otherTenant, `wire_read_other_membership_${unique}`, ids.otherUser],
      );
    },
  );
});

afterAll(async () => {
  if (runtimePool !== undefined) await runtimePool.end();
  if (migratorPool !== undefined) {
    await migrateDown(migratorPool, {
      ...migrationSecurity,
      allowDestructive: true,
      environment: "test",
      targetVersion: 0,
    });
    await migratorPool.end();
  }
  if (schemaCreated) await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await administrativePool.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}"; DROP ROLE "${migratorRole}"`,
    );
  }
  if (administrativePool !== undefined) await administrativePool.end();
});

describe("模型网络诊断 PostgreSQL 读取分页", () => {
  it("limit=1 跨过同毫秒内不同微秒记录且不重复页尾", async () => {
    const repository = new PgModelWireTraceReadRepository(runtimePool);
    const first = await repository.list({
      scope,
      threadId: ids.thread,
      runId: ids.run,
      limit: 1,
    });
    expect(first.outcome).toBe("found");
    if (first.outcome !== "found" || first.nextCursor === undefined) {
      throw new Error("首个诊断分页没有返回游标");
    }
    expect(first.records.map((record) => record.modelTurn)).toEqual([0]);
    expect(first.records[0]?.createdAt).toBe("2099-07-30T00:00:00.000Z");
    expect(first.nextCursor.createdAt).toBe("2099-07-30T00:00:00.000Z");
    expect(first.hasMore).toBe(true);

    const second = await repository.list({
      scope,
      threadId: ids.thread,
      runId: ids.run,
      limit: 1,
      after: first.nextCursor,
    });
    expect(second.outcome).toBe("found");
    if (second.outcome !== "found") throw new Error("第二个诊断分页不存在");
    expect(second.records.map((record) => record.modelTurn)).toEqual([1]);
    expect(second.records[0]?.attemptId).toBe(ids.attempt);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toMatchObject({ modelTurn: 1 });
    if (second.nextCursor === undefined) throw new Error("尾页没有保留最终排序游标");

    const afterTail = await repository.list({
      scope,
      threadId: ids.thread,
      runId: ids.run,
      limit: 1,
      after: second.nextCursor,
    });
    expect(afterTail).toEqual({ outcome: "found", records: [], hasMore: false });
  });

  it("错误 Tenant、User、Thread 或 Run 对列表与正文统一返回 not_found", async () => {
    const repository = new PgModelWireTraceReadRepository(runtimePool);
    const cases = [
      {
        scope: { tenantId: ids.otherTenant, userId: ids.otherUser },
        threadId: ids.thread,
        runId: ids.run,
      },
      {
        scope: { tenantId: ids.tenant, userId: ids.outsiderUser },
        threadId: ids.thread,
        runId: ids.run,
      },
      {
        scope,
        threadId: threadId(`wire_read_missing_thread_${unique}`),
        runId: ids.run,
      },
      {
        scope,
        threadId: ids.thread,
        runId: runId(`wire_read_missing_run_${unique}`),
      },
    ] as const;

    for (const boundary of cases) {
      await expect(repository.list({ ...boundary, limit: 1 })).resolves.toEqual({
        outcome: "not_found",
      });
      await expect(
        repository.getBody({
          ...boundary,
          attemptId: ids.attempt,
          modelTurn: 0,
          transportAttempt: 0,
          part: "request",
        }),
      ).resolves.toEqual({ outcome: "not_found" });
    }
  });
});
