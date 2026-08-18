import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { encodeControlledToolReceipt, ToolObservationPipeline } from "@hoox/context-policy";
import {
  agentThreadId,
  artifactId,
  isoTimestamp,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@hoox/domain";
import type {
  ExecutionFence,
  ExecutionScope,
  SandboxSessionRegistryPort,
} from "@hoox/run-contracts";
import { rolloutProjectionDigest } from "@hoox/run-contracts/mutation-protocol";
import { FakeSandboxGateway } from "@hoox/sandbox/testing";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDurableObservationSession } from "../../runtime-ts/apps/agent-worker/src/pg-observation-assembly.js";
import { PiWorkerSessionFactory } from "../../runtime-ts/apps/agent-worker/src/pi-session-factory.js";
import {
  startWorkerProcess,
  WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
} from "../../runtime-ts/apps/agent-worker/src/process-entry.js";
import {
  AgentWorkerPollingLoop,
  SystemWorkerClock,
} from "../../runtime-ts/apps/agent-worker/src/production-worker-runtime.js";
import { RunWorker } from "../../runtime-ts/apps/agent-worker/src/run-worker.js";
import {
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
} from "../../runtime-ts/apps/agent-worker/src/testing/fakes.js";
import {
  ArtifactDeliveryService,
  createArtifactExecutionAuthorizationAuthority,
  PgArtifactDeliveryRepository,
  PgSimpleDeliveredFileRepository,
  SimpleArtifactDeliveryService,
} from "../../runtime-ts/packages/artifact/src/index.js";
import {
  type BlobCommitSnapshot,
  type BlobStore,
  type CreateS3BlobStoreConfig,
  createDurableTraceBlobPersistence,
  createS3BlobStore,
  createS3RetiredBlobTombstoneScrubber,
  createS3StableBlobGarbageCollector,
  DurableResourceBlobWriter,
  PgBackedSandboxSessionRegistry,
  PgExecutionPersistence,
  PgModelWireTraceCleanupRepository,
  PgModelWireTraceRepository,
  PgRunDispatchOutbox,
  PgWorkerTenantAssignments,
  type StableBlobLifecycleAllocation,
  type StableBlobRef,
  type StagedBlobRef,
  sha256Hex,
  type TenantBlobScope,
  transitionBlobCommit,
} from "../../runtime-ts/packages/persistence/src/index.js";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgBlobLifecycleRepository } from "../../runtime-ts/packages/persistence/src/pg-blob-lifecycle.js";
import { PgRuntimeRolloutRepository } from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { PgToolObservationRolloutAdapter } from "../../runtime-ts/packages/persistence/src/tool-observation-rollout-adapter.js";
import { DeliverFileToolRouterFactory } from "../../runtime-ts/packages/tool-router/src/deliver-file.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Blob 生命周期集成测试缺少 ${name}；不会输出配置值`);
  }
  return value;
}

const runtimeDatabaseUrl = requiredEnvironment("DATABASE_URL");
const bootstrapDatabaseUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const migrationDatabaseUrl = requiredEnvironment("MIGRATION_DATABASE_URL");
const runtimeRole = requiredEnvironment("DATABASE_RUNTIME_ROLE");
const configuredMigratorRole = requiredEnvironment("DATABASE_MIGRATOR_ROLE");
const schema = `it_blob_${process.pid}_${Date.now()}`;
const databaseName = new URL(bootstrapDatabaseUrl).pathname.slice(1);
const migratorRole = `it_bl_mg_${process.pid}_${Date.now().toString(36)}`;
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherRole = `it_bl_pub_${process.pid}_${Date.now().toString(36)}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorRole = `it_bl_coord_${process.pid}_${Date.now().toString(36)}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const workerCoordinatorDatabaseUrl = new URL(migrationDatabaseUrl);
workerCoordinatorDatabaseUrl.username = workerCoordinatorRole;
workerCoordinatorDatabaseUrl.password = workerCoordinatorPassword;
const migrationSecurity = {
  runtimeRole,
  migratorRole,
  skillPublisherRole,
  workerCoordinatorRole,
  teamCoordinatorRole,
  schema,
} as const;

let administrativePool!: Pool;
let migratorPool!: Pool;
let runtimePool!: Pool;
let workerCoordinatorPool!: Pool;
let repository!: PgBlobLifecycleRepository;
let schemaCreated = false;
let migratorCreated = false;

const unique = randomUUID().replaceAll("-", "_");
const scopeA = { tenantId: `blob_tenant_a_${unique}` } as const;
const scopeB = { tenantId: `blob_tenant_b_${unique}` } as const;
const prefix = `pg-blob-integration/${unique}`;

function minioConfig(): CreateS3BlobStoreConfig {
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  return {
    bucket: requiredEnvironment("S3_BUCKET"),
    endpoint: requiredEnvironment("S3_ENDPOINT"),
    ...(publicEndpoint === undefined ? {} : { publicEndpoint }),
    region: requiredEnvironment("S3_REGION"),
    accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: true,
    prefix,
    maxPresignTtlSeconds: 60,
    maxBlobSizeBytes: 1024 * 1024,
  };
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: requiredEnvironment("S3_ENDPOINT"),
    region: requiredEnvironment("S3_REGION"),
    credentials: {
      accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
}

async function seedTenant(scope: TenantBlobScope, suffix: string): Promise<void> {
  const userId = `blob_user_${suffix}_${unique}`;
  await withTenantTransaction(runtimePool, { ...scope, userId }, async (client) => {
    await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, clock_timestamp())", [
      userId,
    ]);
    await client.query(
      "INSERT INTO tenants(id, kind, owner_user_id, created_at) VALUES ($1, 'personal', $2, clock_timestamp())",
      [scope.tenantId, userId],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id, id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'owner', 'active', clock_timestamp())`,
      [scope.tenantId, `blob_membership_${suffix}_${unique}`, userId],
    );
  });
}

async function migrationTenantQuery(
  scope: TenantBlobScope,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  await withTenantTransaction(migratorPool, scope, async (client) => {
    await client.query(sql, [...values]);
  });
}

async function seedModelWireAttempt(label: string, scope: TenantBlobScope) {
  const actorUserId = `blob_user_${scope === scopeA ? "a" : "b"}_${unique}`;
  const context = {
    tenantId: scope.tenantId,
    threadId: `wire_thread_${label}_${unique}`,
    runId: `wire_run_${label}_${unique}`,
    attemptId: `wire_attempt_${label}_${unique}`,
  };
  const workspaceId = `wire_workspace_${label}_${unique}`;
  const projectionDigest = sha256Hex(new TextEncoder().encode(`wire-${label}`));
  await withTenantTransaction(
    runtimePool,
    { tenantId: scope.tenantId, userId: actorUserId },
    async (client) => {
      await client.query(
        `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
       VALUES($1,$2,$3,'Wire Trace','active',clock_timestamp(),clock_timestamp())`,
        [scope.tenantId, context.threadId, actorUserId],
      );
      await client.query(
        `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
        [scope.tenantId, context.runId, context.threadId],
      );
      await client.query(
        `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at)
       VALUES($1,$2,$3,clock_timestamp(),clock_timestamp())`,
        [scope.tenantId, workspaceId, context.threadId],
      );
      await client.query(
        `INSERT INTO run_execution_inputs(
         tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
         initial_projection,initial_projection_digest
       ) VALUES($1,$2,$3,$4,$2,'wire','{}'::jsonb,$5)`,
        [scope.tenantId, context.runId, context.threadId, workspaceId, projectionDigest],
      );
      await client.query(
        `INSERT INTO execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage
       ) VALUES($1,$2,$3,$4,$5,$3,'running','model_execution_started')`,
        [scope.tenantId, context.attemptId, context.runId, context.threadId, workspaceId],
      );
    },
  );
  return context;
}

beforeAll(async () => {
  administrativePool = createPostgresPool({
    connectionString: bootstrapDatabaseUrl,
    maxConnections: 2,
  });
  await administrativePool.query(
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
  migratorPool = createPostgresPool({
    connectionString: testMigrationUrl.toString(),
    schema,
    maxConnections: 4,
  });
  runtimePool = createPostgresPool({
    connectionString: runtimeDatabaseUrl,
    schema,
    maxConnections: 12,
  });
  workerCoordinatorPool = createPostgresPool({
    connectionString: workerCoordinatorDatabaseUrl.toString(),
    schema,
    maxConnections: 2,
  });
  await migrateUp(migratorPool, migrationSecurity);
  await seedTenant(scopeA, "a");
  await seedTenant(scopeB, "b");
  repository = new PgBlobLifecycleRepository(runtimePool, {
    objectPrefix: prefix,
    gcLeaseSeconds: 1,
    promotionLeaseSeconds: 1,
    scrubLeaseSeconds: 1,
    scrubIntervalSeconds: 1,
  });
});

afterAll(async () => {
  if (runtimePool !== undefined) await runtimePool.end();
  if (workerCoordinatorPool !== undefined) await workerCoordinatorPool.end();
  if (migratorPool !== undefined) {
    await migrateDown(migratorPool, {
      ...migrationSecurity,
      allowDestructive: true,
      environment: "test",
      targetVersion: 0,
    });
    const residual = await migratorPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class
        WHERE relnamespace = current_schema()::regnamespace
          AND relkind IN ('r', 'p') AND relname <> 'runtime_schema_migrations'`,
    );
    expect(residual.rows[0]?.count).toBe("0");
    await migratorPool.end();
  }
  if (schemaCreated) await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await administrativePool.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}";
       DROP ROLE "${teamCoordinatorRole}";
       DROP ROLE "${workerCoordinatorRole}";
       DROP ROLE "${skillPublisherRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (administrativePool !== undefined) await administrativePool.end();
});

function staged(scope: TenantBlobScope, label: string, body?: Uint8Array): StagedBlobRef {
  const bytes = body ?? new TextEncoder().encode(label);
  return {
    kind: "staging",
    tenantId: scope.tenantId,
    purpose: "artifact",
    uploadId: `upload-${label}-${randomUUID()}`,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
    mediaType: "text/plain",
  };
}

function stableFrom(
  staging: StagedBlobRef,
  allocation: StableBlobLifecycleAllocation,
): StableBlobRef {
  return {
    kind: "stable",
    tenantId: allocation.tenantId,
    purpose: allocation.purpose,
    sha256: allocation.sha256,
    size: allocation.size,
    mediaType: staging.mediaType,
    incarnationId: allocation.incarnationId,
    physicalObjectKey: allocation.physicalObjectKey,
  };
}

function repositoryWithOneLostCommitResponse(): PgBlobLifecycleRepository {
  const originalConnect = runtimePool.connect.bind(runtimePool);
  let inject = true;
  const lossyPool = new Proxy(runtimePool, {
    get(target, property, receiver) {
      if (property !== "connect") return Reflect.get(target, property, receiver);
      return async () => {
        const client = await originalConnect();
        const originalMethod = client.query;
        const originalQuery = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          const result = await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(
            ...args,
          );
          if (inject && args[0] === "COMMIT") {
            // COMMIT 已在服务端生效，只丢失调用方响应；先恢复方法，避免污染归还连接。
            inject = false;
            client.query = originalMethod;
            throw Object.assign(new Error("模拟 COMMIT 成功后的响应丢失"), {
              code: "ECONNRESET",
            });
          }
          return result;
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return new PgBlobLifecycleRepository(lossyPool, {
    objectPrefix: prefix,
    gcLeaseSeconds: 1,
    promotionLeaseSeconds: 1,
    scrubLeaseSeconds: 1,
    scrubIntervalSeconds: 1,
  });
}

async function prepareAllocation(
  scope: TenantBlobScope,
  staging: StagedBlobRef,
  operationId: string,
): Promise<{
  readonly referenceId: string;
  readonly allocation: StableBlobLifecycleAllocation;
  readonly stable: StableBlobRef;
  readonly snapshotVersion: number;
}> {
  let snapshot: BlobCommitSnapshot = {
    operationId,
    scope,
    status: "upload_pending",
    version: 0,
  };
  await repository.create(snapshot);
  let next = transitionBlobCommit(snapshot, { type: "stage_verified", staged: staging });
  expect(
    await repository.compareAndSet({ scope, operationId, expectedVersion: snapshot.version, next }),
  ).toBe(true);
  snapshot = next;
  next = transitionBlobCommit(snapshot, { type: "reference_commit_started" });
  expect(
    await repository.compareAndSet({ scope, operationId, expectedVersion: snapshot.version, next }),
  ).toBe(true);
  snapshot = next;
  const { referenceId } = await repository.commitStagedReference({
    scope,
    operationId,
    staged: staging,
  });
  next = transitionBlobCommit(snapshot, { type: "reference_commit_succeeded", referenceId });
  expect(
    await repository.compareAndSet({ scope, operationId, expectedVersion: snapshot.version, next }),
  ).toBe(true);
  snapshot = next;
  const allocation = await repository.reserve({ scope, staged: staging, operationId, referenceId });
  const stable = stableFrom(staging, allocation);
  next = transitionBlobCommit(snapshot, { type: "allocation_reserved", allocation, stable });
  expect(
    await repository.compareAndSet({ scope, operationId, expectedVersion: snapshot.version, next }),
  ).toBe(true);
  return { referenceId, allocation, stable, snapshotVersion: next.version };
}

async function preparePromotion(
  scope: TenantBlobScope,
  staging: StagedBlobRef,
  operationId: string,
): Promise<{
  readonly referenceId: string;
  readonly allocation: StableBlobLifecycleAllocation;
  readonly stable: StableBlobRef;
  readonly authorization: { tenantId: string; operationId: string; authorizationId: string };
}> {
  const { referenceId, allocation, stable, snapshotVersion } = await prepareAllocation(
    scope,
    staging,
    operationId,
  );
  const started = await repository.startPromotion({
    scope,
    operationId,
    expectedSnapshotVersion: snapshotVersion,
    allocationId: allocation.allocationId,
  });
  if (started.status !== "started") throw new Error(`startPromotion 失败：${started.status}`);
  return { referenceId, allocation, stable, authorization: started.authorization };
}

describe("PostgreSQL stable blob 生命周期", () => {
  it("deliver_file 清理失败后由 released anchor 周期恢复真实 MinIO stable Blob", async () => {
    const idempotencyKey = `delivery-failed-${unique}`;
    const body = new TextEncoder().encode(`delivery-cleanup-${unique}`);
    const digest = sha256Digest(createHash("sha256").update("delivery-cleanup").digest("hex"));
    const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 0 });
    const authorization = authority.issuer.issue({
      attemptId: `delivery_attempt_${unique}`,
      consumed: {
        permit: {
          permitId: `delivery_permit_${unique}`,
          scope: {
            tenantId: tenantId(scopeA.tenantId),
            threadId: threadId(`delivery_thread_${unique}`),
            runId: runId(`delivery_run_${unique}`),
            rootRunId: runId(`delivery_run_${unique}`),
            workspaceId: workspaceId(`delivery_workspace_${unique}`),
          },
          runClaimToken: `delivery_claim_${unique}`,
          runClaimEpoch: 1,
          workspaceRootRunId: runId(`delivery_run_${unique}`),
          workspaceLeaseEpoch: 1,
          attemptVersion: 0,
          effect: "tool_execution",
          callId: idempotencyKey,
          toolName: "deliver_file",
          argsDigest: digest,
          issuedAt: isoTimestamp("2099-07-30T00:00:00.000Z"),
          expiresAt: isoTimestamp("2099-07-30T00:01:00.000Z"),
        },
        consumedAt: isoTimestamp("2099-07-30T00:00:01.000Z"),
        consumedAtMonotonicMs: 0,
        maxContinuationDelayMs: 250,
      },
    });
    const config = minioConfig();
    const store = createS3BlobStore(config, repository);
    const failedGcWriter = new DurableResourceBlobWriter(repository, store, 1024 * 1024, {
      collectIfUnreachable: async () => Promise.reject(new Error("模拟首次 GC 不可用")),
    });
    const service = new SimpleArtifactDeliveryService(
      new PgSimpleDeliveredFileRepository(runtimePool),
      failedGcWriter,
    );

    await expect(
      service.publish({
        authorization,
        idempotencyKey,
        toolArgsDigest: digest,
        sourcePath: "failed-delivery.txt",
        name: "failed-delivery.txt",
        body,
      }),
    ).rejects.toThrow("DELIVER_FILE_CLEANUP_RESULT_UNKNOWN");

    const operationDigest = createHash("sha256")
      .update(`${scopeA.tenantId}\0${idempotencyKey}`, "utf8")
      .digest("hex");
    const released = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{
        readonly state: string;
        readonly lifecycle_state: string;
      }>(
        `SELECT reference.state,lifecycle.state AS lifecycle_state
           FROM blob_references reference
           JOIN blob_lifecycles lifecycle
             ON lifecycle.tenant_id=reference.tenant_id
            AND lifecycle.lifecycle_id=reference.lifecycle_id
          WHERE reference.tenant_id=$1 AND reference.operation_id=$2`,
        [scopeA.tenantId, `deliver-${operationDigest}`],
      ),
    );
    expect(released.rows).toEqual([{ state: "released", lifecycle_state: "active" }]);
    const recovery = new DurableResourceBlobWriter(
      repository,
      store,
      1024 * 1024,
      createS3StableBlobGarbageCollector(config, repository),
    );
    await expect(
      recovery.recoverPending({
        tenantId: scopeA.tenantId,
        limit: 8,
        orphanGraceSeconds: 1,
      }),
    ).resolves.toMatchObject({ claimed: 1, converged: 1 });
    const recovered = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ readonly state: string; readonly lifecycle_state: string }>(
        `SELECT reference.state,lifecycle.state AS lifecycle_state
           FROM blob_references reference
           JOIN blob_lifecycles lifecycle
             ON lifecycle.tenant_id=reference.tenant_id
            AND lifecycle.lifecycle_id=reference.lifecycle_id
          WHERE reference.tenant_id=$1 AND reference.operation_id=$2`,
        [scopeA.tenantId, `deliver-${operationDigest}`],
      ),
    );
    expect(recovered.rows).toEqual([{ state: "released", lifecycle_state: "deleted" }]);

    const crashKey = `delivery-abandon-crash-${unique}`;
    const crashed = await recovery.persist({
      tenantId: scopeA.tenantId,
      idempotencyKey: crashKey,
      body: new TextEncoder().encode(`delivery-abandon-crash-${unique}`),
      sha256: sha256Hex(new TextEncoder().encode(`delivery-abandon-crash-${unique}`)),
      mediaType: "text/plain; charset=utf-8",
    });
    await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query(
        `UPDATE blob_references SET updated_at=clock_timestamp()-interval '10 seconds'
          WHERE tenant_id=$1 AND reference_id=$2`,
        [scopeA.tenantId, crashed.referenceId],
      ),
    );
    await expect(
      recovery.recoverPending({
        tenantId: scopeA.tenantId,
        limit: 8,
        orphanGraceSeconds: 1,
      }),
    ).resolves.toMatchObject({ claimed: 1, converged: 1 });
    expect(await store.head(scopeA, crashed.blob)).toBeUndefined();
  });

  it("开发 Agent Worker 入口装配真实 PG、S3 Observation 与 Pi 恢复依赖", async () => {
    const dependencyServer = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/sandbox/v2/sandboxes" || request.url === "/sandbox/volumes") {
        response.end("[]");
        return;
      }
      if (request.url === "/model/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      dependencyServer.once("error", reject);
      dependencyServer.listen(0, "127.0.0.1", resolve);
    });
    const address = dependencyServer.address();
    if (address === null || typeof address === "string") throw new Error("依赖测试服务未监听 TCP");
    let service: Awaited<ReturnType<typeof startWorkerProcess>> | undefined;
    try {
      service = await startWorkerProcess({
        environment: {
          RUNTIME_ENV: "development",
          DATABASE_URL: runtimeDatabaseUrl,
          DATABASE_SCHEMA: schema,
          DATABASE_RUNTIME_ROLE: requiredEnvironment("DATABASE_RUNTIME_ROLE"),
          DATABASE_WORKER_COORDINATOR_URL: workerCoordinatorDatabaseUrl.toString(),
          DATABASE_WORKER_COORDINATOR_ROLE: workerCoordinatorRole,
          S3_ENDPOINT: requiredEnvironment("S3_ENDPOINT"),
          S3_BUCKET: requiredEnvironment("S3_BUCKET"),
          S3_REGION: requiredEnvironment("S3_REGION"),
          S3_ACCESS_KEY_ID: requiredEnvironment("S3_ACCESS_KEY_ID"),
          S3_SECRET_ACCESS_KEY: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
          S3_FORCE_PATH_STYLE: "true",
          CUBESANDBOX_API_URL: `http://127.0.0.1:${address.port}/sandbox`,
          CUBESANDBOX_TEMPLATE_ID: "integration-template",
          CUBESANDBOX_RESOURCE_VOLUME_DRIVER: "runtime-resourcefs",
          MODEL_BASE_URL: `http://127.0.0.1:${address.port}/model/v1/`,
          MODEL_API_KEY: "integration-model-key",
          MODEL_ID: "deepseek-v4-flash",
          MODEL_SUPPORTS_IMAGES: "false",
          MODEL_CONTEXT_WINDOW: "1048576",
          MODEL_MAX_OUTPUT_TOKENS: "65536",
          MODEL_WIRE_TRACE_ENABLED: "false",
          MODEL_WIRE_TRACE_RETENTION_DAYS: "7",
          MODEL_WIRE_TRACE_MAX_BYTES: "1048576",
          AGENT_WORKER_TENANT_ID: scopeA.tenantId,
          AGENT_WORKER_ID: "integration-worker",
          AGENT_WORKER_POLL_INTERVAL_MS: "100",
          AGENT_WORKER_DISPATCH_LEASE_MS: "30000",
          AGENT_WORKER_RUN_LEASE_MS: "30000",
          AGENT_WORKER_RUN_TIMEOUT_MS: "900000",
          DEV_AUTH_ENABLED: "true",
          DEV_AUTH_USER_A_TENANT_ID: scopeA.tenantId,
          PROCESS_SHUTDOWN_TIMEOUT_MS: "5000",
        },
      });
      await expect(service.readiness()).resolves.toEqual({ status: "ready" });
    } finally {
      await service?.close();
      await new Promise<void>((resolve, reject) =>
        dependencyServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it.runIf(process.platform === "linux")(
    "durable dispatch 经真实 PG RunWorker、Faux Pi 与 S3 Observation 完成生产消费闭环",
    async () => {
      const label = `worker_vertical_${unique}`;
      const actorUserId = userId(`blob_user_a_${unique}`);
      const executionScope = {
        tenantId: tenantId(scopeA.tenantId),
        threadId: threadId(`thread_${label}`),
        runId: runId(`run_${label}`),
        rootRunId: runId(`run_${label}`),
        workspaceId: `workspace_${label}` as never,
      } satisfies ExecutionScope;
      const initialProjection = Object.freeze({
        schemaVersion: 2 as const,
        checkpointId: "initial",
        items: Object.freeze([]),
      });
      const inputText = "执行一次受控命令并交付生成文件后完成";
      await withTenantTransaction(
        runtimePool,
        { tenantId: scopeA.tenantId, userId: actorUserId },
        async (client) => {
          await client.query(
            `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
             VALUES ($1,$2,$3,'Worker 纵向测试','active',clock_timestamp(),clock_timestamp())`,
            [scopeA.tenantId, executionScope.threadId, actorUserId],
          );
          await client.query(
            `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
             VALUES ($1,$2,$3,'queued',clock_timestamp(),clock_timestamp())`,
            [scopeA.tenantId, executionScope.runId, executionScope.threadId],
          );
          await client.query(
            `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at)
             VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp())`,
            [scopeA.tenantId, executionScope.workspaceId, executionScope.threadId],
          );
          await client.query(
            `INSERT INTO run_execution_inputs(
               tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
               initial_projection,initial_projection_digest)
             VALUES ($1,$2,$3,$4,$2,$5,$6::jsonb,$7)`,
            [
              scopeA.tenantId,
              executionScope.runId,
              executionScope.threadId,
              executionScope.workspaceId,
              inputText,
              JSON.stringify(initialProjection),
              rolloutProjectionDigest(initialProjection),
            ],
          );
          await client.query(
            `INSERT INTO run_dispatch_outbox(
               tenant_id,outbox_id,run_id,thread_id,workspace_id,root_run_id,input_digest,state)
             VALUES ($1,$2,$3,$4,$5,$3,$6,'ready')`,
            [
              scopeA.tenantId,
              randomUUID(),
              executionScope.runId,
              executionScope.threadId,
              executionScope.workspaceId,
              createHash("sha256").update(inputText, "utf8").digest("hex"),
            ],
          );
        },
      );

      const gateway = new FakeSandboxGateway();
      let sandboxSequence = 0;
      const upstream: SandboxSessionRegistryPort = {
        acquire: async ({ signal }) => {
          const sandbox = await gateway.create(
            { templateId: "worker-vertical-template", ttlSeconds: 120 },
            { signal },
          );
          await sandbox.writeFile("/workspace/vertical.txt", "vertical-deliver-file");
          sandboxSequence += 1;
          return {
            outcome: "ready",
            session: {
              registryId: `registry-${label}-${sandboxSequence}`,
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
        api: `worker-vertical-${unique}`,
        provider: `worker-vertical-${unique}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: "printf vertical" }, { id: `call_exec_${label}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(
            "deliver_file",
            { path: "/workspace/vertical.txt" },
            { id: `call_deliver_${label}` },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("完成"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const blobRepository = new PgBlobLifecycleRepository(runtimePool, {
        objectPrefix: prefix,
      });
      const blobStore = createS3BlobStore(minioConfig(), blobRepository);
      const durableObservation = createPgDurableObservationSession({
        blobRepository,
        blobs: blobStore,
        rolloutRepository: new PgRuntimeRolloutRepository(runtimePool),
        policy: { maxModelObservationBytes: 64 },
      });
      const artifactAuthorization = createArtifactExecutionAuthorizationAuthority();
      const resourceBlobs = new DurableResourceBlobWriter(
        blobRepository,
        blobStore,
        1024 * 1024,
        createS3StableBlobGarbageCollector(minioConfig(), blobRepository),
      );
      const deliverFileTools = new DeliverFileToolRouterFactory({
        source: {
          read: async ({ binding, absolutePath }) => {
            try {
              const content = await binding.sandbox.sandbox.readFile(absolutePath);
              return {
                outcome: "found" as const,
                relativePath: absolutePath.slice("/workspace/".length),
                body: new TextEncoder().encode(content),
              };
            } catch {
              return { outcome: "not_found" as const };
            }
          },
        },
        publications: new SimpleArtifactDeliveryService(
          new PgSimpleDeliveredFileRepository(runtimePool),
          resourceBlobs,
        ),
        authorizationVerifier: artifactAuthorization.verifier,
      });
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
        durableObservation.createRecorder,
        artifactAuthorization.issuer,
        durableObservation.prepare,
        undefined,
        deliverFileTools,
      );
      const sandboxes = new PgBackedSandboxSessionRegistry(runtimePool, upstream, 120);
      const worker = new RunWorker(
        {
          persistence: new PgExecutionPersistence(runtimePool),
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock: new SystemWorkerClock(),
          metrics: new FakeRecoveryMetrics(),
        },
        { workerId: `worker-${label}`, leaseDurationMs: 30_000, heartbeatMs: 10_000 },
      );
      const tenantAssignments = new PgWorkerTenantAssignments({
        runtime: runtimePool,
        coordinator: workerCoordinatorPool,
      });
      await tenantAssignments.wake(scopeA.tenantId);
      const loop = new AgentWorkerPollingLoop(
        tenantAssignments,
        new PgRunDispatchOutbox(runtimePool),
        worker,
        {
          workerId: `dispatcher-${label}`,
          pollIntervalMs: 25,
          tenantAssignmentLeaseMs: 30_000,
          dispatchLeaseMs: 30_000,
        },
      );
      loop.start();
      try {
        let status = "queued";
        for (let index = 0; index < 200 && status !== "succeeded"; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          status = await withTenantTransaction(
            runtimePool,
            { tenantId: scopeA.tenantId },
            async (client) =>
              String(
                (
                  await client.query<{ status: string }>(
                    "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2",
                    [scopeA.tenantId, executionScope.runId],
                  )
                ).rows[0]?.status,
              ),
          );
        }
        expect(status).toBe("succeeded");
      } finally {
        await loop.close();
      }
      expect(faux.state.callCount).toBe(3);
      const facts = await withTenantTransaction(
        runtimePool,
        { tenantId: scopeA.tenantId, userId: actorUserId },
        async (client) =>
          client.query<{
            kind: string;
            tool_name: string | null;
            blob_reference_id: string | null;
            blob_state: string | null;
            blob_purpose: string | null;
          }>(
            `SELECT entry.kind,entry.body->>'toolName' AS tool_name,entry.blob_reference_id,
                    reference.state AS blob_state,reference.purpose AS blob_purpose
               FROM runtime_rollout_entries entry
               LEFT JOIN blob_references reference
                 ON reference.tenant_id=entry.tenant_id
                AND reference.reference_id=entry.blob_reference_id
              WHERE entry.tenant_id=$1 AND entry.run_id=$2 ORDER BY entry.sequence`,
            [scopeA.tenantId, executionScope.runId],
          ),
      );
      expect(facts.rows.map((row) => row.kind)).toEqual([
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
      ]);
      expect(facts.rows.map((row) => row.tool_name)).toEqual([
        "exec_command",
        "exec_command",
        "deliver_file",
        "deliver_file",
      ]);
      expect(facts.rows[3]).toMatchObject({ blob_state: "stable", blob_purpose: "trace" });
      expect(facts.rows[3]?.blob_reference_id).toBeTypeOf("string");

      const published = await withTenantTransaction(
        runtimePool,
        { tenantId: scopeA.tenantId, userId: actorUserId },
        (client) =>
          client.query<{ readonly artifact_id: string; readonly target: string }>(
            `SELECT publication.id AS artifact_id,settlement.target
               FROM artifact_publications publication
               JOIN artifact_publication_settlements settlement
                 ON settlement.tenant_id=publication.tenant_id
                AND settlement.artifact_id=publication.id
              WHERE publication.tenant_id=$1 AND publication.run_id=$2`,
            [scopeA.tenantId, executionScope.runId],
          ),
      );
      expect(published.rows).toHaveLength(1);
      expect(published.rows[0]?.target).toBe("published");
      const artifactService = new ArtifactDeliveryService(
        new PgArtifactDeliveryRepository(runtimePool, artifactAuthorization.verifier),
        blobStore,
        {
          runtimeMode: "development",
          allowInsecureHttpDownload: true,
          defaultDownloadTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
          maxDownloadTtlSeconds: WORKER_ARTIFACT_DOWNLOAD_TTL_SECONDS,
          executionAuthorizationVerifier: artifactAuthorization.verifier,
        },
      );
      const download = await artifactService.createDownload({
        request: { tenantId: tenantId(scopeA.tenantId), userId: actorUserId },
        artifactId: artifactId(String(published.rows[0]?.artifact_id)),
      });
      const response = await fetch(download.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("vertical-deliver-file");
    },
  );

  it("真实 PG + MinIO 持久化 Trace 后追加 Rollout，并可在重启后幂等重放", async () => {
    const suffix = `observation_${unique}`;
    const rolloutScope = {
      tenantId: tenantId(scopeA.tenantId),
      threadId: threadId(`thread_${suffix}`),
      runId: runId(`run_${suffix}`),
      attemptId: `attempt_${suffix}`,
      agentThreadId: agentThreadId(
        `root_${createHash("sha256").update(`attempt_${suffix}`, "utf8").digest("hex")}`,
      ),
    };
    const actorUserId = userId(`blob_user_a_${unique}`);
    const workspaceId = `workspace_${suffix}`;
    const digest = sha256Digest(sha256Hex(new TextEncoder().encode("compatibility")));
    await withTenantTransaction(
      runtimePool,
      { tenantId: scopeA.tenantId, userId: actorUserId },
      async (client) => {
        await client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
         VALUES ($1,$2,$3,'Observation 集成测试','active',clock_timestamp(),clock_timestamp())`,
          [scopeA.tenantId, rolloutScope.threadId, actorUserId],
        );
        await client.query(
          `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
         VALUES ($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
          [scopeA.tenantId, rolloutScope.runId, rolloutScope.threadId],
        );
        await client.query(
          `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at)
         VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp())`,
          [scopeA.tenantId, workspaceId, rolloutScope.threadId],
        );
        await client.query(
          `INSERT INTO run_execution_inputs(
           tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
           initial_projection,initial_projection_digest)
         VALUES ($1,$2,$3,$4,$2,'test','{}'::jsonb,$5)`,
          [scopeA.tenantId, rolloutScope.runId, rolloutScope.threadId, workspaceId, digest],
        );
        await client.query(
          `INSERT INTO execution_attempts(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage)
         VALUES ($1,$2,$3,$4,$5,$3,'running','model_execution_started')`,
          [
            scopeA.tenantId,
            rolloutScope.attemptId,
            rolloutScope.runId,
            rolloutScope.threadId,
            workspaceId,
          ],
        );
        await client.query(
          `INSERT INTO workspace_write_leases(
             tenant_id,workspace_id,thread_id,root_run_id,epoch,expires_at)
           VALUES ($1,$2,$3,$4,1,clock_timestamp()+interval '10 minutes')`,
          [scopeA.tenantId, workspaceId, rolloutScope.threadId, rolloutScope.runId],
        );
        await client.query(
          `INSERT INTO execution_workspace_fences(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             lease_epoch,initial_expires_at)
           VALUES ($1,$2,$3,$4,$5,$3,1,clock_timestamp()+interval '10 minutes')`,
          [
            scopeA.tenantId,
            rolloutScope.attemptId,
            rolloutScope.runId,
            rolloutScope.threadId,
            workspaceId,
          ],
        );
        await client.query(
          `INSERT INTO run_claims(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             worker_id,claim_token,claim_epoch,workspace_lease_epoch,expires_at)
           VALUES ($1,$2,$3,$4,$5,$3,'observation-worker',$6,1,1,
                   clock_timestamp()+interval '10 minutes')`,
          [
            scopeA.tenantId,
            rolloutScope.attemptId,
            rolloutScope.runId,
            rolloutScope.threadId,
            workspaceId,
            `claim_${suffix}`,
          ],
        );
      },
    );
    const rollout = new PgRuntimeRolloutRepository(runtimePool);
    const compatibility = {
      modelId: "integration-model",
      modelCompatibilityHash: digest,
      promptPolicyHash: digest,
      toolSchemaHash: digest,
      skillManifestHash: digest,
    };
    const fenceData = {
      scope: {
        tenantId: rolloutScope.tenantId,
        threadId: rolloutScope.threadId,
        runId: rolloutScope.runId,
        rootRunId: rolloutScope.runId,
        workspaceId,
      },
      runClaim: { token: `claim_${suffix}`, epoch: 1, expiresAt: "2026-07-28T23:59:59.999Z" },
      workspaceLease: {
        rootRunId: rolloutScope.runId,
        epoch: 1,
        expiresAt: "2026-07-28T23:59:59.999Z",
      },
    };
    const fence = fenceData as unknown as ExecutionFence;
    const context = { scope: rolloutScope, userId: actorUserId, fence };
    const observationBinding = {
      ...fence.scope,
      attemptId: rolloutScope.attemptId,
      agentThreadId: rolloutScope.agentThreadId,
      runClaimToken: fence.runClaim.token,
      runClaimEpoch: fence.runClaim.epoch,
      workspaceLeaseRootRunId: fence.workspaceLease.rootRunId,
      workspaceLeaseEpoch: fence.workspaceLease.epoch,
    };
    const sessionInput = {
      scope: fence.scope,
      fence,
      attemptId: rolloutScope.attemptId,
    } as never;
    const blobs = createS3BlobStore(minioConfig(), repository);
    const durableObservation = createPgDurableObservationSession({
      blobRepository: repository,
      blobs,
      rolloutRepository: rollout,
      policy: { maxModelObservationBytes: 64 },
    });
    await expect(durableObservation.prepare(sessionInput, compatibility)).resolves.toBeUndefined();
    await expect(durableObservation.prepare(sessionInput, compatibility)).resolves.toBeUndefined();
    expect(
      (
        await rollout.append({
          context,
          idempotencyKey: `call.${suffix}`,
          entries: [
            {
              kind: "tool_call",
              toolCallId: `call_${suffix}`,
              body: { toolName: "sandbox_command" },
            },
          ],
        })
      ).outcome,
    ).toBe("created");

    let observedOutput = encodeControlledToolReceipt("sandbox_command", "succeeded");
    const rolloutAdapter = new PgToolObservationRolloutAdapter(rollout, context);
    const pipeline = new ToolObservationPipeline(
      createDurableTraceBlobPersistence(repository, blobs),
      {
        appendToolCall: async () => ({ outcome: "unknown" }),
        appendToolResult: async () => ({ outcome: "unknown" }),
      },
      { readControlledReceipt: async () => observedOutput },
      { maxModelObservationBytes: 64 },
    );
    const command = {
      binding: observationBinding,
      idempotencyKey: `result.${suffix}`,
      toolCallId: `call_${suffix}`,
      toolName: "sandbox_command",
    };
    await expect(pipeline.record(command)).resolves.toMatchObject({
      outcome: "unknown",
    });
    const traceOperationId = `trace-${createHash("sha256").update(`${command.idempotencyKey}.trace`, "utf8").digest("hex")}`;
    const traceSnapshot = await repository.load(scopeA, traceOperationId);
    if (traceSnapshot?.stable === undefined) throw new Error("真实 Trace stable identity 缺失");
    await expect(blobs.getBytes(scopeA, traceSnapshot.stable)).resolves.toEqual(
      new TextEncoder().encode(observedOutput),
    );
    await expect(blobs.getBytes(scopeB, traceSnapshot.stable)).rejects.toBeDefined();
    const restarted = new ToolObservationPipeline(
      createDurableTraceBlobPersistence(
        new PgBlobLifecycleRepository(runtimePool, { objectPrefix: prefix }),
        createS3BlobStore(
          minioConfig(),
          new PgBlobLifecycleRepository(runtimePool, { objectPrefix: prefix }),
        ),
      ),
      rolloutAdapter,
      { readControlledReceipt: async () => observedOutput },
      { maxModelObservationBytes: 64 },
    );
    await expect(restarted.record(command)).resolves.toMatchObject({ outcome: "recorded" });
    await expect(restarted.record(command)).resolves.toMatchObject({ outcome: "replayed" });
    observedOutput = encodeControlledToolReceipt("sandbox_command", "failed");
    await expect(restarted.record(command)).resolves.toEqual({ outcome: "conflict" });
    observedOutput = encodeControlledToolReceipt("sandbox_command", "succeeded");
    const restored = await rollout.loadRecovery({
      context,
      compatibility: {
        modelId: "integration-model",
        modelCompatibilityHash: digest,
        promptPolicyHash: digest,
        toolSchemaHash: digest,
        skillManifestHash: digest,
      },
    });
    expect(restored).toMatchObject({
      outcome: "loaded",
      tail: [
        { kind: "tool_call", toolCallId: `call_${suffix}` },
        { kind: "tool_result", toolCallId: `call_${suffix}`, isTruncated: true },
      ],
    });

    const factoryCallId = `factory_${suffix}`;
    const factoryReceipt = encodeControlledToolReceipt("sandbox_command", "succeeded");
    const recorder = durableObservation.createRecorder(sessionInput, {
      readControlledReceipt: async () => factoryReceipt,
    });
    await expect(
      recorder.recordStarted({ toolCallId: factoryCallId, toolName: "sandbox_command" }),
    ).resolves.toBe("recorded");
    await expect(
      recorder.record({ toolCallId: factoryCallId, toolName: "sandbox_command" }),
    ).resolves.toMatchObject({ outcome: "recorded" });

    const boundaryCallId = `boundary_${suffix}`;
    expect(
      (
        await rollout.append({
          context,
          idempotencyKey: `boundary.call.${suffix}`,
          entries: [
            {
              kind: "tool_call",
              toolCallId: boundaryCallId,
              body: { toolName: "sandbox_command" },
            },
          ],
        })
      ).outcome,
    ).toBe("created");
    const boundary = new ToolObservationPipeline(
      createDurableTraceBlobPersistence(repository, blobs),
      new PgToolObservationRolloutAdapter(rollout, context),
      {
        readControlledReceipt: async () =>
          encodeControlledToolReceipt("sandbox_command", "succeeded"),
      },
      { maxModelObservationBytes: 64, maxRolloutBodyBytes: 16 * 1024 },
    );
    await expect(
      boundary.record({
        binding: observationBinding,
        idempotencyKey: `boundary.result.${suffix}`,
        toolCallId: boundaryCallId,
        toolName: "sandbox_command",
      }),
    ).resolves.toMatchObject({ outcome: "recorded", isTruncated: true });
    const bodySize = await withTenantTransaction(
      runtimePool,
      { tenantId: scopeA.tenantId, userId: context.userId },
      (client) =>
        client.query<{ bytes: number }>(
          `SELECT octet_length(body::text)::integer AS bytes
             FROM runtime_rollout_entries
            WHERE tenant_id=$1 AND attempt_id=$2 AND tool_call_id=$3 AND kind='tool_result'`,
          [scopeA.tenantId, rolloutScope.attemptId, boundaryCallId],
        ),
    );
    expect(bodySize.rows[0]?.bytes).toBeGreaterThan(0);
    // 固定受控回执不会为“贴近 16 KiB”而填充原始输出；Rollout body 应保持很小。
    expect(bodySize.rows[0]?.bytes).toBeLessThan(1024);
  });

  it("并发 reserve 原子去重，同 operation 可读回且跨 Tenant 隔离", async () => {
    const body = new TextEncoder().encode(`reserve-${unique}`);
    const stagedA1 = staged(scopeA, "reserve-a1", body);
    const stagedA2 = { ...stagedA1, uploadId: `upload-reserve-a2-${unique}` };
    const [left, right] = await Promise.all([
      repository.reserve({
        scope: scopeA,
        staged: stagedA1,
        operationId: `reserve-left-${unique}`,
        referenceId: `ref-left-${unique}`,
      }),
      repository.reserve({
        scope: scopeA,
        staged: stagedA2,
        operationId: `reserve-right-${unique}`,
        referenceId: `ref-right-${unique}`,
      }),
    ]);
    expect(left.incarnationId).toBe(right.incarnationId);
    expect(left.physicalObjectKey).toBe(right.physicalObjectKey);
    const replay = await repository.reserve({
      scope: scopeA,
      staged: stagedA1,
      operationId: `reserve-left-${unique}`,
      referenceId: `ref-left-${unique}`,
    });
    expect(replay).toEqual(left);
    await expect(
      repository.reserve({
        scope: scopeA,
        staged: staged(scopeA, `reserve-conflict-${unique}`),
        operationId: `reserve-left-${unique}`,
        referenceId: `ref-left-${unique}`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const otherTenant = await repository.reserve({
      scope: scopeB,
      staged: { ...stagedA1, tenantId: scopeB.tenantId, uploadId: `upload-reserve-b-${unique}` },
      operationId: `reserve-left-${unique}`,
      referenceId: `ref-left-${unique}`,
    });
    expect(otherTenant.incarnationId).not.toBe(left.incarnationId);
    expect(otherTenant.physicalObjectKey).not.toBe(left.physicalObjectKey);
  });

  it("started 授权绑定完整目标，单一 COPY attempt 且 UNKNOWN 只进入同目标恢复", async () => {
    const staging = staged(scopeA, `authorization-${unique}`);
    const flow = await preparePromotion(scopeA, staging, `authorization-${unique}`);
    const startedSnapshot = await repository.load(scopeA, flow.authorization.operationId);
    if (startedSnapshot === undefined) throw new Error("promotion_started snapshot 缺失");
    expect(
      await repository.startPromotion({
        scope: scopeA,
        operationId: flow.authorization.operationId,
        expectedSnapshotVersion: startedSnapshot.version - 1,
        allocationId: flow.allocation.allocationId,
      }),
    ).toMatchObject({ status: "started", authorization: flow.authorization });
    const first = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: flow.authorization,
      attemptId: randomUUID(),
    });
    if (first.status !== "copy_allowed") throw new Error(`未取得 execution：${first.status}`);
    const competing = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: flow.authorization,
      attemptId: randomUUID(),
    });
    expect(competing).toEqual({ status: "in_progress" });
    const resolved = await repository.resolveAuthorizedForCopy({
      scope: scopeA,
      execution: first.execution,
    });
    expect(resolved).toMatchObject({
      status: "authorized",
      authorization: {
        authorizationId: flow.authorization.authorizationId,
        allocationId: flow.allocation.allocationId,
        incarnationId: flow.stable.incarnationId,
        physicalObjectKey: flow.stable.physicalObjectKey,
        stagingUploadId: staging.uploadId,
      },
    });
    const issued = await repository.markPromotionCopyIssued({
      scope: scopeA,
      execution: first.execution,
    });
    if (issued.status !== "marked") throw new Error("COPY intent 未写入");
    expect(
      await repository.markPromotionCopyIssued({ scope: scopeA, execution: first.execution }),
    ).toMatchObject({ status: "marked", execution: { executionId: first.execution.executionId } });
    await repository.completePromotionExecution({
      scope: scopeA,
      execution: issued.execution,
      outcome: "unknown",
    });
    const recovered = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: flow.authorization,
      attemptId: randomUUID(),
    });
    expect(recovered).toMatchObject({
      status: "reconcile",
      execution: {
        executionId: first.execution.executionId,
        incarnationId: flow.stable.incarnationId,
        physicalObjectKey: flow.stable.physicalObjectKey,
      },
    });
  });

  it("只有持久 pre_intent/not_copied 证明可以消费授权并原子回退 commit", async () => {
    const staging = staged(scopeA, `not-copied-${unique}`);
    const flow = await preparePromotion(scopeA, staging, `not-copied-${unique}`);
    const claimed = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: flow.authorization,
      attemptId: randomUUID(),
    });
    if (claimed.status !== "copy_allowed") throw new Error(`未取得 execution：${claimed.status}`);
    await repository.completePromotionExecution({
      scope: scopeA,
      execution: claimed.execution,
      outcome: "not_copied",
    });
    const startedSnapshot = await repository.load(scopeA, flow.authorization.operationId);
    if (startedSnapshot === undefined) throw new Error("promotion_started snapshot 缺失");
    const proven = await repository.provePromotionNotCopied({
      scope: scopeA,
      operationId: flow.authorization.operationId,
      expectedSnapshotVersion: startedSnapshot.version,
      authorizationId: flow.authorization.authorizationId,
    });
    expect(proven).toMatchObject({ status: "proven_not_copied" });
    expect(
      await repository.provePromotionNotCopied({
        scope: scopeA,
        operationId: flow.authorization.operationId,
        expectedSnapshotVersion: startedSnapshot.version,
        authorizationId: flow.authorization.authorizationId,
      }),
    ).toEqual(proven);
    expect((await repository.load(scopeA, flow.authorization.operationId))?.status).toBe(
      "allocation_reserved",
    );
    expect(
      await repository.claimPromotionExecution({
        scope: scopeA,
        authorization: flow.authorization,
        attemptId: randomUUID(),
      }),
    ).toEqual({ status: "consumed" });
    const executionProof = await withTenantTransaction(migratorPool, scopeA, (client) =>
      client.query<{ proof_status: string }>(
        `SELECT proof_status FROM promotion_executions
          WHERE tenant_id = $1 AND authorization_id = $2`,
        [scopeA.tenantId, flow.authorization.authorizationId],
      ),
    );
    expect(executionProof.rows[0]?.proof_status).toBe("consumed_not_copied");
  });

  it("事务响应丢失后重复 reserve 从 PostgreSQL 读回同一结果", async () => {
    const staging = staged(scopeA, `response-loss-${unique}`);
    const operationId = `response-loss-${unique}`;
    const lossy = repositoryWithOneLostCommitResponse();
    await expect(
      lossy.reserve({
        scope: scopeA,
        staged: staging,
        operationId,
        referenceId: `ref-${operationId}`,
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const readback = await repository.reserve({
      scope: scopeA,
      staged: staging,
      operationId,
      referenceId: `ref-${operationId}`,
    });
    expect(readback.physicalObjectKey).toContain(`/incarnations/${readback.incarnationId}`);
  });

  it("关键状态变更在 COMMIT 成功但响应丢失后可由幂等重试读回", async () => {
    const startOperation = `loss-start-${unique}`;
    const startFlow = await prepareAllocation(
      scopeA,
      staged(scopeA, startOperation),
      startOperation,
    );
    const startInput = {
      scope: scopeA,
      operationId: startOperation,
      expectedSnapshotVersion: startFlow.snapshotVersion,
      allocationId: startFlow.allocation.allocationId,
    } as const;
    await expect(
      repositoryWithOneLostCommitResponse().startPromotion(startInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const started = await repository.startPromotion(startInput);
    expect(started).toMatchObject({ status: "started" });

    const proofOperation = `loss-proof-${unique}`;
    const proofFlow = await preparePromotion(
      scopeA,
      staged(scopeA, proofOperation),
      proofOperation,
    );
    const proofClaim = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: proofFlow.authorization,
      attemptId: randomUUID(),
    });
    if (proofClaim.status !== "copy_allowed") throw new Error("proof execution 未取得");
    await repository.completePromotionExecution({
      scope: scopeA,
      execution: proofClaim.execution,
      outcome: "not_copied",
    });
    const proofSnapshot = await repository.load(scopeA, proofOperation);
    if (proofSnapshot === undefined) throw new Error("proof commit 缺失");
    const proofInput = {
      scope: scopeA,
      operationId: proofOperation,
      expectedSnapshotVersion: proofSnapshot.version,
      authorizationId: proofFlow.authorization.authorizationId,
    } as const;
    await expect(
      repositoryWithOneLostCommitResponse().provePromotionNotCopied(proofInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await repository.provePromotionNotCopied(proofInput)).toMatchObject({
      status: "proven_not_copied",
    });

    const copyOperation = `loss-copy-${unique}`;
    const copyFlow = await preparePromotion(scopeA, staged(scopeA, copyOperation), copyOperation);
    const copyClaim = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: copyFlow.authorization,
      attemptId: randomUUID(),
    });
    if (copyClaim.status !== "copy_allowed") throw new Error("copy execution 未取得");
    const copyInput = { scope: scopeA, execution: copyClaim.execution } as const;
    await expect(
      repositoryWithOneLostCommitResponse().markPromotionCopyIssued(copyInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await repository.markPromotionCopyIssued(copyInput)).toMatchObject({ status: "marked" });

    const deletionOperation = `loss-delete-${unique}`;
    const deletionFlow = await preparePromotion(
      scopeA,
      staged(scopeA, deletionOperation),
      deletionOperation,
    );
    const deletionClaim = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: deletionFlow.authorization,
      attemptId: randomUUID(),
    });
    if (deletionClaim.status !== "copy_allowed") throw new Error("deletion execution 未取得");
    const deletionIssued = await repository.markPromotionCopyIssued({
      scope: scopeA,
      execution: deletionClaim.execution,
    });
    if (deletionIssued.status !== "marked") throw new Error("deletion COPY intent 未写入");
    await repository.completePromotionExecution({
      scope: scopeA,
      execution: deletionIssued.execution,
      outcome: "succeeded",
    });
    await repository.markReferenceStable({
      scope: scopeA,
      operationId: deletionOperation,
      referenceId: deletionFlow.referenceId,
      stable: deletionFlow.stable,
    });
    await migrationTenantQuery(
      scopeA,
      "DELETE FROM blob_references WHERE tenant_id = $1 AND reference_id = $2",
      [scopeA.tenantId, deletionFlow.referenceId],
    );
    const gcClaim = await repository.claimUnreachable({
      scope: scopeA,
      blob: deletionFlow.stable,
    });
    if (gcClaim.status !== "claimed") throw new Error(`GC claim 失败：${gcClaim.status}`);
    const deletionInput = {
      scope: scopeA,
      blob: deletionFlow.stable,
      claim: gcClaim.claim,
    } as const;
    await expect(
      repositoryWithOneLostCommitResponse().beginDeletion(deletionInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await repository.beginDeletion(deletionInput)).toMatchObject({ status: "started" });
  });

  it("promotion 并发路径统一 authorization→execution 锁序且最终收敛", async () => {
    for (let index = 0; index < 8; index += 1) {
      const operationId = `lock-order-${index}-${unique}`;
      const flow = await preparePromotion(scopeA, staged(scopeA, operationId), operationId);
      const claim = await repository.claimPromotionExecution({
        scope: scopeA,
        authorization: flow.authorization,
        attemptId: randomUUID(),
      });
      if (claim.status !== "copy_allowed") throw new Error(`未取得并发 execution：${claim.status}`);
      const [mark, complete] = await Promise.allSettled([
        repository.markPromotionCopyIssued({ scope: scopeA, execution: claim.execution }),
        repository.completePromotionExecution({
          scope: scopeA,
          execution: claim.execution,
          outcome: "reconcile",
        }),
      ]);
      expect(mark.status).toBe("fulfilled");
      expect(complete.status).toBe("fulfilled");
      const converged = await repository.claimPromotionExecution({
        scope: scopeA,
        authorization: flow.authorization,
        attemptId: randomUUID(),
      });
      expect(converged).toMatchObject({
        status: "reconcile",
        execution: { executionId: claim.execution.executionId },
      });
    }
  });

  it("数据库拒绝错绑 current execution，Runtime 不能改写审计身份列", async () => {
    const operationA = `binding-a-${unique}`;
    const operationB = `binding-b-${unique}`;
    const flowA = await preparePromotion(scopeA, staged(scopeA, operationA), operationA);
    const flowB = await preparePromotion(scopeA, staged(scopeA, operationB), operationB);
    const claimA = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: flowA.authorization,
      attemptId: randomUUID(),
    });
    const claimB = await repository.claimPromotionExecution({
      scope: scopeA,
      authorization: flowB.authorization,
      attemptId: randomUUID(),
    });
    if (claimA.status !== "copy_allowed" || claimB.status !== "copy_allowed") {
      throw new Error("绑定约束测试未取得 execution");
    }
    await expect(
      withTenantTransaction(runtimePool, scopeA, (client) =>
        client.query(
          `UPDATE promotion_executions SET attempt_id = $3
            WHERE tenant_id = $1 AND execution_id = $2`,
          [scopeA.tenantId, claimA.execution.executionId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(migratorPool, scopeA, (client) =>
        client.query(
          `UPDATE promotion_authorizations
              SET current_execution_id = $3, execution_generation = $4
            WHERE tenant_id = $1 AND authorization_id = $2`,
          [
            scopeA.tenantId,
            flowA.authorization.authorizationId,
            claimB.execution.executionId,
            claimB.execution.generation,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("真实 MinIO 完成新 incarnation、GC 接管与 tombstone scrub，迟到旧操作不伤新对象", async () => {
    const body = new TextEncoder().encode(`vertical-${unique}`);
    const config = minioConfig();
    const store = createS3BlobStore(config, repository);
    const gc = createS3StableBlobGarbageCollector(config, repository);
    const scrubber = createS3RetiredBlobTombstoneScrubber(config, repository);
    const firstStaging = await store.putStaging({
      scope: scopeA,
      purpose: "artifact",
      uploadId: `vertical-first-${unique}`,
      body,
      mediaType: "text/plain",
    });
    const first = await preparePromotion(scopeA, firstStaging, `vertical-first-${unique}`);
    const firstStable = await store.promote(scopeA, firstStaging, first.authorization);
    expect(
      await repository.markReferenceStable({
        scope: scopeA,
        operationId: first.authorization.operationId,
        referenceId: first.referenceId,
        stable: firstStable,
      }),
    ).toBe("marked");
    expect(await gc.collectIfUnreachable(scopeA, firstStable)).toBe("still_referenced");
    await migrationTenantQuery(
      scopeA,
      "DELETE FROM blob_references WHERE tenant_id = $1 AND reference_id = $2",
      [scopeA.tenantId, first.referenceId],
    );

    const firstClaim = await repository.claimUnreachable({ scope: scopeA, blob: firstStable });
    if (firstClaim.status !== "claimed")
      throw new Error(`首次 GC claim 失败：${firstClaim.status}`);
    await migrationTenantQuery(
      scopeA,
      "UPDATE blob_lifecycles SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE tenant_id = $1 AND current_claim_id = $2",
      [scopeA.tenantId, firstClaim.claim.claimId],
    );
    const takeover = await repository.claimUnreachable({ scope: scopeA, blob: firstStable });
    if (takeover.status !== "claimed") throw new Error(`GC 接管失败：${takeover.status}`);
    expect(takeover.claim.generation).toBeGreaterThan(firstClaim.claim.generation);
    expect(
      await repository.beginDeletion({ scope: scopeA, blob: firstStable, claim: firstClaim.claim }),
    ).toEqual({ status: "claim_lost" });
    const deleting = await repository.beginDeletion({
      scope: scopeA,
      blob: firstStable,
      claim: takeover.claim,
    });
    if (deleting.status !== "started") throw new Error("GC beginDeletion 失败");
    expect(
      await repository.beginDeletion({ scope: scopeA, blob: firstStable, claim: takeover.claim }),
    ).toEqual(deleting);
    const client = s3Client();
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: firstStable.physicalObjectKey }),
    );
    await repository.completeDeletion({ scope: scopeA, blob: firstStable, claim: deleting.claim });

    const secondStaging = await store.putStaging({
      scope: scopeA,
      purpose: "artifact",
      uploadId: `vertical-second-${unique}`,
      body,
      mediaType: "text/plain",
    });
    const second = await preparePromotion(scopeA, secondStaging, `vertical-second-${unique}`);
    expect(second.stable.incarnationId).not.toBe(firstStable.incarnationId);
    expect(second.stable.physicalObjectKey).not.toBe(firstStable.physicalObjectKey);
    const secondStable = await store.promote(scopeA, secondStaging, second.authorization);
    expect(
      await repository.markReferenceStable({
        scope: scopeA,
        operationId: second.authorization.operationId,
        referenceId: second.referenceId,
        stable: secondStable,
      }),
    ).toBe("marked");

    // 模拟旧 COPY 迟到重新制造 retired key，scrubber 只能删除 tombstone 固定的旧 key。
    await client.send(
      new CopyObjectCommand({
        Bucket: config.bucket,
        CopySource: `${config.bucket}/${prefix}/tenants/${scopeA.tenantId}/staging/artifact/${secondStaging.uploadId}`,
        Key: firstStable.physicalObjectKey,
      }),
    );
    expect(await scrubber.scrubNext(scopeA)).toBe("scrubbed");
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: firstStable.physicalObjectKey }),
    );
    expect(await store.getBytes(scopeA, secondStable)).toEqual(body);

    await migrationTenantQuery(
      scopeA,
      "DELETE FROM blob_references WHERE tenant_id = $1 AND reference_id = $2",
      [scopeA.tenantId, second.referenceId],
    );
    expect(await gc.collectIfUnreachable(scopeA, secondStable)).toBe("deleted");
    await Promise.all([
      store.deleteStaging(scopeA, firstStaging),
      store.deleteStaging(scopeA, secondStaging),
    ]);
    client.destroy();
  });

  it("模型 Wire Trace 精确重放、冲突、COMMIT unknown、RLS 与真实 MinIO 到期删除闭环", async () => {
    const context = await seedModelWireAttempt("closure", scopeA);
    const body = new TextEncoder().encode("model-wire-shared-body");
    const sha256 = sha256Hex(body);
    const store = createS3BlobStore(minioConfig(), repository);
    const wire = new PgModelWireTraceRepository(runtimePool, repository, store, 1, {
      afterCommit: () => {
        throw new Error("模拟 COMMIT 响应丢失");
      },
    });
    const base = {
      context,
      modelTurn: 0,
      part: "response" as const,
      body,
      sha256,
      size: body.byteLength,
      status: "complete" as const,
    };
    await wire.persist({ ...base, transportAttempt: 0 });
    await wire.persist({ ...base, transportAttempt: 0 });
    await expect(
      wire.persist({ ...base, transportAttempt: 0, status: "truncated" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await wire.persist({ ...base, transportAttempt: 1 });
    await wire.captureFailed({
      context,
      modelTurn: 1,
      transportAttempt: 0,
      part: "response",
      code: "BODY_UNREADABLE",
    });
    const facts = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{
        transport_attempt: string;
        persistence_status: string;
        capture_error_code: string | null;
        blob_incarnation_id: string | null;
        physical_object_key: string | null;
      }>(
        `SELECT transport_attempt,persistence_status,capture_error_code,
                blob_incarnation_id,physical_object_key
           FROM model_wire_trace_records WHERE tenant_id=$1 AND attempt_id=$2
           ORDER BY model_turn,transport_attempt`,
        [scopeA.tenantId, context.attemptId],
      ),
    );
    expect(facts.rows).toHaveLength(3);
    expect(facts.rows[0]).toMatchObject({ persistence_status: "stored", capture_error_code: null });
    expect(facts.rows[1]?.blob_incarnation_id).toBe(facts.rows[0]?.blob_incarnation_id);
    expect(facts.rows[2]).toMatchObject({
      persistence_status: "not_captured",
      capture_error_code: "BODY_UNREADABLE",
    });
    const forbiddenDelete = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query(
        `DELETE FROM model_wire_trace_records
          WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=0 AND transport_attempt=0`,
        [scopeA.tenantId, context.attemptId],
      ),
    );
    expect(forbiddenDelete.rowCount).toBe(0);
    const cross = await withTenantTransaction(runtimePool, scopeB, (client) =>
      client.query("SELECT 1 FROM model_wire_trace_records WHERE tenant_id=$1", [scopeA.tenantId]),
    );
    expect(cross.rowCount).toBe(0);
    const stable = {
      kind: "stable" as const,
      tenantId: scopeA.tenantId,
      purpose: "trace" as const,
      sha256,
      size: body.byteLength,
      mediaType: "text/plain; charset=utf-8",
      incarnationId: facts.rows[0]?.blob_incarnation_id ?? "",
      physicalObjectKey: facts.rows[0]?.physical_object_key ?? "",
    };
    const cleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
      {
        afterCommit: () => {
          throw new Error("模拟 cleanup COMMIT 响应丢失");
        },
      },
    );
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_records SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=0 AND transport_attempt=0`,
      [scopeA.tenantId, context.attemptId],
    );
    await cleanup.cleanupExpired({
      tenantId: scopeA.tenantId,
      commandId: `wire-cleanup-first-${unique}`,
      expiresBefore: new Date(),
      batchSize: 10,
    });
    await expect(store.getBytes(scopeA, stable)).resolves.toEqual(body);
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_records SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scopeA.tenantId, context.attemptId],
    );
    const finalCleanup = {
      tenantId: scopeA.tenantId,
      commandId: `wire-cleanup-final-${unique}`,
      expiresBefore: new Date(),
      batchSize: 10,
    };
    await expect(cleanup.cleanupExpired(finalCleanup)).resolves.toMatchObject({ deletedCount: 2 });
    await expect(cleanup.cleanupExpired(finalCleanup)).resolves.toMatchObject({
      outcome: "replayed",
    });
    await expect(store.getBytes(scopeA, stable)).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
  });

  it("Trace Blob 已完成但索引 finalize 前崩溃时由清理 outbox 回收真实对象", async () => {
    const context = await seedModelWireAttempt("finalize-crash", scopeA);
    const body = new TextEncoder().encode("model-wire-finalize-crash");
    const sha256 = sha256Hex(body);
    const store = createS3BlobStore(minioConfig(), repository);
    const wire = new PgModelWireTraceRepository(runtimePool, repository, store, 1, {
      beforeFinalizeStored: () => {
        throw new Error("模拟 Blob completed 后 finalize 前进程退出");
      },
    });
    await expect(
      wire.persist({
        context,
        modelTurn: 0,
        transportAttempt: 0,
        part: "response",
        body,
        sha256,
        size: body.byteLength,
        status: "complete",
      }),
    ).rejects.toThrow("模拟 Blob completed 后 finalize 前进程退出");
    const beforeCleanup = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{
        persistence_status: string;
        blob_reference_id: string | null;
        commit_status: string;
        reference_id: string;
        lifecycle_id: string;
        incarnation_id: string;
        physical_object_key: string;
      }>(
        `SELECT record.persistence_status,record.blob_reference_id,commit.status AS commit_status,
                reference.reference_id,reference.lifecycle_id,reference.incarnation_id,
                reference.physical_object_key
           FROM model_wire_trace_records record
           JOIN blob_commits commit
             ON commit.tenant_id=record.tenant_id AND commit.operation_id=record.blob_operation_id
           JOIN blob_references reference
             ON reference.tenant_id=record.tenant_id
            AND reference.operation_id=record.blob_operation_id
          WHERE record.tenant_id=$1 AND record.attempt_id=$2`,
        [scopeA.tenantId, context.attemptId],
      ),
    );
    expect(beforeCleanup.rows).toHaveLength(1);
    expect(beforeCleanup.rows[0]).toMatchObject({
      persistence_status: "pending",
      blob_reference_id: null,
      commit_status: "completed",
    });
    const identity = beforeCleanup.rows[0];
    if (identity === undefined) throw new Error("缺少 finalize 崩溃后的 stable 身份");
    const stable = {
      kind: "stable" as const,
      tenantId: scopeA.tenantId,
      purpose: "trace" as const,
      sha256,
      size: body.byteLength,
      mediaType: "text/plain; charset=utf-8",
      incarnationId: identity.incarnation_id,
      physicalObjectKey: identity.physical_object_key,
    };
    await expect(store.getBytes(scopeA, stable)).resolves.toEqual(body);
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_records
          SET expires_at=clock_timestamp()-interval '1 second',
              processing_lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scopeA.tenantId, context.attemptId],
    );
    const deleteWithoutOutbox = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query(`DELETE FROM blob_references WHERE tenant_id=$1 AND reference_id=$2`, [
        scopeA.tenantId,
        identity.reference_id,
      ]),
    );
    expect(deleteWithoutOutbox.rowCount).toBe(0);
    const commandId = `wire-cleanup-finalize-crash-${unique}`;
    const cleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
    );
    await expect(
      cleanup.cleanupExpired({
        tenantId: scopeA.tenantId,
        commandId,
        expiresBefore: new Date(),
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ outcome: "completed", deletedCount: 1 });
    const afterCleanup = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{
        state: string;
        outcome: string;
        record_count: string;
        reference_count: string;
      }>(
        `SELECT item.state,item.outcome,
                (SELECT count(*)::text FROM model_wire_trace_records
                  WHERE tenant_id=$1 AND attempt_id=$3) AS record_count,
                (SELECT count(*)::text FROM blob_references
                  WHERE tenant_id=$1 AND reference_id=$4) AS reference_count
           FROM model_wire_trace_cleanup_items item
          WHERE item.tenant_id=$1 AND item.cleanup_command_id=$2`,
        [scopeA.tenantId, commandId, context.attemptId, identity.reference_id],
      ),
    );
    expect(afterCleanup.rows).toEqual([
      { state: "completed", outcome: "deleted", record_count: "0", reference_count: "0" },
    ]);
    await expect(store.getBytes(scopeA, stable)).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
  });

  it("Trace promotion in-flight 崩溃后从 durable anchor 恢复并完成真实对象回收", async () => {
    const context = await seedModelWireAttempt("in-flight-anchor", scopeA);
    const body = new TextEncoder().encode("model-wire-in-flight-anchor");
    const sha256 = sha256Hex(body);
    const baseStore = createS3BlobStore(minioConfig(), repository);
    const blockedStore: BlobStore = {
      putStaging: (input) => baseStore.putStaging(input),
      promote: () => Promise.reject(new Error("模拟 promotion_started 后进程退出")),
      head: (scope, blob) => baseStore.head(scope, blob),
      read: (scope, blob) => baseStore.read(scope, blob),
      getBytes: (scope, blob) => baseStore.getBytes(scope, blob),
      deleteStaging: (scope, blob) => baseStore.deleteStaging(scope, blob),
      presignDownload: (input) => baseStore.presignDownload(input),
    };
    const wire = new PgModelWireTraceRepository(runtimePool, repository, blockedStore, 1, {
      processingLeaseSeconds: 1,
    });
    await expect(
      wire.persist({
        context,
        modelTurn: 0,
        transportAttempt: 0,
        part: "request",
        body,
        sha256,
        size: body.byteLength,
        status: "complete",
      }),
    ).resolves.toBeUndefined();
    const anchored = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{
        persistence_status: string;
        cleanup_command_id: string | null;
        commit_status: string;
        reference_state: string;
      }>(
        `SELECT record.persistence_status,record.cleanup_command_id,
                commit.status AS commit_status,reference.state AS reference_state
           FROM model_wire_trace_records record
           JOIN blob_commits commit
             ON commit.tenant_id=record.tenant_id AND commit.operation_id=record.blob_operation_id
           JOIN blob_references reference
             ON reference.tenant_id=record.tenant_id
            AND reference.operation_id=record.blob_operation_id
          WHERE record.tenant_id=$1 AND record.attempt_id=$2`,
        [scopeA.tenantId, context.attemptId],
      ),
    );
    expect(anchored.rows).toEqual([
      {
        persistence_status: "unavailable",
        cleanup_command_id: null,
        commit_status: "promotion_started",
        reference_state: "staged",
      },
    ]);
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_records
          SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scopeA.tenantId, context.attemptId],
    );
    const commandId = `wire-cleanup-in-flight-${unique}`;
    const unconfiguredCleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
    );
    await expect(
      unconfiguredCleanup.cleanupExpired({
        tenantId: scopeA.tenantId,
        commandId,
        expiresBefore: new Date(),
        batchSize: 10,
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const failClosed = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ command_count: string; record_count: string }>(
        `SELECT
           (SELECT count(*)::text FROM model_wire_trace_cleanup_commands
             WHERE tenant_id=$1 AND command_id=$3) AS command_count,
           (SELECT count(*)::text FROM model_wire_trace_records
             WHERE tenant_id=$1 AND attempt_id=$2) AS record_count`,
        [scopeA.tenantId, context.attemptId, commandId],
      ),
    );
    expect(failClosed.rows).toEqual([{ command_count: "0", record_count: "1" }]);
    const cleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
      { inFlightRecovery: { commits: repository, blobs: baseStore } },
    );
    await expect(
      cleanup.cleanupExpired({
        tenantId: scopeA.tenantId,
        commandId,
        expiresBefore: new Date(),
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ outcome: "completed", deletedCount: 1 });
    const recovered = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{
        commit_status: string;
        record_count: string;
        reference_count: string;
        item_state: string;
        item_outcome: string;
        incarnation_id: string;
        physical_object_key: string;
      }>(
        `SELECT commit.status AS commit_status,
                (SELECT count(*)::text FROM model_wire_trace_records
                  WHERE tenant_id=$1 AND attempt_id=$2) AS record_count,
                (SELECT count(*)::text FROM blob_references reference
                  WHERE reference.tenant_id=commit.tenant_id
                    AND reference.operation_id=commit.operation_id) AS reference_count,
                item.state AS item_state,item.outcome AS item_outcome,
                item.incarnation_id,item.physical_object_key
           FROM blob_commits commit
           JOIN model_wire_trace_expiry_tombstones tombstone
             ON tombstone.tenant_id=commit.tenant_id
            AND tombstone.blob_operation_id=commit.operation_id
           JOIN model_wire_trace_cleanup_items item
             ON item.tenant_id=tombstone.tenant_id
            AND item.cleanup_command_id=tombstone.cleanup_command_id
          WHERE commit.tenant_id=$1 AND tombstone.attempt_id=$2`,
        [scopeA.tenantId, context.attemptId],
      ),
    );
    expect(recovered.rows).toHaveLength(1);
    expect(recovered.rows[0]).toMatchObject({
      commit_status: "completed",
      record_count: "0",
      reference_count: "0",
      item_state: "completed",
      item_outcome: "deleted",
    });
    const removed = recovered.rows[0];
    if (removed === undefined) throw new Error("缺少 promotion recovery 清理 item");
    await expect(
      baseStore.getBytes(scopeA, {
        kind: "stable",
        tenantId: scopeA.tenantId,
        purpose: "trace",
        sha256,
        size: body.byteLength,
        mediaType: "text/plain; charset=utf-8",
        incarnationId: removed.incarnation_id,
        physicalObjectKey: removed.physical_object_key,
      }),
    ).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
  });

  it("prepare 后清理与迟到 upload_pending 交错时由永久墓碑周期重删 staging", async () => {
    const context = await seedModelWireAttempt("upload-pending-tombstone", scopeA);
    const body = new TextEncoder().encode("model-wire-upload-pending-tombstone");
    const sha256 = sha256Hex(body);
    const baseStore = createS3BlobStore(minioConfig(), repository);
    let persistenceEntered!: () => void;
    let releasePersistence!: () => void;
    const persistenceBarrier = new Promise<void>((resolve) => (persistenceEntered = resolve));
    const persistenceReleased = new Promise<void>((resolve) => (releasePersistence = resolve));
    const crashingCommits = new Proxy(repository, {
      get(target, property) {
        if (property === "compareAndSet") {
          return (input: { readonly next: BlobCommitSnapshot }) => {
            if (input.next.status === "staged") {
              throw new Error("模拟 PUT 返回后、stage CAS 前进程退出");
            }
            return target.compareAndSet(input as Parameters<typeof target.compareAndSet>[0]);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wire = new PgModelWireTraceRepository(runtimePool, crashingCommits, baseStore, 1, {
      processingLeaseSeconds: 1,
      beforeBlobPersistence: async () => {
        persistenceEntered();
        await persistenceReleased;
      },
    });
    const persist = wire.persist({
      context,
      modelTurn: 0,
      transportAttempt: 0,
      part: "request",
      body,
      sha256,
      size: body.byteLength,
      status: "complete",
    });
    await persistenceBarrier;
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_records
          SET expires_at=clock_timestamp()-interval '1 second',
              processing_lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scopeA.tenantId, context.attemptId],
    );
    const command = {
      tenantId: scopeA.tenantId,
      commandId: `wire-cleanup-upload-pending-${unique}`,
      expiresBefore: new Date(),
      batchSize: 10,
    };
    const cleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
    );
    await expect(cleanup.cleanupExpired(command)).resolves.toMatchObject({
      outcome: "completed",
      deletedCount: 1,
    });
    await expect(cleanup.cleanupExpired(command)).resolves.toMatchObject({ outcome: "replayed" });
    releasePersistence();
    await expect(persist).rejects.toThrow();
    const durable = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ blob_operation_id: string; commit_status: string; record_count: string }>(
        `SELECT tombstone.blob_operation_id,commit.status AS commit_status,
                (SELECT count(*)::text FROM model_wire_trace_records
                  WHERE tenant_id=$1 AND attempt_id=$2) AS record_count
           FROM model_wire_trace_expiry_tombstones tombstone
           JOIN blob_commits commit
             ON commit.tenant_id=tombstone.tenant_id
            AND commit.operation_id=tombstone.blob_operation_id
          WHERE tombstone.tenant_id=$1 AND tombstone.attempt_id=$2`,
        [scopeA.tenantId, context.attemptId],
      ),
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]).toMatchObject({ commit_status: "upload_pending", record_count: "0" });
    const operationId = durable.rows[0]?.blob_operation_id;
    if (operationId === undefined) throw new Error("缺少墓碑关联的 upload_pending commit");
    const staging = {
      kind: "staging" as const,
      tenantId: scopeA.tenantId,
      purpose: "trace" as const,
      uploadId: `trace-${operationId}`,
      sha256,
      size: body.byteLength,
      mediaType: "text/plain; charset=utf-8",
    };
    await expect(baseStore.head(scopeA, staging)).resolves.toBeDefined();
    const restartedCleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
      { inFlightRecovery: { commits: repository, blobs: baseStore } },
    );
    await expect(
      restartedCleanup.resumePending({ tenantId: scopeA.tenantId, batchSize: 10 }),
    ).resolves.toBe(0);
    await expect(baseStore.head(scopeA, staging)).resolves.toBeUndefined();
    await baseStore.putStaging({
      scope: scopeA,
      purpose: "trace",
      uploadId: staging.uploadId,
      body,
      mediaType: staging.mediaType,
      expectedSha256: sha256,
      expectedSize: body.byteLength,
    });
    await expect(baseStore.head(scopeA, staging)).resolves.toBeDefined();
    await expect(
      restartedCleanup.resumePending({ tenantId: scopeA.tenantId, batchSize: 10 }),
    ).resolves.toBe(0);
    await expect(baseStore.head(scopeA, staging)).resolves.toBeUndefined();
  });

  it("永久墓碑 staging sweep 在 batchSize=1 时公平轮转到第二个 operation", async () => {
    const store = createS3BlobStore(minioConfig(), repository);
    const cleanupCommandId = `wire-sweep-fairness-${unique}`;
    const operations = [0, 1].map((index) => ({
      attemptId: `wire-sweep-attempt-${index}-${unique}`,
      operationId: `trace-${sha256Hex(new TextEncoder().encode(`wire-sweep-op-${index}-${unique}`))}`,
      digest: sha256Hex(new TextEncoder().encode(`wire-sweep-command-${index}-${unique}`)),
      sha256: sha256Hex(new TextEncoder().encode(`wire-sweep-body-${index}-${unique}`)),
    }));
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_expiry_tombstones
          SET staging_swept_at=clock_timestamp()
        WHERE tenant_id=$1 AND staging_swept_at IS NULL`,
      [scopeA.tenantId],
    );
    await migrationTenantQuery(
      scopeA,
      `INSERT INTO model_wire_trace_cleanup_commands(
         tenant_id,command_id,command_digest,expires_before,batch_size,status,deleted_count,completed_at
       ) VALUES ($1,$2,$3,clock_timestamp(),1,'completed',0,clock_timestamp())`,
      [scopeA.tenantId, cleanupCommandId, sha256Hex(new TextEncoder().encode(cleanupCommandId))],
    );
    for (const [index, operation] of operations.entries()) {
      await migrationTenantQuery(
        scopeA,
        `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot)
         VALUES ($1,$2,'upload_pending',0,$3::jsonb)`,
        [
          scopeA.tenantId,
          operation.operationId,
          JSON.stringify({
            operationId: operation.operationId,
            scope: { tenantId: scopeA.tenantId },
            status: "upload_pending",
            version: 0,
            expectedPurpose: "trace",
            expectedSha256: operation.sha256,
            expectedSize: 1,
          }),
        ],
      );
      await migrationTenantQuery(
        scopeA,
        `INSERT INTO model_wire_trace_expiry_tombstones(
           tenant_id,attempt_id,model_turn,transport_attempt,part,command_digest,
           blob_operation_id,sha256,size,cleanup_command_id
         ) VALUES ($1,$2,$3,0,'request',$4,$5,$6,1,$7)`,
        [
          scopeA.tenantId,
          operation.attemptId,
          index,
          operation.digest,
          operation.operationId,
          operation.sha256,
          cleanupCommandId,
        ],
      );
    }
    const cleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
      { inFlightRecovery: { commits: repository, blobs: store } },
    );
    await expect(cleanup.resumePending({ tenantId: scopeA.tenantId, batchSize: 1 })).resolves.toBe(
      0,
    );
    const firstSweep = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ swept: string }>(
        `SELECT count(staging_swept_at)::text AS swept
           FROM model_wire_trace_expiry_tombstones
          WHERE tenant_id=$1 AND cleanup_command_id=$2`,
        [scopeA.tenantId, cleanupCommandId],
      ),
    );
    expect(firstSweep.rows).toEqual([{ swept: "1" }]);
    await expect(cleanup.resumePending({ tenantId: scopeA.tenantId, batchSize: 1 })).resolves.toBe(
      0,
    );
    const secondSweep = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ swept: string }>(
        `SELECT count(staging_swept_at)::text AS swept
           FROM model_wire_trace_expiry_tombstones
          WHERE tenant_id=$1 AND cleanup_command_id=$2`,
        [scopeA.tenantId, cleanupCommandId],
      ),
    );
    expect(secondSweep.rows).toEqual([{ swept: "2" }]);
  });

  it("慢上传穿越 processing lease 后由墓碑补偿迟到引用，max=1 pool 并发无连接饥饿", async () => {
    const context = await seedModelWireAttempt("late", scopeA);
    const body = new TextEncoder().encode("model-wire-late-body");
    const sha256 = sha256Hex(body);
    const baseStore = createS3BlobStore(minioConfig(), repository);
    let entered!: () => void;
    let release!: () => void;
    const persistenceEntered = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const wire = new PgModelWireTraceRepository(runtimePool, repository, baseStore, 1, {
      processingLeaseSeconds: 1,
      beforeBlobPersistence: async () => {
        entered();
        await released;
      },
      beforeLateReferenceCompensation: () => {
        throw new Error("模拟迟到引用补偿前进程退出");
      },
    });
    const persist = wire.persist({
      context,
      modelTurn: 0,
      transportAttempt: 0,
      part: "request",
      body,
      sha256,
      size: body.byteLength,
      status: "complete",
    });
    await persistenceEntered;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await migrationTenantQuery(
      scopeA,
      `UPDATE model_wire_trace_records SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scopeA.tenantId, context.attemptId],
    );
    const cleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
    );
    await cleanup.cleanupExpired({
      tenantId: scopeA.tenantId,
      commandId: `wire-cleanup-late-${unique}`,
      expiresBefore: new Date(),
      batchSize: 10,
    });
    release();
    await expect(persist).rejects.toThrow("模拟迟到引用补偿前进程退出");
    const orphanBeforeRestart = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query(
        "SELECT 1 FROM blob_references WHERE tenant_id=$1 AND purpose='trace' AND sha256=$2",
        [scopeA.tenantId, sha256],
      ),
    );
    expect(orphanBeforeRestart.rowCount).toBe(1);
    const raceReferenceId = `wire-cleanup-race-${unique}`;
    let completionEntered!: () => void;
    let releaseCompletion!: () => void;
    const completionBarrier = new Promise<void>((resolve) => (completionEntered = resolve));
    const completionReleased = new Promise<void>((resolve) => (releaseCompletion = resolve));
    const restartedCleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
      {
        beforeCompletionTransition: async () => {
          completionEntered();
          await completionReleased;
        },
      },
    );
    const resuming = restartedCleanup.resumePending({ tenantId: scopeA.tenantId, batchSize: 10 });
    await completionBarrier;
    await withTenantTransaction(runtimePool, scopeA, async (client) => {
      const inserted = await client.query(
        `INSERT INTO model_wire_trace_cleanup_items(
           tenant_id,cleanup_command_id,blob_reference_id,lifecycle_id,purpose,sha256,size,
           incarnation_id,physical_object_key,state
         ) SELECT tenant_id,cleanup_command_id,$3,lifecycle_id,purpose,sha256,size,
                  incarnation_id,physical_object_key,'pending'
             FROM model_wire_trace_cleanup_items
            WHERE tenant_id=$1 AND cleanup_command_id=$2
            ORDER BY created_at,blob_reference_id LIMIT 1`,
        [scopeA.tenantId, `wire-cleanup-late-${unique}`, raceReferenceId],
      );
      expect(inserted.rowCount).toBe(1);
      const reopened = await client.query(
        `UPDATE model_wire_trace_cleanup_commands
            SET status='references_released',completed_at=NULL
          WHERE tenant_id=$1 AND command_id=$2 AND status='completed'`,
        [scopeA.tenantId, `wire-cleanup-late-${unique}`],
      );
      expect(reopened.rowCount).toBe(1);
    });
    releaseCompletion();
    await expect(resuming).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const raced = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ status: string; pending_count: string }>(
        `SELECT command.status,
                count(item.*) FILTER (WHERE item.state<>'completed')::text AS pending_count
           FROM model_wire_trace_cleanup_commands command
           LEFT JOIN model_wire_trace_cleanup_items item
             ON item.tenant_id=command.tenant_id AND item.cleanup_command_id=command.command_id
          WHERE command.tenant_id=$1 AND command.command_id=$2
          GROUP BY command.status`,
        [scopeA.tenantId, `wire-cleanup-late-${unique}`],
      ),
    );
    expect(raced.rows).toEqual([{ status: "references_released", pending_count: "1" }]);
    const finalCleanup = new PgModelWireTraceCleanupRepository(
      runtimePool,
      createS3StableBlobGarbageCollector(minioConfig(), repository),
    );
    await expect(
      finalCleanup.resumePending({ tenantId: scopeA.tenantId, batchSize: 10 }),
    ).resolves.toBe(1);
    const late = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ state: string; outcome: string }>(
        `SELECT state,outcome FROM model_wire_trace_cleanup_items
          WHERE tenant_id=$1 AND cleanup_command_id=$2`,
        [scopeA.tenantId, `wire-cleanup-late-${unique}`],
      ),
    );
    expect(late.rows).toHaveLength(2);
    expect(late.rows.every((row) => row.state === "completed" && row.outcome === "deleted")).toBe(
      true,
    );
    const references = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query(
        "SELECT 1 FROM blob_references WHERE tenant_id=$1 AND purpose='trace' AND sha256=$2",
        [scopeA.tenantId, sha256],
      ),
    );
    expect(references.rowCount).toBe(0);

    const single = createPostgresPool({
      connectionString: runtimeDatabaseUrl,
      schema,
      maxConnections: 1,
    });
    try {
      const singleRepo = new PgBlobLifecycleRepository(single, { objectPrefix: prefix });
      const singleWire = new PgModelWireTraceRepository(
        single,
        singleRepo,
        createS3BlobStore(minioConfig(), singleRepo),
        1,
      );
      const singleContext = await seedModelWireAttempt("single", scopeA);
      const operations = [0, 1].map((transportAttempt) =>
        singleWire.persist({
          context: singleContext,
          modelTurn: 0,
          transportAttempt,
          part: "request",
          body,
          sha256,
          size: body.byteLength,
          status: "complete",
        }),
      );
      await expect(
        Promise.race([
          Promise.all(operations),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("max=1 pool 饥饿")), 20_000),
          ),
        ]),
      ).resolves.toBeDefined();
    } finally {
      await single.end();
    }
  });

  it("0017 在含索引、清理 item 与墓碑事实时可 down 至 0016 后再次 up 并恢复 ACL/RLS", async () => {
    const before = await withTenantTransaction(runtimePool, scopeA, (client) =>
      client.query<{ records: string; items: string; tombstones: string }>(
        `SELECT
           (SELECT count(*)::text FROM model_wire_trace_records) AS records,
           (SELECT count(*)::text FROM model_wire_trace_cleanup_items) AS items,
           (SELECT count(*)::text FROM model_wire_trace_expiry_tombstones) AS tombstones`,
      ),
    );
    expect(Number(before.rows[0]?.records)).toBeGreaterThan(0);
    expect(Number(before.rows[0]?.items)).toBeGreaterThan(0);
    expect(Number(before.rows[0]?.tombstones)).toBeGreaterThan(0);
    await migrateDown(migratorPool, {
      ...migrationSecurity,
      allowDestructive: true,
      environment: "test",
      targetVersion: 16,
    });
    const down = await migratorPool.query<{
      records: string | null;
      items: string | null;
      tombstones: string | null;
      identity_constraint: string | null;
    }>(
      `SELECT to_regclass('model_wire_trace_records')::text AS records,
              to_regclass('model_wire_trace_cleanup_items')::text AS items,
              to_regclass('model_wire_trace_expiry_tombstones')::text AS tombstones,
              (SELECT conname FROM pg_constraint
                WHERE conrelid='blob_references'::regclass
                  AND conname='blob_references_model_wire_identity_unique') AS identity_constraint`,
    );
    expect(down.rows[0]).toEqual({
      records: null,
      items: null,
      tombstones: null,
      identity_constraint: null,
    });
    const latestVersion = (await loadMigrations()).at(-1)?.version;
    expect((await migrateUp(migratorPool, migrationSecurity)).at(-1)?.version).toBe(latestVersion);
    const restored = await migratorPool.query<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      runtime_select: boolean;
    }>(
      `SELECT relation.relname AS table_name,relation.relrowsecurity AS rls,
              relation.relforcerowsecurity AS forced,
              has_table_privilege($1,relation.oid,'SELECT') AS runtime_select
         FROM pg_class relation
        WHERE relation.relnamespace=current_schema()::regnamespace
          AND relation.relname IN (
            'model_wire_trace_records','model_wire_trace_cleanup_commands',
            'model_wire_trace_cleanup_items','model_wire_trace_expiry_tombstones'
          ) ORDER BY relation.relname`,
      [runtimeRole],
    );
    expect(restored.rows).toHaveLength(4);
    expect(restored.rows.every((row) => row.rls && row.forced && row.runtime_select)).toBe(true);
    const deletePrivilege = await migratorPool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege($1,'blob_references','DELETE') AS allowed",
      [runtimeRole],
    );
    expect(deletePrivilege.rows[0]?.allowed).toBe(true);
  });
});
