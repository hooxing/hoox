import { randomBytes, randomUUID } from "node:crypto";
import { resourceId, resourceVersionId, tenantId, userId } from "@cube-runtime/domain";
import {
  type AuthorizedAgentResourceContext,
  createPromotionCapabilityRegistry,
  normalizeSearchQuery,
  type PromoteResourceCapability,
  type TrustedResourceContext,
} from "@cube-runtime/resource";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgBlobLifecycleRepository } from "../../runtime-ts/packages/persistence/src/pg-blob-lifecycle.js";
import {
  PgResourceCatalog,
  PgResourcePromotionRepository,
} from "../../runtime-ts/packages/persistence/src/pg-resource-library.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Resource PostgreSQL 集成测试缺少 ${name}；不会输出配置值`);
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
const schema = `it_resource_${unique}`;
const migratorRole = `it_rs_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;

const scopeA: TrustedResourceContext = {
  tenantId: tenantId(`resource_tenant_a_${unique}`),
  userId: userId(`resource_user_a_${unique}`),
};
const scopeB: TrustedResourceContext = {
  tenantId: tenantId(`resource_tenant_b_${unique}`),
  userId: userId(`resource_user_b_${unique}`),
};

interface TenantFixture {
  readonly scope: TrustedResourceContext;
  readonly agentThreadId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly promotionCapability: PromoteResourceCapability;
}

interface PromotionFixture {
  readonly authorizationId: string;
  readonly operationId?: string;
  readonly blobReferenceId: string;
  readonly digest: string;
  readonly lifecycleId?: string;
  readonly incarnationId?: string;
  readonly physicalObjectKey?: string;
  readonly size?: number;
}

let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let catalog!: PgResourceCatalog;
let promotions!: PgResourcePromotionRepository;
let tenantA!: TenantFixture;
let tenantB!: TenantFixture;
let schemaCreated = false;
let migratorCreated = false;
const promotionCapabilities = createPromotionCapabilityRegistry();

function authorizedContext(
  scope: TrustedResourceContext,
  agentThreadId: string,
  threadId: string,
  runId: string,
): AuthorizedAgentResourceContext {
  return Object.freeze({
    ...scope,
    actor: Object.freeze({
      kind: "agent" as const,
      agentThreadId: agentThreadId as AuthorizedAgentResourceContext["actor"]["agentThreadId"],
      threadId: threadId as AuthorizedAgentResourceContext["actor"]["threadId"],
      runId: runId as AuthorizedAgentResourceContext["actor"]["runId"],
    }),
  });
}

async function seedTenant(scope: TrustedResourceContext, label: string): Promise<TenantFixture> {
  const threadId = `resource_thread_${label}_${unique}`;
  const runId = `resource_run_${label}_${unique}`;
  const workspaceId = `resource_workspace_${label}_${unique}`;
  const revisionId = `resource_revision_${label}_${unique}`;
  const agentThreadId = `resource_agent_${label}_${unique}`;
  await withTenantTransaction(runtime, scope, async (client) => {
    await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, clock_timestamp())", [
      scope.userId,
    ]);
    await client.query(
      "INSERT INTO tenants(id, kind, owner_user_id, created_at) VALUES ($1, 'personal', $2, clock_timestamp())",
      [scope.tenantId, scope.userId],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id, id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'owner', 'active', clock_timestamp())`,
      [scope.tenantId, `resource_membership_${label}_${unique}`, scope.userId],
    );
    await client.query(
      `INSERT INTO threads(tenant_id, id, created_by_user_id, title, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', clock_timestamp(), clock_timestamp())`,
      [scope.tenantId, threadId, scope.userId, `Resource 集成 ${label}`],
    );
    await client.query(
      `INSERT INTO runs(tenant_id, id, thread_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'running', clock_timestamp(), clock_timestamp())`,
      [scope.tenantId, runId, threadId],
    );
    await client.query(
      `INSERT INTO workspaces(
         tenant_id, id, thread_id, current_revision_number, lease_epoch, created_at, updated_at
       ) VALUES ($1, $2, $3, 0, 1, clock_timestamp(), clock_timestamp())`,
      [scope.tenantId, workspaceId, threadId],
    );
    await client.query(
      `INSERT INTO workspace_revisions(
         tenant_id, workspace_id, id, thread_id, revision_number, created_by_run_id,
         lease_epoch, object_key, digest, created_at
       ) VALUES ($1,$2,$3,$4,1,$5,1,$6,$7,clock_timestamp())`,
      [
        scope.tenantId,
        workspaceId,
        revisionId,
        threadId,
        runId,
        `integration/workspace/${label}`,
        "f".repeat(64),
      ],
    );
    await client.query(
      `UPDATE workspaces
          SET current_revision_number = 1, current_revision_id = $3, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [scope.tenantId, workspaceId, revisionId],
    );
    await client.query(
      `INSERT INTO workspace_write_leases(
         tenant_id, workspace_id, thread_id, root_run_id, epoch, expires_at
       ) VALUES ($1,$2,$3,$4,1,clock_timestamp() + interval '1 hour')`,
      [scope.tenantId, workspaceId, threadId, runId],
    );
  });
  return {
    scope,
    agentThreadId,
    threadId,
    runId,
    workspaceId,
    revisionId,
    promotionCapability: promotionCapabilities.issuer.issue(
      authorizedContext(scope, agentThreadId, threadId, runId),
    ),
  };
}

async function seedPromotion(
  fixture: TenantFixture,
  label: string,
  digest = randomBytes(32).toString("hex"),
): Promise<PromotionFixture> {
  const authorizationId = `resource-auth-${label}-${randomUUID()}`;
  const operationId = `resource-op-${label}-${randomUUID()}`;
  const blobReferenceId = randomUUID();
  const lifecycleId = randomUUID();
  const incarnationId = randomUUID();
  const size = 12;
  const physicalObjectKey = `integration/stable/${fixture.scope.tenantId}/resource/sha256/${digest}/incarnations/${incarnationId}`;
  await withTenantTransaction(runtime, fixture.scope, async (client) => {
    await client.query(
      `INSERT INTO blob_commits(tenant_id, operation_id, status, version, snapshot)
       VALUES ($1, $2, 'completed', 0, '{}'::jsonb)`,
      [fixture.scope.tenantId, operationId],
    );
    await client.query(
      `INSERT INTO blob_lifecycles(
         tenant_id, lifecycle_id, purpose, sha256, size, state,
         current_incarnation_id, generation
       ) VALUES ($1,$2,'resource',$3,$4,'active',$5,1)`,
      [fixture.scope.tenantId, lifecycleId, digest, size, incarnationId],
    );
    await client.query(
      `INSERT INTO blob_incarnations(
         tenant_id, lifecycle_id, purpose, sha256, size,
         incarnation_id, physical_object_key, state
       ) VALUES ($1,$2,'resource',$3,$4,$5,$6,'active')`,
      [fixture.scope.tenantId, lifecycleId, digest, size, incarnationId, physicalObjectKey],
    );
    await client.query(
      `INSERT INTO blob_references(
         tenant_id, reference_id, operation_id, state, purpose, sha256, size,
         media_type, staging_upload_id, lifecycle_id, incarnation_id, physical_object_key
       ) VALUES ($1,$2,$3,'stable','resource',$4,$5,'text/plain',$6,$7,$8,$9)`,
      [
        fixture.scope.tenantId,
        blobReferenceId,
        operationId,
        digest,
        size,
        `staging-${label}`,
        lifecycleId,
        incarnationId,
        physicalObjectKey,
      ],
    );
    // 该 INSERT 模拟未来 Workspace 事实源的同事务授权写入；生产包不暴露签发方法。
    await client.query(
      `INSERT INTO resource_promotion_authorizations(
         tenant_id, authorization_id, user_id, agent_thread_id, thread_id, run_id,
         workspace_id, revision_id, writer_lease_epoch, relative_path,
         digest, media_type, size, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,'text/plain',$11,
                 clock_timestamp() + interval '15 minutes')`,
      [
        fixture.scope.tenantId,
        authorizationId,
        fixture.scope.userId,
        fixture.agentThreadId,
        fixture.threadId,
        fixture.runId,
        fixture.workspaceId,
        fixture.revisionId,
        `deliverables/${label}.txt`,
        digest,
        size,
      ],
    );
  });
  return {
    authorizationId,
    operationId,
    blobReferenceId,
    digest,
    lifecycleId,
    incarnationId,
    physicalObjectKey,
    size,
  };
}

async function seedAuthorizationOnly(
  fixture: TenantFixture,
  label: string,
  digest: string,
): Promise<PromotionFixture> {
  const authorizationId = `resource-auth-${label}-${randomUUID()}`;
  await withTenantTransaction(runtime, fixture.scope, (client) =>
    client.query(
      `INSERT INTO resource_promotion_authorizations(
         tenant_id, authorization_id, user_id, agent_thread_id, thread_id, run_id,
         workspace_id, revision_id, writer_lease_epoch, relative_path,
         digest, media_type, size, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,'text/plain',12,
                 clock_timestamp() + interval '15 minutes')`,
      [
        fixture.scope.tenantId,
        authorizationId,
        fixture.scope.userId,
        fixture.agentThreadId,
        fixture.threadId,
        fixture.runId,
        fixture.workspaceId,
        fixture.revisionId,
        `deliverables/${label}.txt`,
        digest,
      ],
    ),
  );
  return { authorizationId, blobReferenceId: randomUUID(), digest };
}

function command(
  fixture: TenantFixture,
  promotion: PromotionFixture,
  input: {
    readonly key: string;
    readonly resource: string;
    readonly version: string;
    readonly expected?: number;
    readonly name?: string;
  },
) {
  return {
    context: fixture.scope,
    capability: fixture.promotionCapability,
    authorizationId: promotion.authorizationId,
    idempotencyKey: input.key,
    resourceId: resourceId(input.resource),
    resourceVersionId: resourceVersionId(input.version),
    expectedLatestVersionNumber: input.expected ?? 0,
    resourceName: input.name ?? `${input.resource}.txt`,
    blobReferenceId: promotion.blobReferenceId,
  };
}

function repositoryWithOneLostCommitResponse(): PgResourcePromotionRepository {
  const originalConnect = runtime.connect.bind(runtime);
  let inject = true;
  const lossyPool = new Proxy(runtime, {
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
            inject = false;
            client.query = originalMethod;
            throw Object.assign(new Error("模拟 Resource COMMIT 成功后的响应丢失"), {
              code: "ECONNRESET",
            });
          }
          return result;
        }) as typeof client.query;
        return client;
      };
    },
  }) as Pool;
  return new PgResourcePromotionRepository(lossyPool, promotionCapabilities.verifier);
}

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapDatabaseUrl, maxConnections: 2 });
  await admin.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}";
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
  expect((await migrateUp(migrator, migrationSecurity)).map((record) => record.version)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  catalog = new PgResourceCatalog(runtime);
  promotions = new PgResourcePromotionRepository(runtime, promotionCapabilities.verifier);
  tenantA = await seedTenant(scopeA, "a");
  tenantB = await seedTenant(scopeB, "b");
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
    const residual = await migrator.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class
        WHERE relnamespace = current_schema()::regnamespace
          AND relkind IN ('r', 'p') AND relname <> 'runtime_schema_migrations'`,
    );
    expect(residual.rows[0]?.count).toBe("0");
    await migrator.end();
  }
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await admin.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}"; DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin !== undefined) await admin.end();
});

describe("Resource Library PostgreSQL 与 RLS", () => {
  it("不读取访问器或 Proxy，并拒绝多余字段与伪造 capability", async () => {
    let contextReads = 0;
    const alternatingContext = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(alternatingContext, {
      tenantId: {
        enumerable: true,
        get() {
          contextReads += 1;
          return contextReads === 1 ? tenantA.scope.tenantId : tenantB.scope.tenantId;
        },
      },
      userId: { enumerable: true, value: tenantA.scope.userId },
    });
    await expect(
      catalog.search({
        context: alternatingContext as unknown as TrustedResourceContext,
        normalizedQuery: "",
        limit: 10,
      }),
    ).rejects.toThrow("无访问器");
    expect(contextReads).toBe(0);

    let limitReads = 0;
    const accessorCommand = {
      context: tenantA.scope,
      normalizedQuery: "",
      get limit() {
        limitReads += 1;
        return limitReads === 1 ? 10 : 1_000;
      },
    };
    await expect(catalog.search(accessorCommand)).rejects.toThrow("无访问器");
    expect(limitReads).toBe(0);

    const secret = "不应泄漏的 getter 内容";
    const proxyContext = new Proxy(tenantA.scope, {
      get() {
        throw new Error(secret);
      },
    });
    let proxyMessage = "";
    try {
      await catalog.search({ context: proxyContext, normalizedQuery: "", limit: 10 });
    } catch (error) {
      proxyMessage = error instanceof Error ? error.message : String(error);
    }
    expect(proxyMessage).toContain("无访问器");
    expect(proxyMessage).not.toContain(secret);

    await expect(
      catalog.search({
        context: { ...tenantA.scope, extra: "禁止" } as TrustedResourceContext,
        normalizedQuery: "",
        limit: 10,
      }),
    ).rejects.toThrow("无访问器");

    const promotion = await seedPromotion(tenantA, "input-snapshot");
    const input = command(tenantA, promotion, {
      key: `idem-input-snapshot-${unique}`,
      resource: `resource_input_snapshot_${unique}`,
      version: `resource_version_input_snapshot_${unique}`,
    });
    await expect(
      promotions.commitPromotedVersion({
        ...input,
        capability: { kind: "promote_resource_capability" },
      }),
    ).rejects.toThrow("无访问器");

    let actorReads = 0;
    const maliciousVerifier = {
      verify() {
        const restored = Object.create(null) as Record<string, unknown>;
        Object.defineProperties(restored, {
          tenantId: { enumerable: true, value: tenantA.scope.tenantId },
          userId: { enumerable: true, value: tenantA.scope.userId },
          actor: {
            enumerable: true,
            get() {
              actorReads += 1;
              throw new Error(secret);
            },
          },
        });
        return restored as unknown as AuthorizedAgentResourceContext;
      },
    };
    const guardedRepository = new PgResourcePromotionRepository(runtime, maliciousVerifier);
    let verifierMessage = "";
    try {
      await guardedRepository.commitPromotedVersion(input);
    } catch (error) {
      verifierMessage = error instanceof Error ? error.message : String(error);
    }
    expect(actorReads).toBe(0);
    expect(verifierMessage).toContain("无访问器");
    expect(verifierMessage).not.toContain(secret);

    const throwingRepository = new PgResourcePromotionRepository(runtime, {
      verify() {
        throw new Error(secret);
      },
    });
    let throwingVerifierMessage = "";
    try {
      await throwingRepository.commitPromotedVersion(input);
    } catch (error) {
      throwingVerifierMessage = error instanceof Error ? error.message : String(error);
    }
    expect(throwingVerifierMessage).toContain("能力验证失败");
    expect(throwingVerifierMessage).not.toContain(secret);

    let verifierReads = 0;
    const accessorVerifier = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorVerifier, "verify", {
      enumerable: true,
      get() {
        verifierReads += 1;
        throw new Error(secret);
      },
    });
    expect(
      () =>
        new PgResourcePromotionRepository(
          runtime,
          accessorVerifier as unknown as typeof promotionCapabilities.verifier,
        ),
    ).toThrow("无访问器");
    expect(verifierReads).toBe(0);
  });

  it("原子提交显式提升、精确重放，并隐藏 pending 记录", async () => {
    const promotion = await seedPromotion(tenantA, "first");
    const input = command(tenantA, promotion, {
      key: `idem-first-${unique}`,
      resource: `resource_first_${unique}`,
      version: `resource_version_first_${unique}`,
      name: "项目说明.txt",
    });
    const first = await promotions.commitPromotedVersion(input);
    expect(first.outcome).toBe("committed");
    const replay = await promotions.commitPromotedVersion(input);
    expect(replay.outcome).toBe("replayed");
    expect(replay).toMatchObject({
      resource: { id: input.resourceId, latestVersionNumber: 1 },
      version: { id: input.resourceVersionId, digest: promotion.digest },
    });
    expect(
      await promotions.commitPromotedVersion({
        ...input,
        resourceVersionId: resourceVersionId(`resource_version_conflict_${unique}`),
      }),
    ).toEqual({ outcome: "key_conflict" });

    await withTenantTransaction(runtime, tenantA.scope, (client) =>
      client.query(
        `INSERT INTO resources(
           tenant_id, id, name, normalized_name, origin, visibility,
           latest_version_number, created_at, updated_at
         ) VALUES ($1,$2,'scratch.tmp','scratch.tmp','promoted_workspace',
                   'pending_explicit_commit',0,clock_timestamp(),clock_timestamp())`,
        [tenantA.scope.tenantId, `resource_pending_${unique}`],
      ),
    );
    const page = await catalog.search({
      context: tenantA.scope,
      normalizedQuery: normalizeSearchQuery("项目"),
      limit: 20,
    });
    expect(page.items.map((item) => item.resourceId)).toContain(input.resourceId);
    expect(
      (
        await catalog.search({
          context: tenantA.scope,
          normalizedQuery: normalizeSearchQuery("说明"),
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await catalog.search({
          context: tenantA.scope,
          normalizedQuery: "%",
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    const pending = await catalog.search({
      context: tenantA.scope,
      normalizedQuery: normalizeSearchQuery("scratch.tmp"),
      limit: 20,
    });
    expect(pending.items).toEqual([]);
  });

  it("双租户目录、resolve 与直接 Runtime SQL 都 fail closed", async () => {
    const promotion = await seedPromotion(tenantB, "tenant-b");
    const input = command(tenantB, promotion, {
      key: `idem-b-${unique}`,
      resource: `resource_b_${unique}`,
      version: `resource_version_b_${unique}`,
      name: "租户 B 文档.txt",
    });
    expect((await promotions.commitPromotedVersion(input)).outcome).toBe("committed");
    const own = await catalog.search({ context: tenantB.scope, normalizedQuery: "", limit: 50 });
    expect(own.items.map((item) => item.resourceId)).toContain(input.resourceId);
    expect(own.items.some((item) => String(item.resourceId).includes("resource_first"))).toBe(
      false,
    );
    const guessed = await catalog.resolveVersion({
      context: tenantB.scope,
      resourceId: resourceId(`resource_first_${unique}`),
      versionId: resourceVersionId(`resource_version_first_${unique}`),
    });
    expect(guessed).toEqual({ status: "not_found" });

    const direct = await withTenantTransaction(runtime, tenantB.scope, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM resources WHERE tenant_id = $1",
        [tenantA.scope.tenantId],
      ),
    );
    expect(direct.rows[0]?.count).toBe("0");
    await expect(
      withTenantTransaction(runtime, tenantB.scope, (client) =>
        client.query(
          `INSERT INTO resources(
             tenant_id,id,name,normalized_name,origin,visibility,latest_version_number
           ) VALUES ($1,$2,'越权','越权','upload','pending_explicit_commit',0)`,
          [tenantA.scope.tenantId, `resource_cross_${unique}`],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("稳定 updatedAt+id 分页不重复且不自动读取内容", async () => {
    for (const label of ["page-a", "page-b", "page-c"]) {
      const promotion = await seedPromotion(tenantA, label);
      const input = command(tenantA, promotion, {
        key: `idem-${label}-${unique}`,
        resource: `resource_${label.replace("-", "_")}_${unique}`,
        version: `resource_version_${label.replace("-", "_")}_${unique}`,
        name: `分页 ${label}.txt`,
      });
      expect((await promotions.commitPromotedVersion(input)).outcome).toBe("committed");
    }
    const first = await catalog.search({
      context: tenantA.scope,
      normalizedQuery: normalizeSearchQuery("分页"),
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextPosition).toBeDefined();
    const after = first.nextPosition;
    if (after === undefined) throw new Error("Resource 分页缺少下一位置");
    const second = await catalog.search({
      context: tenantA.scope,
      normalizedQuery: normalizeSearchQuery("分页"),
      limit: 2,
      after,
    });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.resourceId)).size).toBe(3);
  });

  it("并发 latest CAS 只有一个版本提交成功", async () => {
    const initialPromotion = await seedPromotion(tenantA, "cas-initial");
    const resource = `resource_cas_${unique}`;
    const firstInput = command(tenantA, initialPromotion, {
      key: `idem-cas-initial-${unique}`,
      resource,
      version: `resource_version_cas_1_${unique}`,
      name: "并发版本.txt",
    });
    expect((await promotions.commitPromotedVersion(firstInput)).outcome).toBe("committed");
    const [leftPromotion, rightPromotion] = await Promise.all([
      seedPromotion(tenantA, "cas-left"),
      seedPromotion(tenantA, "cas-right"),
    ]);
    const results = await Promise.all([
      promotions.commitPromotedVersion(
        command(tenantA, leftPromotion, {
          key: `idem-cas-left-${unique}`,
          resource,
          version: `resource_version_cas_left_${unique}`,
          expected: 1,
          name: "并发版本.txt",
        }),
      ),
      promotions.commitPromotedVersion(
        command(tenantA, rightPromotion, {
          key: `idem-cas-right-${unique}`,
          resource,
          version: `resource_version_cas_right_${unique}`,
          expected: 1,
          name: "并发版本.txt",
        }),
      ),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "committed",
      "version_conflict",
    ]);
  });

  it("等待最后业务锁跨过 TTL 后按新数据库时钟拒绝并保持授权未消费", async () => {
    const initialPromotion = await seedPromotion(tenantA, "fresh-clock-initial");
    const resource = `resource_fresh_clock_${unique}`;
    const initial = command(tenantA, initialPromotion, {
      key: `idem-fresh-clock-initial-${unique}`,
      resource,
      version: `resource_version_fresh_clock_1_${unique}`,
      name: "锁后时钟.txt",
    });
    expect((await promotions.commitPromotedVersion(initial)).outcome).toBe("committed");

    const nextPromotion = await seedPromotion(tenantA, "fresh-clock-next");
    await withTenantTransaction(migrator, tenantA.scope, (client) =>
      client.query(
        `UPDATE resource_promotion_authorizations
            SET expires_at=clock_timestamp() + interval '300 milliseconds'
          WHERE tenant_id=$1 AND authorization_id=$2`,
        [tenantA.scope.tenantId, nextPromotion.authorizationId],
      ),
    );
    const next = command(tenantA, nextPromotion, {
      key: `idem-fresh-clock-next-${unique}`,
      resource,
      version: `resource_version_fresh_clock_2_${unique}`,
      expected: 1,
      name: "锁后时钟.txt",
    });

    const blocker = await migrator.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)",
        [tenantA.scope.tenantId, tenantA.scope.userId],
      );
      await blocker.query("SELECT id FROM resources WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        tenantA.scope.tenantId,
        resource,
      ]);
      const pending = promotions.commitPromotedVersion(next);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ outcome: "not_authorized" });
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }

    const facts = await withTenantTransaction(runtime, tenantA.scope, (client) =>
      client.query<{ auth_state: string; version_count: string }>(
        `SELECT
           (SELECT state FROM resource_promotion_authorizations
             WHERE tenant_id=$1 AND authorization_id=$2) AS auth_state,
           (SELECT count(*)::text FROM resource_versions
             WHERE tenant_id=$1 AND id=$3) AS version_count`,
        [tenantA.scope.tenantId, nextPromotion.authorizationId, next.resourceVersionId],
      ),
    );
    expect(facts.rows[0]).toEqual({ auth_state: "active", version_count: "0" });
  });

  it("Resource 提升与 Blob 标记/GC 并发遵循无环锁序并保留可达引用", async () => {
    const initialPromotion = await seedPromotion(tenantA, "blob-lock-initial");
    const resource = `resource_blob_lock_${unique}`;
    expect(
      (
        await promotions.commitPromotedVersion(
          command(tenantA, initialPromotion, {
            key: `idem-blob-lock-initial-${unique}`,
            resource,
            version: `resource_version_blob_lock_1_${unique}`,
            name: "Blob 锁序.txt",
          }),
        )
      ).outcome,
    ).toBe("committed");

    const nextPromotion = await seedPromotion(tenantA, "blob-lock-next");
    if (
      nextPromotion.incarnationId === undefined ||
      nextPromotion.physicalObjectKey === undefined ||
      nextPromotion.size === undefined ||
      nextPromotion.operationId === undefined
    ) {
      throw new Error("Blob 并发夹具不完整");
    }
    const next = command(tenantA, nextPromotion, {
      key: `idem-blob-lock-next-${unique}`,
      resource,
      version: `resource_version_blob_lock_2_${unique}`,
      expected: 1,
      name: "Blob 锁序.txt",
    });
    const blob = Object.freeze({
      kind: "stable" as const,
      tenantId: tenantA.scope.tenantId,
      purpose: "resource" as const,
      sha256: nextPromotion.digest,
      size: nextPromotion.size,
      mediaType: "text/plain",
      incarnationId: nextPromotion.incarnationId,
      physicalObjectKey: nextPromotion.physicalObjectKey,
    });
    const lifecycle = new PgBlobLifecycleRepository(runtime);

    const blocker = await migrator.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)",
        [tenantA.scope.tenantId, tenantA.scope.userId],
      );
      await blocker.query("SELECT id FROM resources WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        tenantA.scope.tenantId,
        resource,
      ]);
      const committing = promotions.commitPromotedVersion(next);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const marking = lifecycle.markReferenceStable({
        scope: tenantA.scope,
        operationId: nextPromotion.operationId,
        referenceId: nextPromotion.blobReferenceId,
        stable: blob,
      });
      const collecting = lifecycle.claimUnreachable({ scope: tenantA.scope, blob });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query("COMMIT");
      const [commitResult, markResult, gcResult] = await Promise.all([
        committing,
        marking,
        collecting,
      ]);
      expect(commitResult.outcome).toBe("committed");
      expect(markResult).toBe("marked");
      expect(gcResult).toEqual({ status: "still_referenced" });
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
  });

  it("重验 active Membership、Agent 执行身份与数据库时钟 Writer Lease", async () => {
    await withTenantTransaction(migrator, tenantB.scope, (client) =>
      client.query("UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2", [
        tenantB.scope.tenantId,
        tenantB.scope.userId,
      ]),
    );
    expect(
      (
        await catalog.search({
          context: tenantB.scope,
          normalizedQuery: "",
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    await withTenantTransaction(migrator, tenantB.scope, (client) =>
      client.query("UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2", [
        tenantB.scope.tenantId,
        tenantB.scope.userId,
      ]),
    );

    const promotion = await seedPromotion(tenantA, "authorization-boundary");
    const input = command(tenantA, promotion, {
      key: `idem-authorization-boundary-${unique}`,
      resource: `resource_authorization_boundary_${unique}`,
      version: `resource_version_authorization_boundary_${unique}`,
      name: "授权边界.txt",
    });
    const wrongAgent = {
      ...input,
      capability: promotionCapabilities.issuer.issue(
        authorizedContext(tenantA.scope, `wrong_agent_${unique}`, tenantA.threadId, tenantA.runId),
      ),
    };
    expect(await promotions.commitPromotedVersion(wrongAgent)).toEqual({
      outcome: "not_authorized",
    });

    await withTenantTransaction(runtime, tenantA.scope, (client) =>
      client.query(
        `UPDATE workspace_write_leases
            SET expires_at=clock_timestamp() - interval '1 second'
          WHERE tenant_id=$1 AND workspace_id=$2`,
        [tenantA.scope.tenantId, tenantA.workspaceId],
      ),
    );
    expect(await promotions.commitPromotedVersion(input)).toEqual({ outcome: "not_authorized" });
    await withTenantTransaction(runtime, tenantA.scope, (client) =>
      client.query(
        `UPDATE workspace_write_leases
            SET expires_at=clock_timestamp() + interval '1 hour'
          WHERE tenant_id=$1 AND workspace_id=$2`,
        [tenantA.scope.tenantId, tenantA.workspaceId],
      ),
    );
  });

  it("约束失败整体回滚，COMMIT unknown 依精确键读回", async () => {
    const shared = await seedPromotion(tenantA, "rollback-shared");
    const original = command(tenantA, shared, {
      key: `idem-shared-${unique}`,
      resource: `resource_shared_${unique}`,
      version: `resource_version_shared_${unique}`,
      name: "共享引用.txt",
    });
    expect((await promotions.commitPromotedVersion(original)).outcome).toBe("committed");
    const secondAuth = await seedAuthorizationOnly(tenantA, "rollback-auth", shared.digest);
    const invalidResource = resourceId(`resource_rollback_${unique}`);
    await expect(
      promotions.commitPromotedVersion({
        ...command(tenantA, secondAuth, {
          key: `idem-rollback-${unique}`,
          resource: invalidResource,
          version: `resource_version_rollback_${unique}`,
          name: "应回滚.txt",
        }),
        blobReferenceId: shared.blobReferenceId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const rolledBack = await withTenantTransaction(runtime, tenantA.scope, (client) =>
      client.query<{ resource_count: string; auth_state: string }>(
        `SELECT
           (SELECT count(*)::text FROM resources WHERE tenant_id=$1 AND id=$2) AS resource_count,
           (SELECT state FROM resource_promotion_authorizations
             WHERE tenant_id=$1 AND authorization_id=$3) AS auth_state`,
        [tenantA.scope.tenantId, invalidResource, secondAuth.authorizationId],
      ),
    );
    expect(rolledBack.rows[0]).toEqual({ resource_count: "0", auth_state: "active" });

    const unknownPromotion = await seedPromotion(tenantA, "unknown");
    const unknownInput = command(tenantA, unknownPromotion, {
      key: `idem-unknown-${unique}`,
      resource: `resource_unknown_${unique}`,
      version: `resource_version_unknown_${unique}`,
      name: "未知提交.txt",
    });
    const recovered =
      await repositoryWithOneLostCommitResponse().commitPromotedVersion(unknownInput);
    expect(recovered.outcome).toBe("replayed");
    const count = await withTenantTransaction(runtime, tenantA.scope, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM resource_versions WHERE tenant_id=$1 AND id=$2",
        [tenantA.scope.tenantId, unknownInput.resourceVersionId],
      ),
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("FORCE RLS 与 Runtime 最小 ACL 保护不可变版本和授权身份", async () => {
    const rls = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace=current_schema()::regnamespace
          AND relname = ANY($1::text[]) ORDER BY relname`,
      [
        [
          "resources",
          "resource_versions",
          "resource_promotion_authorizations",
          "resource_promotion_idempotency",
        ],
      ],
    );
    expect(rls.rows).toHaveLength(4);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const acl = await migrator.query<{
      resource_update: boolean;
      head_update: boolean;
      name_update: boolean;
      version_update: boolean;
      version_delete: boolean;
      auth_state_update: boolean;
      auth_identity_update: boolean;
      idem_update: boolean;
      idem_delete: boolean;
    }>(
      `SELECT
         has_table_privilege($1, 'resources', 'UPDATE') AS resource_update,
         has_column_privilege($1, 'resources', 'latest_version_id', 'UPDATE') AS head_update,
         has_column_privilege($1, 'resources', 'name', 'UPDATE') AS name_update,
         has_table_privilege($1, 'resource_versions', 'UPDATE') AS version_update,
         has_table_privilege($1, 'resource_versions', 'DELETE') AS version_delete,
         has_column_privilege($1, 'resource_promotion_authorizations', 'state', 'UPDATE') AS auth_state_update,
         has_column_privilege($1, 'resource_promotion_authorizations', 'run_id', 'UPDATE') AS auth_identity_update,
         has_table_privilege($1, 'resource_promotion_idempotency', 'UPDATE') AS idem_update,
         has_table_privilege($1, 'resource_promotion_idempotency', 'DELETE') AS idem_delete`,
      [runtimeRole],
    );
    expect(acl.rows[0]).toEqual({
      resource_update: false,
      head_update: true,
      name_update: false,
      version_update: false,
      version_delete: false,
      auth_state_update: true,
      auth_identity_update: false,
      idem_update: false,
      idem_delete: false,
    });
    await expect(
      withTenantTransaction(runtime, tenantA.scope, (client) =>
        client.query("UPDATE resource_versions SET media_type='x/y' WHERE tenant_id=$1", [
          tenantA.scope.tenantId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
