import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encodeControlledToolReceipt, ToolObservationPipeline } from "@hoox/context-policy";
import { agentThreadId, runId, sha256Digest, tenantId, threadId, userId } from "@hoox/domain";
import type { ExecutionFence } from "@hoox/run-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  PgRuntimeRolloutRepository,
  type TrustedRolloutContext,
} from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { PgToolObservationRolloutAdapter } from "../../runtime-ts/packages/persistence/src/tool-observation-rollout-adapter.js";
import { loadPostgreSqlMigrationContract } from "./postgres-migration-contract.js";

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
const schema = `it_ptc_${unique}`;
const migratorRole = `it_ptc_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherRole = `it_ptc_pub_${unique}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorRole = `it_ptc_coord_${unique}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const adminControlRole = workerCoordinatorRole.replace("_coord_", "_control_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const adminControlPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const migrationSecurity = {
  runtimeRole,
  migratorRole,
  skillPublisherRole,
  workerCoordinatorRole,
  teamCoordinatorRole,
  adminControlRole,
  schema,
} as const;

const hash = (character: string) => sha256Digest(character.repeat(64));
const attemptId = `ptc_attempt_${unique}`;
const executionScope = {
  tenantId: tenantId(`ptc_tenant_${unique}`),
  threadId: threadId(`ptc_thread_${unique}`),
  runId: runId(`ptc_run_${unique}`),
  rootRunId: runId(`ptc_run_${unique}`),
  workspaceId: `ptc_workspace_${unique}` as never,
};
const fence = {
  scope: executionScope,
  runClaim: {
    token: `ptc_claim_${unique}`,
    epoch: 1,
    expiresAt: "2099-01-01T00:00:00.000Z" as never,
  },
  workspaceLease: {
    rootRunId: executionScope.rootRunId,
    epoch: 1,
    expiresAt: "2099-01-01T00:00:00.000Z" as never,
  },
} as unknown as ExecutionFence;
const scope = {
  tenantId: executionScope.tenantId,
  threadId: executionScope.threadId,
  runId: executionScope.runId,
  attemptId,
  agentThreadId: agentThreadId(
    `root_${createHash("sha256").update(attemptId, "utf8").digest("hex")}`,
  ),
};
const context = { scope, userId: userId(`ptc_user_${unique}`), fence };
const databaseContext = { tenantId: scope.tenantId, userId: context.userId };
const workspaceId = executionScope.workspaceId;

let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repository!: PgRuntimeRolloutRepository;
let schemaCreated = false;
let migratorCreated = false;

const compatibility = {
  modelId: "provider/model:test",
  modelCompatibilityHash: hash("1"),
  promptPolicyHash: hash("2"),
  toolSchemaHash: hash("3"),
  skillManifestHash: hash("4"),
};

const controlled = encodeControlledToolReceipt("read", "succeeded");
const traceDigest = sha256Digest(createHash("sha256").update(controlled).digest("hex"));
const traceSize = Buffer.byteLength(controlled, "utf8");
const parentToolCallId = `outer_ptc_${unique}`;
let trace: {
  readonly referenceId: string;
  readonly sha256: ReturnType<typeof sha256Digest>;
  readonly size: number;
};
function start(toolCallId: string) {
  return {
    context,
    toolCallId,
    parentToolCallId,
    toolName: "read",
    idempotencyKey: `start.${toolCallId}`,
  };
}
function result(toolCallId: string, blob = trace) {
  return {
    context,
    toolCallId,
    parentToolCallId,
    idempotencyKey: `result.${toolCallId}`,
    isTruncated: false,
    blob,
    body: {
      schemaVersion: 2,
      toolName: "read",
      receiptSha256: blob.sha256,
      receiptBytes: blob.size,
      receipt: JSON.parse(controlled) as Record<string, unknown>,
      traceBlob: { referenceId: blob.referenceId },
      truncation: { isTruncated: false, modelVisibleBytes: traceSize },
      observation: controlled,
    },
  };
}
async function seedStableBlob(
  purpose: "trace" | "resource",
  label: string,
  digest = traceDigest,
  size = traceSize,
) {
  const operationId = `rollout-blob-operation-${label}-${unique}`;
  const referenceId = `rollout-blob-reference-${label}-${unique}`;
  const lifecycleId = randomUUID();
  const incarnationId = randomUUID();
  const physicalObjectKey = `integration/rollout/${label}/${incarnationId}`;
  await withTenantTransaction(runtime, databaseContext, async (client) => {
    await client.query(
      `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot)
       VALUES ($1,$2,'completed',0,'{}'::jsonb)`,
      [scope.tenantId, operationId],
    );
    const existing = await client.query<{
      lifecycle_id: string;
      incarnation_id: string;
      physical_object_key: string;
    }>(
      `SELECT lifecycle.lifecycle_id, incarnation.incarnation_id, incarnation.physical_object_key
       FROM blob_lifecycles lifecycle JOIN blob_incarnations incarnation
         ON incarnation.tenant_id=lifecycle.tenant_id
        AND incarnation.incarnation_id=lifecycle.current_incarnation_id
       WHERE lifecycle.tenant_id=$1 AND lifecycle.purpose=$2
         AND lifecycle.sha256=$3 AND lifecycle.size=$4 AND lifecycle.state='active'`,
      [scope.tenantId, purpose, digest, size],
    );
    const identity = existing.rows[0];
    if (identity === undefined) {
      await client.query(
        `INSERT INTO blob_lifecycles(
           tenant_id,lifecycle_id,purpose,sha256,size,state,current_incarnation_id,generation
         ) VALUES ($1,$2,$3,$4,$5,'active',$6,1)`,
        [scope.tenantId, lifecycleId, purpose, digest, size, incarnationId],
      );
      await client.query(
        `INSERT INTO blob_incarnations(
           tenant_id,lifecycle_id,purpose,sha256,size,incarnation_id,physical_object_key,state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [scope.tenantId, lifecycleId, purpose, digest, size, incarnationId, physicalObjectKey],
      );
    }
    await client.query(
      `INSERT INTO blob_references(
         tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,
         staging_upload_id,lifecycle_id,incarnation_id,physical_object_key
       ) VALUES ($1,$2,$3,'stable',$4,$5,$6,'application/json',$7,$8,$9,$10)`,
      [
        scope.tenantId,
        referenceId,
        operationId,
        purpose,
        digest,
        size,
        `staging-${label}-${unique}`,
        identity?.lifecycle_id ?? lifecycleId,
        identity?.incarnation_id ?? incarnationId,
        identity?.physical_object_key ?? physicalObjectKey,
      ],
    );
  });
  return { referenceId, sha256: digest, size };
}
async function seedExecution(
  seededContext: TrustedRolloutContext = context,
  options: { readonly createTenant?: boolean; readonly createRun?: boolean } = {},
): Promise<void> {
  const { scope, fence } = seededContext;
  const workspaceId = fence.scope.workspaceId;
  await withTenantTransaction(
    runtime,
    { tenantId: scope.tenantId, userId: seededContext.userId },
    async (client) => {
      if (options.createTenant !== false) {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, clock_timestamp())", [
          seededContext.userId,
        ]);
        await client.query(
          "INSERT INTO tenants(id, kind, owner_user_id, created_at) VALUES ($1,'personal',$2,clock_timestamp())",
          [scope.tenantId, seededContext.userId],
        );
        await client.query(
          `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
         VALUES ($1,$2,$3,'owner','active',clock_timestamp())`,
          [scope.tenantId, `rollout_member_${unique}`, seededContext.userId],
        );
      }
      if (options.createRun !== false) {
        await client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
         VALUES ($1,$2,$3,'Rollout 集成测试','active',clock_timestamp(),clock_timestamp())`,
          [scope.tenantId, scope.threadId, seededContext.userId],
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
          `INSERT INTO workspace_write_leases(
           tenant_id,workspace_id,thread_id,root_run_id,epoch,expires_at)
         VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '30 minutes')`,
          [scope.tenantId, workspaceId, scope.threadId, scope.runId, fence.workspaceLease.epoch],
        );
      }
      await client.query(
        `INSERT INTO execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage
       ) VALUES ($1,$2,$3,$4,$5,$3,'running','model_execution_started')`,
        [scope.tenantId, scope.attemptId, scope.runId, scope.threadId, workspaceId],
      );
      await client.query(
        `INSERT INTO execution_workspace_fences(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
         lease_epoch,initial_expires_at)
       VALUES ($1,$2,$3,$4,$5,$3,$6,clock_timestamp()+interval '30 minutes')`,
        [
          scope.tenantId,
          scope.attemptId,
          scope.runId,
          scope.threadId,
          workspaceId,
          fence.workspaceLease.epoch,
        ],
      );
      await client.query(
        `INSERT INTO run_claims(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
         worker_id,claim_token,claim_epoch,workspace_lease_epoch,expires_at)
       VALUES ($1,$2,$3,$4,$5,$3,'rollout-worker',$6,$7,$8,
               clock_timestamp()+interval '30 minutes')`,
        [
          scope.tenantId,
          scope.attemptId,
          scope.runId,
          scope.threadId,
          workspaceId,
          fence.runClaim.token,
          fence.runClaim.epoch,
          fence.workspaceLease.epoch,
        ],
      );
    },
  );
}

function independentContext(label: string): TrustedRolloutContext {
  const nextAttemptId = `ptc_attempt_${label}_${unique}`;
  const nextRunId = runId(`ptc_run_${label}_${unique}`);
  const nextThreadId = threadId(`ptc_thread_${label}_${unique}`);
  return {
    ...context,
    scope: {
      ...scope,
      threadId: nextThreadId,
      runId: nextRunId,
      attemptId: nextAttemptId,
      agentThreadId: agentThreadId(
        `root_${createHash("sha256").update(nextAttemptId).digest("hex")}`,
      ),
    },
    fence: {
      scope: {
        ...executionScope,
        threadId: nextThreadId,
        runId: nextRunId,
        rootRunId: nextRunId,
        workspaceId: `ptc_workspace_${label}_${unique}` as never,
      },
      runClaim: { ...fence.runClaim, token: `ptc_claim_${label}_${unique}` },
      workspaceLease: { ...fence.workspaceLease, rootRunId: nextRunId },
    },
  };
}

async function openPtcParent(scopedContext: TrustedRolloutContext): Promise<void> {
  expect(
    await repository.openRootStreamFromClaim({
      fence: scopedContext.fence,
      attemptId: scopedContext.scope.attemptId,
      compatibility,
    }),
  ).toMatchObject({ outcome: "ready", context: { scope: scopedContext.scope } });
  expect(
    await repository.append({
      context: scopedContext,
      idempotencyKey: "outer.start",
      entries: [
        { kind: "tool_call", toolCallId: parentToolCallId, body: { toolName: "run_code" } },
      ],
    }),
  ).toMatchObject({ outcome: "created" });
}

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapDatabaseUrl, maxConnections: 2 });
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
  const migrationContract = await loadPostgreSqlMigrationContract();
  expect((await migrateUp(migrator, migrationSecurity)).at(-1)?.version).toBe(
    migrationContract.latestVersion,
  );
  repository = new PgRuntimeRolloutRepository(runtime);
  await seedExecution();
  expect(
    await repository.openRootStreamFromClaim({
      fence,
      attemptId: scope.attemptId,
      compatibility,
    }),
  ).toMatchObject({ outcome: "ready" });
  trace = await seedStableBlob("trace", "receipt");
  expect(
    await repository.append({
      context,
      idempotencyKey: "outer.start",
      entries: [
        { kind: "tool_call", toolCallId: parentToolCallId, body: { toolName: "run_code" } },
      ],
    }),
  ).toMatchObject({ outcome: "created" });
});

afterAll(async () => {
  if (runtime !== undefined) await runtime.end();
  if (schemaCreated) {
    const table = await admin.query("SELECT to_regclass($1) AS name", [
      `${schema}.runtime_ptc_dispatches`,
    ]);
    if (table.rows[0]?.name !== null) {
      // 只清理本套件专用 schema 的夹具。
      await admin.query(`DELETE FROM "${schema}".runtime_ptc_dispatches`);
    }
  }
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
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
       DROP ROLE "${adminControlRole}";
       DROP ROLE "${teamCoordinatorRole}";
       DROP ROLE "${workerCoordinatorRole}";
       DROP ROLE "${skillPublisherRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin !== undefined) await admin.end();
});

function committedButUnknownPool(upstream: Pool, afterCommit?: () => Promise<void>): Pool {
  let armed = true;
  const connect = upstream.connect.bind(upstream);
  return new Proxy(upstream, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          const result = await (query as (...values: unknown[]) => Promise<unknown>)(...args);
          if (armed && args[0] === "COMMIT") {
            armed = false;
            // 真实提交已成功，仅丢弃提交响应；坏连接必须由事务边界丢弃后按同键核对。
            await afterCommit?.();
            throw Object.assign(new Error("测试模拟提交响应未知"), { code: "ECONNRESET" });
          }
          return result;
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
}

function rollbackAfterStreamInsertPool(
  upstream: Pool,
  insertFragment: string,
): { readonly pool: Pool; readonly inserted: Promise<void>; readonly release: () => void } {
  let signalInserted!: () => void;
  let releaseInsert!: () => void;
  const inserted = new Promise<void>((resolve) => {
    signalInserted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseInsert = resolve;
  });
  let armed = true;
  const connect = upstream.connect.bind(upstream);
  const pool = new Proxy(upstream, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          const result = await (query as (...values: unknown[]) => Promise<unknown>)(...args);
          const sql = typeof args[0] === "string" ? args[0] : "";
          if (armed && sql.includes(insertFragment)) {
            armed = false;
            signalInserted();
            await gate;
            throw new Error("测试强制竞争建流事务回滚");
          }
          return result;
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return { pool, inserted, release: releaseInsert };
}

function observingAdvisoryWaitPool(
  upstream: Pool,
  requestNumber = 1,
): {
  readonly pool: Pool;
  readonly requested: Promise<number>;
} {
  let signalRequested!: (pid: number) => void;
  const requested = new Promise<number>((resolve) => {
    signalRequested = resolve;
  });
  let advisoryRequests = 0;
  const connect = upstream.connect.bind(upstream);
  const pool = new Proxy(upstream, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : "";
          if (sql.includes("pg_advisory_xact_lock(hashtextextended")) {
            advisoryRequests += 1;
            if (advisoryRequests === requestNumber) {
              const pidResult = await (
                query as (...values: unknown[]) => Promise<{
                  rows: { pid: number }[];
                }>
              )("SELECT pg_backend_pid() AS pid");
              const pid = pidResult.rows[0]?.pid;
              if (pid === undefined) throw new Error("未能读取流锁等待连接 PID");
              signalRequested(pid);
            }
          }
          return (query as (...values: unknown[]) => Promise<unknown>)(...args);
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return { pool, requested };
}

function observationBinding(scopedContext: TrustedRolloutContext) {
  return {
    ...scopedContext.scope,
    rootRunId: scopedContext.fence.scope.rootRunId,
    workspaceId: scopedContext.fence.scope.workspaceId,
    runClaimToken: scopedContext.fence.runClaim.token,
    runClaimEpoch: scopedContext.fence.runClaim.epoch,
    workspaceLeaseRootRunId: scopedContext.fence.workspaceLease.rootRunId,
    workspaceLeaseEpoch: scopedContext.fence.workspaceLease.epoch,
  };
}

const binding = {
  ...scope,
  rootRunId: executionScope.rootRunId,
  workspaceId,
  runClaimToken: fence.runClaim.token,
  runClaimEpoch: fence.runClaim.epoch,
  workspaceLeaseRootRunId: fence.workspaceLease.rootRunId,
  workspaceLeaseEpoch: fence.workspaceLease.epoch,
};

describe("PTC 独立 durable journal PostgreSQL 事实源", () => {
  it.each(["root_from_claim", "root_direct", "subagent"] as const)(
    "%s 建流在竞争事务回滚且租约于等待中到期后拒绝插入",
    async (operation) => {
      const target = independentContext(`open_${operation}`);
      await seedExecution(target, { createTenant: false });
      let agentContext = target;
      let insertFragment = "INSERT INTO runtime_agent_threads";
      if (operation === "subagent") {
        expect(
          await repository.openRootStreamFromClaim({
            fence: target.fence,
            attemptId: target.scope.attemptId,
            compatibility,
          }),
        ).toMatchObject({ outcome: "ready" });
        const childId = agentThreadId(`lease_child_${unique}`);
        await withTenantTransaction(runtime, { tenantId: target.scope.tenantId }, (client) =>
          client.query(
            `INSERT INTO runtime_agent_threads(
               tenant_id,thread_id,run_id,attempt_id,agent_thread_id,parent_agent_thread_id,
               canonical_path,kind,status,task
             ) VALUES($1,$2,$3,$4,$5,$6,$7,'subagent','open','lease race')`,
            [
              target.scope.tenantId,
              target.scope.threadId,
              target.scope.runId,
              target.scope.attemptId,
              childId,
              target.scope.agentThreadId,
              `/root/lease_${unique}`,
            ],
          ),
        );
        agentContext = {
          ...target,
          scope: { ...target.scope, agentThreadId: childId },
        };
        insertFragment = "INSERT INTO runtime_rollout_streams";
      }
      const setClaimLease = (duration: string) =>
        withTenantTransaction(migrator, { tenantId: target.scope.tenantId }, async (client) => {
          const updated = await client.query<{ expires_at: string }>(
            `UPDATE run_claims SET expires_at=clock_timestamp()+$3::interval
              WHERE tenant_id=$1 AND attempt_id=$2 RETURNING expires_at::text`,
            [target.scope.tenantId, target.scope.attemptId, duration],
          );
          const expiry = updated.rows[0]?.expires_at;
          if (expiry === undefined) throw new Error("找不到建流竞争用 claim");
          return expiry;
        });
      const open = (repo: PgRuntimeRolloutRepository, direct: boolean) =>
        operation === "subagent"
          ? repo.openAgentStreamFromClaim({
              fence: target.fence,
              attemptId: target.scope.attemptId,
              compatibility,
              agentThreadId: agentContext.scope.agentThreadId,
              agentKind: "subagent",
            })
          : direct
            ? repo.openRootStream({
                context: target,
                workspaceId: target.fence.scope.workspaceId,
                rootRunId: target.fence.scope.rootRunId,
                compatibility,
              })
            : repo.openRootStreamFromClaim({
                fence: target.fence,
                attemptId: target.scope.attemptId,
                compatibility,
              });
      await setClaimLease("2 seconds");
      const losing = rollbackAfterStreamInsertPool(runtime, insertFragment);
      const first = open(new PgRuntimeRolloutRepository(losing.pool), operation === "root_direct");
      let second: ReturnType<typeof open> | undefined;
      try {
        await losing.inserted;
        const waitingPool = observingAdvisoryWaitPool(runtime);
        const contender = new PgRuntimeRolloutRepository(waitingPool.pool);
        second = open(contender, operation !== "root_direct");
        const pid = await Promise.race([
          waitingPool.requested,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("建流竞争者未请求流锁")), 1_000),
          ),
        ]);
        await expect
          .poll(
            async () => {
              const state = await admin.query<{ waiting: boolean }>(
                "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
                [pid],
              );
              return state.rows[0]?.waiting;
            },
            { timeout: 1_000 },
          )
          .toBe(true);
        const expiry = await withTenantTransaction(
          runtime,
          { tenantId: target.scope.tenantId },
          async (client) => {
            const result = await client.query<{ expires_at: string }>(
              "SELECT expires_at::text FROM run_claims WHERE tenant_id=$1 AND attempt_id=$2",
              [target.scope.tenantId, target.scope.attemptId],
            );
            return result.rows[0]?.expires_at;
          },
        );
        if (expiry === undefined) throw new Error("建流竞争用 claim 已丢失");
        await withTenantTransaction(runtime, { tenantId: target.scope.tenantId }, (client) =>
          client.query(
            "SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))",
            [expiry],
          ),
        );
      } finally {
        losing.release();
      }
      await first.catch(() => undefined);
      const secondResult = await second;
      expect(typeof secondResult === "string" ? secondResult : secondResult.outcome).toBe(
        "not_authorized",
      );
      const counts = await withTenantTransaction(
        runtime,
        { tenantId: target.scope.tenantId },
        async (client) =>
          client.query<{ streams: string; agent_threads: string }>(
            `SELECT
               (SELECT count(*) FROM runtime_rollout_streams WHERE tenant_id=$1 AND attempt_id=$2
                 AND agent_thread_id=$3)::text AS streams,
               (SELECT count(*) FROM runtime_agent_threads WHERE tenant_id=$1 AND attempt_id=$2
                 AND agent_thread_id=$3)::text AS agent_threads`,
            [target.scope.tenantId, target.scope.attemptId, agentContext.scope.agentThreadId],
          ),
      );
      expect(counts.rows[0]).toEqual({
        streams: "0",
        agent_threads: operation === "subagent" ? "1" : "0",
      });
      await setClaimLease("30 minutes");
    },
  );

  it.each([
    { operation: "append", lease: "claim" },
    { operation: "checkpoint", lease: "workspace" },
    { operation: "ptc_start", lease: "workspace" },
    { operation: "ptc_result", lease: "claim" },
  ] as const)("$operation 等待流锁时 $lease 租约过期，不写入事实", async ({ operation, lease }) => {
    const target = independentContext(operation);
    const { scope } = target;
    const tenant = { tenantId: scope.tenantId };
    await seedExecution(target, { createTenant: false });
    await openPtcParent(target);
    const append = () =>
      repository.append({
        context: target,
        idempotencyKey: "outer.complete",
        entries: [{ kind: "tool_result", toolCallId: parentToolCallId, body: { finished: true } }],
      });
    const appendPtcStart = () =>
      repository.appendPtcToolCall({ ...start("inner_waits_for_lock"), context: target });
    if (operation === "checkpoint") expect(await append()).toMatchObject({ outcome: "created" });
    if (operation === "ptc_result") {
      expect(await appendPtcStart()).toMatchObject({ outcome: "created" });
    }
    const write = {
      append,
      checkpoint: () =>
        repository.writeCheckpoint({
          context: target,
          idempotencyKey: "checkpoint.after_parent",
          checkpointId: "checkpoint.after_parent",
          windowStartSequence: 0,
          throughSequence: 1,
          projection: { summary: "压缩工具对" },
          replacementHistory: [{ from: 0, through: 1 }],
        }),
      ptc_start: appendPtcStart,
      ptc_result: () =>
        repository.appendPtcToolResult({ ...result("inner_waits_for_lock"), context: target }),
    }[operation];
    const readFacts = () =>
      withTenantTransaction(runtime, tenant, async (client) => {
        const facts = await client.query(
          `SELECT
             (SELECT count(*) FROM runtime_rollout_entries WHERE attempt_id=$1) AS entries,
             (SELECT count(*) FROM runtime_rollout_append_commands WHERE attempt_id=$1) AS appends,
             (SELECT count(*) FROM runtime_rollout_checkpoints WHERE attempt_id=$1) AS checkpoints,
             (SELECT count(*) FROM runtime_rollout_checkpoint_commands WHERE attempt_id=$1) AS checkpoint_commands,
             (SELECT count(*) FROM runtime_rollout_replacements WHERE attempt_id=$1) AS replacements,
             (SELECT count(*) FROM runtime_ptc_dispatches WHERE attempt_id=$1) AS ptc_starts,
             (SELECT count(result_digest) FROM runtime_ptc_dispatches WHERE attempt_id=$1) AS ptc_results`,
          [scope.attemptId],
        );
        return facts.rows;
      });
    const setLease = (duration: string) =>
      withTenantTransaction(migrator, tenant, async (client) => {
        const updated = await client.query<{ expires_at: string }>(
          lease === "claim"
            ? `UPDATE run_claims SET expires_at=clock_timestamp()+$3::interval
                WHERE tenant_id=$1 AND attempt_id=$2 RETURNING expires_at::text`
            : `UPDATE workspace_write_leases SET expires_at=clock_timestamp()+$3::interval
                WHERE tenant_id=$1 AND workspace_id=$2 RETURNING expires_at::text`,
          [
            scope.tenantId,
            lease === "claim" ? scope.attemptId : target.fence.scope.workspaceId,
            duration,
          ],
        );
        const deadline = updated.rows[0]?.expires_at;
        if (deadline === undefined) throw new Error("找不到用例租约");
        return deadline;
      });

    const before = await readFacts();
    let pending: ReturnType<typeof write> | undefined;
    try {
      await withTenantTransaction(runtime, tenant, async (holder) => {
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          [scope.tenantId, scope.threadId, scope.runId, scope.attemptId, scope.agentThreadId].join(
            "\u001f",
          ),
        ]);
        const deadline = await setLease("2 seconds");
        pending = write();
        void pending.catch(() => undefined);
        // 必须观察到仍在租期内的真实锁等待，不能把写入未开始误判为过期后拒绝。
        await expect
          .poll(
            async () => {
              const waiting = await holder.query<{ blocked: boolean }>(
                `SELECT $1::timestamptz > clock_timestamp() AND EXISTS (
                   SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
                     AND pg_backend_pid()=ANY(pg_blocking_pids(pid))
                 ) AS blocked`,
                [deadline],
              );
              return waiting.rows[0]?.blocked;
            },
            { timeout: 2_000 },
          )
          .toBe(true);
        await holder.query(
          `SELECT pg_sleep(greatest(0, extract(epoch FROM $1::timestamptz - clock_timestamp())))`,
          [deadline],
        );
      });
    } catch (error) {
      await pending?.catch(() => undefined);
      throw error;
    }
    expect(await pending).toEqual({ outcome: "not_authorized" });
    expect(await readFacts()).toEqual(before);
    await setLease("30 minutes");
    expect(await write()).toMatchObject({ outcome: "created" });
  });

  it("native 流不接纳内层调用，journal 开始与结果均不消耗 Rollout sequence", async () => {
    await expect(
      repository.append({
        context,
        idempotencyKey: "native.inner.invalid",
        entries: [{ kind: "tool_call", toolCallId: "native_inner", body: { toolName: "read" } }],
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(await repository.appendPtcToolCall(start("inner_first"))).toMatchObject({
      outcome: "created",
    });
    expect(await repository.appendPtcToolResult(result("inner_first"))).toMatchObject({
      outcome: "created",
    });
    expect(await repository.loadRecovery({ context, compatibility })).toMatchObject({
      outcome: "loaded",
      tail: [{ sequence: 0, kind: "tool_call", toolCallId: parentToolCallId }],
    });
    const journal = await repository.listPtcDispatchesByParent({ context, parentToolCallId });
    expect(journal).toMatchObject({
      outcome: "loaded",
      dispatches: [
        {
          toolCallId: "inner_first",
          parentToolCallId,
          toolName: "read",
          runClaimEpoch: 1,
          workspaceLeaseEpoch: 1,
          result: {
            body: result("inner_first").body,
            blob: { ...trace, kind: "stable", purpose: "trace" },
          },
        },
      ],
    });
    if (journal.outcome !== "loaded") throw new Error("测试需要可核对的 journal");
    expect(journal.dispatches[0]?.result?.blob?.incarnationId).toBeTruthy();
    expect(journal.dispatches[0]?.result?.blob?.physicalObjectKey).toBeTruthy();
  });

  it("未截断回执以 schemaVersion 3 内联写入 journal，不引用 Blob 且可同键重放", async () => {
    const toolCallId = "inner_inline";
    const inline = {
      context,
      toolCallId,
      parentToolCallId,
      idempotencyKey: `result.${toolCallId}`,
      isTruncated: false,
      body: {
        schemaVersion: 3,
        toolName: "read",
        receipt: JSON.parse(controlled) as Record<string, unknown>,
        truncation: { isTruncated: false, modelVisibleBytes: traceSize },
        observation: controlled,
      },
    };
    expect(await repository.appendPtcToolCall(start(toolCallId))).toMatchObject({
      outcome: "created",
    });
    await expect(
      repository.appendPtcToolResult({ ...inline, isTruncated: true }),
    ).rejects.toThrow();
    expect(await repository.appendPtcToolResult(inline)).toMatchObject({ outcome: "created" });
    expect(await repository.appendPtcToolResult(inline)).toMatchObject({ outcome: "replayed" });
    const journal = await repository.listPtcDispatchesByParent({ context, parentToolCallId });
    if (journal.outcome !== "loaded") throw new Error("测试需要可核对的 journal");
    const dispatch = journal.dispatches.find((item) => item.toolCallId === toolCallId);
    expect(dispatch?.result?.body).toEqual(inline.body);
    expect(dispatch?.result).not.toHaveProperty("blob");
  });

  it("并发同 ID 同正文只开始一次、结果一次；不同正文或幂等键冲突", async () => {
    const command = start("inner_idempotent");
    const starts = await Promise.all([
      repository.appendPtcToolCall(command),
      repository.appendPtcToolCall(command),
    ]);
    expect(starts.map((item) => item.outcome).sort()).toEqual(["created", "replayed"]);
    const completion = result(command.toolCallId);
    const results = await Promise.all([
      repository.appendPtcToolResult(completion),
      repository.appendPtcToolResult(completion),
    ]);
    expect(results.map((item) => item.outcome).sort()).toEqual(["created", "replayed"]);
    expect(await repository.appendPtcToolCall({ ...command, toolName: "write" })).toEqual({
      outcome: "conflict",
    });
    expect(
      await repository.appendPtcToolCall({ ...command, idempotencyKey: "start.other" }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await repository.appendPtcToolCall({ ...command, toolCallId: "inner_key_reused" }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await repository.appendPtcToolResult({ ...completion, idempotencyKey: "result.other" }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await repository.appendPtcToolResult({
        ...completion,
        body: {
          ...completion.body,
          truncation: {
            isTruncated: true,
            reason: "model_utf8_budget_or_rollout_body_budget",
            modelVisibleBytes: 0,
          },
          observation: "",
        },
        isTruncated: true,
      }),
    ).toEqual({ outcome: "conflict" });
    await repository.appendPtcToolCall(start("inner_second"));
    expect(
      await repository.appendPtcToolResult({
        ...result("inner_second"),
        idempotencyKey: completion.idempotencyKey,
      }),
    ).toEqual({ outcome: "conflict" });
    const journal = await repository.listPtcDispatchesByParent({ context, parentToolCallId });
    if (journal.outcome !== "loaded") throw new Error("测试需要可核对的 journal");
    expect(
      journal.dispatches.filter((item) => item.toolCallId === command.toolCallId),
    ).toHaveLength(1);
    expect(
      journal.dispatches.find((item) => item.toolCallId === "inner_second"),
    ).not.toHaveProperty("result");
  });

  it("同租户不同 Run 复用 Provider 父 ID、内层 ID 和幂等键仍独立，不能跨 scope replay", async () => {
    const otherContext = independentContext("same_provider_id");
    await seedExecution(otherContext, { createTenant: false });
    await openPtcParent(otherContext);
    const toolCallId = `ptc.${createHash("sha256").update(parentToolCallId).digest("hex")}.1`;
    const command = start(toolCallId);
    const completion = result(toolCallId);
    expect(await repository.appendPtcToolCall(command)).toMatchObject({ outcome: "created" });
    expect(await repository.appendPtcToolResult(completion)).toMatchObject({ outcome: "created" });
    expect(await repository.appendPtcToolResult({ ...completion, context: otherContext })).toEqual({
      outcome: "not_found",
    });
    // 相同 ID 和正文不能借用另一个 Run 的开始或结果；每个 scope 必须实际写入自己的事实。
    expect(await repository.appendPtcToolCall({ ...command, context: otherContext })).toMatchObject(
      { outcome: "created" },
    );
    const otherTrace = await seedStableBlob("trace", "same_id_other_run");
    expect(
      await repository.appendPtcToolResult({
        ...result(toolCallId, otherTrace),
        context: otherContext,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(await repository.appendPtcToolResult(completion)).toMatchObject({ outcome: "replayed" });
    for (const [scopedContext, scopedTrace] of [
      [context, trace],
      [otherContext, otherTrace],
    ] as const) {
      const journal = await repository.listPtcDispatchesByParent({
        context: scopedContext,
        parentToolCallId,
      });
      if (journal.outcome !== "loaded") throw new Error("测试需要可核对的 journal");
      expect(journal.dispatches.filter((item) => item.toolCallId === toolCallId)).toEqual([
        expect.objectContaining({
          toolCallId,
          result: expect.objectContaining({
            blob: expect.objectContaining(scopedTrace),
          }),
        }),
      ]);
      expect(
        await repository.loadRecovery({ context: scopedContext, compatibility }),
      ).toMatchObject({
        outcome: "loaded",
        tail: [{ sequence: 0, kind: "tool_call", toolCallId: parentToolCallId }],
      });
    }
  });

  it("同一 Run 的新 Attempt 可复用内层 ID 与幂等键，旧 Attempt 仅可核对而不能提供 replay", async () => {
    const previousContext = independentContext("attempt_reuse");
    await seedExecution(previousContext, { createTenant: false });
    await openPtcParent(previousContext);
    const toolCallId = "ptc.same_run_attempt.1";
    expect(
      await repository.appendPtcToolCall({ ...start(toolCallId), context: previousContext }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.appendPtcToolResult({ ...result(toolCallId), context: previousContext }),
    ).toMatchObject({ outcome: "created" });
    const nextAttemptId = `ptc_attempt_retry_${unique}`;
    const retryContext: TrustedRolloutContext = {
      ...previousContext,
      scope: {
        ...previousContext.scope,
        attemptId: nextAttemptId,
        agentThreadId: agentThreadId(
          `root_${createHash("sha256").update(nextAttemptId).digest("hex")}`,
        ),
      },
      fence: {
        ...previousContext.fence,
        runClaim: {
          ...previousContext.fence.runClaim,
          token: `ptc_retry_claim_${unique}`,
          epoch: 2,
        },
        workspaceLease: { ...previousContext.fence.workspaceLease, epoch: 2 },
      },
    };
    await withTenantTransaction(migrator, databaseContext, async (client) => {
      await client.query(
        "UPDATE execution_attempts SET status='failed',finished_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, previousContext.scope.attemptId],
      );
      await client.query(
        "UPDATE run_claims SET released_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, previousContext.scope.attemptId],
      );
      await client.query(
        "UPDATE workspace_write_leases SET epoch=2 WHERE tenant_id=$1 AND workspace_id=$2",
        [scope.tenantId, previousContext.fence.scope.workspaceId],
      );
    });
    await seedExecution(retryContext, { createTenant: false, createRun: false });
    await openPtcParent(retryContext);
    expect(
      await repository.appendPtcToolResult({ ...result(toolCallId), context: retryContext }),
    ).toEqual({ outcome: "not_found" });
    expect(
      await repository.appendPtcToolCall({ ...start(toolCallId), context: retryContext }),
    ).toMatchObject({ outcome: "created" });
    const retryTrace = await seedStableBlob("trace", "same_run_retry_attempt");
    expect(
      await repository.appendPtcToolResult({
        ...result(toolCallId, retryTrace),
        context: retryContext,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.appendPtcToolResult({ ...result(toolCallId), context: previousContext }),
    ).toEqual({ outcome: "not_authorized" });
    expect(
      await repository.listPtcDispatchesByParent({ context: previousContext, parentToolCallId }),
    ).toMatchObject({ outcome: "loaded", dispatches: [{ toolCallId, result: { blob: trace } }] });
    expect(
      await repository.listPtcDispatchesByParent({ context: retryContext, parentToolCallId }),
    ).toMatchObject({
      outcome: "loaded",
      dispatches: [
        { toolCallId, runClaimEpoch: 2, workspaceLeaseEpoch: 2, result: { blob: retryTrace } },
      ],
    });
  });

  it("提交响应未知后同键读回等待流锁跨过租约截止时保留 unknown", async () => {
    const target = independentContext("unknown_lease_replay");
    await seedExecution(target, { createTenant: false });
    expect(
      await repository.openRootStreamFromClaim({
        fence: target.fence,
        attemptId: target.scope.attemptId,
        compatibility,
      }),
    ).toMatchObject({ outcome: "ready" });
    let releaseHolder!: () => void;
    let signalHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHolder = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let deadline: string | undefined;
    let holderTask: Promise<void> | undefined;
    const afterCommit = async () => {
      holderTask = (async () => {
        const holder = await runtime.connect();
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT set_config('app.tenant_id',$1,true)", [target.scope.tenantId]);
          await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            [
              target.scope.tenantId,
              target.scope.threadId,
              target.scope.runId,
              target.scope.attemptId,
              target.scope.agentThreadId,
            ].join("\u001f"),
          ]);
          const update = await withTenantTransaction(
            migrator,
            { tenantId: target.scope.tenantId },
            (client) =>
              client.query<{ expires_at: string }>(
                `UPDATE run_claims SET expires_at=clock_timestamp()+interval '5 seconds'
                  WHERE tenant_id=$1 AND attempt_id=$2 RETURNING expires_at::text`,
                [target.scope.tenantId, target.scope.attemptId],
              ),
          );
          deadline = update.rows[0]?.expires_at;
          if (deadline === undefined) throw new Error("找不到未知提交重放用 claim");
          signalHolder();
          await hold;
          await holder.query("COMMIT");
        } catch (error) {
          await holder.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          holder.release();
        }
      })();
      // 先确认阻塞事务已持锁且租约已延后，再让首次 COMMIT 的未知结果触发重放。
      await held;
    };
    // 第一次 advisory lock 属于已提交的原写入；等待发生在同键重放。
    const observed = observingAdvisoryWaitPool(runtime, 2);
    const uncertainRepository = new PgRuntimeRolloutRepository(
      committedButUnknownPool(observed.pool, afterCommit),
    );
    const adapter = new PgToolObservationRolloutAdapter(uncertainRepository, target);
    const append = adapter.appendToolCall({
      binding: observationBinding(target),
      idempotencyKey: `unknown-expiry-${unique}`,
      toolCallId: `unknown-expiry-call-${unique}`,
      toolName: "sandbox_command",
    });
    try {
      await Promise.race([
        held,
        append.then(() => {
          throw new Error("首次写入未进入未知 COMMIT 响应处理");
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("首次写入 COMMIT 未触发锁持有者")), 5_000),
        ),
      ]);
      const pid = await Promise.race([
        observed.requested,
        append.then((outcome) => {
          throw new Error(`同键重放在流锁前终止：${JSON.stringify(outcome)}`);
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            void admin
              .query<{
                pid: number;
                wait_event_type: string | null;
                wait_event: string | null;
                query: string;
              }>(
                `SELECT pid,wait_event_type,wait_event,left(query,120) AS query
                   FROM pg_stat_activity WHERE datname=current_database()
                    AND query LIKE 'SELECT membership.user_id%' AND state='active'`,
              )
              .then((state) =>
                reject(new Error(`同键重放未请求流锁；活动授权查询=${JSON.stringify(state.rows)}`)),
              )
              .catch(reject);
          }, 1_000),
        ),
      ]);
      await expect
        .poll(
          async () => {
            const state = await admin.query<{ waiting: boolean }>(
              "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [pid],
            );
            return state.rows[0]?.waiting;
          },
          { timeout: 1_000 },
        )
        .toBe(true);
      if (deadline === undefined) throw new Error("未知提交测试未设置 claim 截止时间");
      await withTenantTransaction(runtime, { tenantId: target.scope.tenantId }, (client) =>
        client.query(
          "SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))",
          [deadline],
        ),
      );
    } finally {
      releaseHolder();
      await holderTask?.catch(() => undefined);
    }
    await expect(append).resolves.toEqual({ outcome: "unknown" });
    const facts = await withTenantTransaction(
      runtime,
      { tenantId: target.scope.tenantId },
      (client) =>
        client.query<{ entries: string; commands: string }>(
          `SELECT
           (SELECT count(*) FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2)::text AS entries,
           (SELECT count(*) FROM runtime_rollout_append_commands WHERE tenant_id=$1 AND attempt_id=$2)::text AS commands`,
          [target.scope.tenantId, target.scope.attemptId],
        ),
    );
    expect(facts.rows[0]).toEqual({ entries: "1", commands: "1" });
  });

  it("真实 COMMIT 响应未知后 adapter 按原 ID 原键收敛，pipeline 保留 parent 与固定截断回执", async () => {
    const toolCallId = "inner_pipeline_unknown";
    const beginAdapter = new PgToolObservationRolloutAdapter(
      new PgRuntimeRolloutRepository(committedButUnknownPool(runtime)),
      context,
    );
    expect(
      await beginAdapter.appendToolCall({
        binding,
        toolCallId,
        parentToolCallId,
        toolName: "read",
        idempotencyKey: "pipeline.start",
      }),
    ).toEqual({ outcome: "replayed" });
    const identity = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ incarnation_id: string; physical_object_key: string }>(
        "SELECT incarnation_id,physical_object_key FROM blob_references WHERE tenant_id=$1 AND reference_id=$2",
        [scope.tenantId, trace.referenceId],
      ),
    );
    const stable = identity.rows[0];
    if (stable === undefined) throw new Error("测试需要 stable trace 身份");
    const pipeline = new ToolObservationPipeline(
      {
        persistTrace: async () => ({
          outcome: "persisted",
          referenceId: trace.referenceId,
          blob: {
            kind: "stable",
            tenantId: scope.tenantId,
            purpose: "trace",
            sha256: trace.sha256,
            size: trace.size,
            incarnationId: stable.incarnation_id,
            physicalObjectKey: stable.physical_object_key,
          },
        }),
      },
      new PgToolObservationRolloutAdapter(
        new PgRuntimeRolloutRepository(committedButUnknownPool(runtime)),
        context,
      ),
      { readControlledReceipt: async () => controlled },
      { maxModelObservationBytes: 30 },
    );
    expect(
      await pipeline.record({
        binding,
        toolCallId,
        parentToolCallId,
        toolName: "read",
        idempotencyKey: "pipeline.receipt",
      }),
    ).toMatchObject({ outcome: "replayed", isTruncated: true });
    const journal = await repository.listPtcDispatchesByParent({ context, parentToolCallId });
    if (journal.outcome !== "loaded") throw new Error("测试需要可核对的 journal");
    const rows = journal.dispatches.filter((item) => item.toolCallId === toolCallId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: { isTruncated: true, body: { receipt: JSON.parse(controlled) } },
    });
  });

  it("真实 COMMIT 响应丢失后父调用闭合，开始不放行而结果可精确重放", async () => {
    const startContext = independentContext("unknown_closed_start");
    await seedExecution(startContext, { createTenant: false });
    await openPtcParent(startContext);
    const startId = `inner_unknown_parent_close_${unique}`;
    const closeStartParent = async () => {
      const closed = await repository.append({
        context: startContext,
        idempotencyKey: `outer.close.unknown.start.${unique}`,
        entries: [{ kind: "tool_result", toolCallId: parentToolCallId, body: { finished: true } }],
      });
      if (closed.outcome !== "created") throw new Error("测试需要闭合开始用例父调用");
    };
    const beginAdapter = new PgToolObservationRolloutAdapter(
      new PgRuntimeRolloutRepository(committedButUnknownPool(runtime, closeStartParent)),
      startContext,
    );
    expect(
      await beginAdapter.appendToolCall({
        binding: observationBinding(startContext),
        toolCallId: startId,
        parentToolCallId,
        toolName: "read",
        idempotencyKey: `start.unknown.parent.close.${unique}`,
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await repository.appendPtcToolCall({
        ...start(startId),
        context: startContext,
        idempotencyKey: `start.unknown.parent.close.${unique}`,
      }),
    ).toEqual({ outcome: "parent_closed" });
    expect(
      await repository.appendPtcToolCall({
        ...start(`new_after_closed_parent_${unique}`),
        context: startContext,
        idempotencyKey: `start.new.after.closed.${unique}`,
      }),
    ).toEqual({ outcome: "not_found" });

    const resultContext = independentContext("unknown_closed_result");
    await seedExecution(resultContext, { createTenant: false });
    await openPtcParent(resultContext);
    const resultId = `inner_result_unknown_parent_close_${unique}`;
    expect(
      await repository.appendPtcToolCall({ ...start(resultId), context: resultContext }),
    ).toMatchObject({ outcome: "created" });
    const completion = result(resultId);
    const closeResultParent = async () => {
      const closed = await repository.append({
        context: resultContext,
        idempotencyKey: `outer.close.unknown.result.${unique}`,
        entries: [{ kind: "tool_result", toolCallId: parentToolCallId, body: { finished: true } }],
      });
      if (closed.outcome !== "created") throw new Error("测试需要闭合结果用例父调用");
    };
    const resultAdapter = new PgToolObservationRolloutAdapter(
      new PgRuntimeRolloutRepository(committedButUnknownPool(runtime, closeResultParent)),
      resultContext,
    );
    expect(
      await resultAdapter.appendToolResult({
        binding: observationBinding(resultContext),
        toolCallId: resultId,
        parentToolCallId,
        idempotencyKey: completion.idempotencyKey,
        body: completion.body,
        isTruncated: completion.isTruncated,
        blob: completion.blob,
      }),
    ).toEqual({ outcome: "replayed" });
    expect(
      await repository.appendPtcToolResult({
        ...result(`new_result_after_closed_parent_${unique}`),
        context: resultContext,
        idempotencyKey: `result.new.after.closed.${unique}`,
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("同流复用父调用 ID 时按 parent_sequence 隔离旧 journal", async () => {
    const target = independentContext("reused_parent_id_sequence");
    await seedExecution(target, { createTenant: false });
    await openPtcParent(target);
    const oldChildId = `inner_old_parent_sequence_${unique}`;
    expect(
      await repository.appendPtcToolCall({ ...start(oldChildId), context: target }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.append({
        context: target,
        idempotencyKey: `outer.close.first.parent.${unique}`,
        entries: [{ kind: "tool_result", toolCallId: parentToolCallId, body: { finished: true } }],
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.append({
        context: target,
        idempotencyKey: `outer.reopen.same.id.${unique}`,
        entries: [
          { kind: "tool_call", toolCallId: parentToolCallId, body: { toolName: "run_code" } },
        ],
      }),
    ).toMatchObject({ outcome: "created" });

    const parentRows = await withTenantTransaction(
      runtime,
      { tenantId: target.scope.tenantId },
      (client) =>
        client.query<{ sequence: string }>(
          `SELECT sequence::text FROM runtime_rollout_entries
          WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3
            AND tool_call_id=$4 AND kind='tool_call' ORDER BY sequence`,
          [
            target.scope.tenantId,
            target.scope.attemptId,
            target.scope.agentThreadId,
            parentToolCallId,
          ],
        ),
    );
    expect(parentRows.rows.map((row) => row.sequence)).toEqual(["0", "2"]);
    const oldJournal = await withTenantTransaction(
      runtime,
      { tenantId: target.scope.tenantId },
      (client) =>
        client.query<{ parent_sequence: string }>(
          `SELECT parent_sequence::text FROM runtime_ptc_dispatches
          WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND tool_call_id=$4`,
          [target.scope.tenantId, target.scope.attemptId, target.scope.agentThreadId, oldChildId],
        ),
    );
    expect(oldJournal.rows[0]?.parent_sequence).toBe("0");
    expect(await repository.appendPtcToolCall({ ...start(oldChildId), context: target })).toEqual({
      outcome: "parent_closed",
    });
    expect(
      await repository.appendPtcToolResult({ ...result(oldChildId), context: target }),
    ).toEqual({ outcome: "parent_closed" });
    expect(
      await repository.appendPtcToolCall({
        ...start(`inner_new_parent_sequence_${unique}`),
        context: target,
      }),
    ).toMatchObject({ outcome: "created" });
    const resultFields = await withTenantTransaction(
      runtime,
      { tenantId: target.scope.tenantId },
      (client) =>
        client.query<{ result_digest: string | null; result_body: unknown | null }>(
          `SELECT result_digest,result_body FROM runtime_ptc_dispatches
            WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND tool_call_id=$4`,
          [target.scope.tenantId, target.scope.attemptId, target.scope.agentThreadId, oldChildId],
        ),
    );
    expect(resultFields.rows[0]).toEqual({ result_digest: null, result_body: null });
  });

  it("父关联拒绝错误 parent、跨 Agent/Run/Attempt/租户，结果必须先有开始", async () => {
    expect(
      await repository.appendPtcToolCall({
        ...start("inner_wrong_parent"),
        parentToolCallId: "missing_parent",
      }),
    ).toEqual({ outcome: "conflict" });
    expect(await repository.appendPtcToolResult(result("missing_start"))).toEqual({
      outcome: "not_found",
    });
    const otherAgent = {
      ...context,
      scope: { ...scope, agentThreadId: agentThreadId("agent_other") },
    };
    expect(
      await repository.appendPtcToolCall({ ...start("inner_cross_agent"), context: otherAgent }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await repository.appendPtcToolResult({ ...result("inner_first"), context: otherAgent }),
    ).toEqual({ outcome: "conflict" });
    for (const otherContext of [
      { ...context, scope: { ...scope, attemptId: "attempt_other" } },
      {
        ...context,
        scope: { ...scope, runId: runId("run_other") },
        fence: { ...fence, scope: { ...fence.scope, runId: runId("run_other") } },
      },
      {
        ...context,
        scope: { ...scope, tenantId: tenantId("tenant_other") },
        fence: { ...fence, scope: { ...fence.scope, tenantId: tenantId("tenant_other") } },
      },
    ]) {
      expect(
        await repository.appendPtcToolCall({
          ...start("inner_cross_scope"),
          context: otherContext,
        }),
      ).toEqual({ outcome: "not_authorized" });
      expect(
        await repository.appendPtcToolResult({ ...result("inner_first"), context: otherContext }),
      ).toEqual({ outcome: "not_authorized" });
    }
  });

  it("开始和结果每次重验 run claim 与 workspace lease 双栅栏", async () => {
    for (const invalidFence of [
      { ...fence, runClaim: { ...fence.runClaim, token: "wrong_claim" } },
      { ...fence, runClaim: { ...fence.runClaim, epoch: 2 } },
      { ...fence, workspaceLease: { ...fence.workspaceLease, epoch: 2 } },
    ]) {
      const invalidContext = { ...context, fence: invalidFence };
      expect(
        await repository.appendPtcToolCall({ ...start("inner_stale"), context: invalidContext }),
      ).toEqual({ outcome: "not_authorized" });
      expect(
        await repository.appendPtcToolResult({ ...result("inner_first"), context: invalidContext }),
      ).toEqual({ outcome: "not_authorized" });
    }
    await repository.appendPtcToolCall(start("inner_takeover"));
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        "UPDATE run_claims SET claim_token=$3,claim_epoch=2 WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, scope.attemptId, "takeover_claim"],
      ),
    );
    try {
      expect(await repository.appendPtcToolResult(result("inner_takeover"))).toEqual({
        outcome: "not_authorized",
      });
      const takeoverContext = {
        ...context,
        fence: { ...fence, runClaim: { ...fence.runClaim, token: "takeover_claim", epoch: 2 } },
      };
      expect(
        await repository.appendPtcToolResult({
          ...result("inner_takeover"),
          context: takeoverContext,
        }),
      ).toEqual({ outcome: "conflict" });
      // 失效 claim 下只读核对仍可识别未完成开始，不授权恢复重放。
      expect(
        await repository.listPtcDispatchesByParent({ context, parentToolCallId }),
      ).toMatchObject({ outcome: "loaded" });
    } finally {
      await withTenantTransaction(migrator, databaseContext, (client) =>
        client.query(
          "UPDATE run_claims SET claim_token=$3,claim_epoch=1 WHERE tenant_id=$1 AND attempt_id=$2",
          [scope.tenantId, scope.attemptId, fence.runClaim.token],
        ),
      );
    }
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        "UPDATE workspace_write_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND workspace_id=$2",
        [scope.tenantId, workspaceId],
      ),
    );
    try {
      expect(await repository.appendPtcToolCall(start("inner_expired"))).toEqual({
        outcome: "not_authorized",
      });
      expect(await repository.appendPtcToolResult(result("inner_takeover"))).toEqual({
        outcome: "not_authorized",
      });
    } finally {
      await withTenantTransaction(migrator, databaseContext, (client) =>
        client.query(
          "UPDATE workspace_write_leases SET expires_at=clock_timestamp()+interval '30 minutes' WHERE tenant_id=$1 AND workspace_id=$2",
          [scope.tenantId, workspaceId],
        ),
      );
    }
  });

  it("数据库 FK 再次拒绝 resource、staged、错误 stable digest 与缺失引用", async () => {
    const resource = await seedStableBlob("resource", "resource");
    const wrongDigest = await seedStableBlob("trace", "wrong_digest", hash("c"));
    const stagedReferenceId = `staged_ptc_${unique}`;
    await withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        "INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot) VALUES ($1,$2,'completed',0,'{}'::jsonb)",
        [scope.tenantId, stagedReferenceId],
      );
      await client.query(
        `INSERT INTO blob_references(tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,staging_upload_id)
        VALUES ($1,$2,$2,'staged','trace',$3,$4,'application/json',$2)`,
        [scope.tenantId, stagedReferenceId, traceDigest, traceSize],
      );
    });
    for (const [index, referenceId] of [
      resource.referenceId,
      wrongDigest.referenceId,
      stagedReferenceId,
      "missing_reference",
    ].entries()) {
      const toolCallId = `inner_bad_blob_${index}`;
      await repository.appendPtcToolCall(start(toolCallId));
      await expect(
        repository.appendPtcToolResult(result(toolCallId, { ...trace, referenceId })),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    }
    const journal = await repository.listPtcDispatchesByParent({ context, parentToolCallId });
    if (journal.outcome !== "loaded") throw new Error("测试需要可核对的 journal");
    expect(
      journal.dispatches
        .filter((item) => item.toolCallId.startsWith("inner_bad_blob_"))
        .every((item) => item.result === undefined),
    ).toBe(true);
  });

  it("拒绝伪造回执正文、任意输出及 observation，不从未知结果生成成功", async () => {
    await repository.appendPtcToolCall(start("inner_invalid_receipt"));
    const valid = result("inner_invalid_receipt");
    for (const body of [
      { ...valid.body, receipt: { ...valid.body.receipt, message: "随意宣称成功" } },
      { ...valid.body, receipt: { ...valid.body.receipt, outcome: "unknown" } },
      { ...valid.body, rawOutput: "原始工具输出" },
      {
        ...valid.body,
        observation: "伪造投影",
        truncation: { isTruncated: false, modelVisibleBytes: 12 },
      },
      { ...valid.body, receiptSha256: hash("f") },
    ]) {
      await expect(repository.appendPtcToolResult({ ...valid, body })).rejects.toThrow();
    }
    expect(await repository.appendPtcToolResult(valid)).toMatchObject({ outcome: "created" });
  });

  it("RLS 隔离、只读核对校验成员，并禁止修改开始身份和删除 journal", async () => {
    const membershipExistingId = `inner_membership_existing_${unique}`;
    expect(await repository.appendPtcToolCall(start(membershipExistingId))).toMatchObject({
      outcome: "created",
    });
    expect(await repository.appendPtcToolResult(result(membershipExistingId))).toMatchObject({
      outcome: "created",
    });
    const otherTenant = await withTenantTransaction(runtime, { tenantId: "ptc_other" }, (client) =>
      client.query("SELECT count(*)::text AS count FROM runtime_ptc_dispatches"),
    );
    expect(otherTenant.rows[0]?.count).toBe("0");
    expect(
      await repository.listPtcDispatchesByParent({
        context: { ...context, userId: userId("wrong_user") },
        parentToolCallId,
      }),
    ).toEqual({ outcome: "not_authorized" });
    for (const query of [
      "UPDATE runtime_ptc_dispatches SET tool_name='forged' WHERE tenant_id=$1",
      "DELETE FROM runtime_ptc_dispatches WHERE tenant_id=$1",
    ]) {
      await expect(
        withTenantTransaction(runtime, databaseContext, (client) =>
          client.query(query, [scope.tenantId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      withTenantTransaction(runtime, databaseContext, (client) =>
        client.query("TRUNCATE runtime_ptc_dispatches"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(runtime, databaseContext, (client) =>
        client.query(
          "UPDATE runtime_ptc_dispatches SET result_body='{}'::jsonb WHERE tenant_id=$1 AND tool_call_id='inner_first'",
          [scope.tenantId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query("UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2", [
        scope.tenantId,
        context.userId,
      ]),
    );
    try {
      expect(await repository.listPtcDispatchesByParent({ context, parentToolCallId })).toEqual({
        outcome: "not_authorized",
      });
      expect(await repository.appendPtcToolCall(start(membershipExistingId))).toEqual({
        outcome: "not_authorized",
      });
      expect(await repository.appendPtcToolCall(start("inner_revoked"))).toEqual({
        outcome: "not_authorized",
      });
      expect(await repository.appendPtcToolResult(result(membershipExistingId))).toEqual({
        outcome: "not_authorized",
      });
      expect(await repository.appendPtcToolResult(result("inner_missing_after_revoke"))).toEqual({
        outcome: "not_authorized",
      });
    } finally {
      await withTenantTransaction(migrator, databaseContext, (client) =>
        client.query("UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2", [
          scope.tenantId,
          context.userId,
        ]),
      );
    }
  });

  it("父 call 闭合后拒绝新开始但精确结果仍可重放；非 run_code 父拒绝，native 路径兼容", async () => {
    const pendingAfterCloseId = `inner_pending_after_close_${unique}`;
    expect(await repository.appendPtcToolCall(start(pendingAfterCloseId))).toMatchObject({
      outcome: "created",
    });
    expect(
      await repository.append({
        context,
        idempotencyKey: "outer.complete",
        entries: [{ kind: "tool_result", toolCallId: parentToolCallId, body: { finished: true } }],
      }),
    ).toMatchObject({ outcome: "created" });
    expect(await repository.appendPtcToolCall(start(pendingAfterCloseId))).toEqual({
      outcome: "parent_closed",
    });
    expect(await repository.appendPtcToolResult(result(pendingAfterCloseId))).toEqual({
      outcome: "parent_closed",
    });
    const pendingResult = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ result_digest: string | null; result_body: unknown | null }>(
        `SELECT result_digest,result_body FROM runtime_ptc_dispatches
          WHERE tenant_id=$1 AND attempt_id=$2 AND tool_call_id=$3`,
        [scope.tenantId, scope.attemptId, pendingAfterCloseId],
      ),
    );
    expect(pendingResult.rows[0]).toEqual({ result_digest: null, result_body: null });
    expect(await repository.appendPtcToolCall(start("inner_after_close"))).toEqual({
      outcome: "not_found",
    });
    expect(await repository.appendPtcToolResult(result("inner_first"))).toEqual({
      outcome: "replayed",
      value: undefined,
    });
    expect(await repository.appendPtcToolResult(result(`inner_new_after_close_${unique}`))).toEqual(
      {
        outcome: "not_found",
      },
    );
    const nativeCall = "native_read";
    expect(
      await repository.append({
        context,
        idempotencyKey: "native.call",
        entries: [{ kind: "tool_call", toolCallId: nativeCall, body: { toolName: "read" } }],
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.appendPtcToolCall({
        ...start("inner_non_code_parent"),
        parentToolCallId: nativeCall,
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await repository.append({
        context,
        idempotencyKey: "native.result",
        entries: [
          { kind: "tool_result", toolCallId: nativeCall, body: result("unused").body, blob: trace },
        ],
      }),
    ).toMatchObject({ outcome: "created" });
    const recovery = await repository.loadRecovery({ context, compatibility });
    if (recovery.outcome !== "loaded") throw new Error("测试需要已加载的 Rollout");
    expect(recovery.tail.map((entry) => entry.toolCallId)).toEqual([
      parentToolCallId,
      parentToolCallId,
      nativeCall,
      nativeCall,
    ]);
    expect(await repository.listPtcDispatchesByParent({ context, parentToolCallId })).toMatchObject(
      { outcome: "loaded" },
    );
  });
});
