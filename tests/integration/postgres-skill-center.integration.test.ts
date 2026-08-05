import { randomBytes } from "node:crypto";
import { tenantId, userId } from "@cube-runtime/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgSkillCenterRepository } from "../../runtime-ts/packages/persistence/src/pg-skill-center.js";
import { PgSkillFilesystemCatalog } from "../../runtime-ts/packages/persistence/src/pg-skill-filesystem.js";
import {
  createRunSkillSnapshot,
  readRunSkillSnapshot,
} from "../../runtime-ts/packages/persistence/src/pg-skill-runtime.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
  withTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { loadPostgreSqlMigrationContract } from "./postgres-migration-contract.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Skill Center PostgreSQL 集成测试缺少 ${name}；不会输出配置值`);
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
const schema = `it_skill_${unique}`;
const migratorRole = `it_sk_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherRole = `it_sk_pub_${unique}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;

const scopeA = {
  tenantId: tenantId(`skill_tenant_a_${unique}`),
  userId: userId(`skill_user_a_${unique}`),
};
const scopeB = {
  tenantId: tenantId(`skill_tenant_b_${unique}`),
  userId: userId(`skill_user_b_${unique}`),
};

let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repository!: PgSkillCenterRepository;
let filesystem!: PgSkillFilesystemCatalog;
let schemaCreated = false;
let migratorCreated = false;

async function seedPrincipal(scope: typeof scopeA): Promise<void> {
  await withTenantTransaction(runtime, scope, async (client) => {
    await client.query("INSERT INTO app_users(id,created_at) VALUES ($1,clock_timestamp())", [
      scope.userId,
    ]);
    await client.query(
      "INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES ($1,'personal',$2,clock_timestamp())",
      [scope.tenantId, scope.userId],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES ($1,$2,$3,'owner','active',clock_timestamp())`,
      [scope.tenantId, `membership_${scope.userId}`, scope.userId],
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
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}", "${skillPublisherRole}";
     CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
  );
  migratorCreated = true;
  schemaCreated = true;
  migrator = createPostgresPool({
    connectionString: testMigrationUrl.toString(),
    schema,
    maxConnections: 4,
  });
  runtime = createPostgresPool({ connectionString: runtimeDatabaseUrl, schema, maxConnections: 8 });
  const contract = await loadPostgreSqlMigrationContract();
  expect(
    (await migrateUp(migrator, { runtimeRole, migratorRole, skillPublisherRole, schema })).map(
      (record) => record.version,
    ),
  ).toEqual(contract.versions);
  await Promise.all([seedPrincipal(scopeA), seedPrincipal(scopeB)]);

  await withTransaction(migrator, async (client) => {
    for (const [id, canonicalKey, displayName] of [
      ["skill_review", "code-review", "代码审阅"],
      ["skill_deploy", "deploy", "部署准备"],
    ] as const) {
      await client.query(
        `INSERT INTO skills(
           id,canonical_key,publisher,display_name,recommended_version,status
         ) VALUES ($1,$2,'Cube',$3,'1.0.0','active')`,
        [id, canonicalKey, displayName],
      );
      await client.query(
        `INSERT INTO skill_versions(
           skill_id,version,description,compatibility,package_digest,
           entrypoint_path,entrypoint_digest,package_blob_ref,security_status,status
         ) VALUES ($1,'1.0.0',$2,'runtime >= 1',$3,'SKILL.md',$4,$5,'verified','available')`,
        [id, `${displayName}工作流`, "a".repeat(64), "b".repeat(64), `skills/${id}/1.0.0/package`],
      );
      await client.query(
        `INSERT INTO skill_version_files(
           skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref
         ) VALUES ($1,'1.0.0','SKILL.md','text/markdown',20,$2,$3)`,
        [id, "b".repeat(64), `skills/${id}/1.0.0/SKILL.md`],
      );
    }
    await client.query(
      `INSERT INTO skill_versions(
         skill_id,version,description,compatibility,package_digest,
         entrypoint_path,entrypoint_digest,package_blob_ref,security_status,status
       ) VALUES ('skill_review','0.9.0','旧版代码审阅工作流','runtime >= 1',$1,
                 'SKILL.md',$2,$3,'verified','available')`,
      ["d".repeat(64), "e".repeat(64), "skills/skill_review/0.9.0/package"],
    );
    await client.query(
      `INSERT INTO skill_version_files(
         skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref
       ) VALUES ('skill_review','0.9.0','SKILL.md','text/markdown',18,$1,$2)`,
      ["e".repeat(64), "skills/skill_review/0.9.0/SKILL.md"],
    );
  });
  repository = new PgSkillCenterRepository(runtime);
  filesystem = new PgSkillFilesystemCatalog(runtime);
});

afterAll(async () => {
  if (runtime !== undefined) await runtime.end();
  if (migrator !== undefined) await migrator.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await admin.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}", "${skillPublisherRole}";
       DROP ROLE "${skillPublisherRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (admin !== undefined) await admin.end();
});

describe("Skill Center PostgreSQL 安装与用户 RLS", () => {
  it("所有 Tenant 无需安装即可浏览公开市场，并可解析仍然可用的精确旧版本", async () => {
    const rootA = await filesystem.listDirectory({ tenantId: scopeA.tenantId, segments: [] });
    const rootB = await filesystem.listDirectory({ tenantId: scopeB.tenantId, segments: [] });
    expect(rootA).toEqual(rootB);
    expect(rootA).toEqual([
      { kind: "directory", name: "code-review" },
      { kind: "directory", name: "deploy" },
    ]);

    const versions = await filesystem.listDirectory({
      tenantId: scopeA.tenantId,
      segments: ["code-review"],
    });
    expect(versions?.map((entry) => entry.name)).toEqual(["_metadata.json", "0.9.0", "1.0.0"]);
    expect(
      await filesystem.resolveFile({
        tenantId: scopeA.tenantId,
        segments: ["code-review", "0.9.0", "SKILL.md"],
      }),
    ).toMatchObject({
      mediaType: "text/markdown",
      source: { kind: "blob", blobRef: "skills/skill_review/0.9.0/SKILL.md" },
    });

    const metadata = await filesystem.resolveFile({
      tenantId: scopeB.tenantId,
      segments: ["code-review", "_metadata.json"],
    });
    if (metadata?.source.kind !== "inline") throw new Error("Skill 市场元数据缺失");
    expect(JSON.parse(new TextDecoder().decode(metadata.source.body))).toMatchObject({
      canonicalKey: "code-review",
      recommendedVersion: "1.0.0",
      availableVersions: ["0.9.0", "1.0.0"],
    });
  });

  it("受信发布者可导入目录，而 Runtime 只能在认证用户上下文读取", async () => {
    const page = await repository.listCatalog({
      context: scopeA,
      normalizedQuery: "",
      limit: 10,
    });
    expect(page.items.map((item) => item.canonicalKey)).toEqual(["code-review", "deploy"]);
    expect((await runtime.query("SELECT canonical_key FROM skills")).rows).toEqual([]);
    await expect(
      withTenantTransaction(runtime, scopeA, (client) =>
        client.query(
          `INSERT INTO skills(id,canonical_key,publisher,display_name,recommended_version,status)
           VALUES ('skill_forged','forged','x','x',NULL,'revoked')`,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("安装按用户隔离，同键回放且配置与卸载使用 CAS", async () => {
    const installInput = {
      context: scopeA,
      canonicalKey: "code-review",
      versionSelector: "recommended" as const,
      invocationName: "review",
      idempotencyKey: "skill-install-it-0001",
      requestDigest: "c".repeat(64),
    };
    const installed = await repository.install(installInput);
    expect(installed).toMatchObject({
      outcome: "installed",
      installation: { invocationName: "review", skillVersion: "1.0.0", versionToken: 0 },
    });
    expect(await repository.install(installInput)).toMatchObject({ outcome: "replayed" });
    expect(
      await repository.install({
        ...installInput,
        invocationName: "other",
        requestDigest: "d".repeat(64),
      }),
    ).toEqual({ outcome: "key_conflict" });
    expect(await repository.listInstallations({ context: scopeB })).toEqual([]);

    const configured = await repository.configure({
      context: scopeA,
      canonicalKey: "code-review",
      expectedVersionToken: 0,
      enabled: false,
      idempotencyKey: "skill-configure-it-0001",
      requestDigest: "e".repeat(64),
    });
    expect(configured).toMatchObject({
      outcome: "updated",
      installation: { status: "disabled", versionToken: 1 },
    });
    expect(
      await repository.uninstall({
        context: scopeA,
        canonicalKey: "code-review",
        expectedVersionToken: 0,
        idempotencyKey: "skill-uninstall-it-old",
        requestDigest: "f".repeat(64),
      }),
    ).toEqual({ outcome: "version_conflict" });
    expect(
      await repository.uninstall({
        context: scopeA,
        canonicalKey: "code-review",
        expectedVersionToken: 1,
        idempotencyKey: "skill-uninstall-it-0001",
        requestDigest: "0".repeat(64),
      }),
    ).toEqual({ outcome: "uninstalled" });
    expect(await repository.listInstallations({ context: scopeA })).toEqual([]);
  });

  it("调用名称唯一性只约束同一用户的有效安装", async () => {
    const first = await repository.install({
      context: scopeB,
      canonicalKey: "code-review",
      versionSelector: "1.0.0",
      invocationName: "shared-name",
      idempotencyKey: "skill-install-b-0001",
      requestDigest: "1".repeat(64),
    });
    expect(first.outcome).toBe("installed");
    expect(
      await repository.install({
        context: scopeB,
        canonicalKey: "deploy",
        versionSelector: "1.0.0",
        invocationName: "shared-name",
        idempotencyKey: "skill-install-b-0002",
        requestDigest: "2".repeat(64),
      }),
    ).toEqual({ outcome: "name_conflict" });
  });

  it("Run 快照固定用户当时的安装版本，之后停用不会改变目录或显式调用", async () => {
    const candidateRunId = `skill-run-${unique}`;
    await withTenantTransaction(runtime, scopeB, (client) =>
      createRunSkillSnapshot(client, {
        tenantId: scopeB.tenantId,
        runId: candidateRunId,
        userId: scopeB.userId,
        explicitInvocation: { invocationName: "shared-name", args: "检查修改" },
      }),
    );
    const before = await withTenantTransaction(runtime, scopeB, (client) =>
      readRunSkillSnapshot(client, scopeB.tenantId, candidateRunId),
    );
    expect(before).toMatchObject({
      items: [{ invocationName: "shared-name", skillVersion: "1.0.0" }],
      explicitInvocation: { invocationName: "shared-name", args: "检查修改" },
    });

    expect(
      await repository.configure({
        context: scopeB,
        canonicalKey: "code-review",
        expectedVersionToken: 0,
        enabled: false,
        idempotencyKey: "skill-configure-b-0001",
        requestDigest: "3".repeat(64),
      }),
    ).toMatchObject({ outcome: "updated" });
    const after = await withTenantTransaction(runtime, scopeB, (client) =>
      readRunSkillSnapshot(client, scopeB.tenantId, candidateRunId),
    );
    expect(after).toEqual(before);
  });
});
