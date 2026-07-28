import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { encodeControlledToolReceipt, ToolObservationPipeline } from "@cube-runtime/context-policy";
import {
  agentThreadId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
} from "@cube-runtime/domain";
import type {
  ExecutionFence,
  ExecutionScope,
  SandboxSessionRegistryPort,
} from "@cube-runtime/run-contracts";
import { rolloutProjectionDigest } from "@cube-runtime/run-contracts/mutation-protocol";
import { FakeSandboxGateway } from "@cube-runtime/sandbox/testing";
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
import { startWorkerProcess } from "../../runtime-ts/apps/agent-worker/src/process-entry.js";
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
  createS3BlobStore,
  createS3RetiredBlobTombstoneScrubber,
  createS3StableBlobGarbageCollector,
  createDurableTraceBlobPersistence,
  PgBackedSandboxSessionRegistry,
  PgExecutionPersistence,
  PgRunDispatchOutbox,
  sha256Hex,
  transitionBlobCommit,
  type BlobCommitSnapshot,
  type CreateS3BlobStoreConfig,
  type StableBlobLifecycleAllocation,
  type StableBlobRef,
  type StagedBlobRef,
  type TenantBlobScope,
} from "../../runtime-ts/packages/persistence/src/index.js";
import { PgRuntimeRolloutRepository } from "../../runtime-ts/packages/persistence/src/pg-runtime-rollout.js";
import { PgToolObservationRolloutAdapter } from "../../runtime-ts/packages/persistence/src/tool-observation-rollout-adapter.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgBlobLifecycleRepository } from "../../runtime-ts/packages/persistence/src/pg-blob-lifecycle.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

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
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;

let administrativePool!: Pool;
let migratorPool!: Pool;
let runtimePool!: Pool;
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

beforeAll(async () => {
  administrativePool = createPostgresPool({
    connectionString: bootstrapDatabaseUrl,
    maxConnections: 2,
  });
  await administrativePool.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}";
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
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}"; DROP ROLE "${migratorRole}"`,
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
  it("开发 Agent Worker 入口装配真实 PG、S3 Observation 与 Pi 恢复依赖", async () => {
    const dependencyServer = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/sandbox/v2/sandboxes") {
        response.end("[]");
        return;
      }
      if (request.url === "/model/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "integration-model" }] }));
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
          S3_ENDPOINT: requiredEnvironment("S3_ENDPOINT"),
          S3_BUCKET: requiredEnvironment("S3_BUCKET"),
          S3_REGION: requiredEnvironment("S3_REGION"),
          S3_ACCESS_KEY_ID: requiredEnvironment("S3_ACCESS_KEY_ID"),
          S3_SECRET_ACCESS_KEY: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
          S3_FORCE_PATH_STYLE: "true",
          CUBESANDBOX_API_URL: `http://127.0.0.1:${address.port}/sandbox`,
          CUBESANDBOX_TEMPLATE_ID: "integration-template",
          MODEL_BASE_URL: `http://127.0.0.1:${address.port}/model/v1/`,
          MODEL_API_KEY: "integration-model-key",
          MODEL_ID: "integration-model",
          MODEL_CONTEXT_WINDOW: "128000",
          MODEL_MAX_OUTPUT_TOKENS: "16384",
          AGENT_WORKER_TENANT_ID: scopeA.tenantId,
          AGENT_WORKER_ID: "integration-worker",
          AGENT_WORKER_POLL_INTERVAL_MS: "100",
          AGENT_WORKER_DISPATCH_LEASE_MS: "30000",
          AGENT_WORKER_RUN_LEASE_MS: "30000",
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
      const inputText = "执行一次受控命令后完成";
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
          sandboxSequence += 1;
          return {
            outcome: "ready",
            session: {
              registryId: `registry-${label}-${sandboxSequence}`,
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
          fauxToolCall("sandbox_command", { command: "printf vertical" }, { id: `call_${label}` }),
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
      const durableObservation = createPgDurableObservationSession({
        blobRepository,
        blobs: createS3BlobStore(minioConfig(), blobRepository),
        rolloutRepository: new PgRuntimeRolloutRepository(runtimePool),
        policy: { maxModelObservationBytes: 64 },
      });
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
        durableObservation.createRecorder,
        undefined,
        undefined,
        durableObservation.prepare,
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
      const loop = new AgentWorkerPollingLoop(new PgRunDispatchOutbox(runtimePool), worker, {
        tenantId: scopeA.tenantId,
        workerId: `dispatcher-${label}`,
        pollIntervalMs: 25,
        dispatchLeaseMs: 30_000,
      });
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
      expect(faux.state.callCount).toBe(2);
      const facts = await withTenantTransaction(
        runtimePool,
        { tenantId: scopeA.tenantId, userId: actorUserId },
        async (client) =>
          client.query<{
            kind: string;
            blob_reference_id: string | null;
            blob_state: string | null;
            blob_purpose: string | null;
          }>(
            `SELECT entry.kind,entry.blob_reference_id,
                    reference.state AS blob_state,reference.purpose AS blob_purpose
               FROM runtime_rollout_entries entry
               LEFT JOIN blob_references reference
                 ON reference.tenant_id=entry.tenant_id
                AND reference.reference_id=entry.blob_reference_id
              WHERE entry.tenant_id=$1 AND entry.run_id=$2 ORDER BY entry.sequence`,
            [scopeA.tenantId, executionScope.runId],
          ),
      );
      expect(facts.rows.map((row) => row.kind)).toEqual(["tool_call", "tool_result"]);
      expect(facts.rows[1]).toMatchObject({ blob_state: "stable", blob_purpose: "trace" });
      expect(facts.rows[1]?.blob_reference_id).toBeTypeOf("string");
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
});
