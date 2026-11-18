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

function committedButUnknownPool(upstream: Pool): Pool {
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
            throw Object.assign(new Error("测试模拟提交响应未知"), { code: "ECONNRESET" });
          }
          return result;
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
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
    expect(journal.dispatches[0]?.result?.blob.incarnationId).toBeTruthy();
    expect(journal.dispatches[0]?.result?.blob.physicalObjectKey).toBeTruthy();
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
      expect(await repository.appendPtcToolCall(start("inner_revoked"))).toEqual({
        outcome: "not_authorized",
      });
      expect(await repository.appendPtcToolResult(result("inner_first"))).toEqual({
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

  it("父 call 闭合后不允许新开始或结果重放；非 run_code 父拒绝，native 路径仍兼容", async () => {
    expect(
      await repository.append({
        context,
        idempotencyKey: "outer.complete",
        entries: [{ kind: "tool_result", toolCallId: parentToolCallId, body: { finished: true } }],
      }),
    ).toMatchObject({ outcome: "created" });
    expect(await repository.appendPtcToolCall(start("inner_after_close"))).toEqual({
      outcome: "conflict",
    });
    expect(await repository.appendPtcToolResult(result("inner_first"))).toEqual({
      outcome: "conflict",
    });
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
