import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  artifactId,
  isoTimestamp,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "@hoox/domain";
import type { RuntimeMutation } from "@hoox/run-contracts";
import { runtimeMutationDigest } from "@hoox/run-contracts/mutation-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactExecutionAuthorization } from "../../runtime-ts/packages/artifact/src/authorization.js";
import { PgArtifactDeliveryRepository } from "../../runtime-ts/packages/artifact/src/pg-repository.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  createPostgresPool,
  type Pool,
  type PoolClient,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { PgExecutionPersistence } from "../../runtime-ts/packages/persistence/src/pg-run-worker-state.js";
import { PgRunExperienceReadRepository } from "../../runtime-ts/packages/persistence/src/runtime.js";
import { loadPostgreSqlMigrationContract } from "./postgres-migration-contract.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Artifact PG 集成测试缺少 ${name}`);
  return value;
}

const bootstrapUrl = required("DATABASE_BOOTSTRAP_URL");
const runtimeUrl = required("DATABASE_URL");
const migrationUrl = new URL(required("MIGRATION_DATABASE_URL"));
const runtimeRole = required("DATABASE_RUNTIME_ROLE");
const configuredMigratorRole = required("DATABASE_MIGRATOR_ROLE");
const databaseName = new URL(bootstrapUrl).pathname.slice(1);
const unique = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_artifact_${unique}`;
const migratorRole = `it_af_mg_${unique}`;
const migratorPassword = randomBytes(24).toString("hex");
const skillPublisherRole = `it_af_pub_${unique}`;
const skillPublisherPassword = randomBytes(24).toString("hex");
const workerCoordinatorRole = `it_af_coord_${unique}`;
const teamCoordinatorRole = workerCoordinatorRole.replace("_coord_", "_team_");
const adminControlRole = workerCoordinatorRole.replace("_coord_", "_control_");
const workerCoordinatorPassword = randomBytes(24).toString("hex");
const teamCoordinatorPassword = randomBytes(24).toString("hex");
const adminControlPassword = randomBytes(24).toString("hex");
if (migrationUrl.username !== configuredMigratorRole) throw new Error("迁移角色配置不一致");
migrationUrl.username = migratorRole;
migrationUrl.password = migratorPassword;
const migrationSecurity = {
  runtimeRole,
  migratorRole,
  skillPublisherRole,
  workerCoordinatorRole,
  teamCoordinatorRole,
  adminControlRole,
  schema,
} as const;

const ids = {
  tenant: tenantId(`artifact_tenant_${unique}`),
  user: userId(`artifact_user_${unique}`),
  thread: threadId(`artifact_thread_${unique}`),
  run: runId(`artifact_run_${unique}`),
  workspace: workspaceId(`artifact_workspace_${unique}`),
  attempt: `artifact_attempt_${unique}`,
  resource: `artifact_resource_${unique}`,
  version: resourceVersionId(`artifact_version_${unique}`),
};
const other = {
  tenant: tenantId(`artifact_other_tenant_${unique}`),
  user: userId(`artifact_other_user_${unique}`),
};
const issuedAt = isoTimestamp("2099-07-28T00:00:00.000Z");
const expiresAt = isoTimestamp("2099-07-28T01:00:00.000Z");
const consumedAt = isoTimestamp("2099-07-28T00:00:01.000Z");
let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repository!: PgArtifactDeliveryRepository;
let experienceRepository!: PgRunExperienceReadRepository;

function signedMutation(
  input: Omit<RuntimeMutation, "schemaVersion" | "commandDigest">,
): RuntimeMutation {
  const unsigned = { ...input, schemaVersion: 1 as const };
  return { ...unsigned, commandDigest: runtimeMutationDigest(unsigned) };
}

function authorization(
  toolName: string,
  label: string,
  timeline: { issuedAt: string; expiresAt: string; consumedAt: string } = {
    issuedAt,
    expiresAt,
    consumedAt,
  },
): ArtifactExecutionAuthorization {
  return Object.freeze({
    permitId: `permit_${label}_${unique}`,
    attemptId: ids.attempt,
    scope: Object.freeze({
      tenantId: ids.tenant,
      threadId: ids.thread,
      runId: ids.run,
      rootRunId: ids.run,
      workspaceId: ids.workspace,
    }),
    runClaimToken: `claim_${unique}`,
    runClaimEpoch: 1,
    workspaceRootRunId: ids.run,
    workspaceLeaseEpoch: 1,
    attemptVersion: 0,
    effect: "tool_execution",
    callId: `call_${label}_${unique}`,
    toolName,
    argsDigest: sha256Digest(createHash("sha256").update(label).digest("hex")),
    issuedAt: timeline.issuedAt,
    expiresAt: timeline.expiresAt,
    consumedAt: timeline.consumedAt,
    consumedAtMonotonicMs: 1,
    maxContinuationDelayMs: 60_000,
  }) as unknown as ArtifactExecutionAuthorization;
}

async function seedPermit(auth: ArtifactExecutionAuthorization): Promise<void> {
  await withTenantTransaction(runtime, { tenantId: ids.tenant }, (client) =>
    client.query(
      `INSERT INTO external_effect_permits(
         tenant_id,permit_id,attempt_id,effect,call_id,tool_name,args_digest,attempt_version,
         run_claim_token,run_claim_epoch,workspace_root_run_id,workspace_lease_epoch,
         issued_at,expires_at,consumed_at
       ) VALUES($1,$2,$3,'tool_execution',$4,$5,$6,0,$7,1,$8,1,$9,$10,$11)`,
      [
        ids.tenant,
        auth.permitId,
        ids.attempt,
        auth.callId,
        auth.toolName,
        auth.argsDigest,
        auth.runClaimToken,
        ids.run,
        auth.issuedAt,
        auth.expiresAt,
        auth.consumedAt,
      ],
    ),
  );
}

async function seedAdditionalExecution(label: string): Promise<{
  run: ReturnType<typeof runId>;
  thread: ReturnType<typeof threadId>;
  workspace: ReturnType<typeof workspaceId>;
  attempt: string;
}> {
  const thread = threadId(`artifact_${label}_thread_${unique}`);
  const run = runId(`artifact_${label}_run_${unique}`);
  const workspace = workspaceId(`artifact_${label}_workspace_${unique}`);
  const attempt = `artifact_${label}_attempt_${unique}`;
  await withTenantTransaction(
    runtime,
    { tenantId: ids.tenant, userId: ids.user },
    async (client) => {
      await client.query(
        `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,'active',clock_timestamp(),clock_timestamp())`,
        [ids.tenant, thread, ids.user, `Artifact ${label}`],
      );
      await client.query(
        `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
         VALUES($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
        [ids.tenant, run, thread],
      );
      await client.query(
        `INSERT INTO workspaces(tenant_id,id,thread_id,lease_epoch,created_at,updated_at)
         VALUES($1,$2,$3,1,clock_timestamp(),clock_timestamp())`,
        [ids.tenant, workspace, thread],
      );
      await client.query(
        `INSERT INTO run_execution_inputs(
           tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,
           initial_projection,initial_projection_digest
         ) VALUES($1,$2,$3,$4,$2,'artifact-extra','{}',$5)`,
        [ids.tenant, run, thread, workspace, "9".repeat(64)],
      );
      await client.query(
        `INSERT INTO execution_attempts(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,version
         ) VALUES($1,$2,$3,$4,$5,$3,'running','workspace_verified',0)`,
        [ids.tenant, attempt, run, thread, workspace],
      );
      await client.query(
        `INSERT INTO artifact_deliverable_declarations(
           tenant_id,run_id,deliverable_key,name,requirement
         ) VALUES($1,$2,'report','报告','required')`,
        [ids.tenant, run],
      );
    },
  );
  return { run, thread, workspace, attempt };
}

async function cloneDeliverableForExecution(
  execution: Awaited<ReturnType<typeof seedAdditionalExecution>>,
  label: string,
  target?: "published" | "failed",
): Promise<string> {
  const artifact = `artifact_${label}_${unique}`;
  await withTenantTransaction(runtime, { tenantId: ids.tenant }, async (client) => {
    await client.query(
      `INSERT INTO artifact_publications(
         tenant_id,id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
         resource_id,resource_version_id,name,purpose,deliverable_key,status,
         blob_reference_id,blob_purpose,blob_lifecycle_id,blob_incarnation_id,
         physical_object_key,digest,media_type,size
       )
       SELECT tenant_id,$2,$3,$4,$5,$6,$4,resource_id,resource_version_id,
              name,'deliverable','report','publishing',blob_reference_id,blob_purpose,
              blob_lifecycle_id,blob_incarnation_id,physical_object_key,digest,media_type,size
         FROM artifact_publications WHERE tenant_id=$1 AND id=$7`,
      [
        ids.tenant,
        artifact,
        execution.thread,
        execution.run,
        execution.attempt,
        execution.workspace,
        `artifact_result_${unique}`,
      ],
    );
    if (target !== undefined) {
      await client.query(
        `INSERT INTO artifact_publication_settlements(tenant_id,artifact_id,target)
         VALUES($1,$2,$3)`,
        [ids.tenant, artifact, target],
      );
    }
  });
  return artifact;
}

/** 在 latest Attempt 查询返回后、事件查询开始前提交并发写入，用真实 PG 验证读取快照。 */
function hookAfterLatestAttemptRead(pool: Pool, hook: () => Promise<void>): Pool {
  let triggered = false;
  return {
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (
        text: string,
        values?: readonly unknown[],
      ) => Promise<unknown>;
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "query") {
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (text: string, values?: readonly unknown[]) => {
            const result = await query(text, values);
            if (!triggered && text.includes("SELECT attempt_id FROM execution_attempts")) {
              triggered = true;
              await hook();
            }
            return result;
          };
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
}

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapUrl, maxConnections: 2 });
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
     GRANT CONNECT ON DATABASE "${databaseName}"
       TO "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
     CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
  );
  migrator = createPostgresPool({
    connectionString: migrationUrl.toString(),
    schema,
    maxConnections: 3,
  });
  runtime = createPostgresPool({ connectionString: runtimeUrl, schema, maxConnections: 6 });
  const migrationContract = await loadPostgreSqlMigrationContract();
  expect((await migrateUp(migrator, migrationSecurity)).at(-1)?.version).toBe(
    migrationContract.latestVersion,
  );
  repository = new PgArtifactDeliveryRepository(runtime, { assert() {} });
  experienceRepository = new PgRunExperienceReadRepository(runtime);

  await withTenantTransaction(
    runtime,
    { tenantId: ids.tenant, userId: ids.user },
    async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
        ids.user,
      ]);
      await client.query(
        `INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,clock_timestamp())`,
        [ids.tenant, ids.user],
      );
      await client.query(
        `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES($1,$2,$3,'owner','active',clock_timestamp())`,
        [ids.tenant, `artifact_member_${unique}`, ids.user],
      );
      await client.query(
        `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
       VALUES($1,$2,$3,'Artifact 集成','active',clock_timestamp(),clock_timestamp())`,
        [ids.tenant, ids.thread, ids.user],
      );
      await client.query(
        `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
        [ids.tenant, ids.run, ids.thread],
      );
      await client.query(
        `INSERT INTO workspaces(tenant_id,id,thread_id,lease_epoch,created_at,updated_at)
       VALUES($1,$2,$3,1,clock_timestamp(),clock_timestamp())`,
        [ids.tenant, ids.workspace, ids.thread],
      );
      await client.query(
        `INSERT INTO workspace_write_leases(tenant_id,workspace_id,thread_id,root_run_id,epoch,expires_at)
       VALUES($1,$2,$3,$4,1,$5)`,
        [ids.tenant, ids.workspace, ids.thread, ids.run, expiresAt],
      );
      await client.query(
        `INSERT INTO run_execution_inputs(
         tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,initial_projection,initial_projection_digest
       ) VALUES($1,$2,$3,$4,$2,'artifact','{}',$5)`,
        [ids.tenant, ids.run, ids.thread, ids.workspace, "1".repeat(64)],
      );
      await client.query(
        `INSERT INTO execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,version
       ) VALUES($1,$2,$3,$4,$5,$3,'running','workspace_verified',0)`,
        [ids.tenant, ids.attempt, ids.run, ids.thread, ids.workspace],
      );
      await client.query(
        `INSERT INTO execution_workspace_fences(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,lease_epoch,initial_expires_at
       ) VALUES($1,$2,$3,$4,$5,$3,1,$6)`,
        [ids.tenant, ids.attempt, ids.run, ids.thread, ids.workspace, expiresAt],
      );
      await client.query(
        `INSERT INTO run_claims(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,worker_id,
         claim_token,claim_epoch,workspace_lease_epoch,expires_at
       ) VALUES($1,$2,$3,$4,$5,$3,'worker',$6,1,1,$7)`,
        [ids.tenant, ids.attempt, ids.run, ids.thread, ids.workspace, `claim_${unique}`, expiresAt],
      );
      const lifecycle = randomUUID();
      const incarnation = randomUUID();
      const digest = "2".repeat(64);
      const objectKey = `artifact/${unique}/deliverable.txt`;
      await client.query(
        `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot)
       VALUES($1,$2,'completed',1,'{}')`,
        [ids.tenant, `artifact-op-${unique}`],
      );
      await client.query(
        `INSERT INTO blob_lifecycles(tenant_id,lifecycle_id,purpose,sha256,size,state,current_incarnation_id,generation)
       VALUES($1,$2,'resource',$3,7,'active',$4,1)`,
        [ids.tenant, lifecycle, digest, incarnation],
      );
      await client.query(
        `INSERT INTO blob_incarnations(
         tenant_id,lifecycle_id,purpose,sha256,size,incarnation_id,physical_object_key,state
       ) VALUES($1,$2,'resource',$3,7,$4,$5,'active')`,
        [ids.tenant, lifecycle, digest, incarnation, objectKey],
      );
      await client.query(
        `INSERT INTO blob_references(
         tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,
         staging_upload_id,lifecycle_id,incarnation_id,physical_object_key
       ) VALUES($1,$2,$3,'stable','resource',$4,7,'text/plain','staging',$5,$6,$7)`,
        [
          ids.tenant,
          `artifact-ref-${unique}`,
          `artifact-op-${unique}`,
          digest,
          lifecycle,
          incarnation,
          objectKey,
        ],
      );
      await client.query(
        `INSERT INTO resources(
         tenant_id,id,name,normalized_name,origin,visibility,latest_version_number,latest_version_id
       ) VALUES($1,$2,'交付物','交付物','promoted_workspace','searchable',1,$3)`,
        [ids.tenant, ids.resource, ids.version],
      );
      await client.query(
        `INSERT INTO resource_versions(
         tenant_id,resource_id,id,version_number,blob_reference_id,blob_purpose,
         blob_lifecycle_id,blob_incarnation_id,physical_object_key,digest,media_type,size
       ) VALUES($1,$2,$3,1,$4,'resource',$5,$6,$7,$8,'text/plain',7)`,
        [
          ids.tenant,
          ids.resource,
          ids.version,
          `artifact-ref-${unique}`,
          lifecycle,
          incarnation,
          objectKey,
          digest,
        ],
      );
    },
  );
  await withTenantTransaction(
    runtime,
    { tenantId: other.tenant, userId: other.user },
    async (client) => {
      await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
        other.user,
      ]);
      await client.query(
        `INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,clock_timestamp())`,
        [other.tenant, other.user],
      );
      await client.query(
        `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
       VALUES($1,$2,$3,'owner','active',clock_timestamp())`,
        [other.tenant, `artifact_other_member_${unique}`, other.user],
      );
    },
  );
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
    await migrator.end();
  }
  if (admin !== undefined) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(
      `REVOKE CONNECT ON DATABASE "${databaseName}"
         FROM "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}";
       DROP ROLE IF EXISTS "${adminControlRole}";
       DROP ROLE IF EXISTS "${teamCoordinatorRole}";
       DROP ROLE IF EXISTS "${workerCoordinatorRole}";
       DROP ROLE IF EXISTS "${skillPublisherRole}";
       DROP ROLE IF EXISTS "${migratorRole}"`,
    );
    await admin.end();
  }
});

describe("Artifact PostgreSQL 持久化", () => {
  it("事件读取在 Attempt 切换期间固定快照，并准确维持 limit 与 hasMore", async () => {
    const execution = await seedAdditionalExecution("event_snapshot");
    await withTenantTransaction(runtime, { tenantId: ids.tenant }, (client) =>
      client.query(
        `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
         VALUES($1,$2,0,1,'agent_event','{"type":"message.delta","delta":"旧-0"}'),
               ($1,$2,1,1,'agent_event','{"type":"message.delta","delta":"旧-1"}')`,
        [ids.tenant, execution.attempt],
      ),
    );
    const nextAttempt = `artifact_event_snapshot_next_attempt_${unique}`;
    const switchingRepository = new PgRunExperienceReadRepository(
      hookAfterLatestAttemptRead(runtime, async () => {
        await withTenantTransaction(runtime, { tenantId: ids.tenant }, async (client) => {
          // 旧 Attempt 的追加与新 Attempt 的创建都发生在 reader 已选定 Attempt 之后。
          await client.query(
            `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
             VALUES($1,$2,2,1,'agent_event','{"type":"message.delta","delta":"旧-迟到"}')`,
            [ids.tenant, execution.attempt],
          );
          await client.query(
            `UPDATE execution_attempts
                SET status='abandoned',stage='finished',finished_at=clock_timestamp(),
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND attempt_id=$2`,
            [ids.tenant, execution.attempt],
          );
          await client.query(
            `INSERT INTO execution_attempts(
               tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,version,
               created_at,updated_at
             ) VALUES($1,$2,$3,$4,$5,$3,'running','workspace_verified',0,
                      clock_timestamp()+interval '1 second',clock_timestamp()+interval '1 second')`,
            [ids.tenant, nextAttempt, execution.run, execution.thread, execution.workspace],
          );
          await client.query(
            `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
             VALUES($1,$2,0,1,'agent_event','{"type":"message.delta","delta":"新-0"}'),
                   ($1,$2,1,1,'agent_event','{"type":"message.delta","delta":"新-1"}'),
                   ($1,$2,2,1,'agent_event','{"type":"message.delta","delta":"新-2"}')`,
            [ids.tenant, nextAttempt],
          );
        });
      }),
    );

    const duringSwitch = await switchingRepository.listEvents({
      scope: { tenantId: ids.tenant, userId: ids.user },
      runId: execution.run,
      after: -1,
      limit: 2,
    });
    expect(duringSwitch).toMatchObject({
      outcome: "found",
      attemptId: execution.attempt,
      hasMore: false,
      events: [{ sequence: 0 }, { sequence: 1 }],
    });

    const latest = await experienceRepository.listEvents({
      scope: { tenantId: ids.tenant, userId: ids.user },
      runId: execution.run,
      after: -1,
      limit: 2,
    });
    expect(latest).toMatchObject({
      outcome: "found",
      attemptId: nextAttempt,
      hasMore: true,
      events: [{ sequence: 0 }, { sequence: 1 }],
    });
    const tail = await experienceRepository.listEvents({
      scope: { tenantId: ids.tenant, userId: ids.user },
      runId: execution.run,
      after: 1,
      limit: 1,
    });
    expect(tail).toMatchObject({
      outcome: "found",
      attemptId: nextAttempt,
      hasMore: false,
      events: [{ sequence: 2 }],
    });
  });

  it("声明、发布、幂等重放、完成门与下载授权形成租户隔离闭环", async () => {
    const declare = authorization("declare_deliverables", "declare");
    const publish = authorization("publish_artifact", "publish");
    await seedPermit(declare);
    await seedPermit(publish);
    const commandDigest = sha256Digest("3".repeat(64));
    const declarationCommand = {
      authorization: declare,
      idempotencyKey: `declare-${unique}`,
      commandDigest,
      declarations: [{ key: "report", name: "报告", requirement: "required" as const }],
    };
    const declared = await Promise.all([
      repository.declareDeliverables(declarationCommand),
      repository.declareDeliverables(declarationCommand),
    ]);
    expect(declared.map((result) => result.outcome).sort()).toEqual(["already_applied", "applied"]);
    expect(await repository.inspectCompletion({ scope: publish.scope })).toMatchObject({
      outcome: "not_ready",
      blockers: [{ deliverableKey: "report", status: "missing" }],
    });

    const publicationDigest = sha256Digest("4".repeat(64));
    const artifact = artifactId(`artifact_result_${unique}`);
    const publicationCommand = {
      authorization: publish,
      idempotencyKey: `publish-${unique}`,
      commandDigest: publicationDigest,
      artifactId: artifact,
      resourceVersionId: ids.version,
      name: "报告.txt",
      purpose: "deliverable" as const,
      deliverableKey: "report",
    };
    const begun = await Promise.all([
      repository.beginPublication(publicationCommand),
      repository.beginPublication(publicationCommand),
    ]);
    expect(begun.map((result) => result.outcome).sort()).toEqual(["already_started", "started"]);
    expect(
      (
        await repository.beginPublication({
          authorization: publish,
          idempotencyKey: `publish-${unique}`,
          commandDigest: sha256Digest("5".repeat(64)),
          artifactId: artifact,
          resourceVersionId: ids.version,
          name: "报告.txt",
          purpose: "deliverable",
          deliverableKey: "report",
        })
      ).outcome,
    ).toBe("conflict");
    const finishCommand = {
      authorization: publish,
      idempotencyKey: `publish-${unique}`,
      commandDigest: publicationDigest,
      artifactId: artifact,
      target: "published" as const,
    };
    const finished = await Promise.all([
      repository.finishPublication(finishCommand),
      repository.finishPublication(finishCommand),
    ]);
    expect(finished.map((result) => result.outcome).sort()).toEqual(["already_applied", "applied"]);
    expect(await repository.inspectCompletion({ scope: publish.scope })).toEqual({
      outcome: "ready",
    });
    expect(
      (
        await repository.listAuthorizedArtifacts({
          request: { tenantId: ids.tenant, userId: ids.user },
          runId: ids.run,
        })
      ).outcome,
    ).toBe("authorized");
    expect(
      (
        await repository.listAuthorizedArtifacts({
          request: { tenantId: other.tenant, userId: other.user },
          runId: ids.run,
        })
      ).outcome,
    ).toBe("not_found");
    const emptyRun = runId(`artifact_empty_run_${unique}`);
    await withTenantTransaction(runtime, { tenantId: ids.tenant }, (client) =>
      client.query(
        `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
         VALUES($1,$2,$3,'running',clock_timestamp(),clock_timestamp())`,
        [ids.tenant, emptyRun, ids.thread],
      ),
    );
    expect(
      await repository.listAuthorizedArtifacts({
        request: { tenantId: ids.tenant, userId: ids.user },
        runId: emptyRun,
      }),
    ).toEqual({ outcome: "authorized", artifacts: [] });

    const download = await repository.authorizeDownload({
      request: { tenantId: ids.tenant, userId: ids.user },
      artifactId: artifact,
    });
    expect(download.outcome).toBe("authorized");
    if (download.outcome === "authorized") {
      expect(await repository.confirmDownloadAuthorization(download.download)).toEqual({
        outcome: "confirmed",
      });
    }
  });

  it("真实 PG permit 在后续 tool.started 推进版本后仍可发布，并严格拒绝倒退、claim、lease、fence 与取消", async () => {
    const execution = await seedAdditionalExecution("permit_version_boundary");
    const scope = {
      tenantId: ids.tenant,
      threadId: execution.thread,
      runId: execution.run,
      rootRunId: execution.run,
      workspaceId: execution.workspace,
    };
    const claimToken = `permit-boundary-claim-${unique}`;
    await withTenantTransaction(runtime, { tenantId: ids.tenant }, async (client) => {
      await client.query(
        `INSERT INTO workspace_write_leases(tenant_id,workspace_id,thread_id,root_run_id,epoch,expires_at)
         VALUES($1,$2,$3,$4,1,$5)`,
        [ids.tenant, execution.workspace, execution.thread, execution.run, expiresAt],
      );
      await client.query(
        `INSERT INTO execution_workspace_fences(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,lease_epoch,initial_expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,1,$7)`,
        [
          ids.tenant,
          execution.attempt,
          execution.run,
          execution.thread,
          execution.workspace,
          execution.run,
          expiresAt,
        ],
      );
      await client.query(
        `INSERT INTO run_claims(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,worker_id,
           claim_token,claim_epoch,workspace_lease_epoch,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,'permit-boundary-worker',$7,1,1,$8)`,
        [
          ids.tenant,
          execution.attempt,
          execution.run,
          execution.thread,
          execution.workspace,
          execution.run,
          claimToken,
          expiresAt,
        ],
      );
    });
    const fence = {
      scope,
      runClaim: { token: claimToken, epoch: 1, expiresAt },
      workspaceLease: { rootRunId: execution.run, epoch: 1, expiresAt },
    };
    const persistence = new PgExecutionPersistence(runtime);
    const publishCall = {
      callId: `permit-boundary-publish-${unique}`,
      toolName: "publish_artifact",
      argsDigest: sha256Digest("b".repeat(64)),
    };
    const registered = await persistence.mutate(
      signedMutation({
        idempotencyKey: `${execution.attempt}/tool-started/0`,
        fence,
        expectedAttemptVersion: 0,
        events: [
          {
            schemaVersion: 1,
            kind: "agent_event",
            sequence: 0,
            payload: {
              type: "tool.started",
              callId: publishCall.callId,
              name: publishCall.toolName,
            },
          },
        ],
        outbox: [],
        effectInvocation: { callId: publishCall.callId, toolName: publishCall.toolName },
      }),
    );
    expect(registered.outcome).toBe("applied");
    const issued = await persistence.issueExternalEffectPermit({
      fence,
      expectedAttemptVersion: 1,
      effect: "tool_execution",
      call: publishCall,
      permitDurationMs: 30_000,
    });
    expect(issued.outcome).toBe("authorized");
    if (issued.outcome !== "authorized") throw new Error("真实 PG permit 未签发");
    const precision = await withTenantTransaction(
      runtime,
      { tenantId: ids.tenant },
      (client) =>
        client.query<{
          issued_microsecond_remainder: number;
          expires_microsecond_remainder: number;
        }>(
          `SELECT (EXTRACT(MICROSECONDS FROM issued_at)::bigint % 1000)::int AS issued_microsecond_remainder,
                  (EXTRACT(MICROSECONDS FROM expires_at)::bigint % 1000)::int AS expires_microsecond_remainder
             FROM external_effect_permits WHERE tenant_id=$1 AND permit_id=$2`,
          [ids.tenant, issued.permit.permitId],
        ),
      { readOnly: true },
    );
    expect(precision.rows[0]).toEqual({
      issued_microsecond_remainder: 0,
      expires_microsecond_remainder: 0,
    });
    const consumed = await persistence.consumeExternalEffectPermit({
      fence,
      expectedAttemptVersion: 1,
      permit: issued.permit,
    });
    expect(consumed.outcome).toBe("consumed");
    if (consumed.outcome !== "consumed") throw new Error("真实 PG permit 未消费");
    const authorization = Object.freeze({
      ...issued.permit,
      attemptId: execution.attempt,
      consumedAt: consumed.databaseNow,
      consumedAtMonotonicMs: 1,
      maxContinuationDelayMs: 60_000,
    }) as unknown as ArtifactExecutionAuthorization;
    const advanced = await persistence.mutate(
      signedMutation({
        idempotencyKey: `${execution.attempt}/tool-started/1`,
        fence,
        expectedAttemptVersion: 1,
        events: [
          {
            schemaVersion: 1,
            kind: "agent_event",
            sequence: 1,
            payload: {
              type: "tool.started",
              callId: `permit-boundary-followup-${unique}`,
              name: "sandbox_read_file",
            },
          },
        ],
        outbox: [],
        effectInvocation: {
          callId: `permit-boundary-followup-${unique}`,
          toolName: "sandbox_read_file",
        },
      }),
    );
    expect(advanced.outcome).toBe("applied");
    const publish = (label: string, boundaryAuthorization = authorization) =>
      repository.beginPublication({
        authorization: boundaryAuthorization,
        idempotencyKey: `permit-boundary-${label}-${unique}`,
        commandDigest: sha256Digest(createHash("sha256").update(label).digest("hex")),
        artifactId: artifactId(`artifact_permit_boundary_${label}_${unique}`),
        resourceVersionId: ids.version,
        name: `${label}.txt`,
        purpose: "diagnostic",
      });
    // authorization 固定在 version=1；第二个 tool.started 已将 Attempt 推至 version=2。
    expect((await publish("advanced")).outcome).toBe("started");

    const expectRejected = async (
      label: string,
      boundaryAuthorization: ArtifactExecutionAuthorization = authorization,
    ) => {
      expect((await publish(label, boundaryAuthorization)).outcome).toBe("scope_mismatch");
    };
    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query("UPDATE execution_attempts SET version=0 WHERE tenant_id=$1 AND attempt_id=$2", [
        ids.tenant,
        execution.attempt,
      ]),
    );
    await expectRejected("version-rollback");
    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query("UPDATE execution_attempts SET version=2 WHERE tenant_id=$1 AND attempt_id=$2", [
        ids.tenant,
        execution.attempt,
      ]),
    );

    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query(
        "UPDATE run_claims SET released_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2",
        [ids.tenant, execution.attempt],
      ),
    );
    await expectRejected("claim-released");
    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query("UPDATE run_claims SET released_at=NULL WHERE tenant_id=$1 AND attempt_id=$2", [
        ids.tenant,
        execution.attempt,
      ]),
    );
    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query(
        "UPDATE workspace_write_leases SET expires_at='2020-01-01T00:00:00.000Z' WHERE tenant_id=$1 AND workspace_id=$2",
        [ids.tenant, execution.workspace],
      ),
    );
    await expectRejected("lease-expired");
    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query(
        "UPDATE workspace_write_leases SET expires_at=$3 WHERE tenant_id=$1 AND workspace_id=$2",
        [ids.tenant, execution.workspace, expiresAt],
      ),
    );
    await expectRejected(
      "fence-epoch",
      Object.freeze({ ...authorization, workspaceLeaseEpoch: 2 }) as ArtifactExecutionAuthorization,
    );

    await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
      client.query("UPDATE runs SET status='cancelled' WHERE tenant_id=$1 AND id=$2", [
        ids.tenant,
        execution.run,
      ]),
    );
    expect((await publish("cancelled")).outcome).toBe("not_running");
  });

  it("数据库拒绝终态逆转、重复结算与未失败 replacement", async () => {
    await expect(
      withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query("UPDATE artifact_publications SET status='published' WHERE tenant_id=$1", [
          ids.tenant,
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query(
          `INSERT INTO artifact_publication_settlements(tenant_id,artifact_id,target)
           VALUES($1,$2,'failed')`,
          [ids.tenant, `artifact_result_${unique}`],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query(
          `INSERT INTO artifact_publications(
             tenant_id,id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
             resource_id,resource_version_id,replaces_artifact_id,name,purpose,
             deliverable_key,status,blob_reference_id,blob_purpose,blob_lifecycle_id,
             blob_incarnation_id,physical_object_key,digest,media_type,size
           )
           SELECT tenant_id,$2,thread_id,run_id,attempt_id,workspace_id,root_run_id,
                  resource_id,resource_version_id,id,name,purpose,deliverable_key,'publishing',
                  blob_reference_id,blob_purpose,blob_lifecycle_id,blob_incarnation_id,
                  physical_object_key,digest,media_type,size
             FROM artifact_publications WHERE tenant_id=$1 AND id=$3`,
          [ids.tenant, `artifact_invalid_replacement_${unique}`, `artifact_result_${unique}`],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query(
          `INSERT INTO artifact_deliverable_commands(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             idempotency_key,command_digest
           ) VALUES($1,$2,$3,$4,$5,$3,$6,$7)`,
          [
            ids.tenant,
            ids.attempt,
            `wrong_run_${unique}`,
            ids.thread,
            ids.workspace,
            `wrong-composite-${unique}`,
            "8".repeat(64),
          ],
        ),
      ),
    ).rejects.toThrow();
  });

  it("仅有 publishing 或 failed deliverable 时仍授权返回空列表，并拒绝交叉 Attempt 复合身份", async () => {
    const empty = await seedAdditionalExecution("experience_empty");
    const publishing = await seedAdditionalExecution("publishing_only");
    const failed = await seedAdditionalExecution("failed_only");
    const published = await seedAdditionalExecution("published_only");
    await cloneDeliverableForExecution(publishing, "publishing_only");
    await cloneDeliverableForExecution(failed, "failed_only", "failed");
    const publishedArtifact = await cloneDeliverableForExecution(
      published,
      "published_only",
      "published",
    );

    for (const execution of [empty, publishing, failed]) {
      expect(
        await repository.listAuthorizedArtifacts({
          request: { tenantId: ids.tenant, userId: ids.user },
          runId: execution.run,
        }),
      ).toEqual({ outcome: "authorized", artifacts: [] });
      expect(
        await experienceRepository.listArtifacts({
          scope: { tenantId: ids.tenant, userId: ids.user },
          runId: execution.run,
        }),
      ).toEqual({ outcome: "found", artifacts: [] });
    }

    const publishedProjection = await experienceRepository.listArtifacts({
      scope: { tenantId: ids.tenant, userId: ids.user },
      runId: published.run,
    });
    expect(publishedProjection.outcome).toBe("found");
    if (publishedProjection.outcome === "found") {
      expect(publishedProjection.artifacts[0]?.resourceId).toBe(ids.resource);
      expect(publishedProjection.artifacts.map((artifact) => artifact.id)).toEqual([
        publishedArtifact,
      ]);
    }

    await expect(
      withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query(
          `INSERT INTO artifact_deliverable_commands(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             idempotency_key,command_digest
           ) VALUES($1,$2,$3,$4,$5,$3,$6,$7)`,
          [
            ids.tenant,
            publishing.attempt,
            failed.run,
            failed.thread,
            failed.workspace,
            `cross-attempt-${unique}`,
            "a".repeat(64),
          ],
        ),
      ),
    ).rejects.toThrow();
  });

  it("数据库时钟拒绝过期 permit，完成门拒绝错误 rootRunId", async () => {
    const expired = authorization("publish_artifact", "expired", {
      issuedAt: "2020-01-01T00:00:00.000Z",
      consumedAt: "2020-01-01T00:00:01.000Z",
      expiresAt: "2020-01-01T00:01:00.000Z",
    });
    await seedPermit(expired);
    expect(
      (
        await repository.beginPublication({
          authorization: expired,
          idempotencyKey: `expired-${unique}`,
          commandDigest: sha256Digest("6".repeat(64)),
          artifactId: artifactId(`artifact_expired_${unique}`),
          resourceVersionId: ids.version,
          name: "过期.txt",
          purpose: "diagnostic",
        })
      ).outcome,
    ).toBe("scope_mismatch");
    expect(
      await repository.inspectCompletion({
        scope: { ...expired.scope, rootRunId: runId(`wrong_root_${unique}`) },
      }),
    ).toEqual({ outcome: "scope_mismatch" });
    expect(
      await repository.inspectCompletion({
        scope: {
          ...expired.scope,
          baseRevisionId: workspaceRevisionId(`wrong_revision_${unique}`),
        },
      }),
    ).toEqual({ outcome: "scope_mismatch" });
  });

  it("Run 终态提交与发布按行锁串行化并在锁后拒绝", async () => {
    const racing = authorization("publish_artifact", "terminal-race");
    await seedPermit(racing);
    const blocker = await migrator.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('app.tenant_id',$1,true)", [ids.tenant]);
      await blocker.query("SELECT id FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        ids.tenant,
        ids.run,
      ]);
      const publishing = repository.beginPublication({
        authorization: racing,
        idempotencyKey: `terminal-race-${unique}`,
        commandDigest: sha256Digest("7".repeat(64)),
        artifactId: artifactId(`artifact_terminal_race_${unique}`),
        resourceVersionId: ids.version,
        name: "终态竞态.txt",
        purpose: "diagnostic",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query(
        "UPDATE runs SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND id=$2",
        [ids.tenant, ids.run],
      );
      await blocker.query("COMMIT");
      expect((await publishing).outcome).toBe("not_running");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query("UPDATE runs SET status='running' WHERE tenant_id=$1 AND id=$2", [
          ids.tenant,
          ids.run,
        ]),
      );
    }
  });

  it("Membership 撤销与单 SQL 列表授权按成员行锁串行化", async () => {
    const blocker = await migrator.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('app.tenant_id',$1,true)", [ids.tenant]);
      await blocker.query(
        "SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
        [ids.tenant, ids.user],
      );
      const listing = repository.listAuthorizedArtifacts({
        request: { tenantId: ids.tenant, userId: ids.user },
        runId: ids.run,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query(
        "UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2",
        [ids.tenant, ids.user],
      );
      await blocker.query("COMMIT");
      expect((await listing).outcome).toBe("not_found");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await withTenantTransaction(migrator, { tenantId: ids.tenant }, (client) =>
        client.query("UPDATE memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2", [
          ids.tenant,
          ids.user,
        ]),
      );
    }
  });
});
