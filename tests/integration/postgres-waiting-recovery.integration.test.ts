import { randomBytes } from "node:crypto";
import {
  agentThreadId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@cube-runtime/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WaitingRecoveryStorePort } from "../../runtime-ts/apps/agent-worker/src/waiting-recovery.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgRuntimeRolloutRepository } from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import { PgWaitingRecoveryStore } from "../../runtime-ts/packages/persistence/src/pg-waiting-recovery.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { loadPostgreSqlMigrationContract } from "./postgres-migration-contract.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`waiting recovery PG 测试缺少 ${name}；不会输出配置值`);
  return value;
}

const runtimeUrl = required("DATABASE_URL");
const bootstrapUrl = required("DATABASE_BOOTSTRAP_URL");
const migrationUrl = required("MIGRATION_DATABASE_URL");
const runtimeRole = required("DATABASE_RUNTIME_ROLE");
const configuredMigrator = required("DATABASE_MIGRATOR_ROLE");
const unique = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_waiting_${unique}`;
const migratorRole = `it_wait_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationUrl);
if (testMigrationUrl.username !== configuredMigrator) throw new Error("迁移角色配置不一致");
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const databaseName = new URL(bootstrapUrl).pathname.slice(1);
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;

const scope = {
  tenantId: tenantId(`wait_tenant_${unique}`),
  threadId: threadId(`wait_thread_${unique}`),
  runId: runId(`wait_run_${unique}`),
  rootRunId: runId(`wait_run_${unique}`),
  workspaceId: workspaceId(`wait_workspace_${unique}`),
};
const attemptId = `wait_attempt_${unique}`;
const checkpointId = `wait_checkpoint_${unique}`;
const actorId = userId(`wait_user_${unique}`);
const databaseContext = { tenantId: scope.tenantId, userId: actorId };
const rolloutContext = {
  scope: {
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    runId: scope.runId,
    attemptId,
    agentThreadId: agentThreadId(`wait_agent_${unique}`),
  },
  userId: actorId,
};
const hash = (value: string) => sha256Digest(value.repeat(64));
const compatibility = {
  modelId: "test/waiting",
  modelCompatibilityHash: hash("1"),
  promptPolicyHash: hash("2"),
  toolSchemaHash: hash("3"),
  skillManifestHash: hash("4"),
};

let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let store!: PgWaitingRecoveryStore;
let schemaCreated = false;
let roleCreated = false;

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapUrl, maxConnections: 2 });
  await admin.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}";
     CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
  );
  roleCreated = true;
  schemaCreated = true;
  migrator = createPostgresPool({
    connectionString: testMigrationUrl.toString(),
    schema,
    maxConnections: 4,
  });
  runtime = createPostgresPool({ connectionString: runtimeUrl, schema, maxConnections: 8 });
  const contract = await loadPostgreSqlMigrationContract();
  expect((await migrateUp(migrator, migrationSecurity)).at(-1)?.version).toBe(
    contract.latestVersion,
  );
  await withTenantTransaction(runtime, databaseContext, async (client) => {
    await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
      actorId,
    ]);
    await client.query(
      "INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,clock_timestamp())",
      [scope.tenantId, actorId],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES($1,$2,$3,'owner','active',clock_timestamp())`,
      [scope.tenantId, `wait_member_${unique}`, actorId],
    );
    await client.query(
      `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
       VALUES($1,$2,$3,'waiting recovery','active',clock_timestamp(),clock_timestamp())`,
      [scope.tenantId, scope.threadId, actorId],
    );
    await client.query(
      `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
      [scope.tenantId, scope.runId, scope.threadId],
    );
    await client.query(
      `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at)
       VALUES($1,$2,$3,clock_timestamp(),clock_timestamp())`,
      [scope.tenantId, scope.workspaceId, scope.threadId],
    );
    await client.query(
      `INSERT INTO run_execution_inputs(
         tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
         initial_projection,initial_projection_digest
       ) VALUES($1,$2,$3,$4,$2,'test','{}'::jsonb,$5)`,
      [scope.tenantId, scope.runId, scope.threadId, scope.workspaceId, hash("5")],
    );
    await client.query(
      `INSERT INTO execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage
       ) VALUES($1,$2,$3,$4,$5,$3,'running','model_settled')`,
      [scope.tenantId, attemptId, scope.runId, scope.threadId, scope.workspaceId],
    );
  });
  const rollout = new PgRuntimeRolloutRepository(runtime);
  expect(
    await rollout.openRootStream({
      context: rolloutContext,
      workspaceId: scope.workspaceId,
      rootRunId: scope.rootRunId,
      compatibility,
    }),
  ).toBe("created");
  const appended = await rollout.append({
    context: rolloutContext,
    idempotencyKey: `wait-entry-${unique}`,
    entries: [{ kind: "waiting", body: { checkpointId } }],
  });
  if (appended.outcome !== "created") throw new Error("waiting Rollout 写入失败");
  const sequence = appended.value[0]?.sequence;
  if (sequence === undefined) throw new Error("waiting Rollout 缺少序号");
  expect(
    (
      await rollout.writeCheckpoint({
        context: rolloutContext,
        idempotencyKey: `wait-checkpoint-${unique}`,
        checkpointId,
        windowStartSequence: sequence,
        throughSequence: sequence,
        projection: { turns: [] },
        replacementHistory: [],
      })
    ).outcome,
  ).toBe("created");
  await withTenantTransaction(runtime, databaseContext, async (client) => {
    await client.query(
      "UPDATE runs SET status='waiting',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [scope.tenantId, scope.runId],
    );
    await client.query(
      `UPDATE execution_attempts SET status='waiting',finished_at=clock_timestamp(),next_event_sequence=1
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scope.tenantId, attemptId],
    );
    await client.query(
      `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
       VALUES($1,$2,0,1,'run_waiting',$3::jsonb)`,
      [scope.tenantId, attemptId, JSON.stringify({ question: "继续？", checkpointId })],
    );
  });
  store = new PgWaitingRecoveryStore(runtime, 30);
  const compatiblePort: WaitingRecoveryStorePort = store;
  expect(compatiblePort).toBe(store);
  expect(
    await store.record({
      scope,
      attemptId,
      checkpointId,
      workspaceHeadAtWait: { outcome: "empty" },
    }),
  ).toBe("created");
});

afterAll(async () => {
  if (runtime) await runtime.end();
  if (migrator) {
    await migrateDown(migrator, {
      ...migrationSecurity,
      allowDestructive: true,
      environment: "test",
      targetVersion: 0,
    });
    await migrator.end();
  }
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (roleCreated) {
    await admin.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}"; DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin) await admin.end();
});

describe("waiting recovery PostgreSQL 事实源", () => {
  it("完整 Scope 并发 claim 只有一个胜者，错误 Scope 与跨租户均不可见", async () => {
    const [left, right] = await Promise.all([
      store.claim({ scope, checkpointId, workerId: "worker-left" }),
      store.claim({ scope, checkpointId, workerId: "worker-right" }),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["busy", "claimed"]);
    expect(
      (
        await store.claim({
          scope: { ...scope, threadId: threadId(`wrong_${unique}`) },
          checkpointId,
          workerId: "wrong",
        })
      ).outcome,
    ).toBe("not_found");
    const hidden = await withTenantTransaction(
      runtime,
      { tenantId: `foreign_${unique}`, userId: `foreign_user_${unique}` },
      (client) =>
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM waiting_recovery_checkpoints WHERE checkpoint_id=$1",
          [checkpointId],
        ),
    );
    expect(hidden.rows[0]?.count).toBe("0");
  });

  it("过期 claim 可 reclaim，旧 token 在 intent 前得到 claim_lost", async () => {
    const first = await store.claim({ scope, checkpointId, workerId: "reclaim-first" });
    if (first.outcome !== "claimed") {
      await withTenantTransaction(migrator, databaseContext, (client) =>
        client.query(
          "UPDATE waiting_recovery_checkpoints SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND checkpoint_id=$2",
          [scope.tenantId, checkpointId],
        ),
      );
    }
    const old =
      first.outcome === "claimed"
        ? first
        : await store.claim({ scope, checkpointId, workerId: "reclaim-old" });
    if (old.outcome !== "claimed") throw new Error("测试需要旧 claim");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        "UPDATE waiting_recovery_checkpoints SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND checkpoint_id=$2",
        [scope.tenantId, checkpointId],
      ),
    );
    const reclaimed = await store.claim({ scope, checkpointId, workerId: "reclaim-new" });
    expect(reclaimed.outcome).toBe("claimed");
    expect(
      (
        await store.beginEffect({
          claim: old.claim,
          decision: {
            outcome: "resume",
            workspace: "unchanged",
            sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
          },
          observedWorkspaceHead: { outcome: "empty" },
          effect: "create",
        })
      ).outcome,
    ).toBe("claim_lost");
  });

  it("intent、create/materialize 完成与决定事件/Rollout 在单一事实链中且只写一次", async () => {
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        "UPDATE waiting_recovery_checkpoints SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND checkpoint_id=$2",
        [scope.tenantId, checkpointId],
      ),
    );
    const acquired = await store.claim({ scope, checkpointId, workerId: "saga" });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 claim");
    const decision = {
      outcome: "resume",
      workspace: "unchanged",
      sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
    };
    for (const effect of ["create", "materialize"] as const) {
      const intent = await store.beginEffect({
        claim: acquired.claim,
        decision,
        observedWorkspaceHead: { outcome: "empty" },
        effect,
      });
      if (intent.outcome !== "authorized") throw new Error("测试需要 intent");
      expect(
        await store.completeEffect({
          claim: acquired.claim,
          intentId: intent.intentId,
          effect,
          proof: {
            registryId: `rebuilt_registry_${unique}`,
            providerSandboxId: `rebuilt_sandbox_${unique}`,
            generation: 1,
          },
        }),
      ).toBe("completed");
    }
    expect(
      await store.resolve({
        claim: acquired.claim,
        decision,
      }),
    ).toBe("resolved");
    const facts = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ run_count: string; rollout_count: string; decision: string; reason: string }>(
        `SELECT
          (SELECT count(*) FROM run_events WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery_decided')::text AS run_count,
          (SELECT count(*) FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery')::text AS rollout_count,
          (SELECT payload->>'decision' FROM run_events WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery_decided') AS decision,
          (SELECT payload->>'reason' FROM run_events WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery_decided') AS reason`,
        [scope.tenantId, attemptId],
      ),
    );
    expect(facts.rows[0]).toEqual({
      run_count: "1",
      rollout_count: "1",
      decision: "sandbox_rebuilt",
      reason: "missing",
    });
    expect(
      await store.resolve({
        claim: acquired.claim,
        decision,
      }),
    ).not.toBe("resolved");
  });

  it("effect_pending 租约过期时由后续 claim 收敛 UNKNOWN，绝不重发 create", async () => {
    const abandonedCheckpointId = `wait_abandoned_${unique}`;
    const rollout = new PgRuntimeRolloutRepository(runtime);
    const appended = await rollout.append({
      context: rolloutContext,
      idempotencyKey: `wait-abandoned-entry-${unique}`,
      entries: [{ kind: "waiting", body: { checkpointId: abandonedCheckpointId } }],
    });
    if (appended.outcome !== "created") throw new Error("测试 waiting Rollout 写入失败");
    const sequence = appended.value[0]?.sequence;
    if (sequence === undefined) throw new Error("测试 waiting Rollout 缺少序号");
    expect(
      (
        await rollout.writeCheckpoint({
          context: rolloutContext,
          idempotencyKey: `wait-abandoned-checkpoint-${unique}`,
          checkpointId: abandonedCheckpointId,
          windowStartSequence: sequence,
          throughSequence: sequence,
          projection: { turns: [] },
          replacementHistory: [],
        })
      ).outcome,
    ).toBe("created");
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      const next = await client.query<{ sequence: string }>(
        `UPDATE execution_attempts SET next_event_sequence=next_event_sequence+1
          WHERE tenant_id=$1 AND attempt_id=$2 RETURNING (next_event_sequence-1)::text AS sequence`,
        [scope.tenantId, attemptId],
      );
      const eventSequence = next.rows[0]?.sequence;
      if (eventSequence === undefined) throw new Error("测试 waiting event 缺少序号");
      await client.query(
        `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
         VALUES($1,$2,$3,1,'run_waiting',$4::jsonb)`,
        [
          scope.tenantId,
          attemptId,
          eventSequence,
          JSON.stringify({ question: "继续？", checkpointId: abandonedCheckpointId }),
        ],
      );
    });
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: abandonedCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      checkpointId: abandonedCheckpointId,
      workerId: "crashed-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 effect_pending claim");
    const intent = await store.beginEffect({
      claim: acquired.claim,
      decision: {
        outcome: "resume",
        workspace: "unchanged",
        sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
      },
      observedWorkspaceHead: { outcome: "empty" },
      effect: "create",
    });
    if (intent.outcome !== "authorized") throw new Error("测试需要 create intent");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE waiting_recovery_checkpoints
          SET claim_expires_at=clock_timestamp()-interval '1 second'
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, abandonedCheckpointId],
      ),
    );
    expect(
      (
        await store.claim({
          scope,
          checkpointId: abandonedCheckpointId,
          workerId: "recovery-worker",
        })
      ).outcome,
    ).toBe("resolved");
    const state = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ checkpoint_state: string; effect_state: string; unknown_effect: string }>(
        `SELECT checkpoint.state AS checkpoint_state,effect.state AS effect_state,
                effect.payload->>'unknownEffect' AS unknown_effect
           FROM waiting_recovery_checkpoints checkpoint
           JOIN waiting_recovery_effect_outbox effect USING(tenant_id,checkpoint_id)
          WHERE checkpoint.tenant_id=$1 AND checkpoint.checkpoint_id=$2`,
        [scope.tenantId, abandonedCheckpointId],
      ),
    );
    expect(state.rows[0]).toEqual({
      checkpoint_state: "unknown",
      effect_state: "unknown",
      unknown_effect: "create",
    });
  });
});
