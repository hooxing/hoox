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
  normalizeExternalToolSchema,
  prepareWorkspaceRevision,
  type Run,
  rehydrateThread,
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
import type { ExecutionFence, RuntimeMutation } from "@hoox/run-contracts";
import { runtimeMutationDigest } from "@hoox/run-contracts/mutation-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { AdminControlApiDependencies } from "../../runtime-ts/apps/admin-control-api/src/app.js";
import { createApiApp } from "../../runtime-ts/apps/api/src/app.js";
import { createApiCreateCapability } from "../../runtime-ts/apps/api/src/capabilities.js";
import { createThreadCursorCodec } from "../../runtime-ts/apps/api/src/cursor.js";
import { AdminControlService } from "../../runtime-ts/packages/admin-control/src/index.js";
import { createApiKeyToken, hashApiKey } from "../../runtime-ts/packages/identity/src/api-key.js";
import {
  assertEvaluationRoleSafe,
  bootstrapEvaluationRole,
  evaluationRoleName,
  setLocalEvaluationRole,
} from "../../runtime-ts/packages/persistence/src/evaluation-role.js";
import { ExternalToolCredentialCipher } from "../../runtime-ts/packages/persistence/src/external-tool-credential.js";
import { ExternalToolCredentialDecryptor } from "../../runtime-ts/packages/persistence/src/external-tool-credential-reader.js";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import { ModelProviderCredentialCipher } from "../../runtime-ts/packages/persistence/src/model-provider-credential.js";
import {
  PgAdminControlRepository,
  PgRuntimeControlConfigurationRepository,
} from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
import { PgAdminRunExplorerRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-run-explorer.js";
import { PgAgentDefinitionRepository } from "../../runtime-ts/packages/persistence/src/pg-agent-definition.js";
import { PgApiKeyRepository } from "../../runtime-ts/packages/persistence/src/pg-api-keys.js";
import {
  PgArchiveThreadCommand,
  PgCoreRepositories,
  PgRenamePersonalThreadCommand,
} from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import { PgEvaluationRepository } from "../../runtime-ts/packages/persistence/src/pg-evaluation.js";
import { PgEvaluationCommand } from "../../runtime-ts/packages/persistence/src/pg-evaluation-command.js";
import { PgEvaluationDriver } from "../../runtime-ts/packages/persistence/src/pg-evaluation-driver.js";
import { PgExternalToolSnapshotReader } from "../../runtime-ts/packages/persistence/src/pg-external-tool-snapshot-reader.js";
import { PgExternalToolRegistry } from "../../runtime-ts/packages/persistence/src/pg-external-tools.js";
import { PgIntegrationAdminRepository } from "../../runtime-ts/packages/persistence/src/pg-integration-admin.js";
import { readRunAgentSnapshot } from "../../runtime-ts/packages/persistence/src/pg-run-agent-snapshot.js";
import { PgRunDispatchCreation } from "../../runtime-ts/packages/persistence/src/pg-run-dispatch.js";
import {
  PgExecutionPersistence,
  PgRunExecutionSetup,
} from "../../runtime-ts/packages/persistence/src/pg-run-worker-state.js";
import {
  PgSandboxConfigurationResolver,
  PgSandboxControlRepository,
} from "../../runtime-ts/packages/persistence/src/pg-sandbox-configuration.js";
import { readRunSkillSnapshot } from "../../runtime-ts/packages/persistence/src/pg-skill-runtime.js";
import { PgThreadCreation } from "../../runtime-ts/packages/persistence/src/pg-thread-creation.js";
import {
  enqueueRunStatusWebhook,
  enqueueWebhookEvent,
  PgWebhookOutboxStore,
  PgWebhookRepository,
  runWebhookPayload,
} from "../../runtime-ts/packages/persistence/src/pg-webhooks.js";
import {
  createPostgresPool,
  type Pool,
  type PoolClient,
  withTenantTransaction,
  withTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import {
  bootstrapRuntimeAccess,
  bootstrapRuntimeAccessOnClient,
} from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";
import { WebhookSecretCipher } from "../../runtime-ts/packages/persistence/src/webhook-crypto.js";
import {
  buildRuntimeSystemPrompt,
  DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
} from "../../runtime-ts/packages/prompt-builder/src/index.js";
import type { EvaluationCase } from "../../runtime-ts/packages/protocol/src/admin-evaluation.js";
import {
  parseAgentConfiguration,
  serializeAgentConfiguration,
} from "../../runtime-ts/packages/protocol/src/agent-configuration.js";
import { assertRunSkillSnapshot } from "../../runtime-ts/packages/skill/src/runtime.js";
import { apiEndUserTests } from "./postgres-api-end-users.js";
import { externalToolRegistryTests } from "./postgres-external-tool-registry.js";
import {
  loadPostgreSqlMigrationContract,
  type PostgreSqlMigrationContract,
} from "./postgres-migration-contract.js";

function skillSnapshotBlobRef(sha256: string, size: number, mediaType: string): string {
  const tenantId = "tenant_test_publisher";
  const incarnationId = "00000000-0000-4000-8000-000000000001";
  return JSON.stringify({
    kind: "stable",
    tenantId,
    purpose: "skill",
    sha256,
    size,
    mediaType,
    incarnationId,
    physicalObjectKey: `test/stable/${tenantId}/skill/sha256/${sha256}/incarnations/${incarnationId}`,
  });
}

function sqlStateFromCause(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

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
const workerCoordinatorDatabaseUrl = new URL(migrationDatabaseUrl);
const teamCoordinatorDatabaseUrl = new URL(migrationDatabaseUrl);
const adminControlDatabaseUrl = new URL(migrationDatabaseUrl);
if (testMigrationUrl.username !== configuredMigratorRole) {
  throw new Error("MIGRATION_DATABASE_URL 与 DATABASE_MIGRATOR_ROLE 不一致");
}
testMigrationUrl.username = migratorRole;
testMigrationUrl.password = migratorPassword;
workerCoordinatorDatabaseUrl.username = workerCoordinatorRole;
workerCoordinatorDatabaseUrl.password = workerCoordinatorPassword;
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
let workerCoordinatorPool!: Pool;
let teamCoordinatorPool!: Pool;
let adminControlPool!: Pool;
let repositories!: CoreRepositories;
let schemaCreated = false;
let migratorCreated = false;
let concurrentMigrationVersions: readonly number[] = [];
let migrationContract!: PostgreSqlMigrationContract;
let isolatedMigrationCounter = 0;

apiEndUserTests(() => ({
  administrativePool,
  schema,
  runtimePool,
  migratorPool,
  adminControlPool,
  repositories,
  createFixture,
}));

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
  return repository.readRevisionById(
    tenantId("tenant_seed_contract"),
    "agent_default_revision_platform_memory",
  );
}

function timestamp(second: number): ReturnType<typeof isoTimestamp> {
  return isoTimestamp(`2099-07-26T08:00:${second.toString().padStart(2, "0")}.000Z`);
}

async function createFixture(
  suffix: string,
  fixtureRepositories: CoreRepositories = repositories,
): Promise<Fixture> {
  const user = createUser(userId(`user_${suffix}`), timestamp(0));
  const personal = createPersonalTenant({
    id: tenantId(`tenant_${suffix}`),
    ownerMembershipId: membershipId(`membership_${suffix}`),
    owner: user,
    createdAt: timestamp(0),
  });
  const scope: TenantScope = { tenantId: personal.tenant.id, userId: user.id };
  expect(
    await fixtureRepositories.tenants.createPersonal({
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
  expect(await fixtureRepositories.threads.create(scope, thread)).toEqual({
    outcome: "created",
    version: 0n,
  });
  const queued = createRun({ id: runId(`run_${suffix}`), thread, now: timestamp(2) });
  const run = transitionRun(queued, "running", timestamp(3));
  expect(await fixtureRepositories.runs.create(scope, run)).toEqual({
    outcome: "created",
    version: 0n,
  });
  const workspace = createWorkspace({
    id: workspaceId(`workspace_${suffix}`),
    thread,
    now: timestamp(4),
  });
  expect(await fixtureRepositories.workspaces.create(scope, workspace)).toEqual({
    outcome: "created",
  });
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

async function evaluationFixture(suffix: string, globalLimit: number) {
  const target = await createIsolatedMigrationTarget(`eval_${suffix}`);
  const schema = target.context.schema;
  const controlUrl = new URL(target.connectionString);
  controlUrl.username = target.context.adminControlRole;
  const adminControlPool = createPostgresPool({ connectionString: controlUrl.toString(), schema }),
    runtimePool = createPostgresPool({ connectionString: target.runtimeConnectionString, schema });
  onTestFinished(async () => {
    await Promise.all([runtimePool.end(), adminControlPool.end()]);
    await target.close();
  });
  await migrateUp(target.pool, target.context);
  const evaluationProjectionGrant = await adminControlPool.query<{
    allowed: boolean;
    role: string;
  }>(
    "SELECT current_user AS role,has_table_privilege(current_user,'admin_evaluation_case_projection','SELECT') AS allowed",
  );
  if (!evaluationProjectionGrant.rows[0]?.allowed) {
    const acl = await target.pool.query<{ relacl: string | null }>(
      "SELECT relacl::text FROM pg_class WHERE oid='admin_evaluation_case_projection'::regclass",
    );
    throw new Error(
      `评测结构投影视图未授权给 ${evaluationProjectionGrant.rows[0]?.role}: ${acl.rows[0]?.relacl}`,
    );
  }
  const repositories = new PgCoreRepositories(runtimePool);
  const { scope } = await createFixture(`evaluation_${suffix}`, repositories);
  await administrativePool.query(
    `INSERT INTO "${schema}".platform_control_operators(user_id,role,status) VALUES($1,'admin','active')`,
    [scope.userId],
  );
  await administrativePool.query(
    `INSERT INTO "${schema}".user_accounts(user_id,personal_tenant_id,email,normalized_email,display_name,password_algorithm,password_salt,password_hash,created_at,updated_at) VALUES($1,$2,$3,$3,'评测管理员','scrypt-v1',decode(repeat('00',16),'hex'),decode(repeat('00',32),'hex'),now(),now())`,
    [scope.userId, scope.tenantId, `${suffix}@example.invalid`],
  );
  await administrativePool.query(
    `INSERT INTO "${schema}".agent_revisions(id,definition_id,revision,status,content,content_digest,created_by) SELECT $1,r.definition_id,1000+$2::int,'draft',r.content,r.content_digest,$3 FROM "${schema}".agent_definitions d JOIN "${schema}".agent_revisions r ON r.id=d.current_revision_id WHERE d.id='agent_default'`,
    [`eval_revision_${suffix}`, suffix === "limits" ? 1 : 2, scope.userId],
  );
  const repo = new PgEvaluationRepository(adminControlPool),
    command = new PgEvaluationCommand(runtimePool),
    explorer = new PgAdminRunExplorerRepository(adminControlPool);
  const driver = new PgEvaluationDriver(
    adminControlPool,
    (c) => command.execute(c),
    (a, t, r) => explorer.evaluationEvidence(a, t, r),
    { globalLimit, leaseMs: 30000, pollMs: 60000 },
  );
  return {
    repo,
    command,
    driver,
    actor: scope.userId,
    sql: administrativePool,
    schema,
    adminControlPool,
    runtimePool,
    repositories,
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

const externalToolFixtureDraftIds = new Set<string>();

afterEach(async () => {
  if (externalToolFixtureDraftIds.size === 0) return;
  const draftIds = [...externalToolFixtureDraftIds];
  await withTransaction(migratorPool, async (client) => {
    await client.query(
      `DELETE FROM external_tool_publish_batch_versions WHERE batch_id IN
         (SELECT batch_id FROM external_tool_publish_batches WHERE draft_id=ANY($1::text[]))`,
      [draftIds],
    );
    await client.query("DELETE FROM external_tool_publish_batches WHERE draft_id=ANY($1::text[])", [
      draftIds,
    ]);
    await client.query(
      "DELETE FROM external_tool_registration_drafts WHERE draft_id=ANY($1::text[])",
      [draftIds],
    );
  });
  externalToolFixtureDraftIds.clear();
});

async function createExternalToolFixture(suffix: string) {
  const manager = await createFixture(`external_${suffix}`);
  await migratorPool.query(
    "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
    [manager.user.id],
  );
  const credentialKey = "b5-placeholder-credential-key".repeat(2);
  const registry = new PgExternalToolRegistry(
    adminControlPool,
    new ExternalToolCredentialCipher(credentialKey),
  );
  const inputSchema = normalizeExternalToolSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
  const versionId = `external-${suffix}-v1`;
  const outsideVersionId = `external-${suffix}-v2`;
  const toolName = "http__b5_lookup";
  const draftId = `external-${suffix}-draft`;
  await migratorPool.query(
    `INSERT INTO external_tool_registration_drafts(draft_id,source,display_name,server_name,endpoint,timeout_ms,max_response_bytes,side_effect,idempotent,created_by,updated_by)
       VALUES($1,'mcp','测试外部工具','b5_lookup','https://tools.example.invalid/lookup',1000,512,'write',false,$2,$2)`,
    [draftId, manager.user.id],
  );
  externalToolFixtureDraftIds.add(draftId);
  let sequence = 0;
  for (const toolVersionId of [versionId, outsideVersionId]) {
    await registry.publish({
      actorUserId: manager.user.id,
      tool: {
        toolVersionId,
        source: "http",
        endpoint: "https://tools.example.invalid/lookup",
        modelToolName: toolName,
        remoteToolName: null,
        httpMethod: "POST",
        description: "测试外部工具",
        inputSchema: inputSchema.schema,
        inputSchemaDigest: inputSchema.digest,
        timeoutMs: 1000,
        maxResponseBytes: 512,
        sideEffect: "write",
        idempotent: false,
        credentialRef: "b5-placeholder-reference",
      },
      credential: "b5-placeholder-credential",
    });
    const batchId = `${toolVersionId}-batch`;
    await migratorPool.query(
      `INSERT INTO external_tool_publish_batches(batch_id,draft_id,sequence,draft_generation,display_name,source,server_name,endpoint,created_by)
         VALUES($1,$2,$3,0,'测试外部工具','http','b5_lookup','https://tools.example.invalid/lookup',$4)`,
      [batchId, draftId, ++sequence, manager.user.id],
    );
    await migratorPool.query(
      "INSERT INTO external_tool_publish_batch_versions(batch_id,tool_version_id) VALUES($1,$2)",
      [batchId, toolVersionId],
    );
  }
  const defaults = await readDefaultAgentRevision();
  if (defaults === undefined) throw new Error("默认 Agent Revision 不可见");
  const agents = new PgAgentDefinitionRepository(adminControlPool);
  const draft = await agents.createDraft({
    actorUserId: manager.user.id,
    id: `agent_external_${suffix}`,
    availability: { mode: "selected_tenants", tenantIds: [manager.tenant.id] },
    content: {
      ...defaults.content,
      tools: {
        mode: "configured",
        builtinTools: [],
        externalTools: [{ kind: "http", versionId }],
        clientTools: [],
        toolCallingMode: "native",
      },
    },
    revisionId: `agent_external_${suffix}_v1`,
    idempotencyKey: `external-${suffix}-draft`,
    expectedGeneration: 0,
  });
  await agents.publish({
    actorUserId: manager.user.id,
    definitionId: draft.definition.id,
    revisionId: draft.revision.id,
    idempotencyKey: `external-${suffix}-publish`,
    expectedGeneration: draft.definition.generation,
  });
  const thread = rehydrateThread(
    {
      ...manager.thread,
      id: threadId(`thread_external_${suffix}_bound`),
      agentDefinitionId: draft.definition.id,
    },
    manager.tenant,
    manager.user,
    manager.membership,
  );
  expect(await repositories.threads.create(manager.scope, thread)).toMatchObject({
    outcome: "created",
  });
  const workspace = createWorkspace({
    id: workspaceId(`workspace_external_${suffix}_bound`),
    thread,
    now: timestamp(4),
  });
  expect(await repositories.workspaces.create(manager.scope, workspace)).toEqual({
    outcome: "created",
  });
  const run = createRun({ id: runId(`run_external_${suffix}_bound`), thread, now: timestamp(5) });
  expect(
    await new PgRunDispatchCreation(runtimePool).createQueuedRun({
      scope: manager.scope,
      thread,
      run,
      inputText: "执行外部工具",
      idempotency: { key: `external-${suffix}-run`, requestHash: sha256Digest("0".repeat(64)) },
    }),
  ).toMatchObject({ outcome: "created" });
  const scope = {
    tenantId: manager.scope.tenantId,
    threadId: thread.id,
    runId: run.id,
    rootRunId: run.id,
    workspaceId: workspace.id,
  };
  const worker = new PgExecutionPersistence(runtimePool);
  const claimed = await worker.claim({
    scope,
    workerId: `external-${suffix}`,
    leaseDurationMs: 120_000,
  });
  if (claimed.outcome !== "claimed") throw new Error(`外部工具测试领取失败：${claimed.outcome}`);
  const reader = new PgExternalToolSnapshotReader(
    workerCoordinatorPool,
    new ExternalToolCredentialDecryptor(credentialKey),
  );
  const call = {
    callId: `external-${suffix}-call`,
    toolName,
    toolVersionId: versionId,
    argsDigest: sha256Digest("a".repeat(64)),
  };
  const issue = async (toolVersionId = versionId) => {
    const unsigned = {
      schemaVersion: 1 as const,
      idempotencyKey: `external-${suffix}-started`,
      fence: claimed.fence,
      expectedAttemptVersion: 0,
      events: [
        {
          schemaVersion: 1 as const,
          kind: "agent_event" as const,
          sequence: 0,
          payload: { type: "tool.started" as const, callId: call.callId, name: toolName },
        },
      ],
      outbox: [],
      effectInvocation: { callId: call.callId, toolName },
    };
    expect(
      await worker.mutate({ ...unsigned, commandDigest: runtimeMutationDigest(unsigned) }),
    ).toMatchObject({ outcome: "applied" });
    const authorized = await worker.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 1,
      effect: "tool_execution",
      call: { ...call, toolVersionId },
      permitDurationMs: 60_000,
    });
    if (authorized.outcome !== "authorized")
      throw new Error(`外部工具测试许可失败：${authorized.outcome}`);
    return authorized.permit;
  };
  return {
    manager,
    versionId,
    outsideVersionId,
    toolName,
    registry,
    worker,
    reader,
    fence: claimed.fence,
    issue,
  };
}

async function waitForDatabaseBlocker(blockerPid: number): Promise<void> {
  for (let retry = 0; retry < 200; retry += 1) {
    const result = await administrativePool.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",
      [blockerPid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("未观察到预期的 PostgreSQL 行锁等待");
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
    readonly webhookDispatcherRole: string;
    readonly schema: string;
  };
  readonly webhookDispatcherConnectionString: string;
  readonly runtimeConnectionString: string;
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
  const isolatedWebhookDispatcherRole = `it_webhook_${isolatedSuffix}`;
  const isolatedRuntimeRole = `it_runtime_${isolatedSuffix}`;
  const password = randomBytes(24).toString("hex");
  const isolatedRuntimeUrl = new URL(runtimeDatabaseUrl);
  isolatedRuntimeUrl.username = isolatedRuntimeRole;
  isolatedRuntimeUrl.password = password;
  const isolatedWebhookDispatcherUrl = new URL(migrationDatabaseUrl);
  isolatedWebhookDispatcherUrl.username = isolatedWebhookDispatcherRole;
  isolatedWebhookDispatcherUrl.password = password;
  const isolatedSchema = `it_${suffix}_${isolatedSuffix}`;
  const url = new URL(migrationDatabaseUrl);
  url.username = isolatedRole;
  url.password = password;
  await administrativePool.query(
    `CREATE ROLE "${isolatedRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedRuntimeRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedPublisherRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedCoordinatorRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedTeamCoordinatorRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedAdminControlRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     CREATE ROLE "${isolatedWebhookDispatcherRole}" LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${isolatedRole}", "${isolatedRuntimeRole}", "${isolatedPublisherRole}", "${isolatedCoordinatorRole}", "${isolatedTeamCoordinatorRole}", "${isolatedAdminControlRole}", "${isolatedWebhookDispatcherRole}";
     CREATE SCHEMA "${isolatedSchema}" AUTHORIZATION "${isolatedRole}"`,
  );
  await withTransaction(administrativePool, (client) =>
    bootstrapEvaluationRole(client, isolatedRuntimeRole),
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
      runtimeRole: isolatedRuntimeRole,
      migratorRole: isolatedRole,
      skillPublisherRole: isolatedPublisherRole,
      workerCoordinatorRole: isolatedCoordinatorRole,
      teamCoordinatorRole: isolatedTeamCoordinatorRole,
      adminControlRole: isolatedAdminControlRole,
      webhookDispatcherRole: isolatedWebhookDispatcherRole,
      schema: isolatedSchema,
    },
    webhookDispatcherConnectionString: isolatedWebhookDispatcherUrl.toString(),
    runtimeConnectionString: isolatedRuntimeUrl.toString(),
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
      await administrativePool.query(
        `DROP SCHEMA "${isolatedSchema}" CASCADE;
         REVOKE "${evaluationRoleName(isolatedRuntimeRole)}" FROM "${isolatedRuntimeRole}";
         REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${isolatedRole}", "${isolatedRuntimeRole}", "${isolatedPublisherRole}", "${isolatedCoordinatorRole}", "${isolatedTeamCoordinatorRole}", "${isolatedAdminControlRole}", "${isolatedWebhookDispatcherRole}";
         DROP ROLE "${isolatedWebhookDispatcherRole}";
         DROP ROLE "${isolatedAdminControlRole}";
         DROP ROLE "${isolatedTeamCoordinatorRole}";
         DROP ROLE "${isolatedCoordinatorRole}";
         DROP ROLE "${isolatedPublisherRole}";
         DROP ROLE "${isolatedRole}";
         DROP ROLE "${evaluationRoleName(isolatedRuntimeRole)}";
         DROP ROLE "${isolatedRuntimeRole}"`,
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
  workerCoordinatorPool = createPostgresPool({
    connectionString: workerCoordinatorDatabaseUrl.toString(),
    schema,
    maxConnections: 4,
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
  if (workerCoordinatorPool !== undefined) await workerCoordinatorPool.end();
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

function webhookSecret(tag: string) {
  return { version: 1 as const, nonce: `n_${tag}`, ciphertext: `c_${tag}`, authTag: `t_${tag}` };
}

async function asTenant<T>(
  pool: Pool,
  tenant: string,
  user: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(pool, { tenantId: tenant, userId: user }, operation);
}

async function webhookIsolatedPools(target: IsolatedMigrationTarget) {
  const teamUrl = new URL(target.webhookDispatcherConnectionString);
  teamUrl.username = target.context.teamCoordinatorRole;
  const pools = {
    dispatcher: createPostgresPool({
      connectionString: target.webhookDispatcherConnectionString,
      schema: target.context.schema,
      maxConnections: 2,
    }),
    runtime: createPostgresPool({
      connectionString: target.runtimeConnectionString,
      schema: target.context.schema,
      maxConnections: 2,
    }),
    team: createPostgresPool({
      connectionString: teamUrl.toString(),
      schema: target.context.schema,
      maxConnections: 1,
    }),
  };
  return {
    ...pools,
    close: async () => {
      await Promise.all([pools.dispatcher.end(), pools.runtime.end(), pools.team.end()]);
    },
  };
}

async function seedWebhookTenant(target: IsolatedMigrationTarget, label: string) {
  const tenant = tenantId(`tenant_webhook_${label}_${process.pid}`);
  const user = userId(`user_webhook_${label}_${process.pid}`);
  await administrativePool.query(
    `INSERT INTO "${target.context.schema}".app_users(id,created_at) VALUES($1,clock_timestamp())`,
    [user],
  );
  await administrativePool.query(
    `INSERT INTO "${target.context.schema}".tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,clock_timestamp())`,
    [tenant, user],
  );
  await administrativePool.query(
    `INSERT INTO "${target.context.schema}".memberships(tenant_id,id,user_id,role,status,created_at)
     VALUES($1,$2,$3,'owner','active',clock_timestamp())`,
    [tenant, `membership_${label}_${process.pid}`, user],
  );
  return { tenant, user };
}

async function seedWebhookRun(
  target: IsolatedMigrationTarget,
  tenant: string,
  user: string,
  runId: string,
  origin: "normal" | "evaluation" = "normal",
) {
  const threadId = `thread_${runId}`;
  await administrativePool.query(
    `INSERT INTO "${target.context.schema}".threads(tenant_id,id,created_by_user_id,title,status,is_evaluation,created_at,updated_at)
     VALUES($1,$2,$3,'Webhook fixture','active',$4,clock_timestamp(),clock_timestamp())`,
    [tenant, threadId, user, origin === "evaluation"],
  );
  await administrativePool.query(
    `INSERT INTO "${target.context.schema}".runs(tenant_id,id,thread_id,status,created_at,updated_at,origin)
     VALUES($1,$2,$3,'succeeded',clock_timestamp(),clock_timestamp(),$4)`,
    [tenant, runId, threadId, origin],
  );
}

describe("PostgreSQL 迁移与强权限边界", () => {
  it("评测角色只允许 Runtime 显式切换，并拒绝危险属性、越权成员与权限继承", async () => {
    const runtime = `it_eval_${process.pid}_`.padEnd(63, "x");
    const evaluation = evaluationRoleName(runtime);
    const stranger = `it_eval_stranger_${process.pid}`;
    await administrativePool.query(`CREATE ROLE "${runtime}" NOLOGIN NOINHERIT;
      CREATE ROLE "${stranger}" NOLOGIN NOINHERIT`);
    try {
      await withTransaction(administrativePool, (client) =>
        bootstrapEvaluationRole(client, runtime),
      );
      await withTransaction(administrativePool, (client) =>
        bootstrapEvaluationRole(client, runtime),
      );
      const privileges = await administrativePool.query<{
        can_set: boolean;
        inherits: boolean;
        name: string;
      }>(
        `SELECT pg_has_role($1,$2,'SET') AS can_set,pg_has_role($1,$2,'USAGE') AS inherits,
          (CASE WHEN length($1::text)<=52 THEN $1::text ELSE left($1::text,43)||'_'||left(md5($1::text),8) END || '_evaluation') AS name`,
        [runtime, evaluation],
      );
      expect(privileges.rows).toEqual([{ can_set: true, inherits: false, name: evaluation }]);
      for (const [unsafe, restore] of [
        [`ALTER ROLE "${evaluation}" LOGIN`, `ALTER ROLE "${evaluation}" NOLOGIN`],
        [`ALTER ROLE "${evaluation}" INHERIT`, `ALTER ROLE "${evaluation}" NOINHERIT`],
        [`ALTER ROLE "${evaluation}" BYPASSRLS`, `ALTER ROLE "${evaluation}" NOBYPASSRLS`],
        [
          `GRANT "${evaluation}" TO "${runtime}" WITH INHERIT TRUE`,
          `GRANT "${evaluation}" TO "${runtime}" WITH INHERIT FALSE`,
        ],
        [
          `GRANT "${evaluation}" TO "${runtime}" WITH ADMIN TRUE`,
          `GRANT "${evaluation}" TO "${runtime}" WITH ADMIN FALSE`,
        ],
        [
          `GRANT "${evaluation}" TO "${runtime}" WITH SET FALSE`,
          `GRANT "${evaluation}" TO "${runtime}" WITH SET TRUE`,
        ],
        [`GRANT "${evaluation}" TO "${stranger}"`, `REVOKE "${evaluation}" FROM "${stranger}"`],
        [`GRANT "${stranger}" TO "${evaluation}"`, `REVOKE "${stranger}" FROM "${evaluation}"`],
      ] as const) {
        await administrativePool.query(unsafe);
        try {
          await expect(
            withTransaction(administrativePool, (client) =>
              assertEvaluationRoleSafe(client, runtime),
            ),
          ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
        } finally {
          await administrativePool.query(restore);
        }
      }
    } finally {
      await administrativePool.query(`DROP ROLE IF EXISTS "${evaluation}";
        DROP ROLE "${runtime}"; DROP ROLE "${stranger}"`);
    }
  });

  it("拒绝已有评测角色携带同库其他 Schema 的有效对象权限", async () => {
    const schema = `it_eval_sensitive_${process.pid}`;
    const target = await createIsolatedMigrationTarget("eval_cross_schema");
    try {
      await migrateUp(target.pool, target.context);
      const evaluation = evaluationRoleName(target.context.runtimeRole);
      await administrativePool.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".secret(value text);
        GRANT USAGE ON SCHEMA "${schema}" TO "${evaluation}";
        GRANT SELECT ON "${schema}".secret TO "${evaluation}"`);
      await expect(
        withTransaction(target.pool, (client) =>
          bootstrapRuntimeAccessOnClient(client, target.context),
        ),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    } finally {
      await administrativePool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await target.close();
    }
  });

  it("拒绝评测角色及 PUBLIC 的大对象 SELECT 与 UPDATE 权限", async () => {
    const target = await createIsolatedMigrationTarget("eval_large_object");
    let largeObjectId: string | undefined;
    try {
      await migrateUp(target.pool, target.context);
      const evaluation = evaluationRoleName(target.context.runtimeRole);
      const created = await administrativePool.query<{ oid: string }>(
        "SELECT lo_create(0)::text AS oid",
      );
      largeObjectId = created.rows[0]?.oid;
      if (!largeObjectId) throw new Error("未创建测试大对象");
      for (const [privilege, grantee] of [
        ["SELECT", `"${evaluation}"`],
        ["UPDATE", `"${evaluation}"`],
        ["SELECT", "PUBLIC"],
        ["UPDATE", "PUBLIC"],
      ] as const) {
        await administrativePool.query(
          `GRANT ${privilege} ON LARGE OBJECT ${largeObjectId} TO ${grantee}`,
        );
        await expect(
          withTransaction(administrativePool, (client) =>
            assertEvaluationRoleSafe(client, target.context.runtimeRole),
          ),
        ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
        await administrativePool.query(
          `REVOKE ${privilege} ON LARGE OBJECT ${largeObjectId} FROM ${grantee}`,
        );
      }
    } finally {
      if (largeObjectId)
        await administrativePool.query("SELECT lo_unlink($1::oid)", [largeObjectId]);
      await target.close();
    }
  });

  it("在对象创建前拒绝全局及 Schema 局部默认 ACL", async () => {
    const target = await createIsolatedMigrationTarget("eval_default_acl");
    const futureSchema = `it_eval_future_${process.pid}_${isolatedMigrationCounter}`;
    let evaluation: string | undefined;
    try {
      await migrateUp(target.pool, target.context);
      evaluation = evaluationRoleName(target.context.runtimeRole);
      await administrativePool.query(
        `CREATE SCHEMA "${futureSchema}" AUTHORIZATION "${target.context.migratorRole}"`,
      );
      await expect(
        withTransaction(administrativePool, (client) =>
          assertEvaluationRoleSafe(client, target.context.runtimeRole),
        ),
      ).resolves.toBeUndefined();

      await administrativePool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${target.context.migratorRole}"
           GRANT SELECT ON TABLES TO "${evaluation}"`,
      );
      await expect(
        withTransaction(administrativePool, (client) =>
          assertEvaluationRoleSafe(client, target.context.runtimeRole),
        ),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      await target.pool.query(`CREATE TABLE "${futureSchema}".future_global(value integer)`);
      await expect(
        target.pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
          [evaluation, `${futureSchema}.future_global`],
        ),
      ).resolves.toMatchObject({ rows: [{ allowed: true }] });
      await administrativePool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${target.context.migratorRole}"
           REVOKE SELECT ON TABLES FROM "${evaluation}"`,
      );

      await administrativePool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${target.context.migratorRole}"
           IN SCHEMA "${futureSchema}" GRANT SELECT ON TABLES TO PUBLIC`,
      );
      await expect(
        withTransaction(administrativePool, (client) =>
          assertEvaluationRoleSafe(client, target.context.runtimeRole),
        ),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      await target.pool.query(`CREATE TABLE "${futureSchema}".future_public(value integer)`);
      await expect(
        target.pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
          [evaluation, `${futureSchema}.future_public`],
        ),
      ).resolves.toMatchObject({ rows: [{ allowed: true }] });
    } finally {
      await administrativePool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${target.context.migratorRole}"
           REVOKE SELECT ON TABLES FROM "${evaluation}";
         ALTER DEFAULT PRIVILEGES FOR ROLE "${target.context.migratorRole}"
           REVOKE SELECT ON TABLES FROM PUBLIC;
         ALTER DEFAULT PRIVILEGES FOR ROLE "${target.context.migratorRole}"
           IN SCHEMA "${futureSchema}" REVOKE SELECT ON TABLES FROM PUBLIC;
         DROP SCHEMA IF EXISTS "${futureSchema}" CASCADE`,
      );
      await target.close();
    }
  });

  it("仅允许受控超级用户预置评测角色", async () => {
    const admin = `it_eval_admin_${process.pid}`;
    const runtime = `it_eval_runtime_${process.pid}`;
    const evaluation = evaluationRoleName(runtime);
    await administrativePool.query(`CREATE ROLE "${admin}" NOLOGIN CREATEROLE NOINHERIT;
      CREATE ROLE "${runtime}" NOLOGIN NOINHERIT`);
    try {
      await withTransaction(administrativePool, async (client) => {
        await client.query(`SET LOCAL ROLE "${admin}"`);
        await expect(bootstrapEvaluationRole(client, runtime)).rejects.toThrow(
          "受控 PostgreSQL 超级用户",
        );
      });
      const role = await administrativePool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
        evaluation,
      ]);
      expect(role.rowCount).toBe(0);
    } finally {
      await administrativePool.query(`DROP ROLE IF EXISTS "${evaluation}";
        DROP ROLE "${runtime}"; DROP ROLE "${admin}"`);
    }
  });

  it("迁移前置检查对缺失评测角色给出生产预置步骤", async () => {
    await expect(
      withTransaction(administrativePool, (client) =>
        assertEvaluationRoleSafe(client, `it_eval_missing_${process.pid}`),
      ),
    ).rejects.toThrow("先按生产数据库升级步骤预置评测角色");
  });

  it("迁移缺少派生评测角色时在任何 DDL 前指向生产预置入口", async () => {
    const target = await createIsolatedMigrationTarget("missing_evaluation_role");
    const evaluation = evaluationRoleName(target.context.runtimeRole);
    await administrativePool.query(`REVOKE "${evaluation}" FROM "${target.context.runtimeRole}";
      DROP ROLE "${evaluation}"`);
    try {
      await expect(migrateUp(target.pool, target.context)).rejects.toThrow(
        "pnpm db:evaluation-role:bootstrap",
      );
      const migrationTable = await target.pool.query<{ readonly exists: boolean }>(
        "SELECT to_regclass('runtime_schema_migrations') IS NOT NULL AS exists",
      );
      expect(migrationTable.rows[0]?.exists).toBe(false);
    } finally {
      await withTransaction(administrativePool, (client) =>
        bootstrapEvaluationRole(client, target.context.runtimeRole),
      );
      await target.close();
    }
  });

  it("评测 SET LOCAL ROLE 在提交、应用异常、SQL 错误与 stale 命令后不泄漏到池中下一事务", async () => {
    const target = await createIsolatedMigrationTarget("eval_pool");
    const pool = createPostgresPool({
      connectionString: target.runtimeConnectionString,
      schema: target.context.schema,
      maxConnections: 1,
      preparedStatements: true,
    });
    try {
      await migrateUp(target.pool, target.context);
      const fixture = await createFixture("eval_pool", new PgCoreRepositories(pool));
      const identity = () =>
        withTransaction(pool, (client) =>
          client.query<{ pid: number; role: string; login: string }>(
            "SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS login",
          ),
        );
      const original = (await identity()).rows;
      expect(original[0]).toMatchObject({
        role: target.context.runtimeRole,
        login: target.context.runtimeRole,
      });
      for (const outcome of ["commit", "application_error", "sql_error"] as const) {
        const transaction = withTenantTransaction(pool, fixture.scope, async (client) => {
          await setLocalEvaluationRole(client);
          const privileges = await client.query<{ safe: boolean }>(
            `SELECT NOT has_table_privilege(current_user,'external_tool_credentials','SELECT')
              AND NOT has_table_privilege(current_user,'agent_evaluation_cases','SELECT')
              AND NOT has_table_privilege(current_user,'runs','DELETE')
              AND NOT has_column_privilege(current_user,'run_agent_snapshots','content','UPDATE')
              AND NOT has_column_privilege(current_user,'threads','status','UPDATE')
              AND NOT has_column_privilege(current_user,'workspaces','current_revision_id','UPDATE')
              AND NOT has_column_privilege(current_user,'memberships','status','UPDATE') AS safe`,
          );
          expect(privileges.rows).toEqual([{ safe: true }]);
          for (let iteration = 0; iteration < 7; iteration++) {
            const identity = await client.query<{ role: string; login: string }>(
              "SELECT current_user AS role,session_user AS login,$1::text AS marker",
              ["role_cache"],
            );
            expect(identity.rows[0]).toMatchObject({
              role: evaluationRoleName(target.context.runtimeRole),
              login: target.context.runtimeRole,
            });
          }
          if (outcome === "application_error") throw new Error("测试应用异常");
          if (outcome === "sql_error") await client.query("SELECT 1/0");
        });
        if (outcome === "commit") await transaction;
        else await expect(transaction).rejects.toThrow();
        expect((await identity()).rows).toEqual(original);
      }
      await expect(
        new PgEvaluationCommand(pool).execute({
          ...fixture.scope,
          batchId: "missing_batch",
          token: "00000000-0000-0000-0000-000000000000",
          generation: "1",
          plannedRunId: "missing_run",
        }),
      ).resolves.toBe("stale");
      expect((await identity()).rows).toEqual(original);
      await expect(
        withTenantTransaction(pool, fixture.scope, (client) =>
          client.query("SELECT * FROM evaluation_run_command"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await identity()).rows).toEqual(original);
    } finally {
      await pool.end();
      await target.close();
    }
  });

  it("评测策略不进入普通 custom/generic 计划，且可回滚重放", async () => {
    const target = await createIsolatedMigrationTarget("eval_plan");
    const pool = createPostgresPool({
      connectionString: target.runtimeConnectionString,
      schema: target.context.schema,
    });
    try {
      await migrateUp(target.pool, target.context);
      const fixture = await createFixture("eval_plan", new PgCoreRepositories(pool));
      interface PlanNode {
        readonly "Relation Name"?: string;
        readonly "Parent Relationship"?: string;
        readonly "Actual Loops": number;
        readonly "Actual Rows": number;
        readonly Plans?: readonly PlanNode[];
      }
      const evaluationNodes = (node: PlanNode): readonly PlanNode[] => {
        if (node["Relation Name"]?.startsWith("agent_evaluation_")) {
          return [node];
        }
        return (node.Plans ?? []).flatMap((child) => evaluationNodes(child));
      };
      const planningTimes = { isolated: [] as number[], runtime: [] as number[] };
      const assertFastPath = async (isolated = true) => {
        for (const scope of [fixture.scope, { tenantId: fixture.scope.tenantId }]) {
          for (const mode of ["force_custom_plan", "force_generic_plan"]) {
            await withTenantTransaction(pool, scope, async (client) => {
              await client.query("SELECT set_config('plan_cache_mode',$1,true)", [mode]);
              for (const batch of [undefined, "", "forged_batch"]) {
                if (batch !== undefined) {
                  await client.query("SELECT set_config('app.evaluation_batch',$1,true)", [batch]);
                }
                const statements = [
                  ["threads", "SELECT id FROM threads WHERE tenant_id=$1 AND id=$2"],
                  ["runs", "SELECT id FROM runs WHERE tenant_id=$1 AND thread_id=$2"],
                  [
                    "revisions",
                    "SELECT id FROM agent_revisions WHERE definition_id=$1 AND status=$2",
                  ],
                  ["definitions", "SELECT id FROM agent_definitions WHERE id=$1 AND status=$2"],
                  [
                    "snapshot_read",
                    "SELECT run_id FROM run_agent_snapshots WHERE tenant_id=$1 AND thread_id=$2",
                  ],
                  [
                    "snapshot",
                    `INSERT INTO run_agent_snapshots(tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content)
                  SELECT t.tenant_id,t.id,t.id,d.id,r.id,r.content_digest,r.content FROM threads t
                  JOIN agent_definitions d ON d.id=t.agent_definition_id AND d.status='published'
                  JOIN agent_revisions r ON r.definition_id=d.id AND r.id=d.current_revision_id AND r.status='published'
                  WHERE t.tenant_id=$1 AND t.id=$2 AND (d.availability_mode='all_tenants' OR EXISTS (
                    SELECT 1 FROM agent_definition_tenants scope
                     WHERE scope.definition_id=d.id AND scope.tenant_id=t.tenant_id AND scope.available
                  )) RETURNING run_id`,
                  ],
                ] as const;
                for (const [name, statement] of statements) {
                  const values =
                    name === "revisions" || name === "definitions"
                      ? "'agent_default','published'"
                      : `'${fixture.scope.tenantId}','${fixture.thread.id}'`;
                  await client.query(`PREPARE eval_plan_${name}(text,text) AS ${statement}`);
                  try {
                    await client.query("SAVEPOINT evaluation_plan");
                    const plan = await client.query<{
                      "QUERY PLAN": readonly { Plan: PlanNode; "Planning Time": number }[];
                    }>(
                      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE eval_plan_${name}(${values})`,
                    );
                    const root = plan.rows[0]?.["QUERY PLAN"][0]?.Plan;
                    expect(root).toBeDefined();
                    if (!root) throw new Error("缺少执行计划");
                    expect(root["Actual Rows"]).toBeGreaterThan(0);
                    if (isolated)
                      expect(evaluationNodes(root), `${mode}/${name}/${batch ?? "unset"}`).toEqual(
                        [],
                      );
                    if (isolated)
                      expect(JSON.stringify(root)).not.toMatch(
                        /agent_evaluation_|evaluation_run_command|app\.evaluation_/u,
                      );
                    if (mode === "force_custom_plan" && name === "snapshot") {
                      const planning = plan.rows[0]?.["QUERY PLAN"][0]?.["Planning Time"];
                      if (planning !== undefined)
                        planningTimes[isolated ? "isolated" : "runtime"].push(planning);
                    }
                    await client.query("ROLLBACK TO SAVEPOINT evaluation_plan");
                    await client.query("RELEASE SAVEPOINT evaluation_plan");
                  } finally {
                    await client.query(`DEALLOCATE eval_plan_${name}`);
                  }
                }
              }
            });
          }
        }
      };
      await assertFastPath();
      const migration = (await loadMigrations()).find(
        (migration) => migration.name === "evaluation_role",
      );
      if (!migration) throw new Error("缺少评测策略迁移");
      await migrateDown(target.pool, {
        ...target.context,
        targetVersion: migration.version - 1,
        allowDestructive: true,
        environment: "test",
      });
      const restored = await target.pool.query<{ predicate: string }>(
        `SELECT pg_get_expr(polqual,polrelid) AS predicate FROM pg_policy
          WHERE polrelid='agent_revisions'::regclass AND polname='evaluation_revision_read'`,
      );
      expect(restored.rows[0]?.predicate).toContain("CASE");
      await expect(assertFastPath()).rejects.toThrow();
      await assertFastPath(false);
      await migrateUp(target.pool, target.context);
      await assertFastPath();
      const median = (values: readonly number[]) =>
        [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
      console.info(
        `快照 INSERT Planning Time 中位数(ms)：Runtime 策略=${median(planningTimes.runtime)} (n=${planningTimes.runtime.length})，专用评测角色=${median(planningTimes.isolated)} (n=${planningTimes.isolated.length})`,
      );
    } finally {
      await pool.end();
      await target.close();
    }
  });

  it("评测命令只授权租约的 planned Run，并拒绝伪造来源与快照", async () => {
    const { actor, repo, command, driver, sql, schema, runtimePool } = await evaluationFixture(
      "rls_scope",
      2,
    );
    await repo.saveSuite(actor, {
      id: "eval_rls_scope",
      definitionId: "agent_default",
      name: "命令范围",
      description: "",
      cases: ["first", "second"].map((id) => ({
        id,
        name: id,
        inputText: "输入",
        attachments: [],
        assertions: [],
      })),
    });
    await repo.startRun(actor, {
      id: "eval_rls_scope_batch",
      definitionId: "agent_default",
      suiteId: "eval_rls_scope",
      revisionId: "eval_revision_rls_scope",
      maxConcurrency: 2,
    });
    const first = await driver.claim();
    const second = await driver.claim();
    if (!first || !second) throw new Error("缺少并发评测租约");
    expect(await command.execute(first)).toBe("active");
    expect(await command.execute(second)).toBe("active");
    await sql.query(
      `INSERT INTO "${schema}".agent_revisions(id,definition_id,revision,status,content,content_digest,created_by)
       SELECT 'eval_revision_rls_other',definition_id,1003,'draft',content,content_digest,$1
         FROM "${schema}".agent_revisions WHERE id='eval_revision_rls_scope'`,
      [actor],
    );
    const scope = { tenantId: tenantId(first.tenantId), userId: userId(actor) };
    const inCommand = <Result>(action: (client: PoolClient) => Promise<Result>, lease = first) =>
      withTenantTransaction(runtimePool, scope, async (client) => {
        await setLocalEvaluationRole(client);
        await client.query(
          "SELECT set_config('app.evaluation_batch',$1,true),set_config('app.evaluation_token',$2,true),set_config('app.evaluation_generation',$3,true)",
          [lease.batchId, lease.token, lease.generation],
        );
        return action(client);
      });
    await expect(
      withTenantTransaction(runtimePool, scope, async (client) => {
        await setLocalEvaluationRole(client);
        return client.query(
          `INSERT INTO worker_tenant_assignments(tenant_id,state,next_attempt_at)
           VALUES($1,'ready',clock_timestamp())`,
          [scope.tenantId],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inCommand((client) =>
        client.query(
          `INSERT INTO worker_tenant_assignments(tenant_id,state,next_attempt_at)
           VALUES('other_tenant','ready',clock_timestamp())`,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const table of ["threads", "runs"] as const) {
      const statement = `SELECT id FROM ${table} WHERE id=ANY($1::text[]) ORDER BY id`;
      const ids = [first.plannedRunId, second.plannedRunId];
      expect(
        (
          await withTenantTransaction(runtimePool, scope, (client) =>
            client.query(statement, [ids]),
          )
        ).rows,
      ).toEqual([]);
      expect((await inCommand((client) => client.query(statement, [ids]))).rows).toEqual([
        { id: first.plannedRunId },
      ]);
      for (const lease of [
        { ...first, batchId: "another_batch" },
        { ...first, token: "00000000-0000-0000-0000-000000000000" },
        { ...first, generation: String(Number(first.generation) + 1) },
      ]) {
        expect((await inCommand((client) => client.query(statement, [ids]), lease)).rows).toEqual(
          [],
        );
      }
    }
    const snapshot = (
      await sql.query<{
        definition_id: string;
        revision_id: string;
        revision_digest: string;
        content: unknown;
      }>(
        `SELECT definition_id,revision_id,revision_digest,content FROM "${schema}".run_agent_snapshots WHERE run_id=$1`,
        [first.plannedRunId],
      )
    ).rows[0];
    if (!snapshot) throw new Error("缺少评测快照");
    const insertSnapshot = (
      client: PoolClient,
      id: string,
      revisionId: string,
      digest: string,
      content: unknown,
    ) =>
      client.query(
        `INSERT INTO run_agent_snapshots(tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content)
       VALUES($1,$2,$2,$3,$4,$5,$6)`,
        [scope.tenantId, id, snapshot.definition_id, revisionId, digest, content],
      );
    for (const [id, revisionId, digest, content] of [
      [second.plannedRunId, snapshot.revision_id, snapshot.revision_digest, snapshot.content],
      [first.plannedRunId, "eval_revision_rls_other", snapshot.revision_digest, snapshot.content],
      [first.plannedRunId, snapshot.revision_id, "0".repeat(64), snapshot.content],
      [first.plannedRunId, snapshot.revision_id, snapshot.revision_digest, {}],
    ] as const) {
      await expect(
        inCommand((client) => insertSnapshot(client, id, revisionId, digest, content)),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await sql.query(`DELETE FROM "${schema}".run_agent_snapshots WHERE run_id=$1`, [
      first.plannedRunId,
    ]);
    const alternateContent = { alternate: "已发布 B" };
    const alternateDigest = "b".repeat(64);
    await sql.query(
      `INSERT INTO "${schema}".agent_revisions(id,definition_id,revision,status,content,content_digest,created_by)
       VALUES('eval_revision_rls_published_b',$1,1004,'published',$2,$3,$4)`,
      [snapshot.definition_id, alternateContent, alternateDigest, actor],
    );
    await sql.query(
      `UPDATE "${schema}".agent_definitions SET status='published',current_revision_id='eval_revision_rls_published_b'
        WHERE id=$1`,
      [snapshot.definition_id],
    );
    await expect(
      inCommand((client) =>
        insertSnapshot(
          client,
          first.plannedRunId,
          "eval_revision_rls_published_b",
          alternateDigest,
          alternateContent,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inCommand((client) =>
        insertSnapshot(
          client,
          first.plannedRunId,
          snapshot.revision_id,
          snapshot.revision_digest,
          snapshot.content,
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      inCommand((client) =>
        client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,is_evaluation,created_at,updated_at)
       VALUES($1,'forged_evaluation_thread',$2,'伪造评测','active',true,now(),now())`,
          [scope.tenantId, actor],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inCommand(
        (client) =>
          client.query(
            `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,is_evaluation,agent_definition_id,created_at,updated_at)
             VALUES($1,$2,$3,'伪装普通 Thread','active',false,$4,now(),now())`,
            [scope.tenantId, second.plannedRunId, actor, snapshot.definition_id],
          ),
        second,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inCommand((client) =>
        client.query(
          `INSERT INTO runs(tenant_id,id,thread_id,status,origin,created_at,updated_at)
       VALUES($1,'forged_evaluation_run',$2,'queued','evaluation',now(),now())`,
          [scope.tenantId, first.plannedRunId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("评测正文列仅经身份投影开放，结果只允许追加写入", async () => {
    const { actor, repo, adminControlPool, sql, schema } = await evaluationFixture("acl", 1);
    await repo.saveSuite(actor, {
      id: "eval_acl",
      definitionId: "agent_default",
      name: "权限投影",
      description: "",
      cases: [
        {
          id: "eval_acl_case",
          name: "正文",
          inputText: "不得给 operator 的正文",
          attachments: [],
          assertions: [{ kind: "text_contains", value: "通过" }],
        },
      ],
    });
    await sql.query(
      `UPDATE "${schema}".platform_control_operators SET role='operator' WHERE user_id=$1`,
      [actor],
    );
    const suites = await repo.listSuites(actor, "agent_default");
    expect(suites[0]).toMatchObject({
      contentAccess: false,
      cases: [{ inputText: "", attachments: [], assertions: [{ kind: "text_contains" }] }],
    });
    await expect(
      withTransaction(adminControlPool, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [actor]);
        return client.query(
          `SELECT input_text FROM agent_evaluation_cases WHERE id='eval_acl_case'`,
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
    const resultPrivileges = await adminControlPool.query<{
      update_allowed: boolean;
      delete_allowed: boolean;
      case_snapshot_select: boolean;
    }>(
      `SELECT has_table_privilege(current_user,'agent_evaluation_results','UPDATE') AS update_allowed,
              has_table_privilege(current_user,'agent_evaluation_results','DELETE') AS delete_allowed,
              has_column_privilege(current_user,'agent_evaluation_case_jobs','case_snapshot','SELECT') AS case_snapshot_select`,
    );
    expect(resultPrivileges.rows[0]).toEqual({
      update_allowed: false,
      delete_allowed: false,
      case_snapshot_select: false,
    });
  });

  it("评测身份失效仍可取消和清理，且用例版本固定并校验路径归属", async () => {
    const { actor, repo, command, driver, sql, schema } = await evaluationFixture("revoked", 1);
    const suite = {
      id: "eval_revoked",
      definitionId: "agent_default",
      name: "固定版本",
      description: "",
      cases: [
        {
          id: "eval_revoked_case",
          name: "待运行",
          inputText: "原正文",
          attachments: [],
          assertions: [{ kind: "text_contains" as const, value: "完成" }],
        },
      ],
    };
    await repo.saveSuite(actor, suite);
    await sql.query(`UPDATE "${schema}".user_accounts SET status='disabled' WHERE user_id=$1`, [
      actor,
    ]);
    await expect(
      repo.startRun(actor, {
        id: "eval_disabled_account",
        definitionId: "agent_default",
        suiteId: suite.id,
        revisionId: "eval_revision_revoked",
        maxConcurrency: 1,
      }),
    ).rejects.toThrow("评测执行空间不可用");
    await sql.query(`UPDATE "${schema}".user_accounts SET status='active' WHERE user_id=$1`, [
      actor,
    ]);
    expect(await repo.deleteSuite(actor, "agent_other", suite.id)).toBe(false);
    await expect(
      repo.startRun(actor, {
        id: "eval_wrong_agent",
        definitionId: "agent_other",
        suiteId: suite.id,
        revisionId: "eval_revision_revoked",
        maxConcurrency: 1,
      }),
    ).resolves.toBeUndefined();
    await repo.startRun(actor, {
      id: "eval_revoked_batch",
      definitionId: "agent_default",
      suiteId: suite.id,
      revisionId: "eval_revision_revoked",
      maxConcurrency: 1,
    });
    const lease = await driver.claim();
    if (!lease) throw new Error("缺少评测租约");
    expect(await command.execute(lease)).toBe("active");
    const snapshot = await sql.query<{ suite_version: string; content_version: string }>(
      `SELECT batch.suite_version::text,suite.content_version::text
         FROM "${schema}".agent_evaluation_runs batch
         JOIN "${schema}".agent_evaluation_suites suite ON suite.id=batch.suite_id
        WHERE batch.id='eval_revoked_batch'`,
    );
    expect(snapshot.rows[0]).toEqual({ suite_version: "1", content_version: "1" });

    await repo.saveSuite(actor, {
      ...suite,
      cases: [
        {
          id: "eval_revoked_case",
          name: "待运行",
          inputText: "更新后正文",
          attachments: [],
          assertions: [{ kind: "text_contains", value: "完成" }],
        },
      ],
    });
    const changed = await sql.query<{ suite_version: string; content_version: string }>(
      `SELECT batch.suite_version::text,suite.content_version::text
         FROM "${schema}".agent_evaluation_runs batch
         JOIN "${schema}".agent_evaluation_suites suite ON suite.id=batch.suite_id
        WHERE batch.id='eval_revoked_batch'`,
    );
    expect(changed.rows[0]).toEqual({ suite_version: "1", content_version: "2" });

    await sql.query(`UPDATE "${schema}".memberships SET status='revoked' WHERE user_id=$1`, [
      actor,
    ]);
    await repo.cancelRun(actor, "eval_revoked_batch");
    await driver.process(lease);
    expect(await command.execute(lease)).toBe("stale");
    const final = await repo.readRun(actor, "eval_revoked_batch");
    expect(final?.run).toMatchObject({ status: "cancelled", cancelledCases: 1 });
    expect(final?.results[0]?.outcome).toBe("cancelled");
    expect(
      (await sql.query(`SELECT status FROM "${schema}".runs WHERE id=$1`, [lease.plannedRunId]))
        .rows,
    ).toEqual([{ status: "cancelled" }]);
  });

  it("评测调度：并发占位、取消和租约换代重放不复制 Run", async () => {
    const { actor, repo, command, driver, sql, schema, adminControlPool, repositories } =
      await evaluationFixture("limits", 1);
    const makeSuite = async (id: string, count: number) =>
      repo.saveSuite(actor, {
        id,
        definitionId: "agent_default",
        description: "",
        name: id,
        cases: Array.from({ length: count }, (_, i) => ({
          id: `${id}_${i}`,
          name: "测试",
          inputText: "输入",
          attachments: [],
          assertions: [],
        })),
      });
    await makeSuite("eval_limits", 2);
    await makeSuite("eval_more", 1);
    const start = (id: string, suiteId: string) =>
      repo.startRun(actor, {
        id,
        definitionId: "agent_default",
        suiteId,
        revisionId: "eval_revision_limits",
        maxConcurrency: 1,
      });
    await start("eval_batch", "eval_limits");
    await start("eval_batch2", "eval_more");
    const pendingQueue = await adminControlPool.query(
      "SELECT batch_id,case_id,status FROM admin_evaluation_queue ORDER BY batch_id,case_id",
    );
    const rawJobs = await sql.query(
      `SELECT evaluation_run_id,status FROM "${schema}".agent_evaluation_case_jobs ORDER BY evaluation_run_id,case_id`,
    );
    expect(rawJobs.rows, JSON.stringify(pendingQueue.rows)).toHaveLength(3);
    expect(pendingQueue.rows).toHaveLength(3);
    const claims = await Promise.all([driver.claim(), driver.claim(), driver.claim()]);
    const leases = claims.filter((l) => l !== undefined);
    expect(leases).toHaveLength(1);
    const first = leases[0];
    if (!first) throw new Error("缺少首个租约");
    expect(first.batchId).toBe("eval_batch");
    expect(await command.execute({ ...first, userId: "another_user" })).toBe("stale");
    expect(await command.execute({ ...first, tenantId: "other_tenant" })).toBe("stale");
    expect(await command.execute(first)).toBe("active");
    await sql.query(
      `UPDATE "${schema}".agent_evaluation_case_jobs SET lease_until=now()-interval '1 second' WHERE claim_token=$1`,
      [first.token],
    );
    const retry = await driver.claim();
    expect(retry?.plannedRunId).toBe(first.plannedRunId);
    if (!retry) throw new Error("未重领");
    expect(retry.token !== first.token).toBe(true);
    expect(Number(retry.generation)).toBe(Number(first.generation) + 1);
    expect(await command.execute(first)).toBe("stale");
    // 模拟旧执行者在失去租约后才收到失败响应，不能结算新一代的任务。
    const late = new PgEvaluationDriver(
      adminControlPool,
      async () => "failed",
      async () => {
        throw new Error("不读取正文");
      },
      { globalLimit: 1, leaseMs: 30000, pollMs: 60000 },
    );
    await late.process(first);
    expect((await repo.readRun(actor, first.batchId))?.run.failedCases).toBe(0);
    await driver.process(retry);
    const snapshot = await sql.query(
      `SELECT t.is_evaluation,s.revision_id,r.origin FROM "${schema}".runs r JOIN "${schema}".threads t ON t.tenant_id=r.tenant_id AND t.id=r.thread_id JOIN "${schema}".run_agent_snapshots s ON s.run_id=r.id WHERE r.id=$1`,
      [first.plannedRunId],
    );
    expect(snapshot.rows).toEqual([
      { is_evaluation: true, revision_id: "eval_revision_limits", origin: "evaluation" },
    ]);
    expect(
      (
        await sql.query(`SELECT 1 FROM "${schema}".run_playground_mocks WHERE run_id=$1`, [
          first.plannedRunId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      await repositories.runs.get(
        { tenantId: tenantId(first.tenantId), userId: userId(actor) },
        runId(first.plannedRunId),
      ),
    ).toBeUndefined();
    const wider = new PgEvaluationDriver(
      adminControlPool,
      (c) => command.execute(c),
      async () => {
        throw new Error("不应结算");
      },
      { globalLimit: 2, leaseMs: 30000, pollMs: 60000 },
    );
    const other = await wider.claim();
    expect(other?.batchId).toBe("eval_batch2");
    if (!other) throw new Error("缺少第二批");
    await wider.process(other);
    await repo.cancelRun(actor, "eval_batch");
    await repo.cancelRun(actor, "eval_batch2");
    while (await wider.tick()) {}
    const detail = await repo.readRun(actor, "eval_batch");
    expect(detail?.run).toMatchObject({ status: "cancelled", cancelledCases: 2 });
    expect(
      (await sql.query(`SELECT status FROM "${schema}".runs WHERE id=$1`, [first.plannedRunId]))
        .rows,
    ).toEqual([{ status: "cancelled" }]);
  });

  it("评测结算：持久回复、工具和已发布 Artifact 必须经过本人正文审计", async () => {
    const { actor, repo, driver, sql, schema } = await evaluationFixture("evidence", 8);
    const assertions: EvaluationCase["assertions"] = [
      { kind: "text_contains", value: "最终回复" },
      { kind: "tool_called", toolName: "read" },
      { kind: "artifact_exists", name: "结果.txt", type: "text/plain" },
    ];
    await repo.saveSuite(actor, {
      id: "eval_evidence",
      definitionId: "agent_default",
      name: "取证",
      description: "",
      cases: ["pass", "assert_fail", "run_fail", "unknown"].map((id) => ({
        id: `eval_${id}`,
        name: id,
        inputText: "输入",
        attachments: [],
        assertions,
      })),
    });
    await repo.startRun(actor, {
      id: "eval_verdicts",
      definitionId: "agent_default",
      suiteId: "eval_evidence",
      revisionId: "eval_revision_evidence",
      maxConcurrency: 4,
    });
    for (let i = 0; i < 4; i++) expect(await driver.tick()).toBe(true);
    const detail = await repo.readRun(actor, "eval_verdicts");
    expect(detail?.results).toHaveLength(4);
    expect(detail?.results.every((r) => r.outcome === "running")).toBe(true);
    for (const item of detail?.results ?? []) {
      const id = item.runId;
      if (!id) throw new Error("未创建 Run");
      await withTransaction(sql, async (c) => {
        await c.query(`SET LOCAL search_path TO "${schema}"`);
        await c.query("UPDATE runs SET status=$2 WHERE id=$1", [
          id,
          item.caseName === "run_fail" ? "failed" : "succeeded",
        ]);
        if (item.caseName === "run_fail" || item.caseName === "unknown") return;
        await c.query(
          `INSERT INTO execution_attempts(tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,finished_at,created_at,updated_at) SELECT tenant_id,$2,run_id,thread_id,workspace_id,root_run_id,'succeeded','finished',now(),now(),now() FROM run_execution_inputs WHERE run_id=$1`,
          [id, `attempt_${id}`],
        );
        const events = [
          { type: "message.delta", delta: "中间回复" },
          { type: "message.completed", stopReason: "toolUse" },
          { type: "tool.started", callId: "call_1", name: "read" },
          { type: "message.delta", delta: "最终" },
          { type: "message.delta", delta: "回复" },
          { type: "message.completed", stopReason: "stop" },
        ];
        for (const [i, event] of events.entries())
          await c.query(
            `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload) VALUES($1,$2,$3,1,'agent_event',$4::jsonb)`,
            [item.tenantId, `attempt_${id}`, i, JSON.stringify(event)],
          );
        if (item.caseName === "pass") {
          // 此处只验证已发布元数据投影，不构造对象存储生命周期夹具。
          await c.query("SET LOCAL session_replication_role=replica");
          await c.query(
            `INSERT INTO artifact_publications(tenant_id,id,thread_id,run_id,attempt_id,workspace_id,root_run_id,resource_id,resource_version_id,name,purpose,deliverable_key,blob_reference_id,blob_purpose,blob_lifecycle_id,blob_incarnation_id,physical_object_key,digest,media_type,size) SELECT tenant_id,'artifact_eval',thread_id,run_id,$2,workspace_id,root_run_id,'res','v1','结果.txt','deliverable','result','ref','resource',gen_random_uuid(),gen_random_uuid(),'object',repeat('a',64),'text/plain',1 FROM run_execution_inputs WHERE run_id=$1`,
            [id, `attempt_${id}`],
          );
          await c.query(
            "INSERT INTO artifact_publication_settlements(tenant_id,artifact_id,target) VALUES($1,'artifact_eval','published')",
            [item.tenantId],
          );
        }
      });
    }
    await sql.query(
      `UPDATE "${schema}".agent_evaluation_case_jobs SET next_poll_at=now() WHERE evaluation_run_id='eval_verdicts'`,
    );
    while (await driver.tick()) {}
    const settled = await repo.readRun(actor, "eval_verdicts");
    expect(settled?.run).toMatchObject({
      status: "completed",
      passRate: 0.25,
      passedCases: 1,
      failedCases: 2,
      unknownCases: 1,
    });
    expect(
      settled?.results
        .find((c) => c.caseName === "assert_fail")
        ?.assertionResults.map((a) => a.passed),
    ).toEqual([true, true, false]);
    expect(
      settled?.results.find((c) => c.caseName === "pass")?.assertionResults.map((a) => a.passed),
    ).toEqual([true, true, true]);
    const audits = await sql.query(
      `SELECT actor_user_id,query_summary->>'reason' AS reason FROM "${schema}".admin_run_content_access_audits WHERE actor_user_id=$1`,
      [actor],
    );
    expect(audits.rows).toEqual(Array(2).fill({ actor_user_id: actor, reason: "评测结算" }));
    await repo.saveSuite(actor, {
      id: "eval_evidence",
      definitionId: "agent_default",
      name: "取证内容已更新",
      description: "",
      cases: ["pass", "assert_fail", "run_fail", "unknown"].map((id) => ({
        id: `eval_${id}`,
        name: id === "pass" ? "内容已变更" : id,
        inputText: id === "pass" ? "新增后尚未执行的输入" : "输入",
        attachments: [],
        assertions,
      })),
    });
    const eligible = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM "${schema}".agent_evaluation_runs batch
         JOIN "${schema}".agent_evaluation_suites suite ON suite.id=batch.suite_id
        WHERE batch.suite_id='eval_evidence' AND batch.revision_id='eval_revision_evidence'
          AND batch.status='completed' AND batch.suite_version=suite.content_version`,
    );
    expect(eligible.rows[0]?.count).toBe("0");
    const completedCase = settled?.results.find((item) => item.caseName === "pass");
    if (!completedCase?.runId || !completedCase.tenantId) throw new Error("缺少完成用例 Run");
    await sql.query(`UPDATE "${schema}".user_accounts SET status='disabled' WHERE user_id=$1`, [
      actor,
    ]);
    const explorer = new PgAdminRunExplorerRepository(adminControlPool);
    await expect(
      explorer.evaluationEvidence(actor, completedCase.tenantId, completedCase.runId),
    ).rejects.toThrow();
    await sql.query(`UPDATE "${schema}".user_accounts SET status='active' WHERE user_id=$1`, [
      actor,
    ]);
  });

  it("评测迁移建立 Agent 级资源、后台 RLS，并可单独回滚与重放", async () => {
    const target = await createIsolatedMigrationTarget("agent_evaluation_schema");
    try {
      await migrateUp(target.pool, target.context);
      const versions = new Map((await loadMigrations()).map((m) => [m.name, m.version]));
      const versionBefore = (name: string) => {
        const version = versions.get(name);
        if (version === undefined) throw new Error(`缺少迁移：${name}`);
        return version - 1;
      };
      const grants = await target.pool.query<{
        readonly relation_name: string;
        readonly row_security: boolean;
        readonly force_row_security: boolean;
        readonly control_select: boolean;
        readonly control_insert: boolean;
        readonly runtime_select: boolean;
      }>(
        `SELECT relation.relname AS relation_name,relation.relrowsecurity AS row_security,
                relation.relforcerowsecurity AS force_row_security,
                has_table_privilege($1,relation.oid,'SELECT') AS control_select,
                has_table_privilege($1,relation.oid,'INSERT') AS control_insert,
                has_table_privilege($2,relation.oid,'SELECT') AS runtime_select
           FROM pg_class relation
          WHERE relation.relnamespace=current_schema()::regnamespace
            AND relation.relname IN ('agent_evaluation_suites','agent_evaluation_cases',
              'agent_evaluation_runs','agent_evaluation_results')
          ORDER BY relation.relname`,
        [target.context.adminControlRole, target.context.runtimeRole],
      );
      expect(grants.rows).toHaveLength(4);
      expect(grants.rows.every((row) => row.row_security && row.force_row_security)).toBe(true);
      expect(
        grants.rows
          .filter((row) => row.relation_name !== "agent_evaluation_cases")
          .every((row) => row.control_select && row.control_insert),
      ).toBe(true);
      expect(
        grants.rows.find((row) => row.relation_name === "agent_evaluation_cases"),
      ).toMatchObject({ control_select: false, control_insert: true });
      expect(grants.rows.every((row) => !row.runtime_select)).toBe(true);
      await migrateDown(target.pool, {
        ...target.context,
        runtimeRole: target.context.runtimeRole,
        targetVersion: versionBefore("hide_evaluation_runs"),
        allowDestructive: true,
        environment: "test",
      });
      const visibilityColumn = await target.pool.query<{ readonly present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='threads' AND column_name='is_evaluation') AS present",
      );
      expect(visibilityColumn.rows[0]?.present).toBe(false);
      const executionTables = await target.pool.query<{ readonly table_name: string | null }>(
        "SELECT to_regclass('agent_evaluation_case_jobs')::text AS table_name",
      );
      expect(executionTables.rows[0]?.table_name).toBe("agent_evaluation_case_jobs");
      await migrateDown(target.pool, {
        ...target.context,
        runtimeRole: target.context.runtimeRole,
        targetVersion: versionBefore("evaluation_execution"),
        allowDestructive: true,
        environment: "test",
      });
      const removedExecution = await target.pool.query<{ readonly table_name: string | null }>(
        "SELECT to_regclass('agent_evaluation_case_jobs')::text AS table_name",
      );
      expect(removedExecution.rows[0]?.table_name).toBeNull();
      const baseTables = await target.pool.query<{ readonly table_name: string | null }>(
        "SELECT to_regclass('agent_evaluation_suites')::text AS table_name",
      );
      expect(baseTables.rows[0]?.table_name).toBe("agent_evaluation_suites");
      await migrateDown(target.pool, {
        ...target.context,
        runtimeRole: target.context.runtimeRole,
        targetVersion: versionBefore("agent_evaluations"),
        allowDestructive: true,
        environment: "test",
      });
      const removed = await target.pool.query<{ readonly table_name: string | null }>(
        "SELECT to_regclass('agent_evaluation_suites')::text AS table_name",
      );
      expect(removed.rows[0]?.table_name).toBeNull();
      await migrateUp(target.pool, target.context);
      const restored = await target.pool.query<{ readonly table_name: string | null }>(
        "SELECT to_regclass('agent_evaluation_suites')::text AS table_name",
      );
      expect(restored.rows[0]?.table_name).toBe("agent_evaluation_suites");
    } finally {
      await target.close();
    }
  });

  it("真实 Migrator 跨租户回填客户端工具 Thread 及多级 Fork 后代", async () => {
    const target = await createIsolatedMigrationTarget("client_history_backfill");
    const migrationDir = await mkdtemp(join(tmpdir(), "hoox-client-history-migrations-"));
    const runtime = createPostgresPool({
      connectionString: target.runtimeConnectionString,
      schema: target.context.schema,
      maxConnections: 4,
    });
    try {
      const migrations = await loadMigrations();
      const markerMigration = migrations.find(
        (migration) => migration.name === "thread_client_tool_history",
      );
      if (markerMigration === undefined) throw new Error("缺少客户端历史标记迁移");
      const previousMigrations = migrations.filter(
        (migration) => migration.version < markerMigration.version,
      );
      for (const migration of previousMigrations) {
        for (const direction of ["up", "down"] as const) {
          const name = `${String(migration.version).padStart(4, "0")}_${migration.name}.${direction}.sql`;
          await copyFile(join(sourceMigrationDirectory, name), join(migrationDir, name));
        }
      }
      const identity = await target.pool.query<{ readonly current_user: string }>(
        "SELECT current_user",
      );
      expect(identity.rows[0]?.current_user).toBe(target.context.migratorRole);
      await migrateUp(target.pool, { ...target.context, directory: migrationDir });

      const suffix = `client_history_backfill_${process.pid}_${Date.now()}`;
      const source = await createFixture(`${suffix}_source`, new PgCoreRepositories(runtime));
      const child = await createFixture(`${suffix}_child`, new PgCoreRepositories(runtime));
      const grandchild = await createFixture(
        `${suffix}_grandchild`,
        new PgCoreRepositories(runtime),
      );
      const unrelated = await createFixture(`${suffix}_unrelated`, new PgCoreRepositories(runtime));
      for (const [targetFixture, sourceFixture] of [
        [child, source],
        [grandchild, child],
      ] as const) {
        await asTenant(
          runtime,
          targetFixture.scope.tenantId,
          targetFixture.user.id,
          async (client) => {
            await client.query(
              `INSERT INTO thread_forks(
               tenant_id,child_thread_id,source_tenant_id,source_thread_id,
               fork_kind,created_by_user_id
             ) VALUES($1,$2,$3,$4,'team_publish',$5)`,
              [
                targetFixture.scope.tenantId,
                targetFixture.thread.id,
                sourceFixture.scope.tenantId,
                sourceFixture.thread.id,
                targetFixture.user.id,
              ],
            );
          },
        );
      }

      await withTransaction(administrativePool, async (client) => {
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query(
          `INSERT INTO "${target.context.schema}".client_tool_calls(
             tenant_id,run_id,thread_id,attempt_id,call_id,tool_name,arguments,deadline
           ) VALUES($1,'legacy_run',$2,'legacy_attempt','legacy_call','lookup',
                    '{"secret":"redacted-fixture"}'::jsonb,clock_timestamp())`,
          [source.scope.tenantId, source.thread.id],
        );
      });

      await migrateUp(target.pool, target.context);
      const observed: boolean[] = [];
      for (const fixture of [source, child, grandchild, unrelated]) {
        const result = await asTenant(
          runtime,
          fixture.scope.tenantId,
          fixture.user.id,
          async (client) =>
            await client.query<{ readonly has_client_tool_history: boolean }>(
              `SELECT has_client_tool_history FROM threads WHERE tenant_id=$1 AND id=$2`,
              [fixture.scope.tenantId, fixture.thread.id],
            ),
        );
        observed.push(result.rows[0]?.has_client_tool_history ?? true);
      }
      expect(observed).toEqual([true, true, true, false]);
      expect(observed.filter(Boolean)).toHaveLength(3);
      const rls = await target.pool.query<{
        readonly relrowsecurity: boolean;
        readonly relforcerowsecurity: boolean;
      }>(
        `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
          WHERE oid=ANY(ARRAY['threads'::regclass,'thread_forks'::regclass,'client_tool_calls'::regclass])
          ORDER BY relname`,
      );
      expect(rls.rows).toHaveLength(3);
      expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
      expect(
        (
          await target.pool.query(
            `SELECT policyname FROM pg_policies
              WHERE schemaname=current_schema()
                AND policyname LIKE 'client_tool_history_backfill_%'`,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await runtime.end();
      await rm(migrationDir, { recursive: true, force: true });
      await target.close();
    }
  });

  it("14→15 升级以真实 Migrator 回填正常 Webhook，并允许 Dispatcher 投递且可回退", async () => {
    const target = await createIsolatedMigrationTarget("webhook_v15_backfill");
    const webhook = await webhookIsolatedPools(target);
    try {
      await migrateUp(target.pool, target.context);
      expect(
        (await target.pool.query<{ readonly current_user: string }>("SELECT current_user")).rows[0]
          ?.current_user,
      ).toBe(target.context.migratorRole);
      const { tenant, user } = await seedWebhookTenant(target, "v15_backfill");
      const runId = `run_webhook_v15_${process.pid}`;
      await seedWebhookRun(target, tenant, user, runId);
      const repository = new PgWebhookRepository(webhook.runtime);
      const subscription = await repository.create({
        scope: { tenantId: tenant, userId: user },
        name: "migration backfill",
        endpointUrl: "https://hooks.example.invalid/migration-backfill",
        eventTypes: ["run.succeeded"],
        secret: webhookSecret("v15_backfill"),
      });
      await asTenant(webhook.runtime, tenant, user, async (client) => {
        await enqueueRunStatusWebhook(client, {
          tenantId: tenant,
          runId,
          status: "succeeded",
          runVersion: 1,
          occurredAt: "2026-11-20T00:00:00.000Z",
        });
      });

      await migrateDown(target.pool, {
        ...target.context,
        runtimeRole: target.context.runtimeRole,
        targetVersion: 14,
        allowDestructive: true,
        environment: "test",
      });
      const atVersion14 = await administrativePool.query<{ readonly present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema=$1 AND table_name='webhook_outbox' AND column_name='source_run_origin') AS present`,
        [target.context.schema],
      );
      expect(atVersion14.rows[0]?.present).toBe(false);

      // migrateUp 的连接身份是真实、无 BYPASSRLS 的 Migrator；正常 Outbox 必须可见并回填。
      await migrateUp(target.pool, target.context);
      const migrated = await administrativePool.query<{
        readonly event_id: string;
        readonly source_run_id: string;
        readonly source_run_origin: string;
        readonly state: string;
      }>(
        `SELECT event_id,source_run_id,source_run_origin,state FROM "${target.context.schema}".webhook_outbox
          WHERE tenant_id=$1 AND payload->'data'->>'runId'=$2`,
        [tenant, runId],
      );
      expect(migrated.rows).toHaveLength(1);
      expect(migrated.rows[0]).toMatchObject({
        source_run_id: runId,
        source_run_origin: "normal",
        state: "pending",
      });
      const store = new PgWebhookOutboxStore(webhook.dispatcher);
      const delivery = await store.claim({ owner: "migration-backfill" });
      expect(delivery).toMatchObject({
        webhookId: subscription.id,
        eventId: migrated.rows[0]?.event_id,
      });
      if (delivery === undefined) throw new Error("升级后正常投递不可领取");
      await expect(store.permitSend(delivery, 0)).resolves.toEqual({
        outcome: "send",
        secretCiphertext: webhookSecret("v15_backfill"),
      });
    } finally {
      await webhook.close();
      await target.close();
    }
  });

  it("Webhook 角色边界：Dispatcher 只读投递列，Runtime 与 Team Coordinator 不能改写密文或 Outbox", async () => {
    const target = await createIsolatedMigrationTarget("webhook_acl");
    const webhook = await webhookIsolatedPools(target);
    try {
      await migrateUp(target.pool, target.context);
      const { tenant, user } = await seedWebhookTenant(target, "acl");
      const repository = new PgWebhookRepository(webhook.runtime);
      await seedWebhookRun(target, tenant, user, "run_team_dissolved");
      const created = await repository.create({
        scope: { tenantId: tenant, userId: user },
        name: "acl",
        endpointUrl: "https://hooks.example.invalid/acl",
        eventTypes: ["run.cancelled"],
        secret: webhookSecret("c1"),
      });

      const managementBindings = await administrativePool.query<{ roles: string[] }>(
        `SELECT ARRAY(SELECT pg_get_userbyid(r)::text FROM unnest(polroles) r) AS roles FROM pg_policy
          WHERE polrelid IN (format('%I.tenant_webhooks',$1::text)::regclass,format('%I.webhook_outbox',$1::text)::regclass)
            AND polname IN ('tenant_webhooks_tenant_policy','webhook_outbox_tenant_policy')`,
        [target.context.schema],
      );
      expect(managementBindings.rows).toEqual([
        { roles: [target.context.runtimeRole] },
        { roles: [target.context.runtimeRole] },
      ]);
      // Dispatcher：只读投递所需列，不能读取订阅名称、业务表或写入 Outbox。
      await expect(
        webhook.dispatcher.query("SELECT id,endpoint_url,secret_ciphertext FROM tenant_webhooks"),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const sql of [
        "SELECT name FROM tenant_webhooks",
        "SELECT created_by_user_id FROM tenant_webhooks",
        "SELECT last_error_code FROM webhook_outbox",
        "SELECT event_type FROM webhook_outbox",
        "SELECT id FROM runs LIMIT 1",
        "SELECT id FROM tenants LIMIT 1",
        `INSERT INTO webhook_outbox(tenant_id,id,webhook_id,event_id,event_type,payload) VALUES('${tenant}','x','${created.id}','e','run.cancelled','{}')`,
        "UPDATE tenant_webhooks SET secret_ciphertext='{}'::jsonb",
        "DELETE FROM webhook_outbox",
      ])
        await expect(webhook.dispatcher.query(sql), sql).rejects.toMatchObject({ code: "42501" });

      // Runtime：不能改写目的地址，也不能读取或结算 Outbox。
      await expect(
        asTenant(webhook.runtime, tenant, user, (client) =>
          client.query("UPDATE tenant_webhooks SET endpoint_url='https://evil.example.invalid/'"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      for (const sql of [
        "SELECT id FROM webhook_outbox",
        "UPDATE webhook_outbox SET state='delivered'",
      ])
        await expect(
          asTenant(webhook.runtime, tenant, user, (client) => client.query(sql)),
          sql,
        ).rejects.toMatchObject({ code: "42501" });

      // Team Coordinator：只能为解散批量取消入队，不能读取或改写订阅密文与 Outbox。
      for (const sql of [
        "UPDATE tenant_webhooks SET secret_ciphertext='{}'::jsonb",
        "UPDATE tenant_webhooks SET disabled_at=clock_timestamp(),disabled_reason='x'",
        "SELECT secret_ciphertext FROM tenant_webhooks",
        "SELECT endpoint_url FROM tenant_webhooks",
        "UPDATE webhook_outbox SET state='disabled'",
        "SELECT id FROM webhook_outbox",
      ])
        await expect(
          asTenant(webhook.team, tenant, user, (client) => client.query(sql)),
          sql,
        ).rejects.toMatchObject({ code: "42501" });
      await asTenant(webhook.team, tenant, user, (client) =>
        enqueueRunStatusWebhook(client, {
          tenantId: tenant,
          runId: "run_team_dissolved",
          status: "cancelled",
          runVersion: 3,
          occurredAt: "2026-11-20T00:00:00.000Z",
        }),
      );
      const queued = await administrativePool.query<{ secret: unknown; event_type: string }>(
        `SELECT webhook.secret_ciphertext AS secret,outbox.event_type
           FROM "${target.context.schema}".webhook_outbox outbox
           JOIN "${target.context.schema}".tenant_webhooks webhook
             ON webhook.tenant_id=outbox.tenant_id AND webhook.id=outbox.webhook_id
          WHERE outbox.tenant_id=$1`,
        [tenant],
      );
      expect(queued.rows).toEqual([{ secret: webhookSecret("c1"), event_type: "run.cancelled" }]);

      // Dispatcher 只能停用订阅，不能恢复启用。
      await repository.disable({ tenantId: tenant, userId: user }, created.id);
      const reenabled = await webhook.dispatcher.query(
        "UPDATE tenant_webhooks SET disabled_at=NULL,disabled_reason=NULL WHERE id=$1",
        [created.id],
      );
      expect(reenabled.rowCount).toBe(0);
    } finally {
      await webhook.close();
      await target.close();
    }
  });

  it("Webhook Dispatcher 角色更换后撤销旧角色的 Schema、表与列权限", async () => {
    const target = await createIsolatedMigrationTarget("webhook_rebind");
    const replacementRole = `${target.context.webhookDispatcherRole}_next`;
    const password = randomBytes(24).toString("hex");
    await administrativePool.query(
      `CREATE ROLE "${replacementRole}" LOGIN PASSWORD '${password}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       GRANT CONNECT ON DATABASE "${databaseName}" TO "${replacementRole}"`,
    );
    const replacementUrl = new URL(migrationDatabaseUrl);
    replacementUrl.username = replacementRole;
    replacementUrl.password = password;
    const oldDispatcher = createPostgresPool({
      connectionString: target.webhookDispatcherConnectionString,
      schema: target.context.schema,
      maxConnections: 1,
    });
    const newDispatcher = createPostgresPool({
      connectionString: replacementUrl.toString(),
      schema: target.context.schema,
      maxConnections: 1,
    });
    try {
      await migrateUp(target.pool, target.context);
      await expect(oldDispatcher.query("SELECT id FROM webhook_outbox")).resolves.toBeDefined();
      await bootstrapRuntimeAccess(target.pool, {
        ...target.context,
        webhookDispatcherRole: replacementRole,
      });
      // 失去 Schema USAGE 后对象解析即失败（42P01），否则为权限拒绝（42501）。
      for (const sql of [
        "SELECT id FROM webhook_outbox",
        "SELECT endpoint_url FROM tenant_webhooks",
        "UPDATE webhook_outbox SET state='pending'",
      ])
        await expect(oldDispatcher.query(sql), sql).rejects.toSatisfy(
          (error: { code?: string }) => error.code === "42501" || error.code === "42P01",
        );
      const residual = await administrativePool.query<{
        readonly usage: boolean;
        readonly outbox: boolean;
        readonly subscriptions: boolean;
      }>(
        `SELECT has_schema_privilege($1,$2,'USAGE') AS usage,
                has_any_column_privilege($1,format('%I.webhook_outbox',$2::text),'SELECT') AS outbox,
                has_any_column_privilege($1,format('%I.tenant_webhooks',$2::text),'SELECT') AS subscriptions`,
        [target.context.webhookDispatcherRole, target.context.schema],
      );
      expect(residual.rows[0]).toEqual({ usage: false, outbox: false, subscriptions: false });
      const policies = await administrativePool.query<{ readonly roles: string[] }>(
        `SELECT ARRAY(SELECT member::regrole::text FROM unnest(polroles) member) AS roles
           FROM pg_policy WHERE polname='webhook_outbox_dispatcher_policy'
            AND polrelid=format('%I.webhook_outbox',$1::text)::regclass`,
        [target.context.schema],
      );
      expect(policies.rows[0]?.roles).toEqual([replacementRole]);
      await expect(newDispatcher.query("SELECT id FROM webhook_outbox")).resolves.toBeDefined();
    } finally {
      await oldDispatcher.end();
      await newDispatcher.end();
      await target.close();
      await administrativePool.query(
        `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${replacementRole}";
         DROP ROLE "${replacementRole}"`,
      );
    }
  });

  it("Webhook 停用、轮换与次数上限在领取时对整个订阅生效", async () => {
    const target = await createIsolatedMigrationTarget("webhook_claim");
    const webhook = await webhookIsolatedPools(target);
    try {
      await migrateUp(target.pool, target.context);
      const { tenant, user } = await seedWebhookTenant(target, "claim");
      const scope = { tenantId: tenant, userId: user };
      const repository = new PgWebhookRepository(webhook.runtime);
      const primary = await repository.create({
        scope,
        name: "primary",
        endpointUrl: "https://hooks.example.invalid/primary",
        eventTypes: ["run.succeeded", "run.failed"],
        secret: webhookSecret("c1"),
      });
      for (const runId of [
        "run_rollback",
        "run_one",
        "run_two",
        "run_after_disable",
        "run_manual_a",
        "run_manual_b",
      ]) {
        await seedWebhookRun(target, tenant, user, runId);
      }
      const event = (runId: string) =>
        runWebhookPayload({
          tenantId: tenant,
          runId,
          status: "succeeded",
          runVersion: 1,
          occurredAt: "2026-11-20T00:00:00.000Z",
        });
      const enqueue = (runId: string, commit = true) =>
        asTenant(webhook.runtime, tenant, user, async (client) => {
          const payload = event(runId);
          if (payload === undefined) throw new Error("事件缺失");
          await enqueueWebhookEvent({ client, tenantId: tenant, payload });
          if (!commit) throw new Error("ROLLBACK_FOR_TEST");
        });
      const outbox = async () =>
        (
          await administrativePool.query<{
            readonly id: string;
            readonly webhook_id: string;
            readonly state: string;
            readonly attempts: number;
            readonly last_error_code: string | null;
          }>(
            `SELECT id,webhook_id,state,attempts,last_error_code
               FROM "${target.context.schema}".webhook_outbox ORDER BY created_at,id`,
          )
        ).rows;

      // 回滚不入队，重放同一事件不重复入队。
      await expect(enqueue("run_rollback", false)).rejects.toThrow("ROLLBACK_FOR_TEST");
      expect(await outbox()).toEqual([]);
      await enqueue("run_one");
      await enqueue("run_one");
      expect(await outbox()).toHaveLength(1);

      // 每次发送前读取当前密钥：轮换后已领取但未发出的投递也使用新密钥。
      const store = new PgWebhookOutboxStore(webhook.dispatcher, {
        maxAttempts: 2,
        leaseMs: 30_000,
      });
      const first = await store.claim({ owner: "it" });
      expect(first?.endpointUrl).toBe("https://hooks.example.invalid/primary");
      if (first === undefined) throw new Error("未领取");
      await expect(store.permitSend(first, 0)).resolves.toEqual({
        outcome: "send",
        secretCiphertext: webhookSecret("c1"),
      });
      // 第二条事件先写入，但在另一连接的轮换提交后才提交，不能固化旧密钥。
      await asTenant(webhook.runtime, tenant, user, async (client) => {
        const payload = event("run_two");
        if (!payload) throw new Error("事件缺失");
        await enqueueWebhookEvent({ client, tenantId: tenant, payload });
        expect(await repository.rotate(scope, primary.id, webhookSecret("c2"))).toBe(true);
      });
      expect(await outbox()).toHaveLength(2);
      await expect(store.permitSend(first, 0)).resolves.toEqual({
        outcome: "send",
        secretCiphertext: webhookSecret("c2"),
      });
      // 剩余租约不足以覆盖发送时限时拒绝发送。
      await expect(store.permitSend(first, 60_000)).resolves.toEqual({ outcome: "skip" });
      // 同一 Tenant 已在途时，排除该 Tenant 后不再领取。
      await expect(
        store.claim({ owner: "it", excludedTenantIds: [tenant] }),
      ).resolves.toBeUndefined();
      await store.settle(first, { kind: "retry", errorCode: "timeout", delayMs: 0 });

      // 次数上限在领取时强制：最后一次尝试未结算且租约过期后直接进入终态并停用整个订阅。
      const second = await store.claim({ owner: "it" });
      const third = await store.claim({ owner: "it" });
      if (second === undefined || third === undefined) throw new Error("未领取");
      expect([second.attempts, third.attempts].sort()).toEqual([1, 2]);
      const last = second.attempts === 2 ? second : third;
      const other = second.attempts === 2 ? third : second;
      await expect(store.permitSend(last, 0)).resolves.toEqual({
        outcome: "send",
        secretCiphertext: webhookSecret("c2"),
      });
      await expect(store.permitSend(other, 0)).resolves.toEqual({
        outcome: "send",
        secretCiphertext: webhookSecret("c2"),
      });
      await store.settle(other, { kind: "retry", errorCode: "timeout", delayMs: 0 });
      await administrativePool.query(
        `UPDATE "${target.context.schema}".webhook_outbox SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2`,
        [tenant, last.id],
      );
      await expect(store.claim({ owner: "it" })).resolves.toBeUndefined();
      const exhausted = (await outbox()).find((row) => row.id === last.id);
      expect(exhausted).toMatchObject({
        state: "disabled",
        attempts: 2,
        last_error_code: "attempts_exhausted",
      });
      // 迟到的结算不能把已终结的记录拉回。
      await store.settle(last, { kind: "delivered" });
      expect((await outbox()).find((row) => row.id === last.id)?.state).toBe("disabled");
      expect((await repository.list(scope))[0]).toMatchObject({
        id: primary.id,
        disabledReason: "delivery_attempts_exhausted",
      });
      // 自动停用作用于整个订阅：同订阅其余积压不再领取，新事件不再入队。
      expect((await outbox()).find((row) => row.id === other.id)?.state).toBe("pending");
      await enqueue("run_after_disable");
      expect(await outbox()).toHaveLength(2);

      // 手动停用：已领取未发出的投递在复核时结算为 webhook_disabled，积压不再领取。
      const manual = await repository.create({
        scope,
        name: "manual",
        endpointUrl: "https://hooks.example.invalid/manual",
        eventTypes: ["run.succeeded"],
        secret: webhookSecret("m1"),
      });
      await enqueue("run_manual_a");
      await enqueue("run_manual_b");
      const manualStore = new PgWebhookOutboxStore(webhook.dispatcher);
      const claimed = await manualStore.claim({ owner: "it" });
      if (claimed === undefined) throw new Error("未领取");
      expect(claimed.webhookId).toBe(manual.id);
      await repository.disable(scope, manual.id);
      await expect(manualStore.permitSend(claimed, 0)).resolves.toEqual({ outcome: "skip" });
      expect((await outbox()).find((row) => row.id === claimed.id)).toMatchObject({
        state: "disabled",
        last_error_code: "webhook_disabled",
      });
      await expect(manualStore.claim({ owner: "it" })).resolves.toBeUndefined();

      await seedWebhookRun(target, tenant, user, "run_evaluation", "evaluation");
      await withTransaction(administrativePool, async (client) => {
        await client.query(`SET LOCAL search_path TO "${target.context.schema}"`);
        await client.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
          [tenant, user],
        );
        const payload = event("run_evaluation");
        if (!payload) throw new Error("评测事件缺失");
        await enqueueWebhookEvent({ client, tenantId: tenant, payload });
      });
      const evaluationEnqueue = await administrativePool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${target.context.schema}".webhook_outbox
          WHERE tenant_id=$1 AND source_run_id='run_evaluation'`,
        [tenant],
      );
      expect(evaluationEnqueue.rows[0]?.count).toBe("0");

      await administrativePool.query(
        `INSERT INTO "${target.context.schema}".webhook_outbox(
           tenant_id,id,webhook_id,event_id,event_type,payload,source_run_id,source_run_origin
         ) VALUES($1,'outbox_eval_legacy',$2,'event_eval_legacy','run.succeeded',$3::jsonb,
                  'run_evaluation','evaluation')`,
        [tenant, primary.id, JSON.stringify(event("run_evaluation"))],
      );
      await expect(store.claim({ owner: "it" })).resolves.toBeUndefined();
      expect((await outbox()).find((row) => row.id === "outbox_eval_legacy")).toMatchObject({
        state: "disabled",
        last_error_code: "source_not_allowed",
      });

      const sourceGuard = await repository.create({
        scope,
        name: "source-guard",
        endpointUrl: "https://hooks.example.invalid/source-guard",
        eventTypes: ["run.succeeded"],
        secret: webhookSecret("sg"),
      });
      await seedWebhookRun(target, tenant, user, "run_send_guard");
      await asTenant(webhook.runtime, tenant, user, async (client) => {
        const payload = event("run_send_guard");
        if (!payload) throw new Error("普通事件缺失");
        await enqueueWebhookEvent({ client, tenantId: tenant, payload });
      });
      const sendGuard = await store.claim({ owner: "it" });
      if (!sendGuard || sendGuard.webhookId !== sourceGuard.id)
        throw new Error("普通 Webhook 领取失败");
      await administrativePool.query(
        `UPDATE "${target.context.schema}".webhook_outbox
            SET source_run_id='run_evaluation',source_run_origin='evaluation'
          WHERE tenant_id=$1 AND id=$2`,
        [tenant, sendGuard.id],
      );
      await expect(store.permitSend(sendGuard, 0)).resolves.toEqual({ outcome: "skip" });
      expect((await outbox()).find((row) => row.id === sendGuard.id)).toMatchObject({
        state: "disabled",
        last_error_code: "source_not_allowed",
      });
    } finally {
      await webhook.close();
      await target.close();
    }
  });

  it("Webhook 并发逻辑删除与 Run 取消不会回滚业务状态", async () => {
    const fixture = await createFixture(`webhook_delete_race_${process.pid}`);
    const repository = new PgWebhookRepository(runtimePool);
    const webhook = await repository.create({
      scope: fixture.scope,
      name: "delete-race",
      endpointUrl: "https://hooks.example.invalid/delete-race",
      eventTypes: ["run.cancelled"],
      secret: webhookSecret("race"),
    });
    const current = await repositories.runs.get(fixture.scope, fixture.run.id);
    if (!current) throw new Error("Run 缺失");
    const cancelled = transitionRun(current.entity, "cancelled", timestamp(35));
    const barrier = await administrativePool.connect();
    let cancellation: Promise<unknown> | undefined;
    try {
      const blocker = await barrier.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid,pg_advisory_lock(hashtext($1))",
        [fixture.scope.tenantId],
      );
      // BEFORE INSERT 在订阅快照已选中、外键检查之前暂停，强制覆盖原物理删除会失败的交错。
      await administrativePool.query(`
        CREATE FUNCTION "${schema}".webhook_delete_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id));
          RETURN NEW;
        END $$;
        CREATE TRIGGER webhook_delete_barrier BEFORE INSERT ON "${schema}".webhook_outbox
          FOR EACH ROW EXECUTE FUNCTION "${schema}".webhook_delete_barrier();
      `);
      cancellation = repositories.runs.update(fixture.scope, cancelled, current.version);
      const completed = cancellation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await expect
        .poll(async () => {
          const waiting = await administrativePool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",
            [blocker.rows[0]?.pid],
          );
          return waiting.rows[0]?.waiting;
        })
        .toBe(true);
      // 两个业务事务使用独立连接；删除必须在取消事务恢复外键检查之前完成。
      expect(await repository.remove(fixture.scope, webhook.id)).toBe(true);
      await barrier.query("SELECT pg_advisory_unlock(hashtext($1))", [fixture.scope.tenantId]);
      expect(await completed).toMatchObject({ value: { outcome: "updated" } });
    } finally {
      await barrier.query("SELECT pg_advisory_unlock_all()");
      await cancellation?.catch(() => undefined);
      barrier.release();
      await administrativePool.query(
        `DROP TRIGGER IF EXISTS webhook_delete_barrier ON "${schema}".webhook_outbox; DROP FUNCTION IF EXISTS "${schema}".webhook_delete_barrier()`,
      );
    }
    expect((await repositories.runs.get(fixture.scope, fixture.run.id))?.entity.status).toBe(
      "cancelled",
    );
    expect(await repository.list(fixture.scope)).toEqual([]);
    expect(await repository.remove(fixture.scope, webhook.id)).toBe(false);
    expect(await repository.disable(fixture.scope, webhook.id)).toBeUndefined();
    expect(await repository.rotate(fixture.scope, webhook.id, webhookSecret("after_delete"))).toBe(
      false,
    );
  });

  it("Webhook 数据库客户端截止时间淘汰悬挂连接后可继续使用连接池", async () => {
    const pool = createPostgresPool({
      connectionString: runtimeDatabaseUrl,
      schema,
      maxConnections: 1,
    });
    try {
      let previousPid: number | undefined;
      await expect(
        withTransaction(
          pool,
          async (client) => {
            const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            previousPid = result.rows[0]?.pid;
            await client.query("SELECT pg_sleep(10)");
          },
          { deadlineMs: 100 },
        ),
      ).rejects.toThrow("POSTGRES_TRANSACTION_DEADLINE_EXCEEDED");
      const next = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(next.rows[0]?.pid).not.toBe(previousPid);
      expect(next.rows[0]?.pid).toEqual(expect.any(Number));
    } finally {
      await pool.end();
    }
  });

  it("Webhook 事件随 API 取消在同一事务入队，版本冲突与重放不重复入队", async () => {
    const fixture = await createFixture(`webhook_cancel_${process.pid}`);
    const repository = new PgWebhookRepository(runtimePool);
    await repository.create({
      scope: fixture.scope,
      name: "cancel",
      endpointUrl: "https://hooks.example.invalid/cancel",
      eventTypes: ["run.cancelled", "run.succeeded"],
      secret: webhookSecret("c1"),
    });
    const current = await repositories.runs.get(fixture.scope, fixture.run.id);
    if (current === undefined) throw new Error("Run 缺失");
    const cancelled = transitionRun(current.entity, "cancelled", timestamp(30));
    // 在隔离 Schema 注入入队失败，直接证明取消与事件之间没有独立提交窗口。
    await administrativePool.query(
      `ALTER TABLE "${schema}".webhook_outbox ADD CONSTRAINT it_reject_cancel CHECK (event_type <> 'run.cancelled') NOT VALID`,
    );
    try {
      await expect(
        repositories.runs.update(fixture.scope, cancelled, current.version),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      expect(await repositories.runs.get(fixture.scope, fixture.run.id)).toEqual(current);
    } finally {
      await administrativePool.query(
        `ALTER TABLE "${schema}".webhook_outbox DROP CONSTRAINT it_reject_cancel`,
      );
    }
    await expect(
      repositories.runs.update(fixture.scope, cancelled, current.version),
    ).resolves.toMatchObject({ outcome: "updated" });
    await expect(
      repositories.runs.update(fixture.scope, cancelled, current.version),
    ).resolves.toEqual({ outcome: "conflict" });
    const rows = await administrativePool.query<{
      readonly event_type: string;
      readonly event_id: string;
      readonly payload: { readonly id: string; readonly data: Record<string, unknown> };
    }>(`SELECT event_type,event_id,payload FROM "${schema}".webhook_outbox WHERE tenant_id=$1`, [
      fixture.scope.tenantId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.event_type).toBe("run.cancelled");
    expect(Object.keys(rows.rows[0]?.payload ?? {}).sort()).toEqual([
      "createdAt",
      "data",
      "id",
      "type",
    ]);
    expect(rows.rows[0]?.payload.data).toEqual({ runId: fixture.run.id, status: "cancelled" });
    expect(rows.rows[0]?.payload.id).toBe(rows.rows[0]?.event_id);
  });

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
      try {
        await migrateUp(target.pool, target.context);
      } catch (error) {
        const sqlState = sqlStateFromCause(error) ?? "unknown";
        throw new Error(`升级迁移前 Thread 时失败，SQLSTATE=${sqlState}`);
      }
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
  it("带数据旧库升级在即时约束下保留 Agent 与 Thread，未修复 SQL 以 55006 失败", async () => {
    const migrations = await loadMigrations();
    const snapshotMigration = migrations.find(
      (migration) => migration.name === "run_agent_snapshots",
    );
    if (snapshotMigration === undefined) throw new Error("缺少 RunAgentSnapshot 迁移");
    const previousMigrations = migrations.filter(
      (migration) => migration.version < snapshotMigration.version,
    );
    const previousVersion = previousMigrations.at(-1)?.version;
    if (previousVersion === undefined) throw new Error("缺少旧库迁移基线");
    const target = await createIsolatedMigrationTarget("populated_upgrade");
    const oldMigrations = await mkdtemp(join(tmpdir(), "hoox-populated-migrations-"));
    const seedPool = createPostgresPool({
      connectionString: bootstrapDatabaseUrl,
      schema: target.context.schema,
      maxConnections: 2,
    });
    try {
      for (const migration of previousMigrations) {
        for (const direction of ["up", "down"]) {
          const name = `${String(migration.version).padStart(4, "0")}_${migration.name}.${direction}.sql`;
          await copyFile(join(sourceMigrationDirectory, name), join(oldMigrations, name));
        }
      }
      const previousRecords = await migrateUp(target.pool, {
        ...target.context,
        directory: oldMigrations,
      });
      await withTransaction(seedPool, async (client) => {
        await client.query(`
          INSERT INTO app_users(id,created_at) VALUES('user_upgrade',clock_timestamp());
          INSERT INTO tenants(id,kind,owner_user_id,created_at)
            VALUES('tenant_upgrade','personal','user_upgrade',clock_timestamp());
          INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
            VALUES('tenant_upgrade','membership_upgrade','user_upgrade','owner','active',clock_timestamp());
          INSERT INTO agent_definitions(id,status,generation,availability_mode)
            VALUES('agent_upgrade','published',1,'all_tenants');
          INSERT INTO agent_revisions(id,definition_id,revision,status,content,content_digest,created_by)
            SELECT 'agent_upgrade_revision','agent_upgrade',1,'published',content,content_digest,'user_upgrade'
              FROM agent_revisions WHERE id='agent_default_revision_1';
          UPDATE agent_definitions SET current_revision_id='agent_upgrade_revision' WHERE id='agent_upgrade';
          INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at,agent_definition_id)
            VALUES('tenant_upgrade','thread_upgrade','user_upgrade','既有默认任务','active',clock_timestamp(),clock_timestamp(),'agent_default'),
                  ('tenant_upgrade','thread_custom','user_upgrade','既有自定义任务','active',clock_timestamp(),clock_timestamp(),'agent_upgrade');
          INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
            VALUES('tenant_upgrade','run_upgrade','thread_upgrade','succeeded',clock_timestamp(),clock_timestamp());
        `);
      });
      const originalRevisions = await seedPool.query<{
        id: string;
        content: Record<string, unknown>;
        content_digest: string;
      }>("SELECT id,content,content_digest FROM agent_revisions ORDER BY id");

      // 旧执行器在新事务保留初始延迟属性；直接执行原迁移复现 UPDATE 后 ALTER 的真实失败。
      await expect(
        withTransaction(target.pool, async (client) => {
          await client.query("SELECT set_config('app.runtime_role', $1, true)", [
            target.context.runtimeRole,
          ]);
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(snapshotMigration.upSql);
        }),
      ).rejects.toMatchObject({ code: "55006" });
      expect(
        (await target.pool.query("SELECT to_regclass('run_agent_snapshots') AS relation")).rows,
      ).toEqual([{ relation: null }]);

      const expectedRecords = migrations.map(({ version, name, checksum }) => ({
        version,
        name,
        checksum,
      }));
      expect(await migrateUp(target.pool, target.context)).toEqual(expectedRecords);
      const definitions = await seedPool.query(
        "SELECT id,current_revision_id,generation::text FROM agent_definitions ORDER BY id",
      );
      expect(definitions.rows).toEqual([
        {
          id: "agent_default",
          current_revision_id: "agent_default_revision_platform_memory",
          generation: "2",
        },
        { id: "agent_upgrade", current_revision_id: "agent_upgrade_revision", generation: "1" },
      ]);
      const revision = await seedPool.query(
        "SELECT content,content_digest FROM agent_revisions WHERE id='agent_default_revision_platform_memory'",
      );
      const originalContent = originalRevisions.rows.find(
        (row) => row.id === "agent_default_revision_1",
      )?.content;
      if (originalContent === undefined) throw new Error("缺少默认 Agent 原始 Revision");
      const { longTermMemoryEnabled: _oldMemory, ...unchangedContent } = originalContent;
      expect(revision.rows[0]?.content).toEqual({
        ...unchangedContent,
        memory: { mode: "platform_default" },
      });
      expect(revision.rows[0]?.content_digest).toBe(
        createHash("sha256").update(canonical(revision.rows[0]?.content)).digest("hex"),
      );
      expect(
        (
          await seedPool.query(
            "SELECT id,content,content_digest FROM agent_revisions WHERE id=ANY($1::text[]) ORDER BY id",
            [originalRevisions.rows.map((row) => row.id)],
          )
        ).rows,
      ).toEqual(originalRevisions.rows);
      expect(
        (
          await seedPool.query(
            "SELECT id,agent_definition_id FROM threads WHERE tenant_id='tenant_upgrade' ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "thread_custom", agent_definition_id: "agent_upgrade" },
        { id: "thread_upgrade", agent_definition_id: "agent_default" },
      ]);
      expect(
        (
          await seedPool.query(
            "SELECT id,thread_id,status FROM runs WHERE tenant_id='tenant_upgrade'",
          )
        ).rows,
      ).toEqual([{ id: "run_upgrade", thread_id: "thread_upgrade", status: "succeeded" }]);
      expect(
        (
          await target.pool.query(
            `SELECT condeferrable,condeferred FROM pg_constraint
            WHERE conrelid='agent_definitions'::regclass AND conname='agent_definitions_current_revision_fk'`,
          )
        ).rows,
      ).toEqual([{ condeferrable: true, condeferred: true }]);
      expect(
        await migrateDown(target.pool, {
          ...target.context,
          targetVersion: previousVersion,
          allowDestructive: true,
          environment: "test",
        }),
      ).toEqual(previousRecords);
      expect(
        (
          await seedPool.query(
            "SELECT current_revision_id FROM agent_definitions WHERE id='agent_default'",
          )
        ).rows,
      ).toEqual([{ current_revision_id: "agent_default_revision_1" }]);
      expect(await migrateUp(target.pool, target.context)).toEqual(expectedRecords);
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
    expect(revision?.content.memory).toEqual({ mode: "platform_default" });
    const seed = await administrativePool.query<{ readonly content: Record<string, unknown> }>(
      `SELECT content FROM "${schema}".agent_revisions WHERE id='agent_default_revision_1'`,
    );
    expect(seed.rows[0]?.content).toMatchObject({ longTermMemoryEnabled: false });
    expect(seed.rows[0]?.content).not.toHaveProperty("memory");
  });

  function pinnedModelFixture() {
    const cipher = new ModelProviderCredentialCipher(
      "integration-pinned-model-root-at-least-32-bytes",
    );
    const config = new PgAdminControlRepository(adminControlPool, cipher);
    const service = new AdminControlService(
      config,
      config,
      { async probeModel() {}, async probeMemory() {} },
      [],
    );
    const providerKey = "agent-pinned-model";
    const configurations = {
      providerKey,
      displayName: "Agent 固定模型测试供应商",
      protocol: "openai-compatible",
      baseUrl: "https://pinned.example.invalid/v1",
      defaultModelId: "model-default",
      models: [
        {
          id: "model-default",
          name: "默认",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 65536,
          maxTokens: 4096,
        },
        {
          id: "model-selected",
          name: "固定",
          enabled: true,
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 32768,
          maxTokens: 2048,
        },
        {
          id: "model-disabled",
          name: "停用",
          enabled: false,
          reasoning: false,
          input: ["text"],
          contextWindow: 32768,
          maxTokens: 1024,
        },
      ],
    } as const;
    const context = (actorUserId: string, idempotencyKey: string) => ({
      actorUserId,
      idempotencyKey,
      requestDigest: createHash("sha256").update(idempotencyKey).digest("hex"),
    });
    return { cipher, config, service, providerKey, configurations, context };
  }

  it("RunAgentSnapshot 只读解析精确的固定模型，不采用 active、默认条目或部署凭据", async () => {
    const manager = await createFixture("pinned_runtime_model");
    const other = await createFixture("pinned_other_tenant");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [manager.user.id],
    );
    const { cipher, config, service, providerKey, configurations, context } = pinnedModelFixture();
    const key = "placeholder-agent-pinned-api-key";
    const provider = await service.createModelDraft(
      context(manager.user.id, "pinned-model-runtime-draft"),
      {
        ...configurations,
        apiKey: key,
      },
    );
    const active = await service.saveModelConfiguration(
      context(manager.user.id, "pinned-model-runtime-active"),
      {
        ...configurations,
        expectedGeneration: await config.generation(manager.user.id),
        apiKey: "placeholder-distinct-active-model-key",
      },
    );
    try {
      const defaults = await readDefaultAgentRevision();
      if (!defaults) throw new Error("默认 Agent Revision 不可见");
      const reference = {
        mode: "pinned",
        providerKey,
        providerRevision: provider.revision,
        modelId: "model-selected",
      } as const;
      const agents = new PgAgentDefinitionRepository(adminControlPool);
      const draft = await agents.createDraft({
        actorUserId: manager.user.id,
        id: "agent_pinned_runtime_model",
        revisionId: "agent_pinned_runtime_revision",
        expectedGeneration: 0,
        idempotencyKey: "pinned-runtime-agent-draft",
        availability: { mode: "all_tenants" },
        content: { ...defaults.content, model: reference },
      });
      await agents.publish({
        actorUserId: manager.user.id,
        definitionId: draft.definition.id,
        revisionId: draft.revision.id,
        expectedGeneration: 0,
        idempotencyKey: "pinned-runtime-agent-publish",
      });
      const thread = rehydrateThread(
        {
          ...manager.thread,
          id: "thread_agent_pinned_runtime",
          agentDefinitionId: draft.definition.id,
        },
        manager.tenant,
        manager.user,
        manager.membership,
      );
      expect(await repositories.threads.create(manager.scope, thread)).toMatchObject({
        outcome: "created",
      });
      const workspace = createWorkspace({
        id: workspaceId("workspace_agent_pinned_runtime"),
        thread,
        now: timestamp(4),
      });
      expect(await repositories.workspaces.create(manager.scope, workspace)).toEqual({
        outcome: "created",
      });
      const run = createRun({ id: runId("run_agent_pinned_runtime"), thread, now: timestamp(5) });
      expect(
        await new PgRunDispatchCreation(runtimePool).createQueuedRun({
          scope: manager.scope,
          thread,
          run,
          origin: "api",
          inputText: "执行",
          idempotency: {
            key: "pinned-runtime-create-run",
            requestHash: sha256Digest("0".repeat(64)),
          },
        }),
      ).toMatchObject({ outcome: "created" });
      const createdOrigin = await withTenantTransaction(runtimePool, manager.scope, (client) =>
        client.query<{ readonly origin: string }>("SELECT origin FROM runs WHERE id=$1", [run.id]),
      );
      expect(createdOrigin.rows[0]?.origin).toBe("api");
      const scope = { tenantId: manager.tenant.id, runId: run.id };
      const runtime = new PgRuntimeControlConfigurationRepository(
        runtimePool,
        cipher,
        "placeholder-deployment-key",
      );
      const readVisible = (tenantId: string, runId?: string) =>
        withTenantTransaction(runtimePool, { tenantId }, async (client) => {
          if (runId)
            await client.query("SELECT set_config('app.pinned_model_run_id',$1,true)", [runId]);
          return (
            await client.query(
              "SELECT 1 FROM admin_control_config_revisions WHERE object_kind='model_provider' AND object_key=$1 AND revision=$2",
              [providerKey, provider.revision],
            )
          ).rowCount;
        });
      expect(await readVisible(scope.tenantId)).toBe(0);
      expect(await readVisible(other.tenant.id, run.id)).toBe(0);
      expect(await readVisible(scope.tenantId, run.id)).toBe(1);
      const resolved = await runtime.resolvePinnedModelConfiguration(scope, reference);
      expect(resolved.model).toMatchObject({
        revision: provider.revision,
        configuration: {
          providerKey,
          defaultModelId: reference.modelId,
          models: expect.arrayContaining([
            expect.objectContaining({ id: reference.modelId, maxTokens: 2048 }),
          ]),
        },
      });
      expect(resolved.apiKey === key).toBe(true);
      const countSnapshots = async () =>
        Number(
          (
            await migratorPool.query<{ count: string }>(
              "SELECT count(*) AS count FROM run_runtime_config_snapshots WHERE tenant_id=$1 AND run_id=$2",
              [scope.tenantId, scope.runId],
            )
          ).rows[0]?.count,
        );
      expect(await countSnapshots()).toBe(0);
      await expect(
        runtime.resolvePinnedModelConfiguration(scope, {
          ...reference,
          providerRevision: active.revision,
        }),
      ).rejects.toThrow("PINNED_MODEL_CONFIGURATION_UNAVAILABLE");
      await expect(
        runtime.resolvePinnedModelConfiguration(scope, { ...reference, modelId: "model-default" }),
      ).rejects.toThrow("PINNED_MODEL_CONFIGURATION_UNAVAILABLE");
      await expect(
        runtime.resolvePinnedModelConfiguration({ ...scope, tenantId: other.tenant.id }, reference),
      ).rejects.toThrow("PINNED_MODEL_CONFIGURATION_UNAVAILABLE");
      const wrongCipher = new ModelProviderCredentialCipher(
        "integration-wrong-pinned-root-at-least-32-bytes",
      );
      await expect(
        new PgRuntimeControlConfigurationRepository(
          runtimePool,
          wrongCipher,
          "placeholder-deployment-key",
        ).resolvePinnedModelConfiguration(scope, reference),
      ).rejects.toThrow("PINNED_MODEL_CONFIGURATION_UNAVAILABLE");
      expect((await runtime.resolveActiveModelConfiguration())?.configuration.defaultModelId).toBe(
        "model-default",
      );
      expect((await runtime.resolveForRun(scope))?.model).toEqual(resolved.model);
      expect(await countSnapshots()).toBe(1);
      await migratorPool.query("DELETE FROM admin_control_active_configs WHERE activated_by=$1", [
        manager.user.id,
      ]);
      expect(
        (
          await new PgRuntimeControlConfigurationRepository(runtimePool, cipher).resolveForRun(
            scope,
          )
        )?.model,
      ).toEqual(resolved.model);
      await migratorPool.query(
        "DELETE FROM admin_control_config_revisions WHERE object_kind='model_provider' AND object_key=$1 AND revision=$2",
        [providerKey, provider.revision],
      );
      await expect(runtime.resolveForRun(scope)).rejects.toThrow(
        "PINNED_MODEL_CONFIGURATION_UNAVAILABLE",
      );
    } finally {
      await migratorPool.query("DELETE FROM admin_control_active_configs WHERE activated_by=$1", [
        manager.user.id,
      ]);
      await administrativePool.query(
        `UPDATE "${schema}".runs SET origin='normal' WHERE tenant_id=$1 AND id=$2`,
        [manager.tenant.id, "run_agent_pinned_runtime"],
      );
    }
  });

  it("后台 Agent 管理拒绝草稿越权并原子更新可用范围", async () => {
    const operator = await createFixture("agent_admin_operator");
    const viewer = await createFixture("agent_admin_viewer");
    const outsider = await createFixture("agent_admin_outsider");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'operator','active'),($2,'viewer','active')",
      [operator.user.id, viewer.user.id],
    );
    const repository = new PgAgentDefinitionRepository(adminControlPool);
    const actors = new Map([
      ["Bearer operator", operator.user.id],
      ["Bearer viewer", viewer.user.id],
      ["Bearer outsider", outsider.user.id],
    ]);
    const { createAdminControlApiApp } = await import(
      "../../runtime-ts/apps/admin-control-api/src/app.js"
    );
    const app = createAdminControlApiApp({
      agents: repository,
      auth: {
        async resolve(input) {
          const id = actors.get(input.authorization ?? "");
          return id === undefined ? undefined : { userId: id };
        },
      },
      control: {} as AdminControlApiDependencies["control"],
      identity: {} as AdminControlApiDependencies["identity"],
      modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
      skills: {} as AdminControlApiDependencies["skills"],
      readiness: { async probe() {} },
    });
    const route = "/v1/admin/control/agent-definitions";
    const id = "agent_admin_integration";
    const definition = `${route}/${id}`;
    const revisions = `${definition}/revisions`;
    const first = "agent_admin_draft_1";
    const second = "agent_admin_draft_2";
    const content = {
      displayName: "后台创建的草稿",
      description: "隔离测试",
      operatorInstructions: "只提供测试说明。",
      suggestedQuestions: [],
      replyLanguage: "zh-CN",
      model: { mode: "platform_default" },
      tools: { mode: "platform_default" },
      skillVersions: [],
      includeTenantSkills: true,
      sandboxIdleAction: "pause",
      memory: { mode: "platform_default" },
    };
    const write = (
      url: string,
      key: string,
      payload: object,
      authorization = "Bearer operator",
      method: "POST" | "PUT" = "POST",
    ) => app.inject({ method, url, headers: { authorization, "idempotency-key": key }, payload });
    const read = (url: string, authorization = "Bearer operator") =>
      app.inject({ method: "GET", url, headers: { authorization } });
    try {
      const draft = {
        id,
        revisionId: first,
        content,
        versionNotes: "首个草稿说明",
        expectedGeneration: 0,
        availability: { mode: "selected_tenants", tenantIds: [operator.tenant.id] },
      };
      expect((await read(route, "Bearer outsider")).statusCode).toBe(401);
      expect((await write(route, "agent-admin-create", draft, "Bearer viewer")).statusCode).toBe(
        401,
      );
      expect((await write(route, "short", draft)).statusCode).toBe(400);
      const oversized = await write(route, "agent-admin-create", {
        ...draft,
        content: { ...content, operatorInstructions: "字".repeat(11_000) },
      });
      expect(oversized.statusCode).toBe(400);
      expect(oversized.json().error.message).toContain("operatorInstructions");
      const oversizedNotes = await write(route, "agent-admin-create", {
        ...draft,
        versionNotes: "说".repeat(2001),
      });
      expect(oversizedNotes.statusCode).toBe(400);
      const { service, configurations, context, providerKey } = pinnedModelFixture();
      const provider = await service.createModelDraft(
        context(operator.user.id, "pinned-model-admin-draft"),
        {
          ...configurations,
          apiKey: "placeholder-admin-pinned-api-key",
        },
      );
      const pinned = {
        mode: "pinned",
        providerKey,
        providerRevision: provider.revision,
        modelId: "model-selected",
      };
      for (const model of [
        { ...pinned, providerRevision: provider.revision + 100 },
        { ...pinned, modelId: "model-disabled" },
        { ...pinned, modelId: "model-missing" },
      ]) {
        const invalid = await write(route, "agent-invalid-pinned-model", {
          ...draft,
          content: { ...content, model },
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error.message).toContain("已保存、已启用");
      }
      const invalidTool = await write(route, "agent-admin-create", {
        ...draft,
        content: {
          ...content,
          tools: {
            mode: "configured",
            builtinTools: ["unknown"],
            externalTools: [],
            clientTools: [],
            toolCallingMode: "native",
          },
        },
      });
      expect(invalidTool.statusCode).toBe(400);
      expect(invalidTool.json().error.message).toContain("内置工具");
      const created = await write(route, "agent-admin-create", draft);
      expect(created.statusCode).toBe(201);
      expect(created.json().data).toMatchObject({
        definition: { id, generation: 0 },
        revision: { id: first },
      });
      expect((await write(route, "agent-admin-create", draft)).json().data).toEqual(
        created.json().data,
      );
      expect(
        (await write(route, "agent-admin-create", { ...draft, revisionId: second })).statusCode,
      ).toBe(409);
      const runtimeDraft = await withTenantTransaction(
        runtimePool,
        operator.scope,
        async (client) => {
          await client.query("SELECT set_config('app.user_id',$1,true)", [operator.user.id]);
          return client.query("SELECT id FROM agent_revisions WHERE id=$1", [first]);
        },
      );
      expect(runtimeDraft.rows).toEqual([]);
      const managerList = await read(route);
      expect(managerList.statusCode).toBe(200);
      expect(managerList.json().data).toMatchObject({
        canManage: true,
        pinnedModelOptions: expect.arrayContaining([pinned]),
      });
      expect(managerList.body).not.toContain("placeholder-admin-pinned-api-key");
      expect(managerList.body).not.toContain("ciphertext");
      expect((await read(route, "Bearer viewer")).json().data.pinnedModelOptions).toEqual([]);
      const listItem = managerList
        .json()
        .data.items.find((item: { definition: { id: string } }) => item.definition.id === id);
      expect(listItem).toMatchObject({
        definition: { availability: draft.availability },
        revision: { id: first, displayName: content.displayName },
      });
      expect(listItem.revision).not.toHaveProperty("content");
      expect((await read(route, "Bearer viewer")).body).not.toContain(id);
      expect((await read(revisions, "Bearer viewer")).statusCode).toBe(404);
      expect((await read(`${revisions}/${first}`, "Bearer viewer")).statusCode).toBe(404);
      const saved = await write(revisions, "agent-admin-save", {
        expectedGeneration: 0,
        revisionId: second,
        content: { ...content, displayName: "草稿第二版", model: pinned },
        versionNotes: "固定专用模型",
      });
      expect(saved.statusCode).toBe(201);
      expect(saved.json().data).toMatchObject({
        id: second,
        revision: 2,
        status: "draft",
        content: { model: pinned },
      });
      expect(
        (
          await write(`${revisions}/${first}/publish`, "agent-admin-publish", {
            expectedGeneration: 0,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await write(`${revisions}/${first}/publish`, "agent-admin-publish", {
            expectedGeneration: 1,
          })
        ).statusCode,
      ).toBe(200);
      await expect(
        withTransaction(adminControlPool, async (client) => {
          await client.query("SELECT set_config('app.user_id',$1,true)", [operator.user.id]);
          await client.query(
            "UPDATE agent_revisions SET version_notes='发布后不可改' WHERE id=$1",
            [first],
          );
        }),
      ).rejects.toThrow();
      const adminHistory = await read(revisions);
      expect(adminHistory.json().data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: second,
            versionNotes: "固定专用模型",
            changedSections: expect.arrayContaining(["model", "display"]),
          }),
        ]),
      );
      const history = await read(revisions, "Bearer viewer");
      expect(history.statusCode).toBe(200);
      expect(history.json().data.items.map((item: { id: string }) => item.id)).toEqual([first]);
      expect(history.json().data.items[0].versionNotes).toBe("首个草稿说明");
      expect((await read(`${revisions}/${first}`, "Bearer viewer")).json().data.content).toEqual(
        content,
      );
      expect((await read(`${revisions}/${first}`, "Bearer viewer")).json().data.versionNotes).toBe(
        "首个草稿说明",
      );
      expect((await read(`${revisions}/${second}`, "Bearer viewer")).statusCode).toBe(404);
      expect((await read(`${revisions}/${second}`)).json().data.content.displayName).toBe(
        "草稿第二版",
      );
      expect((await read(`${route}/agent_default/revisions/${first}`)).statusCode).toBe(404);
      const seed = await read(`${route}/agent_default/revisions/agent_default_revision_1`);
      expect(seed.statusCode).toBe(200);
      expect(seed.json().data.content.memory).toEqual({
        mode: "configured",
        longTermEnabled: false,
      });
      expect(seed.json().data.content).not.toHaveProperty("longTermMemoryEnabled");

      const scope = (expectedGeneration: number, tenantIds: string[]) => ({
        expectedGeneration,
        availability: { mode: "selected_tenants", tenantIds },
      });
      const nextScope = scope(2, [viewer.tenant.id]);
      const availability = `${definition}/availability`;
      expect(
        (await write(availability, "agent-admin-scope", nextScope, "Bearer viewer", "PUT"))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await write(
            availability,
            "agent-admin-scope",
            scope(1, [viewer.tenant.id]),
            "Bearer operator",
            "PUT",
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await write(
            availability,
            "agent-admin-scope",
            scope(2, ["tenant_does_not_exist"]),
            "Bearer operator",
            "PUT",
          )
        ).statusCode,
      ).toBe(400);
      expect((await read(revisions)).json().data.definition).toMatchObject({
        generation: 2,
        availability: draft.availability,
      });
      const updateScope = () =>
        write(availability, "agent-admin-scope", nextScope, "Bearer operator", "PUT");
      const [updated, replay] = await Promise.all([updateScope(), updateScope()]);
      expect(updated.statusCode).toBe(200);
      expect(replay.json().data).toEqual(updated.json().data);
      expect(updated.json().data).toMatchObject({
        generation: 3,
        availability: nextScope.availability,
      });
      expect(
        (await repository.listAvailable(operator.tenant.id)).map((item) => item.definition.id),
      ).not.toContain(id);
      expect(
        (await repository.listAvailable(viewer.tenant.id)).map((item) => item.definition.id),
      ).toContain(id);
      expect(
        (
          await write(`${definition}/deactivate`, "agent-admin-disable", { expectedGeneration: 3 })
        ).json().data,
      ).toMatchObject({ status: "disabled", availability: nextScope.availability });
      expect(
        (
          await write(`${revisions}/${first}/revoke`, "agent-admin-revoke", {
            expectedGeneration: 4,
            reason: "撤销不合规的配置",
          })
        ).json().data.status,
      ).toBe("revoked");
      expect((await read(revisions, "Bearer viewer")).json().data.items).toMatchObject([
        { id: first, status: "revoked" },
      ]);
      expect((await read(`${revisions}/${first}`, "Bearer viewer")).json().data.status).toBe(
        "revoked",
      );
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `${route}/agent_default`,
            headers: { authorization: "Bearer operator" },
          })
        ).statusCode,
      ).toBe(404);
      const allTenants = await write(
        availability,
        "agent-admin-scope-all",
        {
          expectedGeneration: 5,
          availability: { mode: "all_tenants" },
        },
        "Bearer operator",
        "PUT",
      );
      expect(allTenants.statusCode).toBe(200);
      expect(allTenants.json().data).toMatchObject({
        status: "revoked",
        availability: { mode: "all_tenants" },
      });
      expect(
        (await repository.listAvailable(operator.tenant.id)).map((item) => item.definition.id),
      ).not.toContain(id);
      const audit = await administrativePool.query(
        `SELECT action,generation::text FROM "${schema}".agent_definition_audits WHERE definition_id=$1 ORDER BY audit_id`,
        [id],
      );
      expect(audit.rows).toEqual([
        { action: "created", generation: "0" },
        { action: "created", generation: "1" },
        { action: "published", generation: "2" },
        { action: "availability_changed", generation: "3" },
        { action: "disabled", generation: "4" },
        { action: "revoked", generation: "5" },
        { action: "availability_changed", generation: "6" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("后台 Agent 管理在发布时重新校验平台内置工具上限", async () => {
    const manager = await createFixture("agent_tool_manager");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [manager.user.id],
    );
    const agents = new PgAgentDefinitionRepository(adminControlPool);
    const control = new PgAdminControlRepository(
      adminControlPool,
      new ModelProviderCredentialCipher("integration-agent-tool-root-at-least-32-bytes"),
    );
    const service = new AdminControlService(
      control,
      control,
      {
        probeModel: async () => undefined,
        probeMemory: async () => undefined,
      },
      [],
    );
    const existing = await agents.readAdminRevision(
      manager.user.id,
      "agent_default",
      "agent_default_revision_1",
    );
    if (!existing) throw new Error("默认版本不存在");
    const created = await agents.createDraft({
      actorUserId: manager.user.id,
      id: "agent_with_builtin_tools",
      revisionId: "agent_with_builtin_tools_1",
      expectedGeneration: 0,
      idempotencyKey: "agent-tool-create-draft",
      availability: { mode: "all_tenants" },
      content: {
        ...existing.content,
        tools: {
          mode: "configured",
          builtinTools: ["read"],
          externalTools: [],
          clientTools: [],
          toolCallingMode: "native",
        },
      },
    });
    try {
      await service.saveRuntimeSettingsConfiguration(
        {
          actorUserId: manager.user.id,
          idempotencyKey: "agent-tool-set-ceiling",
          requestDigest: "1".repeat(64),
        },
        {
          expectedGeneration: await control.generation(manager.user.id),
          enabledTools: [],
          workerMaxConcurrentRuns: 7,
          userMaxConcurrentRunsPerTenant: 3,
          compactionSoftLimitPercent: 90,
          compactionTargetPercent: 65,
          compactionRecentUserTokens: 2048,
          compactionMaxOutputTokens: 1024,
          compactionTimeoutMs: 45000,
        },
      );
      expect((await agents.listDefinitions(manager.user.id)).builtinToolLimit).toEqual([]);
      await expect(
        agents.publish({
          actorUserId: manager.user.id,
          definitionId: created.definition.id,
          revisionId: created.revision.id,
          expectedGeneration: 0,
          idempotencyKey: "agent-tool-publish-denied",
        }),
      ).rejects.toMatchObject({
        code: "CONSTRAINT_VIOLATION",
        message: expect.stringContaining("内置工具"),
      });
      expect(
        (await agents.listRevisions(manager.user.id, created.definition.id))?.definition,
      ).toMatchObject({ generation: 0, status: "draft" });
    } finally {
      await migratorPool.query(
        "DELETE FROM admin_control_activation_events WHERE actor_user_id=$1",
        [manager.user.id],
      );
      await migratorPool.query("DELETE FROM admin_control_active_configs WHERE activated_by=$1", [
        manager.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_audits WHERE actor_user_id=$1", [
        manager.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_commands WHERE actor_user_id=$1", [
        manager.user.id,
      ]);
      await migratorPool.query("DELETE FROM admin_control_config_revisions WHERE created_by=$1", [
        manager.user.id,
      ]);
    }
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
      memory: { mode: "configured" as const, longTermEnabled: false },
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
    const orderedScopeDraft = await repository.createDraft({
      actorUserId: manager.user.id,
      id: "agent_scope_order_test",
      availability: {
        mode: "selected_tenants",
        tenantIds: [other.tenant.id, manager.tenant.id],
      },
      content,
      revisionId: "agent_scope_order_revision",
      idempotencyKey: "agent-scope-order-create",
      expectedGeneration: 0,
    });
    await expect(
      repository.validateImport(manager.user.id, {
        id: orderedScopeDraft.definition.id,
        availability: {
          mode: "selected_tenants",
          tenantIds: [manager.tenant.id, other.tenant.id],
        },
        definitionId: orderedScopeDraft.definition.id,
        expectedGeneration: orderedScopeDraft.definition.generation,
        content,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.validateImport(manager.user.id, {
        id: draft.definition.id,
        availability: draft.definition.availability,
        content,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const published = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: draft.revision.id,
      idempotencyKey: "agent-publish-scope-1",
      expectedGeneration: 0,
    });
    expect(published.currentRevisionId).toBe(draft.revision.id);
    const exportResult = await repository.readRevisionForExport(
      manager.user.id,
      draft.definition.id,
      draft.revision.id,
    );
    if (!exportResult) throw new Error("已发布 Revision 未能导出");
    const exportedYaml = serializeAgentConfiguration({
      schemaVersion: 1,
      definition: {
        id: exportResult.definition.id,
        availability: exportResult.definition.availability,
      },
      revision: { content: exportResult.revision.content },
    });
    const importedConfiguration = parseAgentConfiguration(exportedYaml);
    await repository.validateImport(manager.user.id, {
      id: importedConfiguration.definition.id,
      availability: draft.definition.availability,
      definitionId: draft.definition.id,
      expectedGeneration: published.generation,
      content: importedConfiguration.revision.content,
    });
    const importedRevisionInput = {
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: "agent_scope_imported_revision",
      content: importedConfiguration.revision.content,
      idempotencyKey: "agent-import-scope-revision",
      expectedGeneration: published.generation,
      auditAction: "imported",
      importDefinition: {
        id: importedConfiguration.definition.id,
        availability: draft.definition.availability,
      },
    } as const;
    const importedRevision = await repository.createDraftRevision(importedRevisionInput);
    await expect(repository.createDraftRevision(importedRevisionInput)).resolves.toEqual(
      importedRevision,
    );
    expect(importedRevision.status).toBe("draft");
    expect(
      await repository.readCurrentPublished(manager.tenant.id, draft.definition.id),
    ).toMatchObject({ id: draft.revision.id, status: "published" });
    const importedExport = await repository.readRevisionForExport(
      manager.user.id,
      draft.definition.id,
      importedRevision.id,
    );
    if (!importedExport) throw new Error("导入的草稿 Revision 未能导出");
    expect(
      serializeAgentConfiguration({
        schemaVersion: 1,
        definition: {
          id: importedExport.definition.id,
          availability: importedExport.definition.availability,
        },
        revision: { content: importedExport.revision.content },
      }),
    ).toBe(exportedYaml);
    const transferAudits = await administrativePool.query<{ action: string }>(
      `SELECT action FROM "${schema}".agent_definition_audits WHERE definition_id=$1 AND action IN ('imported','exported') ORDER BY audit_id`,
      [draft.definition.id],
    );
    expect(transferAudits.rows.map(({ action }) => action)).toEqual([
      "exported",
      "imported",
      "exported",
    ]);
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
      expectedGeneration: 2,
    });
    const secondPublish = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: secondRevision.id,
      idempotencyKey: "agent-publish-scope-2",
      expectedGeneration: 3,
    });
    expect(secondPublish.currentRevisionId).toBe(secondRevision.id);
    expect((await repository.readRevisionById(manager.tenant.id, draft.revision.id))?.status).toBe(
      "published",
    );
    expect(
      (await repository.listAvailable(manager.tenant.id)).map((item) => item.definition.id),
    ).toContain("agent_scope_test");
    const visibleSelection = await repository.readVisibleCurrent(
      manager.tenant.id,
      "agent_scope_test",
    );
    expect(visibleSelection?.revision?.content.displayName).toBe("测试助手第二版");
    expect(
      await repository.readVisibleCurrent(other.tenant.id, "agent_scope_test"),
    ).toBeUndefined();
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
        expectedGeneration: 4,
      }),
    ).resolves.toMatchObject({ status: "disabled", generation: 5 });
    expect(
      await repository.readVisibleCurrent(manager.tenant.id, "agent_scope_test"),
    ).toBeUndefined();
    await expect(
      repository.revoke({
        actorUserId: manager.user.id,
        definitionId: published.id,
        revisionId: draft.revision.id,
        reason: "测试撤销",
        idempotencyKey: "agent-revoke-old-revision",
        expectedGeneration: 5,
      }),
    ).resolves.toMatchObject({ status: "disabled", generation: 6 });
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
    const revisionless = await repository.createDraft({
      actorUserId: manager.user.id,
      id: "agent_visible_without_revision",
      availability: { mode: "selected_tenants", tenantIds: [manager.tenant.id] },
      content,
      revisionId: "agent_visible_without_revision_v1",
      idempotencyKey: "agent-revisionless-create",
      expectedGeneration: 0,
    });
    await repository.publish({
      actorUserId: manager.user.id,
      definitionId: revisionless.definition.id,
      revisionId: revisionless.revision.id,
      idempotencyKey: "agent-revisionless-publish",
      expectedGeneration: 0,
    });
    const clearedRevision = await withTenantTransaction(adminControlPool, manager.scope, (client) =>
      client.query("UPDATE agent_definitions SET current_revision_id=NULL WHERE id=$1", [
        revisionless.definition.id,
      ]),
    );
    expect(clearedRevision.rowCount).toBe(1);
    const visibleWithoutRevision = await repository.readVisibleCurrent(
      manager.tenant.id,
      revisionless.definition.id,
    );
    expect(visibleWithoutRevision?.definition.id).toBe(revisionless.definition.id);
    expect(visibleWithoutRevision?.revision).toBeUndefined();
  });

  it("RunAgentSnapshot 固定创建时的 Revision，发布、停用与重启恢复不改写，撤销阻断安全点和许可", async () => {
    const manager = await createFixture("run_agent_snapshot");
    const agentSkillId = "skill_agent_snapshot_review";
    const tenantSkillId = "skill_agent_snapshot_notes";
    await withTenantTransaction(migratorPool, manager.scope, async (client) => {
      await client.query(
        `INSERT INTO skills(id,canonical_key,publisher,display_name,recommended_version,status)
         VALUES ($1,'review','测试','审阅','2.0.0','active'),
                ($2,'notes','测试','笔记','1.0.0','active')`,
        [agentSkillId, tenantSkillId],
      );
      await client.query(
        `INSERT INTO skill_versions(skill_id,version,description,compatibility,package_digest,
             entrypoint_path,entrypoint_digest,package_blob_ref,security_status,status)
         VALUES ($1,'1.0.0','Agent 固定审阅','runtime >= 1',repeat('a',64),'SKILL.md',repeat('b',64),$3,'verified','available'),
                ($1,'2.0.0','Tenant 新版审阅','runtime >= 1',repeat('c',64),'SKILL.md',repeat('d',64),'test/tenant-review-package','verified','available'),
                ($2,'1.0.0','Tenant 笔记','runtime >= 1',repeat('e',64),'SKILL.md',repeat('f',64),'test/tenant-notes-package','verified','available')`,
        [
          agentSkillId,
          tenantSkillId,
          skillSnapshotBlobRef("a".repeat(64), 250, "application/json"),
        ],
      );
      await client.query(
        `INSERT INTO skill_version_files(skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref)
         SELECT skill_id,version,entrypoint_path,'text/markdown',20,entrypoint_digest,
                CASE WHEN skill_id=$1 AND version='1.0.0' THEN $3 ELSE package_blob_ref || '/SKILL.md' END
           FROM skill_versions WHERE skill_id IN ($1,$2)`,
        [agentSkillId, tenantSkillId, skillSnapshotBlobRef("b".repeat(64), 20, "text/markdown")],
      );
    });
    await withTenantTransaction(runtimePool, manager.scope, (client) =>
      client.query(
        `INSERT INTO tenant_skill_installations(tenant_id,skill_id,skill_version,invocation_name,status)
         VALUES ($1,$2,'2.0.0','review','enabled'),($1,$3,'1.0.0','notes','enabled')`,
        [manager.tenant.id, agentSkillId, tenantSkillId],
      ),
    );
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [manager.user.id],
    );
    const repository = new PgAgentDefinitionRepository(adminControlPool);
    const defaults = await readDefaultAgentRevision();
    if (defaults === undefined) throw new Error("默认 Agent Revision 不可见");
    const draft = await repository.createDraft({
      actorUserId: manager.user.id,
      id: "agent_run_snapshot",
      availability: { mode: "selected_tenants", tenantIds: [manager.tenant.id] },
      content: {
        ...defaults.content,
        operatorInstructions: "固定指令一",
        skillVersions: [{ skillId: agentSkillId, version: "1.0.0" }],
        includeTenantSkills: true,
      },
      revisionId: "agent_run_snapshot_v1",
      idempotencyKey: "run-agent-snapshot-draft",
      expectedGeneration: 0,
    });
    const revision = draft.revision;
    const firstPublish = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: revision.id,
      idempotencyKey: "run-agent-snapshot-publish",
      expectedGeneration: draft.definition.generation,
    });
    const thread = rehydrateThread(
      {
        ...manager.thread,
        id: "thread_run_agent_snapshot_bound",
        agentDefinitionId: draft.definition.id,
      },
      manager.tenant,
      manager.user,
      manager.membership,
    );
    expect(await repositories.threads.create(manager.scope, thread)).toMatchObject({
      outcome: "created",
    });
    const workspace = createWorkspace({
      id: workspaceId("workspace_run_agent_snapshot_bound"),
      thread,
      now: timestamp(4),
    });
    expect(await repositories.workspaces.create(manager.scope, workspace)).toEqual({
      outcome: "created",
    });
    const creation = new PgRunDispatchCreation(runtimePool);
    const enqueue = (
      id: string,
      skillInvocation?: { readonly invocationName: string; readonly args: string },
    ) =>
      creation.createQueuedRun({
        scope: manager.scope,
        thread,
        run: createRun({ id: runId(id), thread, now: timestamp(5) }),
        inputText: "执行",
        ...(skillInvocation === undefined ? {} : { skillInvocation }),
        idempotency: { key: id, requestHash: sha256Digest("0".repeat(64)) },
      });
    const rejectedRunId = "run_agent_snapshot_skill_rejected";
    await expect(
      enqueue(rejectedRunId, { invocationName: "not-installed", args: "" }),
    ).resolves.toEqual({ outcome: "skill_not_available" });
    const rejectedRun = await withTenantTransaction(runtimePool, manager.scope, (client) =>
      client.query(
        `SELECT 1 FROM runs WHERE id=$1
         UNION ALL SELECT 1 FROM run_agent_snapshots WHERE run_id=$1
         UNION ALL SELECT 1 FROM run_skill_snapshots WHERE run_id=$1`,
        [rejectedRunId],
      ),
    );
    expect(rejectedRun.rowCount).toBe(0);
    const skillInvocation = { invocationName: "review", args: "审阅本轮更改" };
    const first = await enqueue("run_agent_snapshot_v1", skillInvocation);
    if (first.outcome !== "created") throw new Error(`Run 创建失败：${first.outcome}`);
    const scope = {
      tenantId: manager.scope.tenantId,
      threadId: thread.id,
      workspaceId: workspace.id,
      runId: first.entity.id,
      rootRunId: first.entity.id,
    };
    const snap = await withTenantTransaction(runtimePool, manager.scope, (client) =>
      readRunAgentSnapshot(client, scope),
    );
    const readSkills = (id: string) =>
      withTenantTransaction(runtimePool, manager.scope, (client) =>
        readRunSkillSnapshot(client, scope.tenantId, id),
      );
    const skills = await readSkills(scope.runId);
    expect(() => assertRunSkillSnapshot(skills)).not.toThrow();
    expect(skills).toMatchObject({
      items: [
        { invocationName: "notes", skillVersion: "1.0.0", source: "tenant" },
        {
          invocationName: "review",
          skillVersion: "1.0.0",
          source: "agent",
          description: "Agent 固定审阅",
        },
      ],
      explicitInvocation: skillInvocation,
    });
    expect(snap).toEqual({
      definitionId: draft.definition.id,
      revisionId: revision.id,
      revisionDigest: revision.digest,
      content: revision.content,
    });
    expect(await enqueue(first.entity.id)).toMatchObject({ outcome: "replayed" });
    const stranger = await createFixture("run_agent_snapshot_other");
    await expect(
      withTenantTransaction(runtimePool, stranger.scope, (client) =>
        readRunAgentSnapshot(client, scope),
      ),
    ).resolves.toBeUndefined();
    await expect(
      withTenantTransaction(runtimePool, manager.scope, (client) =>
        client.query("UPDATE run_agent_snapshots SET content='{}'::jsonb WHERE run_id=$1", [
          scope.runId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantTransaction(runtimePool, manager.scope, (client) =>
        client.query("DELETE FROM run_agent_snapshots WHERE run_id=$1", [scope.runId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      await withTenantTransaction(runtimePool, manager.scope, (client) =>
        client.query("SELECT 1 FROM run_skill_snapshots WHERE tenant_id=$1 AND run_id=$2", [
          scope.tenantId,
          scope.runId,
        ]),
      ),
    ).toMatchObject({ rowCount: 1 });

    const second = await repository.createDraftRevision({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: "agent_run_snapshot_v2",
      content: {
        ...revision.content,
        operatorInstructions: "固定指令二",
        includeTenantSkills: false,
      },
      idempotencyKey: "run-agent-snapshot-draft-v2",
      expectedGeneration: firstPublish.generation,
    });
    const secondPublish = await repository.publish({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: second.id,
      idempotencyKey: "run-agent-snapshot-publish-v2",
      expectedGeneration: firstPublish.generation + 1,
    });
    const secondRun = await enqueue("run_agent_snapshot_v2");
    expect(secondRun.outcome).toBe("created");
    expect(
      await withTenantTransaction(runtimePool, manager.scope, (client) =>
        readRunAgentSnapshot(client, { ...scope, runId: "run_agent_snapshot_v2" }),
      ),
    ).toMatchObject({ revisionId: second.id });
    const agentOnlySkills = await readSkills("run_agent_snapshot_v2");
    expect(agentOnlySkills.items).toEqual(skills.items.filter((item) => item.source === "agent"));
    await expect(
      enqueue("run_agent_snapshot_tenant_excluded", { invocationName: "notes", args: "" }),
    ).resolves.toEqual({ outcome: "skill_not_available" });
    await withTenantTransaction(runtimePool, manager.scope, (client) =>
      client.query("UPDATE tenant_skill_installations SET status='disabled' WHERE skill_id=$1", [
        tenantSkillId,
      ]),
    );
    const disabled = await repository.deactivate({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      idempotencyKey: "run-agent-snapshot-disable",
      expectedGeneration: secondPublish.generation,
    });
    await expect(enqueue("run_agent_snapshot_denied")).resolves.toEqual({
      outcome: "agent_revision_unavailable",
    });
    await expect(
      repositories.runs.get(manager.scope, runId("run_agent_snapshot_denied")),
    ).resolves.toBeUndefined();

    await expect(enqueue(first.entity.id)).resolves.toMatchObject({ outcome: "replayed" });

    const worker = new PgExecutionPersistence(runtimePool);
    const claim = await worker.claim({
      scope,
      workerId: "snapshot-worker-first",
      leaseDurationMs: 30_000,
    });
    if (claim.outcome !== "claimed") throw new Error(`领取失败：${claim.outcome}`);
    expect(claim.snapshot.agent).toEqual(snap);
    expect(claim.snapshot.skills).toEqual(skills);
    const mutate = (
      claimFence: typeof claim.fence,
      input: Omit<
        RuntimeMutation,
        "schemaVersion" | "commandDigest" | "fence" | "events" | "outbox"
      >,
    ) => {
      const unsigned = {
        schemaVersion: 1 as const,
        fence: claimFence,
        events: [],
        outbox: [],
        ...input,
      };
      return worker.mutate({ ...unsigned, commandDigest: runtimeMutationDigest(unsigned) });
    };
    await expect(
      mutate(claim.fence, {
        idempotencyKey: "agent-snapshot-running",
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
      }),
    ).resolves.toMatchObject({ outcome: "applied" });
    await expect(
      mutate(claim.fence, {
        idempotencyKey: "agent-snapshot-waiting",
        expectedAttemptVersion: 1,
        nextAttemptStatus: "waiting",
        nextStage: "finished",
        nextRunStatus: "waiting",
        releaseFences: true,
      }),
    ).resolves.toMatchObject({ outcome: "applied" });
    const waiting = await repositories.runs.get(manager.scope, scope.runId);
    if (waiting === undefined) throw new Error("等待中的 Run 不可见");
    await expect(
      new PgRunExecutionSetup(runtimePool).setAnswer({
        scope,
        answer: "恢复执行",
        expectedRunVersion: Number(waiting.version),
      }),
    ).resolves.toBe("updated");
    const restarted = new PgExecutionPersistence(runtimePool);
    const resumed = await restarted.claim({
      scope,
      workerId: "snapshot-worker-restarted",
      leaseDurationMs: 30_000,
    });
    if (resumed.outcome !== "claimed") throw new Error(`恢复领取失败：${resumed.outcome}`);
    expect(resumed.snapshot.agent).toEqual(snap);
    expect(resumed.snapshot.skills).toEqual(skills);
    expect(resumed.snapshot.attempt.attemptId).not.toBe(claim.snapshot.attempt.attemptId);
    await expect(
      mutate(resumed.fence, {
        idempotencyKey: "agent-snapshot-resumed-running",
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
      }),
    ).resolves.toMatchObject({ outcome: "applied" });
    const permit = await restarted.issueExternalEffectPermit({
      fence: resumed.fence,
      expectedAttemptVersion: 1,
      effect: "model_start",
      call: {
        callId: "model-before-revocation",
        toolName: "pi_model",
        argsDigest: sha256Digest("0".repeat(64)),
      },
      permitDurationMs: 15_000,
    });
    if (permit.outcome !== "authorized") throw new Error(`签发许可失败：${permit.outcome}`);

    await repository.revoke({
      actorUserId: manager.user.id,
      definitionId: draft.definition.id,
      revisionId: revision.id,
      idempotencyKey: "run-agent-snapshot-revoke",
      reason: "撤销旧 Revision",
      expectedGeneration: disabled.generation,
    });
    const inspected = await restarted.inspectAndRenew({
      fence: resumed.fence,
      leaseDurationMs: 30_000,
    });
    if (inspected.outcome !== "active") throw new Error(`安全点失败：${inspected.outcome}`);
    expect(inspected.agentRevisionRevoked).toBe(true);
    await expect(
      restarted.consumeExternalEffectPermit({
        fence: inspected.fence,
        expectedAttemptVersion: 1,
        permit: permit.permit,
      }),
    ).resolves.toEqual({ outcome: "agent_revision_revoked" });
    await expect(
      restarted.issueExternalEffectPermit({
        fence: inspected.fence,
        expectedAttemptVersion: resumed.snapshot.attempt.version,
        effect: "model_start",
        call: {
          callId: "revoked-call",
          toolName: "pi_model",
          argsDigest: sha256Digest("0".repeat(64)),
        },
        permitDurationMs: 3_000,
      }),
    ).resolves.toEqual({ outcome: "agent_revision_revoked" });
  });

  it("Agent 自带 Skill 缺失、撤销或摘要不一致时拒绝创建 Run，不回退到 Tenant 版本", async () => {
    const owner = await createFixture("agent_skill_unavailable");
    const skillId = "skill_agent_unavailable";
    const defaults = await readDefaultAgentRevision();
    if (defaults === undefined) throw new Error("默认 Agent Revision 不可见");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
      [owner.user.id],
    );
    await withTenantTransaction(migratorPool, owner.scope, async (client) => {
      await client.query(
        `INSERT INTO skills(id,canonical_key,publisher,display_name,recommended_version,status)
         VALUES ($1,'agent-unavailable','测试','审阅','2.0.0','active')`,
        [skillId],
      );
      await client.query(
        `INSERT INTO skill_versions(skill_id,version,description,compatibility,package_digest,
             entrypoint_path,entrypoint_digest,package_blob_ref,security_status,status)
         VALUES ($1,'2.0.0','可用的 Tenant 版本','runtime >= 1',repeat('a',64),
                 'SKILL.md',repeat('b',64),'test/tenant-fallback-package','verified','available')`,
        [skillId],
      );
      await client.query(
        `INSERT INTO skill_versions(skill_id,version,description,compatibility,package_digest,
             entrypoint_path,entrypoint_digest,package_blob_ref,security_status,status)
         VALUES ($1,'1.0.0','Agent 固定版本','runtime >= 1',repeat('c',64),
                 'SKILL.md',repeat('d',64),'test/agent-skill-package','verified','available')`,
        [skillId],
      );
      await client.query(
        `INSERT INTO skill_version_files(skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref)
         VALUES ($1,'2.0.0','SKILL.md','text/markdown',20,repeat('b',64),'test/tenant-fallback-entrypoint')`,
        [skillId],
      );
      await client.query(
        `INSERT INTO skill_version_files(skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref)
         VALUES ($1,'1.0.0','SKILL.md','text/markdown',20,repeat('d',64),'test/agent-skill-entrypoint')`,
        [skillId],
      );
    });
    await withTenantTransaction(runtimePool, owner.scope, (client) =>
      client.query(
        `INSERT INTO tenant_skill_installations(tenant_id,skill_id,skill_version,invocation_name,status)
         VALUES ($1,$2,'2.0.0','agent-unavailable','enabled')`,
        [owner.tenant.id, skillId],
      ),
    );
    const agents = new PgAgentDefinitionRepository(adminControlPool);
    const skillContent = {
      ...defaults.content,
      skillVersions: [{ skillId, version: "1.0.0" }],
    };
    await expect(
      agents.validateImport(owner.user.id, {
        id: "agent_skill_missing_reference",
        availability: { mode: "selected_tenants", tenantIds: [owner.tenant.id] },
        content: { ...defaults.content, skillVersions: [{ skillId, version: "3.0.0" }] },
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await expect(
      agents.createDraft({
        actorUserId: owner.user.id,
        id: "agent_skill_missing_reference",
        availability: { mode: "selected_tenants", tenantIds: [owner.tenant.id] },
        content: { ...defaults.content, skillVersions: [{ skillId, version: "3.0.0" }] },
        revisionId: "agent_skill_missing_revision",
        idempotencyKey: "agent-skill-missing-reference",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await expect(
      agents.createDraft({
        actorUserId: owner.user.id,
        id: "agent_skill_duplicate_reference",
        availability: { mode: "selected_tenants", tenantIds: [owner.tenant.id] },
        content: {
          ...defaults.content,
          skillVersions: [...skillContent.skillVersions, ...skillContent.skillVersions],
        },
        revisionId: "agent_skill_duplicate_revision",
        idempotencyKey: "agent-skill-duplicate-reference",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await migratorPool.query("UPDATE skills SET status='revoked' WHERE id=$1", [skillId]);
    await expect(
      agents.createDraft({
        actorUserId: owner.user.id,
        id: "agent_skill_revoked_reference",
        availability: { mode: "selected_tenants", tenantIds: [owner.tenant.id] },
        content: skillContent,
        revisionId: "agent_skill_revoked_revision",
        idempotencyKey: "agent-skill-revoked-reference",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await migratorPool.query("UPDATE skills SET status='active' WHERE id=$1", [skillId]);
    await migratorPool.query(
      "UPDATE skill_versions SET status='revoked' WHERE skill_id=$1 AND version='1.0.0'",
      [skillId],
    );
    await expect(
      agents.createDraft({
        actorUserId: owner.user.id,
        id: "agent_skill_revoked_version",
        availability: { mode: "selected_tenants", tenantIds: [owner.tenant.id] },
        content: skillContent,
        revisionId: "agent_skill_revoked_version_revision",
        idempotencyKey: "agent-skill-revoked-version",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await migratorPool.query(
      "UPDATE skill_versions SET status='available' WHERE skill_id=$1 AND version='1.0.0'",
      [skillId],
    );
    const draft = await agents.createDraft({
      actorUserId: owner.user.id,
      id: "agent_skill_unavailable",
      availability: { mode: "selected_tenants", tenantIds: [owner.tenant.id] },
      content: skillContent,
      revisionId: "agent_skill_unavailable_v1",
      idempotencyKey: "agent-skill-unavailable-draft",
      expectedGeneration: 0,
    });
    await migratorPool.query(
      "UPDATE skill_versions SET status='revoked' WHERE skill_id=$1 AND version='1.0.0'",
      [skillId],
    );
    await expect(
      agents.publish({
        actorUserId: owner.user.id,
        definitionId: draft.definition.id,
        revisionId: draft.revision.id,
        idempotencyKey: "agent-skill-unavailable-publish",
        expectedGeneration: draft.definition.generation,
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    await migratorPool.query(
      "UPDATE skill_versions SET status='available' WHERE skill_id=$1 AND version='1.0.0'",
      [skillId],
    );
    await agents.publish({
      actorUserId: owner.user.id,
      definitionId: draft.definition.id,
      revisionId: draft.revision.id,
      idempotencyKey: "agent-skill-unavailable-publish",
      expectedGeneration: draft.definition.generation,
    });
    const thread = rehydrateThread(
      {
        ...owner.thread,
        id: "thread_agent_skill_unavailable_bound",
        agentDefinitionId: draft.definition.id,
      },
      owner.tenant,
      owner.user,
      owner.membership,
    );
    expect(await repositories.threads.create(owner.scope, thread)).toMatchObject({
      outcome: "created",
    });
    const creation = new PgRunDispatchCreation(runtimePool);
    const expectRejected = async (suffix: string) => {
      const id = runId(`run_agent_skill_unavailable_${suffix}`);
      await expect(
        creation.createQueuedRun({
          scope: owner.scope,
          thread,
          run: createRun({ id, thread, now: timestamp(5) }),
          inputText: "审阅",
          idempotency: { key: id, requestHash: sha256Digest("0".repeat(64)) },
        }),
      ).rejects.toMatchObject({ code: "AGENT_REVISION_UNAVAILABLE" });
      const rows = await withTenantTransaction(runtimePool, owner.scope, (client) =>
        client.query(
          `SELECT 1 FROM runs WHERE id=$1
           UNION ALL SELECT 1 FROM run_agent_snapshots WHERE run_id=$1
           UNION ALL SELECT 1 FROM run_skill_snapshots WHERE run_id=$1`,
          [id],
        ),
      );
      expect(rows.rowCount).toBe(0);
    };
    await expectRejected("missing");
    const app = createApiApp(
      {
        auth: { resolve: async () => owner.scope },
        repositories,
        createCapability: createApiCreateCapability({
          threadCreation: new PgThreadCreation(runtimePool),
          enqueueOutbox: creation,
        }),
        archiveThread: new PgArchiveThreadCommand(runtimePool),
        renamePersonalThread: new PgRenamePersonalThreadCommand(runtimePool),
        cursorCodec: createThreadCursorCodec({
          activeKid: "integration-key",
          keys: [{ kid: "integration-key", secret: Buffer.alloc(32, 11).toString("base64url") }],
          clock: { now: () => timestamp(20) },
          ttlMilliseconds: 60_000,
          maximumTtlMilliseconds: 60_000,
        }),
        readiness: { probe: async () => undefined },
        clock: { now: () => timestamp(20) },
        ids: {
          thread: () => thread.id,
          workspace: () => owner.workspace.id,
          run: () => runId("run_agent_skill_unavailable_http"),
        },
      },
      { logger: false },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/threads/${thread.id}/runs`,
        headers: { "idempotency-key": "agent-skill-unavailable-http" },
        payload: { input: "审阅" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({
        code: "AGENT_REVISION_UNAVAILABLE",
        retryable: false,
      });
    } finally {
      await app.close();
    }
    await migratorPool.query(
      "UPDATE skill_versions SET status='revoked',package_blob_ref=$2 WHERE skill_id=$1 AND version='1.0.0'",
      [skillId, skillSnapshotBlobRef("a".repeat(64), 250, "application/json")],
    );
    await expectRejected("revoked");
    await migratorPool.query(
      `UPDATE skill_versions SET status='available',entrypoint_digest=repeat('c',64)
        WHERE skill_id=$1 AND version='1.0.0'`,
      [skillId],
    );
    await expectRejected("corrupt");
    await migratorPool.query(
      `UPDATE skill_versions SET entrypoint_digest=repeat('b',64),package_blob_ref=$2
        WHERE skill_id=$1 AND version='1.0.0'`,
      [skillId, skillSnapshotBlobRef("d".repeat(64), 250, "application/json")],
    );
    await expectRejected("package_ref_mismatch");
  });

  it("RunAgentSnapshot 默认 Agent 保留 Prompt Golden 字节，损坏和缺失快照不回退", async () => {
    const f = await createFixture("agent_snapshot_golden");
    const scope = { tenantId: f.scope.tenantId, threadId: f.thread.id, runId: f.run.id };
    const snapshot = await withTenantTransaction(runtimePool, f.scope, (client) =>
      readRunAgentSnapshot(client, scope),
    );
    if (snapshot === undefined) throw new Error("默认 Agent 快照不可见");
    const prompt = (operatorInstructions: string) =>
      buildRuntimeSystemPrompt({
        schemaVersion: 1,
        operatorInstructions,
        capabilities: [],
        availableSkills: [],
        untrusted: { tenant: [], skill: [], user: [] },
      });
    expect(prompt(snapshot.content.operatorInstructions)).toEqual(
      prompt(DEFAULT_AGENT_OPERATOR_INSTRUCTIONS),
    );
    const fixtures = await Promise.all(
      ["corrupt", "missing"].map(async (kind) => {
        const isolated = await createFixture(`agent_snapshot_${kind}`);
        const run = createRun({
          id: runId(`run_agent_snapshot_${kind}_queued`),
          thread: isolated.thread,
          now: timestamp(5),
        });
        expect(
          await new PgRunDispatchCreation(runtimePool).createQueuedRun({
            scope: isolated.scope,
            thread: isolated.thread,
            run,
            inputText: "执行",
            idempotency: { key: run.id, requestHash: sha256Digest("0".repeat(64)) },
          }),
        ).toMatchObject({ outcome: "created" });
        return { kind, run, isolated };
      }),
    );
    for (const { kind, run, isolated } of fixtures) {
      // 使用隔离 Schema 的管理连接模拟磁盘事实损坏；Runtime 本身不能改写此行。
      const table = `"${schema}".run_agent_snapshots`;
      await administrativePool.query(
        kind === "corrupt"
          ? `UPDATE ${table} SET revision_digest=repeat('0',64) WHERE run_id=$1`
          : `DELETE FROM ${table} WHERE run_id=$1`,
        [run.id],
      );
      await expect(
        new PgExecutionPersistence(runtimePool).claim({
          scope: {
            tenantId: isolated.tenant.id,
            threadId: isolated.thread.id,
            runId: run.id,
            rootRunId: run.id,
            workspaceId: isolated.workspace.id,
          },
          workerId: "snapshot-invalid-worker",
          leaseDurationMs: 30_000,
        }),
      ).resolves.toMatchObject({
        outcome: "claimed",
        snapshot: { agent: "AGENT_SNAPSHOT_INVALID" },
      });
    }
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
      expect(created.map((policy) => policy.policyname)).toEqual([
        "cleanup_outbox_admin_projection_read",
        "execution_attempts_admin_projection_read",
        "memory_ingestion_outbox_admin_projection_read",
        "run_dispatch_outbox_admin_projection_read",
        "run_events_admin_projection_read",
        "run_execution_inputs_admin_projection_read",
        "runs_admin_projection_read",
        "sandbox_registry_admin_projection_read",
        "scheduled_task_occurrences_admin_projection_read",
        "scheduled_tasks_admin_projection_read",
        "tenant_skill_installations_admin_projection_read",
        "thread_continuity_metric_observations_admin_projection_read",
        "threads_admin_projection_read",
        "user_accounts_admin_projection_read",
        "user_sessions_admin_projection_read",
      ]);
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
    // generation 是安装级单例，仅更换 Tenant 或 Run 无法隔离其他用例的配置变更。
    const target = await createIsolatedMigrationTarget("memory_config");
    const isolatedRuntimePool = createPostgresPool({
      connectionString: target.runtimeConnectionString,
      schema: target.context.schema,
      maxConnections: 2,
    });
    const isolatedAdminControlUrl = new URL(target.connectionString);
    isolatedAdminControlUrl.username = target.context.adminControlRole;
    const isolatedAdminControlPool = createPostgresPool({
      connectionString: isolatedAdminControlUrl.toString(),
      schema: target.context.schema,
      maxConnections: 2,
    });
    try {
      await migrateUp(target.pool, target.context);
      const isolatedRepositories = new PgCoreRepositories(isolatedRuntimePool);
      const initial = await createFixture("memory_bootstrap", isolatedRepositories);
      const cipher = new ModelProviderCredentialCipher("integration-memory-root-at-least-32-bytes");
      const repository = new PgAdminControlRepository(isolatedAdminControlPool, cipher);
      const service = new AdminControlService(
        repository,
        repository,
        { probeModel: async () => undefined, probeMemory: async () => undefined },
        [],
      );
      const runtime = new PgRuntimeControlConfigurationRepository(isolatedRuntimePool, cipher);
      const scope = { tenantId: initial.scope.tenantId, runId: initial.run.id };
      await target.pool.query(
        "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
        [initial.user.id],
      );
      const context = (id: string) => ({
        actorUserId: initial.user.id,
        idempotencyKey: `memory-online-${id}`,
        requestDigest: "b".repeat(64),
      });
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
      const raw = await target.pool.query(
        "SELECT configuration FROM admin_control_config_revisions WHERE object_kind='memory_provider'",
      );
      expect(JSON.stringify(raw.rows)).not.toContain(command.apiKey);
      expect(raw.rows[0].configuration.credential).toBeDefined();
      await expect(runtime.resolveForRun(scope)).resolves.toEqual(empty);
      const activeRun = await createFixture("memory_active", isolatedRepositories);
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
      const newRun = await createFixture("memory_updated", isolatedRepositories);
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
        isolatedAdminControlPool.query("SELECT * FROM run_runtime_config_snapshots"),
      ).rejects.toMatchObject({ code: "42501" });
      const foreign = await withTenantTransaction(isolatedRuntimePool, initial.scope, (client) =>
        client.query("SELECT run_id FROM run_runtime_config_snapshots WHERE run_id=$1", [
          activeRun.run.id,
        ]),
      );
      expect(foreign.rows).toHaveLength(0);
    } finally {
      await Promise.all([isolatedRuntimePool.end(), isolatedAdminControlPool.end()]);
      await target.close();
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

  it("外部工具原始名称迁移仅允许 MCP 版本绑定远程工具名", async () => {
    const result = await migratorPool.query<{ column_name: string; constraint_definition: string }>(
      `SELECT column_state.column_name, pg_get_constraintdef(constraint_row.oid) AS constraint_definition
         FROM information_schema.columns column_state
         JOIN pg_constraint constraint_row ON constraint_row.conrelid = format('%I.%I',$1::text,'external_tool_versions')::regclass
        WHERE column_state.table_schema=$1 AND column_state.table_name='external_tool_versions'
          AND column_state.column_name='remote_tool_name'
          AND constraint_row.conname='external_tool_versions_remote_name_source_check'`,
      [schema],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.constraint_definition).toContain("remote_tool_name IS NOT NULL");
    expect(result.rows[0]?.constraint_definition).toContain("remote_tool_name IS NULL");
  });

  it("外部工具快照视图仅向 Worker Coordinator 开放双栅栏读取，Runtime 只能读许可门", async () => {
    const privileges = await migratorPool.query<{
      readonly view_select: boolean;
      readonly version_select: boolean;
      readonly credential_select: boolean;
      readonly revocation_select: boolean;
      readonly worker_select: boolean;
      readonly permit_select: boolean;
    }>(
      `SELECT has_table_privilege($1,format('%I.%I',$2::text,'worker_run_external_tool_snapshots'),'SELECT') AS view_select,
              has_table_privilege($3,format('%I.%I',$2::text,'worker_run_external_tool_snapshots'),'SELECT') AS worker_select,
              has_table_privilege($1,format('%I.%I',$2::text,'runtime_external_tool_permit_gate'),'SELECT') AS permit_select,
              has_table_privilege($1,format('%I.%I',$2::text,'external_tool_versions'),'SELECT') AS version_select,
              has_table_privilege($1,format('%I.%I',$2::text,'external_tool_credentials'),'SELECT') AS credential_select,
              has_table_privilege($1,format('%I.%I',$2::text,'external_tool_revocations'),'SELECT') AS revocation_select`,
      [runtimeRole, schema, workerCoordinatorRole],
    );
    expect(privileges.rows).toEqual([
      {
        view_select: false,
        worker_select: true,
        permit_select: true,
        version_select: false,
        credential_select: false,
        revocation_select: false,
      },
    ]);
    const view = await migratorPool.query<{ readonly definition: string }>(
      `SELECT pg_get_viewdef(format('%I.%I',$1::text,'worker_run_external_tool_snapshots')::regclass,true) AS definition`,
      [schema],
    );
    expect(view.rows[0]?.definition).toContain("app.external_claim_token");
    expect(view.rows[0]?.definition).toContain("execution_workspace_fences");
    expect(view.rows[0]?.definition).toContain("workspace_write_leases");
    expect(view.rows[0]?.definition).toContain("external_tool_revocations");
    expect(view.rows[0]?.definition).toContain("externalTools");
    const method = await migratorPool.query<{ readonly data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='external_tool_versions' AND column_name='http_method'`,
      [schema],
    );
    expect(method.rows).toEqual([{ data_type: "text" }]);
  });

  it("外部工具快照视图真实 Runtime 即使持有正确证明并切换 Tenant/Run 也不可读密文", async () => {
    const first = await createExternalToolFixture("runtime_first");
    const second = await createExternalToolFixture("runtime_second");
    for (const fence of [
      first.fence,
      { ...first.fence, scope: { ...first.fence.scope, runId: first.manager.run.id } },
      second.fence,
    ]) {
      await expect(
        withTenantTransaction(runtimePool, fence.scope, async (client) => {
          await client.query(
            `SELECT set_config('app.external_tool_run_id',$1,true),
                  set_config('app.external_claim_token',$2,true),
                  set_config('app.external_claim_epoch',$3,true),
                  set_config('app.external_lease_epoch',$4,true)`,
            [
              fence.scope.runId,
              fence.runClaim.token,
              String(fence.runClaim.epoch),
              String(fence.workspaceLease.epoch),
            ],
          );
          return client.query("SELECT ciphertext FROM worker_run_external_tool_snapshots");
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const snapshots = await first.reader.read({
      fence: first.fence,
      toolVersionIds: [first.versionId],
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.tool.httpMethod).toBe("POST");
    expect(snapshots[0]?.credential === "b5-placeholder-credential").toBe(true);
    await expect(
      first.reader.read({
        fence: first.fence,
        toolVersionIds: [first.outsideVersionId],
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" });
    await expect(
      first.reader.read({
        fence: { ...first.fence, scope: second.fence.scope },
        toolVersionIds: [second.versionId],
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" });
    await expect(
      first.reader.read({
        fence: { ...first.fence, scope: { ...first.fence.scope, runId: first.manager.run.id } },
        toolVersionIds: [first.versionId],
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" });
    const gate = await withTenantTransaction(runtimePool, first.fence.scope, (client) =>
      client.query("SELECT * FROM runtime_external_tool_permit_gate WHERE run_id=$1", [
        first.fence.scope.runId,
      ]),
    );
    expect(gate.rows).toEqual([
      {
        tenant_id: first.fence.scope.tenantId,
        run_id: first.fence.scope.runId,
        tool_version_id: first.versionId,
        model_tool_name: first.toolName,
        revoked: false,
      },
    ]);
  });

  it("外部工具快照视图拒绝 stale claim、workspace fence 与错配 scope", async () => {
    const fixture = await createExternalToolFixture("stale");
    const { fence, reader, versionId } = fixture;
    const staleFences: readonly ExecutionFence[] = [
      { ...fence, runClaim: { ...fence.runClaim, token: "stale-placeholder-token" } },
      { ...fence, runClaim: { ...fence.runClaim, epoch: fence.runClaim.epoch + 1 } },
      {
        ...fence,
        workspaceLease: { ...fence.workspaceLease, epoch: fence.workspaceLease.epoch + 1 },
      },
      { ...fence, scope: { ...fence.scope, workspaceId: fixture.manager.workspace.id } },
      { ...fence, scope: { ...fence.scope, threadId: fixture.manager.thread.id } },
      {
        ...fence,
        scope: { ...fence.scope, baseRevisionId: workspaceRevisionId("stale-revision") },
      },
    ];
    for (const staleFence of staleFences) {
      await expect(
        reader.read({ fence: staleFence, toolVersionIds: [versionId] }),
      ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" });
    }
    const released = await withTenantTransaction(migratorPool, fence.scope, (client) =>
      client.query(
        "UPDATE run_claims SET released_at=clock_timestamp() WHERE tenant_id=$1 AND claim_token=$2",
        [fence.scope.tenantId, fence.runClaim.token],
      ),
    );
    expect(released.rowCount).toBe(1);
    await expect(reader.read({ fence, toolVersionIds: [versionId] })).rejects.toMatchObject({
      code: "EXTERNAL_TOOL_SNAPSHOT_INVALID",
    });
  });

  it.each(["claim", "lease"])(
    "外部工具快照视图拒绝数据库已过期的 %s，调用者未来时间无效",
    async (expired) => {
      const { fence, reader, versionId } = await createExternalToolFixture(`expired_${expired}`);
      const target = expired === "claim" ? "run_claims" : "workspace_write_leases";
      const acquiredClock =
        expired === "claim" ? ",acquired_at=clock_timestamp()-interval '2 seconds'" : "";
      const updated = await withTenantTransaction(migratorPool, fence.scope, (client) =>
        client.query(
          `UPDATE ${target} SET expires_at=clock_timestamp()-interval '1 second'${acquiredClock} WHERE tenant_id=$1`,
          [fence.scope.tenantId],
        ),
      );
      expect(updated.rowCount).toBe(1);
      await expect(reader.read({ fence, toolVersionIds: [versionId] })).rejects.toMatchObject({
        code: "EXTERNAL_TOOL_SNAPSHOT_INVALID",
      });
    },
  );

  it("外部工具快照视图已撤销许可不可消费，读取错误保留明确撤销分类", async () => {
    const fixture = await createExternalToolFixture("revoked");
    const permit = await fixture.issue();
    await fixture.registry.revoke({
      actorUserId: fixture.manager.user.id,
      toolVersionId: fixture.versionId,
      reason: "测试撤销",
    });
    await expect(
      fixture.reader.read({ fence: fixture.fence, toolVersionIds: [fixture.versionId] }),
    ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_REVOKED" });
    await expect(
      fixture.worker.consumeExternalEffectPermit({
        fence: fixture.fence,
        expectedAttemptVersion: 1,
        permit,
      }),
    ).resolves.toEqual({ outcome: "external_tool_revoked" });
    const stored = await withTenantTransaction(runtimePool, fixture.fence.scope, (client) =>
      client.query("SELECT consumed_at FROM external_effect_permits WHERE permit_id=$1", [
        permit.permitId,
      ]),
    );
    expect(stored.rows).toEqual([{ consumed_at: null }]);
    const ciphertext = await withTenantTransaction(
      workerCoordinatorPool,
      fixture.fence.scope,
      async (client) => {
        await client.query(
          `SELECT set_config('app.external_claim_token',$1,true),set_config('app.external_claim_epoch',$2,true),set_config('app.external_lease_epoch',$3,true)`,
          [
            fixture.fence.runClaim.token,
            String(fixture.fence.runClaim.epoch),
            String(fixture.fence.workspaceLease.epoch),
          ],
        );
        return client.query(
          "SELECT revoked,ciphertext FROM worker_run_external_tool_snapshots WHERE run_id=$1",
          [fixture.fence.scope.runId],
        );
      },
    );
    expect(ciphertext.rows).toEqual([{ revoked: true, ciphertext: null }]);
  });

  it("外部工具快照视图许可绑定精确版本并发消费恰好一次，不能换绑同名新版本", async () => {
    const fixture = await createExternalToolFixture("consume_once");
    const permit = await fixture.issue();
    await expect(
      fixture.worker.consumeExternalEffectPermit({
        fence: fixture.fence,
        expectedAttemptVersion: 1,
        permit: { ...permit, toolVersionId: fixture.outsideVersionId },
      }),
    ).resolves.toEqual({ outcome: "external_tool_snapshot_invalid" });
    const { toolVersionId, ...unbound } = permit;
    expect(toolVersionId).toBe(fixture.versionId);
    await expect(
      fixture.worker.consumeExternalEffectPermit({
        fence: fixture.fence,
        expectedAttemptVersion: 1,
        permit: unbound,
      }),
    ).resolves.toEqual({ outcome: "external_tool_snapshot_invalid" });
    const results = await Promise.all(
      [0, 1].map(() =>
        fixture.worker.consumeExternalEffectPermit({
          fence: fixture.fence,
          expectedAttemptVersion: 1,
          permit,
        }),
      ),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "already_consumed",
      "consumed",
    ]);
  });

  it("外部工具快照视图拒绝许可引用快照外的同名版本", async () => {
    const fixture = await createExternalToolFixture("outside_permit");
    const permit = await fixture.issue(fixture.outsideVersionId);
    await expect(
      fixture.worker.consumeExternalEffectPermit({
        fence: fixture.fence,
        expectedAttemptVersion: 1,
        permit,
      }),
    ).resolves.toEqual({ outcome: "external_tool_snapshot_invalid" });
  });

  it("外部工具快照视图撤销先持有 FK KEY SHARE 时消费等待，提交后重新读取并拒绝", async () => {
    const fixture = await createExternalToolFixture("revoke_race");
    const permit = await fixture.issue();
    const blocker = await adminControlPool.connect();
    let consumption: ReturnType<PgExecutionPersistence["consumeExternalEffectPermit"]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('app.user_id',$1,true)", [fixture.manager.user.id]);
      await blocker.query(
        "INSERT INTO external_tool_revocations(tool_version_id,reason,actor_user_id) VALUES($1,'测试并发撤销',$2)",
        [fixture.versionId, fixture.manager.user.id],
      );
      const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      consumption = fixture.worker.consumeExternalEffectPermit({
        fence: fixture.fence,
        expectedAttemptVersion: 1,
        permit,
      });
      await waitForDatabaseBlocker(pid.rows[0]!.pid);
      await blocker.query("COMMIT");
      await expect(consumption).resolves.toEqual({ outcome: "external_tool_revoked" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await consumption;
    }
  });

  it("外部工具快照视图真实消费事务持锁至提交，阻塞后到撤销且不需要 Runtime 底表 UPDATE 权限", async () => {
    const fixture = await createExternalToolFixture("consume_race");
    const permit = await fixture.issue();
    const paused = Promise.withResolvers<number>();
    const resume = Promise.withResolvers<void>();
    const pausingPool = {
      async connect() {
        const client = await runtimePool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql.includes("UPDATE external_effect_permits SET consumed_at")) {
              const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              paused.resolve(pid.rows[0]!.pid);
              await resume.promise;
            }
            return result;
          },
          release(error?: Error) {
            client.release(error);
          },
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
    const consumption = new PgExecutionPersistence(pausingPool).consumeExternalEffectPermit({
      fence: fixture.fence,
      expectedAttemptVersion: 1,
      permit,
    });
    let revocation: Promise<void> | undefined;
    try {
      const blockerPid = await Promise.race([
        paused.promise,
        consumption.then((result) => {
          throw new Error(`消费未到达提交边界：${result.outcome}`);
        }),
      ]);
      revocation = fixture.registry.revoke({
        actorUserId: fixture.manager.user.id,
        toolVersionId: fixture.versionId,
        reason: "消费后撤销",
      });
      await waitForDatabaseBlocker(blockerPid);
      resume.resolve();
      await expect(consumption).resolves.toMatchObject({ outcome: "consumed" });
      await revocation;
      await expect(
        fixture.reader.read({ fence: fixture.fence, toolVersionIds: [fixture.versionId] }),
      ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_REVOKED" });
    } finally {
      resume.resolve();
      await consumption;
      await revocation;
    }
  });

  it("外部工具 Agent 选择投影不含 Schema 与凭据字段", async () => {
    const columns = await migratorPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='external_tool_selectable_versions'
        ORDER BY ordinal_position`,
      [schema],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "tool_version_id",
      "source",
      "model_tool_name",
      "description",
      "batch_name",
    ]);
    const privileges = await migratorPool.query<{
      runtime_select: boolean;
      control_select: boolean;
    }>(
      `SELECT has_table_privilege($1,format('%I.external_tool_selectable_versions',$3::text),'SELECT') AS runtime_select,
              has_table_privilege($2,format('%I.external_tool_selectable_versions',$3::text),'SELECT') AS control_select`,
      [runtimeRole, adminControlRole, schema],
    );
    expect(privileges.rows[0]).toEqual({ runtime_select: false, control_select: true });
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
    const target = await createIsolatedMigrationTarget("down_acl_failure");
    try {
      await migrateUp(target.pool, target.context);
      await administrativePool.query(
        `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${target.context.runtimeRole}"`,
      );
      await expect(
        migrateDown(target.pool, {
          allowDestructive: true,
          environment: "test",
          ...target.context,
        }),
      ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
      const state = await target.pool.query<{ threads: string | null; migration_count: string }>(
        `SELECT to_regclass('threads')::text AS threads,
                (SELECT count(*)::text FROM runtime_schema_migrations) AS migration_count`,
      );
      expect(state.rows[0]).toMatchObject({
        threads: "threads",
        migration_count: String(migrationContract.count),
      });
    } finally {
      await administrativePool.query(
        `GRANT CONNECT ON DATABASE "${databaseName}" TO "${target.context.runtimeRole}"`,
      );
      await target.close();
    }
  });

  it("Playground 来源数据在 FORCE RLS 隐藏时仍阻止回退并保留隔离事实", async () => {
    const target = await createIsolatedMigrationTarget("playground_down_guard");
    try {
      await migrateUp(target.pool, target.context);
      await administrativePool.query(
        `BEGIN;
         SET LOCAL search_path TO "${target.context.schema}";
         SET LOCAL session_replication_role = replica;
         INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at,is_playground)
           VALUES('tenant_hidden','thread_hidden','user_hidden','Playground','active',now(),now(),true);
         INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at,origin)
           VALUES('tenant_hidden','run_hidden','thread_hidden','queued',now(),now(),'playground');
         COMMIT;`,
      );
      const hidden = await target.pool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM runs WHERE origin='playground'",
      );
      expect(hidden.rows[0]?.count).toBe("0");

      let rollbackError: unknown;
      try {
        await migrateDown(target.pool, {
          ...target.context,
          runtimeRole: target.context.runtimeRole,
          targetVersion: 14,
          allowDestructive: true,
          environment: "test",
        });
      } catch (error) {
        rollbackError = error;
      }
      expect(sqlStateFromCause(rollbackError)).toBe("55000");
      const preserved = await administrativePool.query<{
        readonly origin: string;
        readonly marked: boolean;
      }>(
        `SELECT run.origin,thread.is_playground AS marked
           FROM "${target.context.schema}".runs run
           JOIN "${target.context.schema}".threads thread
             ON thread.tenant_id=run.tenant_id AND thread.id=run.thread_id
          WHERE run.id='run_hidden'`,
      );
      expect(preserved.rows).toEqual([{ origin: "playground", marked: true }]);
      const migrationVersion = await administrativePool.query<{ readonly version: number }>(
        `SELECT max(version)::int AS version FROM "${target.context.schema}".runtime_schema_migrations`,
      );
      expect(migrationVersion.rows[0]?.version).toBe(migrationContract.latestVersion);
    } finally {
      await target.close();
    }
  });

  it("down 只有显式 test 授权可执行并能再次向前", async () => {
    const target = await createIsolatedMigrationTarget("authorized_down");
    try {
      await migrateUp(target.pool, target.context);
      await expect(
        migrateDown(target.pool, {
          allowDestructive: false as true,
          environment: "test",
          ...target.context,
        }),
      ).rejects.toThrow("禁止破坏性");
      expect(
        await migrateDown(target.pool, {
          allowDestructive: true,
          environment: "test",
          ...target.context,
        }),
      ).toEqual([]);
      const usageAfterDown = await target.pool.query<{ allowed: boolean }>(
        "SELECT has_schema_privilege($1, current_schema(), 'USAGE') AS allowed",
        [runtimeRole],
      );
      expect(usageAfterDown.rows[0]?.allowed).toBe(false);
      const downPrivileges = await target.pool.query<{ privilege: string; allowed: boolean }>(
        `SELECT requested.privilege,
                has_table_privilege($1, 'runtime_schema_migrations', requested.privilege) AS allowed
           FROM unnest($2::text[]) AS requested(privilege)`,
        [
          runtimeRole,
          ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
        ],
      );
      expect(downPrivileges.rows.every((entry) => !entry.allowed)).toBe(true);
      const routineState = await target.pool.query<{
        routine_count: string;
        default_acl_count: string;
      }>(
        `SELECT (SELECT count(*)::text FROM pg_proc
                  WHERE pronamespace = current_schema()::regnamespace) AS routine_count,
                (SELECT count(*)::text
                   FROM pg_default_acl defaults
                  WHERE defaults.defaclrole = $1::regrole
                    AND defaults.defaclobjtype = 'f') AS default_acl_count`,
        [target.context.migratorRole],
      );
      expect(routineState.rows[0]).toEqual({ routine_count: "0", default_acl_count: "0" });
      expect(await migrateUp(target.pool, target.context)).toHaveLength(migrationContract.count);
    } finally {
      await target.close();
    }
  });

  it("导入导出审计在迁移角色受 RLS 限制时仍以 P0001 阻止回退", async () => {
    const target = await createIsolatedMigrationTarget("transfer_down_guard");
    try {
      await migrateUp(target.pool, target.context);
      await administrativePool.query(
        `BEGIN;
         SET LOCAL search_path TO "${target.context.schema}";
         SET LOCAL session_replication_role = replica;
         INSERT INTO agent_definition_audits(definition_id,action,generation,actor_user_id,reason)
           VALUES('definition_hidden','imported',0,'actor_hidden','test rollback guard');
         COMMIT;`,
      );
      await expect(
        migrateDown(target.pool, {
          targetVersion: migrationContract.latestVersion - 1,
          allowDestructive: true,
          environment: "test",
          ...target.context,
        }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", cause: { code: "P0001" } });
      const state = await target.pool.query<{
        readonly version: number;
        readonly row_security: boolean;
        readonly force_row_security: boolean;
      }>(
        `SELECT (SELECT max(version)::int FROM runtime_schema_migrations) AS version,
                relation.relrowsecurity AS row_security,
                relation.relforcerowsecurity AS force_row_security
           FROM pg_class relation
          WHERE relation.oid='agent_definition_audits'::regclass`,
      );
      expect(state.rows[0]).toEqual({
        version: migrationContract.latestVersion,
        row_security: true,
        force_row_security: true,
      });
    } finally {
      await target.close();
    }
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
      `GRANT TEMPORARY ON DATABASE "${databaseName}" TO "${downTarget.context.runtimeRole}"`,
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
        `REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM "${downTarget.context.runtimeRole}"`,
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

  it("Runtime 的业务 Schema 不包含可执行 Routine", async () => {
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
      ["runs", new Set(["SELECT", "INSERT"])],
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
      ["runs", new Set(["status", "version", "updated_at"])],
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
          "has_client_tool_history",
        ]),
      ],
      ["memberships", new Set(["lock_marker", "status"])],
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
    const sequencePrivileges = await migratorPool.query<{
      sequence_name: string;
      can_select: boolean;
      can_update: boolean;
      can_use: boolean;
    }>(
      `SELECT relname AS sequence_name,
              has_sequence_privilege($1, oid, 'SELECT') AS can_select,
              has_sequence_privilege($1, oid, 'UPDATE') AS can_update,
              has_sequence_privilege($1, oid, 'USAGE') AS can_use
         FROM pg_class
        WHERE relnamespace = current_schema()::regnamespace AND relkind = 'S'
        ORDER BY relname`,
      [runtimeRole],
    );
    expect(sequencePrivileges.rows).toEqual([
      {
        sequence_name: "agent_definition_audits_audit_id_seq",
        can_select: false,
        can_update: false,
        can_use: false,
      },
      {
        sequence_name: "external_tool_admin_audits_audit_id_seq",
        can_select: false,
        can_update: false,
        can_use: false,
      },
    ]);
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

function postgresSqlState(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown };
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code) &&
      ![
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ECONNRESET",
        "ECONNABORTED",
        "EPIPE",
      ].includes(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function itWithSqlStateDiagnostic(title: string, test: () => Promise<void>): void {
  it(title, async () => {
    try {
      await test();
    } catch (error) {
      const code = postgresSqlState(error);
      if (code !== undefined) {
        throw new Error(`PostgreSQL API Key 用例失败（SQLSTATE ${code}）`, { cause: error });
      }
      throw error;
    }
  });
}

describe("PostgreSQL API Key 隔离与集成身份", () => {
  itWithSqlStateDiagnostic("后台接入只允许平台管理员，跨 Tenant 管理与审计原子提交", async () => {
    const manager = await createFixture("integration_manager");
    const target = await createFixture("integration_target");
    const other = await createFixture("integration_other");
    const viewer = await createFixture("integration_viewer");
    const operator = await createFixture("integration_operator");
    const disabled = await createFixture("integration_disabled");
    await migratorPool.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active'),($2,'viewer','active'),($3,'operator','active'),($4,'admin','disabled')",
      [manager.user.id, viewer.user.id, operator.user.id, disabled.user.id],
    );
    const actors = new Map(
      [manager, target, viewer, operator, disabled].map((item) => [
        `Bearer ${item.user.id}`,
        item.user.id,
      ]),
    );
    const cipher = new WebhookSecretCipher(
      "integration-test-webhook-root-placeholder-at-least-32-bytes",
    );
    const integrations = new PgIntegrationAdminRepository(adminControlPool, cipher);
    const { createAdminControlApiApp } = await import(
      "../../runtime-ts/apps/admin-control-api/src/app.js"
    );
    const app = createAdminControlApiApp({
      integrations,
      auth: {
        async resolve(input) {
          const id = actors.get(input.authorization ?? "");
          return id === undefined ? undefined : { userId: id };
        },
      },
      control: {} as AdminControlApiDependencies["control"],
      identity: {} as AdminControlApiDependencies["identity"],
      modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
      skills: {} as AdminControlApiDependencies["skills"],
      readiness: { async probe() {} },
    });
    const base = `/v1/admin/control/integrations/${target.tenant.id}`;
    const alternate = `/v1/admin/control/integrations/${other.tenant.id}`;
    const headers = { authorization: `Bearer ${manager.user.id}` };
    try {
      for (const member of [target, viewer, operator, disabled]) {
        for (const [method, path, payload] of [
          ["GET", "/api-keys", undefined],
          ["POST", "/api-keys", { name: "拒绝", scopes: ["threads:read"] }],
          ["POST", "/api-keys/key_unknown/rotate", undefined],
          ["DELETE", "/api-keys/key_unknown", undefined],
          ["GET", "/webhooks", undefined],
          [
            "POST",
            "/webhooks",
            { name: "拒绝", endpointUrl: "https://1.1.1.1/events", eventTypes: ["run.succeeded"] },
          ],
          ["POST", "/webhooks/wh_unknown/rotate-secret", undefined],
          ["POST", "/webhooks/wh_unknown/disable", undefined],
          ["DELETE", "/webhooks/wh_unknown", undefined],
        ] as const) {
          const response = await app.inject({
            method,
            url: base + path,
            headers: { authorization: `Bearer ${member.user.id}` },
            ...(payload === undefined ? {} : { payload }),
          });
          expect(response.statusCode).toBe(401);
        }
      }
      expect((await app.inject({ method: "GET", url: `${base}/api-keys` })).statusCode).toBe(401);
      const created = await app.inject({
        method: "POST",
        url: `${base}/api-keys`,
        headers,
        payload: {
          name: "后台集成",
          scopes: ["threads:read", "runs:create"],
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
      expect(created.statusCode).toBe(200);
      const { key, token } = created.json().data;
      expect(typeof token === "string" && token.startsWith("hoox_sk_")).toBe(true);
      expect(created.headers["cache-control"]).toContain("no-store");
      expect(key.integrationUserId).toBeUndefined();
      const authentication = new PgApiKeyRepository(runtimePool);
      const principal = await authentication.authenticateKey({
        token,
        now: new Date().toISOString(),
      });
      expect(principal?.tenantId).toBe(target.tenant.id);
      const listed = await app.inject({ method: "GET", url: `${base}/api-keys`, headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data.items.map((item: { id: string }) => item.id)).toContain(key.id);
      expect(listed.body.includes(token)).toBe(false);
      const foreign = await app.inject({ method: "GET", url: `${alternate}/api-keys`, headers });
      expect(foreign.json().data.items).toEqual([]);
      for (const [method, path] of [
        ["POST", `/api-keys/${key.id}/rotate`],
        ["DELETE", `/api-keys/${key.id}`],
      ] as const) {
        expect((await app.inject({ method, url: alternate + path, headers })).statusCode).toBe(404);
      }
      const rotated = await app.inject({
        method: "POST",
        url: `${base}/api-keys/${key.id}/rotate`,
        headers,
      });
      expect(rotated.statusCode).toBe(200);
      const newToken = rotated.json().data.token;
      expect(newToken !== token).toBe(true);
      expect(
        await authentication.authenticateKey({ token, now: new Date().toISOString() }),
      ).toBeUndefined();
      expect(
        (await authentication.authenticateKey({ token: newToken, now: new Date().toISOString() }))
          ?.userId,
      ).toBe(principal?.userId);
      expect(rotated.json().data.key.expiresAt).toBe(key.expiresAt);
      const revoked = await app.inject({
        method: "DELETE",
        url: `${base}/api-keys/${key.id}`,
        headers,
      });
      expect(revoked.statusCode).toBe(200);
      expect(
        await authentication.authenticateKey({ token: newToken, now: new Date().toISOString() }),
      ).toBeUndefined();
      expect(
        (await app.inject({ method: "POST", url: `${base}/api-keys/${key.id}/rotate`, headers }))
          .statusCode,
      ).toBe(404);
      const membership = await withTenantTransaction(migratorPool, target.scope, (client) =>
        client.query("SELECT status FROM memberships WHERE tenant_id=$1 AND user_id=$2", [
          target.tenant.id,
          principal?.userId,
        ]),
      );
      expect(membership.rows[0]?.status).toBe("revoked");

      const registered = await app.inject({
        method: "POST",
        url: `${base}/webhooks`,
        headers,
        payload: {
          name: "业务回调",
          endpointUrl: "https://1.1.1.1/events",
          eventTypes: ["run.succeeded", "artifact.published"],
        },
      });
      expect(registered.statusCode).toBe(200);
      const { webhook, secret } = registered.json().data;
      const subscriptions = await app.inject({ method: "GET", url: `${base}/webhooks`, headers });
      expect(subscriptions.statusCode).toBe(200);
      expect(subscriptions.body.includes(secret)).toBe(false);
      expect(
        (await app.inject({ method: "GET", url: `${alternate}/webhooks`, headers })).json().data
          .items,
      ).toEqual([]);
      for (const [method, path] of [
        ["POST", `/webhooks/${webhook.id}/rotate-secret`],
        ["POST", `/webhooks/${webhook.id}/disable`],
        ["DELETE", `/webhooks/${webhook.id}`],
      ] as const) {
        expect((await app.inject({ method, url: alternate + path, headers })).statusCode).toBe(404);
      }
      const changed = await app.inject({
        method: "POST",
        url: `${base}/webhooks/${webhook.id}/rotate-secret`,
        headers,
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().data.secret !== secret).toBe(true);
      const stored = await administrativePool.query(
        `SELECT secret_ciphertext FROM "${schema}".tenant_webhooks WHERE tenant_id=$1 AND id=$2`,
        [target.tenant.id, webhook.id],
      );
      expect(
        cipher.decrypt(target.tenant.id, webhook.id, stored.rows[0]?.secret_ciphertext) ===
          changed.json().data.secret,
      ).toBe(true);
      const stopped = await app.inject({
        method: "POST",
        url: `${base}/webhooks/${webhook.id}/disable`,
        headers,
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().data.webhook.disabledReason).toBe("disabled_by_owner");
      expect(
        (await app.inject({ method: "DELETE", url: `${base}/webhooks/${webhook.id}`, headers }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: `${base}/webhooks`, headers })).json().data.items,
      ).toEqual([]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/webhooks/${webhook.id}/rotate-secret`,
            headers,
          })
        ).statusCode,
      ).toBe(404);

      const audits = await migratorPool.query(
        "SELECT actor_user_id,tenant_id,action,object_id FROM integration_admin_audits WHERE tenant_id=$1 ORDER BY occurred_at,id",
        [target.tenant.id],
      );
      const writes = audits.rows.filter((row) => !row.action.endsWith(".list"));
      expect(writes.map((row) => row.action)).toEqual([
        "api_key.create",
        "api_key.rotate",
        "api_key.revoke",
        "webhook.create",
        "webhook.rotate",
        "webhook.disable",
        "webhook.delete",
      ]);
      expect(writes.every((row) => row.actor_user_id === manager.user.id)).toBe(true);
      expect(
        JSON.stringify(audits.rows).includes(token) || JSON.stringify(audits.rows).includes(secret),
      ).toBe(false);
      expect(
        (
          await migratorPool.query(
            "SELECT count(*)::int AS count FROM integration_admin_audits WHERE actor_user_id=ANY($1::text[])",
            [[target.user.id, viewer.user.id, operator.user.id, disabled.user.id]],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  itWithSqlStateDiagnostic(
    "Admin Control 的集成授权限制列与 Tenant，审计失败回滚创建",
    async () => {
      const manager = await createFixture("integration_acl_manager");
      const target = await createFixture("integration_acl_target");
      const other = await createFixture("integration_acl_other");
      await migratorPool.query(
        "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
        [manager.user.id],
      );
      const integrations = new PgIntegrationAdminRepository(adminControlPool);
      const created = await integrations.createKey(manager.user.id, target.tenant.id, {
        name: "列级权限",
        scopes: ["threads:read"],
      });
      await withTransaction(adminControlPool, async (client) => {
        await client.query(
          "SELECT set_config('app.user_id',$1,true),set_config('app.integration_admin_user_id',$1,true),set_config('app.tenant_id',$2,true)",
          [manager.user.id, target.tenant.id],
        );
        expect((await client.query("SELECT id FROM tenants")).rows).toEqual([
          { id: target.tenant.id },
        ]);
        expect(
          (await client.query("SELECT id FROM api_keys WHERE tenant_id=$1", [other.tenant.id]))
            .rows,
        ).toHaveLength(0);
        expect(
          (
            await client.query(
              "UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2",
              [target.tenant.id, target.user.id],
            )
          ).rowCount,
        ).toBe(0);
      });
      for (const sql of [
        "SELECT * FROM tenants",
        "SELECT * FROM app_users",
        "SELECT * FROM memberships",
        "SELECT id FROM threads",
        "SELECT id FROM runs",
        "SELECT id FROM webhook_outbox",
        "SELECT secret_ciphertext FROM tenant_webhooks",
        "UPDATE api_keys SET scopes=ARRAY['runs:create']",
        "UPDATE tenant_webhooks SET endpoint_url='https://1.1.1.1/'",
      ]) {
        await expect(adminControlPool.query(sql)).rejects.toMatchObject({ code: "42501" });
      }
      await migratorPool.query(
        `REVOKE INSERT ON integration_admin_audits FROM "${adminControlRole}"`,
      );
      try {
        await expect(
          integrations.createKey(manager.user.id, target.tenant.id, {
            name: "必须回滚",
            scopes: ["threads:read"],
          }),
        ).rejects.toBeDefined();
      } finally {
        await migratorPool.query(
          `GRANT INSERT ON integration_admin_audits TO "${adminControlRole}"`,
        );
      }
      expect(
        (await integrations.listKeys(manager.user.id, target.tenant.id)).map((key) => key.id),
      ).toEqual([created.key.id]);
      const orphan = await withTenantTransaction(migratorPool, target.scope, (client) =>
        client.query(
          "SELECT count(*)::int AS count FROM memberships m JOIN app_users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.kind='integration'",
          [target.tenant.id],
        ),
      );
      expect(orphan.rows[0]?.count).toBe(1);
    },
  );
  itWithSqlStateDiagnostic(
    "仅持久化哈希，按 Tenant 隔离并在吊销后同步禁用集成 Membership",
    async () => {
      const owner = await createFixture("api_key_owner");
      const other = await createFixture("api_key_other");
      const repository = new PgApiKeyRepository(runtimePool);
      const token = createApiKeyToken();
      const key = await repository.create({
        scope: owner.scope,
        createdBy: owner.user.id,
        keyHash: hashApiKey(token),
        prefix: token.slice(0, 12),
        name: "集成测试",
        scopes: ["threads:read", "runs:read"],
        now: timestamp(10),
      });

      expect((await repository.list(other.scope)).map((item) => item.id)).toEqual([]);
      const principal = await repository.authenticateKey({ token, now: timestamp(11) });
      expect(principal).toMatchObject({
        tenantId: owner.scope.tenantId,
        userId: key.integrationUserId,
      });
      const integration = await repositories.tenants.get({
        tenantId: owner.scope.tenantId,
        userId: userId(key.integrationUserId),
      });
      expect(integration?.membership.role).toBe("member");

      const raw = await withTenantTransaction(migratorPool, owner.scope, (client) =>
        client.query<{
          key_hash: Buffer;
          kind: string;
          last_used_at: Date | null;
        }>(
          "SELECT k.key_hash, k.last_used_at, u.kind FROM api_keys k JOIN app_users u ON u.id = k.integration_user_id WHERE k.tenant_id = $1 AND k.id = $2",
          [owner.scope.tenantId, key.id],
        ),
      );
      expect(raw.rows[0]?.key_hash.equals(hashApiKey(token))).toBe(true);
      expect(raw.rows[0]?.key_hash.equals(Buffer.from(token))).toBe(false);
      expect(raw.rows[0]?.last_used_at).not.toBeNull();
      expect(raw.rows[0]?.kind).toBe("integration");

      await repository.revoke(owner.scope, key.id, timestamp(12));
      const clearRevocation = await withTenantTransaction(runtimePool, owner.scope, (client) =>
        client.query("UPDATE api_keys SET revoked_at = NULL WHERE tenant_id = $1 AND id = $2", [
          owner.scope.tenantId,
          key.id,
        ]),
      );
      expect(clearRevocation.rowCount).toBe(0);
      const restoreMembership = await withTenantTransaction(
        runtimePool,
        { ...owner.scope, userId: key.integrationUserId },
        (client) =>
          client.query(
            "UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2",
            [owner.scope.tenantId, key.integrationUserId],
          ),
      );
      expect(restoreMembership.rowCount).toBe(0);
      expect(
        (await repository.list(owner.scope)).find((item) => item.id === key.id)?.revokedAt,
      ).toBe(timestamp(12));
      expect(await repository.authenticateKey({ token, now: timestamp(13) })).toBeUndefined();
      expect(
        await repositories.tenants.get({
          tenantId: owner.scope.tenantId,
          userId: userId(key.integrationUserId),
        }),
      ).toBeUndefined();
    },
  );

  itWithSqlStateDiagnostic("Runtime 不能直接撤销人类成员 Membership", async () => {
    const owner = await createFixture("api_key_human_guard");
    const humanId = userId("user_api_key_human_guard_member");
    await withTenantTransaction(
      migratorPool,
      { tenantId: owner.scope.tenantId, userId: humanId },
      async (client) => {
        await client.query("INSERT INTO app_users(id, created_at) VALUES ($1, $2)", [
          humanId,
          timestamp(10),
        ]);
        await client.query(
          "INSERT INTO memberships(tenant_id, id, user_id, role, status, created_at) VALUES ($1, $2, $3, 'member', 'active', $4)",
          [owner.scope.tenantId, "mem_api_key_human_guard", humanId, timestamp(10)],
        );
      },
    );

    // FOR SHARE/UPDATE 会施加 UPDATE 策略的 USING；人类成员的授权加锁与 lock_marker
    // 自更新必须仍然命中，否则 Thread 创建、归档等主路径会退化为 not_authorized。
    const humanScope = { tenantId: owner.scope.tenantId, userId: humanId };
    const locked = await withTenantTransaction(runtimePool, humanScope, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR SHARE",
        [owner.scope.tenantId, humanId],
      ),
    );
    expect(locked.rows.map((row) => row.status)).toEqual(["active"]);
    const markerTouch = await withTenantTransaction(runtimePool, humanScope, (client) =>
      client.query(
        "UPDATE memberships SET lock_marker = lock_marker WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'",
        [owner.scope.tenantId, humanId],
      ),
    );
    expect(markerTouch.rowCount).toBe(1);

    await expect(
      withTenantTransaction(runtimePool, owner.scope, (client) =>
        client.query(
          "UPDATE memberships SET status = 'revoked' WHERE tenant_id = $1 AND user_id = $2",
          [owner.scope.tenantId, humanId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const unchanged = await withTenantTransaction(migratorPool, owner.scope, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2",
        [owner.scope.tenantId, humanId],
      ),
    );
    expect(unchanged.rows[0]?.status).toBe("active");
  });

  it("到期的 Key 无法认证", async () => {
    const owner = await createFixture("api_key_expired");
    const repository = new PgApiKeyRepository(runtimePool);
    const token = createApiKeyToken();
    await repository.create({
      scope: owner.scope,
      createdBy: owner.user.id,
      keyHash: hashApiKey(token),
      prefix: token.slice(0, 12),
      name: "过期测试",
      scopes: ["threads:read"],
      now: "2000-01-01T00:00:00.000Z",
      expiresAt: "2001-01-01T00:00:00.000Z",
    });
    expect(await repository.authenticateKey({ token, now: timestamp(14) })).toBeUndefined();
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

externalToolRegistryTests(
  () => ({ control: adminControlPool, db: migratorPool }),
  migrationSecurity,
);
