import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  artifactId,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactExecutionAuthorization } from "../../runtime-ts/packages/artifact/src/authorization.js";
import { PgArtifactDeliveryRepository } from "../../runtime-ts/packages/artifact/src/pg-repository.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
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
if (migrationUrl.username !== configuredMigratorRole) throw new Error("迁移角色配置不一致");
migrationUrl.username = migratorRole;
migrationUrl.password = migratorPassword;
const migrationSecurity = { runtimeRole, migratorRole, schema } as const;

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
const issuedAt = "2099-07-28T00:00:00.000Z";
const expiresAt = "2099-07-28T01:00:00.000Z";
const consumedAt = "2099-07-28T00:00:01.000Z";
let admin!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let repository!: PgArtifactDeliveryRepository;

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

beforeAll(async () => {
  admin = createPostgresPool({ connectionString: bootstrapUrl, maxConnections: 2 });
  await admin.query(
    `CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${migratorPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT CONNECT ON DATABASE "${databaseName}" TO "${migratorRole}";
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
      `REVOKE CONNECT ON DATABASE "${databaseName}" FROM "${migratorRole}"; DROP ROLE IF EXISTS "${migratorRole}"`,
    );
    await admin.end();
  }
});

describe("Artifact PostgreSQL 持久化", () => {
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
    const publishing = await seedAdditionalExecution("publishing_only");
    const failed = await seedAdditionalExecution("failed_only");
    await cloneDeliverableForExecution(publishing, "publishing_only");
    await cloneDeliverableForExecution(failed, "failed_only", "failed");

    for (const execution of [publishing, failed]) {
      expect(
        await repository.listAuthorizedArtifacts({
          request: { tenantId: ids.tenant, userId: ids.user },
          runId: execution.run,
        }),
      ).toEqual({ outcome: "authorized", artifacts: [] });
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
