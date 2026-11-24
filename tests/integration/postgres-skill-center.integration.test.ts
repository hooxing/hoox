import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tenantId, userId } from "@hoox/domain";
import { SkillPublicationService } from "../../runtime-ts/packages/skill/src/publishing-service.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishDevelopmentCsvPdfSkill } from "../../runtime-ts/packages/persistence/src/development-csv-pdf-publisher.js";
import { loadMigrations, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgSkillCenterRepository } from "../../runtime-ts/packages/persistence/src/pg-skill-center.js";
import { PgSkillFilesystemCatalog } from "../../runtime-ts/packages/persistence/src/pg-skill-filesystem.js";
import {
  PgSkillPublicationAuthorization,
  PgSkillPublicationRepository,
} from "../../runtime-ts/packages/persistence/src/pg-skill-publication.js";
import { S3StableSkillPublisher } from "../../runtime-ts/packages/persistence/src/skill-publication-object-store.js";
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
const workerCoordinatorRole = `it_sk_coord_${unique}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const adminControlRole = workerCoordinatorRole.replace("_coord_", "_control_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const adminControlPassword = randomBytes(24).toString("hex");
const csvPdfSourceRoot = fileURLToPath(
  new URL("../../runtime-ts/managed-skills/csv-to-pdf/", import.meta.url),
);
const csvPdfObjectStorage = {
  endpoint: requiredEnvironment("SKILL_PUBLISHER_S3_ENDPOINT"),
  bucket: requiredEnvironment("SKILL_PUBLISHER_S3_BUCKET"),
  region: requiredEnvironment("SKILL_PUBLISHER_S3_REGION"),
  accessKeyId: requiredEnvironment("SKILL_PUBLISHER_S3_ACCESS_KEY_ID"),
  secretAccessKey: requiredEnvironment("SKILL_PUBLISHER_S3_SECRET_ACCESS_KEY"),
  forcePathStyle: requiredEnvironment("SKILL_PUBLISHER_S3_FORCE_PATH_STYLE") === "true",
} as const;
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
const teamScope = {
  tenantId: tenantId(`skill_team_${unique}`),
  userId: scopeA.userId,
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

async function seedTeam(scope: typeof teamScope): Promise<void> {
  await withTenantTransaction(runtime, scope, async (client) => {
    await client.query(
      "INSERT INTO tenants(id,kind,display_name,created_by_user_id,created_at) VALUES ($1,'team','Skill 集成测试团队',$2,clock_timestamp())",
      [scope.tenantId, scope.userId],
    );
    await client.query(
      `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES ($1,$2,$3,'owner','active',clock_timestamp())`,
      [scope.tenantId, `membership_${scope.tenantId}`, scope.userId],
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
  runtime = createPostgresPool({ connectionString: runtimeDatabaseUrl, schema, maxConnections: 8 });
  const contract = await loadPostgreSqlMigrationContract();
  expect(
    (
      await migrateUp(migrator, {
        runtimeRole,
        migratorRole,
        skillPublisherRole,
        workerCoordinatorRole,
        teamCoordinatorRole,
        adminControlRole,
        schema,
      })
    ).map((record) => record.version),
  ).toEqual(contract.versions);
  await Promise.all([seedPrincipal(scopeA), seedPrincipal(scopeB)]);
  await seedTeam(teamScope);

  await publishDevelopmentCsvPdfSkill({
    sourceRoot: csvPdfSourceRoot,
    pool: migrator,
    objectStorage: csvPdfObjectStorage,
  });

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

describe("Skill Center PostgreSQL 安装与用户 RLS", () => {
  it("Skill 命名空间发布者只能发布授权目录，撤销立即生效并保留审计", async () => {
    await admin.query(
      `INSERT INTO "${schema}".platform_skill_operators(user_id,role,status) VALUES
        ($1,'admin','active')
       ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status`,
      [scopeA.userId],
    );
    const publisherUrl = new URL(runtimeDatabaseUrl);
    publisherUrl.username = skillPublisherRole;
    publisherUrl.password = skillPublisherPassword;
    const publisherPool = createPostgresPool({
      connectionString: publisherUrl.toString(),
      schema,
      maxConnections: 2,
    });
    const objects = new S3StableSkillPublisher(csvPdfObjectStorage);
    const authorization = new PgSkillPublicationAuthorization(publisherPool);
    const repository = new PgSkillPublicationRepository(publisherPool, objects);
    const adminPublications = new SkillPublicationService(authorization, repository);
    const publisherPublications = new SkillPublicationService(authorization, repository);
    const namespace = `wp-${unique.replaceAll("_", "-")}`;
    try {
      await adminPublications.createNamespace(scopeA.userId, namespace);
      await adminPublications.grantNamespace(scopeA.userId, namespace, scopeB.userId);
      await adminPublications.grantNamespace(scopeA.userId, namespace, scopeB.userId);
      await expect(publisherPublications.publicationAccess(scopeB.userId)).resolves.toEqual({
        role: "publisher",
        namespaces: [namespace],
      });

      const create = {
        userId: scopeB.userId,
        submissionId: `namespace_${unique}`,
        metadata: {
          canonicalKey: `${namespace}.automation-helper`,
          displayName: "命名空间测试技能",
          publisher: "Hoox",
          description: "验证命名空间发布权限",
          compatibility: "Agent Skills 标准格式",
          sourceUrl: "",
          sourceRevision: "",
          licenseSpdx: "MIT",
        },
        files: [
          {
            path: "SKILL.md",
            mediaType: "text/markdown",
            contentBase64: Buffer.from("# Namespace\n").toString("base64"),
          },
        ],
        idempotencyKey: `namespace-create-${unique}`,
      } as const;
      const submission = await publisherPublications.create(create);
      await expect(
        publisherPublications.create({
          ...create,
          submissionId: `namespace_other_${unique}`,
          metadata: { ...create.metadata, canonicalKey: `${namespace}-other.automation-helper` },
          idempotencyKey: `namespace-cross-${unique}`,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        (await publisherPublications.list({ userId: scopeB.userId })).items.map(
          (item) => item.submissionId,
        ),
      ).toEqual([submission.submissionId]);

      await publisherPublications.publish({
        userId: scopeB.userId,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        recommended: true,
        idempotencyKey: `namespace-publish-${unique}`,
      });
      const rlsVisible = await withTransaction(
        publisherPool,
        async (client) => {
          await client.query("SELECT set_config('app.user_id',$1,true)", [scopeB.userId]);
          const submissions = await client.query<{ canonical_key: string }>(
            "SELECT canonical_key FROM skill_publication_submissions ORDER BY canonical_key",
          );
          const catalog = await client.query<{ canonical_key: string }>(
            "SELECT canonical_key FROM skills ORDER BY canonical_key",
          );
          return { submissions: submissions.rows, catalog: catalog.rows };
        },
        { readOnly: true },
      );
      expect(rlsVisible.submissions).toEqual([{ canonical_key: `${namespace}.automation-helper` }]);
      expect(rlsVisible.catalog).toEqual([{ canonical_key: `${namespace}.automation-helper` }]);
      await publisherPublications.revoke({
        userId: scopeB.userId,
        submissionId: submission.submissionId,
        expectedVersionToken: 1,
        idempotencyKey: `namespace-revoke-${unique}`,
      });
      const audit = await admin.query(
        `SELECT operation,namespace,skill_version FROM "${schema}".skill_publication_audits
          WHERE submission_id=$1 ORDER BY version_token`,
        [submission.submissionId],
      );
      expect(audit.rows.map((row) => row.operation)).toEqual(["create", "publish", "revoke"]);
      expect(
        audit.rows.every(
          (row) => row.namespace === namespace && row.skill_version === submission.version,
        ),
      ).toBe(true);
      await adminPublications.revokeNamespace(scopeA.userId, namespace, scopeB.userId);
      await expect(
        publisherPublications.get(scopeB.userId, submission.submissionId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(publisherPublications.create(create)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        publisherPublications.createNamespace(scopeB.userId, `${namespace}-blocked`),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const namespaceAudits = await admin.query(
        `SELECT operation,subject_user_id FROM "${schema}".skill_namespace_audits WHERE namespace=$1 ORDER BY created_at`,
        [namespace],
      );
      expect(namespaceAudits.rows.map((row) => row.operation)).toEqual([
        "create",
        "grant",
        "revoke",
      ]);

      const migrations = await loadMigrations();
      const migration = migrations.find((item) => item.name === "skill_namespaces");
      expect(migration).toBeDefined();
      const client = await migrator.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration?.downSql ?? "");
        await client.query(migration?.upSql ?? "");
        const restored = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
          `${schema}.skill_namespaces`,
        ]);
        expect(restored.rows[0]?.present).toBe(true);
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } finally {
      objects.close();
      await publisherPool.end();
    }
  });

  it("固定 CSV 转 PDF publisher 将旧品牌目录迁移到 Hoox，并保持新版本幂等", async () => {
    await migrator.query("UPDATE skills SET publisher='AISay' WHERE id='skill_cube_csv_to_pdf'");

    const first = await publishDevelopmentCsvPdfSkill({
      sourceRoot: csvPdfSourceRoot,
      pool: migrator,
      objectStorage: csvPdfObjectStorage,
    });
    const second = await publishDevelopmentCsvPdfSkill({
      sourceRoot: csvPdfSourceRoot,
      pool: migrator,
      objectStorage: csvPdfObjectStorage,
    });

    expect(first).toEqual(second);
    expect(
      await migrator.query<{ publisher: string; recommended_version: string }>(
        "SELECT publisher,recommended_version FROM skills WHERE id='skill_cube_csv_to_pdf'",
      ),
    ).toMatchObject({ rows: [{ publisher: "Hoox", recommended_version: "1.3.0" }] });
    expect(first).toEqual({
      version: "1.3.0",
      fileCount: 3,
      packageDigest: "84a8d48b82b54cbf24d60c140189ecb1a08cd02ad691f1782104f35b74c1c77c",
    });
    expect(
      await migrator.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM skill_versions
          WHERE skill_id='skill_cube_csv_to_pdf' AND version='1.3.0'`,
      ),
    ).toMatchObject({ rows: [{ count: "1" }] });
    expect(
      await migrator.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM skill_version_files
          WHERE skill_id='skill_cube_csv_to_pdf' AND skill_version='1.3.0'`,
      ),
    ).toMatchObject({ rows: [{ count: "3" }] });
  });

  it("所有 Tenant 无需安装即可浏览公开市场，并可解析仍然可用的精确旧版本", async () => {
    const rootA = await filesystem.listDirectory({ tenantId: scopeA.tenantId, segments: [] });
    const rootB = await filesystem.listDirectory({ tenantId: scopeB.tenantId, segments: [] });
    expect(rootA).toEqual(rootB);
    expect(rootA).toEqual([
      { kind: "directory", name: "code-review" },
      { kind: "directory", name: "csv-to-pdf" },
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
    expect(page.items.map((item) => item.canonicalKey)).toEqual([
      "code-review",
      "csv-to-pdf",
      "deploy",
    ]);
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

  it("团队 Owner 启用 Skill 后，新 Run 快照包含团队的精确安装版本", async () => {
    expect(
      await repository.install({
        context: teamScope,
        canonicalKey: "csv-to-pdf",
        versionSelector: "1.3.0",
        invocationName: "csv-to-pdf",
        idempotencyKey: "skill-install-team-0001",
        requestDigest: "4".repeat(64),
      }),
    ).toMatchObject({
      outcome: "installed",
      installation: { status: "enabled", skillVersion: "1.3.0" },
    });

    const candidateRunId = `skill-team-run-${unique}`;
    await withTenantTransaction(runtime, teamScope, (client) =>
      createRunSkillSnapshot(client, {
        tenantId: teamScope.tenantId,
        runId: candidateRunId,
        userId: teamScope.userId,
      }),
    );
    expect(
      await withTenantTransaction(runtime, teamScope, (client) =>
        readRunSkillSnapshot(client, teamScope.tenantId, candidateRunId),
      ),
    ).toMatchObject({
      items: [
        {
          invocationName: "csv-to-pdf",
          canonicalKey: "csv-to-pdf",
          skillVersion: "1.3.0",
        },
      ],
    });
  });

  it("固定 publisher 拒绝既有目录发布者漂移", async () => {
    await migrator.query(
      "UPDATE skills SET publisher='Drift Publisher' WHERE id='skill_cube_csv_to_pdf'",
    );
    await expect(
      publishDevelopmentCsvPdfSkill({
        sourceRoot: csvPdfSourceRoot,
        pool: migrator,
        objectStorage: csvPdfObjectStorage,
      }),
    ).rejects.toThrow("CSV 转 PDF Skill 目录键已被其他发布者占用");
  });

  it("管理员直接发布和上传更新保留精确安装引用、幂等审计与下架约束", async () => {
    await admin.query(
      `INSERT INTO "${schema}".platform_skill_operators(user_id,role,status) VALUES ($1,'admin','active')`,
      [scopeA.userId],
    );
    const publisherUrl = new URL(runtimeDatabaseUrl);
    publisherUrl.username = skillPublisherRole;
    publisherUrl.password = skillPublisherPassword;
    const publisherPool = createPostgresPool({
      connectionString: publisherUrl.toString(),
      schema,
      maxConnections: 2,
    });
    const objects = new S3StableSkillPublisher(csvPdfObjectStorage);
    const publications = new SkillPublicationService(
      new PgSkillPublicationAuthorization(publisherPool),
      new PgSkillPublicationRepository(publisherPool, objects),
    );
    try {
      const canonicalKey = `direct-publish-${unique.replaceAll("_", "-")}`;
      const create = {
        userId: scopeA.userId,
        submissionId: `direct_first_${unique}`,
        metadata: {
          canonicalKey,
          displayName: "直接发布技能",
          publisher: "Hoox",
          description: "集成测试技能",
          compatibility: "Agent Skills 标准格式",
          sourceUrl: "",
          sourceRevision: "",
          licenseSpdx: "MIT",
        },
        files: [
          {
            path: "SKILL.md",
            mediaType: "text/markdown",
            contentBase64: Buffer.from("# Direct\n").toString("base64"),
          },
        ],
        idempotencyKey: "skill-direct-first-create-0001",
      };
      const draft = await publications.create(create);
      const replay = await publications.create({
        ...create,
        submissionId: `direct_retry_${unique}`,
      });
      expect(replay.submissionId).toBe(draft.submissionId);
      expect(replay.version).toBe(draft.version);
      const publish = {
        userId: scopeA.userId,
        submissionId: draft.submissionId,
        expectedVersionToken: 0,
        recommended: true,
        idempotencyKey: "skill-direct-first-publish-0001",
      };
      const first = await publications.publish(publish);
      expect(first).toMatchObject({ status: "published", versionToken: 1 });
      expect(first.reviewedBy).toBeUndefined();
      await expect(publications.publish(publish)).resolves.toMatchObject({ versionToken: 1 });
      await expect(
        publications.publish({ ...publish, idempotencyKey: "skill-direct-first-stale-0001" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      expect(
        await repository.install({
          context: scopeA,
          canonicalKey,
          versionSelector: first.version,
          invocationName: "direct-publish",
          idempotencyKey: "skill-direct-install-0001",
          requestDigest: "7".repeat(64),
        }),
      ).toMatchObject({ outcome: "installed", installation: { skillVersion: first.version } });
      const update = await publications.create({
        ...create,
        submissionId: `direct_second_${unique}`,
        idempotencyKey: "skill-direct-second-create-0001",
        files: [
          {
            ...create.files[0],
            path: "SKILL.md",
            mediaType: "text/markdown",
            contentBase64: Buffer.from("# Updated\n").toString("base64"),
          },
        ],
      });
      expect(update.version).not.toBe(first.version);
      const other = await publications.create({
        ...create,
        submissionId: `direct_middle_${unique}`,
        metadata: { ...create.metadata, canonicalKey: `other-${canonicalKey}` },
        idempotencyKey: "skill-direct-other-create-0001",
      });
      const page = await publications.list({ userId: scopeA.userId, latestOnly: true, limit: 1 });
      expect(page.items.map((item) => item.submissionId)).toEqual([other.submissionId]);
      expect(page.nextSubmissionId).toBe(other.submissionId);
      if (page.nextSubmissionId === undefined) throw new Error("当前技能列表缺少下一页游标");
      const next = await publications.list({
        userId: scopeA.userId,
        latestOnly: true,
        limit: 1,
        cursor: page.nextSubmissionId,
      });
      expect(next.items.map((item) => item.submissionId)).toEqual([update.submissionId]);
      expect(next.nextSubmissionId).toBeUndefined();
      expect(next.items[0]?.status).toBe("draft");
      expect(next.items[0]?.currentPublished).toEqual({
        submissionId: first.submissionId,
        versionToken: 1,
      });
      expect((await publications.get(scopeA.userId, update.submissionId)).currentPublished).toEqual(
        { submissionId: first.submissionId, versionToken: 1 },
      );
      expect((await publications.list({ userId: scopeA.userId })).items).toHaveLength(3);
      const beforePublish = await admin.query(
        `SELECT recommended_version FROM "${schema}".skills WHERE canonical_key=$1`,
        [canonicalKey],
      );
      expect(beforePublish.rows[0]?.recommended_version).toBe(first.version);
      await publications.revoke({
        userId: scopeA.userId,
        submissionId: first.submissionId,
        expectedVersionToken: 1,
        idempotencyKey: "skill-direct-first-revoke-before-update",
      });
      const pendingAfterRevoke = (
        await publications.list({ userId: scopeA.userId, latestOnly: true })
      ).items.find((item) => item.submissionId === update.submissionId);
      expect(pendingAfterRevoke).toMatchObject({ status: "draft", versionToken: 0 });
      expect(pendingAfterRevoke?.currentPublished).toBeUndefined();
      expect(
        (await publications.get(scopeA.userId, update.submissionId)).currentPublished,
      ).toBeUndefined();
      await expect(
        withTenantTransaction(runtime, scopeA, (client) =>
          createRunSkillSnapshot(client, {
            tenantId: scopeA.tenantId,
            runId: `revoked-direct-${unique}`,
            userId: scopeA.userId,
            explicitInvocation: { invocationName: "direct-publish", args: "检查" },
          }),
        ),
      ).rejects.toThrow("SKILL_NOT_AVAILABLE");
      await publications.publish({
        ...publish,
        submissionId: update.submissionId,
        idempotencyKey: "skill-direct-second-publish-0001",
      });
      const catalog = await admin.query(
        `SELECT recommended_version FROM "${schema}".skills WHERE canonical_key=$1`,
        [canonicalKey],
      );
      expect(catalog.rows[0]?.recommended_version).toBe(update.version);
      const installed = await admin.query(
        `SELECT skill_version FROM "${schema}".tenant_skill_installations WHERE tenant_id=$1 AND invocation_name='direct-publish'`,
        [scopeA.tenantId],
      );
      expect(installed.rows[0]?.skill_version).toBe(first.version);
      await publications.revoke({
        userId: scopeA.userId,
        submissionId: update.submissionId,
        expectedVersionToken: 1,
        idempotencyKey: "skill-direct-second-revoke-0001",
      });
      await expect(
        publications.publish({
          ...publish,
          submissionId: update.submissionId,
          expectedVersionToken: 2,
          idempotencyKey: "skill-direct-no-resurrection-0001",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const audit = await admin.query(
        `SELECT operation,reason FROM "${schema}".skill_publication_audits WHERE submission_id=$1 ORDER BY version_token`,
        [update.submissionId],
      );
      expect(audit.rows).toEqual([
        { operation: "create", reason: null },
        { operation: "publish", reason: null },
        { operation: "revoke", reason: null },
      ]);
      const conflictingPublisher = await publications.create({
        ...create,
        submissionId: `direct_z_conflict_${unique}`,
        metadata: { ...create.metadata, publisher: "Other Publisher" },
        idempotencyKey: "skill-direct-other-publisher-0001",
      });
      const current = await publications.list({ userId: scopeA.userId, latestOnly: true });
      expect(
        current.items
          .filter((item) => item.canonicalKey === canonicalKey)
          .map((item) => item.submissionId),
      ).toEqual([conflictingPublisher.submissionId]);
      await expect(
        publications.publish({
          ...publish,
          submissionId: conflictingPublisher.submissionId,
          idempotencyKey: "skill-direct-publisher-conflict-0001",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      objects.close();
      await publisherPool.end();
    }
  });
});
