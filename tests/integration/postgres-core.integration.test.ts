import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireWorkspaceLease,
  archiveThread,
  createPersonalTenant,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  isoTimestamp,
  type Membership,
  membershipId,
  prepareWorkspaceRevision,
  type Run,
  releaseWorkspaceLease,
  renewWorkspaceLease,
  runId,
  sha256Digest,
  type Tenant,
  type Thread,
  tenantId,
  threadId,
  transitionRun,
  type User,
  userId,
  type Workspace,
  workspaceId,
  workspaceRevisionId,
} from "@hoox/domain";
import type {
  CoreRepositories,
  TenantScope,
  WorkspaceWriteScope,
} from "@hoox/persistence/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "../../runtime-ts/apps/api/src/app.js";
import { createThreadCursorCodec } from "../../runtime-ts/apps/api/src/cursor.js";
import { DEFAULT_AGENT_OPERATOR_INSTRUCTIONS } from "../../runtime-ts/packages/prompt-builder/src/index.js";
import { AdminControlService } from "../../runtime-ts/packages/admin-control/src/index.js";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import { ModelProviderCredentialCipher } from "../../runtime-ts/packages/persistence/src/model-provider-credential.js";
import { PgAgentDefinitionRepository } from "../../runtime-ts/packages/persistence/src/pg-agent-definition.js";
import {
  PgAdminControlRepository,
  PgRuntimeControlConfigurationRepository,
} from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
import {
  PgArchiveThreadCommand,
  PgCoreRepositories,
  PgRenamePersonalThreadCommand,
} from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import {
  PgSandboxConfigurationResolver,
  PgSandboxControlRepository,
} from "../../runtime-ts/packages/persistence/src/pg-sandbox-configuration.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { bootstrapRuntimeAccess } from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";
import {
  loadPostgreSqlMigrationContract,
  type PostgreSqlMigrationContract,
} from "./postgres-migration-contract.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`PostgreSQL 集成测试缺少 ${name}；不会输出配置值`);
  }
  return value;
}

const runtimeDatabaseUrl = requiredEnvironment("DATABASE_URL");
const bootstrapDatabaseUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const migrationDatabaseUrl = requiredEnvironment("MIGRATION_DATABASE_URL");
const runtimeRole = requiredEnvironment("DATABASE_RUNTIME_ROLE");
const configuredMigratorRole = requiredEnvironment("DATABASE_MIGRATOR_ROLE");

const schema = `it_${process.pid}_${Date.now()}`;
const databaseOwnerRole = new URL(bootstrapDatabaseUrl).username;
const databaseName = new URL(bootstrapDatabaseUrl).pathname.slice(1);
const migratorRole = `it_mg_${process.pid}_${Date.now().toString(36)}`;
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherRole = `it_pub_${process.pid}_${Date.now().toString(36)}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorRole = `it_coord_${process.pid}_${Date.now().toString(36)}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const adminControlRole = workerCoordinatorRole.replace("_coord_", "_control_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const adminControlPassword = randomBytes(24).toString("hex");
const testMigrationUrl = new URL(migrationDatabaseUrl);
const teamCoordinatorDatabaseUrl = new URL(migrationDatabaseUrl);
const adminControlDatabaseUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
teamCoordinatorDatabaseUrl.username = teamCoordinatorRole;
teamCoordinatorDatabaseUrl.password = teamCoordinatorPassword;
adminControlDatabaseUrl.username = adminControlRole;
adminControlDatabaseUrl.password = adminControlPassword;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseOwnerRole)) {
  throw new Error("数据库 Owner 角色名称无效");
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("测试数据库名称无效");
const migrationSecurity = {
  runtimeRole,
  migratorRole,
  skillPublisherRole,
  workerCoordinatorRole,
  teamCoordinatorRole,
  adminControlRole,
  schema,
} as const;
const sourceMigrationDirectory = fileURLToPath(
  new URL("../../runtime-ts/packages/persistence/migrations/", import.meta.url),
);
let administrativePool!: Pool;
let migratorPool!: Pool;
let runtimePool!: Pool;
let teamCoordinatorPool!: Pool;
let adminControlPool!: Pool;
let repositories!: CoreRepositories;
let schemaCreated = false;
let migratorCreated = false;
let concurrentMigrationVersions: readonly number[] = [];
let migrationContract!: PostgreSqlMigrationContract;
let isolatedMigrationCounter = 0;

interface Fixture {
  readonly scope: TenantScope;
  readonly writeScope: WorkspaceWriteScope;
  readonly tenant: Tenant;
  readonly user: User;
  readonly membership: Membership;
  readonly thread: Thread;
  readonly run: Run;
  readonly workspace: Workspace;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

async function readDefaultAgentRevision() {
  const repository = new PgAgentDefinitionRepository(runtimePool);
  return repository.readRevisionById(tenantId("tenant_seed_contract"), "agent_default_revision_1");
}

function timestamp(second: number): ReturnType<typeof isoTimestamp> {
  return isoTimestamp(`2099-07-26T08:00:${second.toString().padStart(2, "0")}.000Z`);
}

async function createFixture(suffix: string): Promise<Fixture> {
  const user = createUser(userId(`user_${suffix}`), timestamp(0));
  const personal = createPersonalTenant({
    id: tenantId(`tenant_${suffix}`),
    ownerMembershipId: membershipId(`membership_${suffix}`),
    owner: user,
    createdAt: timestamp(0),
  });
  const scope: TenantScope = { tenantId: personal.tenant.id, userId: user.id };
  expect(
    await repositories.tenants.createPersonal({
      user,
      tenant: personal.tenant,
      membership: personal.ownerMembership,
    }),
  ).toEqual({ outcome: "created" });
  const thread = createThread({
    id: threadId(`thread_${suffix}`),
    tenant: personal.tenant,
    user,
    membership: personal.ownerMembership,
    title: `任务 ${suffix}`,
    now: timestamp(1),
  });
  expect(await repositories.threads.create(scope, thread)).toEqual({
    outcome: "created",
    version: 0n,
  });
  const queued = createRun({ id: runId(`run_${suffix}`), thread, now: timestamp(2) });
  const run = transitionRun(queued, "running", timestamp(3));
  expect(await repositories.runs.create(scope, run)).toEqual({ outcome: "created", version: 0n });
  const workspace = createWorkspace({
    id: workspaceId(`workspace_${suffix}`),
    thread,
    now: timestamp(4),
  });
  expect(await repositories.workspaces.create(scope, workspace)).toEqual({ outcome: "created" });
  return {
    scope,
    writeScope: { tenantId: scope.tenantId, rootRunId: run.id },
    tenant: personal.tenant,
    user,
    membership: personal.ownerMembership,
    thread,
    run,
    workspace,
  };
}

async function acquireLease(fixture: Fixture): Promise<Workspace> {
  const leased = acquireWorkspaceLease({
    workspace: fixture.workspace,
    rootRun: fixture.run,
    epoch: 1,
    expiresAt: timestamp(50),
    now: timestamp(5),
  });
  expect(
    await repositories.workspaces.compareAndSetLease(fixture.writeScope, fixture.workspace, leased),
  ).toEqual({ outcome: "committed" });
  return leased;
}

interface IsolatedMigrationTarget {
  readonly pool: Pool;
  readonly connectionString: string;
  readonly context: {
    readonly runtimeRole: string;
    readonly migratorRole: string;
    readonly skillPublisherRole: string;
    readonly workerCoordinatorRole: string;
    readonly teamCoordinatorRole: string;
    readonly adminControlRole: string;
    readonly schema: string;
  };
  close(): Promise<void>;
}

async function createIsolatedMigrationTarget(suffix: string): Promise<IsolatedMigrationTarget> {
  isolatedMigrationCounter += 1;
  const isolatedSuffix = `${process.pid}_${isolatedMigrationCounter}`;
  const isolatedRole = `it_mg_${isolatedSuffix}`;
  const isolatedPublisherRole = `it_pub_${isolatedSuffix}`;
  const isolatedCoordinatorRole = `it_coord_${isolatedSuffix}`;
  const isolatedTeamCoordinatorRole = `it_team_${isolatedSuffix}`;
  const isolatedAdminControlRole = `it_control_${isolatedSuffix}`;
  const isolatedSchema = `it_${suffix}_${isolatedSuffix}`;
  const password = randomBytes(24).toString("hex");
  const url = new URL(migrationDatabaseUrl);
  url.username = isolatedRole;
  url.password = password;
  await administrativePool.query(
    `CREATE ROLE "${isolatedRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedPublisherRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedCoordinatorRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedTeamCoordinatorRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedAdminControlRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${isolatedRole}", "${isolatedPublisherRole}", "${isolatedCoordinatorRole}", "${isolatedTeamCoordinatorRole}", "${isolatedAdminControlRole}";
     CREATE SCHEMA "${isolatedSchema}" AUTHORIZATION "${isolatedRole}"`,
  );
  const pool = createPostgresPool({
    connectionString: url.toString(),
    schema: isolatedSchema,
    maxConnections: 2,
  });
  let closed = false;
  return {
    pool,
    connectionString: url.toString(),
    context: {
      runtimeRole,
      migratorRole: isolatedRole,
      skillPublisherRole: isolatedPublisherRole,
      workerCoordinatorRole: isolatedCoordinatorRole,
      teamCoordinatorRole: isolatedTeamCoordinatorRole,
      adminControlRole: isolatedAdminControlRole,
      schema: isolatedSchema,
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
      await administrativePool.query(
        `DROP SCHEMA "${isolatedSchema}" CASCADE;
         REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${isolatedRole}", "${isolatedPublisherRole}", "${isolatedCoordinatorRole}", "${isolatedTeamCoordinatorRole}", "${isolatedAdminControlRole}";
         DROP ROLE "${isolatedAdminControlRole}";
         DROP ROLE "${isolatedTeamCoordinatorRole}";
         DROP ROLE "${isolatedCoordinatorRole}";
         DROP ROLE "${isolatedPublisherRole}";
         DROP ROLE "${isolatedRole}"`,
      );
    },
  };
}

beforeAll(async () => {
  migrationContract = await loadPostgreSqlMigrationContract();
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
     CREATE ROLE "${adminControlRole}" LOGIN PASSWORD '${adminControlPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
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
    maxConnections: 8,
  });
  teamCoordinatorPool = createPostgresPool({
    connectionString: teamCoordinatorDatabaseUrl.toString(),
    schema,
    maxConnections: 4,
  });
  adminControlPool = createPostgresPool({
    connectionString: adminControlDatabaseUrl.toString(),
    schema,
    maxConnections: 4,
  });
  const concurrent = await Promise.all([
    migrateUp(migratorPool, migrationSecurity),
    migrateUp(migratorPool, migrationSecurity),
  ]);
  concurrentMigrationVersions = concurrent.flatMap((records) =>
    records.map((record) => record.version),
  );
  repositories = new PgCoreRepositories(runtimePool);
});

afterAll(async () => {
  if (runtimePool !== undefined) await runtimePool.end();
  if (teamCoordinatorPool !== undefined) await teamCoordinatorPool.end();
  if (adminControlPool !== undefined) await adminControlPool.end();
  if (migratorPool !== undefined) await migratorPool.end();
  if (!schema.startsWith(`it_${process.pid}_`)) throw new Error("拒绝删除非测试 Schema");
  if (schemaCreated) await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
  if (migratorCreated) {
    await administrativePool.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
       DROP ROLE "${adminControlRole}";
       DROP ROLE "${teamCoordinatorRole}";
       DROP ROLE "${workerCoordinatorRole}";
       DROP ROLE "${skillPublisherRole}";
       DROP ROLE "${migratorRole}"`,
    );
  }
  if (administrativePool !== undefined) await administrativePool.end();
});

describe("PostgreSQL 迁移与强权限边界", () => {
  it("为迁移前已有 Thread 回填不可变默认 Agent 绑定", async () => {
    const target = await createIsolatedMigrationTarget("agent_backfill");
    const oldMigrations = await mkdtemp(join(tmpdir(), "hoox-agent-old-migrations-"));
    const seedPool = createPostgresPool({
      connectionString: bootstrapDatabaseUrl,
      schema: target.context.schema,
      maxConnections: 2,
    });
    try {
      for (const name of [
        "0001_baseline.up.sql",
        "0001_baseline.down.sql",
        "0002_inline_tool_receipts.up.sql",
        "0002_inline_tool_receipts.down.sql",
      ]) {
        await copyFile(join(sourceMigrationDirectory, name), join(oldMigrations, name));
      }
      await migrateUp(target.pool, { ...target.context, directory: oldMigrations });
      const tenant = "tenant_agent_backfill";
      const user = "user_agent_backfill";
      await withTenantTransaction(seedPool, { tenantId: tenant, userId: user }, async (client) => {
        await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
          user,
        ]);
        await client.query(
          "INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,clock_timestamp())",
          [tenant, user],
        );
        await client.query(
          "INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at) VALUES($1,'membership_agent_backfill',$2,'owner','active',clock_timestamp())",
          [tenant, user],
        );
        await client.query(
          "INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at) VALUES($1,'thread_agent_backfill',$2,'既有任务','active',clock_timestamp(),clock_timestamp())",
          [tenant, user],
        );
      });
      await migrateUp(target.pool, target.context);
      const binding = await withTenantTransaction(
        seedPool,
        { tenantId: tenant, userId: user },
        (client) =>
          client.query(
            "SELECT agent_definition_id FROM threads WHERE tenant_id=$1 AND id='thread_agent_backfill'",
            [tenant],
          ),
      );
      expect(binding.rows[0]?.agent_definition_id).toBe("agent_default");
    } finally {
      await seedPool.end();
      await rm(oldMigrations, { recursive: true, force: true });
      await target.close();
    }
  });
  it("默认 Agent Revision 使用 Prompt Builder 指令且内容摘要可校验", async () => {
    const revision = await readDefaultAgentRevision();
    expect(revision).toBeDefined();
    if (revision === undefined) throw new Error("默认 Agent Revision 不可见");

    expect(revision.content.operatorInstructions).toBe(DEFAULT_AGENT_OPERATOR_INSTRUCTIONS);
    expect(createHash("sha256").update(canonical(revision.content)).digest("hex")).toBe(
      revision.digest,
    );
  });

  it("默认 Agent Revision 的工具配置跟随平台运行设置", async () => {
    const revision = await readDefaultAgentRevision();
    expect(revision?.content.tools).toEqual({ mode: "platform_default" });
  });

  it("AgentDefinition 发布、可用范围、撤销与 Thread 绑定 ACL", async () => {
    const manager = await createFixture("agent_manager");
    const other = await createFixture("agent_other_tenant");
    const viewer = await createFixture("agent_viewer");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active'),($2,'viewer','active')",
      [manager.user.id, viewer.user.id],
    );
    const repository = new PgAgentDefinitionRepository(adminControlPool);
    const content = {
      displayName: "测试助手",
      description: "测试用途",
      suggestedQuestions: [],
      operatorInstructions: "仅用于隔离 PostgreSQL 测试。",
      replyLanguage: "zh-CN",
      model: { mode: "platform_default" as const },
      tools: {
        mode: "configured" as const,
        builtinTools: [],
        externalTools: [],
        clientTools: [],
        toolCallingMode: "native" as const,
      },
      skillVersions: [],
      includeTenantSkills: true,
      sandboxIdleAction: "pause" as const,
      longTermMemoryEnabled: false,
    };
    await expect(
      repository.createDraft({
        actorUserId: viewer.user.id,
        id: "agent_viewer_denied",
        availability: { mode: "all_tenants" },
        content,
        revisionId: "agent_viewer_revision",
        idempotencyKey: "agent-viewer-create",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    const draft = await repository.createDraft({
      actorUserId: manager.user.id,
      id: "agent_scope_test",
      availability: { mode: "selected_tenants", tenantIds: [manager.tenant.id] },
      content,
      revisionId: "agent_scope_revision_1",
      idempotencyKey: "agent-create-scope-1",
      expectedGeneration: 0,
    });
    expect(draft.definition.status).toBe("draft");
    const published = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: draft.revision.id,
      idempotencyKey: "agent-publish-scope-1",
      expectedGeneration: 0,
    });
    expect(published.currentRevisionId).toBe(draft.revision.id);
    expect(
      await repository.publish({
        actorUserId: manager.user.id,
        definitionId: draft.definition.id,
        revisionId: draft.revision.id,
        idempotencyKey: "agent-publish-scope-1",
        expectedGeneration: 0,
      }),
    ).toEqual(published);
    const secondRevision = await repository.createDraftRevision({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: "agent_scope_revision_2",
      content: { ...content, displayName: "测试助手第二版" },
      idempotencyKey: "agent-revision-create-2",
      expectedGeneration: 1,
    });
    const secondPublish = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: secondRevision.id,
      idempotencyKey: "agent-publish-scope-2",
      expectedGeneration: 2,
    });
    expect(secondPublish.currentRevisionId).toBe(secondRevision.id);
    expect((await repository.readRevisionById(manager.tenant.id, draft.revision.id))?.status).toBe(
      "published",
    );
    expect(
      (await repository.listAvailable(manager.tenant.id)).map((item) => item.definition.id),
    ).toContain("agent_scope_test");
    expect(
      (await repository.listAvailable(other.tenant.id)).map((item) => item.definition.id),
    ).not.toContain("agent_scope_test");
    const hidden = await withTenantTransaction(runtimePool, other.scope, (client) =>
      client.query("SELECT id FROM agent_definitions WHERE id='agent_scope_test'"),
    );
    expect(hidden.rowCount).toBe(0);
    const hiddenRevision = await withTenantTransaction(runtimePool, other.scope, (client) =>
      client.query("SELECT id FROM agent_revisions WHERE id=$1", [draft.revision.id]),
    );
    expect(hiddenRevision.rowCount).toBe(0);
    await expect(
      adminControlPool.query("UPDATE agent_revisions SET content='{}'::jsonb WHERE id=$1", [
        draft.revision.id,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      adminControlPool.query("DELETE FROM agent_definitions WHERE id='agent_default'"),
    ).rejects.toMatchObject({ code: "42501" });
    const defaultAgent = await runtimePool.query(
      "SELECT id,current_revision_id FROM agent_definitions WHERE id='agent_default'",
    );
    expect(defaultAgent.rowCount).toBe(1);
    const thread = await withTenantTransaction(runtimePool, manager.scope, (client) =>
      client.query("SELECT agent_definition_id FROM threads WHERE tenant_id=$1 AND id=$2", [
        manager.tenant.id,
        manager.thread.id,
      ]),
    );
    expect(thread.rows[0]?.agent_definition_id).toBe("agent_default");
    await expect(
      repository.deactivate({
        actorUserId: manager.user.id,
        definitionId: published.id,
        idempotencyKey: "agent-disable-scope-1",
        expectedGeneration: 3,
      }),
    ).resolves.toMatchObject({ status: "disabled", generation: 4 });
    await expect(
      repository.revoke({
        actorUserId: manager.user.id,
        definitionId: published.id,
        revisionId: draft.revision.id,
        reason: "测试撤销",
        idempotencyKey: "agent-revoke-old-revision",
        expectedGeneration: 4,
      }),
    ).resolves.toMatchObject({ status: "disabled", generation: 5 });
    expect(
      (await repository.listAvailable(manager.tenant.id)).map((item) => item.definition.id),
    ).not.toContain("agent_scope_test");
    await expect(
      repository.publish({
        actorUserId: manager.user.id,
        definitionId: draft.definition.id,
        revisionId: draft.revision.id,
        idempotencyKey: "agent-publish-stale-1",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const revokeDraft = await repository.createDraft({
      actorUserId: manager.user.id,
      id: "agent_revoke_test",
      availability: { mode: "all_tenants" },
      content,
      revisionId: "agent_revoke_revision_1",
      idempotencyKey: "agent-revoke-create",
      expectedGeneration: 0,
    });
    const revokePublished = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: revokeDraft.definition.id,
      revisionId: revokeDraft.revision.id,
      idempotencyKey: "agent-revoke-publish",
      expectedGeneration: 0,
    });
    await expect(
      repository.revoke({
        actorUserId: manager.user.id,
        definitionId: revokePublished.id,
        revisionId: revokeDraft.revision.id,
        reason: "紧急撤销测试",
        idempotencyKey: "agent-revoke-current",
        expectedGeneration: 1,
      }),
    ).resolves.toMatchObject({ status: "revoked", generation: 2 });
    expect(
      await repository.readCurrentPublished(manager.tenant.id, "agent_revoke_test"),
    ).toBeUndefined();
  });

  it("托管沙箱配置验证权限、发布门禁、版本并发及实例绑定隔离", async () => {
    const admin = await createFixture("sandbox_control_admin");
    const viewer = await createFixture("sandbox_control_viewer");
    const outsider = await createFixture("sandbox_control_outsider");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active'),($2,'viewer','active')",
      [admin.user.id, viewer.user.id],
    );
    const cipher = new ModelProviderCredentialCipher(
      "sandbox-test-placeholder-root-secret-at-least-32",
    );
    const control = new PgSandboxControlRepository(adminControlPool, cipher);
    const resolver = new PgSandboxConfigurationResolver(runtimePool, cipher);
    const configuration = {
      providerKey: "tencent-ags" as const,
      displayName: "测试沙箱",
      endpoint: "sandbox.example.test",
      policy: {
        templateId: "test-template",
        sessionTtlSeconds: 300,
        operationTimeoutMs: 30000,
        lifecycleTimeoutMs: 90000,
        pausedRetentionSeconds: 600,
        idleAction: "pause" as const,
      },
    };
    const save = {
      expectedGeneration: 0,
      configuration,
      apiKey: "sandbox-test-placeholder-api-key",
    };
    await expect(control.overview(outsider.user.id)).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    await expect(control.saveProfile(viewer.user.id, save)).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(
      await resolver.bind({ tenantId: admin.tenant.id, registryId: "legacy-registry" }),
    ).toBeUndefined();
    const profile = await control.saveProfile(admin.user.id, save);
    expect(profile.probeStatus).toBe("untested");
    expect(JSON.stringify(await control.overview(viewer.user.id))).not.toContain(save.apiKey);
    await expect(control.saveProfile(admin.user.id, save)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const routing = {
      mode: "single" as const,
      targets: [
        { providerKey: configuration.providerKey, profileRevision: profile.revision, weight: 1 },
      ],
    };
    await expect(
      control.publishRouting(admin.user.id, { expectedGeneration: 1, configuration: routing }),
    ).rejects.toMatchObject({ code: "PROBE_FAILED" });
    const observed = await control.probeProfile(
      admin.user.id,
      configuration.providerKey,
      profile.revision,
      async (value, key) => {
        expect(value.endpoint).toBe(configuration.endpoint);
        expect(key).toBe(save.apiKey);
      },
    );
    expect(observed.healthy).toBe(true);
    await control.publishRouting(admin.user.id, { expectedGeneration: 2, configuration: routing });
    const bound = await resolver.bind({
      tenantId: admin.tenant.id,
      registryId: "managed-registry",
    });
    expect(bound?.profileRevision).toBe(profile.revision);
    expect(bound?.apiKey).toBe(save.apiKey);
    expect(
      await resolver.resolve({ tenantId: outsider.tenant.id, registryId: "managed-registry" }),
    ).toBeUndefined();
    const second = await control.saveProfile(admin.user.id, {
      expectedGeneration: 3,
      configuration: {
        ...configuration,
        endpoint: "other.example.test",
        policy: { ...configuration.policy, idleAction: "kill" },
      },
      reuseCredentialFromRevision: profile.revision,
    });
    await control.probeProfile(
      admin.user.id,
      configuration.providerKey,
      second.revision,
      async () => undefined,
    );
    await control.publishRouting(admin.user.id, {
      expectedGeneration: 5,
      configuration: {
        ...routing,
        targets: [
          { providerKey: configuration.providerKey, weight: 1, profileRevision: second.revision },
        ],
      },
    });
    expect(
      (await resolver.resolve({ tenantId: admin.tenant.id, registryId: "managed-registry" }))
        ?.configuration.endpoint,
    ).toBe(configuration.endpoint);
    expect(
      (await resolver.bind({ tenantId: admin.tenant.id, registryId: "managed-registry" }))
        ?.profileRevision,
    ).toBe(profile.revision);
    expect(
      (await resolver.bind({ tenantId: admin.tenant.id, registryId: "new-registry" }))
        ?.configuration.policy.idleAction,
    ).toBe("kill");
    const restarted = new PgSandboxConfigurationResolver(runtimePool, cipher);
    expect(
      (await restarted.resolve({ tenantId: admin.tenant.id, registryId: "managed-registry" }))
        ?.configuration.endpoint,
    ).toBe(configuration.endpoint);
    await expect(
      adminControlPool.query("UPDATE sandbox_provider_profiles SET configuration='{}'::jsonb"),
    ).rejects.toBeDefined();
    await expect(
      runtimePool.query("UPDATE sandbox_control_head SET generation=100"),
    ).rejects.toBeDefined();
    await bootstrapRuntimeAccess(migratorPool, migrationSecurity);
    expect((await control.overview(admin.user.id)).generation).toBe(6);
    expect(
      (await restarted.resolve({ tenantId: admin.tenant.id, registryId: "managed-registry" }))
        ?.configuration.endpoint,
    ).toBe(configuration.endpoint);
    const concurrent = await Promise.allSettled([
      control.saveProfile(admin.user.id, {
        expectedGeneration: 6,
        configuration: {
          ...configuration,
          providerKey: "cube",
          endpoint: "http://cube.example.test:8080",
          cubeProxy: { host: "proxy.example.test", port: 8443, scheme: "https" },
        },
      }),
      control.saveProfile(admin.user.id, {
        expectedGeneration: 6,
        configuration: {
          ...configuration,
          providerKey: "cube",
          endpoint: "http://cube.example.test:8080",
          cubeProxy: { host: "proxy.example.test", port: 8443, scheme: "https" },
        },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("CONFLICT");
    const cube = (await control.overview(admin.user.id)).profiles.find(
      (value) => value.configuration.providerKey === "cube",
    );
    if (!cube) throw new Error("缺少测试 Cube 配置");
    expect(cube.configuration.cubeProxy).toEqual({
      host: "proxy.example.test",
      port: 8443,
      scheme: "https",
    });
    await control.probeProfile(admin.user.id, "cube", cube.revision, async () => undefined);
    await control.publishRouting(admin.user.id, {
      expectedGeneration: 8,
      configuration: {
        mode: "single",
        targets: [{ providerKey: "cube", profileRevision: cube.revision, weight: 1 }],
      },
    });
    expect(
      (await resolver.bind({ tenantId: admin.tenant.id, registryId: "after-switch" }))
        ?.configuration.providerKey,
    ).toBe("cube");
    expect(
      (await restarted.resolve({ tenantId: admin.tenant.id, registryId: "managed-registry" }))
        ?.configuration.providerKey,
    ).toBe("tencent-ags");
    await control.publishRouting(admin.user.id, {
      expectedGeneration: 9,
      configuration: {
        mode: "weighted",
        targets: [
          { providerKey: "tencent-ags", profileRevision: second.revision, weight: 1 },
          { providerKey: "cube", profileRevision: cube.revision, weight: 3 },
        ],
      },
    });
    const allocations = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        resolver.bind({ tenantId: admin.tenant.id, registryId: `weighted-${index}` }),
      ),
    );
    const counts: Record<string, number> = {};
    for (const item of allocations) {
      const providerKey = item?.configuration.providerKey ?? "missing";
      counts[providerKey] = (counts[providerKey] ?? 0) + 1;
    }
    expect(counts["tencent-ags"]).toBeGreaterThan(5);
    expect(counts.cube).toBeGreaterThan(counts["tencent-ags"] ?? 0);
    await migratorPool.query(`
      DELETE FROM sandbox_configuration_bindings;
      DELETE FROM sandbox_control_audits;
      DELETE FROM sandbox_profile_probes;
      UPDATE sandbox_control_head SET generation=0,routing_revision=NULL WHERE singleton=true;
      DELETE FROM sandbox_routing_targets;
      DELETE FROM sandbox_routing_revisions;
      DELETE FROM sandbox_provider_profiles;
    `);
    await migratorPool.query("DELETE FROM platform_control_operators WHERE user_id IN ($1,$2)", [
      admin.user.id,
      viewer.user.id,
    ]);
  }, 120000);

  it("后台聚合策略支持回滚重建和导入后的角色重绑定", async () => {
    const target = await createIsolatedMigrationTarget("admin_projection");
    const policies = () =>
      target.pool.query<{ tablename: string; policyname: string; roles: string[] }>(
        "SELECT tablename,policyname,roles::text[] AS roles FROM pg_policies WHERE schemaname=current_schema() AND policyname LIKE '%_admin_projection_read' ORDER BY tablename",
      );
    try {
      await migrateUp(target.pool, target.context);
      const created = (await policies()).rows;
      expect(created).toHaveLength(12);
      for (const policy of created) {
        await target.pool.query(
          `ALTER POLICY "${policy.policyname}" ON "${policy.tablename}" TO "${migratorRole}"`,
        );
      }
      await bootstrapRuntimeAccess(target.pool, target.context);
      expect(
        (await policies()).rows.every(
          (policy) => policy.roles.length === 1 && policy.roles[0] === target.context.migratorRole,
        ),
      ).toBe(true);
      await migrateDown(target.pool, {
        ...target.context,
        allowDestructive: true,
        environment: "test",
        targetVersion: 0,
      });
      expect((await policies()).rows).toEqual([]);
      await migrateUp(target.pool, target.context);
      expect((await policies()).rows).toEqual(created);
    } finally {
      await target.close();
    }
  });

  it("后台聚合跨租户统计与用量，但不扩大控制角色或 Runtime 的底表权限", async () => {
    const first = await createFixture("stats_a");
    const repository = new PgAdminControlRepository(
      adminControlPool,
      new ModelProviderCredentialCipher("integration-statistics-key-at-least-32-bytes"),
    );
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [first.user.id],
    );
    const baseline = await repository.read(first.user.id);
    const second = await createFixture("stats_b");
    try {
      for (const [index, fixture] of [first, second].entries()) {
        await administrativePool.query(
          `INSERT INTO "${schema}".user_accounts
          (user_id,personal_tenant_id,email,normalized_email,display_name,password_algorithm,password_salt,password_hash,created_at,updated_at)
          VALUES ($1,$2,$3,$3,'统计测试','scrypt-v1',decode(repeat('00',16),'hex'),decode(repeat('00',32),'hex'),clock_timestamp(),clock_timestamp())`,
          [fixture.user.id, fixture.tenant.id, `stats-${index}@example.invalid`],
        );
        await administrativePool.query(
          `INSERT INTO "${schema}".user_sessions
          (token_digest,user_id,personal_tenant_id,created_at,expires_at)
          VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`,
          [String(index + 1).repeat(64), fixture.user.id, fixture.tenant.id],
        );
        await withTenantTransaction(runtimePool, fixture.scope, async (client) => {
          for (const [metric, value] of [
            ["model_input_tokens", 100],
            ["model_output_tokens", 20],
            ["model_cache_read_tokens", 50],
            ["model_generation_duration_ms", 1000],
          ] as const) {
            await client.query(
              `INSERT INTO thread_continuity_metric_observations
              (tenant_id,observation_id,thread_id,run_id,metric_name,value,unit)
              VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                fixture.tenant.id,
                `${metric}_stats`,
                fixture.thread.id,
                fixture.run.id,
                metric,
                value,
                metric.endsWith("duration_ms") ? "milliseconds" : "tokens",
              ],
            );
          }
          await client.query(
            `INSERT INTO thread_continuity_metric_observations
            (tenant_id,observation_id,thread_id,metric_name,value,unit,observed_at)
            VALUES ($1,'old_model_input',$2,'model_input_tokens',9999,'tokens',clock_timestamp()-interval '48 hours')`,
            [fixture.tenant.id, fixture.thread.id],
          );
        });
      }
      const statistics = await repository.read(first.user.id);
      expect(statistics.conversations.total).toBe(baseline.conversations.total + 1);
      expect(statistics.runs.total).toBe(baseline.runs.total + 1);
      expect(statistics.users.total).toBe(baseline.users.total + 2);
      expect(statistics.modelUsage24h).toMatchObject({
        inputTokens: 300,
        outputTokens: 40,
        outputTokensPerSecond: 20,
        cacheHitRate: 1 / 3,
      });
      const directory = await repository.listUsers({
        actorUserId: first.user.id,
        query: "stats-",
        limit: 10,
      });
      expect(directory.items).toHaveLength(2);
      for (const user of directory.items)
        expect(user).toMatchObject({ conversationCount: 1, runCount: 1, activeSessions: 1 });
      for (const role of ["viewer", "operator"] as const) {
        await migratorPool.query("UPDATE platform_control_operators SET role=$2 WHERE user_id=$1", [
          first.user.id,
          role,
        ]);
        expect((await repository.read(first.user.id)).runs.total).toBe(statistics.runs.total);
        expect(
          (await repository.listUsers({ actorUserId: first.user.id, limit: 10 })).items,
        ).toHaveLength(0);
      }
      await migratorPool.query(
        "UPDATE platform_control_operators SET role='admin',status='disabled' WHERE user_id=$1",
        [first.user.id],
      );
      const disabled = await withTenantTransaction(adminControlPool, first.scope, (client) =>
        client.query("SELECT * FROM admin_runtime_statistics"),
      );
      expect(disabled.rows).toHaveLength(0);
      const unknown = await withTenantTransaction(adminControlPool, second.scope, (client) =>
        client.query("SELECT * FROM admin_runtime_statistics"),
      );
      expect(unknown.rows).toHaveLength(0);
      expect(
        (await adminControlPool.query("SELECT * FROM admin_runtime_statistics")).rows,
      ).toHaveLength(0);
      await migratorPool.query(
        "UPDATE platform_control_operators SET status='active' WHERE user_id=$1",
        [first.user.id],
      );
      const ownRuns = await withTenantTransaction(runtimePool, first.scope, (client) =>
        client.query("SELECT tenant_id FROM runs"),
      );
      expect(ownRuns.rows).toEqual([{ tenant_id: first.tenant.id }]);
      for (const table of [
        "threads",
        "runs",
        "run_dispatch_outbox",
        "sandbox_registry",
        "cleanup_outbox",
        "memory_ingestion_outbox",
        "scheduled_tasks",
        "scheduled_task_occurrences",
        "tenant_skill_installations",
        "thread_continuity_metric_observations",
        "user_accounts",
        "user_sessions",
      ]) {
        await expect(adminControlPool.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      const role = await migratorPool.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    } finally {
      await administrativePool.query(
        `DELETE FROM "${schema}".thread_continuity_metric_observations WHERE tenant_id=ANY($1::text[])`,
        [[first.tenant.id, second.tenant.id]],
      );
      await administrativePool.query(
        `DELETE FROM "${schema}".user_accounts WHERE user_id=ANY($1::text[])`,
        [[first.user.id, second.user.id]],
      );
      await migratorPool.query("DELETE FROM platform_control_operators WHERE user_id=$1", [
        first.user.id,
      ]);
    }
  });

  it("记忆密钥独立于模型托管、加密保存且只影响新 Run", async () => {
    const initial = await createFixture("memory_bootstrap");
    const cipher = new ModelProviderCredentialCipher("integration-memory-root-at-least-32-bytes");
    const repository = new PgAdminControlRepository(adminControlPool, cipher);
    const service = new AdminControlService(
      repository,
      repository,
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    const runtime = new PgRuntimeControlConfigurationRepository(runtimePool, cipher);
    const scope = { tenantId: initial.scope.tenantId, runId: initial.run.id };
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [initial.user.id],
    );
    const context = (id: string) => ({
      actorUserId: initial.user.id,
      idempotencyKey: `memory-online-${id}`,
      requestDigest: "b".repeat(64),
    });
    try {
      const empty = await runtime.resolveForRun(scope);
      expect(empty).toEqual({ generation: 0 });
      const command = {
        providerKey: "mem0",
        displayName: "长期记忆",
        providerKind: "mem0",
        baseUrl: "https://memory.example.invalid/",
        apiSecretRef: "managed:memory-api",
        scopeSecretRef: "platform:memory-scope",
        requestTimeoutMs: 10000,
        enabled: true,
        apiKey: "integration-memory-key-a",
        expectedGeneration: 0,
      } as const;
      const first = await service.saveMemoryConfiguration(context("first"), command);
      await expect(service.saveMemoryConfiguration(context("first"), command)).resolves.toEqual(
        first,
      );
      expect(JSON.stringify(first)).not.toContain(command.apiKey);
      expect(JSON.stringify(await repository.listMemoryProviders(initial.user.id))).not.toContain(
        "ciphertext",
      );
      const raw = await migratorPool.query(
        "SELECT configuration FROM admin_control_config_revisions WHERE object_kind='memory_provider'",
      );
      expect(JSON.stringify(raw.rows)).not.toContain(command.apiKey);
      expect(raw.rows[0].configuration.credential).toBeDefined();
      await expect(runtime.resolveForRun(scope)).resolves.toEqual(empty);
      const activeRun = await createFixture("memory_active");
      const activeScope = { tenantId: activeRun.scope.tenantId, runId: activeRun.run.id };
      const active = await runtime.resolveForRun(activeScope);
      expect(active?.model).toBeUndefined();
      expect(active?.memoryApiKey).toBe(command.apiKey);
      const second = await service.saveMemoryConfiguration(context("second"), {
        ...command,
        apiKey: "integration-memory-key-b",
        expectedGeneration: await repository.generation(initial.user.id),
      });
      await expect(runtime.resolveForRun(activeScope)).resolves.toEqual(active);
      const newRun = await createFixture("memory_updated");
      expect(
        (await runtime.resolveForRun({ tenantId: newRun.scope.tenantId, runId: newRun.run.id }))
          ?.memoryApiKey,
      ).toBe("integration-memory-key-b");
      const { apiKey: _apiKey, ...reuse } = command;
      const reused = await service.saveMemoryConfiguration(context("reuse"), {
        ...reuse,
        enabled: false,
        reuseCredentialFromRevision: second.revision,
        expectedGeneration: await repository.generation(initial.user.id),
      });
      expect(reused.configuration.enabled).toBe(false);
      expect(
        await repository.resolveMemoryCredential(initial.user.id, "mem0", reused.revision),
      ).toBe("integration-memory-key-b");
      await expect(
        adminControlPool.query("SELECT * FROM run_runtime_config_snapshots"),
      ).rejects.toMatchObject({ code: "42501" });
      const foreign = await withTenantTransaction(runtimePool, initial.scope, (client) =>
        client.query("SELECT run_id FROM run_runtime_config_snapshots WHERE run_id=$1", [
          activeRun.run.id,
        ]),
      );
      expect(foreign.rows).toHaveLength(0);
    } finally {
      await migratorPool.query(`DELETE FROM run_runtime_config_snapshots;
        DELETE FROM admin_control_audits; DELETE FROM admin_control_commands;
        DELETE FROM admin_control_activation_events; DELETE FROM admin_control_active_configs;
        DELETE FROM admin_control_provider_probes; DELETE FROM admin_control_config_revisions;
        DELETE FROM platform_control_operators;
        UPDATE admin_control_generation SET generation=0,updated_at=clock_timestamp() WHERE singleton='global'`);
    }
  });

  it("模型保存可直接启用并由新 Run 固化，旧 Run 在切换后保持不变", async () => {
    const firstRun = await createFixture("control_first");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [firstRun.user.id],
    );
    try {
      const credentialCipher = new ModelProviderCredentialCipher(
        "integration-model-credential-root-at-least-32-bytes",
      );
      const repository = new PgAdminControlRepository(adminControlPool, credentialCipher);
      const service = new AdminControlService(
        repository,
        repository,
        { probeModel: async () => undefined, probeMemory: async () => undefined },
        [],
      );
      const context = (suffix: string) => ({
        actorUserId: firstRun.user.id,
        idempotencyKey: `control-${suffix}-0001`,
        requestDigest: "a".repeat(64),
      });
      const memoryDraft = await service.createMemoryDraft(context("create-memory"), {
        providerKey: "memory",
        displayName: "Mem0",
        providerKind: "mem0",
        baseUrl: "https://memory.example.invalid/v1",
        apiSecretRef: "deployment:memory-api",
        scopeSecretRef: "deployment:memory-scope",
        requestTimeoutMs: 10_000,
        enabled: true,
        reason: "创建记忆配置",
      });
      await expect(
        repository.publish({
          ...context("publish-memory-without-probe"),
          kind: "memory_provider",
          objectKey: "memory",
          revision: memoryDraft.revision,
          expectedVersionToken: memoryDraft.versionToken,
          reason: "无需探测即可保存",
        }),
      ).resolves.toMatchObject({ outcome: "applied", value: { status: "active" } });
      const createModel = async (modelId: string, suffix: string) => {
        const command = {
          expectedGeneration: await repository.generation(firstRun.user.id),
          providerKey: "main",
          displayName: "主模型",
          protocol: "openai-compatible",
          baseUrl: "https://model.example.invalid/v1",
          apiKey: "integration-model-api-key",
          defaultModelId: modelId,
          models: [
            {
              id: modelId,
              name: modelId,
              enabled: true,
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
            {
              id: `${modelId}-disabled`,
              name: `${modelId} Disabled`,
              enabled: false,
              reasoning: false,
              input: ["text"],
              contextWindow: 64_000,
              maxTokens: 4_096,
            },
          ],
        } as const;
        const saved = await service.saveModelConfiguration(context(`save-${suffix}`), command);
        expect(saved.status).toBe("active");
        expect(JSON.stringify(saved)).not.toContain("integration-model-api-key");
        await expect(
          service.saveModelConfiguration(context(`save-${suffix}`), command),
        ).resolves.toEqual(saved);
        return saved;
      };
      await createModel("model-a", "a");
      const runtimeConfigurations = new PgRuntimeControlConfigurationRepository(
        runtimePool,
        credentialCipher,
      );
      const firstSnapshot = await runtimeConfigurations.resolveForRun({
        tenantId: firstRun.scope.tenantId,
        runId: firstRun.run.id,
      });
      expect(firstSnapshot?.model?.configuration.defaultModelId).toBe("model-a");
      expect(firstSnapshot?.model?.configuration.models).toHaveLength(2);
      await expect(
        adminControlPool.query("SELECT tenant_id,run_id FROM run_runtime_config_snapshots"),
      ).rejects.toMatchObject({ code: "42501" });

      await createModel("model-b", "b");
      await expect(
        runtimeConfigurations.resolveForRun({
          tenantId: firstRun.scope.tenantId,
          runId: firstRun.run.id,
        }),
      ).resolves.toEqual(firstSnapshot);
      const secondRun = await createFixture("control_second");
      const secondSnapshot = await runtimeConfigurations.resolveForRun({
        tenantId: secondRun.scope.tenantId,
        runId: secondRun.run.id,
      });
      expect(secondSnapshot?.model?.configuration.defaultModelId).toBe("model-b");
      expect(secondSnapshot?.generation).toBeGreaterThan(firstSnapshot?.generation ?? 0);
      const memoryCommand = {
        ...memoryDraft.configuration,
        enabled: false,
        expectedGeneration: await repository.generation(firstRun.user.id),
      };
      const disabledMemory = await service.saveMemoryConfiguration(
        context("disable-memory"),
        memoryCommand,
      );
      expect(disabledMemory).toMatchObject({
        status: "active",
        probeStatus: "untested",
        configuration: { enabled: false },
      });
      await expect(
        service.saveMemoryConfiguration(context("disable-memory"), memoryCommand),
      ).resolves.toEqual(disabledMemory);
      const unchangedGeneration = await repository.generation(firstRun.user.id);
      await service.saveMemoryConfiguration(context("save-unchanged-memory"), {
        ...memoryCommand,
        expectedGeneration: unchangedGeneration,
      });
      expect(await repository.generation(firstRun.user.id)).toBe(unchangedGeneration);

      if (secondSnapshot?.model === undefined) throw new Error("第二个运行快照未保存");
      const { credentialConfigured: _credentialConfigured, ...configuration } =
        secondSnapshot.model.configuration;
      const concurrentCommand = {
        ...configuration,
        reuseCredentialFromRevision: secondSnapshot.model.revision,
        expectedGeneration: unchangedGeneration,
      };
      const before = await repository.listModelProviders(firstRun.user.id);
      const outcomes = await Promise.allSettled([
        service.saveModelConfiguration(context("concurrent-a"), {
          ...concurrentCommand,
          displayName: "并发修改甲",
        }),
        service.saveModelConfiguration(context("concurrent-b"), {
          ...concurrentCommand,
          displayName: "并发修改乙",
        }),
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "CONFLICT" },
      });
      expect(await repository.listModelProviders(firstRun.user.id)).toHaveLength(before.length + 1);
      await expect(
        runtimeConfigurations.resolveForRun({
          tenantId: firstRun.scope.tenantId,
          runId: firstRun.run.id,
        }),
      ).resolves.toEqual(firstSnapshot);
    } finally {
      await migratorPool.query(
        `DELETE FROM run_runtime_config_snapshots;
         DELETE FROM admin_control_audits;
         DELETE FROM admin_control_commands;
         DELETE FROM admin_control_activation_events;
         DELETE FROM admin_control_active_configs;
         DELETE FROM admin_control_provider_probes;
         DELETE FROM admin_control_config_revisions;
         DELETE FROM platform_control_operators;
         UPDATE admin_control_generation
            SET generation=0,updated_at=clock_timestamp() WHERE singleton='global'`,
      );
    }
  });

  it("真实 PostgreSQL 读取历史异常 Provider 标识时完成脱敏而不是返回失败", async () => {
    const fixture = await createFixture("control_historical_provider");
    const historicalProviderKey = `sk-${"a".repeat(32)}`;
    const configuration = {
      providerKey: historicalProviderKey,
      displayName: "历史测试模型",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.invalid/v1",
      secretRef: "deployment:model",
      defaultModelId: "model-history",
      models: [
        {
          id: "model-history",
          name: "Model History",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    };
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [fixture.user.id],
    );
    try {
      await migratorPool.query(
        `INSERT INTO admin_control_config_revisions(
           object_kind,object_key,revision,configuration,configuration_digest,created_by
         ) VALUES('model_provider',$1,1,$2::jsonb,$3,$4)`,
        [historicalProviderKey, JSON.stringify(configuration), "f".repeat(64), fixture.user.id],
      );
      await migratorPool.query(
        `INSERT INTO admin_control_active_configs(
           object_kind,object_key,revision,generation,activated_by,reason
         ) VALUES('model_provider',$1,1,1,$2,'历史测试配置')`,
        [historicalProviderKey, fixture.user.id],
      );
      await migratorPool.query(
        `UPDATE admin_control_generation
            SET generation=1,updated_at=clock_timestamp() WHERE singleton='global'`,
      );
      const credentialCipher = new ModelProviderCredentialCipher(
        "integration-model-credential-root-at-least-32-bytes",
      );
      const repository = new PgAdminControlRepository(adminControlPool, credentialCipher);
      const runtimeConfigurations = new PgRuntimeControlConfigurationRepository(
        runtimePool,
        credentialCipher,
        "integration-legacy-model-api-key",
      );
      const service = new AdminControlService(
        repository,
        repository,
        { probeModel: async () => undefined, probeMemory: async () => undefined },
        [],
      );

      const [models, overview] = await Promise.all([
        service.listModelProviders(fixture.user.id),
        service.overview(fixture.user.id),
      ]);
      expect(models[0]?.configuration.providerKey).toBe("sensitive-identifier-redacted");
      expect(overview.activeModel?.configuration.providerKey).toBe("sensitive-identifier-redacted");
      expect(JSON.stringify({ models, overview })).not.toContain(historicalProviderKey);
      const runtimeSnapshot = await runtimeConfigurations.resolveForRun({
        tenantId: fixture.scope.tenantId,
        runId: fixture.run.id,
      });
      expect(runtimeSnapshot?.model?.configuration.providerKey).toBe(historicalProviderKey);
      expect(runtimeSnapshot?.model?.configuration.defaultModelId).toBe("model-history");
    } finally {
      await migratorPool.query(
        `DELETE FROM run_runtime_config_snapshots;
         DELETE FROM admin_control_active_configs;
         DELETE FROM admin_control_config_revisions;
         DELETE FROM platform_control_operators;
         UPDATE admin_control_generation
            SET generation=0,updated_at=clock_timestamp() WHERE singleton='global'`,
      );
    }
  });

  it("HTTP API 经真实 PostgreSQL RLS 隔离 Thread/Run 并完成取消", async () => {
    const left = await createFixture("api_left");
    const right = await createFixture("api_right");
    const principals = new Map([
      ["Bearer pg-left", left.scope],
      ["Bearer pg-right", right.scope],
    ]);
    const app = createApiApp(
      {
        auth: {
          resolve: async ({ authorization }) =>
            authorization === undefined ? undefined : principals.get(authorization),
        },
        repositories,
        archiveThread: new PgArchiveThreadCommand(runtimePool),
        renamePersonalThread: new PgRenamePersonalThreadCommand(runtimePool),
        cursorCodec: createThreadCursorCodec({
          activeKid: "integration-key",
          keys: [
            {
              kid: "integration-key",
              secret: Buffer.alloc(32, 11).toString("base64url"),
            },
          ],
          clock: { now: () => timestamp(20) },
          ttlMilliseconds: 60_000,
          maximumTtlMilliseconds: 60_000,
        }),
        readiness: { probe: () => runtimePool.query("SELECT 1").then(() => undefined) },
        clock: { now: () => timestamp(20) },
        ids: {
          thread: () => threadId("thread_api_unused"),
          run: () => runId("run_api_unused"),
          workspace: () => workspaceId("workspace_api_unused"),
        },
      },
      { logger: false },
    );
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      const ownThread = await app.inject({
        method: "GET",
        url: `/v1/threads/${left.thread.id}`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(ownThread.statusCode).toBe(200);
      expect(ownThread.json().data.id).toBe(left.thread.id);
      const page = await app.inject({
        method: "GET",
        url: "/v1/threads?limit=10",
        headers: { authorization: "Bearer pg-left" },
      });
      expect(page.json().data.items.map((item: { id: string }) => item.id)).toEqual([
        left.thread.id,
      ]);
      const laterRun = createRun({
        id: runId("run_api_left_later"),
        thread: left.thread,
        now: timestamp(4),
      });
      expect(await repositories.runs.create(left.scope, laterRun)).toEqual({
        outcome: "created",
        version: 0n,
      });
      const latestRun = await app.inject({
        method: "GET",
        url: `/v1/threads/${left.thread.id}/runs?limit=1`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(latestRun.statusCode).toBe(200);
      expect(latestRun.json().data.items.map((item: { id: string }) => item.id)).toEqual([
        laterRun.id,
      ]);
      const crossTenant = await app.inject({
        method: "GET",
        url: `/v1/threads/${left.thread.id}/runs/${left.run.id}`,
        headers: {
          authorization: "Bearer pg-right",
          "x-tenant-id": left.scope.tenantId,
        },
      });
      expect(crossTenant.statusCode).toBe(404);
      expect(crossTenant.json().error.code).toBe("NOT_FOUND");
      const crossTenantLatest = await app.inject({
        method: "GET",
        url: `/v1/threads/${left.thread.id}/runs?limit=1`,
        headers: { authorization: "Bearer pg-right" },
      });
      expect(crossTenantLatest.statusCode).toBe(404);

      const cancelled = await app.inject({
        method: "DELETE",
        url: `/v1/threads/${left.thread.id}/runs/${left.run.id}`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().data.status).toBe("cancelled");
      const archived = await app.inject({
        method: "DELETE",
        url: `/v1/threads/${left.thread.id}`,
        headers: { authorization: "Bearer pg-left" },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().data.status).toBe("archived");
    } finally {
      await app.close();
    }
  });

  it("归档命令等待 Membership 行锁，并在降权提交后拒绝归档", async () => {
    const fixture = await createFixture("archive_membership_race");
    const command = new PgArchiveThreadCommand(runtimePool);
    const blocker = await administrativePool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT role FROM "${schema}".memberships
          WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [fixture.scope.tenantId, fixture.scope.userId],
      );
      const pending = command.archiveThread({
        scope: fixture.scope,
        threadId: fixture.thread.id,
      });
      // 先持有 Membership 锁，再提交降权，确保命令必须读取锁后的授权事实。
      await blocker.query(
        `UPDATE "${schema}".memberships SET role = 'member'
          WHERE tenant_id = $1 AND user_id = $2`,
        [fixture.scope.tenantId, fixture.scope.userId],
      );
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ outcome: "not_authorized" });
      const stored = await withTenantTransaction(runtimePool, fixture.scope, (client) =>
        client.query<{ status: string }>(
          "SELECT status FROM threads WHERE tenant_id = $1 AND id = $2",
          [fixture.scope.tenantId, fixture.thread.id],
        ),
      );
      expect(stored.rows[0]?.status).toBe("active");
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
  });

  it("Runtime 不能修改 Membership 的 status、role 或其他授权字段", async () => {
    const fixture = await createFixture("membership_acl");
    for (const statement of [
      "UPDATE memberships SET status = 'revoked' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET role = 'member' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET id = id || '_changed' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET user_id = user_id || '_changed' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET tenant_id = tenant_id || '_changed' WHERE tenant_id = $1 AND user_id = $2",
      "UPDATE memberships SET created_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2",
    ]) {
      await expect(
        withTenantTransaction(runtimePool, fixture.scope, (client) =>
          client.query(statement, [fixture.scope.tenantId, fixture.scope.userId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("Team Coordinator 只在独立连接中更新 Membership 授权列", async () => {
    const fixture = await createFixture("team_coordinator_membership_acl");
    await expect(
      withTenantTransaction(teamCoordinatorPool, fixture.scope, (client) =>
        client.query(
          "UPDATE memberships SET role=role,status=status WHERE tenant_id=$1 AND user_id=$2",
          [fixture.scope.tenantId, fixture.scope.userId],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      withTenantTransaction(teamCoordinatorPool, fixture.scope, (client) =>
        client.query(
          "UPDATE memberships SET created_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2",
          [fixture.scope.tenantId, fixture.scope.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("归档等待 Thread 锁后使用数据库时间，并保持 updated_at 单调", async () => {
    const fixture = await createFixture("archive_database_time");
    const command = new PgArchiveThreadCommand(runtimePool);
    const blocker = await administrativePool.connect();
    let pendingSettled = false;
    try {
      await blocker.query(
        `UPDATE "${schema}".threads
            SET updated_at = clock_timestamp() - interval '1 day'
          WHERE tenant_id = $1 AND id = $2`,
        [fixture.scope.tenantId, fixture.thread.id],
      );
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT status FROM "${schema}".threads
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [fixture.scope.tenantId, fixture.thread.id],
      );
      const pending = command
        .archiveThread({ scope: fixture.scope, threadId: fixture.thread.id })
        .finally(() => {
          pendingSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(pendingSettled).toBe(false);
      const lowerBound = await blocker.query<{ current_time: Date }>(
        "SELECT clock_timestamp() AS current_time",
      );
      await blocker.query("COMMIT");
      const result = await pending;
      expect(result.outcome).toBe("archived");
      const stored = await withTenantTransaction(runtimePool, fixture.scope, (client) =>
        client.query<{ status: string; updated_at: Date }>(
          "SELECT status, updated_at FROM threads WHERE tenant_id = $1 AND id = $2",
          [fixture.scope.tenantId, fixture.thread.id],
        ),
      );
      const updatedAt = stored.rows[0]?.updated_at;
      const releasedAt = lowerBound.rows[0]?.current_time;
      if (updatedAt === undefined || releasedAt === undefined)
        throw new Error("测试数据库时间缺失");
      expect(stored.rows[0]?.status).toBe("archived");
      expect(updatedAt.valueOf()).toBeGreaterThanOrEqual(releasedAt.valueOf());
      if (result.outcome === "archived")
        expect(result.entity.updatedAt).toBe(updatedAt.toISOString());
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
  });

  it("同一 Membership 的共享锁不阻塞另一 Thread 归档", async () => {
    const fixture = await createFixture("archive_share_lock");
    const secondThread = createThread({
      id: threadId("thread_archive_share_second"),
      tenant: fixture.tenant,
      user: fixture.user,
      membership: fixture.membership,
      title: "共享成员锁的第二个任务",
      now: timestamp(5),
    });
    expect(await repositories.threads.create(fixture.scope, secondThread)).toEqual({
      outcome: "created",
      version: 0n,
    });
    const command = new PgArchiveThreadCommand(runtimePool);
    const blocker = await administrativePool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT status FROM "${schema}".threads
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [fixture.scope.tenantId, fixture.thread.id],
      );
      const first = command.archiveThread({
        scope: fixture.scope,
        threadId: fixture.thread.id,
      });
      let waitingOnThread = false;
      for (let attempt = 0; attempt < 50 && !waitingOnThread; attempt += 1) {
        const activity = await administrativePool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%FROM threads%'
           ) AS waiting`,
        );
        waitingOnThread = activity.rows[0]?.waiting === true;
        if (!waitingOnThread) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingOnThread).toBe(true);

      const second = command.archiveThread({ scope: fixture.scope, threadId: secondThread.id });
      const raced = await Promise.race([
        second.then(() => "completed" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      await blocker.query("COMMIT");
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(raced).toBe("completed");
      expect(firstResult.outcome).toBe("archived");
      expect(secondResult.outcome).toBe("archived");
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
      }
    }
  });

  it("并发迁移串行化且 D1 与 A1 均落入受限 Schema", async () => {
    expect(concurrentMigrationVersions).toEqual([
      ...migrationContract.versions,
      ...migrationContract.versions,
    ]);
    const applied = await migratorPool.query<{ version: number; name: string }>(
      "SELECT version,name FROM runtime_schema_migrations WHERE version IN (3,4) ORDER BY version",
    );
    expect(applied.rows).toEqual([
      { version: 3, name: "admin_run_explorer" },
      { version: 4, name: "agent_definitions" },
    ]);
    expect(await migrateUp(migratorPool, migrationSecurity)).toHaveLength(migrationContract.count);
  });

  it("外部工具密文仅允许 Admin Control 写入，Runtime 零权限", async () => {
    const rows = await migratorPool.query<{
      readonly table_name: string;
      readonly runtime_select: boolean;
      readonly runtime_insert: boolean;
      readonly control_select: boolean;
      readonly control_insert: boolean;
    }>(
      `SELECT table_name,
              has_table_privilege($1,format('%I.%I',$3::text,table_name),'SELECT') AS runtime_select,
              has_table_privilege($1,format('%I.%I',$3::text,table_name),'INSERT') AS runtime_insert,
              has_table_privilege($2,format('%I.%I',$3::text,table_name),'SELECT') AS control_select,
              has_table_privilege($2,format('%I.%I',$3::text,table_name),'INSERT') AS control_insert
         FROM unnest(ARRAY['external_tool_versions','external_tool_credentials','external_tool_revocations']::text[]) AS target(table_name)
        ORDER BY table_name`,
      [runtimeRole, adminControlRole, schema],
    );
    expect(rows.rows).toEqual([
      {
        table_name: "external_tool_credentials",
        runtime_select: false,
        runtime_insert: false,
        control_select: false,
        control_insert: true,
      },
      {
        table_name: "external_tool_revocations",
        runtime_select: false,
        runtime_insert: false,
        control_select: true,
        control_insert: true,
      },
      {
        table_name: "external_tool_versions",
        runtime_select: false,
        runtime_insert: false,
        control_select: true,
        control_insert: true,
      },
    ]);
  });

  it("checksum 同时绑定 down SQL，并拒绝孤立和重复版本", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hoox-pg-migration-"));
    const orphan = await mkdtemp(join(tmpdir(), "hoox-pg-orphan-"));
    try {
      await Promise.all([
        copyFile(
          join(sourceMigrationDirectory, "0001_baseline.up.sql"),
          join(temporary, "0001_baseline.up.sql"),
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_baseline.down.sql"),
          join(temporary, "0001_baseline.down.sql"),
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_baseline.up.sql"),
          join(orphan, "0001_baseline.up.sql"),
        ),
      ]);
      await writeFile(
        join(temporary, "0001_baseline.down.sql"),
        "SELECT 'down 已被篡改';\n",
        "utf8",
      );
      await expect(
        migrateUp(migratorPool, { ...migrationSecurity, directory: temporary }),
      ).rejects.toMatchObject({
        code: "MIGRATION_MISMATCH",
      });
      await expect(loadMigrations({ directory: orphan })).rejects.toThrow("未成对");
      await Promise.all([
        copyFile(
          join(sourceMigrationDirectory, "0001_baseline.up.sql"),
          join(orphan, "0001_other.up.sql"),
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_baseline.down.sql"),
          join(orphan, "0001_other.down.sql"),
        ),
      ]);
      await expect(loadMigrations({ directory: orphan })).rejects.toThrow("版本 1 重复");
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(orphan, { recursive: true, force: true });
    }
  });

  it("down 的 DDL 与 ACL 收敛失败时整体回滚", async () => {
    await administrativePool.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${runtimeRole}"`,
    );
    try {
      await expect(
        migrateDown(migratorPool, {
          allowDestructive: true,
          environment: "test",
          ...migrationSecurity,
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const state = await migratorPool.query<{ threads: string | null; migration_count: string }>(
        `SELECT to_regclass('threads')::text AS threads,
                (SELECT count(*)::text FROM runtime_schema_migrations) AS migration_count`,
      );
      expect(state.rows[0]).toMatchObject({
        threads: "threads",
        migration_count: String(migrationContract.count),
      });
    } finally {
      await administrativePool.query(
        `GRANT CONNECT ON DATABASE "${databaseName}" TO "${runtimeRole}"`,
      );
    }
  });

  it("down 只有显式 test 授权可执行并能再次向前", async () => {
    await expect(
      migrateDown(migratorPool, {
        allowDestructive: false as true,
        environment: "test",
        ...migrationSecurity,
      }),
    ).rejects.toThrow("禁止破坏性");
    expect(
      await migrateDown(migratorPool, {
        allowDestructive: true,
        environment: "test",
        ...migrationSecurity,
      }),
    ).toEqual([]);
    const usageAfterDown = await migratorPool.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege($1, current_schema(), 'USAGE') AS allowed",
      [runtimeRole],
    );
    expect(usageAfterDown.rows[0]?.allowed).toBe(false);
    const downPrivileges = await migratorPool.query<{ privilege: string; allowed: boolean }>(
      `SELECT requested.privilege,
              has_table_privilege($1, 'runtime_schema_migrations', requested.privilege) AS allowed
         FROM unnest($2::text[]) AS requested(privilege)`,
      [runtimeRole, ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]],
    );
    expect(downPrivileges.rows.every((entry) => !entry.allowed)).toBe(true);
    const routineState = await migratorPool.query<{
      routine_count: string;
      default_acl_count: string;
    }>(
      `SELECT (SELECT count(*)::text FROM pg_proc
                WHERE pronamespace = current_schema()::regnamespace) AS routine_count,
              (SELECT count(*)::text
                 FROM pg_default_acl defaults
                WHERE defaults.defaclrole = $1::regrole
                  AND defaults.defaclobjtype = 'f') AS default_acl_count`,
      [migratorRole],
    );
    expect(routineState.rows[0]).toEqual({ routine_count: "0", default_acl_count: "0" });
    expect(await migrateUp(migratorPool, migrationSecurity)).toHaveLength(migrationContract.count);
  });

  it("Runtime 角色不安全时在任何迁移 DDL 之前失败", async () => {
    const unsafeParentRole = `it_unsafe_parent_${process.pid}`;
    const unsafeChildRole = `it_unsafe_child_${process.pid}`;
    const unsafeTableOwnerRole = `it_unsafe_table_${process.pid}`;
    const unsafeSchemaOwnerRole = `it_unsafe_schema_${process.pid}`;
    await administrativePool.query(
      `CREATE ROLE "${unsafeParentRole}" NOLOGIN CREATEDB;
       CREATE ROLE "${unsafeChildRole}" NOLOGIN NOINHERIT;
       CREATE ROLE "${unsafeTableOwnerRole}" NOLOGIN;
       CREATE ROLE "${unsafeSchemaOwnerRole}" NOLOGIN;
       GRANT "${unsafeParentRole}" TO "${unsafeChildRole}"`,
    );
    try {
      const cases = [
        { suffix: "inherited", role: unsafeChildRole },
        { suffix: "database_owner", role: databaseOwnerRole },
        { suffix: "table_owner", role: unsafeTableOwnerRole },
      ] as const;
      for (const unsafe of cases) {
        const target = await createIsolatedMigrationTarget(unsafe.suffix);
        if (unsafe.suffix === "table_owner") {
          await administrativePool.query(
            `CREATE TABLE "${target.context.schema}".owned_seed(id integer);
             ALTER TABLE "${target.context.schema}".owned_seed OWNER TO "${unsafeTableOwnerRole}"`,
          );
        }
        try {
          await expect(
            migrateUp(target.pool, { ...target.context, runtimeRole: unsafe.role }),
          ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
          const migrationTable = await target.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          );
          expect(migrationTable.rows[0]?.name).toBeNull();
          if (unsafe.suffix === "inherited") {
            await expect(
              migrateDown(target.pool, {
                allowDestructive: true,
                environment: "test",
                ...target.context,
                runtimeRole: unsafe.role,
              }),
            ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
            expect(
              (
                await target.pool.query<{ name: string | null }>(
                  "SELECT to_regclass('runtime_schema_migrations')::text AS name",
                )
              ).rows[0]?.name,
            ).toBeNull();
          }
        } finally {
          await target.close();
        }
      }

      const ownerTarget = await createIsolatedMigrationTarget("schema_owner");
      const ownedSchema = `${ownerTarget.context.schema}_owned`;
      try {
        await administrativePool.query(
          `CREATE SCHEMA "${ownedSchema}" AUTHORIZATION "${unsafeSchemaOwnerRole}"`,
        );
        await expect(
          migrateUp(ownerTarget.pool, {
            ...ownerTarget.context,
            runtimeRole: unsafeSchemaOwnerRole,
          }),
        ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
        expect(
          (
            await ownerTarget.pool.query<{ name: string | null }>(
              "SELECT to_regclass('runtime_schema_migrations')::text AS name",
            )
          ).rows[0]?.name,
        ).toBeNull();
      } finally {
        try {
          await administrativePool.query(`DROP SCHEMA IF EXISTS "${ownedSchema}"`);
        } finally {
          await ownerTarget.close();
        }
      }
    } finally {
      await administrativePool.query(
        `REVOKE "${unsafeParentRole}" FROM "${unsafeChildRole}";
         DROP ROLE "${unsafeChildRole}";
         DROP ROLE "${unsafeParentRole}";
         DROP ROLE "${unsafeTableOwnerRole}";
         DROP ROLE "${unsafeSchemaOwnerRole}"`,
      );
    }
  });

  it("up/down 在 Runtime 有 Schema CREATE 或数据库 TEMP 时不产生任何 DDL", async () => {
    const upTarget = await createIsolatedMigrationTarget("runtime_schema_create");
    try {
      await administrativePool.query(
        `GRANT CREATE ON SCHEMA "${upTarget.context.schema}" TO PUBLIC`,
      );
      await expect(migrateUp(upTarget.pool, upTarget.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const upObjects = await upTarget.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
          WHERE relnamespace = current_schema()::regnamespace
            AND relname IN ('runtime_schema_migrations', 'threads', 'runs', 'workspaces')`,
      );
      expect(upObjects.rows[0]?.count).toBe("0");
    } finally {
      await administrativePool.query(
        `REVOKE CREATE ON SCHEMA "${upTarget.context.schema}" FROM PUBLIC`,
      );
      await upTarget.close();
    }

    const downTarget = await createIsolatedMigrationTarget("runtime_database_temp");
    await administrativePool.query(
      `GRANT TEMPORARY ON DATABASE "${databaseName}" TO "${runtimeRole}"`,
    );
    try {
      await expect(
        migrateDown(downTarget.pool, {
          ...downTarget.context,
          allowDestructive: true,
          environment: "test",
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const downObjects = await downTarget.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
          WHERE relnamespace = current_schema()::regnamespace
            AND relname IN ('runtime_schema_migrations', 'threads', 'runs', 'workspaces')`,
      );
      expect(downObjects.rows[0]?.count).toBe("0");
    } finally {
      await administrativePool.query(
        `REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM "${runtimeRole}"`,
      );
      await downTarget.close();
    }
  });

  it("首次 up 的 ACL 白名单失败时回滚全部业务 DDL", async () => {
    const target = await createIsolatedMigrationTarget("atomic_up");
    try {
      await target.pool.query("CREATE TABLE unexpected_seed(id integer)");
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const objects = await target.pool.query<{
        migration_table: string | null;
        business_table: string | null;
        seed_table: string | null;
      }>(
        `SELECT to_regclass('runtime_schema_migrations')::text AS migration_table,
                to_regclass('threads')::text AS business_table,
                to_regclass('unexpected_seed')::text AS seed_table`,
      );
      expect(objects.rows[0]).toEqual({
        migration_table: null,
        business_table: null,
        seed_table: "unexpected_seed",
      });
    } finally {
      await target.close();
    }
  });

  it("migration SQL 创建 routine 时整次 up 回滚", async () => {
    const target = await createIsolatedMigrationTarget("migration_routine");
    const temporary = await mkdtemp(join(tmpdir(), "hoox-pg-routine-migration-"));
    try {
      const originalUp = await readFile(
        join(sourceMigrationDirectory, "0001_baseline.up.sql"),
        "utf8",
      );
      await Promise.all([
        writeFile(
          join(temporary, "0001_baseline.up.sql"),
          `${originalUp}\nCREATE FUNCTION forbidden_migration() RETURNS integer LANGUAGE sql AS 'SELECT 1';\n`,
          "utf8",
        ),
        copyFile(
          join(sourceMigrationDirectory, "0001_baseline.down.sql"),
          join(temporary, "0001_baseline.down.sql"),
        ),
      ]);
      await expect(
        migrateUp(target.pool, { ...target.context, directory: temporary }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const objects = await target.pool.query<{
        migration_table: string | null;
        business_table: string | null;
        routine: string | null;
      }>(
        `SELECT to_regclass('runtime_schema_migrations')::text AS migration_table,
                to_regclass('threads')::text AS business_table,
                to_regprocedure('forbidden_migration()')::text AS routine`,
      );
      expect(objects.rows[0]).toEqual({
        migration_table: null,
        business_table: null,
        routine: null,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await target.close();
    }
  });

  it("Migrator 不得拥有目标以外 Schema 或跨 Schema 对象", async () => {
    const target = await createIsolatedMigrationTarget("migrator_ownership");
    const extraSchema = `${target.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${target.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await administrativePool.query(
        `ALTER SCHEMA "${extraSchema}" OWNER TO "${databaseOwnerRole}";
         CREATE TABLE "${extraSchema}".foreign_owned(id integer);
         ALTER TABLE "${extraSchema}".foreign_owned OWNER TO "${target.context.migratorRole}"`,
      );
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const migrationTable = await target.pool.query<{ name: string | null }>(
        "SELECT to_regclass('runtime_schema_migrations')::text AS name",
      );
      expect(migrationTable.rows[0]?.name).toBeNull();
    } finally {
      await administrativePool.query(`DROP SCHEMA "${extraSchema}" CASCADE`);
      await target.close();
    }
  });

  it("目标 SECURITY DEFINER 与跨 Schema routine 均在首个 DDL 前拒绝", async () => {
    const targetRoutine = await createIsolatedMigrationTarget("target_routine");
    try {
      await targetRoutine.pool.query(
        `CREATE FUNCTION forbidden_target() RETURNS integer
           LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
      );
      await expect(migrateUp(targetRoutine.pool, targetRoutine.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const targetObjects = await targetRoutine.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
          WHERE relnamespace = current_schema()::regnamespace
            AND relname IN ('runtime_schema_migrations', 'threads', 'runs')`,
      );
      expect(targetObjects.rows[0]?.count).toBe("0");
    } finally {
      await targetRoutine.close();
    }

    const crossRoutine = await createIsolatedMigrationTarget("cross_routine");
    const extraSchema = `${crossRoutine.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${databaseOwnerRole}";
       CREATE FUNCTION "${extraSchema}".forbidden_cross() RETURNS integer
         LANGUAGE sql AS 'SELECT 1';
       ALTER FUNCTION "${extraSchema}".forbidden_cross()
         OWNER TO "${crossRoutine.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(crossRoutine.pool, crossRoutine.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await crossRoutine.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await administrativePool.query(`DROP SCHEMA "${extraSchema}" CASCADE`);
      await crossRoutine.close();
    }
  });

  it("目标与跨 Schema 的 Migrator-owned 独立 type 均在首个 DDL 前拒绝", async () => {
    const targetType = await createIsolatedMigrationTarget("target_type");
    try {
      await targetType.pool.query("CREATE TYPE forbidden_target_type AS ENUM ('blocked')");
      await expect(migrateUp(targetType.pool, targetType.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await targetType.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await targetType.close();
    }

    const crossType = await createIsolatedMigrationTarget("cross_type");
    const extraSchema = `${crossType.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${databaseOwnerRole}";
       CREATE TYPE "${extraSchema}".forbidden_cross_type AS ENUM ('blocked');
       ALTER TYPE "${extraSchema}".forbidden_cross_type
         OWNER TO "${crossType.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(crossType.pool, crossType.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await crossType.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await administrativePool.query(`DROP SCHEMA "${extraSchema}" CASCADE`);
      await crossType.close();
    }
  });

  it("任意 routine 默认 ACL 记录都在首个 DDL 前拒绝", async () => {
    const localTarget = await createIsolatedMigrationTarget("local_default_acl");
    try {
      await localTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${localTarget.context.schema}"
           GRANT EXECUTE ON ROUTINES TO PUBLIC, "${runtimeRole}"`,
      );
      await expect(migrateUp(localTarget.pool, localTarget.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await localTarget.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await localTarget.close();
    }

    const thirdPartyRole = `it_acl_grantee_${process.pid}`;
    const thirdPartyTarget = await createIsolatedMigrationTarget("third_default_acl");
    await administrativePool.query(`CREATE ROLE "${thirdPartyRole}" NOLOGIN`);
    try {
      await thirdPartyTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${thirdPartyTarget.context.schema}"
           GRANT EXECUTE ON ROUTINES TO "${thirdPartyRole}"`,
      );
      await expect(
        migrateUp(thirdPartyTarget.pool, thirdPartyTarget.context),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    } finally {
      await thirdPartyTarget.close();
      await administrativePool.query(`DROP ROLE "${thirdPartyRole}"`);
    }

    const globalTarget = await createIsolatedMigrationTarget("global_default_acl");
    try {
      await globalTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${globalTarget.context.migratorRole}"
           REVOKE EXECUTE ON ROUTINES FROM PUBLIC`,
      );
      await expect(migrateUp(globalTarget.pool, globalTarget.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
    } finally {
      await globalTarget.pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${globalTarget.context.migratorRole}"
           GRANT EXECUTE ON ROUTINES TO PUBLIC`,
      );
      await globalTarget.close();
    }
  });

  it("Migrator 对无关 Schema 的有效 CREATE 在首个 DDL 前拒绝", async () => {
    const target = await createIsolatedMigrationTarget("foreign_schema_create");
    const extraSchema = `${target.context.schema}_extra`;
    await administrativePool.query(
      `CREATE SCHEMA "${extraSchema}" AUTHORIZATION "${databaseOwnerRole}";
       GRANT CREATE ON SCHEMA "${extraSchema}" TO "${target.context.migratorRole}"`,
    );
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      expect(
        (
          await target.pool.query<{ name: string | null }>(
            "SELECT to_regclass('runtime_schema_migrations')::text AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await administrativePool.query(
        `REVOKE CREATE ON SCHEMA "${extraSchema}" FROM "${target.context.migratorRole}";
         DROP SCHEMA "${extraSchema}" CASCADE`,
      );
      await target.close();
    }
  });

  it("Migrator 或 search_path 不安全时在任何迁移 DDL 之前失败", async () => {
    const parentRole = `it_migrator_parent_${process.pid}`;
    const target = await createIsolatedMigrationTarget("migrator_guard");
    await administrativePool.query(
      `CREATE ROLE "${parentRole}" NOLOGIN;
       GRANT "${parentRole}" TO "${target.context.migratorRole}"`,
    );
    const wrongSearchPathPool = createPostgresPool({
      connectionString: target.connectionString,
      maxConnections: 2,
    });
    const databaseOwnerPool = createPostgresPool({
      connectionString: bootstrapDatabaseUrl,
      schema: target.context.schema,
      maxConnections: 2,
    });
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await administrativePool.query(
        `REVOKE "${parentRole}" FROM "${target.context.migratorRole}"`,
      );
      await expect(migrateUp(wrongSearchPathPool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await administrativePool.query(
        `ALTER SCHEMA "${target.context.schema}" OWNER TO "${databaseOwnerRole}"`,
      );
      await expect(migrateUp(target.pool, target.context)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      await expect(
        migrateUp(databaseOwnerPool, {
          runtimeRole,
          migratorRole: databaseOwnerRole,
          skillPublisherRole: target.context.skillPublisherRole,
          workerCoordinatorRole: target.context.workerCoordinatorRole,
          teamCoordinatorRole: target.context.teamCoordinatorRole,
          adminControlRole: target.context.adminControlRole,
          schema: target.context.schema,
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const migrationTable = await administrativePool.query<{ name: string | null }>(
        "SELECT to_regclass(format('%I.runtime_schema_migrations', $1::text))::text AS name",
        [target.context.schema],
      );
      expect(migrationTable.rows[0]?.name).toBeNull();
    } finally {
      await wrongSearchPathPool.end();
      await databaseOwnerPool.end();
      await administrativePool.query(
        `REVOKE "${parentRole}" FROM "${target.context.migratorRole}";
         DROP ROLE "${parentRole}"`,
      );
      await target.close();
    }
  });

  it("bootstrap 先拒绝上游角色，再清除 PUBLIC 残留授权", async () => {
    const parentRole = `it_runtime_parent_${process.pid}`;
    await administrativePool.query(`CREATE ROLE "${parentRole}" NOLOGIN`);
    await migratorPool.query(
      `GRANT ALL PRIVILEGES ON SCHEMA "${schema}" TO PUBLIC;
       GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schema}" TO PUBLIC;
       GRANT ALL PRIVILEGES ON TABLE "${schema}".threads TO "${parentRole}"`,
    );
    await administrativePool.query(`GRANT "${parentRole}" TO "${runtimeRole}"`);
    try {
      await expect(bootstrapRuntimeAccess(migratorPool, migrationSecurity)).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
      });
      const publicBefore = await migratorPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(relation.relacl) acl
          WHERE relation.relnamespace = current_schema()::regnamespace
            AND relation.relkind IN ('r', 'p') AND acl.grantee = 0`,
      );
      // 若 preflight 之后才检查成员关系，这里的 PUBLIC 攻击性授权会已被错误修改。
      expect(Number(publicBefore.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await administrativePool.query(`REVOKE "${parentRole}" FROM "${runtimeRole}"`);
      await migratorPool.query(
        `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schema}" FROM "${parentRole}"`,
      );
      await administrativePool.query(`DROP ROLE "${parentRole}"`);
    }
    await bootstrapRuntimeAccess(migratorPool, migrationSecurity);
    const publicAfter = await migratorPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_class relation
         CROSS JOIN LATERAL aclexplode(
           COALESCE(relation.relacl, acldefault('r'::"char", relation.relowner))
         ) acl
        WHERE relation.relnamespace = current_schema()::regnamespace
          AND relation.relkind IN ('r', 'p') AND acl.grantee = 0`,
    );
    expect(publicAfter.rows[0]?.count).toBe("0");
  });

  it("空 routine manifest 令 Runtime 与 PUBLIC 的 EXECUTE 集合自然为空", async () => {
    const privileges = await migratorPool.query<{
      routine_count: string;
      runtime_execute_count: string;
      public_execute_count: string;
    }>(
      `SELECT count(*)::text AS routine_count,
              count(*) FILTER (
                WHERE has_function_privilege($1, routine.oid, 'EXECUTE')
              )::text AS runtime_execute_count,
              count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM aclexplode(
                    COALESCE(routine.proacl, acldefault('f'::"char", routine.proowner))
                  ) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                )
              )::text AS public_execute_count
         FROM pg_proc routine
        WHERE routine.pronamespace = current_schema()::regnamespace`,
      [runtimeRole],
    );
    expect(privileges.rows[0]).toEqual({
      routine_count: "0",
      runtime_execute_count: "0",
      public_execute_count: "0",
    });
  });

  it("Runtime 角色不能 DDL、创建 Schema 或绕过 RLS 跨租户写", async () => {
    const roles = await administrativePool.query<{
      migrator_schema_owner: string;
      database_owner: string;
      runtime_super: boolean;
      runtime_bypass_rls: boolean;
      runtime_can_create_database: boolean;
    }>(
      `SELECT pg_get_userbyid(n.nspowner) AS migrator_schema_owner,
              pg_get_userbyid(d.datdba) AS database_owner,
              r.rolsuper AS runtime_super,
              r.rolbypassrls AS runtime_bypass_rls,
              has_database_privilege($1, current_database(), 'CREATE') AS runtime_can_create_database
         FROM pg_database d CROSS JOIN pg_roles r CROSS JOIN pg_namespace n
        WHERE d.datname = current_database() AND r.rolname = $1 AND n.nspname = $2`,
      [runtimeRole, schema],
    );
    expect(roles.rows[0]).toMatchObject({
      migrator_schema_owner: migratorRole,
      database_owner: databaseOwnerRole,
      runtime_super: false,
      runtime_bypass_rls: false,
      runtime_can_create_database: false,
    });
    expect(roles.rows[0]?.database_owner).not.toBe(migratorRole);
    expect(roles.rows[0]?.migrator_schema_owner).not.toBe(runtimeRole);
    const expectedPolicy = new Map<string, ReadonlySet<string>>([
      ["app_users", new Set(["SELECT", "INSERT"])],
      ["tenants", new Set(["SELECT", "INSERT"])],
      ["memberships", new Set(["SELECT", "INSERT"])],
      ["threads", new Set(["SELECT", "INSERT"])],
      ["agent_definitions", new Set(["SELECT"])],
      ["agent_definition_tenants", new Set(["SELECT"])],
      ["agent_revisions", new Set(["SELECT"])],
      ["agent_revision_revocations", new Set(["SELECT"])],
      ["agent_definition_commands", new Set()],
      ["agent_definition_audits", new Set()],
      ["runs", new Set(["SELECT", "INSERT", "UPDATE"])],
      ["workspaces", new Set(["SELECT", "INSERT", "UPDATE"])],
      ["workspace_revisions", new Set(["SELECT", "INSERT"])],
      ["workspace_write_leases", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
      ["blob_lifecycles", new Set(["SELECT", "INSERT"])],
      ["blob_incarnations", new Set(["SELECT", "INSERT"])],
      ["blob_allocations", new Set(["SELECT", "INSERT"])],
      ["blob_commits", new Set(["SELECT", "INSERT"])],
      ["promotion_authorizations", new Set(["SELECT", "INSERT"])],
      ["promotion_executions", new Set(["SELECT", "INSERT"])],
      ["blob_gc_claims", new Set(["SELECT", "INSERT"])],
      ["retired_blob_tombstones", new Set(["SELECT", "INSERT"])],
      ["blob_references", new Set(["SELECT", "INSERT", "DELETE"])],
      ["model_wire_trace_cleanup_commands", new Set(["SELECT", "INSERT"])],
      ["model_wire_trace_cleanup_items", new Set(["SELECT", "INSERT"])],
      ["model_wire_trace_expiry_tombstones", new Set(["SELECT", "INSERT"])],
      ["model_wire_trace_records", new Set(["SELECT", "INSERT", "DELETE"])],
      ["run_execution_inputs", new Set(["SELECT", "INSERT"])],
      ["execution_attempts", new Set(["SELECT", "INSERT"])],
      ["execution_workspace_fences", new Set(["SELECT", "INSERT"])],
      ["run_claims", new Set(["SELECT", "INSERT"])],
      ["rollout_projections", new Set(["SELECT", "INSERT"])],
      ["run_events", new Set(["SELECT", "INSERT"])],
      ["sandbox_registry", new Set(["SELECT", "INSERT"])],
      ["cleanup_outbox", new Set(["SELECT", "INSERT"])],
      ["sandbox_lifecycle_unknown", new Set(["SELECT", "INSERT"])],
      ["runtime_alert_outbox", new Set(["SELECT", "INSERT"])],
      ["effect_invocations", new Set(["SELECT", "INSERT"])],
      ["external_effect_permits", new Set(["SELECT", "INSERT"])],
      ["mutation_receipts", new Set(["SELECT", "INSERT"])],
      ["api_idempotency_records", new Set(["SELECT", "INSERT"])],
      ["api_thread_idempotency_records", new Set(["SELECT", "INSERT"])],
      ["run_dispatch_outbox", new Set(["SELECT", "INSERT"])],
      ["runtime_schema_migrations", new Set()],
    ]);
    const allPrivileges = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ];
    const privilegeMatrix = await migratorPool.query<{
      table_name: string;
      privilege: string;
      allowed: boolean;
    }>(
      `SELECT target.table_name, requested.privilege,
              has_table_privilege(
                $1, format('%I.%I', current_schema()::text, target.table_name), requested.privilege
              ) AS allowed
         FROM unnest($2::text[]) AS target(table_name)
         CROSS JOIN unnest($3::text[]) AS requested(privilege)`,
      [runtimeRole, [...expectedPolicy.keys()], allPrivileges],
    );
    expect(privilegeMatrix.rows).toHaveLength(expectedPolicy.size * allPrivileges.length);
    for (const entry of privilegeMatrix.rows) {
      expect(entry.allowed, `${entry.table_name}:${entry.privilege}`).toBe(
        expectedPolicy.get(entry.table_name)?.has(entry.privilege),
      );
    }
    const expectedColumnUpdates = new Map<string, ReadonlySet<string>>([
      [
        "threads",
        new Set([
          "title",
          "status",
          "updated_at",
          "version",
          "title_source",
          "title_generated_at",
          "title_generation_version",
        ]),
      ],
      ["memberships", new Set(["lock_marker"])],
      [
        "blob_lifecycles",
        new Set([
          "state",
          "current_incarnation_id",
          "generation",
          "current_claim_id",
          "lease_expires_at",
          "updated_at",
        ]),
      ],
      ["blob_incarnations", new Set(["state", "retired_at"])],
      ["blob_commits", new Set(["status", "version", "snapshot", "updated_at"])],
      [
        "promotion_authorizations",
        new Set(["state", "current_execution_id", "execution_generation", "updated_at"]),
      ],
      ["promotion_executions", new Set(["phase", "proof_status", "updated_at"])],
      ["blob_gc_claims", new Set(["phase", "updated_at"])],
      [
        "retired_blob_tombstones",
        new Set(["generation", "scrub_lease_expires_at", "next_scrub_at", "last_scrubbed_at"]),
      ],
      [
        "blob_references",
        new Set(["state", "lifecycle_id", "incarnation_id", "physical_object_key", "updated_at"]),
      ],
      ["run_execution_inputs", new Set(["answer_text", "updated_at"])],
      [
        "execution_attempts",
        new Set([
          "current_revision_id",
          "status",
          "stage",
          "version",
          "next_event_sequence",
          "projection_version",
          "model_execution_started",
          "updated_at",
          "finished_at",
        ]),
      ],
      ["run_claims", new Set(["expires_at", "updated_at", "released_at"])],
      [
        "rollout_projections",
        new Set(["attempt_id", "version", "projection", "digest", "updated_at"]),
      ],
      ["sandbox_registry", new Set(["state", "actual_ttl_seconds", "updated_at"])],
      [
        "cleanup_outbox",
        new Set([
          "state",
          "disposition",
          "payload",
          "payload_digest",
          "updated_at",
          "claim_token",
          "claim_generation",
          "claimed_by",
          "claim_lease_expires_at",
          "retry_at",
          "attempt_count",
          "remote_call_started_at",
        ]),
      ],
      ["external_effect_permits", new Set(["consumed_at"])],
      ["model_wire_trace_cleanup_commands", new Set(["status", "deleted_count", "completed_at"])],
      [
        "model_wire_trace_cleanup_items",
        new Set(["state", "outcome", "attempt_count", "updated_at"]),
      ],
      ["model_wire_trace_expiry_tombstones", new Set(["staging_swept_at"])],
      [
        "model_wire_trace_records",
        new Set([
          "persistence_status",
          "blob_reference_id",
          "blob_state",
          "blob_purpose",
          "blob_lifecycle_id",
          "blob_incarnation_id",
          "physical_object_key",
          "processing_token",
          "processing_lease_expires_at",
          "retention_recovery_at",
          "cleanup_command_id",
          "updated_at",
        ]),
      ],
    ]);
    const columnMatrix = await migratorPool.query<{
      table_name: string;
      column_name: string;
      allowed: boolean;
    }>(
      `SELECT column_state.table_name, column_state.column_name,
              has_column_privilege(
                $1,
                format('%I.%I', current_schema()::text, column_state.table_name),
                column_state.column_name,
                'UPDATE'
              ) AS allowed
         FROM information_schema.columns column_state
        WHERE column_state.table_schema = current_schema()
          AND column_state.table_name = ANY($2::text[])`,
      [runtimeRole, [...expectedColumnUpdates.keys()]],
    );
    for (const entry of columnMatrix.rows) {
      expect(entry.allowed, `${entry.table_name}.${entry.column_name}:UPDATE`).toBe(
        expectedColumnUpdates.get(entry.table_name)?.has(entry.column_name),
      );
    }
    const effectiveBoundary = await migratorPool.query<{
      schema_usage: boolean;
      schema_create: boolean;
      database_connect: boolean;
      database_create: boolean;
      database_temporary: boolean;
    }>(
      `SELECT has_schema_privilege($1, current_schema(), 'USAGE') AS schema_usage,
              has_schema_privilege($1, current_schema(), 'CREATE') AS schema_create,
              has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
              has_database_privilege($1, current_database(), 'CREATE') AS database_create,
              has_database_privilege($1, current_database(), 'TEMP') AS database_temporary`,
      [runtimeRole],
    );
    expect(effectiveBoundary.rows[0]).toEqual({
      schema_usage: true,
      schema_create: false,
      database_connect: true,
      database_create: false,
      database_temporary: false,
    });
    const sequenceCount = await migratorPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'S'",
    );
    expect(sequenceCount.rows[0]?.count).toBe("0");
    await expect(
      runtimePool.query("CREATE TABLE forbidden_runtime_ddl(id integer)"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(runtimePool.query(`CREATE SCHEMA "${schema}_forbidden"`)).rejects.toMatchObject({
      code: "42501",
    });
    const left = await createFixture("rls_left");
    const right = await createFixture("rls_right");
    const ownLockMarker = await withTenantTransaction(runtimePool, left.scope, (client) =>
      client.query(
        `UPDATE memberships SET lock_marker = false
          WHERE tenant_id = $1 AND user_id = $2`,
        [left.scope.tenantId, left.scope.userId],
      ),
    );
    expect(ownLockMarker.rowCount).toBe(1);
    await expect(
      withTenantTransaction(runtimePool, left.scope, (client) =>
        client.query(
          `UPDATE memberships SET lock_marker = true
            WHERE tenant_id = $1 AND user_id = $2`,
          [left.scope.tenantId, left.scope.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const crossTenantLockMarker = await withTenantTransaction(runtimePool, left.scope, (client) =>
      client.query(
        `UPDATE memberships SET lock_marker = false
          WHERE tenant_id = $1 AND user_id = $2`,
        [right.scope.tenantId, right.scope.userId],
      ),
    );
    expect(crossTenantLockMarker.rowCount).toBe(0);
    await expect(
      withTenantTransaction(runtimePool, left.scope, (client) =>
        client.query(
          "UPDATE threads SET agent_definition_id='agent_default' WHERE tenant_id=$1 AND id=$2",
          [left.scope.tenantId, left.thread.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(runtimePool, left.scope, (client) =>
        client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
           VALUES ($1,'cross_tenant_write',$2,'越权','active',clock_timestamp(),clock_timestamp())`,
          [right.scope.tenantId, right.scope.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgreSQL Repository 与并发条件", () => {
  it("双方 Membership 活动时可恢复不同 Tenant/Thread 创建者", async () => {
    const teamTenantId = tenantId("tenant_team_mapping");
    const tenantCreatorId = userId("user_team_creator");
    const threadCreatorId = userId("user_thread_creator");
    await withTenantTransaction(
      runtimePool,
      { tenantId: teamTenantId, userId: tenantCreatorId },
      async (client) => {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, $2)", [
          tenantCreatorId,
          timestamp(0),
        ]);
        await client.query(
          `INSERT INTO tenants(id,kind,display_name,created_by_user_id,created_at)
           VALUES ($1,'team','映射测试团队',$2,$3)`,
          [teamTenantId, tenantCreatorId, timestamp(0)],
        );
        await client.query(
          `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
           VALUES ($1,'membership_team_creator',$2,'owner','active',$3)`,
          [teamTenantId, tenantCreatorId, timestamp(0)],
        );
      },
    );
    await withTenantTransaction(
      runtimePool,
      { tenantId: teamTenantId, userId: threadCreatorId },
      async (client) => {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, $2)", [
          threadCreatorId,
          timestamp(1),
        ]);
        await client.query(
          `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
           VALUES ($1,'membership_thread_creator',$2,'member','active',$3)`,
          [teamTenantId, threadCreatorId, timestamp(1)],
        );
        await client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
           VALUES ($1,'thread_team_mapping',$2,'团队任务','active',$3,$3)`,
          [teamTenantId, threadCreatorId, timestamp(2)],
        );
      },
    );
    const restored = await repositories.threads.get(
      { tenantId: teamTenantId, userId: threadCreatorId },
      threadId("thread_team_mapping"),
    );
    expect(restored?.entity).toMatchObject({
      tenantId: teamTenantId,
      createdByUserId: threadCreatorId,
      title: "团队任务",
    });
  });

  it("TenantScope 让跨租户实体不可见", async () => {
    const left = await createFixture("scope_left");
    const right = await createFixture("scope_right");
    expect(await repositories.threads.get(left.scope, right.thread.id)).toBeUndefined();
    expect(await repositories.runs.get(left.scope, right.run.id)).toBeUndefined();
    expect(await repositories.workspaces.getById(left.scope, right.workspace.id)).toBeUndefined();
    expect((await repositories.workspaces.getById(right.scope, right.workspace.id))?.id).toBe(
      right.workspace.id,
    );
  });

  it("相同时间戳和 version 的 Thread/Run CAS 都只有一个更新成功", async () => {
    const threadFixture = await createFixture("thread_version");
    const archived = archiveThread(threadFixture.thread, timestamp(10));
    const threadResults = await Promise.all([
      repositories.threads.update(threadFixture.scope, archived, 0n),
      repositories.threads.update(threadFixture.scope, archived, 0n),
    ]);
    expect(threadResults.map((result) => result.outcome).sort()).toEqual(["conflict", "updated"]);
    expect(
      (await repositories.threads.get(threadFixture.scope, threadFixture.thread.id))?.version,
    ).toBe(1n);

    const runFixture = await createFixture("run_version");
    const waiting = transitionRun(runFixture.run, "waiting", timestamp(10));
    const runResults = await Promise.all([
      repositories.runs.update(runFixture.scope, waiting, 0n),
      repositories.runs.update(runFixture.scope, waiting, 0n),
    ]);
    expect(runResults.map((result) => result.outcome).sort()).toEqual(["conflict", "updated"]);
    expect((await repositories.runs.get(runFixture.scope, runFixture.run.id))?.version).toBe(1n);
  });

  it("Run 更新拒绝合法 wrong-parent 碰撞 id，并保持数据库真实父级", async () => {
    const fixture = await createFixture("run_wrong_parent");
    const otherThread = createThread({
      id: threadId("thread_run_wrong_parent_other"),
      tenant: fixture.tenant,
      user: fixture.user,
      membership: fixture.membership,
      title: "另一个合法任务",
      now: timestamp(8),
    });
    expect(await repositories.threads.create(fixture.scope, otherThread)).toMatchObject({
      outcome: "created",
    });
    const collidingQueued = createRun({
      id: fixture.run.id,
      thread: otherThread,
      now: timestamp(9),
    });
    const collidingRunning = transitionRun(collidingQueued, "running", timestamp(10));
    const collidingWaiting = transitionRun(collidingRunning, "waiting", timestamp(11));
    expect(await repositories.runs.update(fixture.scope, collidingWaiting, 0n)).toEqual({
      outcome: "conflict",
    });
    const stored = await repositories.runs.get(fixture.scope, fixture.run.id);
    expect(stored).toMatchObject({
      version: 0n,
      entity: { threadId: fixture.thread.id, status: "running" },
    });
  });

  it("真实父 Thread 归档与 Run 更新按 Thread→Run 固定锁序完成", async () => {
    const fixture = await createFixture("run_archive_race");
    const archived = archiveThread(fixture.thread, timestamp(12));
    const waiting = transitionRun(fixture.run, "waiting", timestamp(12));
    const [archiveResult, runResult] = await Promise.all([
      repositories.threads.update(fixture.scope, archived, 0n),
      repositories.runs.update(fixture.scope, waiting, 0n),
    ]);
    expect(archiveResult.outcome).toBe("updated");
    expect(runResult.outcome).toBe("updated");
    expect((await repositories.runs.get(fixture.scope, fixture.run.id))?.entity).toMatchObject({
      threadId: fixture.thread.id,
      status: "waiting",
    });
  });

  it("Thread 归档后拒绝创建 Run 和 Workspace", async () => {
    const fixture = await createFixture("archived_parent");
    const archived = archiveThread(fixture.thread, timestamp(12));
    expect(await repositories.threads.update(fixture.scope, archived, 0n)).toMatchObject({
      outcome: "updated",
    });
    const queued = createRun({
      id: runId("run_after_archive"),
      thread: fixture.thread,
      now: timestamp(13),
    });
    expect(await repositories.runs.create(fixture.scope, queued)).toEqual({ outcome: "conflict" });
    const workspace = createWorkspace({
      id: workspaceId("workspace_after_archive"),
      thread: fixture.thread,
      now: timestamp(13),
    });
    expect(await repositories.workspaces.create(fixture.scope, workspace)).toEqual({
      outcome: "conflict",
    });
  });

  it("Thread 归档与 Run 创建竞态按父行锁串行化", async () => {
    const fixture = await createFixture("archive_race");
    const archived = archiveThread(fixture.thread, timestamp(19));
    const candidate = createRun({
      id: runId("run_archive_race_candidate"),
      thread: fixture.thread,
      now: timestamp(19),
    });
    const [archiveResult, createResult] = await Promise.all([
      repositories.threads.update(fixture.scope, archived, 0n),
      repositories.runs.create(fixture.scope, candidate),
    ]);
    expect(archiveResult.outcome).toBe("updated");
    expect(["created", "conflict"]).toContain(createResult.outcome);
    expect((await repositories.threads.get(fixture.scope, fixture.thread.id))?.entity.status).toBe(
      "archived",
    );
  });

  it("Run 终态后拒绝 Lease、Revision 与 Release", async () => {
    const beforeLease = await createFixture("terminal_before_lease");
    const failed = transitionRun(beforeLease.run, "failed", timestamp(14));
    expect(await repositories.runs.update(beforeLease.scope, failed, 0n)).toMatchObject({
      outcome: "updated",
    });
    const staleLease = acquireWorkspaceLease({
      workspace: beforeLease.workspace,
      rootRun: beforeLease.run,
      epoch: 1,
      expiresAt: timestamp(50),
      now: timestamp(15),
    });
    expect(
      await repositories.workspaces.compareAndSetLease(
        beforeLease.writeScope,
        beforeLease.workspace,
        staleLease,
      ),
    ).toEqual({ outcome: "lease_lost" });

    const afterLease = await createFixture("terminal_after_lease");
    const leased = await acquireLease(afterLease);
    const failedAfterLease = transitionRun(afterLease.run, "failed", timestamp(16));
    expect(await repositories.runs.update(afterLease.scope, failedAfterLease, 0n)).toMatchObject({
      outcome: "updated",
    });
    const revision = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: afterLease.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("revision_terminal"),
      objectKey: "terminal/revision.tar.zst",
      digest: sha256Digest("c".repeat(64)),
      now: timestamp(17),
    });
    expect(await repositories.workspaces.commitRevision(afterLease.writeScope, revision)).toEqual({
      outcome: "lease_lost",
    });
    const released = releaseWorkspaceLease({
      workspace: leased,
      rootRun: afterLease.run,
      epoch: 1,
      now: timestamp(18),
    });
    expect(
      await repositories.workspaces.compareAndSetLease(afterLease.writeScope, leased, released),
    ).toEqual({ outcome: "lease_lost" });
  });

  it("Run 终态与 Revision 提交竞态按 Run 行锁串行化", async () => {
    const fixture = await createFixture("run_revision_race");
    const leased = await acquireLease(fixture);
    const revision = prepareWorkspaceRevision({
      workspace: leased,
      rootRun: fixture.run,
      leaseEpoch: 1,
      revisionId: workspaceRevisionId("revision_run_race"),
      objectKey: "race/revision.tar.zst",
      digest: sha256Digest("d".repeat(64)),
      now: timestamp(20),
    });
    const failed = transitionRun(fixture.run, "failed", timestamp(20));
    const [runResult, revisionResult] = await Promise.all([
      repositories.runs.update(fixture.scope, failed, 0n),
      repositories.workspaces.commitRevision(fixture.writeScope, revision),
    ]);
    expect(runResult.outcome).toBe("updated");
    expect(["committed", "lease_lost"]).toContain(revisionResult.outcome);
  });

  it("相同 parent/revision/epoch 并发提交恰好一个成功", async () => {
    const fixture = await createFixture("revision_cas");
    const leased = await acquireLease(fixture);
    const commands = ["left", "right"].map((side) =>
      prepareWorkspaceRevision({
        workspace: leased,
        rootRun: fixture.run,
        leaseEpoch: 1,
        revisionId: workspaceRevisionId(`revision_${side}`),
        objectKey: `revision/${side}.tar.zst`,
        digest: sha256Digest(side === "left" ? "a".repeat(64) : "b".repeat(64)),
        now: timestamp(18),
      }),
    );
    const [left, right] = commands;
    if (left === undefined || right === undefined) throw new Error("测试命令构造失败");
    const outcomes = await Promise.all([
      repositories.workspaces.commitRevision(fixture.writeScope, left),
      repositories.workspaces.commitRevision(fixture.writeScope, right),
    ]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "committed",
      "revision_conflict",
    ]);
    const rows = await withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1",
        [fixture.workspace.id],
      ),
    );
    expect(rows.rows[0]?.count).toBe("1");
    await expect(
      withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
        client.query(
          "UPDATE workspace_revisions SET object_key = 'forbidden' WHERE workspace_id = $1",
          [fixture.workspace.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
        client.query("DELETE FROM workspace_revisions WHERE workspace_id = $1", [
          fixture.workspace.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("数据库时钟拒绝过期、错误 root Run 和错误 epoch", async () => {
    const fixture = await createFixture("lease_checks");
    const leased = await acquireLease(fixture);
    const renewal = renewWorkspaceLease({
      workspace: leased,
      rootRun: fixture.run,
      epoch: 1,
      expiresAt: timestamp(55),
      now: timestamp(6),
    });
    await withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
      client.query(
        "UPDATE workspace_write_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE workspace_id = $1",
        [fixture.workspace.id],
      ),
    );
    expect(
      await repositories.workspaces.compareAndSetLease(fixture.writeScope, leased, renewal),
    ).toEqual({ outcome: "lease_lost" });
    expect(
      await repositories.workspaces.compareAndSetLease(
        { tenantId: fixture.scope.tenantId, rootRunId: runId("wrong_root") },
        leased,
        renewal,
      ),
    ).toEqual({ outcome: "lease_lost" });
    await withTenantTransaction(runtimePool, fixture.writeScope, (client) =>
      client.query("UPDATE workspace_write_leases SET epoch = 2 WHERE workspace_id = $1", [
        fixture.workspace.id,
      ]),
    );
    expect(
      await repositories.workspaces.compareAndSetLease(fixture.writeScope, leased, renewal),
    ).toEqual({ outcome: "lease_lost" });
  });

  it("事务中途失败完整回滚", async () => {
    const fixture = await createFixture("rollback");
    await expect(
      withTenantTransaction(runtimePool, fixture.scope, async (client) => {
        await client.query("UPDATE threads SET title = '不应提交' WHERE id = $1", [
          fixture.thread.id,
        ]);
        throw new Error("注入事务失败");
      }),
    ).rejects.toThrow("注入事务失败");
    expect((await repositories.threads.get(fixture.scope, fixture.thread.id))?.entity.title).toBe(
      fixture.thread.title,
    );
  });
});

describe("PostgreSQL Run 压缩参数快照", () => {
  const deploymentSettings = {
    softLimitPercent: 80,
    targetPercent: 55,
    recentUserTokens: 4096,
    maxOutputTokens: 4096,
    timeoutMs: 60_000,
  };

  it("无后台模型时并发首次解析只固化一个部署版本，跨租户不可见且 Runtime 不可改删", async () => {
    const { PgRunCompactionSettingsRepository } = await import(
      "../../runtime-ts/packages/persistence/src/pg-run-compaction-settings.js"
    );
    const first = await createFixture("compaction_snapshot_a");
    const second = await createFixture("compaction_snapshot_b");
    const input = { tenantId: first.scope.tenantId, runId: first.run.id, deploymentSettings };
    const otherDeployment = { ...deploymentSettings, targetPercent: 60, maxOutputTokens: 2048 };
    const results = await Promise.all([
      new PgRunCompactionSettingsRepository(runtimePool).resolveForRun(input),
      new PgRunCompactionSettingsRepository(runtimePool).resolveForRun({
        ...input,
        deploymentSettings: otherDeployment,
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect([deploymentSettings, otherDeployment]).toContainEqual(results[0]);
    await expect(
      new PgRunCompactionSettingsRepository(runtimePool).resolveForRun({
        ...input,
        deploymentSettings: { ...deploymentSettings, maxOutputTokens: 512 },
      }),
    ).resolves.toEqual(results[0]);
    const invisible = await withTenantTransaction(runtimePool, second.scope, (client) =>
      client.query("SELECT run_id FROM run_compaction_settings_snapshots WHERE run_id=$1", [
        first.run.id,
      ]),
    );
    expect(invisible.rows).toEqual([]);
    await expect(
      withTenantTransaction(runtimePool, second.scope, (client) =>
        client.query(
          `INSERT INTO run_compaction_settings_snapshots(
             tenant_id,run_id,soft_limit_percent,target_percent,recent_user_tokens,max_output_tokens,timeout_ms
           ) VALUES($1,$2,80,55,4096,4096,60000)`,
          [first.scope.tenantId, first.run.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const sql of [
      "UPDATE run_compaction_settings_snapshots SET target_percent=50 WHERE run_id=$1",
      "DELETE FROM run_compaction_settings_snapshots WHERE run_id=$1",
    ]) {
      await expect(
        withTenantTransaction(runtimePool, first.scope, (client) =>
          client.query(sql, [first.run.id]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      adminControlPool.query("SELECT run_id FROM run_compaction_settings_snapshots"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("升级恢复旧 Run 继承已固定的运行参数引用，新 Run 仍只使用部署值", async () => {
    const { PgRunCompactionSettingsRepository } = await import(
      "../../runtime-ts/packages/persistence/src/pg-run-compaction-settings.js"
    );
    const legacy = await createFixture("compaction_snapshot_legacy");
    const fresh = await createFixture("compaction_snapshot_fresh");
    const legacySettings = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 85,
      compactionTargetPercent: 60,
      compactionRecentUserTokens: 16_000,
      compactionMaxOutputTokens: 2048,
      compactionTimeoutMs: 30_000,
    };
    const legacyModel = {
      providerKey: "compaction-legacy",
      displayName: "历史压缩模型",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.invalid/v1",
      secretRef: "deployment:model",
      defaultModelId: "legacy-model",
      models: [
        {
          id: "legacy-model",
          name: "历史模型",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      ],
    };
    await migratorPool.query(
      `INSERT INTO admin_control_config_revisions(object_kind,object_key,revision,configuration,configuration_digest,created_by)
       VALUES('model_provider','compaction-legacy',100059,$1,$4,$3),
             ('runtime_settings','global',100059,$2,$5,$3)`,
      [
        JSON.stringify(legacyModel),
        JSON.stringify(legacySettings),
        legacy.user.id,
        "a".repeat(64),
        "b".repeat(64),
      ],
    );
    await migratorPool.query(
      `INSERT INTO run_runtime_config_snapshots(
         tenant_id,run_id,generation,model_object_key,model_revision,
         runtime_settings_object_kind,runtime_settings_object_key,runtime_settings_revision
       ) VALUES($1,$2,1,'compaction-legacy',100059,'runtime_settings','global',100059)`,
      [legacy.scope.tenantId, legacy.run.id],
    );
    const repository = new PgRunCompactionSettingsRepository(runtimePool);
    await expect(
      repository.resolveForRun({
        tenantId: legacy.scope.tenantId,
        runId: legacy.run.id,
        deploymentSettings,
      }),
    ).resolves.toEqual({
      softLimitPercent: 85,
      targetPercent: 60,
      recentUserTokens: 16_000,
      maxOutputTokens: 2048,
      timeoutMs: 30_000,
    });
    await expect(
      repository.resolveForRun({
        tenantId: fresh.scope.tenantId,
        runId: fresh.run.id,
        deploymentSettings,
      }),
    ).resolves.toEqual(deploymentSettings);
  });

  it("后台运行设置独立保存并热读取，新 Run 生效且旧 Run 保持快照", async () => {
    const { PgRunCompactionSettingsRepository } = await import(
      "../../runtime-ts/packages/persistence/src/pg-run-compaction-settings.js"
    );
    const first = await createFixture("runtime_live_first");
    const second = await createFixture("runtime_live_second");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [first.user.id],
    );
    const cipher = new ModelProviderCredentialCipher(
      "integration-live-settings-root-at-least-32-bytes",
    );
    const repository = new PgAdminControlRepository(adminControlPool, cipher);
    const service = new AdminControlService(
      repository,
      repository,
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    const runtime = new PgRuntimeControlConfigurationRepository(runtimePool, cipher);
    const compaction = new PgRunCompactionSettingsRepository(runtimePool);
    const command = {
      workerMaxConcurrentRuns: 7,
      userMaxConcurrentRunsPerTenant: 3,
      compactionSoftLimitPercent: 90,
      compactionTargetPercent: 65,
      compactionRecentUserTokens: 2048,
      compactionMaxOutputTokens: 1024,
      compactionTimeoutMs: 45000,
      expectedGeneration: await repository.generation(first.user.id),
    };
    const context = {
      actorUserId: first.user.id,
      idempotencyKey: "runtime-live-first-0001",
      requestDigest: "c".repeat(64),
    };
    const firstInput = { tenantId: first.scope.tenantId, runId: first.run.id, deploymentSettings };
    try {
      expect(
        (await repository.listModelProviders(first.user.id)).some(
          (revision) => revision.status === "active",
        ),
      ).toBe(false);
      const saved = await service.saveRuntimeSettingsConfiguration(context, command);
      expect(saved.status).toBe("active");
      await expect(service.saveRuntimeSettingsConfiguration(context, command)).resolves.toEqual(
        saved,
      );
      await expect(runtime.resolveActiveRuntimeSettings()).resolves.toMatchObject({
        workerMaxConcurrentRuns: 7,
        userMaxConcurrentRunsPerTenant: 3,
      });
      const fixed = await compaction.resolveForRun(firstInput);
      expect(fixed).toEqual({
        softLimitPercent: 90,
        targetPercent: 65,
        recentUserTokens: 2048,
        maxOutputTokens: 1024,
        timeoutMs: 45000,
      });
      await service.saveRuntimeSettingsConfiguration(
        { ...context, idempotencyKey: "runtime-live-second-0001", requestDigest: "d".repeat(64) },
        {
          ...command,
          expectedGeneration: await repository.generation(first.user.id),
          workerMaxConcurrentRuns: 2,
          userMaxConcurrentRunsPerTenant: 1,
          compactionTargetPercent: 70,
        },
      );
      await expect(runtime.resolveActiveRuntimeSettings()).resolves.toMatchObject({
        workerMaxConcurrentRuns: 2,
        userMaxConcurrentRunsPerTenant: 1,
      });
      await expect(compaction.resolveForRun(firstInput)).resolves.toEqual(fixed);
      await expect(
        compaction.resolveForRun({
          tenantId: second.scope.tenantId,
          runId: second.run.id,
          deploymentSettings,
        }),
      ).resolves.toEqual({ ...fixed, targetPercent: 70 });
      await expect(
        service.saveRuntimeSettingsConfiguration(
          { ...context, idempotencyKey: "runtime-live-stale-0001" },
          command,
        ),
      ).rejects.toThrow();
    } finally {
      await migratorPool.query("DELETE FROM admin_control_audits WHERE actor_user_id=$1", [
        first.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_commands WHERE actor_user_id=$1", [
        first.user.id,
      ]);
      await migratorPool.query(
        "DELETE FROM admin_control_activation_events WHERE actor_user_id=$1",
        [first.user.id],
      );
      await migratorPool.query("DELETE FROM admin_control_active_configs WHERE activated_by=$1", [
        first.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_config_revisions WHERE created_by=$1", [
        first.user.id,
      ]);
      await migratorPool.query("DELETE FROM platform_control_operators WHERE user_id=$1", [
        first.user.id,
      ]);
    }
  });
});

describe("PostgreSQL Runtime 模型与模式快照", () => {
  async function createConfigurationFixture(suffix: string) {
    const fixture = await createFixture(suffix);
    const tenants = [fixture.scope.tenantId];
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [fixture.user.id],
    );
    const cipher = new ModelProviderCredentialCipher("integration-runtime-root-at-least-32-bytes");
    const repository = new PgAdminControlRepository(adminControlPool, cipher);
    const service = new AdminControlService(
      repository,
      repository,
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    const runtime = new PgRuntimeControlConfigurationRepository(runtimePool, cipher);
    const context = (key: string) => ({
      actorUserId: fixture.user.id,
      idempotencyKey: `${suffix}-${key}`,
      requestDigest: "a".repeat(64),
    });
    const saveModel = async (modelId: string) =>
      await service.saveModelConfiguration(context(modelId), {
        providerKey: "runtime-main",
        displayName: "Runtime 测试模型",
        protocol: "openai-compatible",
        baseUrl: "https://model.example.invalid/v1",
        apiKey: `integration-${modelId}-api-key`,
        defaultModelId: modelId,
        models: [
          {
            id: modelId,
            name: modelId,
            enabled: true,
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
        expectedGeneration: await repository.generation(fixture.user.id),
      });
    const newRun = async (key: string) => {
      const next = await createFixture(`${suffix}_${key}`);
      tenants.push(next.scope.tenantId);
      return { tenantId: next.scope.tenantId, runId: next.run.id };
    };
    const close = async () => {
      await migratorPool.query(
        "DELETE FROM run_runtime_config_snapshots WHERE tenant_id=ANY($1::text[])",
        [tenants],
      );
      await migratorPool.query("DELETE FROM admin_control_audits WHERE actor_user_id=$1", [
        fixture.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_commands WHERE actor_user_id=$1", [
        fixture.user.id,
      ]);
      await migratorPool.query(
        "DELETE FROM admin_control_activation_events WHERE actor_user_id=$1",
        [fixture.user.id],
      );
      await migratorPool.query("DELETE FROM admin_control_active_configs WHERE activated_by=$1", [
        fixture.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_provider_probes WHERE actor_user_id=$1", [
        fixture.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_config_revisions WHERE created_by=$1", [
        fixture.user.id,
      ]);
      await migratorPool.query("DELETE FROM platform_control_operators WHERE user_id=$1", [
        fixture.user.id,
      ]);
    };
    return { fixture, cipher, repository, service, runtime, context, saveModel, newRun, close };
  }

  it("受限 runtime 角色只读当前 active 模型，不创建快照、不解析记忆且切换后重新读取", async () => {
    const test = await createConfigurationFixture("active_model_read");
    try {
      const role = await runtimePool.query(
        "SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      expect(role.rows).toEqual([{ role: runtimeRole, rolsuper: false, rolbypassrls: false }]);
      await expect(test.runtime.resolveActiveModelConfiguration()).resolves.toBeUndefined();
      const snapshotsBefore = await migratorPool.query(
        "SELECT count(*)::text AS total FROM run_runtime_config_snapshots",
      );
      const first = await test.saveModel("active-a");
      const otherCipher = new ModelProviderCredentialCipher(
        "integration-other-runtime-root-at-least-32-bytes",
      );
      const memoryRepository = new PgAdminControlRepository(adminControlPool, otherCipher);
      const memoryService = new AdminControlService(
        memoryRepository,
        memoryRepository,
        { probeModel: async () => undefined, probeMemory: async () => undefined },
        [],
      );
      await memoryService.saveMemoryConfiguration(test.context("memory-other-key"), {
        providerKey: "active-memory",
        displayName: "不应读取的记忆配置",
        providerKind: "mem0",
        baseUrl: "https://memory.example.invalid/",
        apiSecretRef: "managed:memory-api",
        scopeSecretRef: "platform:memory-scope",
        requestTimeoutMs: 10000,
        enabled: true,
        apiKey: "integration-memory-other-key",
        expectedGeneration: await test.repository.generation(test.fixture.user.id),
      });
      await expect(test.runtime.resolveActiveModelConfiguration()).resolves.toEqual({
        configuration: first.configuration,
        apiKey: "integration-active-a-api-key",
      });
      await expect(
        new PgRuntimeControlConfigurationRepository(
          runtimePool,
          test.cipher,
        ).resolveActiveModelConfiguration(),
      ).resolves.toEqual({
        configuration: first.configuration,
        apiKey: "integration-active-a-api-key",
      });
      const second = await test.saveModel("active-b");
      await expect(test.runtime.resolveActiveModelConfiguration()).resolves.toEqual({
        configuration: second.configuration,
        apiKey: "integration-active-b-api-key",
      });
      const snapshotsAfter = await migratorPool.query(
        "SELECT count(*)::text AS total FROM run_runtime_config_snapshots",
      );
      expect(snapshotsAfter.rows).toEqual(snapshotsBefore.rows);
      await expect(
        runtimePool.query(
          "UPDATE admin_control_active_configs SET reason='禁止写入' WHERE object_kind='model_provider'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await test.close();
    }
  });

  it("active 模型解密失败或缺失凭据必须抛错，不能返回无配置或采用部署回退", async () => {
    const test = await createConfigurationFixture("active_model_bad");
    try {
      const saved = await test.saveModel("bad-active");
      const wrongCipher = new ModelProviderCredentialCipher(
        "integration-wrong-runtime-root-at-least-32-bytes",
      );
      const reader = new PgRuntimeControlConfigurationRepository(
        runtimePool,
        wrongCipher,
        "integration-deployment-fallback-key",
      );
      await expect(reader.resolveActiveModelConfiguration()).rejects.toMatchObject({
        code: "UNEXPECTED",
        message: "读取已发布模型配置失败",
      });
      await migratorPool.query(
        `UPDATE admin_control_config_revisions
            SET configuration=jsonb_set(configuration,'{credential}',$1::jsonb)
          WHERE object_kind='model_provider' AND object_key='runtime-main' AND revision=$2`,
        [
          JSON.stringify(test.cipher.encrypt("different-provider", "integration-bad-aad-key")),
          saved.revision,
        ],
      );
      await expect(
        new PgRuntimeControlConfigurationRepository(
          runtimePool,
          test.cipher,
          "integration-deployment-fallback-key",
        ).resolveActiveModelConfiguration(),
      ).rejects.toMatchObject({ code: "UNEXPECTED" });
      await migratorPool.query(
        `UPDATE admin_control_config_revisions
            SET configuration=(configuration-'credential') || '{"secretRef":"deployment:model"}'::jsonb
          WHERE object_kind='model_provider' AND object_key='runtime-main' AND revision=$1`,
        [saved.revision],
      );
      await expect(test.runtime.resolveActiveModelConfiguration()).rejects.toMatchObject({
        code: "UNEXPECTED",
      });
      const legacyReader = new PgRuntimeControlConfigurationRepository(
        runtimePool,
        test.cipher,
        "integration-legacy-model-api-key",
      );
      await expect(legacyReader.resolveActiveModelConfiguration()).resolves.toMatchObject({
        configuration: { defaultModelId: "bad-active", credentialConfigured: false },
        apiKey: "integration-legacy-model-api-key",
      });
      const snapshots = await withTenantTransaction(runtimePool, test.fixture.scope, (client) =>
        client.query("SELECT run_id FROM run_runtime_config_snapshots"),
      );
      expect(snapshots.rows).toHaveLength(0);
    } finally {
      await test.close();
    }
  });

  it("真实 PG 新 Run 绑定工具模式和名单 revision，切换后新 Run 生效且重建仓储恢复旧选择", async () => {
    const test = await createConfigurationFixture("mode_snapshot");
    try {
      await test.saveModel("mode-model");
      const emptyInput = { tenantId: test.fixture.scope.tenantId, runId: test.fixture.run.id };
      const emptySnapshot = await test.runtime.resolveForRun(emptyInput);
      expect(emptySnapshot?.runtimeSettings).toBeUndefined();
      const settings = {
        workerMaxConcurrentRuns: 4,
        userMaxConcurrentRunsPerTenant: 2,
        toolCallingMode: "ptc",
        enabledTools: ["read", "skill"],
        compactionSoftLimitPercent: 90,
        compactionTargetPercent: 65,
        compactionRecentUserTokens: 2048,
        compactionMaxOutputTokens: 1024,
        compactionTimeoutMs: 45000,
      } as const;
      const ptc = await test.service.saveRuntimeSettingsConfiguration(test.context("ptc"), {
        ...settings,
        expectedGeneration: await test.repository.generation(test.fixture.user.id),
      });
      const ptcInput = await test.newRun("ptc");
      const ptcSnapshot = await test.runtime.resolveForRun(ptcInput);
      expect(ptcSnapshot?.runtimeSettings).toMatchObject({
        revision: ptc.revision,
        configuration: { toolCallingMode: "ptc", enabledTools: ["read", "skill"] },
      });
      const stored = await withTenantTransaction(runtimePool, ptcInput, (client) =>
        client.query(
          `SELECT runtime_settings_object_kind,runtime_settings_object_key,runtime_settings_revision::text
           FROM run_runtime_config_snapshots WHERE tenant_id=$1 AND run_id=$2`,
          [ptcInput.tenantId, ptcInput.runId],
        ),
      );
      expect(stored.rows).toEqual([
        {
          runtime_settings_object_kind: "runtime_settings",
          runtime_settings_object_key: "global",
          runtime_settings_revision: String(ptc.revision),
        },
      ]);
      const native = await test.service.saveRuntimeSettingsConfiguration(test.context("native"), {
        ...settings,
        toolCallingMode: "native",
        enabledTools: [],
        expectedGeneration: await test.repository.generation(test.fixture.user.id),
      });
      const nativeInput = await test.newRun("native");
      const nativeSnapshot = await test.runtime.resolveForRun(nativeInput);
      expect(nativeSnapshot?.runtimeSettings).toMatchObject({
        revision: native.revision,
        configuration: { toolCallingMode: "native", enabledTools: [] },
      });
      const restored = new PgRuntimeControlConfigurationRepository(runtimePool, test.cipher);
      await expect(restored.resolveForRun(ptcInput)).resolves.toEqual(ptcSnapshot);
      await expect(restored.resolveForRun(nativeInput)).resolves.toEqual(nativeSnapshot);
      await expect(restored.resolveForRun(emptyInput)).resolves.toEqual(emptySnapshot);
      expect(
        (await restored.resolveForRun(emptyInput))?.runtimeSettings?.configuration
          .toolCallingMode ?? "native",
      ).toBe("native");
      const emptyStored = await withTenantTransaction(runtimePool, emptyInput, (client) =>
        client.query(
          `SELECT runtime_settings_object_kind,runtime_settings_object_key,runtime_settings_revision
           FROM run_runtime_config_snapshots WHERE tenant_id=$1 AND run_id=$2`,
          [emptyInput.tenantId, emptyInput.runId],
        ),
      );
      expect(emptyStored.rows).toEqual([
        {
          runtime_settings_object_kind: null,
          runtime_settings_object_key: null,
          runtime_settings_revision: null,
        },
      ]);
      await migratorPool.query(
        `UPDATE admin_control_config_revisions SET configuration=configuration-'toolCallingMode'
          WHERE object_kind='runtime_settings' AND object_key='global' AND revision=$1`,
        [native.revision],
      );
      await test.service.saveRuntimeSettingsConfiguration(test.context("ptc-again"), {
        ...settings,
        expectedGeneration: await test.repository.generation(test.fixture.user.id),
      });
      const legacySnapshot = await new PgRuntimeControlConfigurationRepository(
        runtimePool,
        test.cipher,
      ).resolveForRun(nativeInput);
      expect(legacySnapshot?.runtimeSettings?.revision).toBe(native.revision);
      expect(legacySnapshot?.runtimeSettings?.configuration.toolCallingMode).toBe("native");
      expect(legacySnapshot?.runtimeSettings?.configuration.enabledTools).toEqual([]);
    } finally {
      await test.close();
    }
  });
});
