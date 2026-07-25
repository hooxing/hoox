import { randomBytes, randomUUID } from "node:crypto";
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createS3BlobStore,
  createS3RetiredBlobTombstoneScrubber,
  createS3StableBlobGarbageCollector,
  sha256Hex,
  transitionBlobCommit,
  type BlobCommitSnapshot,
  type CreateS3BlobStoreConfig,
  type StableBlobLifecycleAllocation,
  type StableBlobRef,
  type StagedBlobRef,
  type TenantBlobScope,
} from "../../runtime-ts/packages/persistence/src/index.js";
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
  const started = await repository.startPromotion({
    scope,
    operationId,
    expectedSnapshotVersion: next.version,
    allocationId: allocation.allocationId,
  });
  if (started.status !== "started") throw new Error(`startPromotion 失败：${started.status}`);
  return { referenceId, allocation, stable, authorization: started.authorization };
}

describe("PostgreSQL stable blob 生命周期", () => {
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
    const originalConnect = runtimePool.connect.bind(runtimePool);
    let inject = true;
    const lossyPool = new Proxy(runtimePool, {
      get(target, property, receiver) {
        if (property !== "connect") return Reflect.get(target, property, receiver);
        return async () => {
          const client = await originalConnect();
          const originalQuery = client.query.bind(client);
          client.query = (async (...args: unknown[]) => {
            const result = await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(
              ...args,
            );
            if (inject && typeof args[0] === "string" && args[0] === "COMMIT") {
              inject = false;
              throw Object.assign(new Error("模拟 COMMIT 响应丢失"), { code: "ECONNRESET" });
            }
            return result;
          }) as typeof client.query;
          return client;
        };
      },
    }) as Pool;
    const lossy = new PgBlobLifecycleRepository(lossyPool, { objectPrefix: prefix });
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
