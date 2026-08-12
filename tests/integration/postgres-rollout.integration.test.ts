import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  agentThreadId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
} from "@cube-runtime/domain";
import { threadActiveHistoryDigest } from "@cube-runtime/pi-adapter";
import type { ExecutionFence } from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgAgentControlRepository } from "../../runtime-ts/packages/persistence/src/pg-agent-control.js";
import { PgRuntimeRolloutRepository } from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
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
const schema = `it_rollout_${unique}`;
const migratorRole = `it_ro_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherRole = `it_ro_pub_${unique}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorRole = `it_ro_coord_${unique}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
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
  schema,
} as const;

const hash = (character: string) => sha256Digest(character.repeat(64));
const reusableSubagentHistoryUnsigned = Object.freeze({
  schemaVersion: 1 as const,
  projectionSchemaVersion: 1 as const,
  throughSequence: 0,
  messages: Object.freeze([]),
});
const reusableSubagentHistory = Object.freeze({
  ...reusableSubagentHistoryUnsigned,
  digest: threadActiveHistoryDigest(reusableSubagentHistoryUnsigned),
});
const attemptId = `rollout_attempt_${unique}`;
const executionScope = {
  tenantId: tenantId(`rollout_tenant_${unique}`),
  threadId: threadId(`rollout_thread_${unique}`),
  runId: runId(`rollout_run_${unique}`),
  rootRunId: runId(`rollout_run_${unique}`),
  workspaceId: `rollout_workspace_${unique}` as never,
};
const fence = {
  scope: executionScope,
  runClaim: {
    token: `rollout_claim_${unique}`,
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
const context = { scope, userId: userId(`rollout_user_${unique}`), fence };
const databaseContext = { tenantId: scope.tenantId, userId: context.userId };
const workspaceId = executionScope.workspaceId;

let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repository!: PgRuntimeRolloutRepository;
let schemaCreated = false;
let migratorCreated = false;

function pausingFenceLockPool(upstream: Pool): {
  readonly pool: Pool;
  readonly locked: Promise<void>;
  readonly release: () => void;
} {
  let signalLocked!: () => void;
  let releaseLock!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const originalConnect = upstream.connect.bind(upstream);
  const pool = new Proxy(upstream, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await originalConnect();
        const originalQuery = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          const result = await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(
            ...args,
          );
          if (
            typeof args[0] === "string" &&
            args[0].includes("FOR SHARE OF attempt,claim,lease,membership")
          ) {
            signalLocked();
            await gate;
          }
          return result;
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return { pool, locked, release: releaseLock };
}

function observingFenceLockPool(upstream: Pool): {
  readonly pool: Pool;
  readonly lockRequested: Promise<void>;
} {
  let signalLockRequested!: () => void;
  const lockRequested = new Promise<void>((resolve) => {
    signalLockRequested = resolve;
  });
  const originalConnect = upstream.connect.bind(upstream);
  const pool = new Proxy(upstream, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await originalConnect();
        const originalQuery = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes("FOR SHARE OF attempt,claim,lease")) {
            signalLockRequested();
          }
          return (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return { pool, lockRequested };
}

function synchronizingRolloutWriteLockPool(upstream: Pool): {
  readonly pool: Pool;
  readonly ready: Promise<void>;
  readonly release: () => void;
  readonly arrivals: () => number;
} {
  let arrivals = 0;
  let signalReady!: () => void;
  let releaseGate!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const originalConnect = upstream.connect.bind(upstream);
  const pool = new Proxy(upstream, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await originalConnect();
        const originalQuery = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          if (
            typeof args[0] === "string" &&
            args[0].includes("pg_advisory_xact_lock(hashtextextended")
          ) {
            arrivals += 1;
            if (arrivals === 2) signalReady();
            // 两个独立连接先同时到达写锁，再交给 PostgreSQL 决定唯一线性化顺序。
            await gate;
          }
          return (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return { pool, ready, release: releaseGate, arrivals: () => arrivals };
}

async function seedStableBlob(purpose: "trace" | "resource", label: string) {
  const operationId = `rollout-blob-operation-${label}-${unique}`;
  const referenceId = `rollout-blob-reference-${label}-${unique}`;
  const lifecycleId = randomUUID();
  const incarnationId = randomUUID();
  const digest = hash(purpose === "trace" ? "a" : "b");
  const size = 128;
  const physicalObjectKey = `integration/rollout/${label}/${incarnationId}`;
  await withTenantTransaction(runtime, databaseContext, async (client) => {
    await client.query(
      `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot)
       VALUES ($1,$2,'completed',0,'{}'::jsonb)`,
      [scope.tenantId, operationId],
    );
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
        lifecycleId,
        incarnationId,
        physicalObjectKey,
      ],
    );
  });
  return { referenceId, sha256: digest, size };
}

function draft(
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "waiting" | "terminal",
  toolCallId?: string,
) {
  const body = { kind, text: `${kind}-${unique}` };
  return {
    kind,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    body,
  } as const;
}

const compatibility = {
  modelId: "provider/model:test",
  modelCompatibilityHash: hash("1"),
  promptPolicyHash: hash("2"),
  toolSchemaHash: hash("3"),
  skillManifestHash: hash("4"),
};

async function recovery(target = repository) {
  const result = await target.loadRecovery({ context, compatibility });
  expect(result.outcome).toBe("loaded");
  if (result.outcome !== "loaded") throw new Error("测试需要已加载的 Rollout");
  return result;
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
    await client.query(
      `INSERT INTO workspace_write_leases(
         tenant_id,workspace_id,thread_id,root_run_id,epoch,expires_at)
       VALUES ($1,$2,$3,$4,1,clock_timestamp()+interval '30 minutes')`,
      [scope.tenantId, workspaceId, scope.threadId, scope.runId],
    );
    await client.query(
      `INSERT INTO execution_workspace_fences(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
         lease_epoch,initial_expires_at)
       VALUES ($1,$2,$3,$4,$5,$3,1,clock_timestamp()+interval '30 minutes')`,
      [scope.tenantId, scope.attemptId, scope.runId, scope.threadId, workspaceId],
    );
    await client.query(
      `INSERT INTO run_claims(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
         worker_id,claim_token,claim_epoch,workspace_lease_epoch,expires_at)
       VALUES ($1,$2,$3,$4,$5,$3,'rollout-worker',$6,1,1,
               clock_timestamp()+interval '30 minutes')`,
      [
        scope.tenantId,
        scope.attemptId,
        scope.runId,
        scope.threadId,
        workspaceId,
        fence.runClaim.token,
      ],
    );
  });
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
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}";
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
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}";
       DROP ROLE "${teamCoordinatorRole}";
       DROP ROLE "${workerCoordinatorRole}";
       DROP ROLE "${skillPublisherRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin !== undefined) await admin.end();
});

describe("Runtime Rollout PostgreSQL 事实源", () => {
  it("并发 append 保持单调无间隙，幂等重放并拒绝摘要冲突", async () => {
    const initial = await repository.append({
      context,
      idempotencyKey: `append-initial-${unique}`,
      entries: [draft("user")],
    });
    expect(initial.outcome).toBe("created");

    const [left, right] = await Promise.all([
      repository.append({
        context,
        idempotencyKey: `append-left-${unique}`,
        entries: [draft("assistant")],
      }),
      repository.append({
        context,
        idempotencyKey: `append-right-${unique}`,
        entries: [draft("assistant")],
      }),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["created", "created"]);
    const replay = await repository.append({
      context,
      idempotencyKey: `append-left-${unique}`,
      entries: [draft("assistant")],
    });
    expect(replay.outcome).toBe("replayed");
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-left-${unique}`,
          entries: [{ kind: "assistant", body: { text: "同键但正文不同" } }],
        })
      ).outcome,
    ).toBe("conflict");
    const restored = await recovery(new PgRuntimeRolloutRepository(runtime));
    expect(restored.tail.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
  });

  it("两个并发工具对由数据库 stream 写锁串行，保持相邻并支持回放与冲突", async () => {
    const synchronized = synchronizingRolloutWriteLockPool(runtime);
    const guarded = new PgRuntimeRolloutRepository(synchronized.pool);
    const leftCallId = `parallel-left-${unique}`;
    const rightCallId = `parallel-right-${unique}`;
    const leftCommand = {
      context,
      idempotencyKey: `parallel-pair-left-${unique}`,
      entries: [draft("tool_call", leftCallId), draft("tool_result", leftCallId)],
    } as const;
    const rightCommand = {
      context,
      idempotencyKey: `parallel-pair-right-${unique}`,
      entries: [draft("tool_call", rightCallId), draft("tool_result", rightCallId)],
    } as const;
    const appends = Promise.all([guarded.append(leftCommand), guarded.append(rightCommand)]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bothReachedLock = await Promise.race([
      synchronized.ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    synchronized.release();

    const [left, right] = await appends;
    expect(bothReachedLock).toBe(true);
    expect(synchronized.arrivals()).toBe(2);
    expect([left.outcome, right.outcome]).toEqual(["created", "created"]);
    if (left.outcome !== "created" || right.outcome !== "created") {
      throw new Error("并发工具对未创建");
    }
    for (const value of [left.value, right.value]) {
      expect(value.map((entry) => entry.kind)).toEqual(["tool_call", "tool_result"]);
      expect(value[1]?.toolCallId).toBe(value[0]?.toolCallId);
      expect(value[1]?.sequence).toBe((value[0]?.sequence ?? -1) + 1);
    }
    const allSequences = [...left.value, ...right.value]
      .map((entry) => entry.sequence)
      .sort((a, b) => a - b);
    expect(allSequences).toEqual([
      allSequences[0],
      (allSequences[0] ?? -1) + 1,
      (allSequences[0] ?? -1) + 2,
      (allSequences[0] ?? -1) + 3,
    ]);

    const replay = await repository.append(leftCommand);
    expect(replay.outcome).toBe("replayed");
    if (replay.outcome === "replayed") {
      expect(replay.value.map((entry) => entry.sequence)).toEqual(
        left.value.map((entry) => entry.sequence),
      );
    }
    expect(
      (
        await repository.append({
          ...leftCommand,
          entries: [
            { ...draft("tool_call", leftCallId), body: { toolName: "changed" } },
            draft("tool_result", leftCallId),
          ],
        })
      ).outcome,
    ).toBe("conflict");
  });

  it("保存未配对尾部，且后续只能追加同 call ID 的 tool_result", async () => {
    const callId = `call-${unique}`;
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-call-${unique}`,
          entries: [draft("tool_call", callId)],
        })
      ).outcome,
    ).toBe("created");
    expect((await recovery()).tail.at(-1)).toMatchObject({
      kind: "tool_call",
      toolCallId: callId,
    });
    expect(
      (
        await repository.writeCheckpoint({
          context,
          idempotencyKey: `checkpoint-unpaired-${unique}`,
          checkpointId: `checkpoint-unpaired-${unique}`,
          windowStartSequence: 0,
          throughSequence: (await recovery()).tail.at(-1)?.sequence ?? 0,
          projection: { state: "不得提交" },
          replacementHistory: [],
        })
      ).outcome,
    ).toBe("conflict");
    await expect(
      repository.append({
        context,
        idempotencyKey: `append-bad-pair-${unique}`,
        entries: [draft("tool_result", `other-${unique}`)],
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-result-${unique}`,
          entries: [draft("tool_result", callId)],
        })
      ).outcome,
    ).toBe("created");
    expect((await recovery()).tail.at(-1)).toMatchObject({
      kind: "tool_result",
      toolCallId: callId,
    });
  });

  it("checkpoint 只替换模型投影，重启读取 checkpoint 后尾部且不删除事实", async () => {
    const before = await recovery();
    const throughSequence = before.tail.at(-1)?.sequence;
    expect(throughSequence).toBeTypeOf("number");
    const written = await repository.writeCheckpoint({
      context,
      idempotencyKey: `checkpoint-${unique}`,
      checkpointId: `checkpoint-${unique}`,
      windowStartSequence: 0,
      throughSequence: throughSequence ?? 0,
      projection: { turns: [{ role: "assistant", text: "摘要" }] },
      replacementHistory: [{ from: 0, through: throughSequence }],
    });
    expect(written.outcome).toBe("created");
    await repository.append({
      context,
      idempotencyKey: `append-after-checkpoint-${unique}`,
      entries: [draft("assistant")],
    });
    const restarted = await recovery(new PgRuntimeRolloutRepository(runtime));
    expect(restarted.checkpoint?.throughSequence).toBe(throughSequence);
    expect(restarted.tail).toHaveLength(1);
    const facts = await withTenantTransaction(runtime, databaseContext, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, scope.attemptId],
      ),
    );
    expect(Number(facts.rows[0]?.count)).toBeGreaterThan(throughSequence ?? 0);
  });

  it("多 checkpoint 只能推进 window/through 并追加 replacement history 前缀", async () => {
    const before = await recovery();
    const throughSequence = before.tail.at(-1)?.sequence ?? 0;
    const priorHistory = before.checkpoint?.replacementHistory ?? [];
    const secondHistory = [...priorHistory, { from: 1, through: throughSequence }];
    expect(
      (
        await repository.writeCheckpoint({
          context,
          idempotencyKey: `checkpoint-second-${unique}`,
          checkpointId: `checkpoint-second-${unique}`,
          windowStartSequence: 1,
          throughSequence,
          projection: { summary: "第二个 checkpoint" },
          replacementHistory: secondHistory,
        })
      ).outcome,
    ).toBe("created");
    await repository.append({
      context,
      idempotencyKey: `append-window-negative-${unique}`,
      entries: [draft("assistant")],
    });
    const latestSequence = (await recovery()).tail.at(-1)?.sequence ?? throughSequence;
    expect(
      (
        await repository.writeCheckpoint({
          context,
          idempotencyKey: `checkpoint-split-result-${unique}`,
          checkpointId: `checkpoint-split-result-${unique}`,
          windowStartSequence: 4,
          throughSequence: latestSequence,
          projection: { summary: "错误窗口" },
          replacementHistory: secondHistory,
        })
      ).outcome,
    ).toBe("conflict");
    expect(
      (
        await repository.writeCheckpoint({
          context,
          idempotencyKey: `checkpoint-rewrite-history-${unique}`,
          checkpointId: `checkpoint-rewrite-history-${unique}`,
          windowStartSequence: 1,
          throughSequence: latestSequence,
          projection: { summary: "错误历史" },
          replacementHistory: [{ rewritten: true }, secondHistory[1] ?? {}],
        })
      ).outcome,
    ).toBe("conflict");
    const restored = await recovery();
    expect(restored.checkpoint?.replacementHistory).toEqual(secondHistory);
  });

  it("完整大输出只接受同租户 stable trace Blob 身份", async () => {
    const resourceBlob = await seedStableBlob("resource", "resource");
    const traceBlob = await seedStableBlob("trace", "trace");
    const callId = `blob-call-${unique}`;
    await repository.append({
      context,
      idempotencyKey: `append-blob-call-${unique}`,
      entries: [draft("tool_call", callId)],
    });
    await expect(
      repository.append({
        context,
        idempotencyKey: `append-resource-blob-result-${unique}`,
        entries: [
          {
            ...draft("tool_result", callId),
            isTruncated: true,
            blob: resourceBlob,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-trace-blob-result-${unique}`,
          entries: [
            {
              ...draft("tool_result", callId),
              isTruncated: true,
              blob: traceBlob,
            },
          ],
        })
      ).outcome,
    ).toBe("created");
    expect((await recovery()).tail.at(-1)).toMatchObject({
      kind: "tool_result",
      isTruncated: true,
      blob: traceBlob,
    });
  });

  it("恢复严格校验兼容身份，且同一 Attempt 不能创建第二个 root stream", async () => {
    const mismatch = await repository.loadRecovery({
      context,
      compatibility: { ...compatibility, modelId: "provider/another-model" },
    });
    expect(mismatch).toEqual({
      outcome: "compatibility_mismatch",
      action: "rebuild_attempt",
      mismatches: ["modelId"],
    });
    const otherRootContext = {
      ...context,
      scope: { ...scope, agentThreadId: agentThreadId(`rollout_other_agent_${unique}`) },
    };
    expect(
      await repository.openRootStream({
        context: otherRootContext,
        workspaceId,
        rootRunId: scope.runId,
        compatibility,
      }),
    ).toBe("conflict");
    await expect(
      withTenantTransaction(runtime, databaseContext, (client) =>
        client.query(
          `INSERT INTO runtime_rollout_streams(
             tenant_id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
             agent_thread_id,model_id,model_compatibility_hash,prompt_policy_hash,
             tool_schema_hash,skill_manifest_hash
           ) SELECT tenant_id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
                    $3,model_id,model_compatibility_hash,prompt_policy_hash,
                    tool_schema_hash,skill_manifest_hash
               FROM runtime_rollout_streams WHERE tenant_id=$1 AND attempt_id=$2`,
          [scope.tenantId, scope.attemptId, otherRootContext.scope.agentThreadId],
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("SubAgent 控制面创建独立 Rollout，并保持命令重放与 JSONB 结果稳定", async () => {
    const controls = new PgAgentControlRepository(runtime);
    const childId = agentThreadId(`rollout_child_${unique}`);
    const childTurnId = `rollout_child_turn_${unique}`;
    const childContext = {
      ...context,
      scope: { ...scope, agentThreadId: childId },
    };
    try {
      expect(
        await controls.initializeRoot({
          fence,
          attemptId: scope.attemptId,
          rootAgentThreadId: scope.agentThreadId,
        }),
      ).toEqual({ outcome: "ready", conversations: [] });
      expect(
        await controls.spawn({
          fence,
          attemptId: scope.attemptId,
          commandId: `spawn_child_${unique}`,
          argsDigest: hash("5"),
          snapshot: {
            agentThreadId: childId,
            parentAgentThreadId: scope.agentThreadId,
            canonicalPath: `/root/child_${unique}`,
            task: "验证独立 Rollout",
            tools: ["read"],
            toolManifestDigest: digestCanonical({ tools: ["read"] }),
            forkTurns: "none",
            turnId: childTurnId,
            turnOrdinal: 1,
          },
          maxThreads: 16,
          maxActiveSubagents: 3,
        }),
      ).toMatchObject({ outcome: "created" });
      const spawnedConversation = await withTenantTransaction(
        runtime,
        databaseContext,
        async (client) =>
          client.query<{ task: string; current_task: string }>(
            `SELECT task,current_task
               FROM runtime_subagent_conversations
              WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3`,
            [scope.tenantId, scope.threadId, childId],
          ),
      );
      expect(spawnedConversation.rows[0]).toEqual({
        task: "验证独立 Rollout",
        current_task: "验证独立 Rollout",
      });
      expect(
        await repository.openAgentStreamFromClaim({
          fence,
          attemptId: scope.attemptId,
          compatibility,
          agentThreadId: childId,
          agentKind: "subagent",
        }),
      ).toMatchObject({ outcome: "ready" });
      expect(
        (
          await repository.append({
            context: childContext,
            idempotencyKey: `append_child_${unique}`,
            entries: [{ kind: "user", body: { text: "child-only" } }],
          })
        ).outcome,
      ).toBe("created");
      const childRecovery = await repository.loadRecovery({
        context: childContext,
        compatibility,
      });
      expect(childRecovery).toMatchObject({
        outcome: "loaded",
        tail: [{ sequence: 0, kind: "user", body: { text: "child-only" } }],
      });

      expect(
        await controls.startTurn({
          fence,
          attemptId: scope.attemptId,
          agentThreadId: childId,
          turnId: childTurnId,
        }),
      ).toBe("started");
      expect(
        await controls.settleTurn({
          fence,
          attemptId: scope.attemptId,
          agentThreadId: childId,
          turnId: childTurnId,
          status: "completed",
          finalAnswer: "完成",
          history: reusableSubagentHistory,
        }),
      ).toBe("settled");
      expect(
        await controls.initializeRoot({
          fence,
          attemptId: scope.attemptId,
          rootAgentThreadId: scope.agentThreadId,
        }),
      ).toEqual({
        outcome: "ready",
        conversations: [
          expect.objectContaining({
            agentThreadId: childId,
            tools: ["read"],
            turnOrdinal: 1,
            history: reusableSubagentHistory,
          }),
        ],
      });
      expect(
        await controls.queueFollowUp({
          fence,
          attemptId: scope.attemptId,
          callerAgentThreadId: scope.agentThreadId,
          commandId: `follow_child_${unique}`,
          argsDigest: hash("6"),
          agentThreadId: childId,
          turnId: `rollout_child_turn_2_${unique}`,
          turnOrdinal: 2,
          task: "继续验证",
          maxActiveSubagents: 3,
        }),
      ).toBe("created");
      const command = {
        fence,
        attemptId: scope.attemptId,
        callerAgentThreadId: scope.agentThreadId,
        commandId: `send_child_${unique}`,
        kind: "send_message" as const,
        argsDigest: hash("7"),
      };
      expect(await controls.recordCommand({ ...command, result: { left: 1, right: 2 } })).toBe(
        "recorded",
      );
      expect(await controls.recordCommand({ ...command, result: { right: 2, left: 1 } })).toBe(
        "replayed",
      );
    } finally {
      await withTenantTransaction(migrator, databaseContext, async (client) => {
        for (const table of [
          "runtime_rollout_checkpoint_commands",
          "runtime_rollout_checkpoints",
          "runtime_rollout_replacements",
          "runtime_rollout_append_commands",
        ]) {
          await client.query(
            `DELETE FROM ${table} WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3`,
            [scope.tenantId, scope.attemptId, childId],
          );
        }
        await client.query(
          "DELETE FROM runtime_rollout_entries WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_rollout_streams WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_agent_commands WHERE tenant_id=$1 AND attempt_id=$2 AND (caller_agent_thread_id=$3 OR result->>'agentThreadId'=$3)",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_agent_turns WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_agent_threads WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_subagent_conversations WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.threadId, childId],
        );
      });
    }
  });

  it("SubAgent spawn、Rollout 打开与恢复遇到并发 Attempt 更新时重试已回滚事务", async () => {
    const childId = agentThreadId(`rollout_retry_child_${unique}`);
    const commandId = `spawn_retry_child_${unique}`;
    let releaseUpdate!: () => void;
    let signalUpdated!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      signalUpdated = resolve;
    });
    const update = withTenantTransaction(runtime, databaseContext, async (client) => {
      await client.query(
        "UPDATE execution_attempts SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, scope.attemptId],
      );
      signalUpdated();
      await updateGate;
    });
    await updated;

    const observed = observingFenceLockPool(runtime);
    const controls = new PgAgentControlRepository(observed.pool);
    const spawn = controls.spawn({
      fence,
      attemptId: scope.attemptId,
      commandId,
      argsDigest: hash("8"),
      snapshot: {
        agentThreadId: childId,
        parentAgentThreadId: scope.agentThreadId,
        canonicalPath: `/root/retry_child_${unique}`,
        task: "验证 SERIALIZABLE 重试",
        tools: [],
        toolManifestDigest: digestCanonical({ tools: [] }),
        forkTurns: "none",
        turnId: `rollout_retry_turn_${unique}`,
        turnOrdinal: 1,
      },
      maxThreads: 16,
      maxActiveSubagents: 3,
    });
    await observed.lockRequested;
    releaseUpdate();
    await update;

    try {
      await expect(spawn).resolves.toMatchObject({ outcome: "created" });
      const facts = await withTenantTransaction(runtime, databaseContext, async (client) => {
        const threads = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM runtime_agent_threads WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        const turns = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM runtime_agent_turns WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        const commands = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM runtime_agent_commands WHERE tenant_id=$1 AND attempt_id=$2 AND command_id=$3",
          [scope.tenantId, scope.attemptId, commandId],
        );
        return {
          threads: threads.rows[0]?.count,
          turns: turns.rows[0]?.count,
          commands: commands.rows[0]?.count,
        };
      });
      expect(facts).toEqual({ threads: "1", turns: "1", commands: "1" });

      let releaseRolloutUpdate!: () => void;
      let signalRolloutUpdated!: () => void;
      const rolloutUpdateGate = new Promise<void>((resolve) => {
        releaseRolloutUpdate = resolve;
      });
      const rolloutUpdated = new Promise<void>((resolve) => {
        signalRolloutUpdated = resolve;
      });
      const rolloutUpdate = withTenantTransaction(runtime, databaseContext, async (client) => {
        await client.query(
          "UPDATE execution_attempts SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
          [scope.tenantId, scope.attemptId],
        );
        signalRolloutUpdated();
        await rolloutUpdateGate;
      });
      await rolloutUpdated;
      const observedRollout = observingFenceLockPool(runtime);
      const rollout = new PgRuntimeRolloutRepository(observedRollout.pool).openAgentStreamFromClaim(
        {
          fence,
          attemptId: scope.attemptId,
          compatibility,
          agentThreadId: childId,
          agentKind: "subagent",
        },
      );
      await observedRollout.lockRequested;
      releaseRolloutUpdate();
      await rolloutUpdate;
      await expect(rollout).resolves.toMatchObject({ outcome: "ready" });

      let releaseRecoveryUpdate!: () => void;
      let signalRecoveryUpdated!: () => void;
      const recoveryUpdateGate = new Promise<void>((resolve) => {
        releaseRecoveryUpdate = resolve;
      });
      const recoveryUpdated = new Promise<void>((resolve) => {
        signalRecoveryUpdated = resolve;
      });
      const recoveryUpdate = withTenantTransaction(runtime, databaseContext, async (client) => {
        await client.query(
          "UPDATE execution_attempts SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
          [scope.tenantId, scope.attemptId],
        );
        signalRecoveryUpdated();
        await recoveryUpdateGate;
      });
      await recoveryUpdated;
      const observedRecovery = observingFenceLockPool(runtime);
      const childContext = {
        ...context,
        scope: { ...scope, agentThreadId: childId },
      };
      const recovered = new PgRuntimeRolloutRepository(observedRecovery.pool).loadRecovery({
        context: childContext,
        compatibility,
      });
      await observedRecovery.lockRequested;
      releaseRecoveryUpdate();
      await recoveryUpdate;
      await expect(recovered).resolves.toMatchObject({ outcome: "loaded", tail: [] });
    } finally {
      await withTenantTransaction(migrator, databaseContext, async (client) => {
        await client.query(
          "DELETE FROM runtime_rollout_streams WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_agent_commands WHERE tenant_id=$1 AND attempt_id=$2 AND (caller_agent_thread_id=$3 OR result->>'agentThreadId'=$3)",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_agent_turns WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_agent_threads WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.attemptId, childId],
        );
        await client.query(
          "DELETE FROM runtime_subagent_conversations WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3",
          [scope.tenantId, scope.threadId, childId],
        );
      });
    }
  });

  it("每次 append 都重验未释放 claim、实时 workspace lease 与接管后的新 token", async () => {
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        "UPDATE run_claims SET released_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
        [scope.tenantId, scope.attemptId],
      ),
    );
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-released-claim-${unique}`,
          entries: [draft("assistant")],
        })
      ).outcome,
    ).toBe("not_authorized");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE run_claims
            SET released_at=NULL,expires_at=clock_timestamp()+interval '30 minutes'
          WHERE tenant_id=$1 AND attempt_id=$2`,
        [scope.tenantId, scope.attemptId],
      ),
    );

    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE workspace_write_leases SET expires_at=clock_timestamp()-interval '1 second'
          WHERE tenant_id=$1 AND workspace_id=$2`,
        [scope.tenantId, workspaceId],
      ),
    );
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-expired-lease-${unique}`,
          entries: [draft("assistant")],
        })
      ).outcome,
    ).toBe("not_authorized");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE workspace_write_leases SET expires_at=clock_timestamp()+interval '30 minutes'
          WHERE tenant_id=$1 AND workspace_id=$2`,
        [scope.tenantId, workspaceId],
      ),
    );

    const takeoverToken = `rollout_takeover_${unique}`;
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE run_claims SET worker_id='takeover-worker',claim_token=$3,claim_epoch=2
          WHERE tenant_id=$1 AND attempt_id=$2`,
        [scope.tenantId, scope.attemptId, takeoverToken],
      ),
    );
    expect(
      (
        await repository.append({
          context,
          idempotencyKey: `append-after-takeover-${unique}`,
          entries: [draft("assistant")],
        })
      ).outcome,
    ).toBe("not_authorized");
    await withTenantTransaction(migrator, databaseContext, (client) =>
      client.query(
        `UPDATE run_claims SET worker_id='rollout-worker',claim_token=$3,claim_epoch=1
          WHERE tenant_id=$1 AND attempt_id=$2`,
        [scope.tenantId, scope.attemptId, fence.runClaim.token],
      ),
    );
  });

  it("loadRecovery 持有双栅栏共享锁，接管只能在一致快照返回后提交", async () => {
    const paused = pausingFenceLockPool(runtime);
    const guarded = new PgRuntimeRolloutRepository(paused.pool);
    const recoveryPromise = guarded.loadRecovery({ context, compatibility });
    await paused.locked;
    const taker = await migrator.connect();
    const takeoverToken = `rollout_race_takeover_${unique}`;
    try {
      await taker.query("BEGIN");
      await taker.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [scope.tenantId, context.userId],
      );
      const pid = Number(
        (await taker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      const takeover = taker.query(
        `UPDATE run_claims SET worker_id='race-takeover',claim_token=$3,claim_epoch=2
          WHERE tenant_id=$1 AND attempt_id=$2`,
        [scope.tenantId, scope.attemptId, takeoverToken],
      );
      let waiting = false;
      for (let index = 0; index < 100 && !waiting; index += 1) {
        const state = await admin.query<{ waiting: boolean }>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          [pid],
        );
        waiting = state.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      paused.release();
      expect((await recoveryPromise).outcome).toBe("loaded");
      await takeover;
      await taker.query("COMMIT");
      expect((await repository.loadRecovery({ context, compatibility })).outcome).toBe("not_found");
    } finally {
      paused.release();
      await taker.query("ROLLBACK").catch(() => undefined);
      taker.release();
      await withTenantTransaction(migrator, databaseContext, (client) =>
        client.query(
          `UPDATE run_claims SET worker_id='rollout-worker',claim_token=$3,claim_epoch=1
            WHERE tenant_id=$1 AND attempt_id=$2`,
          [scope.tenantId, scope.attemptId, fence.runClaim.token],
        ),
      );
    }
  });

  it("RLS 与 Runtime ACL 拒绝跨租户读取及事实 UPDATE/DELETE/TRUNCATE", async () => {
    const foreignContext = {
      tenantId: `rollout_foreign_tenant_${unique}`,
      userId: `rollout_foreign_user_${unique}`,
    };
    const hidden = await withTenantTransaction(runtime, foreignContext, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM runtime_rollout_entries WHERE tenant_id=$1",
        [scope.tenantId],
      ),
    );
    expect(hidden.rows[0]?.count).toBe("0");
    await expect(
      withTenantTransaction(runtime, databaseContext, (client) =>
        client.query("UPDATE runtime_rollout_entries SET body='{}'::jsonb WHERE tenant_id=$1", [
          scope.tenantId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(runtime, databaseContext, (client) =>
        client.query("DELETE FROM runtime_rollout_entries WHERE tenant_id=$1", [scope.tenantId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query("TRUNCATE TABLE runtime_rollout_entries")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("append 持有 Membership SHARE 锁，revoke 必须在提交后生效", async () => {
    const paused = pausingFenceLockPool(runtime);
    const guarded = new PgRuntimeRolloutRepository(paused.pool);
    const appendPromise = guarded.append({
      context,
      idempotencyKey: `append-revoke-race-${unique}`,
      entries: [draft("assistant")],
    });
    await paused.locked;
    const revoker = await migrator.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [scope.tenantId, context.userId],
      );
      const pid = Number(
        (await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      const revokePromise = revoker.query(
        "UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2",
        [scope.tenantId, context.userId],
      );
      let waiting = false;
      for (let index = 0; index < 100 && !waiting; index += 1) {
        const state = await admin.query<{ waiting: boolean }>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          [pid],
        );
        waiting = state.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      paused.release();
      expect((await appendPromise).outcome).toBe("created");
      await revokePromise;
      await revoker.query("COMMIT");
      expect(
        (
          await repository.append({
            context,
            idempotencyKey: `append-after-race-revoke-${unique}`,
            entries: [draft("assistant")],
          })
        ).outcome,
      ).toBe("not_authorized");
    } finally {
      paused.release();
      await revoker.query("ROLLBACK").catch(() => undefined);
      revoker.release();
      await withTenantTransaction(migrator, databaseContext, (client) =>
        client.query("UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2", [
          scope.tenantId,
          context.userId,
        ]),
      );
    }
  });

  it("直接 SQL 也拒绝序号跳跃、伪造前驱、终态后续写和 tool_call checkpoint", async () => {
    const restored = await recovery();
    const tail = restored.tail.at(-1);
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
      entries: [draft("terminal")],
    });
    expect(terminal.outcome).toBe("created");
    await expect(
      repository.append({
        context,
        idempotencyKey: `append-after-terminal-${unique}`,
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
          entries: [draft("assistant")],
        })
      ).outcome,
    ).toBe("not_authorized");
  });
});
