import { randomBytes, randomUUID } from "node:crypto";
import {
  createPersonalTenant,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  isoTimestamp,
  membershipId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import type {
  ControlledRolloutProjection,
  ExecutionScope,
  RuntimeMutation,
  RuntimeOutboxV1,
  SandboxSessionRegistryPort,
} from "@cube-runtime/run-contracts";
import { assertProtocolSize } from "@cube-runtime/run-contracts";
import {
  outboxPayloadDigest,
  runtimeMutationDigest,
} from "@cube-runtime/run-contracts/mutation-protocol";
import { FakeSandboxGateway } from "@cube-runtime/sandbox/testing";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiWorkerSessionFactory } from "../../runtime-ts/apps/agent-worker/src/pi-session-factory.js";
import { RunWorker } from "../../runtime-ts/apps/agent-worker/src/run-worker.js";
import {
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeClock,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
} from "../../runtime-ts/apps/agent-worker/src/testing/fakes.js";
import { createApiApp } from "../../runtime-ts/apps/api/src/app.js";
import { createApiCreateCapability } from "../../runtime-ts/apps/api/src/capabilities.js";
import { createThreadCursorCodec } from "../../runtime-ts/apps/api/src/cursor.js";
import { createDevelopmentAuthResolver } from "../../runtime-ts/apps/api/src/development-auth.js";
import { RunDispatchScheduler } from "../../runtime-ts/apps/scheduler/src/run-dispatch.js";
import {
  CubeSandboxCleanupResolver,
  SandboxCleanupConsumer,
} from "../../runtime-ts/apps/scheduler/src/sandbox-cleanup-consumer.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  PgArchiveThreadCommand,
  PgCoreRepositories,
} from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import {
  PgRunDispatchCreation,
  PgRunDispatchOutbox,
} from "../../runtime-ts/packages/persistence/src/pg-run-dispatch.js";
import {
  PgBackedSandboxSessionRegistry,
  PgExecutionPersistence,
  PgRunExecutionSetup,
} from "../../runtime-ts/packages/persistence/src/pg-run-worker-state.js";
import { PgSandboxCleanupConsumerStore } from "../../runtime-ts/packages/persistence/src/pg-sandbox-cleanup-consumer.js";
import { PgThreadCreation } from "../../runtime-ts/packages/persistence/src/pg-thread-creation.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

const enabled = process.env.RUN_PG_RUN_WORKER_INTEGRATION === "true";
const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL ?? "";
const preprovisionedDatabase = process.env.M4_PREPROVISIONED_DATABASE === "true";
const adminUrl = preprovisionedDatabase ? (process.env.M4_DATABASE_ADMIN_URL ?? "") : bootstrapUrl;
const configuredRuntimeUrl = process.env.DATABASE_URL ?? "";
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const schema = preprovisionedDatabase ? (process.env.DATABASE_SCHEMA ?? "") : `it_rw_${suffix}`;
const runtimeRole = preprovisionedDatabase
  ? (process.env.DATABASE_RUNTIME_ROLE ?? "")
  : `it_rw_rt_${suffix}`;
const migratorRole = preprovisionedDatabase
  ? (process.env.DATABASE_MIGRATOR_ROLE ?? "")
  : `it_rw_mg_${suffix}`;
const runtimePassword = randomBytes(24).toString("hex");
const migratorPassword = randomBytes(24).toString("hex");
const safePgIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;
let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let runtimeConnectionString = "";
let repositories!: PgCoreRepositories;
let setup!: PgRunExecutionSetup;
let persistence!: PgExecutionPersistence;
let runDispatchCreation!: PgRunDispatchCreation;
let runDispatchOutbox!: PgRunDispatchOutbox;
let databaseName = "";

interface Fixture {
  readonly scope: ExecutionScope;
  readonly user: ReturnType<typeof createUser>;
  readonly thread: ReturnType<typeof createThread>;
  readonly workspace: ReturnType<typeof createWorkspace>;
}

async function fixture(
  label: string,
  rolloutProjection: ControlledRolloutProjection = {
    schemaVersion: 1,
    checkpointId: `cp-${label}`,
    turns: [],
  },
): Promise<Fixture> {
  const now = isoTimestamp("2099-07-26T00:00:00.000Z");
  const user = createUser(userId(`rw-user-${label}`), now);
  const personal = createPersonalTenant({
    id: tenantId(`rw-tenant-${label}`),
    ownerMembershipId: membershipId(`rw-member-${label}`),
    owner: user,
    createdAt: now,
  });
  const tenantScope = { tenantId: personal.tenant.id, userId: user.id };
  expect(
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    }),
  ).toEqual({ outcome: "created" });
  const thread = createThread({
    id: threadId(`rw-thread-${label}`),
    tenant: personal.tenant,
    user,
    membership: personal.ownerMembership,
    title: "PG Run Worker 集成测试",
    now,
  });
  await repositories.threads.create(tenantScope, thread);
  const run = createRun({ id: runId(`rw-run-${label}`), thread, now });
  await repositories.runs.create(tenantScope, run);
  const workspace = createWorkspace({ id: workspaceId(`rw-workspace-${label}`), thread, now });
  await repositories.workspaces.create(tenantScope, workspace);
  const scope: ExecutionScope = {
    tenantId: personal.tenant.id,
    threadId: thread.id,
    runId: run.id,
    rootRunId: run.id,
    workspaceId: workspace.id,
  };
  expect(
    await setup.initialize({
      scope,
      input: "执行 PostgreSQL Run Worker 集成任务",
      rolloutProjection,
    }),
  ).toBe("created");
  return { scope, user, thread, workspace };
}

/** 用真实 PostgreSQL 的 jsonb::text 计算边界，避免测试复制一套不等价序列化规则。 */
async function projectionAtStoredBytes(targetBytes: number) {
  // 用多个合法 turn 填充字节：checkpoint 受 200 字节限制，单个 turn 受 16KiB 限制。
  const empty = {
    schemaVersion: 1 as const,
    checkpointId: "projection-boundary",
    turns: Array.from({ length: 5 }, () => ({ role: "user" as const, text: "" })),
  };
  const measured = await migrator.query<{ bytes: number }>(
    "SELECT octet_length($1::jsonb::text) AS bytes",
    [JSON.stringify(empty)],
  );
  const baseBytes = Number(measured.rows[0]?.bytes);
  let remaining = targetBytes - baseBytes;
  const turns = empty.turns.map((turn, index) => {
    const slots = empty.turns.length - index;
    const bytes = Math.min(16 * 1024, Math.floor(remaining / slots));
    remaining -= bytes;
    return { ...turn, text: "x".repeat(bytes) };
  });
  if (remaining !== 0) throw new Error("无法构造受控 Projection 边界");
  const projection = { ...empty, turns };
  const verified = await migrator.query<{ bytes: number }>(
    "SELECT octet_length($1::jsonb::text) AS bytes",
    [JSON.stringify(projection)],
  );
  expect(Number(verified.rows[0]?.bytes)).toBe(targetBytes);
  return projection;
}

function signed(input: Omit<RuntimeMutation, "schemaVersion" | "commandDigest">): RuntimeMutation {
  const unsigned = { ...input, schemaVersion: 1 as const };
  return { ...unsigned, commandDigest: runtimeMutationDigest(unsigned) };
}

/** 在真实 COMMIT 已成功后丢弃客户端响应，覆盖事务框架而非业务 afterCommit hook。 */
function withLostCommitResponse(
  upstream: Pool,
  options: { readonly failReadback?: boolean } = {},
): Pool {
  let responseDiscarded = false;
  let readbackFailed = false;
  return {
    connect: async () => {
      const client = await upstream.connect();
      const originalQuery = client.query.bind(client) as (
        ...args: readonly unknown[]
      ) => Promise<unknown>;
      client.query = (async (...args: readonly unknown[]) => {
        const result = await originalQuery(...args);
        const first = args[0];
        const sql =
          typeof first === "string"
            ? first
            : typeof first === "object" && first !== null && "text" in first
              ? String(first.text)
              : "";
        if (
          responseDiscarded &&
          options.failReadback === true &&
          !readbackFailed &&
          sql.includes("FROM api_thread_idempotency_records")
        ) {
          readbackFailed = true;
          throw Object.assign(new Error("不得泄漏的恢复查询连接错误"), { code: "ECONNRESET" });
        }
        if (!responseDiscarded && sql.trim().toUpperCase() === "COMMIT") {
          responseDiscarded = true;
          throw Object.assign(new Error("模拟 COMMIT 响应丢失"), { code: "ECONNRESET" });
        }
        return result;
      }) as typeof client.query;
      return client;
    },
  } as unknown as Pool;
}

describe.runIf(enabled)("PostgreSQL Run Worker 状态与并发契约", () => {
  beforeAll(async () => {
    if (!bootstrapUrl) throw new Error("缺少 DATABASE_BOOTSTRAP_URL");
    if (!adminUrl) throw new Error("缺少 M4 数据库管理连接");
    admin = createPostgresPool({ connectionString: adminUrl, maxConnections: 2 });
    databaseName = new URL(adminUrl).pathname.slice(1);
    if (!preprovisionedDatabase) {
      await admin.query(
        `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       GRANT CONNECT ON DATABASE "${databaseName}" TO "${runtimeRole}", "${migratorRole}";
       CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
      );
    }
    const migratorUrl = new URL(bootstrapUrl);
    const runtimeUrl = new URL(preprovisionedDatabase ? configuredRuntimeUrl : bootstrapUrl);
    if (preprovisionedDatabase) {
      if (
        !schema.startsWith("m4_ci_") ||
        !runtimeRole.startsWith("m4_ci_") ||
        !migratorRole.startsWith("m4_ci_") ||
        !safePgIdentifier.test(schema) ||
        !safePgIdentifier.test(runtimeRole) ||
        !safePgIdentifier.test(migratorRole) ||
        migratorUrl.username !== migratorRole ||
        runtimeUrl.username !== runtimeRole ||
        schema.length === 0
      ) {
        throw new Error("M4 预置数据库角色、连接或 Schema 配置不一致");
      }
    } else {
      migratorUrl.username = migratorRole;
      migratorUrl.password = migratorPassword;
      runtimeUrl.username = runtimeRole;
      runtimeUrl.password = runtimePassword;
    }
    runtimeConnectionString = runtimeUrl.toString();
    migrator = createPostgresPool({ connectionString: migratorUrl.toString(), schema });
    runtime = createPostgresPool({ connectionString: runtimeConnectionString, schema });
    await migrateUp(migrator, { runtimeRole, migratorRole, schema });
    const dispatchAcl = await admin.query<{ readonly allowed: boolean; readonly version: number }>(
      `SELECT has_table_privilege($1::text, format('%I.api_idempotency_records', $2::text), 'SELECT') AS allowed,
              (SELECT max(version) FROM "${schema}".runtime_schema_migrations)::int AS version`,
      [runtimeRole, schema],
    );
    // Thread 创建 0007 在 Cleanup 0006 后叠加，既有 Dispatch ACL 仍须存在。
    expect(dispatchAcl.rows[0]).toEqual({ allowed: true, version: 7 });
    const runtimeSchema = await runtime.query<{
      readonly schema: string;
      readonly current_user: string;
    }>("SELECT current_schema() AS schema,current_user");
    expect(runtimeSchema.rows[0]).toEqual({ schema, current_user: runtimeRole });
    repositories = new PgCoreRepositories(runtime);
    setup = new PgRunExecutionSetup(runtime);
    persistence = new PgExecutionPersistence(runtime);
    runDispatchCreation = new PgRunDispatchCreation(runtime);
    runDispatchOutbox = new PgRunDispatchOutbox(runtime);
  });

  afterAll(async () => {
    await runtime?.end();
    await migrator?.end();
    if (!(schema.startsWith("it_rw_") || schema.startsWith("m4_ci_"))) {
      throw new Error("拒绝清理非测试 Schema");
    }
    await admin
      ?.query(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE;
       REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${runtimeRole}", "${migratorRole}"`,
      )
      .catch(() => undefined);
    await admin?.query(
      `DROP ROLE IF EXISTS "${runtimeRole}"; DROP ROLE IF EXISTS "${migratorRole}"`,
    );
    await admin?.end();
  });

  it("双 Worker 并发 claim 只有一个取得双栅栏", async () => {
    const f = await fixture(`claim-${suffix}`);
    const outcomes = await Promise.all([
      persistence.claim({ scope: f.scope, workerId: "worker-a", leaseDurationMs: 30_000 }),
      persistence.claim({ scope: f.scope, workerId: "worker-b", leaseDurationMs: 30_000 }),
    ]);
    expect(outcomes.filter((result) => result.outcome === "claimed")).toHaveLength(1);
    expect(
      outcomes.some((result) => result.outcome === "busy" || result.outcome === "unavailable"),
    ).toBe(true);
    const winner = outcomes.find((result) => result.outcome === "claimed");
    if (winner?.outcome !== "claimed") throw new Error("没有 claim 胜者");
    const renewed = await persistence.inspectAndRenew({
      fence: winner.fence,
      leaseDurationMs: 30_000,
    });
    expect(renewed).toMatchObject({
      outcome: "active",
      fence: {
        runClaim: { token: winner.fence.runClaim.token, epoch: winner.fence.runClaim.epoch },
        workspaceLease: {
          rootRunId: winner.fence.workspaceLease.rootRunId,
          epoch: winner.fence.workspaceLease.epoch,
        },
      },
    });
    if (renewed.outcome !== "active") throw new Error("续租失败");
    expect(Date.parse(renewed.fence.runClaim.expiresAt)).toBeGreaterThan(
      Date.parse(winner.fence.runClaim.expiresAt),
    );
    await expect(
      persistence.inspectAndRenew({
        fence: {
          ...renewed.fence,
          workspaceLease: {
            ...renewed.fence.workspaceLease,
            epoch: renewed.fence.workspaceLease.epoch + 1,
          },
        },
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual({ outcome: "fence_lost" });
  });

  it("同键 Run 创建原子重放，并由 Outbox 至少一次领取", async () => {
    const label = `dispatch-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`dispatch-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`dispatch-tenant-${label}`),
      ownerMembershipId: membershipId(`dispatch-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`dispatch-thread-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "Dispatch PG 集成任务",
      now,
    });
    await repositories.threads.create(scope, thread);
    await repositories.workspaces.create(
      scope,
      createWorkspace({ id: workspaceId(`dispatch-workspace-${label}`), thread, now }),
    );
    const run = createRun({ id: runId(`dispatch-run-${label}`), thread, now });
    const command = {
      scope,
      run,
      thread,
      inputText: "可靠 Dispatch 输入",
      idempotency: {
        key: `dispatch-key-${label}`,
        requestHash: "a".repeat(64),
      },
    } as const;
    const created = await Promise.all([
      runDispatchCreation.createQueuedRun(command),
      runDispatchCreation.createQueuedRun(command),
    ]);
    expect(created.map((value) => value.outcome).sort()).toEqual(["created", "replayed"]);
    await expect(
      runDispatchCreation.createQueuedRun({
        ...command,
        inputText: "不同输入",
        idempotency: { ...command.idempotency, requestHash: "b".repeat(64) },
      }),
    ).resolves.toEqual({ outcome: "key_conflict" });

    const claims = await Promise.all([
      runDispatchOutbox.claim({
        tenantId: scope.tenantId,
        dispatcherId: "dispatch-a",
        limit: 1,
        leaseMilliseconds: 30_000,
      }),
      runDispatchOutbox.claim({
        tenantId: scope.tenantId,
        dispatcherId: "dispatch-b",
        limit: 1,
        leaseMilliseconds: 30_000,
      }),
    ]);
    expect(claims.flat()).toHaveLength(1);
    const claim = claims.flat()[0];
    if (claim === undefined) throw new Error("没有 Outbox claim 胜者");
    const execution = await persistence.claim({
      scope: claim.scope as ExecutionScope,
      workerId: "dispatch-worker",
      leaseDurationMs: 30_000,
    });
    expect(execution).toMatchObject({
      outcome: "claimed",
      snapshot: {
        input: command.inputText,
        rolloutProjection: { schemaVersion: 1, checkpointId: "initial", turns: [] },
      },
    });
    await runDispatchOutbox.acknowledge({ claim, outcome: "dispatched" });
    await expect(
      runDispatchOutbox.claim({
        tenantId: scope.tenantId,
        dispatcherId: "dispatch-c",
        limit: 1,
        leaseMilliseconds: 30_000,
      }),
    ).resolves.toEqual([]);
  });

  it("过期 ack 不能覆盖重领，两个连接只会产生一个下一代 claim", async () => {
    const f = await fixture(`dispatch-reclaim-${suffix}`);
    await expect(
      runDispatchOutbox.claim({
        tenantId: f.scope.tenantId,
        dispatcherId: " \t ",
        limit: 1,
        leaseMilliseconds: 30_000,
      }),
    ).rejects.toThrow("dispatcherId");
    await expect(
      runDispatchOutbox.claim({
        tenantId: f.scope.tenantId,
        dispatcherId: "too-long-dispatcher",
        limit: 1,
        leaseMilliseconds: 300_001,
      }),
    ).rejects.toThrow("Outbox lease");
    const outboxId = `outbox-reclaim-${suffix}`;
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `INSERT INTO run_dispatch_outbox(
           tenant_id,outbox_id,run_id,thread_id,workspace_id,root_run_id,input_digest,state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ready')`,
        [
          f.scope.tenantId,
          outboxId,
          f.scope.runId,
          f.scope.threadId,
          f.scope.workspaceId,
          f.scope.rootRunId,
          "e".repeat(64),
        ],
      ),
    );
    const first = (
      await runDispatchOutbox.claim({
        tenantId: f.scope.tenantId,
        dispatcherId: "first-dispatcher",
        limit: 1,
        leaseMilliseconds: 1_000,
      })
    )[0];
    if (first === undefined) throw new Error("首次 claim 缺失");
    await admin.query(
      `UPDATE "${schema}".run_dispatch_outbox
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND outbox_id=$2`,
      [f.scope.tenantId, outboxId],
    );
    const [lateAck, reclaimLeft, reclaimRight] = await Promise.all([
      runDispatchOutbox.acknowledge({ claim: first, outcome: "dispatched" }),
      runDispatchOutbox.claim({
        tenantId: f.scope.tenantId,
        dispatcherId: "second-dispatcher-left",
        limit: 1,
        leaseMilliseconds: 30_000,
      }),
      runDispatchOutbox.claim({
        tenantId: f.scope.tenantId,
        dispatcherId: "second-dispatcher-right",
        limit: 1,
        leaseMilliseconds: 30_000,
      }),
    ]);
    await lateAck;
    const next = [...reclaimLeft, ...reclaimRight];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ outboxId, generation: first.generation + 1 });
    const winner = next[0];
    if (winner === undefined) throw new Error("重领 winner 缺失");
    await expect(
      runDispatchOutbox.acknowledge({
        claim: winner,
        outcome: "defer",
        retryAfterMilliseconds: 86_400_001,
      }),
    ).rejects.toThrow("Outbox defer");
    await runDispatchOutbox.acknowledge({ claim: winner, outcome: "dispatched" });
  });

  it("COMMIT 响应丢失后，即使 Thread 已归档仍先按同键读回", async () => {
    const label = `dispatch-unknown-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`dispatch-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`dispatch-tenant-${label}`),
      ownerMembershipId: membershipId(`dispatch-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`dispatch-thread-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "响应丢失后归档",
      now,
    });
    await repositories.threads.create(scope, thread);
    await repositories.workspaces.create(
      scope,
      createWorkspace({ id: workspaceId(`dispatch-workspace-${label}`), thread, now }),
    );
    const command = {
      scope,
      run: createRun({ id: runId(`dispatch-run-${label}`), thread, now }),
      thread,
      inputText: "提交成功但响应丢失",
      idempotency: { key: `dispatch-key-${label}`, requestHash: "c".repeat(64) },
    } as const;
    const lossy = new PgRunDispatchCreation(runtime, {
      afterCommit: () => {
        throw new Error("模拟响应丢失");
      },
    });
    await expect(lossy.createQueuedRun(command)).resolves.toMatchObject({ outcome: "replayed" });
    await expect(
      new PgArchiveThreadCommand(runtime).archiveThread({ scope, threadId: thread.id }),
    ).resolves.toMatchObject({ outcome: "archived" });
    await expect(runDispatchCreation.createQueuedRun(command)).resolves.toMatchObject({
      outcome: "replayed",
      entity: { id: command.run.id },
    });
    await expect(
      runDispatchCreation.createQueuedRun({
        ...command,
        inputText: "同键不同载荷",
        idempotency: { ...command.idempotency, requestHash: "d".repeat(64) },
      }),
    ).resolves.toEqual({ outcome: "key_conflict" });
  });

  it("Thread 创建在 COMMIT 响应丢失后精确重放，且不会留下第二个 Workspace", async () => {
    const label = `thread-unknown-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`thread-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`thread-tenant-${label}`),
      ownerMembershipId: membershipId(`thread-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`thread-id-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "Thread 提交响应丢失",
      now,
    });
    const workspace = createWorkspace({
      id: workspaceId(`thread-workspace-${label}`),
      thread,
      now,
    });
    const command = {
      scope,
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      thread,
      workspace,
      idempotency: { key: `thread-key-${label}`, requestHash: "a".repeat(64) },
    } as const;
    const lossy = new PgThreadCreation(runtime, {
      afterCommit: () => {
        throw new Error("模拟 Thread 提交响应丢失");
      },
    });
    await expect(lossy.createThread(command)).resolves.toMatchObject({
      outcome: "replayed",
      entity: { id: thread.id },
    });
    await expect(new PgThreadCreation(runtime).createThread(command)).resolves.toMatchObject({
      outcome: "replayed",
      entity: { id: thread.id },
    });
    const conflictingThread = createThread({
      id: threadId(`thread-conflict-id-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "同键不同标题",
      now,
    });
    await expect(
      new PgThreadCreation(runtime).createThread({
        ...command,
        thread: conflictingThread,
        workspace: createWorkspace({
          id: workspaceId(`thread-conflict-workspace-${label}`),
          thread: conflictingThread,
          now,
        }),
        idempotency: { ...command.idempotency, requestHash: "b".repeat(64) },
      }),
    ).resolves.toEqual({ outcome: "key_conflict" });
    const facts = await withTenantTransaction(runtime, scope, async (client) => {
      const [threads, workspaces] = await Promise.all([
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM threads WHERE tenant_id=$1",
          [scope.tenantId],
        ),
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspaces WHERE tenant_id=$1",
          [scope.tenantId],
        ),
      ]);
      return { threads: threads.rows[0]?.count, workspaces: workspaces.rows[0]?.count };
    });
    expect(facts).toEqual({ threads: "1", workspaces: "1" });
  });

  it("Thread 创建直接命中 TransactionCommitUnknownError 后按原键精确读回", async () => {
    const label = `thread-transaction-unknown-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`thread-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`thread-tenant-${label}`),
      ownerMembershipId: membershipId(`thread-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`thread-id-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "事务 COMMIT 结果未知",
      now,
    });
    const workspace = createWorkspace({
      id: workspaceId(`thread-workspace-${label}`),
      thread,
      now,
    });
    const command = {
      scope,
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      thread,
      workspace,
      idempotency: { key: `thread-key-${label}`, requestHash: "e".repeat(64) },
    } as const;

    await expect(
      new PgThreadCreation(withLostCommitResponse(runtime)).createThread(command),
    ).resolves.toMatchObject({ outcome: "replayed", entity: { id: thread.id } });

    const facts = await withTenantTransaction(runtime, scope, async (client) => {
      const [threads, workspaces, idempotency] = await Promise.all([
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM threads WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, thread.id],
        ),
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspaces WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, workspace.id],
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM api_thread_idempotency_records
            WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3`,
          [scope.tenantId, scope.userId, command.idempotency.key],
        ),
      ]);
      return {
        threads: threads.rows[0]?.count,
        workspaces: workspaces.rows[0]?.count,
        idempotency: idempotency.rows[0]?.count,
      };
    });
    expect(facts).toEqual({ threads: "1", workspaces: "1", idempotency: "1" });
  });

  it("Thread 提交结果未知且恢复查询失败时返回稳定脱敏错误，事实仍可重放", async () => {
    const label = `thread-readback-failure-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`thread-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`thread-tenant-${label}`),
      ownerMembershipId: membershipId(`thread-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`thread-id-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "恢复查询也失败",
      now,
    });
    const command = {
      scope,
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      thread,
      workspace: createWorkspace({ id: workspaceId(`thread-workspace-${label}`), thread, now }),
      idempotency: { key: `thread-key-${label}`, requestHash: "d".repeat(64) },
    } as const;

    const unknownResult = new PgThreadCreation(
      withLostCommitResponse(runtime, { failReadback: true }),
    ).createThread(command);
    await expect(unknownResult).rejects.toMatchObject({
      name: "PersistenceError",
      code: "UNAVAILABLE",
      message: "读取 Thread 创建恢复结果暂时不可用",
    });
    await expect(unknownResult).rejects.not.toThrow("不得泄漏的恢复查询连接错误");
    await expect(new PgThreadCreation(runtime).createThread(command)).resolves.toMatchObject({
      outcome: "replayed",
      entity: { id: thread.id },
    });
  });

  it("Thread 创建中途 Workspace 写入失败时完整回滚 Thread 与幂等事实", async () => {
    const label = `thread-rollback-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`thread-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`thread-tenant-${label}`),
      ownerMembershipId: membershipId(`thread-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const existingThread = createThread({
      id: threadId(`thread-existing-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "已有 Thread",
      now,
    });
    const existingWorkspace = createWorkspace({
      id: workspaceId(`thread-shared-workspace-${label}`),
      thread: existingThread,
      now,
    });
    await repositories.threads.create(scope, existingThread);
    await repositories.workspaces.create(scope, existingWorkspace);

    const targetThread = createThread({
      id: threadId(`thread-target-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "必须整体回滚的 Thread",
      now,
    });
    const idempotencyKey = `thread-key-${label}`;
    await expect(
      new PgThreadCreation(runtime).createThread({
        scope,
        tenant: personal.tenant,
        user,
        membership: personal.ownerMembership,
        thread: targetThread,
        // 复用已存在的 Workspace ID，确保 Thread INSERT 后的第二次写入在真实 PG 中失败。
        workspace: createWorkspace({ id: existingWorkspace.id, thread: targetThread, now }),
        idempotency: { key: idempotencyKey, requestHash: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const facts = await withTenantTransaction(runtime, scope, async (client) => {
      const [threads, targetWorkspaces, idempotency, existingWorkspaces] = await Promise.all([
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM threads WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, targetThread.id],
        ),
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspaces WHERE tenant_id=$1 AND thread_id=$2",
          [scope.tenantId, targetThread.id],
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM api_thread_idempotency_records
            WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3`,
          [scope.tenantId, scope.userId, idempotencyKey],
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM workspaces
            WHERE tenant_id=$1 AND id=$2 AND thread_id=$3`,
          [scope.tenantId, existingWorkspace.id, existingThread.id],
        ),
      ]);
      return {
        threads: threads.rows[0]?.count,
        targetWorkspaces: targetWorkspaces.rows[0]?.count,
        idempotency: idempotency.rows[0]?.count,
        existingWorkspaces: existingWorkspaces.rows[0]?.count,
      };
    });
    expect(facts).toEqual({
      threads: "0",
      targetWorkspaces: "0",
      idempotency: "0",
      existingWorkspaces: "1",
    });
  });

  it("两个独立 PostgreSQL 连接首次并发创建 Thread 只会产生 created 与 replayed", async () => {
    const label = `thread-race-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`thread-race-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`thread-race-tenant-${label}`),
      ownerMembershipId: membershipId(`thread-race-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`thread-race-id-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "并发 Thread 创建",
      now,
    });
    const command = {
      scope,
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      thread,
      workspace: createWorkspace({
        id: workspaceId(`thread-race-workspace-${label}`),
        thread,
        now,
      }),
      idempotency: { key: `thread-race-key-${label}`, requestHash: "c".repeat(64) },
    } as const;
    // 两个独立 Pool 强制走不同物理连接；advisory lock 不能依赖单例或对象内存。
    const firstConnection = createPostgresPool({
      connectionString: runtimeConnectionString,
      schema,
      maxConnections: 1,
    });
    const secondConnection = createPostgresPool({
      connectionString: runtimeConnectionString,
      schema,
      maxConnections: 1,
    });
    let outcomes: readonly [
      Awaited<ReturnType<PgThreadCreation["createThread"]>>,
      Awaited<ReturnType<PgThreadCreation["createThread"]>>,
    ];
    try {
      outcomes = await Promise.all([
        new PgThreadCreation(firstConnection).createThread(command),
        new PgThreadCreation(secondConnection).createThread(command),
      ]);
    } finally {
      await Promise.all([firstConnection.end(), secondConnection.end()]);
    }
    const [left, right] = outcomes;
    expect([left.outcome, right.outcome].sort()).toEqual(["created", "replayed"]);
    const facts = await withTenantTransaction(runtime, scope, async (client) => {
      const [threads, workspaces] = await Promise.all([
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM threads WHERE tenant_id=$1",
          [scope.tenantId],
        ),
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspaces WHERE tenant_id=$1",
          [scope.tenantId],
        ),
      ]);
      return { threads: threads.rows[0]?.count, workspaces: workspaces.rows[0]?.count };
    });
    expect(facts).toEqual({ threads: "1", workspaces: "1" });
  });

  it("Thread 幂等键按 Tenant 隔离，相同键不会跨租户读回", async () => {
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const key = `thread-isolation-key-${suffix}`;
    const createFor = async (suffixPart: string) => {
      const user = createUser(userId(`thread-isolation-user-${suffixPart}-${suffix}`), now);
      const personal = createPersonalTenant({
        id: tenantId(`thread-isolation-tenant-${suffixPart}-${suffix}`),
        ownerMembershipId: membershipId(`thread-isolation-member-${suffixPart}-${suffix}`),
        owner: user,
        createdAt: now,
      });
      const scope = { tenantId: personal.tenant.id, userId: user.id };
      await repositories.tenants.createPersonal({
        user,
        tenant: personal.tenant,
        membership: personal.ownerMembership,
      });
      const thread = createThread({
        id: threadId(`thread-isolation-id-${suffixPart}-${suffix}`),
        tenant: personal.tenant,
        user,
        membership: personal.ownerMembership,
        title: "同键隔离",
        now,
      });
      return new PgThreadCreation(runtime).createThread({
        scope,
        tenant: personal.tenant,
        user,
        membership: personal.ownerMembership,
        thread,
        workspace: createWorkspace({
          id: workspaceId(`thread-isolation-workspace-${suffixPart}-${suffix}`),
          thread,
          now,
        }),
        idempotency: { key, requestHash: "d".repeat(64) },
      });
    };
    const [left, right] = await Promise.all([createFor("a"), createFor("b")]);
    expect(left.outcome).toBe("created");
    expect(right.outcome).toBe("created");
  });

  it("真实 PG HTTP API：归档 Thread 后同键 Run 重放优先，不同载荷冲突", async () => {
    const label = `dispatch-http-${suffix}`;
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const user = createUser(userId(`dispatch-user-${label}`), now);
    const personal = createPersonalTenant({
      id: tenantId(`dispatch-tenant-${label}`),
      ownerMembershipId: membershipId(`dispatch-member-${label}`),
      owner: user,
      createdAt: now,
    });
    const scope = { tenantId: personal.tenant.id, userId: user.id };
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    });
    const thread = createThread({
      id: threadId(`dispatch-thread-${label}`),
      tenant: personal.tenant,
      user,
      membership: personal.ownerMembership,
      title: "HTTP 幂等回放",
      now,
    });
    await repositories.threads.create(scope, thread);
    await repositories.workspaces.create(
      scope,
      createWorkspace({ id: workspaceId(`dispatch-workspace-${label}`), thread, now }),
    );
    const app = createApiApp(
      {
        auth: { resolve: async () => ({ tenantId: scope.tenantId, userId: scope.userId }) },
        repositories,
        createCapability: createApiCreateCapability({
          // 此用例只覆盖已存在 Thread 的 Run 路由；Thread 创建仍由单独的原子端口负责。
          threadCreation: { createThread: async () => ({ outcome: "not_authorized" }) },
          enqueueOutbox: runDispatchCreation,
        }),
        archiveThread: new PgArchiveThreadCommand(runtime),
        cursorCodec: createThreadCursorCodec({
          activeKid: "integration-key",
          keys: [{ kid: "integration-key", secret: randomBytes(32).toString("base64url") }],
          clock: { now: () => now },
          ttlMilliseconds: 60_000,
          maximumTtlMilliseconds: 60_000,
        }),
        readiness: { probe: async () => runtime.query("SELECT 1").then(() => undefined) },
        clock: { now: () => now },
        ids: {
          thread: () => threadId(`unused-thread-${label}`),
          run: () => runId(`dispatch-run-${label}`),
          workspace: () => workspaceId(`unused-workspace-${label}`),
        },
      },
      { logger: false },
    );
    try {
      const request = {
        method: "POST" as const,
        url: `/v1/threads/${thread.id}/runs`,
        headers: { authorization: "Bearer integration", "idempotency-key": `http-key-${label}` },
        payload: { input: "HTTP 原始输入" },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      const archived = await app.inject({
        method: "DELETE",
        url: `/v1/threads/${thread.id}`,
        headers: { authorization: "Bearer integration" },
      });
      expect(archived.statusCode).toBe(200);
      const replay = await app.inject(request);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data).toEqual(first.json().data);
      const conflict = await app.inject({
        ...request,
        payload: { input: "HTTP 不同输入" },
      });
      expect(conflict.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it.runIf(process.platform === "linux")(
    "开发黑盒 Gate：真实 HTTP、PG 原子创建、投递、Faux Pi 执行与 Sandbox 收敛",
    async () => {
      const label = `m4-e2e-${randomUUID()}`;
      const now = isoTimestamp(new Date().toISOString());
      const userA = createUser(userId(`m4-user-a-${label}`), now);
      const tenantA = createPersonalTenant({
        id: tenantId(`m4-tenant-a-${label}`),
        ownerMembershipId: membershipId(`m4-member-a-${label}`),
        owner: userA,
        createdAt: now,
      });
      const userB = createUser(userId(`m4-user-b-${label}`), now);
      const tenantB = createPersonalTenant({
        id: tenantId(`m4-tenant-b-${label}`),
        ownerMembershipId: membershipId(`m4-member-b-${label}`),
        owner: userB,
        createdAt: now,
      });
      await repositories.tenants.createPersonal({
        user: userA,
        tenant: tenantA.tenant,
        membership: tenantA.ownerMembership,
      });
      await repositories.tenants.createPersonal({
        user: userB,
        tenant: tenantB.tenant,
        membership: tenantB.ownerMembership,
      });

      let readinessAvailable = true;
      const generatedThreadId = threadId(`m4-thread-${label}`);
      const generatedWorkspaceId = workspaceId(`m4-workspace-${label}`);
      const generatedRunId = runId(`m4-run-${label}`);
      const app = createApiApp(
        {
          auth: createDevelopmentAuthResolver({
            runtimeEnvironment: "test",
            principals: [
              { tenantId: tenantA.tenant.id, userId: userA.id },
              { tenantId: tenantB.tenant.id, userId: userB.id },
            ],
          }),
          repositories,
          createCapability: createApiCreateCapability({
            threadCreation: new PgThreadCreation(runtime),
            enqueueOutbox: runDispatchCreation,
          }),
          archiveThread: new PgArchiveThreadCommand(runtime),
          cursorCodec: createThreadCursorCodec({
            activeKid: "m4-e2e-key",
            keys: [{ kid: "m4-e2e-key", secret: randomBytes(32).toString("base64url") }],
            clock: { now: () => isoTimestamp(new Date().toISOString()) },
            ttlMilliseconds: 60_000,
            maximumTtlMilliseconds: 60_000,
          }),
          readiness: {
            probe: async () => {
              if (!readinessAvailable) throw new Error("postgres-private-detail");
              await runtime.query("SELECT 1");
            },
          },
          clock: { now: () => isoTimestamp(new Date().toISOString()) },
          ids: {
            thread: () => generatedThreadId,
            workspace: () => generatedWorkspaceId,
            run: () => generatedRunId,
          },
        },
        { logger: false },
      );
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const baseUrl = new URL(address).origin;
      const request = async (path: string, init: RequestInit) => fetch(`${baseUrl}${path}`, init);
      const responseJson = async (
        response: Response,
      ): Promise<{
        readonly data?: { readonly id?: string; readonly status?: string };
        readonly error?: { readonly code?: string };
      }> =>
        (await response.json()) as {
          readonly data?: { readonly id?: string; readonly status?: string };
          readonly error?: { readonly code?: string };
        };
      try {
        const threadRequest = {
          method: "POST",
          headers: {
            authorization: "Bearer dev-user-a",
            "content-type": "application/json",
            "idempotency-key": `m4-thread-key-${label}`,
          },
          body: JSON.stringify({ title: "M4 开发黑盒任务" }),
        } as const;
        const createdThread = await request("/v1/threads", threadRequest);
        expect(createdThread.status).toBe(200);
        const replayedThread = await request("/v1/threads", threadRequest);
        expect(replayedThread.status).toBe(200);
        expect((await responseJson(replayedThread)).data?.id).toBe(
          (await responseJson(createdThread.clone())).data?.id,
        );

        const runRequest = {
          method: "POST",
          headers: {
            authorization: "Bearer dev-user-a",
            "content-type": "application/json",
            "idempotency-key": `m4-run-key-${label}`,
          },
          body: JSON.stringify({ input: "仅完成这个没有交付物的任务" }),
        } as const;
        const createdRun = await request(`/v1/threads/${generatedThreadId}/runs`, runRequest);
        expect(createdRun.status).toBe(200);
        const replayedRun = await request(`/v1/threads/${generatedThreadId}/runs`, runRequest);
        expect(replayedRun.status).toBe(200);
        expect((await responseJson(replayedRun)).data?.id).toBe(generatedRunId);
        const guessedByOtherTenant = await request(`/v1/threads/${generatedThreadId}`, {
          headers: { authorization: "Bearer dev-user-b" },
        });
        expect(guessedByOtherTenant.status).toBe(404);
        expect((await responseJson(guessedByOtherTenant)).error?.code).toBe("NOT_FOUND");

        readinessAvailable = false;
        const unavailable = await request("/ready", { method: "GET" });
        expect(unavailable.status).toBe(503);
        expect(JSON.stringify(await responseJson(unavailable))).not.toContain(
          "postgres-private-detail",
        );
        readinessAvailable = true;

        const gateway = new FakeSandboxGateway();
        let sandboxSequence = 0;
        const upstream: SandboxSessionRegistryPort = {
          acquire: async () => {
            const sandbox = await gateway.create({
              templateId: "m4-faux-template",
              ttlSeconds: 120,
            });
            sandboxSequence += 1;
            return {
              outcome: "ready",
              session: {
                registryId: `m4-registry-${label}-${sandboxSequence}`,
                providerSandboxId: sandbox.id,
                mode: "created",
                sandbox,
              },
            };
          },
          settle: async ({ session, disposition }) => {
            if (disposition === "pause") await session.sandbox.pause();
            else await session.sandbox.kill({ ignoreNotFound: true });
            return { outcome: "settled" };
          },
        };
        const faux = fauxProvider({
          api: `m4-faux-pi-${label}`,
          provider: `m4-faux-pi-${label}`,
          tokensPerSecond: 10_000,
        });
        faux.setResponses([fauxAssistantMessage("M4 Faux Pi 执行完成")]);
        const modelRuntime = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
        const sessions = new PiWorkerSessionFactory(faux.getModel(), modelRuntime);
        const registeredSandboxes = new PgBackedSandboxSessionRegistry(runtime, upstream, 120);
        const worker = new RunWorker(
          {
            persistence: new PgExecutionPersistence(runtime),
            revisions: new FakeRevisionVerifier(),
            sandboxes: registeredSandboxes,
            orphanSandboxes: registeredSandboxes,
            sessions,
            cancellation: new FakeCancellationPort(),
            artifacts: new FakeArtifactPublication(),
            clock: new FakeClock(),
            metrics: new FakeRecoveryMetrics(),
          },
          { workerId: "m4-development-worker", leaseDurationMs: 30_000, heartbeatMs: 10_000 },
        );
        const createDispatcher = () =>
          new RunDispatchScheduler(new PgRunDispatchOutbox(runtime), {
            execute: async (scope) => {
              const result = await worker.execute(scope as ExecutionScope);
              // Gate 注入的 Worker 同步执行到终态；不能把已经 succeeded 的 Run 当作异步已投递。
              if (result.outcome === "succeeded") return { kind: "terminal" };
              if (result.outcome === "waiting")
                return { kind: "waiting", retryAfterMilliseconds: 5_000 };
              if (result.outcome === "ignored") {
                return result.reason === "terminal"
                  ? { kind: "terminal" }
                  : { kind: "busy", retryAfterMilliseconds: 5_000 };
              }
              return { kind: "retryable", retryAfterMilliseconds: 5_000 };
            },
          });
        const firstDispatcher = createDispatcher();
        expect(
          await firstDispatcher.tick({
            tenantId: tenantA.tenant.id,
            dispatcherId: "m4-development-dispatcher",
            limit: 1,
            leaseMilliseconds: 30_000,
          }),
        ).toBe(1);
        // 模拟进程重启：必须重新构造 scheduler 与 outbox 端口，不能只在同一个实例换 ID。
        const restartedDispatcher = createDispatcher();
        expect(
          await restartedDispatcher.tick({
            tenantId: tenantA.tenant.id,
            dispatcherId: "m4-development-dispatcher-restart",
            limit: 1,
            leaseMilliseconds: 30_000,
          }),
        ).toBe(0);
        expect(faux.state.callCount).toBe(1);
        const modelPermit = await withTenantTransaction(
          runtime,
          { tenantId: tenantA.tenant.id },
          async (client) =>
            client.query<{ readonly count: string }>(
              `SELECT count(*)::text AS count FROM external_effect_permits
            WHERE tenant_id=$1 AND effect='model_start' AND consumed_at IS NOT NULL`,
              [tenantA.tenant.id],
            ),
        );
        expect(modelPermit.rows[0]?.count).toBe("1");
        const releasedFences = await withTenantTransaction(
          runtime,
          { tenantId: tenantA.tenant.id },
          async (client) => {
            const [claims, leases] = await Promise.all([
              client.query<{ readonly count: string }>(
                `SELECT count(*)::text AS count FROM run_claims
                WHERE tenant_id=$1 AND released_at IS NULL`,
                [tenantA.tenant.id],
              ),
              client.query<{ readonly count: string }>(
                `SELECT count(*)::text AS count FROM workspace_write_leases WHERE tenant_id=$1`,
                [tenantA.tenant.id],
              ),
            ]);
            return { claims: claims.rows[0]?.count, leases: leases.rows[0]?.count };
          },
        );
        expect(releasedFences).toEqual({ claims: "0", leases: "0" });
        const cleanup = new SandboxCleanupConsumer(
          new PgSandboxCleanupConsumerStore(runtime),
          new CubeSandboxCleanupResolver(gateway),
          "m4-development-cleanup",
        );
        expect(await cleanup.drainTenant(tenantA.tenant.id)).toBe(0);
        await cleanup.close();
        expect([...gateway.sandboxes.values()].every((sandbox) => sandbox.killed)).toBe(true);
        const succeeded = await request(`/v1/threads/${generatedThreadId}/runs/${generatedRunId}`, {
          headers: { authorization: "Bearer dev-user-a" },
        });
        expect(succeeded.status).toBe(200);
        expect((await responseJson(succeeded)).data?.status).toBe("succeeded");
      } finally {
        await app.close();
      }
    },
  );

  it("workerId 按 UTF-8 字节边界拒绝多字节超限且不泄漏数据库约束", async () => {
    const f = await fixture(`worker-id-${suffix}`);
    await expect(
      persistence.claim({
        scope: f.scope,
        workerId: "中".repeat(67),
        leaseDurationMs: 30_000,
      }),
    ).rejects.toThrow("UTF-8 字节长度");
    await expect(
      persistence.claim({
        scope: f.scope,
        workerId: "中".repeat(66),
        leaseDurationMs: 30_000,
      }),
    ).resolves.toMatchObject({ outcome: "claimed" });
  });

  it("Runtime 受限 SQL 直写也拒绝只含 tab/newline 的输入", async () => {
    const f = await fixture(`dispatch-blank-db-${suffix}`);
    const run = createRun({
      id: runId(`blank-run-${suffix}`),
      thread: f.thread,
      now: f.thread.createdAt,
    });
    await repositories.runs.create({ tenantId: f.scope.tenantId, userId: f.user.id }, run);
    await expect(
      withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
        client.query(
          `INSERT INTO run_execution_inputs(
             tenant_id,run_id,thread_id,workspace_id,root_run_id,base_revision_id,
             input_text,initial_projection,initial_projection_digest
           ) VALUES ($1,$2,$3,$4,$2,NULL,$5,$6::jsonb,$7)`,
          [
            f.scope.tenantId,
            run.id,
            f.scope.threadId,
            f.scope.workspaceId,
            "\t\n\r ",
            JSON.stringify({ schemaVersion: 1, checkpointId: "db-check", turns: [] }),
            "f".repeat(64),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("执行初始化逐字段幂等，冲突输入不会被 ON CONFLICT 吞掉", async () => {
    const f = await fixture(`setup-${suffix}`);
    const original = {
      scope: f.scope,
      input: "执行 PostgreSQL Run Worker 集成任务",
      rolloutProjection: {
        schemaVersion: 1 as const,
        checkpointId: `cp-setup-${suffix}`,
        turns: [],
      },
    };
    // fixture 的 checkpointId 含完整 label；用数据库事实读出后验证原命令重放与异命令冲突。
    const stored = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) =>
        client.query<{ initial_projection: typeof original.rolloutProjection }>(
          "SELECT initial_projection FROM run_execution_inputs WHERE tenant_id=$1 AND run_id=$2",
          [f.scope.tenantId, f.scope.runId],
        ),
      { readOnly: true },
    );
    await expect(
      setup.initialize({
        ...original,
        rolloutProjection: stored.rows[0]?.initial_projection ?? original.rolloutProjection,
      }),
    ).resolves.toBe("already_exists");
    await expect(
      setup.initialize({
        ...original,
        input: "另一份不能被吞掉的输入",
        rolloutProjection: stored.rows[0]?.initial_projection ?? original.rolloutProjection,
      }),
    ).resolves.toBe("conflict");
  });

  it("初始化与数据库按同一 jsonb 规范化字节边界接受 64KiB 并确定拒绝超限", async () => {
    const maximum = await projectionAtStoredBytes(65_536);
    await expect(fixture(`projection-max-${suffix}`, maximum)).resolves.toBeDefined();

    const oversized = await projectionAtStoredBytes(65_537);
    await expect(fixture(`projection-over-${suffix}`, oversized)).rejects.toThrow(
      "PostgreSQL 规范化 64KiB 上限",
    );
  });

  it("model_start 只在持久 checkpoint 后签发且每 Attempt 永久一次", async () => {
    const f = await fixture(`model-permit-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "model-permit-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const firstCall = {
      callId: "model-start-1",
      toolName: "model",
      argsDigest: sha256Digest("1".repeat(64)),
    };
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        effect: "model_start",
        call: firstCall,
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    const checkpoint = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/model-checkpoint`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [],
        outbox: [],
      }),
    );
    expect(checkpoint.outcome).toBe("applied");
    const permit = await persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 1,
      effect: "model_start",
      call: firstCall,
      permitDurationMs: 3_000,
    });
    expect(permit.outcome).toBe("authorized");
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        effect: "model_start",
        call: { ...firstCall, callId: "model-start-2" },
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("waiting 回答使用 Run version 与旧值 CAS，不能无条件覆盖", async () => {
    const f = await fixture(`answer-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "answer-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const running = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/running`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        events: [],
        outbox: [],
      }),
    );
    expect(running.outcome).toBe("applied");
    const waiting = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/waiting`,
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        nextAttemptStatus: "waiting",
        nextStage: "finished",
        nextRunStatus: "waiting",
        events: [],
        outbox: [],
        releaseFences: true,
      }),
    );
    expect(waiting.outcome).toBe("applied");
    const version = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => {
        const result = await client.query<{ version: string }>(
          "SELECT version::text FROM runs WHERE tenant_id=$1 AND id=$2",
          [f.scope.tenantId, f.scope.runId],
        );
        return Number(result.rows[0]?.version);
      },
      { readOnly: true },
    );
    await expect(
      setup.setAnswer({
        scope: f.scope,
        answer: "只处理 Markdown",
        expectedRunVersion: version,
      }),
    ).resolves.toBe("updated");
    await expect(
      setup.setAnswer({
        scope: f.scope,
        answer: "覆盖回答",
        expectedRunVersion: version,
      }),
    ).resolves.toBe("conflict");
    const resumed = await persistence.claim({
      scope: f.scope,
      workerId: "answer-resume-worker",
      leaseDurationMs: 30_000,
    });
    expect(resumed).toMatchObject({ outcome: "claimed", snapshot: { answer: "只处理 Markdown" } });
  });

  it("事件、EffectInvocation 与 permit 使用同一 Attempt version 栅栏", async () => {
    const f = await fixture(`permit-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "permit-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const event = {
      schemaVersion: 1 as const,
      kind: "agent_event" as const,
      sequence: 0,
      payload: { type: "tool.started" as const, callId: "call-pg", name: "sandbox_write_file" },
    };
    const registered = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/event/0`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        events: [event],
        outbox: [],
        effectInvocation: { callId: "call-pg", toolName: "sandbox_write_file" },
      }),
    );
    expect(registered.outcome).toBe("applied");
    const call = {
      callId: "call-pg",
      toolName: "sandbox_write_file",
      argsDigest: outboxPayloadDigest({
        schemaVersion: 1,
        kind: "runtime_alert",
        idempotencyKey: "digest-only",
        state: "pending",
        payload: { code: "INTERNAL", attemptId: claimed.snapshot.attempt.attemptId },
      }),
    };
    const permit = await persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 1,
      effect: "tool_execution",
      call,
      permitDurationMs: 3_000,
    });
    expect(permit.outcome).toBe("authorized");
    if (permit.outcome !== "authorized") throw new Error("permit 失败");
    const tamperedPermits = [
      {
        ...permit.permit,
        scope: { ...permit.permit.scope, threadId: threadId("forged-permit-thread") },
      },
      { ...permit.permit, runClaimToken: "forged-claim-token" },
      { ...permit.permit, runClaimEpoch: permit.permit.runClaimEpoch + 1 },
      { ...permit.permit, workspaceRootRunId: runId("forged-permit-root") },
      { ...permit.permit, workspaceLeaseEpoch: permit.permit.workspaceLeaseEpoch + 1 },
      { ...permit.permit, attemptVersion: permit.permit.attemptVersion + 1 },
    ];
    for (const tampered of tamperedPermits) {
      await expect(
        persistence.consumeExternalEffectPermit({
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          permit: tampered,
        }),
      ).resolves.toEqual({ outcome: "conflict" });
    }
    await expect(
      persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        permit: permit.permit,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        effect: "tool_execution",
        call: { ...call, argsDigest: sha256Digest("b".repeat(64)) },
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      persistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/duplicate-call`,
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          events: [{ ...event, sequence: 1 }],
          outbox: [],
          effectInvocation: { callId: "call-pg", toolName: "sandbox_write_file" },
        }),
      ),
    ).resolves.toEqual({ outcome: "idempotency_conflict" });
  });

  it("COMMIT 响应丢失后按原 scope+key 精确读回不可变 receipt", async () => {
    const f = await fixture(`receipt-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "receipt-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const lossy = new PgExecutionPersistence(withLostCommitResponse(runtime));
    const command = signed({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/checkpoint`,
      fence: claimed.fence,
      expectedAttemptVersion: 0,
      events: [],
      outbox: [],
      nextAttemptStatus: "running",
    });
    await expect(lossy.mutate(command)).resolves.toEqual({ outcome: "response_unknown" });
    const readback = await persistence.readMutation({
      scope: f.scope,
      idempotencyKey: command.idempotencyKey,
    });
    expect(readback).toMatchObject({
      outcome: "applied",
      attemptVersion: 1,
      receipt: { commandDigest: command.commandDigest },
    });
    await expect(
      persistence.mutate({ ...command, commandDigest: "0".repeat(64) as never }),
    ).resolves.toEqual({
      outcome: "idempotency_conflict",
    });
    const sameKeyDifferentCommand = signed({
      ...command,
      expectedAttemptVersion: 1,
      nextAttemptStatus: "running",
      events: [
        {
          schemaVersion: 1,
          kind: "attempt_state_changed",
          sequence: 0,
          payload: { status: "running", stage: "claimed" },
        },
      ],
    });
    await expect(persistence.mutate(sameKeyDifferentCommand)).resolves.toEqual({
      outcome: "idempotency_conflict",
    });
  });

  it("Sandbox acquire UNKNOWN 作为独立恢复事实持久化", async () => {
    const f = await fixture(`lifecycle-unknown-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "unknown-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const uncertainEvent = {
      kind: "sandbox_create_outcome_unknown" as const,
      stage: "create_response" as const,
      requestId: "request-unknown-pg",
      actualTtlSeconds: 120,
      occurredAt: "2099-07-26T00:00:01.000Z",
    };
    const persisted = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/acquire-unknown`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "recovery_required",
        events: [],
        outbox: [
          {
            schemaVersion: 1,
            kind: "sandbox_lifecycle_unknown",
            idempotencyKey: `${claimed.snapshot.attempt.attemptId}/unknown/request-unknown-pg`,
            state: "unknown",
            payload: {
              requestId: uncertainEvent.requestId,
              actualTtlSeconds: uncertainEvent.actualTtlSeconds,
              stage: uncertainEvent.stage,
              uncertainEvent,
              retryCode: "SANDBOX_UNKNOWN",
            },
          },
        ],
        releaseFences: true,
      }),
    );
    expect(persisted).toMatchObject({
      outcome: "applied",
      attempt: { status: "recovery_required" },
      receipt: { outbox: [{ kind: "sandbox_lifecycle_unknown", state: "unknown" }] },
    });
    const fact = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => {
        const result = await client.query<{
          request_id: string;
          provider_sandbox_id: string | null;
        }>(
          `SELECT request_id,provider_sandbox_id FROM sandbox_lifecycle_unknown
            WHERE tenant_id=$1 AND attempt_id=$2`,
          [f.scope.tenantId, claimed.snapshot.attempt.attemptId],
        );
        return result.rows[0];
      },
      { readOnly: true },
    );
    expect(fact).toEqual({ request_id: "request-unknown-pg", provider_sandbox_id: null });
  });

  it("Sandbox ready 先登记 registry，settle 只接受已 started 的 cleanup 身份", async () => {
    const f = await fixture(`registry-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "registry-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    let settleCount = 0;
    const upstream: SandboxSessionRegistryPort = {
      acquire: async () => ({
        outcome: "ready",
        session: {
          registryId: "registry-wrapper-pg",
          providerSandboxId: "sandbox-wrapper-pg",
          mode: "created",
          sandbox: {} as never,
        },
      }),
      settle: async () => {
        settleCount += 1;
        return { outcome: "settled" };
      },
    };
    const registry = new PgBackedSandboxSessionRegistry(runtime, upstream, 120);
    const acquired = await registry.acquire({
      scope: f.scope,
      signal: new AbortController().signal,
    });
    if (acquired.outcome !== "ready") throw new Error("registry acquire 失败");
    const orphanKey = `registry:${acquired.session.registryId}:orphan-cleanup`;
    await expect(
      registry.settle({
        scope: f.scope,
        session: acquired.session,
        cleanupIntentId: `${orphanKey}:forged`,
        disposition: "close",
      }),
    ).rejects.toThrow("cleanup intent");
    await expect(
      registry.settle({
        scope: f.scope,
        session: acquired.session,
        cleanupIntentId: orphanKey,
        disposition: "pause",
      }),
    ).rejects.toThrow("cleanup intent");
    await expect(
      registry.closeOrphan({ scope: f.scope, session: { ...acquired.session } }),
    ).rejects.toThrow("capability");
    await expect(
      registry.closeOrphan({
        scope: { ...f.scope, threadId: threadId("forged-orphan-thread") },
        session: acquired.session,
      }),
    ).rejects.toThrow("scope 或身份不匹配");
    expect(settleCount).toBe(0);
    const cleanupKey = `${claimed.snapshot.attempt.attemptId}/registry-cleanup`;
    const pending: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }> = {
      schemaVersion: 1,
      kind: "sandbox_cleanup",
      idempotencyKey: cleanupKey,
      state: "pending",
      armed: true,
      payload: {
        registryId: acquired.session.registryId,
        providerSandboxId: acquired.session.providerSandboxId,
      },
    };
    expect(
      (
        await persistence.mutate(
          signed({
            idempotencyKey: `${claimed.snapshot.attempt.attemptId}/registry-pending`,
            fence: claimed.fence,
            expectedAttemptVersion: 0,
            nextAttemptStatus: "running",
            events: [],
            outbox: [pending],
          }),
        )
      ).outcome,
    ).toBe("applied");
    expect(
      (
        await persistence.mutate(
          signed({
            idempotencyKey: `${claimed.snapshot.attempt.attemptId}/registry-started`,
            fence: claimed.fence,
            expectedAttemptVersion: 1,
            events: [],
            outbox: [
              {
                ...pending,
                state: "started",
                payload: { ...pending.payload, disposition: "close" },
              },
            ],
          }),
        )
      ).outcome,
    ).toBe("applied");
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='closed' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, acquired.session.registryId],
      ),
    );
    await expect(
      registry.settle({
        scope: f.scope,
        session: acquired.session,
        cleanupIntentId: cleanupKey,
        disposition: "close",
      }),
    ).rejects.toThrow("开始态未能原子同步");
    const unchanged = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string; remote_call_started_at: Date | null }>(
          `SELECT state,remote_call_started_at FROM cleanup_outbox
          WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3`,
          [f.scope.tenantId, claimed.snapshot.attempt.attemptId, cleanupKey],
        ),
    );
    expect(unchanged.rows[0]).toEqual({ state: "started", remote_call_started_at: null });
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='ready' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, acquired.session.registryId],
      ),
    );
    await expect(
      registry.settle({
        scope: f.scope,
        session: acquired.session,
        cleanupIntentId: cleanupKey,
        disposition: "close",
      }),
    ).resolves.toEqual({ outcome: "settled" });
    expect(settleCount).toBe(1);
    const state = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => {
        const result = await client.query<{ state: string }>(
          "SELECT state FROM sandbox_registry WHERE tenant_id=$1 AND registry_id=$2",
          [f.scope.tenantId, acquired.session.registryId],
        );
        return result.rows[0]?.state;
      },
      { readOnly: true },
    );
    expect(state).toBe("closed");
  });

  it("孤儿关闭仅接受成功登记返回的 session capability 并固定使用 close", async () => {
    const f = await fixture(`orphan-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "orphan-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const upstreamCalls: Array<Parameters<SandboxSessionRegistryPort["settle"]>[0]> = [];
    const upstream: SandboxSessionRegistryPort = {
      acquire: async () => ({
        outcome: "ready",
        session: {
          registryId: "registry-orphan-pg",
          providerSandboxId: "sandbox-orphan-pg",
          mode: "created",
          sandbox: {} as never,
        },
      }),
      settle: async (input) => {
        upstreamCalls.push(input);
        return { outcome: "settled" };
      },
    };
    const registry = new PgBackedSandboxSessionRegistry(runtime, upstream, 120);
    const acquired = await registry.acquire({
      scope: f.scope,
      signal: new AbortController().signal,
    });
    if (acquired.outcome !== "ready") throw new Error("registry acquire 失败");

    await expect(
      registry.closeOrphan({ scope: f.scope, session: acquired.session }),
    ).resolves.toEqual({ outcome: "settled" });
    expect(upstreamCalls).toEqual([
      expect.objectContaining({
        cleanupIntentId: `registry:${acquired.session.registryId}:orphan-cleanup`,
        disposition: "close",
        session: acquired.session,
      }),
    ]);
  });

  it("cleanup armed/disposition、Projection CAS 与 Revision+Run 终态同事务", async () => {
    const f = await fixture(`final-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "final-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO sandbox_registry(
           tenant_id,registry_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
           provider_sandbox_id,request_id,state,actual_ttl_seconds
         ) VALUES ($1,'registry-pg',$2,$3,$4,$5,$6,'sandbox-pg','request-pg','ready',120)`,
        [
          f.scope.tenantId,
          claimed.snapshot.attempt.attemptId,
          f.scope.runId,
          f.scope.threadId,
          f.scope.workspaceId,
          f.scope.rootRunId,
        ],
      );
    });
    const pending: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }> = {
      schemaVersion: 1,
      kind: "sandbox_cleanup",
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/sandbox/registry-pg/cleanup`,
      state: "pending",
      armed: true,
      payload: { registryId: "registry-pg", providerSandboxId: "sandbox-pg" },
    };
    const first = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/intent`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        expectedProjectionVersion: 0,
        events: [],
        outbox: [pending],
        nextAttemptStatus: "running",
        rolloutProjection: { schemaVersion: 1, checkpointId: "projection-updated", turns: [] },
      }),
    );
    expect(first).toMatchObject({
      outcome: "applied",
      receipt: { outbox: [{ armed: true, state: "pending" }], projection: { version: 1 } },
    });
    const started: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }> = {
      ...pending,
      state: "started",
      payload: { ...pending.payload, disposition: "close" },
    };
    const cleanupStarted = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/cleanup-started`,
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        events: [],
        outbox: [started],
      }),
    );
    expect(cleanupStarted).toMatchObject({
      outcome: "applied",
      receipt: { outbox: [{ state: "started", disposition: "close" }] },
    });
    const finalizing = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/finalizing`,
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        nextAttemptStatus: "finalizing",
        nextStage: "finalizing",
        events: [],
        outbox: [],
      }),
    );
    expect(finalizing.outcome).toBe("applied");
    const revision = workspaceRevisionId(`rw-revision-${suffix}`);
    const lossyFinal = new PgExecutionPersistence(runtime, {
      afterCommit: () => {
        throw new Error("模拟 Revision 终态 COMMIT 响应丢失");
      },
    });
    const finalCommand = signed({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/final`,
      fence: claimed.fence,
      expectedAttemptVersion: 3,
      nextAttemptStatus: "succeeded",
      nextStage: "finished",
      nextRunStatus: "succeeded",
      events: [],
      outbox: [],
      workspaceChange: {
        tenantId: f.scope.tenantId,
        threadId: f.scope.threadId,
        workspaceId: f.scope.workspaceId,
        rootRunId: f.scope.rootRunId,
        revisionId: revision,
        objectKey: `workspace/${revision}.tar`,
        digest: sha256Digest("a".repeat(64)),
      },
      releaseFences: true,
    });
    await expect(lossyFinal.mutate(finalCommand)).resolves.toEqual({
      outcome: "response_unknown",
    });
    const final = await persistence.readMutation({
      scope: f.scope,
      idempotencyKey: finalCommand.idempotencyKey,
    });
    expect(final).toMatchObject({
      outcome: "applied",
      run: { status: "succeeded" },
      workspace: { currentRevisionId: revision },
      receipt: { workspace: { currentHead: revision } },
    });
  });

  it("租约过期由恢复协调器收敛，普通 claim 不越过 running Run", async () => {
    const f = await fixture(`recover-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "recover-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    await admin.query(
      `UPDATE "${schema}".run_claims
          SET expires_at=acquired_at+interval '1 millisecond'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [f.scope.tenantId, claimed.snapshot.attempt.attemptId],
    );
    await admin.query(
      `UPDATE "${schema}".workspace_write_leases
          SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND workspace_id=$2`,
      [f.scope.tenantId, f.scope.workspaceId],
    );
    await expect(
      persistence.claim({ scope: f.scope, workerId: "other-worker", leaseDurationMs: 30_000 }),
    ).resolves.toEqual({ outcome: "recovery_required" });
    await expect(
      persistence.recoverExpiredAttempt({ scope: f.scope, decision: "safe_fail" }),
    ).resolves.toBe("recovered");
    await expect(
      persistence.claim({ scope: f.scope, workerId: "late-worker", leaseDurationMs: 30_000 }),
    ).resolves.toEqual({ outcome: "terminal" });
    const state = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => {
        const result = await client.query<{ run_status: string; attempt_status: string }>(
          `SELECT run.status AS run_status,attempt.status AS attempt_status
             FROM runs run JOIN execution_attempts attempt
               ON attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
            WHERE run.tenant_id=$1 AND run.id=$2`,
          [f.scope.tenantId, f.scope.runId],
        );
        return result.rows[0];
      },
      { readOnly: true },
    );
    expect(state).toEqual({ run_status: "failed", attempt_status: "failed" });

    const unsafe = await fixture(`recover-model-${suffix}`);
    const unsafeClaim = await persistence.claim({
      scope: unsafe.scope,
      workerId: "recover-model-worker",
      leaseDurationMs: 30_000,
    });
    if (unsafeClaim.outcome !== "claimed") throw new Error("claim 失败");
    const modelStarted = await persistence.mutate(
      signed({
        idempotencyKey: `${unsafeClaim.snapshot.attempt.attemptId}/model-started`,
        fence: unsafeClaim.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [],
        outbox: [],
      }),
    );
    expect(modelStarted.outcome).toBe("applied");
    await admin.query(
      `UPDATE "${schema}".run_claims
          SET expires_at=acquired_at+interval '1 millisecond'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [unsafe.scope.tenantId, unsafeClaim.snapshot.attempt.attemptId],
    );
    await admin.query(
      `UPDATE "${schema}".workspace_write_leases
          SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND workspace_id=$2`,
      [unsafe.scope.tenantId, unsafe.scope.workspaceId],
    );
    await expect(
      persistence.recoverExpiredAttempt({ scope: unsafe.scope, decision: "safe_fail" }),
    ).resolves.toBe("recovered");
    const unsafeState = await withTenantTransaction(
      runtime,
      { tenantId: unsafe.scope.tenantId },
      async (client) => {
        const result = await client.query<{ run_status: string; attempt_status: string }>(
          `SELECT run.status AS run_status,attempt.status AS attempt_status
             FROM runs run JOIN execution_attempts attempt
               ON attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
            WHERE run.tenant_id=$1 AND run.id=$2`,
          [unsafe.scope.tenantId, unsafe.scope.runId],
        );
        return result.rows[0];
      },
      { readOnly: true },
    );
    expect(unsafeState).toEqual({
      run_status: "running",
      attempt_status: "recovery_required",
    });
  });

  it("RLS 对跨租户读写均 fail closed", async () => {
    const left = await fixture(`rls-left-${suffix}`);
    const right = await fixture(`rls-right-${suffix}`);
    const visible = await withTenantTransaction(
      runtime,
      { tenantId: left.scope.tenantId },
      async (client) =>
        client.query("SELECT run_id FROM run_execution_inputs WHERE tenant_id=$1", [
          right.scope.tenantId,
        ]),
      { readOnly: true },
    );
    expect(visible.rows).toEqual([]);
    await expect(
      withTenantTransaction(runtime, { tenantId: left.scope.tenantId }, (client) =>
        client.query(
          `UPDATE run_execution_inputs SET answer_text='越权'
            WHERE tenant_id=$1 AND run_id=$2`,
          [right.scope.tenantId, right.scope.runId],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("存储端口与数据库 CHECK 双重拒绝超过 64KiB 的协议 payload", async () => {
    const f = await fixture(`size-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "size-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const oversized = "中".repeat(70_000);
    await expect(
      persistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/oversized`,
          fence: claimed.fence,
          expectedAttemptVersion: 0,
          events: [],
          outbox: [
            {
              schemaVersion: 1,
              kind: "runtime_alert",
              idempotencyKey: "oversized-alert",
              state: "pending",
              payload: { code: "INTERNAL", attemptId: oversized },
            },
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: "protocol_invalid" });
    await expect(
      withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
        client.query(
          `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
           VALUES ($1,$2,0,1,'attempt_state_changed',$3::jsonb)`,
          [f.scope.tenantId, claimed.snapshot.attempt.attemptId, JSON.stringify({ oversized })],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("紧凑 JSON 不再伪造 64KiB 上限，持久化以 jsonb::text 作为唯一事实", async () => {
    const f = await fixture(`canonical-size-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "canonical-size-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    // 数组元素在 jsonb::text 中会增加分隔空白；紧凑 JSON 小于 64KiB 仍可能超限。
    const payload = {
      type: "queue.updated" as const,
      steering: Array.from({ length: 20_000 }, () => ""),
      followUp: [],
    };
    const compact = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const canonical = await migrator.query<{ bytes: number }>(
      "SELECT octet_length($1::jsonb::text) AS bytes",
      [JSON.stringify(payload)],
    );
    expect(compact).toBeLessThanOrEqual(65_536);
    expect(Number(canonical.rows[0]?.bytes)).toBeGreaterThan(65_536);
    const event = {
      schemaVersion: 1 as const,
      kind: "agent_event" as const,
      sequence: 0,
      payload,
    };
    // 应用层不再以紧凑 JSON 误判；真正的 64KiB 由同一 PG 事务收敛。
    expect(() => assertProtocolSize(event)).not.toThrow();
    await expect(
      persistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/canonical-size`,
          fence: claimed.fence,
          expectedAttemptVersion: 0,
          events: [event],
          outbox: [],
        }),
      ),
    ).resolves.toEqual({ outcome: "protocol_invalid" });
  });

  it("Runtime 最小权限、FORCE RLS 与无 routine 均生效", async () => {
    const privilege = await admin.query<{ can_delete_event: boolean; can_update_call: boolean }>(
      `SELECT has_table_privilege($1,$2||'.run_events','DELETE') AS can_delete_event,
              has_column_privilege($1,$2||'.effect_invocations','call_id','UPDATE') AS can_update_call`,
      [runtimeRole, schema],
    );
    expect(privilege.rows[0]).toEqual({ can_delete_event: false, can_update_call: false });
    const routines = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_proc
        WHERE pronamespace=$1::regnamespace`,
      [schema],
    );
    expect(routines.rows[0]?.count).toBe("0");
  });

  it("Cleanup Store 在真实 PostgreSQL 保持领取、栅栏、RLS 与恢复事实", async () => {
    const f = await fixture(`cleanup-store-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "cleanup-seed",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("Cleanup Store fixture 未能取得 Attempt");
    const attemptId = claimed.snapshot.attempt.attemptId;
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO sandbox_registry(tenant_id,registry_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,provider_sandbox_id,request_id,state,actual_ttl_seconds)
         VALUES ($1,'cleanup-store-registry',$2,$3,$4,$5,$6,'cleanup-store-sandbox','cleanup-store-request','ready',120)`,
        [
          f.scope.tenantId,
          attemptId,
          f.scope.runId,
          f.scope.threadId,
          f.scope.workspaceId,
          f.scope.rootRunId,
        ],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,identity_digest,payload,payload_digest)
         VALUES ($1,$2,'cleanup-store-key','cleanup-store-registry','cleanup-store-sandbox','pending',true,$3,$4::jsonb,$5)`,
        [
          f.scope.tenantId,
          attemptId,
          "a".repeat(64),
          JSON.stringify({ schemaVersion: 1 }),
          "b".repeat(64),
        ],
      );
    });
    const left = new PgSandboxCleanupConsumerStore(runtime);
    const right = new PgSandboxCleanupConsumerStore(runtime);
    // 两条真实 PG 连接并发时，heartbeat 续租和 Cleanup 必须遵守同一把 Attempt 栅栏。
    // 无论调度顺序如何，续租成功后 Cleanup 都不能越过仍在使用 Sandbox 的 Attempt。
    const [renewedFence, blockedCleanup] = await Promise.all([
      persistence.inspectAndRenew({ fence: claimed.fence, leaseDurationMs: 30_000 }),
      left.claimNext({
        tenantId: f.scope.tenantId,
        workerId: "cleanup-left",
        leaseMs: 210_000,
      }),
    ]);
    expect(renewedFence.outcome).toBe("active");
    expect(blockedCleanup).toBeUndefined();
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `UPDATE run_claims SET released_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2`,
        [f.scope.tenantId, attemptId],
      );
      await client.query(
        `UPDATE workspace_write_leases SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE tenant_id=$1 AND workspace_id=$2`,
        [f.scope.tenantId, f.scope.workspaceId],
      );
    });
    const races = await Promise.all([
      left.claimNext({ tenantId: f.scope.tenantId, workerId: "cleanup-left", leaseMs: 210_000 }),
      right.claimNext({ tenantId: f.scope.tenantId, workerId: "cleanup-right", leaseMs: 210_000 }),
    ]);
    let winner = races.find((value) => value !== undefined);
    expect(races.filter((value) => value !== undefined)).toHaveLength(1);
    if (winner === undefined) throw new Error("Cleanup Store 没有唯一领取者");
    // 未越过远端边界的过期 claim 可重领，generation 递增，旧 token/generation 立即失效。
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE cleanup_outbox SET claim_lease_expires_at=clock_timestamp()-interval '1 millisecond'
          WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-key'`,
        [f.scope.tenantId, attemptId],
      ),
    );
    const previous = winner;
    winner = await right.claimNext({
      tenantId: f.scope.tenantId,
      workerId: "cleanup-right",
      leaseMs: 210_000,
    });
    if (winner === undefined) throw new Error("过期 Cleanup claim 未能重领");
    expect(winner.generation).toBe(previous.generation + 1);
    expect(await left.markRemoteStarted(previous)).toBe(false);
    // lease 已过期时即使 token 正确也不能跨远端边界。
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE cleanup_outbox SET claim_lease_expires_at=clock_timestamp()-interval '1 millisecond'
          WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-key'`,
        [f.scope.tenantId, attemptId],
      ),
    );
    expect(await left.markRemoteStarted(winner)).toBe(false);
    winner = await left.claimNext({
      tenantId: f.scope.tenantId,
      workerId: "cleanup-left",
      leaseMs: 210_000,
    });
    if (winner === undefined) throw new Error("过期租约后未能取得下一代 claim");
    // 完整身份、generation、token 任一篡改都不能跨越远端边界。
    expect(await left.markRemoteStarted({ ...winner, token: `${winner.token}-forged` })).toBe(
      false,
    );
    expect(await left.markRemoteStarted({ ...winner, registryId: "forged-registry" })).toBe(false);
    // token 与完整身份都正确但 generation 不正确，仍不能跨越远端边界或结束 Cleanup。
    // 这防止旧 Worker 在同一 token 被新一代领取后写回状态。
    const wrongGeneration = { ...winner, generation: winner.generation + 1 };
    expect(await left.markRemoteStarted(wrongGeneration)).toBe(false);
    expect(await left.unknown(wrongGeneration)).toBe(false);
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='closed' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, winner.registryId],
      ),
    );
    await expect(left.markRemoteStarted(winner)).rejects.toThrow("状态同步失败");
    const beforeRetry = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string; remote_call_started_at: Date | null }>(
          `SELECT state,remote_call_started_at FROM cleanup_outbox WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-key'`,
          [f.scope.tenantId, attemptId],
        ),
    );
    expect(beforeRetry.rows[0]).toEqual({ state: "started", remote_call_started_at: null });
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='ready' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, winner.registryId],
      ),
    );
    expect(await left.markRemoteStarted(winner)).toBe(true);
    // marker 之后租约过期只会 unknown；不会再次 claim 或重复远端调用。
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE cleanup_outbox SET claim_lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-key'`,
        [f.scope.tenantId, attemptId],
      ),
    );
    expect(
      await right.claimNext({
        tenantId: f.scope.tenantId,
        workerId: "cleanup-right",
        leaseMs: 210_000,
      }),
    ).toBeUndefined();
    const recovered = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string }>(
          `SELECT state FROM cleanup_outbox WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-key'`,
          [f.scope.tenantId, attemptId],
        ),
    );
    expect(recovered.rows[0]?.state).toBe("unknown");
    // 已决定的 pause 在过期恢复时必须保持，不得被默认 close 覆盖；完成后 registry 同步 paused。
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET state='ready' WHERE tenant_id=$1 AND registry_id='cleanup-store-registry'`,
        [f.scope.tenantId],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,identity_digest,disposition,payload,payload_digest,claim_token,claim_generation,claimed_by,claim_lease_expires_at)
         VALUES ($1,$2,'cleanup-store-pause','cleanup-store-registry','cleanup-store-sandbox','started',true,$3,'pause',$4::jsonb,$5,'old-pause',1,'old-worker',clock_timestamp()-interval '1 millisecond')`,
        [
          f.scope.tenantId,
          attemptId,
          "c".repeat(64),
          JSON.stringify({ schemaVersion: 1, disposition: "pause" }),
          "d".repeat(64),
        ],
      );
    });
    const paused = await left.claimNext({
      tenantId: f.scope.tenantId,
      workerId: "cleanup-left",
      leaseMs: 210_000,
    });
    if (paused === undefined) throw new Error("pause Cleanup 未能重领");
    expect(paused.disposition).toBe("pause");
    expect(await left.markRemoteStarted(paused)).toBe(true);
    // complete 先更新 cleanup 再更新 registry；registry 不匹配时两个事实必须一起回滚。
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='closed' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, paused.registryId],
      ),
    );
    await expect(left.complete(paused)).rejects.toThrow("状态同步失败");
    const completeRollback = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string; claim_token: string | null }>(
          `SELECT state,claim_token FROM cleanup_outbox
            WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-pause'`,
          [f.scope.tenantId, attemptId],
        ),
    );
    expect(completeRollback.rows[0]).toEqual({ state: "started", claim_token: paused.token });
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='pausing' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, paused.registryId],
      ),
    );
    expect(await left.complete(paused)).toBe(true);
    const pausedRegistry = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string }>(
          `SELECT state FROM sandbox_registry WHERE tenant_id=$1 AND registry_id='cleanup-store-registry'`,
          [f.scope.tenantId],
        ),
    );
    expect(pausedRegistry.rows[0]?.state).toBe("paused");
    // unknown 同样必须与 registry 原子同步，避免远端结果未知时留下半完成 Cleanup。
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET state='ready' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, paused.registryId],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,identity_digest,disposition,payload,payload_digest,claim_token,claim_generation,claimed_by,claim_lease_expires_at)
         VALUES ($1,$2,'cleanup-store-unknown','cleanup-store-registry','cleanup-store-sandbox','started',true,$3,'close',$4::jsonb,$5,'old-unknown',1,'old-worker',clock_timestamp()-interval '1 millisecond')`,
        [
          f.scope.tenantId,
          attemptId,
          "e".repeat(64),
          JSON.stringify({ schemaVersion: 1, disposition: "close" }),
          "f".repeat(64),
        ],
      );
    });
    const unknownClaim = await left.claimNext({
      tenantId: f.scope.tenantId,
      workerId: "cleanup-left",
      leaseMs: 210_000,
    });
    if (unknownClaim === undefined) throw new Error("unknown Cleanup 未能重领");
    expect(await left.markRemoteStarted(unknownClaim)).toBe(true);
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='closed' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, unknownClaim.registryId],
      ),
    );
    await expect(left.unknown(unknownClaim)).rejects.toThrow("状态同步失败");
    const unknownRollback = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string; claim_token: string | null }>(
          `SELECT state,claim_token FROM cleanup_outbox
            WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key='cleanup-store-unknown'`,
          [f.scope.tenantId, attemptId],
        ),
    );
    expect(unknownRollback.rows[0]).toEqual({ state: "started", claim_token: unknownClaim.token });
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state='closing' WHERE tenant_id=$1 AND registry_id=$2`,
        [f.scope.tenantId, unknownClaim.registryId],
      ),
    );
    expect(await left.unknown(unknownClaim)).toBe(true);
    const unknownRegistry = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ state: string }>(
          `SELECT state FROM sandbox_registry WHERE tenant_id=$1 AND registry_id=$2`,
          [f.scope.tenantId, unknownClaim.registryId],
        ),
    );
    expect(unknownRegistry.rows[0]?.state).toBe("unknown");
    // Runtime 连接也受 FORCE RLS 约束：即使猜中同一个 registry id，错误 Tenant 直接 SELECT
    // 仍不可见；不能只依赖 claimNext 的 tenant_id 参数作为隔离证明。
    const otherTenant = tenantId("other-cleanup-tenant");
    const hiddenRegistry = await withTenantTransaction(
      runtime,
      { tenantId: otherTenant },
      (client) =>
        client.query<{ registry_id: string }>(
          `SELECT registry_id FROM sandbox_registry WHERE registry_id=$1`,
          [unknownClaim.registryId],
        ),
    );
    expect(hiddenRegistry.rowCount).toBe(0);
    // 明确 Tenant scope 下，其他 Tenant 不能看到或领取此事实。
    expect(
      await left.claimNext({
        tenantId: otherTenant,
        workerId: "cleanup-other",
        leaseMs: 210_000,
      }),
    ).toBeUndefined();
  });

  it("Cleanup 在数据库时钟的短租约边界与 heartbeat 交错后不领取", async () => {
    const f = await fixture(`cleanup-heartbeat-edge-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "cleanup-heartbeat-seed",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("短租约 Cleanup fixture 未能取得 Attempt");
    const attemptId = claimed.snapshot.attempt.attemptId;
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO sandbox_registry(tenant_id,registry_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,provider_sandbox_id,request_id,state,actual_ttl_seconds)
         VALUES ($1,'cleanup-heartbeat-registry',$2,$3,$4,$5,$6,'cleanup-heartbeat-sandbox','cleanup-heartbeat-request','ready',120)`,
        [
          f.scope.tenantId,
          attemptId,
          f.scope.runId,
          f.scope.threadId,
          f.scope.workspaceId,
          f.scope.rootRunId,
        ],
      );
      await client.query(
        `INSERT INTO cleanup_outbox(tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,state,armed,identity_digest,payload,payload_digest)
         VALUES ($1,$2,'cleanup-heartbeat-key','cleanup-heartbeat-registry','cleanup-heartbeat-sandbox','pending',true,$3,$4::jsonb,$5)`,
        [
          f.scope.tenantId,
          attemptId,
          "1".repeat(64),
          JSON.stringify({ schemaVersion: 1 }),
          "2".repeat(64),
        ],
      );
    });
    // 不使用 claim 的默认 30 秒租约：以 PostgreSQL 时钟收紧至 250ms，之后跨过“旧租约”边界。
    const edge = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => {
        const claimExpiry = await client.query<{ expires_at: Date }>(
          `UPDATE run_claims SET expires_at=clock_timestamp()+interval '250 milliseconds'
            WHERE tenant_id=$1 AND attempt_id=$2 RETURNING expires_at`,
          [f.scope.tenantId, attemptId],
        );
        await client.query(
          `UPDATE workspace_write_leases SET expires_at=$3
            WHERE tenant_id=$1 AND workspace_id=$2`,
          [f.scope.tenantId, f.scope.workspaceId, claimExpiry.rows[0]?.expires_at],
        );
        const expiresAt = claimExpiry.rows[0]?.expires_at;
        if (expiresAt === undefined) throw new Error("短租约边界未写入");
        return expiresAt;
      },
    );
    const blocker = await runtime.connect();
    let blockerCommitted = false;
    try {
      // 第三条连接只承担 barrier：它先锁住 run claim，使 heartbeat 与 Cleanup 必须按
      // attempt → run claim → workspace lease 的既定顺序交错，避免把普通 active 路径冒充竞态。
      await blocker.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await blocker.query("SELECT set_config('app.tenant_id',$1,true)", [f.scope.tenantId]);
      await blocker.query(
        `SELECT 1 FROM run_claims WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE`,
        [f.scope.tenantId, attemptId],
      );
      const heartbeat = persistence.inspectAndRenew({
        fence: claimed.fence,
        leaseDurationMs: 30_000,
      });
      const cleanupDuringBarrier = new PgSandboxCleanupConsumerStore(runtime).claimNext({
        tenantId: f.scope.tenantId,
        workerId: "cleanup-heartbeat-worker",
        leaseMs: 210_000,
      });
      // 给两条业务连接进入各自的锁等待点；时钟仍远早于 250ms 短租约到期。
      await blocker.query("SELECT pg_sleep(0.03)");
      await blocker.query("COMMIT");
      blockerCommitted = true;
      const [renewed, duringBarrier] = await Promise.all([heartbeat, cleanupDuringBarrier]);
      expect(renewed.outcome).toBe("active");
      expect(duringBarrier).toBeUndefined();
    } finally {
      if (!blockerCommitted) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    // 以数据库时钟等待旧短租约真正到期。若 heartbeat 没有胜出，这里会成为 Cleanup 候选。
    const afterEdge = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) =>
        client.query<{ database_now: Date }>(
          `SELECT clock_timestamp() AS database_now
             FROM pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+0.01))`,
          [edge],
        ),
    );
    expect(afterEdge.rows[0]?.database_now.getTime()).toBeGreaterThan(
      Date.parse(edge.toISOString()),
    );
    expect(
      await new PgSandboxCleanupConsumerStore(runtime).claimNext({
        tenantId: f.scope.tenantId,
        workerId: "cleanup-heartbeat-worker",
        leaseMs: 210_000,
      }),
    ).toBeUndefined();
  });

  it("0007 可回退至 0004 并重新授予最小 Dispatch ACL", async () => {
    const down = await migrateDown(migrator, {
      runtimeRole,
      migratorRole,
      schema,
      targetVersion: 4,
      allowDestructive: true,
      environment: "test",
    });
    expect(down.at(-1)?.version).toBe(4);
    const restored = await migrateUp(migrator, { runtimeRole, migratorRole, schema });
    expect(restored.at(-1)?.version).toBe(7);
    const acl = await admin.query<{
      readonly select_allowed: boolean;
      readonly update_allowed: boolean;
    }>(
      `SELECT has_table_privilege($1::text, format('%I.api_idempotency_records', $2::text), 'SELECT') AS select_allowed,
              has_table_privilege($1::text, format('%I.api_idempotency_records', $2::text), 'UPDATE') AS update_allowed`,
      [runtimeRole, schema],
    );
    expect(acl.rows[0]).toEqual({ select_allowed: true, update_allowed: false });
  });
});
