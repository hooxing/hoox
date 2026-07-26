import { randomBytes } from "node:crypto";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
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
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

const enabled = process.env.RUN_PG_RUN_WORKER_INTEGRATION === "true";
const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL ?? "";
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_rw_${suffix}`;
const runtimeRole = `it_rw_rt_${suffix}`;
const migratorRole = `it_rw_mg_${suffix}`;
const runtimePassword = randomBytes(24).toString("hex");
const migratorPassword = randomBytes(24).toString("hex");
let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repositories!: PgCoreRepositories;
let setup!: PgRunExecutionSetup;
let persistence!: PgExecutionPersistence;
let runDispatchCreation!: PgRunDispatchCreation;
let runDispatchOutbox!: PgRunDispatchOutbox;
let databaseName = "";

interface Fixture {
  readonly scope: ExecutionScope;
  readonly user: ReturnType<typeof createUser>;
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
  return { scope, user };
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
function withLostCommitResponse(upstream: Pool): Pool {
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
        if (sql.trim().toUpperCase() === "COMMIT") {
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
    admin = createPostgresPool({ connectionString: bootstrapUrl, maxConnections: 2 });
    databaseName = new URL(bootstrapUrl).pathname.slice(1);
    await admin.query(
      `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       GRANT CONNECT ON DATABASE "${databaseName}" TO "${runtimeRole}", "${migratorRole}";
       CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
    );
    const migratorUrl = new URL(bootstrapUrl);
    migratorUrl.username = migratorRole;
    migratorUrl.password = migratorPassword;
    const runtimeUrl = new URL(bootstrapUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    migrator = createPostgresPool({ connectionString: migratorUrl.toString(), schema });
    runtime = createPostgresPool({ connectionString: runtimeUrl.toString(), schema });
    await migrateUp(migrator, { runtimeRole, migratorRole, schema });
    const dispatchAcl = await admin.query<{ readonly allowed: boolean; readonly version: number }>(
      `SELECT has_table_privilege($1::text, format('%I.api_idempotency_records', $2::text), 'SELECT') AS allowed,
              (SELECT max(version) FROM "${schema}".runtime_schema_migrations)::int AS version`,
      [runtimeRole, schema],
    );
    expect(dispatchAcl.rows[0]).toEqual({ allowed: true, version: 5 });
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
    if (!schema.startsWith("it_rw_")) throw new Error("拒绝清理非测试 Schema");
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
});
