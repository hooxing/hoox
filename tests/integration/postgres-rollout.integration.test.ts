import { randomBytes } from "node:crypto";
import {
  agentThreadId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
} from "@cube-runtime/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestCanonical } from "../../runtime-ts/packages/run-contracts/src/mutation-protocol.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgRuntimeRolloutRepository } from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Rollout PostgreSQL 集成测试缺少 ${name}；不会输出配置值`);
  }
  return value;
}

const runtimeDatabaseUrl = requiredEnvironment("DATABASE_URL");
const bootstrapDatabaseUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const migrationDatabaseUrl = requiredEnvironment("MIGRATION_DATABASE_URL");
const runtimeRole = requiredEnvironment("DATABASE_RUNTIME_ROLE");
const configuredMigratorRole = requiredEnvironment("DATABASE_MIGRATOR_ROLE");
const databaseName = new URL(bootstrapDatabaseUrl).pathname.slice(1);
const unique = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_rollout_${unique}`;
const migratorRole = `it_ro_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;

const hash = (character: string) => sha256Digest(character.repeat(64));
const scope = {
  tenantId: tenantId(`rollout_tenant_${unique}`),
  threadId: threadId(`rollout_thread_${unique}`),
  runId: runId(`rollout_run_${unique}`),
  attemptId: `rollout_attempt_${unique}`,
  agentThreadId: agentThreadId(`rollout_agent_${unique}`),
};
const context = { scope, userId: userId(`rollout_user_${unique}`) };
const databaseContext = { tenantId: scope.tenantId, userId: context.userId };
const workspaceId = `rollout_workspace_${unique}`;

let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repository!: PgRuntimeRolloutRepository;
let schemaCreated = false;
let migratorCreated = false;

function draft(
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "waiting" | "terminal",
  toolCallId?: string,
) {
  const body = { kind, text: `${kind}-${unique}` };
  return {
    kind,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    body,
    bodyDigest: digestCanonical(body),
  } as const;
}

async function seedExecution(): Promise<void> {
  await withTenantTransaction(runtime, databaseContext, async (client) => {
    await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, clock_timestamp())", [
      context.userId,
    ]);
    await client.query(
      "INSERT INTO tenants(id, kind, owner_user_id, created_at) VALUES ($1,'personal',$2,clock_timestamp())",
      [scope.tenantId, context.userId],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES ($1,$2,$3,'owner','active',clock_timestamp())`,
      [scope.tenantId, `rollout_member_${unique}`, context.userId],
    );
    await client.query(
      `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Rollout 集成测试','active',clock_timestamp(),clock_timestamp())`,
      [scope.tenantId, scope.threadId, context.userId],
    );
    await client.query(
      `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
      [scope.tenantId, scope.runId, scope.threadId],
    );
    await client.query(
      `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at)
       VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp())`,
      [scope.tenantId, workspaceId, scope.threadId],
    );
    await client.query(
      `INSERT INTO run_execution_inputs(
         tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
         initial_projection,initial_projection_digest
       ) VALUES ($1,$2,$3,$4,$2,'test','{}'::jsonb,$5)`,
      [scope.tenantId, scope.runId, scope.threadId, workspaceId, hash("d")],
    );
    await client.query(
      `INSERT INTO execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage
       ) VALUES ($1,$2,$3,$4,$5,$3,'running','model_execution_started')`,
      [scope.tenantId, scope.attemptId, scope.runId, scope.threadId, workspaceId],
    );
  });
}

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapDatabaseUrl, maxConnections: 2 });
  await admin.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}";
     CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
  );
  migratorCreated = true;
  schemaCreated = true;
  migrator = createPostgresPool({
    connectionString: testMigrationUrl.toString(),
    schema,
    maxConnections: 4,
  });
  runtime = createPostgresPool({
    connectionString: runtimeDatabaseUrl,
    schema,
    maxConnections: 12,
  });
  expect((await migrateUp(migrator, migrationSecurity)).at(-1)?.version).toBe(11);
  repository = new PgRuntimeRolloutRepository(runtime);
  await seedExecution();
  expect(
    await repository.openRootStream({
      context,
      workspaceId,
      rootRunId: scope.runId,
      compatibility: {
        modelId: "provider/model:test",
        modelCompatibilityHash: hash("1"),
        promptPolicyHash: hash("2"),
        toolSchemaHash: hash("3"),
        skillManifestHash: hash("4"),
      },
    }),
  ).toBe("created");
});

afterAll(async () => {
  if (runtime !== undefined) await runtime.end();
  if (migrator !== undefined) {
    await migrateDown(migrator, {
      ...migrationSecurity,
      allowDestructive: true,
      environment: "test",
      targetVersion: 0,
    });
    await migrator.end();
  }
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await admin.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}"; DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin !== undefined) await admin.end();
});

describe("Runtime Rollout PostgreSQL 事实源", () => {
  it("并发 append 保持单调无间隙，幂等重放并拒绝摘要冲突", async () => {
    const initial = await repository.append({
      context,
      idempotencyKey: `append-initial-${unique}`,
      commandDigest: hash("5"),
      entries: [draft("user")],
    });
    expect(initial.outcome).toBe("created");

    const [left, right] = await Promise.all([
      repository.append({
        context,
        idempotencyKey: `append-left-${unique}`,
        commandDigest: hash("6"),
        entries: [draft("assistant")],
      }),
      repository.append({
        context,
        idempotencyKey: `append-right-${unique}`,
        commandDigest: hash("7"),
        entries: [draft("assistant")],
      }),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["created", "created"]);
    const replay = await repository.append({
      context,
      idempotencyKey: `append-left-${unique}`,
      commandDigest: hash("6"),
      entries: [draft("assistant")],
    });
    expect(replay.outcome).toBe("replayed");
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-left-${unique}`,
          commandDigest: hash("8"),
          entries: [draft("assistant")],
        })
      ).outcome,
    ).toBe("conflict");
    const restored = await new PgRuntimeRolloutRepository(runtime).loadRecovery({ context });
    expect(restored?.tail.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
  });

  it("保存未配对尾部，且后续只能追加同 call ID 的 tool_result", async () => {
    const callId = `call-${unique}`;
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-call-${unique}`,
          commandDigest: hash("9"),
          entries: [draft("tool_call", callId)],
        })
      ).outcome,
    ).toBe("created");
    expect((await repository.loadRecovery({ context }))?.tail.at(-1)).toMatchObject({
      kind: "tool_call",
      toolCallId: callId,
    });
    await expect(
      repository.writeCheckpoint({
        context,
        idempotencyKey: `checkpoint-unpaired-${unique}`,
        commandDigest: hash("1"),
        checkpointId: `checkpoint-unpaired-${unique}`,
        windowStartSequence: 0,
        throughSequence: (await repository.loadRecovery({ context }))?.tail.at(-1)?.sequence ?? 0,
        projection: { state: "不得提交" },
        projectionDigest: digestCanonical({ state: "不得提交" }),
        replacementHistory: [],
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await expect(
      repository.append({
        context,
        idempotencyKey: `append-bad-pair-${unique}`,
        commandDigest: hash("e"),
        entries: [draft("tool_result", `other-${unique}`)],
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-result-${unique}`,
          commandDigest: hash("f"),
          entries: [draft("tool_result", callId)],
        })
      ).outcome,
    ).toBe("created");
  });

  it("checkpoint 只替换模型投影，重启读取 checkpoint 后尾部且不删除事实", async () => {
    const before = await repository.loadRecovery({ context });
    const throughSequence = before?.tail.at(-1)?.sequence;
    expect(throughSequence).toBeTypeOf("number");
    const written = await repository.writeCheckpoint({
      context,
      idempotencyKey: `checkpoint-${unique}`,
      commandDigest: hash("0"),
      checkpointId: `checkpoint-${unique}`,
      windowStartSequence: 0,
      throughSequence: throughSequence ?? 0,
      projection: { turns: [{ role: "assistant", text: "摘要" }] },
      projectionDigest: digestCanonical({ turns: [{ role: "assistant", text: "摘要" }] }),
      replacementHistory: [{ from: 0, through: throughSequence }],
    });
    expect(written.outcome).toBe("created");
    await repository.append({
      context,
      idempotencyKey: `append-after-checkpoint-${unique}`,
      commandDigest: hash("b"),
      entries: [draft("assistant")],
    });
    const restarted = await new PgRuntimeRolloutRepository(runtime).loadRecovery({ context });
    expect(restarted?.checkpoint?.throughSequence).toBe(throughSequence);
    expect(restarted?.tail).toHaveLength(1);
    const facts = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, scope.attemptId],
      ),
    );
    expect(Number(facts.rows[0]?.count)).toBeGreaterThan(throughSequence ?? 0);
  });

  it("直接 SQL 也拒绝序号跳跃、伪造前驱、终态后续写和 tool_call checkpoint", async () => {
    const restored = await repository.loadRecovery({ context });
    const tail = restored?.tail.at(-1);
    expect(tail).toBeDefined();
    await expect(
      withTenantTransaction(runtime, databaseContext, (client) =>
        client.query(
          `INSERT INTO runtime_rollout_entries(
             tenant_id,thread_id,run_id,attempt_id,agent_thread_id,sequence,kind,
             previous_sequence,previous_kind,previous_tool_call_id,body,body_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,'assistant',$7,'assistant','','{}'::jsonb,$8)`,
          [
            scope.tenantId,
            scope.threadId,
            scope.runId,
            scope.attemptId,
            scope.agentThreadId,
            (tail?.sequence ?? 0) + 2,
            tail?.sequence,
            hash("c"),
          ],
        ),
      ),
    ).rejects.toBeDefined();

    const terminal = await repository.append({
      context,
      idempotencyKey: `append-terminal-${unique}`,
      commandDigest: hash("d"),
      entries: [draft("terminal")],
    });
    expect(terminal.outcome).toBe("created");
    await expect(
      repository.append({
        context,
        idempotencyKey: `append-after-terminal-${unique}`,
        commandDigest: hash("e"),
        entries: [draft("assistant")],
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
  });

  it("Membership 撤销后 Repository ACL 立即拒绝", async () => {
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query("UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2", [
        scope.tenantId,
        context.userId,
      ]),
    );
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-revoked-${unique}`,
          commandDigest: hash("f"),
          entries: [draft("assistant")],
        })
      ).outcome,
    ).toBe("not_authorized");
  });
});
