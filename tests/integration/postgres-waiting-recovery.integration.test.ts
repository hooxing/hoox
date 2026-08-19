import { createHmac, randomBytes } from "node:crypto";
import {
  agentThreadId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@hoox/domain";
import type { ExecutionFence } from "@hoox/run-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideWaitingRecovery,
  type WaitingRecoveryStorePort,
} from "../../runtime-ts/apps/agent-worker/src/waiting-recovery.js";
import { digestCanonical } from "../../runtime-ts/packages/run-contracts/src/mutation-protocol.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgRuntimeRolloutRepository } from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import {
  createTestingPgWaitingRecoveryStore,
  type PgWaitingRecoveryClaim,
  type PgWaitingRecoveryStore,
  type TestingWaitingRecoveryEffectAdapter,
  type TestingWaitingRecoveryReceiptVerifier,
  type TrustedWaitingRecoveryEffectRequest,
} from "../../runtime-ts/packages/persistence/src/pg-waiting-recovery.js";
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
const skillPublisherRole = `it_wait_pub_${unique}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorRole = `it_wait_coord_${unique}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const adminControlRole = workerCoordinatorRole.replace("_coord_", "_control_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const adminControlPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationUrl);
if (testMigrationUrl.username !== configuredMigrator) throw new Error("迁移角色配置不一致");
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const databaseName = new URL(bootstrapUrl).pathname.slice(1);
const migrationSecurity = {
  runtimeRole,
  migratorRole,
  skillPublisherRole,
  workerCoordinatorRole,
  teamCoordinatorRole,
  adminControlRole,
  schema,
} as const;

const scope = {
  tenantId: tenantId(`wait_tenant_${unique}`),
  threadId: threadId(`wait_thread_${unique}`),
  runId: runId(`wait_run_${unique}`),
  rootRunId: runId(`wait_run_${unique}`),
  workspaceId: workspaceId(`wait_workspace_${unique}`),
};
const attemptId = `wait_attempt_${unique}`;
const checkpointId = `wait_checkpoint_${unique}`;
const changedRevision = `wait_revision_${unique}`;
const actorId = userId(`wait_user_${unique}`);
const databaseContext = { tenantId: scope.tenantId, userId: actorId };
const fence = Object.freeze({
  scope,
  runClaim: Object.freeze({
    token: "waiting-test-claim",
    epoch: 1,
    expiresAt: "2099-01-01T00:00:00.000Z" as never,
  }),
  workspaceLease: Object.freeze({
    rootRunId: scope.rootRunId,
    epoch: 1,
    expiresAt: "2099-01-01T00:00:00.000Z" as never,
  }),
}) satisfies ExecutionFence;
const rolloutContext = {
  scope: {
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    runId: scope.runId,
    attemptId,
    agentThreadId: agentThreadId(`wait_agent_${unique}`),
  },
  userId: actorId,
  fence,
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
const receiptKey = randomBytes(32);
let forgedReceipt = false;
const effectRequests: TrustedWaitingRecoveryEffectRequest[] = [];
let providerEntered: (() => void) | undefined;
let providerBlock: Promise<void> | undefined;
const effectProof = {
  registryId: `rebuilt_registry_${unique}`,
  providerSandboxId: `rebuilt_sandbox_${unique}`,
  generation: 1,
};
class MutableEffectAdapter implements TestingWaitingRecoveryEffectAdapter {
  async execute(
    input: TrustedWaitingRecoveryEffectRequest,
  ): ReturnType<TestingWaitingRecoveryEffectAdapter["execute"]> {
    effectRequests.push(input);
    providerEntered?.();
    if (providerBlock !== undefined) await providerBlock;
    const responseDigest = digestCanonical({ request: input, result: effectProof });
    return {
      outcome: "succeeded" as const,
      receipt: {
        ...effectProof,
        requestDigest: input.requestDigest,
        responseDigest,
        attestation: forgedReceipt
          ? "forged"
          : createHmac("sha256", receiptKey).update(responseDigest).digest("hex"),
      },
    };
  }
}
class MutableReceiptVerifier implements TestingWaitingRecoveryReceiptVerifier {
  verify(input: { receipt: { responseDigest: string; attestation: string } }) {
    return (
      input.receipt.attestation ===
      createHmac("sha256", receiptKey).update(input.receipt.responseDigest).digest("hex")
    );
  }
}
const effectAdapter = new MutableEffectAdapter();
const receiptVerifier = new MutableReceiptVerifier();
let replacedPrototypeExecuteCalls = 0;
let replacedPrototypeVerifyCalls = 0;
let schemaCreated = false;
let roleCreated = false;
let raceClaim!: PgWaitingRecoveryClaim;
let raceIntentId = "";
let raceCheckpointId = "";
let stalePendingCheckpointId = "";
let pauseUnknownClaim!: PgWaitingRecoveryClaim;

async function appendWaitingCheckpointFact(nextCheckpointId: string): Promise<void> {
  const rollout = new PgRuntimeRolloutRepository(runtime);
  const appended = await rollout.append({
    context: rolloutContext,
    idempotencyKey: `wait-entry-${nextCheckpointId}`,
    entries: [{ kind: "waiting", body: { checkpointId: nextCheckpointId } }],
  });
  if (appended.outcome !== "created") throw new Error("测试 waiting Rollout 写入失败");
  const sequence = appended.value[0]?.sequence;
  if (sequence === undefined) throw new Error("测试 waiting Rollout 缺少序号");
  const checkpoint = await rollout.writeCheckpoint({
    context: rolloutContext,
    idempotencyKey: `wait-checkpoint-${nextCheckpointId}`,
    checkpointId: nextCheckpointId,
    windowStartSequence: sequence,
    throughSequence: sequence,
    projection: { turns: [] },
    replacementHistory: [],
  });
  if (checkpoint.outcome !== "created") throw new Error("测试 waiting checkpoint 写入失败");
  await withTenantTransaction(runtime, databaseContext, async (client) => {
    const next = await client.query<{ sequence: string }>(
      `UPDATE execution_attempts SET next_event_sequence=next_event_sequence+1
        WHERE tenant_id=$1 AND attempt_id=$2 RETURNING (next_event_sequence-1)::text AS sequence`,
      [scope.tenantId, attemptId],
    );
    await client.query(
      `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
       VALUES($1,$2,$3,1,'run_waiting',$4::jsonb)`,
      [
        scope.tenantId,
        attemptId,
        next.rows[0]?.sequence,
        JSON.stringify({ question: "继续？", checkpointId: nextCheckpointId }),
      ],
    );
  });
}

async function holdPendingEffectRow(
  nextCheckpointId: string,
  intentId: string,
  effect: "connect" | "create" | "materialize",
): Promise<{ readonly release: () => void; readonly done: Promise<void> }> {
  let release!: () => void;
  let locked!: () => void;
  let lockFailed!: (reason: unknown) => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rowLocked = new Promise<void>((resolve, reject) => {
    locked = resolve;
    lockFailed = reject;
  });
  const done = withTenantTransaction(runtime, databaseContext, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM waiting_recovery_effect_outbox
        WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3 AND effect=$4
          AND state='pending' FOR UPDATE`,
      [scope.tenantId, nextCheckpointId, intentId, effect],
    );
    if (result.rowCount !== 1) throw new Error("未找到待阻塞的 pending effect 行");
    locked();
    await released;
  });
  void done.catch(lockFailed);
  await rowLocked;
  return { release, done };
}

async function waitUntilReserveOwnsCheckpoint(nextCheckpointId: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await withTenantTransaction(runtime, databaseContext, async (client) => {
        await client.query("SET LOCAL lock_timeout='25ms'");
        await client.query(
          `SELECT 1 FROM waiting_recovery_checkpoints
            WHERE tenant_id=$1 AND checkpoint_id=$2 FOR UPDATE`,
          [scope.tenantId, nextCheckpointId],
        );
      });
    } catch (error) {
      if ((error as { readonly code?: string }).code === "55P03") return;
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("reserve 未在限时内持有 checkpoint 行锁");
}

async function waitUntilCheckpointDeadline(
  nextCheckpointId: string,
  deadline: "claim_expires_at" | "sandbox_expires_at",
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const expired = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ expired: boolean }>(
        `SELECT ${deadline}<=clock_timestamp() AS expired
           FROM waiting_recovery_checkpoints
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, nextCheckpointId],
      ),
    );
    if (expired.rows[0]?.expired === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reserve 等待期间 ${deadline} 未在限时内过期`);
}

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapUrl, maxConnections: 2 });
  await admin.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${skillPublisherRole}" LOGIN PASSWORD '${skillPublisherPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${workerCoordinatorRole}" LOGIN PASSWORD '${workerCoordinatorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${teamCoordinatorRole}" LOGIN PASSWORD '${teamCoordinatorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${adminControlRole}" LOGIN PASSWORD '${adminControlPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
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
    await client.query(
      `INSERT INTO workspace_write_leases(
         tenant_id,workspace_id,thread_id,root_run_id,epoch,expires_at)
       VALUES($1,$2,$3,$4,1,clock_timestamp()+interval '1 hour')`,
      [scope.tenantId, scope.workspaceId, scope.threadId, scope.rootRunId],
    );
    await client.query(
      `INSERT INTO execution_workspace_fences(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,lease_epoch,initial_expires_at
       ) VALUES($1,$2,$3,$4,$5,$3,1,clock_timestamp()+interval '1 hour')`,
      [scope.tenantId, attemptId, scope.runId, scope.threadId, scope.workspaceId],
    );
    await client.query(
      `INSERT INTO run_claims(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,worker_id,
         claim_token,claim_epoch,workspace_lease_epoch,expires_at
       ) VALUES($1,$2,$3,$4,$5,$3,'waiting-test','waiting-test-claim',1,1,
         clock_timestamp()+interval '1 hour')`,
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
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  expect(() =>
    createTestingPgWaitingRecoveryStore(runtime, effectAdapter, receiptVerifier, 30),
  ).toThrow("生产路径禁止");
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  store = createTestingPgWaitingRecoveryStore(runtime, effectAdapter, receiptVerifier, 30);
  MutableEffectAdapter.prototype.execute = async () => {
    replacedPrototypeExecuteCalls += 1;
    return { outcome: "unknown" as const };
  };
  MutableReceiptVerifier.prototype.verify = () => {
    replacedPrototypeVerifyCalls += 1;
    return true;
  };
  const compatiblePort: WaitingRecoveryStorePort = store;
  expect(compatiblePort).toBe(store);
  const recoveryModule = await import(
    "../../runtime-ts/packages/persistence/src/pg-waiting-recovery.js"
  );
  expect("PgWaitingRecoveryStore" in recoveryModule).toBe(false);
  expect("completeEffect" in store).toBe(false);
  expect(Object.isFrozen(store)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(store))).toBe(true);
  expect(Reflect.get(store, "constructor")).toBeUndefined();
  expect(Reflect.set(store, "execute", async () => ({ outcome: "completed" }))).toBe(false);
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
    await expect(
      migrateDown(migrator, {
        ...migrationSecurity,
        allowDestructive: true,
        environment: "test",
        targetVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", message: "执行回退迁移失败" });
    const rollback = await migrator.query<{ checkpoint_table: string; version_12: string }>(
      `SELECT to_regclass('waiting_recovery_checkpoints')::text AS checkpoint_table,
              (SELECT count(*)::text FROM runtime_schema_migrations WHERE version=12) AS version_12`,
    );
    expect(rollback.rows[0]).toEqual({
      checkpoint_table: "waiting_recovery_checkpoints",
      version_12: "1",
    });
    await migrator.end();
  }
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (roleCreated) {
    await admin.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
       DROP ROLE "${adminControlRole}";
       DROP ROLE "${teamCoordinatorRole}";
       DROP ROLE "${workerCoordinatorRole}";
       DROP ROLE "${skillPublisherRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin) await admin.end();
});

describe("waiting recovery PostgreSQL 事实源", () => {
  it("完整 Scope 并发 claim 只有一个胜者，错误 Scope 与跨租户均不可见", async () => {
    const [left, right] = await Promise.all([
      store.claim({ scope, attemptId, checkpointId, workerId: "worker-left" }),
      store.claim({ scope, attemptId, checkpointId, workerId: "worker-right" }),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["busy", "claimed"]);
    expect(
      (
        await store.claim({
          scope: { ...scope, threadId: threadId(`wrong_${unique}`) },
          attemptId,
          checkpointId,
          workerId: "wrong",
        })
      ).outcome,
    ).toBe("not_found");
    expect(
      (
        await store.claim({
          scope,
          attemptId: `wrong_attempt_${unique}`,
          checkpointId,
          workerId: "wrong-attempt",
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
    const first = await store.claim({ scope, attemptId, checkpointId, workerId: "reclaim-first" });
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
        : await store.claim({ scope, attemptId, checkpointId, workerId: "reclaim-old" });
    if (old.outcome !== "claimed") throw new Error("测试需要旧 claim");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        "UPDATE waiting_recovery_checkpoints SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND checkpoint_id=$2",
        [scope.tenantId, checkpointId],
      ),
    );
    const reclaimed = await store.claim({
      scope,
      attemptId,
      checkpointId,
      workerId: "reclaim-new",
    });
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
    const acquired = await store.claim({ scope, attemptId, checkpointId, workerId: "saga" });
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
        effect,
      });
      if (intent.outcome !== "authorized") throw new Error("测试需要 intent");
      const callsBeforeForgery = effectRequests.length;
      expect(
        await store.execute({
          claim: { ...acquired.claim, claimToken: "forged-claim" },
          intentId: intent.intentId,
          effect,
        }),
      ).toEqual({ outcome: "claim_lost" });
      expect(effectRequests).toHaveLength(callsBeforeForgery);
      expect(
        await store.execute({
          claim: acquired.claim,
          intentId: intent.intentId,
          effect,
        }),
      ).toEqual({ outcome: "completed" });
    }
    expect(
      (
        await store.beginEffect({
          claim: acquired.claim,
          decision,
          effect: "materialize",
        })
      ).outcome,
    ).toBe("already_completed");
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        `INSERT INTO workspace_revisions(
           tenant_id,workspace_id,id,thread_id,revision_number,created_by_run_id,
           lease_epoch,object_key,digest,created_at
         ) VALUES($1,$2,$3,$4,1,$5,1,'test/wait-revision',$6,clock_timestamp())`,
        [
          scope.tenantId,
          scope.workspaceId,
          changedRevision,
          scope.threadId,
          scope.runId,
          hash("a"),
        ],
      );
      await client.query(
        `UPDATE workspaces SET current_revision_id=$3,current_revision_number=1,
            updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, scope.workspaceId, changedRevision],
      );
    });
    expect(
      (
        await store.beginEffect({
          claim: acquired.claim,
          decision: { ...decision, workspace: "replan" },
          effect: "materialize",
        })
      ).outcome,
    ).toBe("claim_lost");
    expect(await store.resolve({ claim: acquired.claim, decision })).toBe("claim_lost");
    await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query(
        `UPDATE workspaces SET current_revision_id=NULL,current_revision_number=0,
            updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, scope.workspaceId],
      ),
    );
    const [resolved, concurrentAppend] = await Promise.all([
      store.resolve({
        claim: acquired.claim,
        decision,
      }),
      new PgRuntimeRolloutRepository(runtime).append({
        context: rolloutContext,
        idempotencyKey: `wait-concurrent-append-${unique}`,
        entries: [{ kind: "assistant", body: { text: "concurrent append" } }],
      }),
    ]);
    expect(resolved).toBe("resolved");
    expect(concurrentAppend.outcome).toBe("created");
    const facts = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{
        run_count: string;
        rollout_count: string;
        decision: string;
        reason: string;
        rollout_body: unknown;
        rollout_digest: string;
      }>(
        `SELECT
          (SELECT count(*) FROM run_events WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery_decided')::text AS run_count,
          (SELECT count(*) FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery')::text AS rollout_count,
          (SELECT payload->>'decision' FROM run_events WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery_decided') AS decision,
          (SELECT payload->>'reason' FROM run_events WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery_decided') AS reason,
          (SELECT body FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery') AS rollout_body,
          (SELECT body_digest FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2
            AND kind='sandbox_recovery') AS rollout_digest`,
        [scope.tenantId, attemptId],
      ),
    );
    expect(facts.rows[0]).toMatchObject({
      run_count: "1",
      rollout_count: "1",
      decision: "sandbox_rebuilt",
      reason: "missing",
    });
    expect(facts.rows[0]?.rollout_digest).toBe(digestCanonical(facts.rows[0]?.rollout_body));
    expect(
      await store.resolve({
        claim: acquired.claim,
        decision,
      }),
    ).toBe("already_resolved");
  });

  it("伪造 attestation 在 provider 返回后收敛 UNKNOWN 且不会重投", async () => {
    const forgedCheckpointId = `wait_forged_${unique}`;
    await appendWaitingCheckpointFact(forgedCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: forgedCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: forgedCheckpointId,
      workerId: "forged-receipt-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 forged claim");
    const intent = await store.beginEffect({
      claim: acquired.claim,
      decision: {
        outcome: "resume",
        workspace: "unchanged",
        sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
      },
      effect: "create",
    });
    if (intent.outcome !== "authorized") throw new Error("测试需要 forged intent");
    forgedReceipt = true;
    const callsBefore = effectRequests.length;
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: intent.intentId,
        effect: "create",
      }),
    ).toEqual({ outcome: "unknown", effect: "create" });
    forgedReceipt = false;
    expect(effectRequests).toHaveLength(callsBefore + 1);
    expect(replacedPrototypeExecuteCalls).toBe(0);
    expect(replacedPrototypeVerifyCalls).toBe(0);
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: intent.intentId,
        effect: "create",
      }),
    ).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
  });

  it("崩溃后 Workspace 从 unchanged 变为 replan 时可复用已完成 connect", async () => {
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET state='paused',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(
           tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,
           identity_digest,disposition,payload,payload_digest,remote_call_started_at
         ) VALUES($1,$2,$3,$4,$5,'completed',true,$6,'pause','{}'::jsonb,$7,clock_timestamp())`,
        [
          scope.tenantId,
          attemptId,
          `pause-completed-${unique}`,
          effectProof.registryId,
          effectProof.providerSandboxId,
          "c".repeat(64),
          "d".repeat(64),
        ],
      );
    });
    const replanCheckpointId = `wait_replan_${unique}`;
    await appendWaitingCheckpointFact(replanCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: replanCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: replanCheckpointId,
      workerId: "replan-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 replan claim");
    const unchangedDecision = {
      outcome: "resume",
      workspace: "unchanged",
      sandbox: {
        kind: "sandbox_reused",
        registryId: effectProof.registryId,
        generation: effectProof.generation,
      },
    } as const;
    const connect = await store.beginEffect({
      claim: acquired.claim,
      decision: unchangedDecision,
      effect: "connect",
    });
    if (connect.outcome !== "authorized") throw new Error("测试需要 connect intent");
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: connect.intentId,
        effect: "connect",
      }),
    ).toEqual({ outcome: "completed" });
    await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query(
        `UPDATE workspaces SET current_revision_id=$3,current_revision_number=1,
            updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, scope.workspaceId, changedRevision],
      ),
    );
    const replanDecision = { ...unchangedDecision, workspace: "replan" } as const;
    expect(
      (
        await store.beginEffect({
          claim: acquired.claim,
          decision: replanDecision,
          effect: "connect",
        })
      ).outcome,
    ).toBe("already_completed");
    const materialize = await store.beginEffect({
      claim: acquired.claim,
      decision: replanDecision,
      effect: "materialize",
    });
    if (materialize.outcome !== "authorized") throw new Error("测试需要 materialize intent");
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: materialize.intentId,
        effect: "materialize",
      }),
    ).toEqual({ outcome: "completed" });
    expect(effectRequests.at(-1)).toMatchObject({
      scope: {
        tenantId: scope.tenantId,
        threadId: scope.threadId,
        runId: scope.runId,
        workspaceId: scope.workspaceId,
      },
      checkpointId: replanCheckpointId,
      attemptId,
      attemptGeneration: 1,
      effect: "materialize",
      providerSandboxId: effectProof.providerSandboxId,
      workspace: {
        headRevisionId: changedRevision,
        manifestDigest: hash("a"),
      },
    });
    expect(await store.resolve({ claim: acquired.claim, decision: replanDecision })).toBe(
      "resolved",
    );
    await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query(
        `UPDATE workspaces SET current_revision_id=NULL,current_revision_number=0,
            updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, scope.workspaceId],
      ),
    );
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
      attemptId,
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
    const callsBeforeExpiredExecute = effectRequests.length;
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: intent.intentId,
        effect: "create",
      }),
    ).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBeforeExpiredExecute);
    expect(
      (
        await store.claim({
          scope,
          attemptId,
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

  it("reserve 等待 outbox 行锁时 claim 租约过期，最终 CAS 禁止 provider 调用", async () => {
    const reserveLeaseCheckpointId = `wait_reserve_lease_${unique}`;
    await appendWaitingCheckpointFact(reserveLeaseCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: reserveLeaseCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: reserveLeaseCheckpointId,
      workerId: "reserve-lease-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 reserve lease claim");
    const intent = await store.beginEffect({
      claim: acquired.claim,
      decision: {
        outcome: "resume",
        workspace: "unchanged",
        sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
      },
      effect: "create",
    });
    if (intent.outcome !== "authorized") throw new Error("测试需要 reserve lease intent");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE waiting_recovery_checkpoints
            SET claim_expires_at=clock_timestamp()+interval '500 milliseconds'
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, reserveLeaseCheckpointId],
      ),
    );
    const blocker = await holdPendingEffectRow(reserveLeaseCheckpointId, intent.intentId, "create");
    const callsBefore = effectRequests.length;
    const executing = store.execute({
      claim: acquired.claim,
      intentId: intent.intentId,
      effect: "create",
    });
    await waitUntilReserveOwnsCheckpoint(reserveLeaseCheckpointId);
    await waitUntilCheckpointDeadline(reserveLeaseCheckpointId, "claim_expires_at");
    blocker.release();
    await blocker.done;
    expect(await executing).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBefore);
    const pending = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ state: string }>(
        `SELECT state FROM waiting_recovery_effect_outbox
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3`,
        [scope.tenantId, reserveLeaseCheckpointId, intent.intentId],
      ),
    );
    expect(pending.rows[0]?.state).toBe("pending");
    expect(
      (
        await store.claim({
          scope,
          attemptId,
          checkpointId: reserveLeaseCheckpointId,
          workerId: "reserve-lease-reconciler",
        })
      ).outcome,
    ).toBe("resolved");
  });

  it("provider 进入后 claim 租约过期，只调用一次并收敛 UNKNOWN", async () => {
    const postCasLeaseCheckpointId = `wait_post_cas_lease_${unique}`;
    await appendWaitingCheckpointFact(postCasLeaseCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: postCasLeaseCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: postCasLeaseCheckpointId,
      workerId: "post-cas-lease-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 post-CAS lease claim");
    const intent = await store.beginEffect({
      claim: acquired.claim,
      decision: {
        outcome: "resume",
        workspace: "unchanged",
        sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
      },
      effect: "create",
    });
    if (intent.outcome !== "authorized") throw new Error("测试需要 post-CAS lease intent");
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    providerBlock = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const callsBefore = effectRequests.length;
    const executing = store.execute({
      claim: acquired.claim,
      intentId: intent.intentId,
      effect: "create",
    });
    await entered;
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE waiting_recovery_checkpoints
            SET claim_expires_at=clock_timestamp()-interval '1 second'
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, postCasLeaseCheckpointId],
      ),
    );
    releaseProvider();
    providerEntered = undefined;
    providerBlock = undefined;
    expect(await executing).toEqual({ outcome: "unknown", effect: "create" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: intent.intentId,
        effect: "create",
      }),
    ).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
  });

  it("reserve 等待 outbox 行锁时暖池 TTL 过期，最终 CAS 禁止 connect", async () => {
    const cleanupIdempotencyKey = `pause-reserve-ttl-${unique}`;
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        `UPDATE sandbox_registry
            SET state='paused',actual_ttl_seconds=30,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(
           tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,
           identity_digest,disposition,payload,payload_digest,remote_call_started_at
         ) VALUES($1,$2,$3,$4,$5,'completed',true,$6,'pause','{}'::jsonb,$7,clock_timestamp())`,
        [
          scope.tenantId,
          attemptId,
          cleanupIdempotencyKey,
          effectProof.registryId,
          effectProof.providerSandboxId,
          "e".repeat(64),
          "f".repeat(64),
        ],
      );
    });
    const reserveTtlCheckpointId = `wait_reserve_ttl_${unique}`;
    await appendWaitingCheckpointFact(reserveTtlCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: reserveTtlCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: reserveTtlCheckpointId,
      workerId: "reserve-ttl-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 reserve TTL claim");
    const decision = {
      outcome: "resume",
      workspace: "unchanged",
      sandbox: {
        kind: "sandbox_reused",
        registryId: effectProof.registryId,
        generation: effectProof.generation,
      },
    } as const;
    const intent = await store.beginEffect({ claim: acquired.claim, decision, effect: "connect" });
    if (intent.outcome !== "authorized") throw new Error("测试需要 reserve TTL intent");
    await withTenantTransaction(migrator, databaseContext, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET actual_ttl_seconds=1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      );
      await client.query(
        `WITH refreshed AS (
           UPDATE cleanup_outbox SET updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3
            RETURNING updated_at
         )
         UPDATE waiting_recovery_checkpoints checkpoint
            SET sandbox_paused_at=refreshed.updated_at,
                sandbox_expires_at=refreshed.updated_at+interval '1 second'
           FROM refreshed
          WHERE checkpoint.tenant_id=$1 AND checkpoint.checkpoint_id=$4`,
        [scope.tenantId, attemptId, cleanupIdempotencyKey, reserveTtlCheckpointId],
      );
    });
    const blocker = await holdPendingEffectRow(reserveTtlCheckpointId, intent.intentId, "connect");
    const callsBefore = effectRequests.length;
    const executing = store.execute({
      claim: acquired.claim,
      intentId: intent.intentId,
      effect: "connect",
    });
    await waitUntilReserveOwnsCheckpoint(reserveTtlCheckpointId);
    await waitUntilCheckpointDeadline(reserveTtlCheckpointId, "sandbox_expires_at");
    blocker.release();
    await blocker.done;
    expect(await executing).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBefore);
    const pending = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ state: string }>(
        `SELECT state FROM waiting_recovery_effect_outbox
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3`,
        [scope.tenantId, reserveTtlCheckpointId, intent.intentId],
      ),
    );
    expect(pending.rows[0]?.state).toBe("pending");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE waiting_recovery_checkpoints
            SET claim_expires_at=clock_timestamp()-interval '1 second'
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, reserveTtlCheckpointId],
      ),
    );
    expect(
      (
        await store.claim({
          scope,
          attemptId,
          checkpointId: reserveTtlCheckpointId,
          workerId: "reserve-ttl-reconciler",
        })
      ).outcome,
    ).toBe("resolved");
  });

  it("provider 进入后暖池 TTL 过期，connect 只调用一次并收敛 UNKNOWN", async () => {
    const cleanupIdempotencyKey = `pause-post-cas-ttl-${unique}`;
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        `UPDATE sandbox_registry
            SET state='paused',actual_ttl_seconds=30,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(
           tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,
           identity_digest,disposition,payload,payload_digest,remote_call_started_at
         ) VALUES($1,$2,$3,$4,$5,'completed',true,$6,'pause','{}'::jsonb,$7,clock_timestamp())`,
        [
          scope.tenantId,
          attemptId,
          cleanupIdempotencyKey,
          effectProof.registryId,
          effectProof.providerSandboxId,
          "1".repeat(64),
          "2".repeat(64),
        ],
      );
    });
    const postCasTtlCheckpointId = `wait_post_cas_ttl_${unique}`;
    await appendWaitingCheckpointFact(postCasTtlCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: postCasTtlCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: postCasTtlCheckpointId,
      workerId: "post-cas-ttl-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 post-CAS TTL claim");
    const decision = {
      outcome: "resume",
      workspace: "unchanged",
      sandbox: {
        kind: "sandbox_reused",
        registryId: effectProof.registryId,
        generation: effectProof.generation,
      },
    } as const;
    const intent = await store.beginEffect({ claim: acquired.claim, decision, effect: "connect" });
    if (intent.outcome !== "authorized") throw new Error("测试需要 post-CAS TTL intent");
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    providerBlock = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const callsBefore = effectRequests.length;
    const executing = store.execute({
      claim: acquired.claim,
      intentId: intent.intentId,
      effect: "connect",
    });
    await entered;
    await withTenantTransaction(migrator, databaseContext, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET actual_ttl_seconds=1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      );
      await client.query(
        `WITH refreshed AS (
           UPDATE cleanup_outbox SET updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3
            RETURNING updated_at
         )
         UPDATE waiting_recovery_checkpoints checkpoint
            SET sandbox_paused_at=refreshed.updated_at,
                sandbox_expires_at=refreshed.updated_at+interval '1 second'
           FROM refreshed
          WHERE checkpoint.tenant_id=$1 AND checkpoint.checkpoint_id=$4`,
        [scope.tenantId, attemptId, cleanupIdempotencyKey, postCasTtlCheckpointId],
      );
    });
    await waitUntilCheckpointDeadline(postCasTtlCheckpointId, "sandbox_expires_at");
    releaseProvider();
    providerEntered = undefined;
    providerBlock = undefined;
    expect(await executing).toEqual({ outcome: "unknown", effect: "connect" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
    expect(
      await store.execute({
        claim: acquired.claim,
        intentId: intent.intentId,
        effect: "connect",
      }),
    ).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
  });

  it("pause UNKNOWN 由 registry/outbox 事实推导并禁止自动 create", async () => {
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET state='unknown',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(
           tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,
           identity_digest,disposition,payload,payload_digest,remote_call_started_at
         ) VALUES($1,$2,$3,$4,$5,'unknown',true,$6,'pause','{}'::jsonb,$7,clock_timestamp())`,
        [
          scope.tenantId,
          attemptId,
          `pause-unknown-${unique}`,
          effectProof.registryId,
          effectProof.providerSandboxId,
          "a".repeat(64),
          "b".repeat(64),
        ],
      );
    });
    const pauseCheckpointId = `wait_pause_unknown_${unique}`;
    await appendWaitingCheckpointFact(pauseCheckpointId);
    expect(
      await store.record({
        scope,
        attemptId,
        checkpointId: pauseCheckpointId,
        workspaceHeadAtWait: { outcome: "empty" },
      }),
    ).toBe("created");
    const acquired = await store.claim({
      scope,
      attemptId,
      checkpointId: pauseCheckpointId,
      workerId: "pause-unknown-worker",
    });
    if (acquired.outcome !== "claimed") throw new Error("测试需要 pause UNKNOWN claim");
    pauseUnknownClaim = acquired.claim;
    expect(acquired.claim.checkpoint.sandbox?.lifecycle).toBe("pause_unknown");
    expect(
      decideWaitingRecovery(acquired.claim.checkpoint, {
        now: acquired.claim.databaseNow,
        currentWorkspaceHead: { outcome: "empty" },
        canReplanWorkspaceChange: false,
      }),
    ).toEqual({
      outcome: "external_effect_unknown",
      effect: "pause",
      requestAutomaticRetry: false,
    });
  });

  it("provider 执行中 Attempt generation 换代时只调用一次并收敛 UNKNOWN", async () => {
    await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='ready',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [scope.tenantId, effectProof.registryId],
      ),
    );
    const preparePending = async (nextCheckpointId: string, workerId: string) => {
      await appendWaitingCheckpointFact(nextCheckpointId);
      expect(
        await store.record({
          scope,
          attemptId,
          checkpointId: nextCheckpointId,
          workspaceHeadAtWait: { outcome: "empty" },
        }),
      ).toBe("created");
      const acquired = await store.claim({
        scope,
        attemptId,
        checkpointId: nextCheckpointId,
        workerId,
      });
      if (acquired.outcome !== "claimed") throw new Error("测试需要 generation claim");
      const intent = await store.beginEffect({
        claim: acquired.claim,
        decision: {
          outcome: "resume",
          workspace: "unchanged",
          sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
        },
        effect: "create",
      });
      if (intent.outcome !== "authorized") throw new Error("测试需要 generation intent");
      return { claim: acquired.claim, intentId: intent.intentId };
    };
    stalePendingCheckpointId = `wait_stale_pending_${unique}`;
    await preparePending(stalePendingCheckpointId, "stale-pending-worker");
    raceCheckpointId = `wait_generation_race_${unique}`;
    const preparedRace = await preparePending(raceCheckpointId, "generation-race-worker");
    raceClaim = preparedRace.claim;
    raceIntentId = preparedRace.intentId;
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    providerBlock = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const callsBefore = effectRequests.length;
    const execution = store.execute({
      claim: raceClaim,
      intentId: raceIntentId,
      effect: "create",
    });
    await entered;
    const replacementAttemptId = `replacement_attempt_${unique}`;
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      // 与真实 Attempt 创建路径共用 runs 行锁，与 reserve/complete 形成线性化顺序。
      await client.query(`SELECT 1 FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
        scope.tenantId,
        scope.runId,
      ]);
      await client.query(
        `INSERT INTO execution_attempts(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage
         ) VALUES($1,$2,$3,$4,$5,$3,'claimed','claimed')`,
        [scope.tenantId, replacementAttemptId, scope.runId, scope.threadId, scope.workspaceId],
      );
      await client.query(
        `INSERT INTO execution_workspace_fences(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,lease_epoch,initial_expires_at
         ) VALUES($1,$2,$3,$4,$5,$3,2,clock_timestamp()+interval '1 hour')`,
        [scope.tenantId, replacementAttemptId, scope.runId, scope.threadId, scope.workspaceId],
      );
      await client.query(
        `INSERT INTO run_claims(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,worker_id,
           claim_token,claim_epoch,workspace_lease_epoch,expires_at
         ) VALUES($1,$2,$3,$4,$5,$3,'replacement','replacement-claim',2,2,
           clock_timestamp()+interval '1 hour')`,
        [scope.tenantId, replacementAttemptId, scope.runId, scope.threadId, scope.workspaceId],
      );
    });
    releaseProvider();
    providerEntered = undefined;
    providerBlock = undefined;
    expect(await execution).toEqual({ outcome: "unknown", effect: "create" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
    expect(
      await store.execute({
        claim: raceClaim,
        intentId: raceIntentId,
        effect: "create",
      }),
    ).toEqual({ outcome: "claim_lost" });
    expect(effectRequests).toHaveLength(callsBefore + 1);
    expect(
      await store.resolve({
        claim: pauseUnknownClaim,
        decision: {
          outcome: "external_effect_unknown",
          effect: "pause",
          requestAutomaticRetry: false,
        },
      }),
    ).toBe("claim_lost");
    expect(await store.reconcileExpiredEffect(scope, attemptId, stalePendingCheckpointId)).toBe(
      "unknown",
    );
    const states = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ checkpoint_id: string; checkpoint_state: string; effect_state: string }>(
        `SELECT checkpoint.checkpoint_id,checkpoint.state AS checkpoint_state,
                effect.state AS effect_state
           FROM waiting_recovery_checkpoints checkpoint
           JOIN waiting_recovery_effect_outbox effect USING(tenant_id,checkpoint_id)
          WHERE checkpoint.tenant_id=$1 AND checkpoint.checkpoint_id IN ($2,$3)
          ORDER BY checkpoint.checkpoint_id`,
        [scope.tenantId, raceCheckpointId, stalePendingCheckpointId],
      ),
    );
    expect(states.rows).toHaveLength(2);
    expect(states.rows.every((row) => row.checkpoint_state === "unknown")).toBe(true);
    expect(states.rows.every((row) => row.effect_state === "unknown")).toBe(true);
  });
});
