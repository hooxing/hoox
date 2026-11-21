import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createPersonalTenant,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  isoTimestamp,
  membershipId,
  resourceId,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  transitionRun,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "@hoox/domain";
import type {
  ControlledRolloutProjection,
  ExecutionScope,
  RuntimeMutation,
  RuntimeOutboxV1,
  SandboxSessionRegistryPort,
  ThreadSandboxProviderPort,
} from "@hoox/run-contracts";
import { assertProtocolSize } from "@hoox/run-contracts";
import {
  digestCanonical,
  outboxPayloadDigest,
  runtimeMutationDigest,
} from "@hoox/run-contracts/mutation-protocol";
import { FakeSandboxGateway } from "@hoox/sandbox/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PiWorkerSessionFactory } from "../../runtime-ts/apps/agent-worker/src/pi-session-factory.js";
import { RunWorker } from "../../runtime-ts/apps/agent-worker/src/run-worker.js";
import {
  FakeCancellationPort,
  FakeClock,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
} from "../../runtime-ts/apps/agent-worker/src/testing/fakes.js";
import { performWorkerMaintenance } from "../../runtime-ts/apps/agent-worker/src/worker-maintenance.js";
import { createApiApp } from "../../runtime-ts/apps/api/src/app.js";
import { createApiCreateCapability } from "../../runtime-ts/apps/api/src/capabilities.js";
import { createThreadCursorCodec } from "../../runtime-ts/apps/api/src/cursor.js";
import { createDevelopmentAuthResolver } from "../../runtime-ts/apps/api/src/development-auth.js";
import { RunDispatchScheduler } from "../../runtime-ts/apps/scheduler/src/run-dispatch.js";
import {
  CubeSandboxCleanupResolver,
  SandboxCleanupConsumer,
} from "../../runtime-ts/apps/scheduler/src/sandbox-cleanup-consumer.js";
import {
  AdminControlService,
  digestControlRequest,
} from "../../runtime-ts/packages/admin-control/src/index.js";
import { MemoryIngestionConsumer } from "../../runtime-ts/packages/memory/src/index.js";
import type { BlobStore } from "../../runtime-ts/packages/persistence/src/blob-store.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { ModelProviderCredentialCipher } from "../../runtime-ts/packages/persistence/src/model-provider-credential.js";
import { PgAdminControlRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
import {
  PgArchiveThreadCommand,
  PgCoreRepositories,
  PgRenamePersonalThreadCommand,
} from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import { PgMemoryIngestionStore } from "../../runtime-ts/packages/persistence/src/pg-memory-ingestion.js";
import { PgScheduledTaskRepository } from "../../runtime-ts/packages/persistence/src/pg-scheduled-tasks.js";
import { PgResourceCatalog } from "../../runtime-ts/packages/persistence/src/pg-resource-library.js";
import {
  PgRunDispatchCreation,
  PgRunDispatchOutbox,
} from "../../runtime-ts/packages/persistence/src/pg-run-dispatch.js";
import {
  PgRunEventWakeListener,
  RUN_EVENT_WAKE_CHANNEL,
  runEventWakeKey,
} from "../../runtime-ts/packages/persistence/src/pg-run-event-wake.js";
import {
  PgBackedSandboxSessionRegistry,
  PgExecutionPersistence,
  PgRunExecutionSetup,
} from "../../runtime-ts/packages/persistence/src/pg-run-worker-state.js";
import { PgSandboxCleanupConsumerStore } from "../../runtime-ts/packages/persistence/src/pg-sandbox-cleanup-consumer.js";
import { PgSkillRuntimeRepository } from "../../runtime-ts/packages/persistence/src/pg-skill-runtime.js";
import { PgThreadCreation } from "../../runtime-ts/packages/persistence/src/pg-thread-creation.js";
import { PgThreadInputRouting } from "../../runtime-ts/packages/persistence/src/pg-thread-input.js";
import { PgThreadSandboxLifecycleConsumerStore } from "../../runtime-ts/packages/persistence/src/pg-thread-sandbox-lifecycle-consumer.js";
import {
  PgWebhookRepository,
  PgWebhookOutboxStore,
  type WebhookEventType,
} from "../../runtime-ts/packages/persistence/src/pg-webhooks.js";
import { PgWorkerTenantAssignments } from "../../runtime-ts/packages/persistence/src/pg-worker-tenant-assignment.js";
import {
  PgWorkspaceCandidateHandoff,
  workspaceCandidateOperationDigest,
} from "../../runtime-ts/packages/persistence/src/pg-workspace-candidate.js";
import {
  PgWorkspaceManifestRepository,
  PgWorkspaceStableBlobAccess,
} from "../../runtime-ts/packages/persistence/src/pg-workspace-manifest.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
  withTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { PgRunExperienceReadRepository } from "../../runtime-ts/packages/persistence/src/runtime.js";
import { PgThreadContextHistoryRepository } from "../../runtime-ts/packages/persistence/src/thread-context.js";
import { PgThreadSandboxSessionLifecycle } from "../../runtime-ts/packages/persistence/src/thread-sandbox-session.js";
import { createWorkspaceManifest } from "../../runtime-ts/packages/workspace/src/manifest.js";
import {
  loadPostgreSqlMigrationContract,
  type PostgreSqlMigrationContract,
} from "./postgres-migration-contract.js";

const enabled = process.env.RUN_PG_RUN_WORKER_INTEGRATION === "true";
const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL ?? "";
const preprovisionedDatabase = process.env.M4_PREPROVISIONED_DATABASE === "true";
const adminUrl = preprovisionedDatabase ? (process.env.M4_DATABASE_ADMIN_URL ?? "") : bootstrapUrl;
const configuredRuntimeUrl = process.env.DATABASE_URL ?? "";
const configuredWorkerCoordinatorUrl = process.env.DATABASE_WORKER_COORDINATOR_URL ?? "";
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const schema = preprovisionedDatabase ? (process.env.DATABASE_SCHEMA ?? "") : `it_rw_${suffix}`;
const runtimeRole = preprovisionedDatabase
  ? (process.env.DATABASE_RUNTIME_ROLE ?? "")
  : `it_rw_rt_${suffix}`;
const migratorRole = preprovisionedDatabase
  ? (process.env.DATABASE_MIGRATOR_ROLE ?? "")
  : `it_rw_mg_${suffix}`;
const skillPublisherRole = preprovisionedDatabase
  ? (process.env.DATABASE_SKILL_PUBLISHER_ROLE ?? "")
  : `it_rw_pub_${suffix}`;
const workerCoordinatorRole = preprovisionedDatabase
  ? (process.env.DATABASE_WORKER_COORDINATOR_ROLE ?? "")
  : `it_rw_coord_${suffix}`;
const teamCoordinatorRole = preprovisionedDatabase
  ? (process.env.DATABASE_TEAM_COORDINATOR_ROLE ?? "")
  : `it_rw_team_${suffix}`;
const adminControlRole = preprovisionedDatabase
  ? (process.env.DATABASE_ADMIN_CONTROL_ROLE ?? "")
  : `it_rw_control_${suffix}`;
const webhookDispatcherRole = preprovisionedDatabase
  ? (process.env.DATABASE_WEBHOOK_DISPATCHER_ROLE ?? "")
  : `it_rw_webhook_${suffix}`;
const runtimePassword = randomBytes(24).toString("hex");
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const adminControlPassword = randomBytes(24).toString("hex");
const safePgIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;
let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let workerCoordinator!: Pool;
let runtimeConnectionString = "";
let repositories!: PgCoreRepositories;
let setup!: PgRunExecutionSetup;
let persistence!: PgExecutionPersistence;
let runDispatchCreation!: PgRunDispatchCreation;
let runDispatchOutbox!: PgRunDispatchOutbox;
let workerTenantAssignments!: PgWorkerTenantAssignments;
let migrationContract!: PostgreSqlMigrationContract;
let databaseName = "";

interface Fixture {
  readonly scope: ExecutionScope;
  readonly user: ReturnType<typeof createUser>;
  readonly thread: ReturnType<typeof createThread>;
  readonly workspace: ReturnType<typeof createWorkspace>;
}

interface SerialQueueFixture {
  readonly tenantScope: {
    readonly tenantId: ReturnType<typeof tenantId>;
    readonly userId: ReturnType<typeof userId>;
  };
  readonly user: ReturnType<typeof createUser>;
  readonly thread: ReturnType<typeof createThread>;
  readonly workspace: ReturnType<typeof createWorkspace>;
}

async function serialQueueFixture(label: string): Promise<SerialQueueFixture> {
  const now = isoTimestamp("2099-07-26T00:00:00.000Z");
  const user = createUser(userId(`serial-user-${label}`), now);
  const personal = createPersonalTenant({
    id: tenantId(`serial-tenant-${label}`),
    ownerMembershipId: membershipId(`serial-member-${label}`),
    owner: user,
    createdAt: now,
  });
  const tenantScope = { tenantId: personal.tenant.id, userId: user.id } as const;
  expect(
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    }),
  ).toEqual({ outcome: "created" });
  const thread = createThread({
    id: threadId(`serial-thread-${label}`),
    tenant: personal.tenant,
    user,
    membership: personal.ownerMembership,
    title: "Thread 串行队列集成测试",
    now,
  });
  expect(await repositories.threads.create(tenantScope, thread)).toMatchObject({
    outcome: "created",
  });
  const workspace = createWorkspace({
    id: workspaceId(`serial-workspace-${label}`),
    thread,
    now,
  });
  expect(await repositories.workspaces.create(tenantScope, workspace)).toEqual({
    outcome: "created",
  });
  return { tenantScope, user, thread, workspace };
}

function requestDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

let fakeThreadSandboxProviderSequence = 0;

function fakeThreadSandboxProvider(
  gateway: FakeSandboxGateway,
  resourceFilesystemRequirements?: boolean[],
): ThreadSandboxProviderPort {
  const providerPrefix = `thread-provider-${process.pid}-${++fakeThreadSandboxProviderSequence}`;
  return {
    defaultProviderKey: "cube",
    create: async (input) => {
      resourceFilesystemRequirements?.push(input.requiresResourceFilesystem);
      const sandbox = await gateway.create(
        {
          templateId: "thread-session-integration",
          ttlSeconds: 120,
          lifecycle: { onTimeout: "pause", autoResume: true },
        },
        { signal: input.signal },
      );
      const providerSandboxId = `${providerPrefix}-${sandbox.id}`;
      // Fake gateway 每个实例都会从 fake-1 起号，而 Provider capability 在数据库中全局唯一。
      // 以进程内 provider 身份加前缀，避免不同测试 gateway 伪造同一个远端 Sandbox。
      gateway.sandboxes.set(providerSandboxId, sandbox);
      gateway.sandboxes.delete(sandbox.id);
      return {
        outcome: "ready",
        session: {
          registryId: input.registryId,
          providerKey: "cube",
          providerSandboxId,
          mode: "created",
          sandbox,
        },
      };
    },
    connect: async (input) => {
      try {
        const sandbox = await gateway.connect(input.providerSandboxId, {
          signal: input.signal,
        });
        return {
          outcome: "ready",
          session: {
            registryId: input.registryId,
            providerKey: "cube",
            providerSandboxId: input.providerSandboxId,
            mode: "connected",
            sandbox,
          },
        };
      } catch {
        return { outcome: "not_found" };
      }
    },
    settle: async (input) => {
      if (input.disposition === "pause") await input.session.sandbox.pause();
      else await input.session.sandbox.kill({ ignoreNotFound: true });
      return { outcome: "settled" };
    },
  };
}

async function fixture(
  label: string,
  rolloutProjection: ControlledRolloutProjection = {
    schemaVersion: 2,
    checkpointId: `cp-${label}`,
    items: [],
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

/** 为夹具 Tenant 注册订阅；密文为占位值，本套件只验证入队事实，不实际投递。 */
async function subscribeWebhook(f: Fixture, eventTypes: readonly WebhookEventType[]) {
  await new PgWebhookRepository(runtime).create({
    scope: { tenantId: f.scope.tenantId, userId: f.user.id },
    name: "integration",
    endpointUrl: "https://hooks.example.invalid/run-worker",
    eventTypes,
    secret: { version: 1, nonce: "n", ciphertext: "c", authTag: "t" },
  });
}

async function webhookOutbox(f: Fixture) {
  const result = await admin.query<{
    readonly event_type: string;
    readonly payload: { readonly data: Record<string, unknown> };
  }>(
    `SELECT event_type,payload FROM "${schema}".webhook_outbox WHERE tenant_id=$1 ORDER BY event_type`,
    [f.scope.tenantId],
  );
  return result.rows;
}

/** 用真实 PostgreSQL 的 jsonb::text 计算边界，避免测试复制一套不等价序列化规则。 */
async function projectionAtStoredBytes(targetBytes: number) {
  // 用多个合法 turn 填充字节：checkpoint 受 200 字节限制，单个 turn 受 16KiB 限制。
  const empty = {
    schemaVersion: 2 as const,
    checkpointId: "projection-boundary",
    items: Array.from({ length: 5 }, () => ({
      kind: "turn" as const,
      role: "user" as const,
      text: "",
    })),
  };
  const measured = await migrator.query<{ bytes: number }>(
    "SELECT octet_length($1::jsonb::text) AS bytes",
    [JSON.stringify(empty)],
  );
  const baseBytes = Number(measured.rows[0]?.bytes);
  let remaining = targetBytes - baseBytes;
  const items = empty.items.map((turn, index) => {
    const slots = empty.items.length - index;
    const bytes = Math.min(16 * 1024, Math.floor(remaining / slots));
    remaining -= bytes;
    return { ...turn, text: "x".repeat(bytes) };
  });
  if (remaining !== 0) throw new Error("无法构造受控 Projection 边界");
  const projection = { ...empty, items };
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

function withOneSerializationFailure(
  upstream: Pool,
  statementFragment: string,
): { readonly pool: Pool; readonly rejectionCount: () => number } {
  let rejected = false;
  let rejectionCount = 0;
  const pool = {
    connect: async () => {
      const client = await upstream.connect();
      const originalQuery = client.query.bind(client) as (
        ...args: readonly unknown[]
      ) => Promise<unknown>;
      client.query = (async (...args: readonly unknown[]) => {
        const first = args[0];
        const sql =
          typeof first === "string"
            ? first
            : typeof first === "object" && first !== null && "text" in first
              ? String(first.text)
              : "";
        if (!rejected && sql.includes(statementFragment)) {
          rejected = true;
          rejectionCount += 1;
          throw Object.assign(new Error("模拟 SERIALIZABLE 事务被数据库明确回滚"), {
            code: "40001",
          });
        }
        return await originalQuery(...args);
      }) as typeof client.query;
      return client;
    },
  } as unknown as Pool;
  return { pool, rejectionCount: () => rejectionCount };
}

function withOneTransientStatementFailure(
  upstream: Pool,
  statementFragment: string,
): { readonly pool: Pool; readonly rejectionCount: () => number } {
  let rejected = false;
  let rejectionCount = 0;
  const pool = {
    connect: async () => {
      const client = await upstream.connect();
      const originalQuery = client.query.bind(client) as (
        ...args: readonly unknown[]
      ) => Promise<unknown>;
      client.query = (async (...args: readonly unknown[]) => {
        const first = args[0];
        const sql =
          typeof first === "string"
            ? first
            : typeof first === "object" && first !== null && "text" in first
              ? String(first.text)
              : "";
        if (!rejected && sql.includes(statementFragment)) {
          rejected = true;
          rejectionCount += 1;
          throw Object.assign(new Error("模拟许可消费连接被重置"), { code: "ECONNRESET" });
        }
        return await originalQuery(...args);
      }) as typeof client.query;
      return client;
    },
  } as unknown as Pool;
  return { pool, rejectionCount: () => rejectionCount };
}

describe.runIf(enabled)("PostgreSQL Run Worker 状态与并发契约", () => {
  beforeAll(async () => {
    migrationContract = await loadPostgreSqlMigrationContract();
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
       CREATE ROLE "${skillPublisherRole}" LOGIN PASSWORD '${skillPublisherPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${workerCoordinatorRole}" LOGIN PASSWORD '${workerCoordinatorPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${teamCoordinatorRole}" LOGIN PASSWORD '${teamCoordinatorPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${adminControlRole}" LOGIN PASSWORD '${adminControlPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${webhookDispatcherRole}" LOGIN PASSWORD '${adminControlPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       GRANT CONNECT ON DATABASE "${databaseName}"
         TO "${runtimeRole}", "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}", "${webhookDispatcherRole}";
       CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
      );
    }
    const migratorUrl = new URL(bootstrapUrl);
    const runtimeUrl = new URL(preprovisionedDatabase ? configuredRuntimeUrl : bootstrapUrl);
    const workerCoordinatorUrl = new URL(
      preprovisionedDatabase ? configuredWorkerCoordinatorUrl : bootstrapUrl,
    );
    if (preprovisionedDatabase) {
      if (
        !schema.startsWith("m4_ci_") ||
        !runtimeRole.startsWith("m4_ci_") ||
        !migratorRole.startsWith("m4_ci_") ||
        !skillPublisherRole.startsWith("m4_ci_") ||
        !workerCoordinatorRole.startsWith("m4_ci_") ||
        !teamCoordinatorRole.startsWith("m4_ci_") ||
        !adminControlRole.startsWith("m4_ci_") ||
        !webhookDispatcherRole.startsWith("m4_ci_") ||
        !safePgIdentifier.test(schema) ||
        !safePgIdentifier.test(runtimeRole) ||
        !safePgIdentifier.test(migratorRole) ||
        !safePgIdentifier.test(skillPublisherRole) ||
        !safePgIdentifier.test(workerCoordinatorRole) ||
        !safePgIdentifier.test(teamCoordinatorRole) ||
        !safePgIdentifier.test(adminControlRole) ||
        !safePgIdentifier.test(webhookDispatcherRole) ||
        migratorUrl.username !== migratorRole ||
        runtimeUrl.username !== runtimeRole ||
        workerCoordinatorUrl.username !== workerCoordinatorRole ||
        schema.length === 0
      ) {
        throw new Error("M4 预置数据库角色、连接或 Schema 配置不一致");
      }
    } else {
      migratorUrl.username = migratorRole;
      migratorUrl.password = migratorPassword;
      runtimeUrl.username = runtimeRole;
      runtimeUrl.password = runtimePassword;
      workerCoordinatorUrl.username = workerCoordinatorRole;
      workerCoordinatorUrl.password = workerCoordinatorPassword;
    }
    runtimeConnectionString = runtimeUrl.toString();
    migrator = createPostgresPool({ connectionString: migratorUrl.toString(), schema });
    // 与生产 Worker 一致开启预备语句缓存，让整套黑盒在真实 PostgreSQL 上覆盖计划复用路径。
    runtime = createPostgresPool({
      connectionString: runtimeConnectionString,
      schema,
      preparedStatements: true,
    });
    workerCoordinator = createPostgresPool({
      connectionString: workerCoordinatorUrl.toString(),
      schema,
    });
    await migrateUp(migrator, {
      runtimeRole,
      migratorRole,
      skillPublisherRole,
      workerCoordinatorRole,
      teamCoordinatorRole,
      adminControlRole,
      webhookDispatcherRole,
      schema,
    });
    const dispatchAcl = await admin.query<{ readonly allowed: boolean; readonly version: number }>(
      `SELECT has_table_privilege($1::text, format('%I.api_idempotency_records', $2::text), 'SELECT') AS allowed,
              (SELECT max(version) FROM "${schema}".runtime_schema_migrations)::int AS version`,
      [runtimeRole, schema],
    );
    // Thread 创建 0007 在 Cleanup 0006 后叠加，既有 Dispatch ACL 仍须存在。
    expect(dispatchAcl.rows[0]).toEqual({
      allowed: true,
      version: migrationContract.latestVersion,
    });
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
    workerTenantAssignments = new PgWorkerTenantAssignments({
      runtime,
      coordinator: workerCoordinator,
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await workerCoordinator?.end();
    await migrator?.end();
    if (preprovisionedDatabase) {
      // 预置角色属于整个 CI 集群；本套件只清理约定的 M4 Schema，保留所有角色与 CONNECT。
      if (schema !== "m4_ci_runtime_schema") throw new Error("拒绝清理非 M4 测试 Schema");
      await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } else {
      const roles = [
        runtimeRole,
        migratorRole,
        skillPublisherRole,
        workerCoordinatorRole,
        teamCoordinatorRole,
        adminControlRole,
        webhookDispatcherRole,
      ];
      if (
        schema !== `it_rw_${suffix}` ||
        !roles.every((role) => role.startsWith("it_rw_") && role.endsWith(suffix))
      )
        throw new Error("拒绝清理非本测试角色");
      await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;
        REVOKE CONNECT ON DATABASE "${databaseName}" FROM ${roles.map((role) => `"${role}"`).join(",")};
        DROP ROLE ${roles.map((role) => `"${role}"`).join(",")}`);
    }
    await admin?.end();
  });

  it("Playground Run 在执行与 PostgreSQL 写入边界都不能暂停正式定时任务", async () => {
    const f = await fixture(`playground-automation-${suffix}`);
    const repository = new PgScheduledTaskRepository(runtime);
    const task = await repository.mutate({
      scope: { tenantId: f.scope.tenantId, userId: f.user.id },
      commandId: `normal-task-${suffix}`,
      requestDigest: createHash("sha256")
        .update(
          JSON.stringify({
            action: "create",
            sourceThreadId: f.thread.id,
            targetThreadId: f.thread.id,
            name: "正式任务",
            instruction: "保持正式任务不变",
            firstRunAt: "2099-07-27T00:00:00.000Z",
            timezone: "UTC",
          }),
        )
        .digest("hex"),
      mutation: {
        action: "create",
        sourceThreadId: f.thread.id,
        targetThreadId: f.thread.id,
        name: "正式任务",
        instruction: "保持正式任务不变",
        firstRunAt: "2099-07-27T00:00:00.000Z",
        timezone: "UTC",
      },
    });
    expect(task.outcome).toBe("applied");
    if (task.outcome !== "applied") throw new Error("未创建正式定时任务");
    await admin.query(
      `UPDATE "${schema}".runs SET origin='playground',status='running'
        WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, f.scope.runId],
    );
    const mutation = { action: "pause" as const, taskId: task.task.id };
    expect(
      await repository.mutateFromRun({
        tenantId: f.scope.tenantId,
        threadId: f.scope.threadId,
        runId: f.scope.runId,
        commandId: `playground-pause-${suffix}`,
        mutation,
      }),
    ).toEqual({ outcome: "not_authorized" });
    expect(
      await repository.mutate({
        scope: { tenantId: f.scope.tenantId, userId: f.user.id },
        commandId: `direct-playground-pause-${suffix}`,
        requestDigest: createHash("sha256").update(JSON.stringify(mutation)).digest("hex"),
        mutation,
        createdByRunId: f.scope.runId,
      }),
    ).toEqual({ outcome: "not_authorized" });
    const persisted = await admin.query<{ readonly status: string }>(
      `SELECT status FROM "${schema}".scheduled_tasks WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, task.task.id],
    );
    expect(persisted.rows[0]?.status).toBe("active");
  });

  it("Webhook 领取与发送许可边界跳过 Playground Outbox 且不停用订阅", async () => {
    const f = await fixture(`playground-webhook-${suffix}`);
    await admin.query(
      `UPDATE "${schema}".runs SET origin='playground',status='running'
        WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, f.scope.runId],
    );
    const subscription = await new PgWebhookRepository(runtime).create({
      scope: { tenantId: f.scope.tenantId, userId: f.user.id },
      name: "Playground 防护测试",
      endpointUrl: "https://hooks.example.invalid/playground",
      eventTypes: ["run.failed"],
      secret: { version: 1, nonce: "n", ciphertext: "c", authTag: "t" },
    });
    const suffixId = `playground-${suffix}`;
    await admin.query(
      `INSERT INTO "${schema}".webhook_outbox(
         tenant_id,id,webhook_id,event_id,event_type,payload,source_run_id,source_run_origin
       ) VALUES($1,$2,$3,$4,'run.failed',$5::jsonb,$6,'playground')`,
      [
        f.scope.tenantId,
        `delivery-${suffixId}`,
        subscription.id,
        `event-${suffixId}`,
        JSON.stringify({ type: "run.failed", data: { runId: f.scope.runId } }),
        f.scope.runId,
      ],
    );
    const webhookStorePool = createPostgresPool({ connectionString: adminUrl, schema });
    const store = new PgWebhookOutboxStore(webhookStorePool);
    await admin.query(
      `INSERT INTO "${schema}".webhook_outbox(
         tenant_id,id,webhook_id,event_id,event_type,payload,source_run_origin
       ) VALUES($1,$2,$3,$4,'run.failed',$5::jsonb,'unknown')`,
      [
        f.scope.tenantId,
        `delivery-unknown-${suffixId}`,
        subscription.id,
        `event-unknown-${suffixId}`,
        JSON.stringify({ type: "run.failed", data: { runId: "unresolved" } }),
      ],
    );
    expect(await store.claim({ owner: `claim-${suffixId}` })).toBeUndefined();
    const settled = await admin.query<{ readonly state: string; readonly last_error_code: string }>(
      `SELECT state,last_error_code FROM "${schema}".webhook_outbox
        WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, `delivery-${suffixId}`],
    );
    expect(settled.rows[0]).toEqual({ state: "disabled", last_error_code: "playground_source" });
    const unresolved = await admin.query<{
      readonly state: string;
      readonly last_error_code: string | null;
    }>(
      `SELECT state,last_error_code FROM "${schema}".webhook_outbox
        WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, `delivery-unknown-${suffixId}`],
    );
    expect(unresolved.rows[0]).toEqual({ state: "pending", last_error_code: null });

    const unknownPermitId = `delivery-unknown-permit-${suffixId}`;
    const unknownToken = `unknown-claim-${suffixId}`;
    await admin.query(
      `INSERT INTO "${schema}".webhook_outbox(
         tenant_id,id,webhook_id,event_id,event_type,payload,state,claim_token,claim_expires_at,source_run_origin
       ) VALUES($1,$2,$3,$4,'run.failed',$5::jsonb,'claimed',$6,clock_timestamp()+interval '1 minute','unknown')`,
      [
        f.scope.tenantId,
        unknownPermitId,
        subscription.id,
        `event-unknown-permit-${suffixId}`,
        JSON.stringify({ type: "run.failed", data: { runId: "unresolved" } }),
        unknownToken,
      ],
    );
    expect(
      await store.permitSend(
        {
          tenantId: f.scope.tenantId,
          id: unknownPermitId,
          webhookId: subscription.id,
          eventId: `event-unknown-permit-${suffixId}`,
          endpointUrl: "https://hooks.example.invalid/playground",
          payload: {},
          attempts: 1,
          claimToken: unknownToken,
        },
        100,
      ),
    ).toEqual({ outcome: "skip" });
    const unresolvedPermit = await admin.query<{
      readonly state: string;
      readonly last_error_code: string | null;
    }>(
      `SELECT state,last_error_code FROM "${schema}".webhook_outbox
        WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, unknownPermitId],
    );
    expect(unresolvedPermit.rows[0]).toEqual({ state: "claimed", last_error_code: null });

    const permitId = `delivery-permit-${suffixId}`;
    const token = `legacy-claim-${suffixId}`;
    await admin.query(
      `INSERT INTO "${schema}".webhook_outbox(
         tenant_id,id,webhook_id,event_id,event_type,payload,state,claim_token,claim_expires_at,
         source_run_id,source_run_origin
       ) VALUES($1,$2,$3,$4,'run.failed',$5::jsonb,'claimed',$6,clock_timestamp()+interval '1 minute',$7,'playground')`,
      [
        f.scope.tenantId,
        permitId,
        subscription.id,
        `event-permit-${suffixId}`,
        JSON.stringify({ type: "run.failed", data: { runId: f.scope.runId } }),
        token,
        f.scope.runId,
      ],
    );
    expect(
      await store.permitSend(
        {
          tenantId: f.scope.tenantId,
          id: permitId,
          webhookId: subscription.id,
          eventId: `event-permit-${suffixId}`,
          endpointUrl: "https://hooks.example.invalid/playground",
          payload: {},
          attempts: 1,
          claimToken: token,
        },
        100,
      ),
    ).toEqual({ outcome: "skip" });
    const result = await admin.query<{ readonly state: string; readonly last_error_code: string }>(
      `SELECT state,last_error_code FROM "${schema}".webhook_outbox
        WHERE tenant_id=$1 AND id=$2`,
      [f.scope.tenantId, permitId],
    );
    expect(result.rows[0]).toEqual({ state: "disabled", last_error_code: "playground_source" });
    expect(
      (
        await new PgWebhookRepository(runtime).list({
          tenantId: f.scope.tenantId,
          userId: f.user.id,
        })
      ).find(({ id }) => id === subscription.id)?.disabledAt,
    ).toBeUndefined();
    await webhookStorePool.end();
  });

  it("受限控制角色保存工具模式、恢复历史配置并拒绝非法直写", async () => {
    // 全局 generation 与运行设置不能影响同套件的 Worker 和历史迁移回退用例。
    const isolatedSchema = `it_rw_tool_mode_${suffix}`;
    if (!safePgIdentifier.test(isolatedSchema)) throw new Error("工具模式测试 Schema 名称无效");
    // 迁移角色只能拥有一个 Schema，隔离用例不能复用主套件的迁移角色。
    const isolatedMigratorRole = `it_rw_tool_mg_${suffix}`;
    if (!safePgIdentifier.test(isolatedMigratorRole) || !safePgIdentifier.test(databaseName)) {
      throw new Error("工具模式测试迁移角色或数据库名称无效");
    }
    const isolatedMigratorPassword = randomBytes(24).toString("hex");
    const migrationUrl = new URL(bootstrapUrl);
    migrationUrl.username = isolatedMigratorRole;
    migrationUrl.password = isolatedMigratorPassword;
    let isolatedDatabasePrepared = false;
    // CI 未公开控制角色密码；仅用管理连接建立会话，所有业务 SQL 均以受限角色执行。
    const controlUrl = new URL(adminUrl);
    controlUrl.searchParams.set(
      "options",
      `-c role=${adminControlRole} -c search_path=${isolatedSchema}`,
    );
    const isolatedMigrator = createPostgresPool({
      connectionString: migrationUrl.toString(),
      schema: isolatedSchema,
      maxConnections: 2,
    });
    const control = createPostgresPool({
      connectionString: controlUrl.toString(),
      maxConnections: 4,
    });
    const actorUserId = `tool-mode-admin-${suffix}`;
    const historicalConfiguration = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 50,
      compactionRecentUserTokens: 2048,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 30_000,
    };
    const context = (action: string) => ({
      actorUserId,
      idempotencyKey: `tool-mode-${action}-${suffix}`,
      requestDigest: requestDigest(action),
    });
    const cipher = new ModelProviderCredentialCipher("integration-tool-mode-key-at-least-32-bytes");
    const createService = () => {
      const repository = new PgAdminControlRepository(control, cipher);
      return new AdminControlService(
        repository,
        repository,
        { probeModel: async () => undefined, probeMemory: async () => undefined },
        [],
      );
    };
    // FORCE RLS 对迁移角色同样生效；仅夹具准备与全量事实观察使用管理连接，业务 mutation 仍走受限控制角色。
    const readFacts = async () => ({
      revisions: (
        await admin.query(
          `SELECT * FROM "${isolatedSchema}".admin_control_config_revisions ORDER BY object_kind,object_key,revision`,
        )
      ).rows,
      migrations: (
        await admin.query(
          `SELECT * FROM "${isolatedSchema}".runtime_schema_migrations ORDER BY version`,
        )
      ).rows,
    });
    try {
      await withTransaction(admin, async (client) => {
        await client.query(`CREATE ROLE "${isolatedMigratorRole}" LOGIN PASSWORD '${isolatedMigratorPassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
          GRANT CONNECT ON DATABASE "${databaseName}" TO "${isolatedMigratorRole}";
          CREATE SCHEMA "${isolatedSchema}" AUTHORIZATION "${isolatedMigratorRole}"`);
      });
      isolatedDatabasePrepared = true;
      await migrateUp(isolatedMigrator, {
        runtimeRole,
        migratorRole: isolatedMigratorRole,
        skillPublisherRole,
        workerCoordinatorRole,
        teamCoordinatorRole,
        adminControlRole,
        webhookDispatcherRole,
        schema: isolatedSchema,
      });
      const identity = await control.query<{
        readonly current_user: string;
        readonly schema: string;
        readonly rolsuper: boolean;
        readonly rolbypassrls: boolean;
      }>(
        "SELECT current_user,current_schema() AS schema,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      expect(identity.rows[0]).toEqual({
        current_user: adminControlRole,
        schema: isolatedSchema,
        rolsuper: false,
        rolbypassrls: false,
      });
      await admin.query(
        `INSERT INTO "${isolatedSchema}".app_users(id,created_at) VALUES($1,clock_timestamp())`,
        [actorUserId],
      );
      await admin.query(
        `INSERT INTO "${isolatedSchema}".platform_control_operators(user_id,role,status) VALUES($1,'admin','active')`,
        [actorUserId],
      );
      const insertRevisionSql = `INSERT INTO admin_control_config_revisions(
        object_kind,object_key,revision,configuration,configuration_digest,created_by
      ) VALUES('runtime_settings','global',$1,$2::jsonb,$3,$4)`;
      await withTransaction(control, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
        await client.query(insertRevisionSql, [
          1,
          JSON.stringify(historicalConfiguration),
          digestControlRequest(historicalConfiguration),
          actorUserId,
        ]);
      });
      const service = createService();
      const repository = new PgAdminControlRepository(control, cipher);
      const [historicalRevision] = await repository.listRuntimeSettings(actorUserId);
      expect(historicalRevision).toMatchObject({
        revision: 1,
        status: "draft",
        configuration: { ...historicalConfiguration, toolCallingMode: "native" },
      });
      const activateHistorical = async (action: string) => {
        const current = (await repository.listRuntimeSettings(actorUserId)).find(
          (revision) => revision.revision === 1,
        );
        if (current === undefined) throw new Error("历史运行设置 Revision 缺失");
        return await service.publish(context(action), {
          kind: "runtime_settings",
          objectKey: "global",
          revision: 1,
          command: { expectedVersionToken: current.versionToken, reason: "恢复历史运行设置" },
        });
      };
      await activateHistorical("activate-historical");
      expect((await createService().overview(actorUserId)).activeRuntimeSettings).toMatchObject({
        revision: 1,
        status: "active",
        configuration: { ...historicalConfiguration, toolCallingMode: "native" },
      });
      for (const toolCallingMode of ["native", "ptc"] as const) {
        const before = await service.overview(actorUserId);
        const saved = await service.saveRuntimeSettingsConfiguration(context(toolCallingMode), {
          ...historicalConfiguration,
          toolCallingMode,
          expectedGeneration: before.generation,
        });
        expect(saved).toMatchObject({
          status: "active",
          configuration: { ...historicalConfiguration, toolCallingMode },
        });
        const recovered = await createService().overview(actorUserId);
        expect(recovered.generation).toBe(before.generation + 1);
        expect(recovered.activeRuntimeSettings).toEqual(saved);
        const stored = await admin.query<{ readonly configuration: unknown }>(
          `SELECT configuration FROM "${isolatedSchema}".admin_control_config_revisions WHERE object_kind='runtime_settings' AND object_key='global' AND revision=$1`,
          [saved.revision],
        );
        expect(stored.rows[0]?.configuration).toEqual({
          ...historicalConfiguration,
          toolCallingMode,
        });
      }
      const factsBeforeRejections = await readFacts();
      const invalidConfigurations = [
        ...["auto", null, 1, {}, [], true].map((toolCallingMode) => ({
          ...historicalConfiguration,
          toolCallingMode,
        })),
        { ...historicalConfiguration, toolCallingMode: "native", unexpectedSetting: true },
        { ...historicalConfiguration, unexpectedSetting: true },
      ];
      await withTransaction(control, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
        for (const configuration of invalidConfigurations) {
          // CHECK 失败会中止 PostgreSQL 事务；每个非法值必须独立恢复后再验证下一个。
          await client.query("SAVEPOINT invalid_runtime_settings");
          try {
            await expect(
              client.query(insertRevisionSql, [
                100,
                JSON.stringify(configuration),
                digestControlRequest(configuration),
                actorUserId,
              ]),
            ).rejects.toMatchObject({
              code: "23514",
              constraint: "admin_control_configuration_shape",
            });
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT invalid_runtime_settings");
            await client.query("RELEASE SAVEPOINT invalid_runtime_settings");
          }
        }
      });
      expect(await readFacts()).toEqual(factsBeforeRejections);
      await activateHistorical("reactivate-historical");
      const retired = await repository.listRuntimeSettings(actorUserId);
      expect(retired.filter((revision) => revision.status === "retired")).toHaveLength(2);
      const historicalStored = await admin.query<{ readonly configuration: unknown }>(
        `SELECT configuration FROM "${isolatedSchema}".admin_control_config_revisions WHERE object_kind='runtime_settings' AND revision=1`,
      );
      expect(historicalStored.rows[0]?.configuration).toEqual(historicalConfiguration);
      expect((await createService().overview(actorUserId)).activeRuntimeSettings).toMatchObject({
        revision: 1,
        status: "active",
        configuration: { ...historicalConfiguration, toolCallingMode: "native" },
      });
    } finally {
      await control.end();
      await isolatedMigrator.end();
      if (isolatedDatabasePrepared) {
        await admin.query(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE;
          REVOKE ALL PRIVILEGES ON DATABASE "${databaseName}" FROM "${isolatedMigratorRole}";
          DROP ROLE "${isolatedMigratorRole}"`);
      }
    }
  }, 90_000);

  it("Workspace journal 保持 completed 单调，manifest 外键、RLS 与 runtime ACL 均受约束", async () => {
    const f = await fixture(`workspace-manifest-contract-${suffix}`);
    const policy = {
      maxEntries: 8,
      maxFiles: 8,
      maxTotalBytes: 1024,
      maxSingleFileBytes: 1024,
      maxChunkBytes: 1024,
      maxPathUtf8Bytes: 128,
      historicalManifest: { maxFiles: 8, maxTotalBytes: 1024 },
    } as const;
    const journal = new PgWorkspaceManifestRepository(runtime, policy);
    const scope = {
      tenantId: f.scope.tenantId,
      threadId: f.scope.threadId,
      workspaceId: f.scope.workspaceId,
    } as const;
    const identity = {
      schemaVersion: 1 as const,
      digestAlgorithm: "workspace-operation-v2" as const,
      operationKey: `journal-${suffix}`,
      kind: "materialize" as const,
      inputDigest: "a".repeat(64),
      ...scope,
      sandbox: { sessionId: "sandbox-journal", generation: 1 },
    };
    expect(await journal.begin(identity)).toEqual({ status: "started" });
    await journal.complete(identity, {
      kind: "materialized",
      operationKey: identity.operationKey,
      scope,
      sandbox: identity.sandbox,
      targetManifestDigest: "b".repeat(64),
    });
    await journal.recordUnknown(identity, {
      operationKey: identity.operationKey,
      kind: identity.kind,
      inputDigest: identity.inputDigest,
      phase: "after_complete",
      dependencyCode: "SIMULATED_UNKNOWN",
      occurredAt: "2026-07-29T00:00:00.000Z",
    });
    await expect(
      journal.lookupCompleted({
        operationKey: identity.operationKey,
        scope,
        kind: identity.kind,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    const schemaFacts = await admin.query<{
      readonly table_name: string;
      readonly rls: boolean;
      readonly force_rls: boolean;
      readonly definition: string;
    }>(
      `SELECT relation.relname AS table_name,relation.relrowsecurity AS rls,
              relation.relforcerowsecurity AS force_rls,
              COALESCE(constraint_def.definition, '') AS definition
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         LEFT JOIN LATERAL (
           SELECT pg_get_constraintdef(constraint_row.oid) AS definition
             FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid=relation.oid AND constraint_row.contype='f'
            ORDER BY constraint_row.oid
            LIMIT 1
         ) constraint_def ON true
        WHERE namespace.nspname=$1
          AND relation.relname IN ('workspace_revision_manifests','workspace_revision_files','workspace_operation_journal')
        ORDER BY relation.relname`,
      [schema],
    );
    expect(schemaFacts.rows).toHaveLength(3);
    expect(schemaFacts.rows.every((row) => row.rls && row.force_rls)).toBe(true);
    const fileForeignKeys = await admin.query<{ readonly definition: string }>(
      `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid=constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname=$1 AND relation.relname='workspace_revision_files' AND constraint_row.contype='f'`,
      [schema],
    );
    expect(fileForeignKeys.rows.map((row) => row.definition).join("\n")).toContain(
      "blob_incarnations",
    );
    expect(fileForeignKeys.rows.map((row) => row.definition).join("\n")).toContain(
      "workspace_revision_manifests",
    );
    const acl = await admin.query<{
      readonly select_insert_update: boolean;
      readonly delete: boolean;
    }>(
      `SELECT has_table_privilege($1::text, format('%I.workspace_operation_journal', $2::text), 'SELECT,INSERT,UPDATE') AS select_insert_update,
              has_table_privilege($1::text, format('%I.workspace_operation_journal', $2::text), 'DELETE') AS delete`,
      [runtimeRole, schema],
    );
    expect(acl.rows[0]).toEqual({ select_insert_update: true, delete: false });
  });

  it("Workspace journal complete 的 COMMIT 响应未知映射为 unknown，原 identity 可读回", async () => {
    const f = await fixture(`workspace-journal-commit-unknown-${suffix}`);
    const policy = {
      maxEntries: 1,
      maxFiles: 1,
      maxTotalBytes: 1,
      maxSingleFileBytes: 1,
      maxChunkBytes: 1,
      maxPathUtf8Bytes: 128,
      historicalManifest: { maxFiles: 1, maxTotalBytes: 1 },
    } as const;
    const scope = {
      tenantId: f.scope.tenantId,
      threadId: f.scope.threadId,
      workspaceId: f.scope.workspaceId,
    } as const;
    const identity = {
      schemaVersion: 1 as const,
      digestAlgorithm: "workspace-operation-v2" as const,
      operationKey: `journal-complete-unknown-${suffix}`,
      kind: "publish" as const,
      inputDigest: "d".repeat(64),
      ...scope,
      sandbox: { sessionId: "sandbox-journal-unknown", generation: 1 },
      snapshotToken: "snapshot-journal-unknown",
    };
    const journal = new PgWorkspaceManifestRepository(runtime, policy);
    expect(await journal.begin(identity)).toEqual({ status: "started" });
    const result = {
      kind: "published" as const,
      operationKey: identity.operationKey,
      change: {
        kind: "validated_workspace_change" as const,
        operationKey: identity.operationKey,
        ...scope,
        sandboxSnapshot: { ...identity.sandbox, snapshotToken: identity.snapshotToken },
        candidateManifest: createWorkspaceManifest(
          { tenantId: scope.tenantId, entries: [] },
          policy.historicalManifest,
        ),
        verifiedAt: "2026-07-29T00:00:00.000Z",
      },
    };
    await expect(
      new PgWorkspaceManifestRepository(withLostCommitResponse(runtime), policy).complete(
        identity,
        result,
      ),
    ).rejects.toMatchObject({
      result: "unknown",
      dependencyCode: "WORKSPACE_JOURNAL_COMPLETE_COMMIT_UNKNOWN",
    });
    await expect(
      journal.lookupCompleted({ operationKey: identity.operationKey, scope, kind: identity.kind }),
    ).resolves.toMatchObject({ status: "completed", identity, result });
  });

  it("Workspace candidate prepare 的 COMMIT 响应未知映射为 unknown，原 identity 可恢复", async () => {
    const f = await fixture(`workspace-prepare-commit-unknown-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "workspace-prepare-unknown-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("candidate prepare claim 失败");
    const policy = {
      maxEntries: 1,
      maxFiles: 1,
      maxTotalBytes: 1,
      maxSingleFileBytes: 1,
      maxChunkBytes: 1,
      maxPathUtf8Bytes: 128,
      historicalManifest: { maxFiles: 1, maxTotalBytes: 1 },
    } as const;
    const unsigned = {
      tenantId: f.scope.tenantId,
      threadId: f.scope.threadId,
      workspaceId: f.scope.workspaceId,
      attemptId: claimed.snapshot.attempt.attemptId,
      runId: f.scope.runId,
      rootRunId: f.scope.rootRunId,
      revisionId: workspaceRevisionId(`prepare-unknown-revision-${suffix}`),
      operationKey: `${claimed.snapshot.attempt.attemptId}/workspace/prepare-unknown`,
    };
    const identity = {
      ...unsigned,
      operationDigest: workspaceCandidateOperationDigest(unsigned),
    };
    const manifest = createWorkspaceManifest(
      { tenantId: f.scope.tenantId, entries: [] },
      policy.historicalManifest,
    );
    const handoff = new PgWorkspaceCandidateHandoff(runtime, policy);
    await handoff.begin(identity);
    await expect(
      new PgWorkspaceCandidateHandoff(withLostCommitResponse(runtime), policy).prepare({
        identity,
        manifest,
      }),
    ).rejects.toMatchObject({
      result: "unknown",
      dependencyCode: "WORKSPACE_CANDIDATE_PREPARE_COMMIT_UNKNOWN",
    });
    await expect(handoff.prepare({ identity, manifest })).resolves.toBeUndefined();
    const recovered = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      (client) =>
        client.query<{ readonly status: string; readonly manifest_digest: string }>(
          `SELECT status,manifest_digest FROM workspace_revision_candidates
            WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4`,
          [identity.tenantId, identity.workspaceId, identity.attemptId, identity.operationKey],
        ),
      { readOnly: true },
    );
    expect(recovered.rows[0]).toEqual({ status: "prepared", manifest_digest: manifest.digest });
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

  it("Skill 恢复可在空调用集合上按稳定名称排序", async () => {
    const f = await fixture(`skill-recovery-empty-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "skill-recovery-empty-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("Skill 恢复 claim 失败");

    const loaded = await new PgSkillRuntimeRepository(runtime).listLoadedPackages({
      binding: {
        ...f.scope,
        attemptId: claimed.snapshot.attempt.attemptId,
        runClaimToken: claimed.fence.runClaim.token,
        runClaimEpoch: claimed.fence.runClaim.epoch,
        workspaceLeaseRootRunId: claimed.fence.workspaceLease.rootRunId,
        workspaceLeaseEpoch: claimed.fence.workspaceLease.epoch,
      },
    });

    expect(loaded).toEqual([]);
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

    const assignment = await workerTenantAssignments.claim({
      workerId: "dynamic-dispatch-worker",
      leaseMilliseconds: 30_000,
    });
    expect(assignment).toMatchObject({ tenantId: scope.tenantId, generation: 1 });
    if (assignment === undefined) throw new Error("没有动态 Tenant assignment claim 胜者");
    await expect(workerTenantAssignments.settle(assignment)).resolves.toBe(true);

    const runtimeGlobalCount = await withTransaction(runtime, async (client) => {
      // 旧原型使用过这个 GUC；独立角色策略必须保证普通 Runtime 无法借它打开全局视图。
      await client.query("SELECT set_config('app.worker_id','forged-runtime-worker',true)");
      return client.query<{ readonly count: number }>(
        "SELECT count(*)::int AS count FROM worker_tenant_assignments",
      );
    });
    expect(runtimeGlobalCount.rows[0]?.count).toBe(0);
    await expect(workerCoordinator.query("SELECT id FROM runs LIMIT 1")).rejects.toMatchObject({
      code: "42501",
    });

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
        rolloutProjection: { schemaVersion: 2, checkpointId: "initial", items: [] },
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

  it("V2 并发 100 次 follow-up 只激活一个 Run，重试不复制 receipt、Run 或 dispatch", async () => {
    const f = await serialQueueFixture(`hundred-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const commands = Array.from({ length: 100 }, (_, index) => {
      const inputText = `串行输入 ${index}`;
      return {
        scope: f.tenantScope,
        run: createRun({ id: runId(`serial-run-${suffix}-${index}`), thread: f.thread, now }),
        thread: f.thread,
        inputText,
        idempotency: {
          key: `serial-key-${suffix}-${index}`,
          requestHash: requestDigest(`${f.thread.id}\u0000${inputText}`),
        },
      } as const;
    });
    const firstCommand = commands[0];
    if (firstCommand === undefined) throw new Error("并发命令 fixture 缺失");
    const results = await Promise.all([
      ...commands.map((command) => creation.createQueuedRun(command)),
      ...Array.from({ length: 10 }, () => creation.createQueuedRun(firstCommand)),
    ]);
    expect(results.filter((result) => result.outcome === "created")).toHaveLength(100);
    expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(10);
    const disabledEntry = new PgRunDispatchCreation(runtime);
    const rollbackInput = "关闭 V2 后不得在已有队列的 Thread 重开并行旧入口";
    await expect(
      disabledEntry.createQueuedRun({
        scope: f.tenantScope,
        run: createRun({ id: runId(`serial-disabled-${suffix}`), thread: f.thread, now }),
        thread: f.thread,
        inputText: rollbackInput,
        idempotency: {
          key: `serial-disabled-key-${suffix}`,
          requestHash: requestDigest(rollbackInput),
        },
      }),
    ).resolves.toEqual({ outcome: "legacy_drain_required" });

    const snapshot = await withTenantTransaction(runtime, f.tenantScope, async (client) => {
      const queue = await client.query<{ queue_sequence: string; state: string; run_id: string }>(
        `SELECT queue_sequence::text,state,run_id FROM thread_follow_up_queue
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY thread_follow_up_queue.queue_sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const head = await client.query<{ active_run_id: string }>(
        `SELECT active_run_id FROM thread_execution_heads
          WHERE tenant_id=$1 AND thread_id=$2`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const counts = await client.query<{
        receipts: string;
        execution_inputs: string;
        dispatches: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM thread_input_receipts
             WHERE tenant_id=$1 AND thread_id=$2) AS receipts,
           (SELECT count(*)::text FROM run_execution_inputs
             WHERE tenant_id=$1 AND thread_id=$2) AS execution_inputs,
           (SELECT count(*)::text FROM run_dispatch_outbox
             WHERE tenant_id=$1 AND thread_id=$2 AND state IN ('ready','claimed')) AS dispatches`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      return { queue: queue.rows, head: head.rows[0], counts: counts.rows[0] };
    });
    expect(snapshot.queue.map((item) => Number(item.queue_sequence))).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(snapshot.queue.filter((item) => item.state === "active")).toHaveLength(1);
    expect(snapshot.queue.filter((item) => item.state === "queued")).toHaveLength(99);
    expect(snapshot.head?.active_run_id).toBe(snapshot.queue[0]?.run_id);
    expect(snapshot.counts).toEqual({ receipts: "100", execution_inputs: "1", dispatches: "1" });

    const dispatches = await runDispatchOutbox.claim({
      tenantId: f.tenantScope.tenantId,
      dispatcherId: "serial-hundred-dispatcher",
      limit: 100,
      leaseMilliseconds: 30_000,
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.scope.runId).toBe(snapshot.head?.active_run_id);
  });

  it("queued Run 到激活时才绑定上一 Run 的 result revision 与最新 context through-sequence", async () => {
    const f = await serialQueueFixture(`late-bind-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const firstRun = createRun({ id: runId(`serial-first-${suffix}`), thread: f.thread, now });
    const secondRun = createRun({ id: runId(`serial-second-${suffix}`), thread: f.thread, now });
    for (const [index, run] of [firstRun, secondRun].entries()) {
      const inputText = `延迟绑定输入 ${index + 1}`;
      await expect(
        creation.createQueuedRun({
          scope: f.tenantScope,
          run,
          thread: f.thread,
          inputText,
          idempotency: {
            key: `late-bind-key-${suffix}-${index}`,
            requestHash: requestDigest(inputText),
          },
        }),
      ).resolves.toMatchObject({ outcome: "created", entity: { id: run.id } });
    }
    await expect(
      withTenantTransaction(runtime, f.tenantScope, (client) =>
        client.query(`SELECT 1 FROM run_execution_inputs WHERE tenant_id=$1 AND run_id=$2`, [
          f.tenantScope.tenantId,
          secondRun.id,
        ]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });

    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "late-bind-dispatcher",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("首个 Run dispatch 缺失");
    expect(dispatch.scope.runId).toBe(firstRun.id);
    const claimed = await persistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "late-bind-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("首个 Run 未取得 writer");
    await runDispatchOutbox.acknowledge({ claim: dispatch, outcome: "dispatched" });

    const revision = workspaceRevisionId(`serial-revision-${suffix}`);
    const manifestDigest = "f".repeat(64);
    await withTenantTransaction(runtime, f.tenantScope, async (client) => {
      await client.query(
        `INSERT INTO workspace_revisions(
           tenant_id,workspace_id,id,thread_id,revision_number,parent_revision_id,
           created_by_run_id,lease_epoch,object_key,digest,created_at
         ) VALUES ($1,$2,$3,$4,1,NULL,$5,$6,NULL,$7,clock_timestamp())`,
        [
          f.tenantScope.tenantId,
          f.workspace.id,
          revision,
          f.thread.id,
          firstRun.id,
          claimed.fence.workspaceLease.epoch,
          manifestDigest,
        ],
      );
      await client.query(
        `INSERT INTO workspace_revision_manifests(
           tenant_id,workspace_id,revision_id,thread_id,schema_version,manifest_digest,
           entry_count,total_bytes
         ) VALUES ($1,$2,$3,$4,1,$5,0,0)`,
        [f.tenantScope.tenantId, f.workspace.id, revision, f.thread.id, manifestDigest],
      );
      await client.query(
        `UPDATE workspaces SET current_revision_number=1,current_revision_id=$3,
             updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
        [f.tenantScope.tenantId, f.workspace.id, revision],
      );
      await client.query(
        `UPDATE execution_attempts SET current_revision_id=$3,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND attempt_id=$2`,
        [f.tenantScope.tenantId, claimed.snapshot.attempt.attemptId, revision],
      );
      // 阶段 1 不创建 Context facts；直接推进 head cursor 模拟后续 Context writer 的最新事实。
      await client.query(
        `UPDATE thread_execution_heads SET context_through_sequence=41,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id=$3`,
        [f.tenantScope.tenantId, f.thread.id, firstRun.id],
      );
    });

    const running = signed({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/running`,
      fence: claimed.fence,
      expectedAttemptVersion: 0,
      nextAttemptStatus: "running",
      events: [],
      outbox: [],
    });
    expect(await persistence.mutate(running)).toMatchObject({ outcome: "applied" });
    const finalizing = signed({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/finalizing`,
      fence: claimed.fence,
      expectedAttemptVersion: 1,
      nextAttemptStatus: "finalizing",
      nextStage: "finalizing",
      events: [],
      outbox: [],
    });
    expect(await persistence.mutate(finalizing)).toMatchObject({ outcome: "applied" });
    const terminal = signed({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/terminal`,
      fence: claimed.fence,
      expectedAttemptVersion: 2,
      nextAttemptStatus: "succeeded",
      nextStage: "finished",
      nextRunStatus: "succeeded",
      events: [],
      outbox: [],
      releaseFences: true,
    });
    expect(await persistence.mutate(terminal)).toMatchObject({
      outcome: "applied",
      run: { status: "succeeded" },
    });

    const handoff = await withTenantTransaction(runtime, f.tenantScope, async (client) => {
      const input = await client.query<{
        base_revision_id: string;
        context_through_sequence: string;
      }>(
        `SELECT base_revision_id,context_through_sequence::text
           FROM run_execution_inputs WHERE tenant_id=$1 AND run_id=$2`,
        [f.tenantScope.tenantId, secondRun.id],
      );
      const result = await client.query<{
        base_revision_id: string | null;
        result_revision_id: string;
        outcome: string;
        manifest_digest: string;
      }>(
        `SELECT base_revision_id,result_revision_id,outcome,manifest_digest
           FROM run_workspace_results WHERE tenant_id=$1 AND run_id=$2`,
        [f.tenantScope.tenantId, firstRun.id],
      );
      const head = await client.query<{
        active_run_id: string;
        writer_token: string | null;
      }>(
        `SELECT active_run_id,writer_token FROM thread_execution_heads
          WHERE tenant_id=$1 AND thread_id=$2`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      return { input: input.rows[0], result: result.rows[0], head: head.rows[0] };
    });
    expect(handoff.input).toEqual({
      base_revision_id: revision,
      context_through_sequence: "41",
    });
    expect(handoff.result).toEqual({
      base_revision_id: null,
      result_revision_id: revision,
      outcome: "committed",
      manifest_digest: manifestDigest,
    });
    expect(handoff.head).toEqual({ active_run_id: secondRun.id, writer_token: null });
    await expect(
      persistence.inspectAndRenew({ fence: claimed.fence, leaseDurationMs: 30_000 }),
    ).resolves.toEqual({ outcome: "fence_lost" });
    const nextDispatches = await runDispatchOutbox.claim({
      tenantId: f.tenantScope.tenantId,
      dispatcherId: "late-bind-next-dispatcher",
      limit: 10,
      leaseMilliseconds: 30_000,
    });
    expect(nextDispatches.map((item) => item.scope.runId)).toEqual([secondRun.id]);
    expect(nextDispatches[0]?.scope.baseRevisionId).toBe(revision);
  });

  it("Thread Sandbox acquire 遇到已回滚的 SERIALIZABLE 事务时重试完整准备流程", async () => {
    const f = await serialQueueFixture(`sandbox-acquire-retry-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const sandboxPersistence = new PgExecutionPersistence(runtime, {
      threadSandboxSessionReuseEnabled: true,
      threadSandboxHandoffLeaseMs: 30_000,
    });
    const run = createRun({
      id: runId(`sandbox-acquire-retry-${suffix}`),
      thread: f.thread,
      now: isoTimestamp("2099-07-26T00:00:00.000Z"),
    });
    await expect(
      creation.createQueuedRun({
        scope: f.tenantScope,
        run,
        thread: f.thread,
        inputText: "Thread Sandbox acquire retry",
        idempotency: {
          key: `sandbox-acquire-retry-key-${suffix}`,
          requestHash: requestDigest("Thread Sandbox acquire retry"),
        },
      }),
    ).resolves.toMatchObject({ outcome: "created" });
    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "sandbox-acquire-retry-dispatcher",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("Thread Sandbox retry dispatch 缺失");
    const claimed = await sandboxPersistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "sandbox-acquire-retry-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("Thread Sandbox retry claim 失败");
    await runDispatchOutbox.acknowledge({ claim: dispatch, outcome: "dispatched" });

    const injected = withOneSerializationFailure(runtime, "FROM thread_sandbox_sessions");
    const lifecycle = new PgThreadSandboxSessionLifecycle(
      injected.pool,
      fakeThreadSandboxProvider(new FakeSandboxGateway()),
      { pausedRetentionSeconds: 600, transitionWaitMs: 1_000 },
    );
    await expect(
      lifecycle.acquire({
        scope: claimed.fence.scope,
        attemptId: claimed.snapshot.attempt.attemptId,
        owner: "sandbox-acquire-retry-worker",
        leaseDurationMs: 30_000,
        signal: new AbortController().signal,
        requiresResourceFilesystem: true,
      }),
    ).resolves.toMatchObject({
      outcome: "ready",
      source: "cold_created",
      resourceFilesystemMounted: true,
      requiresMaterialization: true,
    });
    expect(injected.rejectionCount()).toBe(1);
  });

  it.each(["pause", "kill"] as const)(
    "阶段 5 并发 handoff 与绑定配置的 %s 终态策略",
    async (idleAction) => {
      const caseSuffix = `${suffix}-${idleAction}`;
      const f = await serialQueueFixture(`sandbox-session-${caseSuffix}`);
      const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
      const sandboxPersistence = new PgExecutionPersistence(runtime, {
        threadSandboxSessionReuseEnabled: true,
        threadSandboxHandoffLeaseMs: 30_000,
      });
      const gateway = new FakeSandboxGateway();
      const lifecycle = new PgThreadSandboxSessionLifecycle(
        runtime,
        fakeThreadSandboxProvider(gateway),
        { pausedRetentionSeconds: 600, transitionWaitMs: 1_000 },
      );
      const now = isoTimestamp("2099-07-26T00:00:00.000Z");
      const runA = createRun({ id: runId(`sandbox-a-${caseSuffix}`), thread: f.thread, now });
      const runB = createRun({ id: runId(`sandbox-b-${caseSuffix}`), thread: f.thread, now });
      await expect(
        creation.createQueuedRun({
          scope: f.tenantScope,
          run: runA,
          thread: f.thread,
          inputText: "Sandbox Session 输入 1",
          idempotency: {
            key: `sandbox-session-key-${caseSuffix}-0`,
            requestHash: requestDigest("Sandbox Session 输入 1"),
          },
        }),
      ).resolves.toMatchObject({ outcome: "created" });

      const dispatchA = (
        await runDispatchOutbox.claim({
          tenantId: f.tenantScope.tenantId,
          dispatcherId: "sandbox-session-dispatcher-a",
          limit: 10,
          leaseMilliseconds: 30_000,
        })
      )[0];
      if (dispatchA === undefined) throw new Error("Run A dispatch 缺失");
      const claimedA = await sandboxPersistence.claim({
        scope: dispatchA.scope as ExecutionScope,
        workerId: "sandbox-session-worker-a",
        leaseDurationMs: 30_000,
      });
      if (claimedA.outcome !== "claimed") throw new Error("Run A claim 失败");
      await runDispatchOutbox.acknowledge({ claim: dispatchA, outcome: "dispatched" });
      const acquiredA = await lifecycle.acquire({
        scope: claimedA.fence.scope,
        attemptId: claimedA.snapshot.attempt.attemptId,
        owner: "sandbox-session-worker-a",
        leaseDurationMs: 30_000,
        signal: new AbortController().signal,
        requiresResourceFilesystem: false,
      });
      if (acquiredA.outcome !== "ready") throw new Error("Run A Sandbox acquire 失败");
      expect(acquiredA).toMatchObject({ source: "cold_created", requiresMaterialization: true });
      expect(acquiredA.resourceFilesystemMounted).toBe(false);
      await expect(
        lifecycle.attestMaterialized({
          scope: claimedA.fence.scope,
          attemptId: claimedA.snapshot.attempt.attemptId,
          lease: acquiredA.lease,
        }),
      ).resolves.toBe("attested");

      const revision = workspaceRevisionId(`sandbox-revision-${caseSuffix}`);
      const manifestDigest = "e".repeat(64);
      await withTenantTransaction(runtime, f.tenantScope, async (client) => {
        await client.query(
          `INSERT INTO workspace_revisions(
           tenant_id,workspace_id,id,thread_id,revision_number,parent_revision_id,
           created_by_run_id,lease_epoch,object_key,digest,created_at
         ) VALUES ($1,$2,$3,$4,1,NULL,$5,$6,NULL,$7,clock_timestamp())`,
          [
            f.tenantScope.tenantId,
            f.workspace.id,
            revision,
            f.thread.id,
            runA.id,
            claimedA.fence.workspaceLease.epoch,
            manifestDigest,
          ],
        );
        await client.query(
          `INSERT INTO workspace_revision_manifests(
           tenant_id,workspace_id,revision_id,thread_id,schema_version,manifest_digest,
           entry_count,total_bytes
         ) VALUES ($1,$2,$3,$4,1,$5,0,0)`,
          [f.tenantScope.tenantId, f.workspace.id, revision, f.thread.id, manifestDigest],
        );
        await client.query(
          `UPDATE workspaces SET current_revision_number=1,current_revision_id=$3,
             updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
          [f.tenantScope.tenantId, f.workspace.id, revision],
        );
        await client.query(
          `UPDATE execution_attempts SET current_revision_id=$3,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND attempt_id=$2`,
          [f.tenantScope.tenantId, claimedA.snapshot.attempt.attemptId, revision],
        );
      });

      expect(
        await sandboxPersistence.mutate(
          signed({
            idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/running-sandbox`,
            fence: claimedA.fence,
            expectedAttemptVersion: 0,
            nextAttemptStatus: "running",
            events: [],
            outbox: [],
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
      expect(
        await sandboxPersistence.mutate(
          signed({
            idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/finalizing-sandbox`,
            fence: claimedA.fence,
            expectedAttemptVersion: 1,
            nextAttemptStatus: "finalizing",
            nextStage: "finalizing",
            events: [],
            outbox: [],
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
      const terminalACommand = signed({
        idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/terminal-sandbox`,
        fence: claimedA.fence,
        expectedAttemptVersion: 2,
        nextAttemptStatus: "succeeded",
        nextStage: "finished",
        nextRunStatus: "succeeded",
        events: [],
        outbox: [],
        releaseFences: true,
        threadSandboxTerminal: {
          schemaVersion: 1,
          sessionId: acquiredA.lease.sessionId,
          generation: acquiredA.lease.generation,
          leaseId: acquiredA.lease.leaseId,
          leaseToken: acquiredA.lease.leaseToken,
        },
      });
      const [terminalA, queuedB] = await Promise.all([
        sandboxPersistence.mutate(terminalACommand),
        creation.createQueuedRun({
          scope: f.tenantScope,
          run: runB,
          thread: f.thread,
          inputText: "Sandbox Session 输入 2",
          idempotency: {
            key: `sandbox-session-key-${caseSuffix}-1`,
            requestHash: requestDigest("Sandbox Session 输入 2"),
          },
        }),
      ]);
      expect(queuedB).toMatchObject({ outcome: "created" });
      if (terminalA.outcome !== "applied") throw new Error("Run A terminal 失败");
      const firstSandboxReceipt = terminalA.receipt.threadSandbox;
      if (firstSandboxReceipt === undefined) throw new Error("Run A Sandbox terminal receipt 缺失");
      expect(["handed_off", "effect_pending"]).toContain(firstSandboxReceipt.outcome);

      const handoffState = await withTenantTransaction(runtime, f.tenantScope, async (client) => {
        const session = await client.query<{
          state: string;
          materialized_revision_id: string | null;
          materialization_attested: boolean;
        }>(
          `SELECT state,materialized_revision_id,materialization_attested
           FROM thread_sandbox_sessions WHERE tenant_id=$1 AND session_id=$2`,
          [f.tenantScope.tenantId, acquiredA.lease.sessionId],
        );
        const leases = await client.query<{
          run_id: string | null;
          attempt_id: string | null;
          active_count: string;
        }>(
          `SELECT min(run_id) AS run_id,min(attempt_id) AS attempt_id,count(*)::text AS active_count
           FROM thread_sandbox_leases
          WHERE tenant_id=$1 AND session_id=$2 AND released_at IS NULL`,
          [f.tenantScope.tenantId, acquiredA.lease.sessionId],
        );
        const queue = await client.query<{ active_count: string }>(
          `SELECT count(*)::text AS active_count FROM thread_follow_up_queue
          WHERE tenant_id=$1 AND thread_id=$2 AND state='active'`,
          [f.tenantScope.tenantId, f.thread.id],
        );
        return { session: session.rows[0], leases: leases.rows[0], queue: queue.rows[0] };
      });
      expect(handoffState.session).toEqual({
        state: firstSandboxReceipt.outcome === "handed_off" ? "running" : "pausing",
        materialized_revision_id: revision,
        materialization_attested: true,
      });
      expect(handoffState.leases).toEqual(
        firstSandboxReceipt.outcome === "handed_off"
          ? { run_id: runB.id, attempt_id: null, active_count: "1" }
          : { run_id: null, attempt_id: null, active_count: "0" },
      );
      expect(handoffState.queue?.active_count).toBe("1");
      if (firstSandboxReceipt.outcome === "effect_pending") {
        await expect(
          lifecycle.completeTerminalEffect({
            scope: claimedA.fence.scope,
            session: acquiredA.session,
            receipt: firstSandboxReceipt,
          }),
        ).resolves.toBe("settled");
      }

      const dispatchB = (
        await runDispatchOutbox.claim({
          tenantId: f.tenantScope.tenantId,
          dispatcherId: "sandbox-session-dispatcher-b",
          limit: 10,
          leaseMilliseconds: 30_000,
        })
      )[0];
      if (dispatchB === undefined) throw new Error("Run B dispatch 缺失");
      expect(dispatchB.scope.baseRevisionId).toBe(revision);
      const claimedB = await sandboxPersistence.claim({
        scope: dispatchB.scope as ExecutionScope,
        workerId: "sandbox-session-worker-b",
        leaseDurationMs: 30_000,
      });
      if (claimedB.outcome !== "claimed") throw new Error("Run B claim 失败");
      await runDispatchOutbox.acknowledge({ claim: dispatchB, outcome: "dispatched" });
      const acquiredB = await lifecycle.acquire({
        scope: claimedB.fence.scope,
        attemptId: claimedB.snapshot.attempt.attemptId,
        owner: "sandbox-session-worker-b",
        leaseDurationMs: 30_000,
        signal: new AbortController().signal,
        requiresResourceFilesystem: false,
      });
      if (acquiredB.outcome !== "ready") throw new Error("Run B Sandbox acquire 失败");
      expect(acquiredB).toMatchObject({
        source: firstSandboxReceipt.outcome === "handed_off" ? "running_handoff" : "paused_resumed",
        requiresMaterialization: false,
        resourceFilesystemMounted: false,
        session: { providerSandboxId: acquiredA.session.providerSandboxId },
        lease: { sessionId: acquiredA.lease.sessionId, generation: acquiredA.lease.generation },
      });
      expect(gateway.sandboxes.size).toBe(1);
      await withTenantTransaction(runtime, f.tenantScope, (client) =>
        client.query(
          `UPDATE thread_sandbox_leases
            SET expires_at=clock_timestamp()+interval '100 milliseconds',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND released_at IS NULL`,
          [f.tenantScope.tenantId, acquiredB.lease.sessionId, acquiredB.lease.leaseId],
        ),
      );
      const renewedB = await sandboxPersistence.inspectAndRenew({
        fence: claimedB.fence,
        leaseDurationMs: 30_000,
      });
      if (renewedB.outcome !== "active") throw new Error("Run B heartbeat 续租失败");
      await expect(
        withTenantTransaction(runtime, f.tenantScope, (client) =>
          client.query<{ lease_renewed: boolean }>(
            `SELECT expires_at > clock_timestamp()+interval '20 seconds' AS lease_renewed
             FROM thread_sandbox_leases
            WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND released_at IS NULL`,
            [f.tenantScope.tenantId, acquiredB.lease.sessionId, acquiredB.lease.leaseId],
          ),
        ),
      ).resolves.toMatchObject({ rows: [{ lease_renewed: true }] });
      const otherTenant = await serialQueueFixture(`sandbox-other-tenant-${caseSuffix}`);
      const crossTenantReplay = await withTenantTransaction(
        runtime,
        otherTenant.tenantScope,
        (client) =>
          client.query(
            `SELECT session_id FROM thread_sandbox_sessions WHERE provider_sandbox_id=$1`,
            [acquiredA.session.providerSandboxId],
          ),
      );
      expect(crossTenantReplay.rowCount).toBe(0);

      expect(
        await sandboxPersistence.mutate(
          signed({
            idempotencyKey: `${claimedB.snapshot.attempt.attemptId}/running-sandbox`,
            fence: renewedB.fence,
            expectedAttemptVersion: 0,
            nextAttemptStatus: "running",
            events: [],
            outbox: [],
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
      expect(
        await sandboxPersistence.mutate(
          signed({
            idempotencyKey: `${claimedB.snapshot.attempt.attemptId}/finalizing-sandbox`,
            fence: renewedB.fence,
            expectedAttemptVersion: 1,
            nextAttemptStatus: "finalizing",
            nextStage: "finalizing",
            events: [],
            outbox: [],
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
      // 为已有测试实例补齐托管绑定夹具，单独验证终态事务读取的策略与默认值不同。
      const profileRevision = idleAction === "pause" ? 700001 : 700002;
      const configuration = {
        providerKey: "cube",
        displayName: "测试沙箱",
        endpoint: "http://cube.example.test",
        credentialConfigured: false,
        policy: {
          templateId: "test-template",
          sessionTtlSeconds: 300,
          operationTimeoutMs: 30000,
          lifecycleTimeoutMs: 30000,
          pausedRetentionSeconds: 123,
          idleAction,
        },
      };
      await migrator.query(
        "INSERT INTO sandbox_provider_profiles(provider_key,revision,configuration,created_by) VALUES('cube',$1,$2,$3)",
        [profileRevision, configuration, f.user.id],
      );
      await migrator.query(
        "INSERT INTO sandbox_routing_revisions(revision,mode,created_by) VALUES($1,'single',$2)",
        [profileRevision, f.user.id],
      );
      await migrator.query(
        "INSERT INTO sandbox_routing_targets(routing_revision,provider_key,profile_revision,weight) VALUES($1,'cube',$1,1)",
        [profileRevision],
      );
      await migrator.query(
        "INSERT INTO sandbox_configuration_bindings(tenant_id,registry_id,routing_revision,provider_key,profile_revision) VALUES($1,$2,$3,'cube',$3)",
        [f.tenantScope.tenantId, acquiredB.session.registryId, profileRevision],
      );
      const terminalB = await sandboxPersistence.mutate(
        signed({
          idempotencyKey: `${claimedB.snapshot.attempt.attemptId}/terminal-sandbox`,
          fence: renewedB.fence,
          expectedAttemptVersion: 2,
          nextAttemptStatus: "succeeded",
          nextStage: "finished",
          nextRunStatus: "succeeded",
          events: [],
          outbox: [],
          releaseFences: true,
          threadSandboxTerminal: {
            schemaVersion: 1,
            sessionId: acquiredB.lease.sessionId,
            generation: acquiredB.lease.generation,
            leaseId: acquiredB.lease.leaseId,
            leaseToken: acquiredB.lease.leaseToken,
          },
        }),
      );
      if (terminalB.outcome !== "applied") throw new Error("Run B terminal 失败");
      const pauseReceipt = terminalB.receipt.threadSandbox;
      if (pauseReceipt?.outcome !== "effect_pending") throw new Error("pause intent 缺失");
      await expect(
        withTenantTransaction(runtime, f.tenantScope, async (client) => {
          const session = await client.query<{ state: string; current_effect_id: string | null }>(
            `SELECT state,current_effect_id FROM thread_sandbox_sessions
            WHERE tenant_id=$1 AND session_id=$2`,
            [f.tenantScope.tenantId, acquiredB.lease.sessionId],
          );
          const lease = await client.query<{ active_count: string }>(
            `SELECT count(*)::text AS active_count FROM thread_sandbox_leases
            WHERE tenant_id=$1 AND session_id=$2 AND released_at IS NULL`,
            [f.tenantScope.tenantId, acquiredB.lease.sessionId],
          );
          return { session: session.rows[0], activeLeases: lease.rows[0]?.active_count };
        }),
      ).resolves.toEqual({
        session: { state: "pausing", current_effect_id: pauseReceipt.effectId },
        activeLeases: "0",
      });
      await expect(
        lifecycle.completeTerminalEffect({
          scope: renewedB.fence.scope,
          session: acquiredB.session,
          receipt: pauseReceipt,
        }),
      ).resolves.toBe("settled");
      expect(pauseReceipt.effectKind).toBe(idleAction === "pause" ? "pause" : "terminate");
      await expect(gateway.inspect(acquiredB.session.providerSandboxId)).resolves.toBe(
        idleAction === "pause" ? "paused" : "not_found",
      );
      const stored = await withTenantTransaction(runtime, f.tenantScope, async (client) =>
        client.query<{ state: string; retention: string }>(
          "SELECT state,extract(epoch FROM retention_expires_at-paused_at)::text AS retention FROM thread_sandbox_sessions WHERE tenant_id=$1 AND session_id=$2",
          [f.tenantScope.tenantId, acquiredB.lease.sessionId],
        ),
      );
      expect(stored.rows[0]?.state).toBe(idleAction === "pause" ? "paused" : "terminated");
      if (idleAction === "pause") expect(Number(stored.rows[0]?.retention)).toBeCloseTo(123, 1);
      await migrator.query("DELETE FROM sandbox_configuration_bindings WHERE routing_revision=$1", [
        profileRevision,
      ]);
      await migrator.query("DELETE FROM sandbox_routing_targets WHERE routing_revision=$1", [
        profileRevision,
      ]);
      await migrator.query("DELETE FROM sandbox_routing_revisions WHERE revision=$1", [
        profileRevision,
      ]);
      await migrator.query(
        "DELETE FROM sandbox_provider_profiles WHERE provider_key='cube' AND revision=$1",
        [profileRevision],
      );
    },
  );

  it("Thread Sandbox 的附件能力升级会退役无挂载 Session 并冷建新 generation", async () => {
    const f = await serialQueueFixture(`sandbox-capability-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const sandboxPersistence = new PgExecutionPersistence(runtime, {
      threadSandboxSessionReuseEnabled: true,
      threadSandboxHandoffLeaseMs: 30_000,
    });
    const gateway = new FakeSandboxGateway();
    const requirements: boolean[] = [];
    const lifecycle = new PgThreadSandboxSessionLifecycle(
      runtime,
      fakeThreadSandboxProvider(gateway, requirements),
      { pausedRetentionSeconds: 600, transitionWaitMs: 1_000 },
    );
    const run = createRun({
      id: runId(`sandbox-capability-run-${suffix}`),
      thread: f.thread,
      now: isoTimestamp("2099-07-26T00:00:00.000Z"),
    });
    await expect(
      creation.createQueuedRun({
        scope: f.tenantScope,
        run,
        thread: f.thread,
        inputText: "Thread Sandbox capability upgrade",
        idempotency: {
          key: `sandbox-capability-key-${suffix}`,
          requestHash: requestDigest("Thread Sandbox capability upgrade"),
        },
      }),
    ).resolves.toMatchObject({ outcome: "created" });
    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "sandbox-capability-dispatcher",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("capability dispatch 缺失");
    const claimed = await sandboxPersistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "sandbox-capability-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("capability claim 失败");
    await runDispatchOutbox.acknowledge({ claim: dispatch, outcome: "dispatched" });

    const first = await lifecycle.acquire({
      scope: claimed.fence.scope,
      attemptId: claimed.snapshot.attempt.attemptId,
      owner: "sandbox-capability-worker",
      leaseDurationMs: 30_000,
      signal: new AbortController().signal,
      requiresResourceFilesystem: false,
    });
    if (first.outcome !== "ready") throw new Error("首次 capability acquire 失败");
    await expect(
      lifecycle.attestMaterialized({
        scope: claimed.fence.scope,
        attemptId: claimed.snapshot.attempt.attemptId,
        lease: first.lease,
      }),
    ).resolves.toBe("attested");
    await withTenantTransaction(runtime, f.tenantScope, (client) =>
      client.query(
        `UPDATE thread_sandbox_leases
            SET released_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND released_at IS NULL`,
        [f.tenantScope.tenantId, first.lease.sessionId, first.lease.leaseId],
      ),
    );

    const upgraded = await lifecycle.acquire({
      scope: claimed.fence.scope,
      attemptId: claimed.snapshot.attempt.attemptId,
      owner: "sandbox-capability-worker",
      leaseDurationMs: 30_000,
      signal: new AbortController().signal,
      requiresResourceFilesystem: true,
    });
    if (upgraded.outcome !== "ready") throw new Error("升级 capability acquire 失败");

    expect(requirements).toEqual([false, true]);
    expect(upgraded).toMatchObject({
      source: "cold_created",
      resourceFilesystemMounted: true,
      lease: { generation: first.lease.generation + 1 },
    });
    expect(upgraded.session.providerSandboxId).not.toBe(first.session.providerSandboxId);
    const sessions = await withTenantTransaction(runtime, f.tenantScope, (client) =>
      client.query<{
        generation: string;
        resource_filesystem_mounted: boolean;
        state: string;
      }>(
        `SELECT generation::text,resource_filesystem_mounted,state
           FROM thread_sandbox_sessions
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY generation`,
        [f.tenantScope.tenantId, f.thread.id],
      ),
    );
    expect(sessions.rows).toEqual([
      { generation: "1", resource_filesystem_mounted: false, state: "terminated" },
      { generation: "2", resource_filesystem_mounted: true, state: "running" },
    ]);
  });

  it.each(["pending", "expired", "submitted"] as const)(
    "关闭记忆将 %s 任务收尾为 skipped，释放租户租约并立即领取新 Run",
    async (initialState) => {
      const base = await serialQueueFixture(`memory-skip-${initialState}-${suffix}`);
      const sourceRun = createRun({
        id: runId(`memory-source-${initialState}-${suffix}`),
        thread: base.thread,
        now: isoTimestamp("2099-07-26T00:00:00.000Z"),
      });
      const f = {
        ...base,
        scope: {
          tenantId: base.tenantScope.tenantId,
          threadId: base.thread.id,
          runId: sourceRun.id,
          rootRunId: sourceRun.id,
          workspaceId: base.workspace.id,
        },
      };
      const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
      const memoryPersistence = new PgExecutionPersistence(runtime, {
        threadContextWriteEnabled: true,
        memoryIngestionEnabled: true,
      });
      await creation.createQueuedRun({
        scope: f.tenantScope,
        run: sourceRun,
        thread: f.thread,
        inputText: "生成记忆关闭回归的来源消息",
        idempotency: { key: `memory-source-${initialState}`, requestHash: requestDigest("source") },
      });
      const sourceDispatch = (
        await runDispatchOutbox.claim({
          tenantId: f.scope.tenantId,
          dispatcherId: "memory-fixture-dispatcher",
          limit: 1,
          leaseMilliseconds: 30_000,
        })
      )[0];
      if (sourceDispatch === undefined) throw new Error("记忆来源 dispatch 缺失");
      const runClaim = await memoryPersistence.claim({
        scope: f.scope,
        workerId: "memory-fixture-worker",
        leaseDurationMs: 30_000,
      });
      if (runClaim.outcome !== "claimed") throw new Error("记忆来源 Attempt 缺失");
      expect(
        await memoryPersistence.mutate(
          signed({
            idempotencyKey: `${runClaim.snapshot.attempt.attemptId}/running`,
            fence: runClaim.fence,
            expectedAttemptVersion: 0,
            nextAttemptStatus: "running",
            events: [],
            outbox: [],
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
      expect(
        await memoryPersistence.mutate(
          signed({
            idempotencyKey: `${runClaim.snapshot.attempt.attemptId}/finalizing`,
            fence: runClaim.fence,
            expectedAttemptVersion: 1,
            nextAttemptStatus: "finalizing",
            nextStage: "finalizing",
            events: [],
            outbox: [],
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
      expect(
        await memoryPersistence.mutate(
          signed({
            idempotencyKey: `${runClaim.snapshot.attempt.attemptId}/terminal`,
            fence: runClaim.fence,
            expectedAttemptVersion: 2,
            nextAttemptStatus: "succeeded",
            nextStage: "finished",
            nextRunStatus: "succeeded",
            releaseFences: true,
            events: [],
            outbox: [],
            threadContextAppend: {
              schemaVersion: 1,
              idempotencyKey: `${runClaim.snapshot.attempt.attemptId}/context/terminal`,
              entries: (
                [
                  {
                    kind: "workspace_unchanged",
                    value: { outcome: "unchanged", revisionId: null },
                  },
                  { kind: "run_terminal", value: { status: "succeeded" } },
                ] as const
              ).map(({ kind, value }) => ({
                entryId: `${runClaim.snapshot.attempt.attemptId}/${kind}`,
                kind,
                body: {
                  storage: "inline" as const,
                  value,
                  sha256: digestCanonical(value),
                  size: Buffer.byteLength(JSON.stringify(value), "utf8"),
                },
              })),
            },
          }),
        ),
      ).toMatchObject({ outcome: "applied", run: { status: "succeeded" } });
      await runDispatchOutbox.acknowledge({ claim: sourceDispatch, outcome: "terminal" });
      const store = new PgMemoryIngestionStore(runtime, {} as BlobStore);
      const claim = await store.claimNext({
        tenantId: f.scope.tenantId,
        workerId: "memory-old-worker",
        leaseMs: 30_000,
      });
      if (claim === undefined) throw new Error("记忆任务缺失");
      await expect(store.complete(claim)).rejects.toThrow("记忆成功必须具有 Provider 事件");
      // 直接走数据库验证 succeeded 约束仍在，不能通过放宽成功语义修复关闭分支。
      await expect(
        withTenantTransaction(runtime, f.scope, (client) =>
          client.query(
            `UPDATE memory_ingestion_outbox SET state='succeeded',completed_at=clock_timestamp(),
               claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL
             WHERE tenant_id=$1 AND run_id=$2`,
            [f.scope.tenantId, f.scope.runId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const eventId = "ba2763d6-284d-4d01-b5ca-cac9f98d99db";
      if (initialState === "submitted") {
        await store.submitted(claim, { eventId, status: "PENDING" });
      }
      await withTenantTransaction(runtime, f.scope, (client) =>
        client.query(
          initialState === "expired"
            ? `UPDATE memory_ingestion_outbox SET claim_expires_at=clock_timestamp()-interval '1 second'
                 WHERE tenant_id=$1 AND run_id=$2`
            : `UPDATE memory_ingestion_outbox SET state=$3,claim_token=NULL,claimed_by=NULL,
                 claim_expires_at=NULL,next_attempt_at=clock_timestamp()
                 WHERE tenant_id=$1 AND run_id=$2`,
          initialState === "expired"
            ? [f.scope.tenantId, f.scope.runId]
            : [f.scope.tenantId, f.scope.runId, initialState],
        ),
      );
      const assignment = {
        tenantId: f.scope.tenantId,
        workerId: "memory-maintenance-worker",
        generation: 1,
        claimToken: randomUUID(),
      };
      await workerCoordinator.query(
        `UPDATE worker_tenant_assignments SET state='claimed',generation=$2,claim_token=$3,
           claimed_by=$4,lease_expires_at=clock_timestamp()+interval '5 minutes'
         WHERE tenant_id=$1`,
        [assignment.tenantId, assignment.generation, assignment.claimToken, assignment.workerId],
      );
      const consumer = new MemoryIngestionConsumer(
        store,
        { resolve: async () => undefined },
        "memory-maintenance-worker",
        30_000,
        5,
        1_000,
        2_000,
      );
      await performWorkerMaintenance({
        recoverResourceBlobs: async () => ({ claimed: 0, converged: 0 }),
        drainMemory: () => consumer.drainTenant(f.scope.tenantId),
        drainScheduledTasks: async () => undefined,
        resourceBlobBatchLimit: 16,
      });
      expect(await store.skip(claim)).toBe(false);
      expect(await consumer.drainTenant(f.scope.tenantId)).toBe(0);
      expect(await workerTenantAssignments.settle(assignment)).toBe(true);
      const state = await withTenantTransaction(runtime, f.scope, (client) =>
        client.query(
          `SELECT state,provider_event_id,submitted_at,completed_at,claim_token,claim_expires_at,
                  claim_generation::text FROM memory_ingestion_outbox WHERE tenant_id=$1 AND run_id=$2`,
          [f.scope.tenantId, f.scope.runId],
        ),
      );
      expect(state.rows[0]).toMatchObject({
        state: "skipped",
        provider_event_id: initialState === "submitted" ? eventId : null,
        submitted_at: initialState === "submitted" ? expect.any(Date) : null,
        completed_at: expect.any(Date),
        claim_token: null,
        claim_expires_at: null,
        claim_generation: "2",
      });
      const settled = await workerCoordinator.query(
        "SELECT state,lease_expires_at FROM worker_tenant_assignments WHERE tenant_id=$1",
        [f.scope.tenantId],
      );
      expect(settled.rows[0]).toEqual({ state: "idle", lease_expires_at: null });
      const nextRun = createRun({
        id: runId(`memory-next-${initialState}-${suffix}`),
        thread: f.thread,
        now: isoTimestamp("2099-07-26T00:00:00.000Z"),
      });
      await creation.createQueuedRun({
        scope: { tenantId: tenantId(f.scope.tenantId), userId: f.user.id },
        run: nextRun,
        thread: f.thread,
        inputText: "验证记忆关闭后的调度",
        idempotency: { key: `memory-next-${initialState}`, requestHash: requestDigest("next") },
      });
      const ready = await workerCoordinator.query(
        "SELECT state,next_attempt_at<=clock_timestamp() AS due FROM worker_tenant_assignments WHERE tenant_id=$1",
        [f.scope.tenantId],
      );
      expect(ready.rows[0]).toEqual({ state: "ready", due: true });
      const dispatches = await runDispatchOutbox.claim({
        tenantId: f.scope.tenantId,
        dispatcherId: "memory-next-worker",
        limit: 1,
        leaseMilliseconds: 30_000,
      });
      expect(dispatches[0]?.scope.runId).toBe(nextRun.id);
    },
  );

  it("阶段 2 让 Run B 只读取激活时冻结的 Run A 历史，重启重建 digest 稳定", async () => {
    const f = await serialQueueFixture(`context-v2-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const contextPersistence = new PgExecutionPersistence(runtime, {
      threadContextWriteEnabled: true,
      memoryIngestionEnabled: true,
    });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const runA = createRun({ id: runId(`context-a-${suffix}`), thread: f.thread, now });
    const runB = createRun({ id: runId(`context-b-${suffix}`), thread: f.thread, now });
    for (const [index, run] of [runA, runB].entries()) {
      const inputText = index === 0 ? "Run A 用户输入" : "Run B 用户输入";
      await creation.createQueuedRun({
        scope: f.tenantScope,
        run,
        thread: f.thread,
        inputText,
        idempotency: {
          key: `context-key-${suffix}-${index}`,
          requestHash: requestDigest(inputText),
        },
      });
    }
    const dispatchA = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "context-dispatcher-a",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatchA === undefined) throw new Error("Run A dispatch 缺失");
    const claimedA = await contextPersistence.claim({
      scope: dispatchA.scope as ExecutionScope,
      workerId: "context-worker-a",
      leaseDurationMs: 30_000,
    });
    if (claimedA.outcome !== "claimed") throw new Error("Run A claim 失败");
    await runDispatchOutbox.acknowledge({ claim: dispatchA, outcome: "dispatched" });
    const assistantBody = {
      role: "assistant",
      text: "Run A Assistant 最终回复",
      content: [
        {
          type: "thinking",
          thinking: "Run A 先核对 Workspace 状态",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: "Run A Assistant 最终回复" },
      ],
      api: "openai-completions",
      provider: "integration",
      model: "integration-model",
      stopReason: "stop",
      timestamp: 1,
    };
    const inlineBody = (value: Readonly<Record<string, unknown>>) => ({
      storage: "inline" as const,
      value,
      sha256: digestCanonical(value),
      size: Buffer.byteLength(JSON.stringify(value), "utf8"),
    });
    const toolTurns = Array.from({ length: 3 }, (_, index) => {
      const callId = `context-tool-${index}-${suffix}`;
      const toolName = "exec_command";
      const turnBody = {
        ...assistantBody,
        text: "",
        content: [
          {
            type: "thinking",
            thinking: `Run A 工具轮次 ${index + 1}`,
            thinkingSignature: "reasoning_content",
          },
        ],
        stopReason: "toolUse",
        timestamp: index + 1,
      };
      const callBody = {
        name: toolName,
        arguments: { cmd: `printf context-${index + 1}` },
        timestamp: index + 1,
      };
      const resultBody = {
        name: toolName,
        text: `context-${index + 1}`,
        isError: false,
        timestamp: index + 1,
      };
      return [
        {
          entryId: `${claimedA.snapshot.attempt.attemptId}/assistant/${index}`,
          kind: "assistant_message" as const,
          body: inlineBody(turnBody),
        },
        {
          entryId: `${claimedA.snapshot.attempt.attemptId}/tool-call/${index}`,
          kind: "tool_call" as const,
          toolCallId: callId,
          toolName,
          body: inlineBody(callBody),
        },
        {
          entryId: `${claimedA.snapshot.attempt.attemptId}/tool-result/${index}`,
          kind: "tool_result" as const,
          toolCallId: callId,
          toolName,
          body: inlineBody(resultBody),
        },
      ];
    }).flat();
    expect(
      await contextPersistence.mutate(
        signed({
          idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/context-turn`,
          fence: claimedA.fence,
          expectedAttemptVersion: 0,
          nextAttemptStatus: "running",
          events: [],
          outbox: [],
          threadContextAppend: {
            schemaVersion: 1,
            idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/context/turn/0`,
            entries: [
              ...toolTurns,
              {
                entryId: `${claimedA.snapshot.attempt.attemptId}/assistant/final`,
                kind: "assistant_message",
                body: inlineBody(assistantBody),
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await contextPersistence.mutate(
        signed({
          idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/finalizing-context`,
          fence: claimedA.fence,
          expectedAttemptVersion: 1,
          nextAttemptStatus: "finalizing",
          nextStage: "finalizing",
          events: [],
          outbox: [],
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    const workspaceBody = { outcome: "unchanged", revisionId: null };
    const terminalBody = { status: "succeeded" };
    expect(
      await contextPersistence.mutate(
        signed({
          idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/terminal-context`,
          fence: claimedA.fence,
          expectedAttemptVersion: 2,
          nextAttemptStatus: "succeeded",
          nextStage: "finished",
          nextRunStatus: "succeeded",
          events: [],
          outbox: [],
          releaseFences: true,
          threadContextAppend: {
            schemaVersion: 1,
            idempotencyKey: `${claimedA.snapshot.attempt.attemptId}/context/final/succeeded`,
            entries: [
              {
                entryId: `${claimedA.snapshot.attempt.attemptId}/workspace`,
                kind: "workspace_unchanged",
                body: {
                  storage: "inline",
                  value: workspaceBody,
                  sha256: digestCanonical(workspaceBody),
                  size: Buffer.byteLength(JSON.stringify(workspaceBody), "utf8"),
                },
              },
              {
                entryId: `${claimedA.snapshot.attempt.attemptId}/terminal`,
                kind: "run_terminal",
                body: {
                  storage: "inline",
                  value: terminalBody,
                  sha256: digestCanonical(terminalBody),
                  size: Buffer.byteLength(JSON.stringify(terminalBody), "utf8"),
                },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ outcome: "applied", run: { status: "succeeded" } });

    const noBlobReads = {
      getBytes: async () => {
        throw new Error("内联记忆正文不应读取 Blob");
      },
    } as unknown as BlobStore;
    const memoryStore = new PgMemoryIngestionStore(runtime, noBlobReads);
    const memoryClaim = await memoryStore.claimNext({
      tenantId: f.tenantScope.tenantId,
      workerId: "context-memory-worker",
      leaseMs: 30_000,
    });
    expect(memoryClaim).toMatchObject({
      tenantId: f.tenantScope.tenantId,
      tenantKind: "personal",
      userId: f.user.id,
      threadId: f.thread.id,
      runId: runA.id,
      messages: [
        { role: "user", content: "Run A 用户输入" },
        { role: "assistant", content: "Run A Assistant 最终回复" },
      ],
    });
    if (memoryClaim === undefined) throw new Error("记忆 Outbox claim 缺失");
    expect(
      await memoryStore.complete(memoryClaim, {
        eventId: "b6c2d5f0-c65f-4f27-8f04-0adf25a69428",
        status: "SUCCEEDED",
      }),
    ).toBe(true);

    const dispatchB = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "context-dispatcher-b",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatchB === undefined) throw new Error("Run B dispatch 缺失");
    const claimedB = await contextPersistence.claim({
      scope: dispatchB.scope as ExecutionScope,
      workerId: "context-worker-b",
      leaseDurationMs: 30_000,
    });
    if (claimedB.outcome !== "claimed") throw new Error("Run B claim 失败");
    await runDispatchOutbox.acknowledge({ claim: dispatchB, outcome: "dispatched" });
    expect(claimedB.snapshot.contextThroughSequence).toBe(14);
    const throughSequence = claimedB.snapshot.contextThroughSequence;
    if (throughSequence === undefined) throw new Error("Run B context cursor 缺失");
    const compatibilityDigest = sha256Digest("a".repeat(64));
    const firstReader = new PgThreadContextHistoryRepository(runtime, noBlobReads);
    const first = await firstReader.readActiveHistory({
      scope: dispatchB.scope as ExecutionScope,
      attemptId: claimedB.snapshot.attempt.attemptId,
      throughSequence,
      compatibilityDigest,
      mode: "shadow",
    });
    if (first.outcome !== "ready") throw new Error("首次 history 重建失败");
    const restartedReader = new PgThreadContextHistoryRepository(runtime, noBlobReads);
    const restarted = await restartedReader.readActiveHistory({
      scope: dispatchB.scope as ExecutionScope,
      attemptId: claimedB.snapshot.attempt.attemptId,
      throughSequence,
      compatibilityDigest,
      mode: "read",
    });
    if (restarted.outcome !== "ready") throw new Error("重启 history 重建失败");
    expect(restarted.history.digest).toBe(first.history.digest);
    expect(JSON.stringify(restarted.history.messages)).toContain("Run A 用户输入");
    expect(JSON.stringify(restarted.history.messages)).toContain("Run A 先核对 Workspace 状态");
    expect(JSON.stringify(restarted.history.messages)).toContain("reasoning_content");
    expect(JSON.stringify(restarted.history.messages)).toContain("Run A Assistant 最终回复");
    expect(JSON.stringify(restarted.history.messages)).not.toContain("Run B 用户输入");

    const active = await withTenantTransaction(runtime, f.tenantScope, (client) =>
      client.query<{ active_count: string }>(
        `SELECT count(*)::text AS active_count FROM thread_follow_up_queue
          WHERE tenant_id=$1 AND thread_id=$2 AND state='active'`,
        [f.tenantScope.tenantId, f.thread.id],
      ),
    );
    expect(active.rows[0]?.active_count).toBe("1");
  });

  it("阶段 3 在并发 head 写入时重试 auto steer，terminal fallback 保持原 input 顺序", async () => {
    const f = await serialQueueFixture(`input-v2-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const inputRouting = new PgThreadInputRouting(runtime);
    const inputPersistence = new PgExecutionPersistence(runtime, {
      threadContextWriteEnabled: true,
      threadInputRoutingV2Enabled: true,
    });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const activeRun = createRun({ id: runId(`input-active-${suffix}`), thread: f.thread, now });
    await creation.createQueuedRun({
      scope: f.tenantScope,
      run: activeRun,
      thread: f.thread,
      inputText: "先执行当前任务",
      idempotency: { key: `input-active-key-${suffix}`, requestHash: requestDigest("active") },
    });
    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "input-v2-dispatcher",
        limit: 1,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("阶段 3 active dispatch 缺失");
    const claimed = await inputPersistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "input-v2-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("阶段 3 active Run claim 失败");
    expect(
      await inputPersistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/model-started`,
          fence: claimed.fence,
          expectedAttemptVersion: 0,
          nextAttemptStatus: "running",
          nextStage: "model_execution_started",
          events: [],
          outbox: [],
        }),
      ),
    ).toMatchObject({ outcome: "applied" });

    const blocker = await runtime.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [f.tenantScope.tenantId, f.tenantScope.userId],
    );
    const blockerPid = Number(
      (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
    );
    await blocker.query(
      `UPDATE thread_execution_heads SET updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND thread_id=$2`,
      [f.tenantScope.tenantId, f.thread.id],
    );

    const steerText = "不要改后端，只调整配色";
    const steerAttachment = {
      resourceId: resourceId(`resource-input-steer-${suffix}`),
      versionId: resourceVersionId(`version-input-steer-${suffix}`),
    };
    const steerPromise = inputRouting.submit({
      scope: f.tenantScope,
      thread: f.thread,
      fallbackRun: createRun({
        id: runId(`input-steer-fallback-${suffix}`),
        thread: f.thread,
        now,
      }),
      inputText: steerText,
      attachments: [steerAttachment],
      mode: "auto",
      expectedRunId: activeRun.id,
      fallbackToFollowUp: false,
      idempotency: { key: `input-steer-key-${suffix}`, requestHash: requestDigest(steerText) },
    });
    let submitWasBlocked = false;
    let blockerCommitted = false;
    try {
      for (let poll = 0; poll < 100; poll += 1) {
        const blocked = await admin.query<{ blocked: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_stat_activity
              WHERE $1=ANY(pg_blocking_pids(pid))
           ) AS blocked`,
          [blockerPid],
        );
        if (blocked.rows[0]?.blocked === true) {
          submitWasBlocked = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      await blocker.query("COMMIT");
      blockerCommitted = true;
    } finally {
      if (!blockerCommitted) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    expect(submitWasBlocked).toBe(true);
    const steer = await steerPromise;
    expect(steer).toMatchObject({
      outcome: "accepted",
      receipt: { disposition: "pending_steer", targetRunId: activeRun.id },
    });
    const secondSteerText = "保留现有字体";
    const secondSteer = await inputRouting.submit({
      scope: f.tenantScope,
      thread: f.thread,
      fallbackRun: createRun({
        id: runId(`input-steer-second-fallback-${suffix}`),
        thread: f.thread,
        now,
      }),
      inputText: secondSteerText,
      attachments: [],
      mode: "auto",
      expectedRunId: activeRun.id,
      expectedTurnId: "turn-1",
      fallbackToFollowUp: false,
      idempotency: {
        key: `input-steer-second-key-${suffix}`,
        requestHash: requestDigest(secondSteerText),
      },
    });
    expect(secondSteer).toMatchObject({
      outcome: "accepted",
      receipt: { disposition: "pending_steer", targetRunId: activeRun.id },
    });
    const pending = await inputPersistence.readPendingThreadSteers({ fence: claimed.fence });
    if (pending.outcome !== "pending") throw new Error("阶段 3 pending steer 缺失");
    expect(pending.items.map((item) => item.inputText)).toEqual([steerText, secondSteerText]);
    expect(pending.items[0]?.attachments).toEqual([steerAttachment]);
    for (const [index, item] of pending.items.entries()) {
      expect(
        await inputPersistence.mutate(
          signed({
            idempotencyKey: `${claimed.snapshot.attempt.attemptId}/steer/${item.receiptId}`,
            fence: claimed.fence,
            expectedAttemptVersion: 1 + index,
            events: [],
            outbox: [],
            threadSteer: {
              receiptId: item.receiptId,
              targetTurnId: item.targetTurnId,
              bodyDigest: item.bodyDigest,
            },
          }),
        ),
      ).toMatchObject({
        outcome: "applied",
        receipt: {
          threadSteer: { receiptId: item.receiptId },
          threadContext: { entryCount: 1 },
        },
      });
    }

    const strictText = "只允许当前 Run，结束后不要自动排队";
    const strict = await inputRouting.submit({
      scope: f.tenantScope,
      thread: f.thread,
      fallbackRun: createRun({ id: runId(`input-strict-${suffix}`), thread: f.thread, now }),
      inputText: strictText,
      attachments: [],
      mode: "steer",
      expectedRunId: activeRun.id,
      expectedTurnId: "turn-1",
      fallbackToFollowUp: false,
      idempotency: { key: `input-strict-key-${suffix}`, requestHash: requestDigest(strictText) },
    });
    expect(strict).toMatchObject({
      outcome: "accepted",
      receipt: { disposition: "pending_steer" },
    });
    if (strict.outcome !== "accepted" && strict.outcome !== "replayed") {
      throw new Error("阶段 3 strict steer receipt 未接受");
    }

    const fallbackText = "若已结束则排到下一项";
    const fallback = await inputRouting.submit({
      scope: f.tenantScope,
      thread: f.thread,
      fallbackRun: createRun({ id: runId(`input-fallback-${suffix}`), thread: f.thread, now }),
      inputText: fallbackText,
      attachments: [],
      mode: "auto",
      expectedRunId: activeRun.id,
      expectedTurnId: "turn-1",
      fallbackToFollowUp: false,
      idempotency: {
        key: `input-fallback-key-${suffix}`,
        requestHash: requestDigest(fallbackText),
      },
    });
    if (fallback.outcome !== "accepted" && fallback.outcome !== "replayed") {
      throw new Error("阶段 3 fallback receipt 未接受");
    }
    const laterText = "更晚的显式下一项";
    const later = await inputRouting.submit({
      scope: f.tenantScope,
      thread: f.thread,
      fallbackRun: createRun({ id: runId(`input-later-${suffix}`), thread: f.thread, now }),
      inputText: laterText,
      attachments: [],
      mode: "follow_up",
      fallbackToFollowUp: false,
      idempotency: { key: `input-later-key-${suffix}`, requestHash: requestDigest(laterText) },
    });
    expect(later).toMatchObject({ outcome: "accepted", receipt: { disposition: "queued" } });

    expect(
      await inputPersistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/finalizing-input-v2`,
          fence: claimed.fence,
          expectedAttemptVersion: 3,
          nextAttemptStatus: "finalizing",
          nextStage: "finalizing",
          events: [],
          outbox: [],
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await inputPersistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/terminal-input-v2`,
          fence: claimed.fence,
          expectedAttemptVersion: 4,
          nextAttemptStatus: "succeeded",
          nextStage: "finished",
          nextRunStatus: "succeeded",
          events: [],
          outbox: [],
          releaseFences: true,
        }),
      ),
    ).toMatchObject({ outcome: "applied" });

    const snapshot = await withTenantTransaction(runtime, f.tenantScope, async (client) => {
      const receipts = await client.query<{
        receipt_id: string;
        disposition: string;
        applied_context_sequence: string | null;
        queued_run_id: string | null;
        input_sequence: string;
        rejection_code: string | null;
      }>(
        `SELECT receipt_id,disposition,applied_context_sequence::text,queued_run_id,
                input_sequence::text,rejection_code
           FROM thread_input_receipts WHERE tenant_id=$1 AND thread_id=$2
           ORDER BY input_sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const queue = await client.query<{ run_id: string; queue_sequence: string; state: string }>(
        `SELECT run_id,queue_sequence::text,state FROM thread_follow_up_queue
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY queue_sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const userFacts = await client.query<{ text: string }>(
        `SELECT body_inline->>'text' AS text FROM thread_context_entries
          WHERE tenant_id=$1 AND thread_id=$2 AND kind='user_message' ORDER BY sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      return { receipts: receipts.rows, queue: queue.rows, userFacts: userFacts.rows };
    });
    expect(snapshot.userFacts.map((item) => item.text)).toEqual(
      expect.arrayContaining([steerText, secondSteerText]),
    );
    for (const item of pending.items) {
      const steerReceipt = snapshot.receipts.find(
        (receipt) => receipt.receipt_id === item.receiptId,
      );
      expect(steerReceipt).toMatchObject({ disposition: "steered" });
      expect(steerReceipt?.applied_context_sequence).not.toBeNull();
    }
    expect(
      snapshot.receipts.find((item) => item.receipt_id === strict.receipt.receiptId),
    ).toMatchObject({ disposition: "rejected", rejection_code: "target_run_finished" });
    const fallbackReceipt = snapshot.receipts.find(
      (item) => item.receipt_id === fallback.receipt.receiptId,
    );
    expect(fallbackReceipt).toMatchObject({ disposition: "queued" });
    expect(snapshot.queue.find((item) => item.state === "active")?.run_id).toBe(
      fallbackReceipt?.queued_run_id,
    );
    expect(Number(snapshot.queue.at(-2)?.queue_sequence)).toBeLessThan(
      Number(snapshot.queue.at(-1)?.queue_sequence),
    );
  });

  it("阶段 3 active Run 取消把 pending auto 原子转 follow-up，且不重复写 user fact", async () => {
    const f = await serialQueueFixture(`input-cancel-v2-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const inputRouting = new PgThreadInputRouting(runtime);
    const inputPersistence = new PgExecutionPersistence(runtime, {
      threadContextWriteEnabled: true,
      threadInputRoutingV2Enabled: true,
    });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const activeRun = createRun({
      id: runId(`input-cancel-active-${suffix}`),
      thread: f.thread,
      now,
    });
    await creation.createQueuedRun({
      scope: f.tenantScope,
      run: activeRun,
      thread: f.thread,
      inputText: "取消前的当前任务",
      idempotency: {
        key: `input-cancel-active-key-${suffix}`,
        requestHash: requestDigest("active"),
      },
    });
    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "input-cancel-v2-dispatcher",
        limit: 1,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("阶段 3 cancel dispatch 缺失");
    const claimed = await inputPersistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "input-cancel-v2-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("阶段 3 cancel Run claim 失败");
    expect(
      await inputPersistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/model-started-cancel-v2`,
          fence: claimed.fence,
          expectedAttemptVersion: 0,
          nextAttemptStatus: "running",
          nextStage: "model_execution_started",
          events: [],
          outbox: [],
        }),
      ),
    ).toMatchObject({ outcome: "applied" });

    const inputText = "当前 Run 已取消则排到下一项";
    const submitted = await inputRouting.submit({
      scope: f.tenantScope,
      thread: f.thread,
      fallbackRun: createRun({
        id: runId(`input-cancel-fallback-${suffix}`),
        thread: f.thread,
        now,
      }),
      inputText,
      attachments: [],
      mode: "auto",
      expectedRunId: activeRun.id,
      expectedTurnId: "turn-1",
      fallbackToFollowUp: false,
      idempotency: {
        key: `input-cancel-fallback-key-${suffix}`,
        requestHash: requestDigest(inputText),
      },
    });
    expect(submitted).toMatchObject({
      outcome: "accepted",
      receipt: { disposition: "pending_steer" },
    });
    if (submitted.outcome !== "accepted" && submitted.outcome !== "replayed") {
      throw new Error("阶段 3 cancel pending receipt 未接受");
    }
    const current = await repositories.runs.get(f.tenantScope, activeRun.id);
    if (current === undefined) throw new Error("阶段 3 cancel active Run 缺失");
    await expect(
      repositories.runs.update(
        f.tenantScope,
        transitionRun(current.entity, "cancelled", isoTimestamp("2099-07-26T00:00:01.000Z")),
        current.version,
      ),
    ).resolves.toMatchObject({ outcome: "updated" });

    const receipt = await inputRouting.get({
      scope: f.tenantScope,
      threadId: f.thread.id,
      receiptId: submitted.receipt.receiptId,
    });
    expect(receipt).toMatchObject({
      disposition: "queued",
      events: [
        { sequence: 1, disposition: "pending_steer" },
        { sequence: 2, disposition: "queued" },
      ],
    });
    const facts = await withTenantTransaction(runtime, f.tenantScope, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM thread_context_entries
          WHERE tenant_id=$1 AND thread_id=$2 AND kind='user_message'
            AND body_inline->>'text'=$3`,
        [f.tenantScope.tenantId, f.thread.id, inputText],
      ),
    );
    expect(facts.rows[0]?.count).toBe("0");
  });

  it("取消 queued Run 保留 receipt/queue 事实，取消 active Run 后 FIFO 跳过它", async () => {
    const f = await serialQueueFixture(`cancel-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const firstRun = createRun({ id: runId(`cancel-run-${suffix}-0`), thread: f.thread, now });
    const secondRun = createRun({ id: runId(`cancel-run-${suffix}-1`), thread: f.thread, now });
    const thirdRun = createRun({ id: runId(`cancel-run-${suffix}-2`), thread: f.thread, now });
    const runs = [firstRun, secondRun, thirdRun] as const;
    for (const [index, run] of runs.entries()) {
      const inputText = `取消队列输入 ${index}`;
      await creation.createQueuedRun({
        scope: f.tenantScope,
        run,
        thread: f.thread,
        inputText,
        idempotency: {
          key: `cancel-key-${suffix}-${index}`,
          requestHash: requestDigest(inputText),
        },
      });
    }
    const followUps = new PgThreadSandboxSessionLifecycle(
      runtime,
      fakeThreadSandboxProvider(new FakeSandboxGateway()),
      { pausedRetentionSeconds: 600, transitionWaitMs: 1_000 },
    );
    const followUpScope = (id: string) =>
      ({ tenantId: f.tenantScope.tenantId, threadId: f.thread.id, runId: id }) as ExecutionScope;
    // 快照推迟提示只看未取消的 queued follow-up，不把当前 active Run 自身算入。
    await expect(followUps.hasQueuedFollowUp({ scope: followUpScope(firstRun.id) })).resolves.toBe(
      true,
    );
    for (const run of [secondRun, firstRun]) {
      const current = await repositories.runs.get(f.tenantScope, run.id);
      if (current === undefined) throw new Error("待取消 Run 缺失");
      const cancelled = transitionRun(
        current.entity,
        "cancelled",
        isoTimestamp("2099-07-26T00:00:01.000Z"),
      );
      await expect(
        repositories.runs.update(f.tenantScope, cancelled, current.version),
      ).resolves.toMatchObject({ outcome: "updated" });
    }
    const cancelled = await withTenantTransaction(runtime, f.tenantScope, async (client) => {
      const queue = await client.query<{ run_id: string; state: string }>(
        `SELECT run_id,state FROM thread_follow_up_queue
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY thread_follow_up_queue.queue_sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const receipts = await client.query<{ queued_run_id: string; state: string }>(
        `SELECT queued_run_id,state FROM thread_input_receipts
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY queue_sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const head = await client.query<{ active_run_id: string }>(
        `SELECT active_run_id FROM thread_execution_heads
          WHERE tenant_id=$1 AND thread_id=$2`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const inputs = await client.query<{ run_id: string }>(
        `SELECT run_id FROM run_execution_inputs
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at,run_id`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      return {
        queue: queue.rows,
        receipts: receipts.rows,
        head: head.rows[0],
        inputs: inputs.rows,
      };
    });
    expect(cancelled.queue).toEqual([
      { run_id: firstRun.id, state: "cancelled" },
      { run_id: secondRun.id, state: "cancelled" },
      { run_id: thirdRun.id, state: "active" },
    ]);
    expect(cancelled.receipts).toEqual([
      { queued_run_id: firstRun.id, state: "consumed" },
      { queued_run_id: secondRun.id, state: "cancelled" },
      { queued_run_id: thirdRun.id, state: "consumed" },
    ]);
    expect(cancelled.head).toEqual({ active_run_id: thirdRun.id });
    await expect(followUps.hasQueuedFollowUp({ scope: followUpScope(thirdRun.id) })).resolves.toBe(
      false,
    );
    expect(cancelled.inputs.map((item) => item.run_id).sort()).toEqual(
      [firstRun.id, thirdRun.id].sort(),
    );
  });

  it("V2 writer 过期后 recovery 原子失败当前 Run 并激活 FIFO 下一项", async () => {
    const f = await serialQueueFixture(`writer-recovery-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const now = isoTimestamp("2099-07-26T00:00:00.000Z");
    const firstRun = createRun({ id: runId(`recovery-first-${suffix}`), thread: f.thread, now });
    const secondRun = createRun({ id: runId(`recovery-second-${suffix}`), thread: f.thread, now });
    const runs = [firstRun, secondRun] as const;
    for (const [index, run] of runs.entries()) {
      const inputText = `崩溃恢复输入 ${index}`;
      await creation.createQueuedRun({
        scope: f.tenantScope,
        run,
        thread: f.thread,
        inputText,
        idempotency: {
          key: `writer-recovery-key-${suffix}-${index}`,
          requestHash: requestDigest(inputText),
        },
      });
    }
    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "writer-recovery-dispatcher",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("恢复测试 dispatch 缺失");
    const claimed = await persistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "crashed-thread-writer",
      leaseDurationMs: 1_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("恢复测试 writer claim 失败");
    await withTenantTransaction(runtime, f.tenantScope, (client) =>
      client.query("SELECT pg_sleep(1.05)"),
    );
    await expect(
      persistence.recoverExpiredAttempt({
        scope: dispatch.scope as ExecutionScope,
        decision: "safe_fail",
      }),
    ).resolves.toBe("recovered");
    const recovered = await withTenantTransaction(runtime, f.tenantScope, async (client) => {
      const queue = await client.query<{ run_id: string; state: string }>(
        `SELECT run_id,state FROM thread_follow_up_queue
          WHERE tenant_id=$1 AND thread_id=$2 ORDER BY queue_sequence`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const head = await client.query<{ active_run_id: string; writer_token: string | null }>(
        `SELECT active_run_id,writer_token FROM thread_execution_heads
          WHERE tenant_id=$1 AND thread_id=$2`,
        [f.tenantScope.tenantId, f.thread.id],
      );
      const result = await client.query<{ outcome: string }>(
        `SELECT outcome FROM run_workspace_results WHERE tenant_id=$1 AND run_id=$2`,
        [f.tenantScope.tenantId, firstRun.id],
      );
      const nextInput = await client.query(
        `SELECT 1 FROM run_execution_inputs WHERE tenant_id=$1 AND run_id=$2`,
        [f.tenantScope.tenantId, secondRun.id],
      );
      return {
        queue: queue.rows,
        head: head.rows[0],
        result: result.rows[0],
        nextInputCount: nextInput.rowCount,
      };
    });
    expect(recovered.queue).toEqual([
      { run_id: firstRun.id, state: "failed" },
      { run_id: secondRun.id, state: "active" },
    ]);
    expect(recovered.head).toEqual({ active_run_id: secondRun.id, writer_token: null });
    expect(recovered.result).toEqual({ outcome: "failed_before_commit" });
    expect(recovered.nextInputCount).toBe(1);
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
      return {
        threads: threads.rows[0]?.count,
        workspaces: workspaces.rows[0]?.count,
      };
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
        renamePersonalThread: new PgRenamePersonalThreadCommand(runtime),
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

  it("开发黑盒 Gate：真实 HTTP、PG 原子创建、投递、Faux Pi 执行与 Sandbox 收敛", async () => {
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
        renamePersonalThread: new PgRenamePersonalThreadCommand(runtime),
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
              providerKey: "cube",
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
      const credentials = new InMemoryCredentialStore();
      await credentials.modify(faux.provider.id, async () => ({
        type: "api_key",
        key: "test-only-key",
      }));
      const modelRuntime = createModels({ credentials });
      modelRuntime.setProvider(faux.provider);
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
        (_input, outputs) => ({
          recordStarted: async () => "recorded" as const,
          record: async (call) => {
            const observation = await outputs.readControlledReceipt(call);
            return observation === undefined
              ? { outcome: "conflict" as const }
              : { outcome: "recorded" as const, observation, isTruncated: false };
          },
        }),
      );
      const registeredSandboxes = new PgBackedSandboxSessionRegistry(runtime, upstream, 120);
      const worker = new RunWorker(
        {
          persistence: new PgExecutionPersistence(runtime),
          revisions: new FakeRevisionVerifier(),
          sandboxes: registeredSandboxes,
          orphanSandboxes: registeredSandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
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
            JSON.stringify({ schemaVersion: 2, checkpointId: "db-check", items: [] }),
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
        schemaVersion: 2 as const,
        checkpointId: `cp-setup-${suffix}`,
        items: [],
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

  it("model_continue 只绑定已持久化的 Artifact 修正轮次与最新 Attempt version", async () => {
    const f = await fixture(`model-continue-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "model-continue-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const attemptId = claimed.snapshot.attempt.attemptId;
    const call = {
      callId: `${attemptId}/model/correction/1`,
      toolName: "pi_model",
      argsDigest: sha256Digest("2".repeat(64)),
    };
    const checkpoint = await persistence.mutate(
      signed({
        idempotencyKey: `${attemptId}/model-checkpoint`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [],
        outbox: [],
      }),
    );
    expect(checkpoint.outcome).toBe("applied");
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        effect: "model_continue",
        call,
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });

    const correction = await persistence.mutate(
      signed({
        idempotencyKey: `${attemptId}/correction/1/feedback`,
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        nextStage: "workspace_verified",
        events: [
          {
            schemaVersion: 1,
            kind: "artifact_correction_requested",
            sequence: 0,
            payload: {
              round: 1,
              maxRounds: 2,
              code: "ARTIFACT_NOT_READY",
              feedback: "请补齐必需交付物后继续。",
            },
          },
        ],
        outbox: [],
      }),
    );
    expect(correction.outcome).toBe("applied");
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        effect: "model_continue",
        call,
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        effect: "model_continue",
        call: { ...call, callId: `${attemptId}/model/correction/2` },
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    const permit = await persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 2,
      effect: "model_continue",
      call,
      permitDurationMs: 3_000,
    });
    expect(permit.outcome).toBe("authorized");
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        effect: "model_continue",
        call,
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    if (permit.outcome !== "authorized") throw new Error("继续许可未签发");
    await expect(
      persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        permit: permit.permit,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
    await expect(
      persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        permit: permit.permit,
      }),
    ).resolves.toEqual({ outcome: "already_consumed" });

    const overBudget = await persistence.mutate(
      signed({
        idempotencyKey: `${attemptId}/correction/2/feedback`,
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        events: [
          {
            schemaVersion: 1,
            kind: "artifact_correction_requested",
            sequence: 1,
            payload: {
              round: 2,
              maxRounds: 2,
              code: "ARTIFACT_NOT_READY",
              feedback: "x".repeat(8 * 1_024),
            },
          },
        ],
        outbox: [],
      }),
    );
    expect(overBudget.outcome).toBe("applied");
    await expect(
      persistence.issueExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 3,
        effect: "model_continue",
        call: { ...call, callId: `${attemptId}/model/correction/2` },
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      persistence.mutate(
        signed({
          idempotencyKey: `${attemptId}/correction/3/feedback`,
          fence: claimed.fence,
          expectedAttemptVersion: 3,
          events: [
            {
              schemaVersion: 1,
              kind: "artifact_correction_requested",
              sequence: 2,
              payload: {
                round: 3,
                maxRounds: 3,
                code: "ARTIFACT_NOT_READY",
                feedback: "不得接受第三轮",
              },
            } as never,
          ],
          outbox: [],
        }),
      ),
    ).resolves.toEqual({ outcome: "protocol_invalid" });
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

  it("Heartbeat、副作用许可签发和消费自动重试已回滚的 SERIALIZABLE 事务", async () => {
    const f = await fixture(`permit-serializable-retry-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "permit-serializable-retry-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const heartbeatFailure = withOneSerializationFailure(
      runtime,
      "UPDATE run_claims SET expires_at",
    );
    const heartbeatRetrying = new PgExecutionPersistence(heartbeatFailure.pool);
    const renewed = await heartbeatRetrying.inspectAndRenew({
      fence: claimed.fence,
      leaseDurationMs: 30_000,
    });
    expect(renewed.outcome).toBe("active");
    expect(heartbeatFailure.rejectionCount()).toBe(1);
    if (renewed.outcome !== "active") throw new Error("heartbeat 续租失败");
    const activeFence = renewed.fence;
    const call = {
      callId: "call-permit-serializable-retry",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("e".repeat(64)),
    };
    const registered = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/permit-serializable-retry/event`,
        fence: activeFence,
        expectedAttemptVersion: 0,
        events: [
          {
            schemaVersion: 1,
            kind: "agent_event",
            sequence: 0,
            payload: { type: "tool.started", callId: call.callId, name: call.toolName },
          },
        ],
        outbox: [],
        effectInvocation: { callId: call.callId, toolName: call.toolName },
      }),
    );
    expect(registered.outcome).toBe("applied");

    const issueFailure = withOneSerializationFailure(
      runtime,
      "INSERT INTO external_effect_permits",
    );
    const issueRetrying = new PgExecutionPersistence(issueFailure.pool);
    const permit = await issueRetrying.issueExternalEffectPermit({
      fence: activeFence,
      expectedAttemptVersion: 1,
      effect: "tool_execution",
      call,
      permitDurationMs: 3_000,
    });
    expect(permit.outcome).toBe("authorized");
    expect(issueFailure.rejectionCount()).toBe(1);
    if (permit.outcome !== "authorized") throw new Error("permit 失败");

    const consumeFailure = withOneSerializationFailure(
      runtime,
      "UPDATE external_effect_permits SET consumed_at",
    );
    const consumeRetrying = new PgExecutionPersistence(consumeFailure.pool);
    await expect(
      consumeRetrying.consumeExternalEffectPermit({
        fence: activeFence,
        expectedAttemptVersion: 1,
        permit: permit.permit,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
    expect(consumeFailure.rejectionCount()).toBe(1);
  });

  it("许可消费在瞬时连接失败和 COMMIT 响应丢失后安全收敛，独立重放仍被拒绝", async () => {
    const f = await fixture(`permit-connection-recovery-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "permit-connection-recovery-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const firstCall = {
      callId: "call-permit-transient-connection",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("7".repeat(64)),
    };
    expect(
      await persistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/permit-transient/event`,
          fence: claimed.fence,
          expectedAttemptVersion: 0,
          events: [
            {
              schemaVersion: 1,
              kind: "agent_event",
              sequence: 0,
              payload: { type: "tool.started", callId: firstCall.callId, name: firstCall.toolName },
            },
          ],
          outbox: [],
          effectInvocation: { callId: firstCall.callId, toolName: firstCall.toolName },
        }),
      ),
    ).toMatchObject({ outcome: "applied", attemptVersion: 1 });
    const firstPermit = await persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 1,
      effect: "tool_execution",
      call: firstCall,
      permitDurationMs: 3_000,
    });
    if (firstPermit.outcome !== "authorized") throw new Error("瞬时故障测试许可未签发");
    const transient = withOneTransientStatementFailure(
      runtime,
      "UPDATE external_effect_permits SET consumed_at",
    );
    await expect(
      new PgExecutionPersistence(transient.pool).consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        permit: firstPermit.permit,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
    expect(transient.rejectionCount()).toBe(1);

    const secondCall = {
      callId: "call-permit-lost-commit-response",
      toolName: "sandbox_read_file",
      argsDigest: sha256Digest("8".repeat(64)),
    };
    expect(
      await persistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/permit-lost-commit/event`,
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          events: [
            {
              schemaVersion: 1,
              kind: "agent_event",
              sequence: 1,
              payload: {
                type: "tool.started",
                callId: secondCall.callId,
                name: secondCall.toolName,
              },
            },
          ],
          outbox: [],
          effectInvocation: { callId: secondCall.callId, toolName: secondCall.toolName },
        }),
      ),
    ).toMatchObject({ outcome: "applied", attemptVersion: 2 });
    const secondPermit = await persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 2,
      effect: "tool_execution",
      call: secondCall,
      permitDurationMs: 3_000,
    });
    if (secondPermit.outcome !== "authorized") throw new Error("提交未知测试许可未签发");
    await expect(
      new PgExecutionPersistence(withLostCommitResponse(runtime)).consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        permit: secondPermit.permit,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
    await expect(
      persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        permit: secondPermit.permit,
      }),
    ).resolves.toEqual({ outcome: "already_consumed" });
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

  it("SERIALIZABLE 事务被明确回滚后自动重放同一幂等 mutation", async () => {
    const f = await fixture(`serializable-retry-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "serializable-retry-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const injected = withOneSerializationFailure(runtime, "UPDATE execution_attempts");
    const retrying = new PgExecutionPersistence(injected.pool);
    const command = signed({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/serializable-retry`,
      fence: claimed.fence,
      expectedAttemptVersion: 0,
      nextAttemptStatus: "running",
      events: [],
      outbox: [],
    });

    await expect(retrying.mutate(command)).resolves.toMatchObject({
      outcome: "applied",
      attemptVersion: 1,
    });
    expect(injected.rejectionCount()).toBe(1);
    await expect(
      persistence.readMutation({
        scope: f.scope,
        idempotencyKey: command.idempotencyKey,
      }),
    ).resolves.toMatchObject({ outcome: "applied", attemptVersion: 1 });
  });

  it("实时事件通知只唤醒已提交事实，事务回滚和幂等重放不重复发布", async () => {
    const f = await fixture(`event-stream-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "event-stream-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const listener = new PgRunEventWakeListener(
      createPostgresPool({ connectionString: runtimeConnectionString, schema, maxConnections: 1 }),
    );
    const wake = vi.fn();
    listener.subscribe(f.scope.tenantId, f.scope.runId, wake);
    try {
      await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
      wake.mockClear();
      const client = await runtime.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_notify($1,$2)", [
          RUN_EVENT_WAKE_CHANNEL,
          runEventWakeKey(f.scope.tenantId, f.scope.runId),
        ]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wake).not.toHaveBeenCalled();
      const command = signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/event-stream`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        events: [0, 1].map((sequence) => ({
          schemaVersion: 1 as const,
          kind: "agent_event" as const,
          sequence,
          payload: { type: "message.delta", delta: `实时文字${sequence}` },
        })),
        outbox: [],
      });
      await expect(persistence.mutate(command)).resolves.toMatchObject({ outcome: "applied" });
      await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
      const read = await new PgRunExperienceReadRepository(runtime).listEvents({
        scope: { tenantId: f.scope.tenantId, userId: f.user.id },
        runId: f.scope.runId,
        after: -1,
        limit: 32,
      });
      expect(read).toMatchObject({
        outcome: "found",
        events: [{ sequence: 0 }, { sequence: 1 }],
        hasMore: false,
      });
      await expect(persistence.mutate(command)).resolves.toMatchObject({
        outcome: "already_applied",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wake).toHaveBeenCalledOnce();
    } finally {
      await listener.close();
    }
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
      providerKey: "cube" as const,
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
          providerKey: "cube",
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
      requiresResourceFilesystem: false,
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
        providerKey: "cube",
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
          providerKey: "cube",
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
      requiresResourceFilesystem: false,
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

  it("cleanup、Revision 终态与 Artifact 结算同事务，并隔离诊断类 Resource", async () => {
    const f = await fixture(`final-${suffix}`);
    await subscribeWebhook(f, ["run.succeeded", "artifact.published"]);
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
      payload: { registryId: "registry-pg", providerKey: "cube", providerSandboxId: "sandbox-pg" },
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
        rolloutProjection: { schemaVersion: 2, checkpointId: "projection-updated", items: [] },
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
    const lifecycleId = randomUUID();
    const incarnationId = randomUUID();
    const referenceId = `candidate-final-ref-${suffix}`;
    const blobOperationId = `candidate-final-${suffix}`.slice(0, 120);
    const contentSha256 = "b".repeat(64);
    const physicalObjectKey = `runtime/stable/${f.scope.tenantId}/workspace/sha256/${contentSha256}/incarnations/${incarnationId}`;
    const intentConsumedAt = new Date().toISOString();
    const scopedArtifactIntents = (["diagnostic", "trace"] as const).map((purpose, index) => ({
      purpose,
      callId: `workspace-${purpose}-call-${suffix}`,
      permitId: `workspace-${purpose}-permit-${suffix}`,
      argsDigest: (index === 0 ? "c" : "d").repeat(64),
      commandDigest: (index === 0 ? "e" : "f").repeat(64),
      requestedArtifactId: `workspace-${purpose}-requested-${suffix}`,
      artifactId: `workspace-${purpose}-artifact-${suffix}`,
      resourceId: `workspace-${purpose}-resource-${suffix}`,
      resourceVersionId: `workspace-${purpose}-version-${suffix}`,
      blobReferenceId: `workspace-${purpose}-binding-ref-${suffix}`,
      blobOperationId: `workspace-${purpose}-binding-${suffix}`.slice(0, 120),
      idempotencyKey: `workspace-${purpose}-intent-${suffix}`,
      consumedAt: intentConsumedAt,
    }));
    const manifest = createWorkspaceManifest(
      {
        tenantId: f.scope.tenantId,
        entries: [
          {
            type: "file",
            path: "final.txt",
            content: { sha256: contentSha256, size: 1 },
            object: {
              tenantId: f.scope.tenantId,
              purpose: "workspace",
              incarnationId,
              physicalObjectKey,
            },
          },
        ],
      },
      { maxFiles: 1, maxTotalBytes: 1 },
    );
    const candidateUnsigned = {
      tenantId: f.scope.tenantId,
      threadId: f.scope.threadId,
      workspaceId: f.scope.workspaceId,
      attemptId: claimed.snapshot.attempt.attemptId,
      runId: f.scope.runId,
      rootRunId: f.scope.rootRunId,
      revisionId: revision,
      operationKey: `${claimed.snapshot.attempt.attemptId}/workspace/final`,
    };
    const candidate = {
      ...candidateUnsigned,
      operationDigest: workspaceCandidateOperationDigest(candidateUnsigned),
    };
    const handoff = new PgWorkspaceCandidateHandoff(runtime, {
      maxEntries: 1,
      maxFiles: 1,
      maxTotalBytes: 1,
      maxSingleFileBytes: 1,
      maxChunkBytes: 1,
      maxPathUtf8Bytes: 128,
      historicalManifest: { maxFiles: 1, maxTotalBytes: 1 },
    });
    await handoff.begin(candidate);
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO blob_lifecycles(
           tenant_id,lifecycle_id,purpose,sha256,size,state,current_incarnation_id
         ) VALUES ($1,$2,'workspace',$3,1,'active',$4)`,
        [f.scope.tenantId, lifecycleId, contentSha256, incarnationId],
      );
      await client.query(
        `INSERT INTO blob_incarnations(
           tenant_id,lifecycle_id,purpose,sha256,size,incarnation_id,physical_object_key,state
         ) VALUES ($1,$2,'workspace',$3,1,$4,$5,'active')`,
        [f.scope.tenantId, lifecycleId, contentSha256, incarnationId, physicalObjectKey],
      );
      await client.query(
        `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot)
         VALUES ($1,$2,'completed',1,'{}'::jsonb)`,
        [f.scope.tenantId, blobOperationId],
      );
      await client.query(
        `INSERT INTO blob_references(
           tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,
           staging_upload_id,lifecycle_id,incarnation_id,physical_object_key
         ) VALUES ($1,$2,$3,'stable','workspace',$4,1,'application/octet-stream',
                   'candidate-final-upload',$5,$6,$7)`,
        [
          f.scope.tenantId,
          referenceId,
          blobOperationId,
          contentSha256,
          lifecycleId,
          incarnationId,
          physicalObjectKey,
        ],
      );
      await client.query(
        `INSERT INTO workspace_revision_candidate_files(
           tenant_id,workspace_id,attempt_id,run_id,thread_id,root_run_id,parent_revision_id,
           revision_id,operation_key,operation_digest,relative_path,source,content_sha256,size,
           blob_lifecycle_id,blob_incarnation_id,physical_object_key,blob_reference_id
         ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,'final.txt','uploaded',$10,1,$11,$12,$13,$14)`,
        [
          f.scope.tenantId,
          f.scope.workspaceId,
          claimed.snapshot.attempt.attemptId,
          f.scope.runId,
          f.scope.threadId,
          f.scope.rootRunId,
          revision,
          candidate.operationKey,
          candidate.operationDigest,
          contentSha256,
          lifecycleId,
          incarnationId,
          physicalObjectKey,
          referenceId,
        ],
      );
      for (const intent of scopedArtifactIntents) {
        await client.query(
          `INSERT INTO effect_invocations(tenant_id,attempt_id,call_id,tool_name)
           VALUES($1,$2,$3,'publish_artifact')`,
          [f.scope.tenantId, claimed.snapshot.attempt.attemptId, intent.callId],
        );
        await client.query(
          `INSERT INTO external_effect_permits(
             tenant_id,permit_id,attempt_id,effect,call_id,tool_name,args_digest,
             attempt_version,run_claim_token,run_claim_epoch,workspace_root_run_id,
             workspace_lease_epoch,issued_at,expires_at,consumed_at
           ) VALUES(
             $1,$2,$3,'tool_execution',$4,'publish_artifact',$5,3,$6,$7,$8,$9,
             $10::timestamptz-interval '1 second',$10::timestamptz+interval '10 minutes',$10
           )`,
          [
            f.scope.tenantId,
            intent.permitId,
            claimed.snapshot.attempt.attemptId,
            intent.callId,
            intent.argsDigest,
            claimed.fence.runClaim.token,
            claimed.fence.runClaim.epoch,
            f.scope.rootRunId,
            claimed.fence.workspaceLease.epoch,
            intent.consumedAt,
          ],
        );
      }
    });
    const invalidIntent = scopedArtifactIntents[0];
    if (invalidIntent === undefined) throw new Error("缺少 Artifact intent fixture");
    await expect(
      withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, (client) =>
        client.query(
          `INSERT INTO workspace_artifact_publication_intents(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             call_id,permit_id,permit_consumed_at,idempotency_key,command_digest,
             tool_args_digest,requested_artifact_id,artifact_id,resource_id,
             resource_version_id,blob_reference_id,blob_operation_id,name,purpose,
             source_relative_path,resource_name
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             '伪造诊断','diagnostic','final.txt','伪造诊断'
           )`,
          [
            f.scope.tenantId,
            claimed.snapshot.attempt.attemptId,
            f.scope.runId,
            f.scope.threadId,
            f.scope.workspaceId,
            f.scope.rootRunId,
            invalidIntent.callId,
            invalidIntent.permitId,
            invalidIntent.consumedAt,
            `${invalidIntent.idempotencyKey}-forged`,
            invalidIntent.commandDigest,
            "0".repeat(64),
            `${invalidIntent.requestedArtifactId}-forged`,
            `${invalidIntent.artifactId}-forged`,
            `${invalidIntent.resourceId}-forged`,
            `${invalidIntent.resourceVersionId}-forged`,
            `${invalidIntent.blobReferenceId}-forged`,
            `${invalidIntent.blobOperationId}-forged`,
          ],
        ),
      ),
    ).rejects.toThrow();
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      for (const intent of scopedArtifactIntents) {
        await client.query(
          `INSERT INTO workspace_artifact_publication_intents(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             call_id,permit_id,permit_consumed_at,idempotency_key,command_digest,
             tool_args_digest,requested_artifact_id,artifact_id,resource_id,
             resource_version_id,blob_reference_id,blob_operation_id,name,purpose,
             source_relative_path,resource_name
           ) VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,'final.txt',$21
           )`,
          [
            f.scope.tenantId,
            claimed.snapshot.attempt.attemptId,
            f.scope.runId,
            f.scope.threadId,
            f.scope.workspaceId,
            f.scope.rootRunId,
            intent.callId,
            intent.permitId,
            intent.consumedAt,
            intent.idempotencyKey,
            intent.commandDigest,
            intent.argsDigest,
            intent.requestedArtifactId,
            intent.artifactId,
            intent.resourceId,
            intent.resourceVersionId,
            intent.blobReferenceId,
            intent.blobOperationId,
            `${intent.purpose} 证据`,
            intent.purpose,
            `${intent.purpose} 证据`,
          ],
        );
      }
    });
    await handoff.prepare({ identity: candidate, manifest });
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
        candidateOperationKey: candidate.operationKey,
        candidateOperationDigest: sha256Digest(candidate.operationDigest),
        manifest,
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
    // 终态与 Artifact 事件和业务事实同事务提交；COMMIT 响应丢失后的重放不重复入队，
    // Artifact 载荷不包含文件名。
    const webhookEvents = await webhookOutbox(f);
    expect(webhookEvents.map((event) => event.event_type).sort()).toEqual([
      "artifact.published",
      "artifact.published",
      "run.succeeded",
    ]);
    for (const event of webhookEvents)
      expect(Object.keys(event.payload.data).sort()).toEqual(
        event.event_type === "run.succeeded" ? ["runId", "status"] : ["artifactId", "runId"],
      );
    await persistence.mutate(finalCommand);
    expect(await webhookOutbox(f)).toHaveLength(3);
    const committedFacts = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => ({
        candidate: await client.query<{ readonly status: string }>(
          `SELECT status FROM workspace_revision_candidates
            WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4`,
          [
            f.scope.tenantId,
            f.scope.workspaceId,
            claimed.snapshot.attempt.attemptId,
            candidate.operationKey,
          ],
        ),
        reference: await client.query<{ readonly state: string }>(
          `SELECT state FROM blob_references WHERE tenant_id=$1 AND reference_id=$2`,
          [f.scope.tenantId, referenceId],
        ),
        file: await client.query<{ readonly relative_path: string }>(
          `SELECT relative_path FROM workspace_revision_files
            WHERE tenant_id=$1 AND workspace_id=$2 AND revision_id=$3`,
          [f.scope.tenantId, f.scope.workspaceId, revision],
        ),
        artifactResources: await client.query<{
          readonly id: string;
          readonly origin: string;
          readonly visibility: string;
        }>(
          `SELECT id,origin,visibility FROM resources
            WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id`,
          [f.scope.tenantId, scopedArtifactIntents.map((intent) => intent.resourceId)],
        ),
      }),
      { readOnly: true },
    );
    expect(committedFacts.candidate.rows[0]?.status).toBe("committed");
    expect(committedFacts.reference.rows[0]?.state).toBe("released");
    expect(committedFacts.file.rows).toEqual([{ relative_path: "final.txt" }]);
    expect(committedFacts.artifactResources.rows).toHaveLength(2);
    expect(
      committedFacts.artifactResources.rows.every(
        (resource) =>
          resource.origin === "artifact" && resource.visibility === "pending_explicit_commit",
      ),
    ).toBe(true);
    const catalog = new PgResourceCatalog(runtime);
    const catalogPage = await catalog.search({
      context: { tenantId: f.scope.tenantId, userId: f.user.id },
      normalizedQuery: "",
      limit: 100,
    });
    expect(catalogPage.items.map((item) => item.resourceId)).not.toEqual(
      expect.arrayContaining(scopedArtifactIntents.map((intent) => intent.resourceId)),
    );
    const stableAccess = new PgWorkspaceStableBlobAccess(runtime, {} as BlobStore);
    const authorizationInput = {
      scope: {
        tenantId: f.scope.tenantId,
        threadId: f.scope.threadId,
        workspaceId: f.scope.workspaceId,
      },
      purpose: "workspace_materialization" as const,
      revisionId: revision,
      relativePath: "final.txt",
      content: { sha256: contentSha256, size: 1 },
      object: {
        tenantId: f.scope.tenantId,
        purpose: "workspace" as const,
        incarnationId,
        physicalObjectKey,
      },
    };
    await expect(stableAccess.authorize(authorizationInput)).resolves.toMatchObject({
      status: "authorized",
      receipt: {
        threadId: f.scope.threadId,
        workspaceId: f.scope.workspaceId,
        revisionId: revision,
        relativePath: "final.txt",
      },
    });
    await expect(
      stableAccess.authorize({ ...authorizationInput, relativePath: "other.txt" }),
    ).resolves.toEqual({ status: "denied" });
  });

  it("终态 mutation 原子释放 building candidate 与 uploaded stable 引用", async () => {
    const f = await fixture(`candidate-release-${suffix}`);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "candidate-release-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("candidate release claim 失败");
    const revision = workspaceRevisionId(`candidate-release-revision-${suffix}`);
    const unsignedCandidate = {
      tenantId: f.scope.tenantId,
      threadId: f.scope.threadId,
      workspaceId: f.scope.workspaceId,
      attemptId: claimed.snapshot.attempt.attemptId,
      runId: f.scope.runId,
      rootRunId: f.scope.rootRunId,
      revisionId: revision,
      operationKey: `${claimed.snapshot.attempt.attemptId}/workspace/release`,
    };
    const candidate = {
      ...unsignedCandidate,
      operationDigest: workspaceCandidateOperationDigest(unsignedCandidate),
    };
    const handoff = new PgWorkspaceCandidateHandoff(runtime, {
      maxEntries: 1,
      maxFiles: 1,
      maxTotalBytes: 8,
      maxSingleFileBytes: 8,
      maxChunkBytes: 8,
      maxPathUtf8Bytes: 128,
      historicalManifest: { maxFiles: 1, maxTotalBytes: 8 },
    });
    await handoff.begin(candidate);
    const lifecycleId = randomUUID();
    const incarnationId = randomUUID();
    const referenceId = `candidate-release-ref-${suffix}`;
    const blobOperationId = `candidate-release-${suffix}`.slice(0, 120);
    const sha256 = "c".repeat(64);
    const physicalObjectKey = `runtime/stable/${f.scope.tenantId}/workspace/sha256/${sha256}/incarnations/${incarnationId}`;
    await withTenantTransaction(runtime, { tenantId: f.scope.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO blob_lifecycles(
           tenant_id,lifecycle_id,purpose,sha256,size,state,current_incarnation_id
         ) VALUES ($1,$2,'workspace',$3,1,'active',$4)`,
        [f.scope.tenantId, lifecycleId, sha256, incarnationId],
      );
      await client.query(
        `INSERT INTO blob_incarnations(
           tenant_id,lifecycle_id,purpose,sha256,size,incarnation_id,physical_object_key,state
         ) VALUES ($1,$2,'workspace',$3,1,$4,$5,'active')`,
        [f.scope.tenantId, lifecycleId, sha256, incarnationId, physicalObjectKey],
      );
      await client.query(
        `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot)
         VALUES ($1,$2,'completed',1,'{}'::jsonb)`,
        [f.scope.tenantId, blobOperationId],
      );
      await client.query(
        `INSERT INTO blob_references(
           tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,
           staging_upload_id,lifecycle_id,incarnation_id,physical_object_key
         ) VALUES ($1,$2,$3,'stable','workspace',$4,1,'application/octet-stream',
                   'candidate-release-upload',$5,$6,$7)`,
        [
          f.scope.tenantId,
          referenceId,
          blobOperationId,
          sha256,
          lifecycleId,
          incarnationId,
          physicalObjectKey,
        ],
      );
      await client.query(
        `INSERT INTO workspace_revision_candidate_files(
           tenant_id,workspace_id,attempt_id,run_id,thread_id,root_run_id,parent_revision_id,
           revision_id,operation_key,operation_digest,relative_path,source,content_sha256,size,
           blob_lifecycle_id,blob_incarnation_id,physical_object_key,blob_reference_id
         ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,'new.txt','uploaded',$10,1,$11,$12,$13,$14)`,
        [
          f.scope.tenantId,
          f.scope.workspaceId,
          claimed.snapshot.attempt.attemptId,
          f.scope.runId,
          f.scope.threadId,
          f.scope.rootRunId,
          revision,
          candidate.operationKey,
          candidate.operationDigest,
          sha256,
          lifecycleId,
          incarnationId,
          physicalObjectKey,
          referenceId,
        ],
      );
    });
    const terminal = await persistence.mutate(
      signed({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/terminal/release-candidate`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "failed",
        nextRunStatus: "failed",
        events: [],
        outbox: [],
        releaseFences: true,
      }),
    );
    expect(terminal.outcome).toBe("applied");
    const released = await withTenantTransaction(
      runtime,
      { tenantId: f.scope.tenantId },
      async (client) => ({
        candidate: await client.query<{ readonly status: string; readonly release_reason: string }>(
          `SELECT status,release_reason FROM workspace_revision_candidates
            WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4`,
          [
            f.scope.tenantId,
            f.scope.workspaceId,
            claimed.snapshot.attempt.attemptId,
            candidate.operationKey,
          ],
        ),
        reference: await client.query<{ readonly state: string }>(
          `SELECT state FROM blob_references WHERE tenant_id=$1 AND reference_id=$2`,
          [f.scope.tenantId, referenceId],
        ),
      }),
      { readOnly: true },
    );
    expect(released.candidate.rows[0]).toEqual({ status: "released", release_reason: "terminal" });
    expect(released.reference.rows[0]?.state).toBe("released");
  });

  it("租约过期由恢复协调器收敛，普通 claim 不越过 running Run", async () => {
    const f = await fixture(`recover-${suffix}`);
    await subscribeWebhook(f, ["run.failed"]);
    const claimed = await persistence.claim({
      scope: f.scope,
      workerId: "recover-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("claim 失败");
    const recoveryRevision = workspaceRevisionId(`recover-candidate-revision-${suffix}`);
    const recoveryCandidateUnsigned = {
      tenantId: f.scope.tenantId,
      threadId: f.scope.threadId,
      workspaceId: f.scope.workspaceId,
      attemptId: claimed.snapshot.attempt.attemptId,
      runId: f.scope.runId,
      rootRunId: f.scope.rootRunId,
      revisionId: recoveryRevision,
      operationKey: `${claimed.snapshot.attempt.attemptId}/workspace/recovery`,
    };
    const recoveryCandidate = {
      ...recoveryCandidateUnsigned,
      operationDigest: workspaceCandidateOperationDigest(recoveryCandidateUnsigned),
    };
    await new PgWorkspaceCandidateHandoff(runtime, {
      maxEntries: 1,
      maxFiles: 1,
      maxTotalBytes: 1,
      maxSingleFileBytes: 1,
      maxChunkBytes: 1,
      maxPathUtf8Bytes: 128,
      historicalManifest: { maxFiles: 1, maxTotalBytes: 1 },
    }).begin(recoveryCandidate);
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
        const result = await client.query<{
          run_status: string;
          attempt_status: string;
          candidate_status: string;
          release_reason: string;
        }>(
          `SELECT run.status AS run_status,attempt.status AS attempt_status,
                  candidate.status AS candidate_status,candidate.release_reason
             FROM runs run JOIN execution_attempts attempt
               ON attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
             JOIN workspace_revision_candidates candidate
               ON candidate.tenant_id=attempt.tenant_id AND candidate.attempt_id=attempt.attempt_id
            WHERE run.tenant_id=$1 AND run.id=$2`,
          [f.scope.tenantId, f.scope.runId],
        );
        return result.rows[0];
      },
      { readOnly: true },
    );
    expect(state).toEqual({
      run_status: "failed",
      attempt_status: "failed",
      candidate_status: "released",
      release_reason: "expired_recovery",
    });
    // 过期 Attempt 的安全失败同样是 Run 终态转换，必须与转换同事务入队。
    expect((await webhookOutbox(f)).map((event) => [event.event_type, event.payload.data])).toEqual(
      [["run.failed", { runId: f.scope.runId, status: "failed" }]],
    );

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
    await expect(
      repositories.runs.get(
        { tenantId: unsafe.scope.tenantId, userId: unsafe.user.id },
        unsafe.scope.runId,
      ),
    ).resolves.toMatchObject({
      entity: { status: "running" },
      executionStatus: "recovery_required",
    });
  });

  it("过期 finalizing Attempt 原子隔离 Thread Sandbox 并登记唯一 terminate effect", async () => {
    const f = await serialQueueFixture(`expired-finalizing-${suffix}`);
    const creation = new PgRunDispatchCreation(runtime, { serialQueueV2Enabled: true });
    const sandboxPersistence = new PgExecutionPersistence(runtime, {
      threadSandboxSessionReuseEnabled: true,
      threadSandboxHandoffLeaseMs: 30_000,
    });
    const baseProvider = fakeThreadSandboxProvider(new FakeSandboxGateway());
    const uniqueProvider: ThreadSandboxProviderPort = {
      ...baseProvider,
      create: async (input) => {
        const result = await baseProvider.create(input);
        return result.outcome !== "ready"
          ? result
          : {
              ...result,
              session: {
                ...result.session,
                providerSandboxId: `expired-finalizing-provider-${randomUUID()}`,
              },
            };
      },
    };
    const lifecycle = new PgThreadSandboxSessionLifecycle(runtime, uniqueProvider, {
      pausedRetentionSeconds: 600,
      transitionWaitMs: 1_000,
    });
    const run = createRun({
      id: runId(`expired-finalizing-run-${suffix}`),
      thread: f.thread,
      now: isoTimestamp("2099-07-26T00:00:00.000Z"),
    });
    await expect(
      creation.createQueuedRun({
        scope: f.tenantScope,
        run,
        thread: f.thread,
        inputText: "构造 finalizing 恢复",
        idempotency: {
          key: `expired-finalizing-key-${suffix}`,
          requestHash: requestDigest("构造 finalizing 恢复"),
        },
      }),
    ).resolves.toMatchObject({ outcome: "created" });
    const dispatch = (
      await runDispatchOutbox.claim({
        tenantId: f.tenantScope.tenantId,
        dispatcherId: "expired-finalizing-dispatcher",
        limit: 10,
        leaseMilliseconds: 30_000,
      })
    )[0];
    if (dispatch === undefined) throw new Error("恢复测试 dispatch 缺失");
    const claimed = await sandboxPersistence.claim({
      scope: dispatch.scope as ExecutionScope,
      workerId: "expired-finalizing-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("恢复测试 claim 失败");
    await runDispatchOutbox.acknowledge({ claim: dispatch, outcome: "dispatched" });
    const acquired = await lifecycle.acquire({
      scope: claimed.fence.scope,
      attemptId: claimed.snapshot.attempt.attemptId,
      owner: "expired-finalizing-worker",
      leaseDurationMs: 30_000,
      signal: new AbortController().signal,
      requiresResourceFilesystem: false,
    });
    if (acquired.outcome !== "ready") {
      throw new Error(`恢复测试 Sandbox acquire 失败：${JSON.stringify(acquired)}`);
    }
    expect(
      await sandboxPersistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/model-started`,
          fence: claimed.fence,
          expectedAttemptVersion: 0,
          nextAttemptStatus: "running",
          nextStage: "model_execution_started",
          events: [],
          outbox: [],
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await sandboxPersistence.mutate(
        signed({
          idempotencyKey: `${claimed.snapshot.attempt.attemptId}/finalizing`,
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          nextAttemptStatus: "finalizing",
          nextStage: "finalizing",
          events: [],
          outbox: [],
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    await admin.query(
      `UPDATE "${schema}".run_claims
          SET expires_at=acquired_at+interval '1 millisecond'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [f.tenantScope.tenantId, claimed.snapshot.attempt.attemptId],
    );
    await admin.query(
      `UPDATE "${schema}".workspace_write_leases
          SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND workspace_id=$2`,
      [f.tenantScope.tenantId, f.workspace.id],
    );

    await expect(
      sandboxPersistence.claim({
        scope: claimed.fence.scope,
        workerId: "expired-finalizing-late-worker",
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual({ outcome: "recovery_required" });
    await expect(
      sandboxPersistence.recoverExpiredAttempt({
        scope: claimed.fence.scope,
        decision: "require_manual_recovery",
      }),
    ).resolves.toBe("recovered");
    await expect(
      sandboxPersistence.recoverExpiredAttempt({
        scope: claimed.fence.scope,
        decision: "require_manual_recovery",
      }),
    ).resolves.toBe("recovered");

    const recovered = await withTenantTransaction(
      runtime,
      f.tenantScope,
      async (client) => {
        const attempt = await client.query<{ readonly status: string }>(
          `SELECT status FROM execution_attempts WHERE tenant_id=$1 AND attempt_id=$2`,
          [f.tenantScope.tenantId, claimed.snapshot.attempt.attemptId],
        );
        const session = await client.query<{ readonly state: string }>(
          `SELECT state FROM thread_sandbox_sessions WHERE tenant_id=$1 AND session_id=$2`,
          [f.tenantScope.tenantId, acquired.lease.sessionId],
        );
        const lease = await client.query<{ readonly released: boolean }>(
          `SELECT released_at IS NOT NULL AS released FROM thread_sandbox_leases
            WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3`,
          [f.tenantScope.tenantId, acquired.lease.sessionId, acquired.lease.leaseId],
        );
        const effects = await client.query<{
          readonly state: string;
          readonly effect_kind: string;
        }>(
          `SELECT state,effect_kind FROM sandbox_lifecycle_effects
            WHERE tenant_id=$1 AND attempt_id=$2 AND effect_kind='terminate'`,
          [f.tenantScope.tenantId, claimed.snapshot.attempt.attemptId],
        );
        return {
          attempt: attempt.rows[0],
          session: session.rows[0],
          lease: lease.rows[0],
          effects: effects.rows,
        };
      },
      { readOnly: true },
    );
    expect(recovered).toEqual({
      attempt: { status: "recovery_required" },
      session: { state: "unknown" },
      lease: { released: true },
      effects: [{ state: "pending", effect_kind: "terminate" }],
    });

    const effectStore = new PgThreadSandboxLifecycleConsumerStore(runtime, 600, true);
    const effectClaim = await effectStore.claimNext({
      tenantId: f.tenantScope.tenantId,
      workerId: "expired-finalizing-effect-worker",
      leaseMs: 30_000,
    });
    if (effectClaim === undefined) throw new Error("恢复测试 terminate effect 缺失");
    expect(effectClaim).toMatchObject({ effectKind: "terminate", mode: "execute" });
    expect(await effectStore.markRemoteStarted(effectClaim)).toBe(true);
    expect(await effectStore.resolve(effectClaim, "terminated")).toBe(true);
    const terminated = await withTenantTransaction(
      runtime,
      f.tenantScope,
      (client) =>
        client.query<{ readonly state: string }>(
          `SELECT state FROM thread_sandbox_sessions WHERE tenant_id=$1 AND session_id=$2`,
          [f.tenantScope.tenantId, acquired.lease.sessionId],
        ),
      { readOnly: true },
    );
    expect(terminated.rows[0]?.state).toBe("terminated");
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
});
