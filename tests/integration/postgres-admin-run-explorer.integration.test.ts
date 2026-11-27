import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RunExplorerService } from "../../runtime-ts/packages/admin-control/src/index.js";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  artifactWebhookPayload,
  enqueueRunStatusWebhook,
  enqueueWebhookEvent,
} from "../../runtime-ts/packages/persistence/src/pg-webhooks.js";
import { PgAdminRunExplorerRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-run-explorer.js";
import { PgAdminControlRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
import { PgRunFeedbackRepository } from "../../runtime-ts/packages/persistence/src/pg-run-feedback.js";
import { PgThreadContinuityMetrics } from "../../runtime-ts/packages/persistence/src/thread-continuity.js";
import {
  listRunTrajectoryCleanupTenants,
  PgRunTrajectoryStore,
} from "../../runtime-ts/packages/persistence/src/run-trajectory-store.js";
import type { BlobStore } from "../../runtime-ts/packages/persistence/src/blob-store.js";
import { PgBlobLifecycleRepository } from "../../runtime-ts/packages/persistence/src/pg-blob-lifecycle.js";
import {
  S3BlobStore,
  type S3ObjectClient,
  type S3PutObjectInput,
} from "../../runtime-ts/packages/persistence/src/s3-blob-store.js";
import { DurableTraceBlobPersistenceAdapter } from "../../runtime-ts/packages/persistence/src/trace-blob-persistence-adapter.js";
import { PgIntegrationAdminRepository } from "../../runtime-ts/packages/persistence/src/pg-integration-admin.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { loadPostgreSqlMigrationContract } from "./postgres-migration-contract.js";
import {
  bootstrapEvaluationRole,
  evaluationRoleName,
} from "../../runtime-ts/packages/persistence/src/evaluation-role.js";
import { withTransaction } from "../../runtime-ts/packages/persistence/src/postgres.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Run 浏览器集成测试缺少 ${name}；不会输出配置值`);
  return value;
}

const bootstrapUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const unique = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_run_explorer_${unique}`;
const roles = {
  runtimeRole: `it_rex_runtime_${unique}`,
  migratorRole: `it_rex_migrator_${unique}`,
  skillPublisherRole: `it_rex_publisher_${unique}`,
  trajectoryDirectoryRole: `it_rex_directory_${unique}`,
  workerCoordinatorRole: `it_rex_worker_${unique}`,
  teamCoordinatorRole: `it_rex_team_${unique}`,
  adminControlRole: `it_rex_control_${unique}`,
};
const security = { ...roles, schema };
const passwords = new Map(
  Object.values(roles).map((role) => [role, randomBytes(24).toString("hex")]),
);
const secret = "SECRET-用户与模型正文";
let administrator!: Pool;
let migrator!: Pool;
let control!: Pool;
let runtime!: Pool;
let created = false;

function roleUrl(role: string): string {
  const url = new URL(bootstrapUrl);
  url.username = role;
  const password = passwords.get(role);
  if (password === undefined) throw new Error("测试数据库角色缺少凭据");
  url.password = password;
  return url.toString();
}

/**
 * 夹具只关心控制面读取边界：以数据库管理员身份在 replica 模式下直接写入 Run 相关行，
 * 跳过与本测试无关的外键链（工作区、执行输入等），检查约束仍然生效。
 */
async function seed(): Promise<void> {
  const client = await administrator.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO app_users(id,created_at) VALUES
         ('user_viewer',now()),('user_admin',now()),('user_owner_a',now()),('user_owner_b',now())`,
    );
    await client.query(
      `INSERT INTO tenants(id,kind,owner_user_id,display_name,created_by_user_id,created_at) VALUES
         ('tenant_a','personal','user_owner_a',NULL,NULL,now()),
         ('tenant_b','personal','user_owner_b',NULL,NULL,now()),
         ('tenant_admin','personal','user_admin',NULL,NULL,now()),
         ('tenant_team','team',NULL,'团队空间','user_admin',now())`,
    );
    await client.query(
      `INSERT INTO user_accounts(user_id,personal_tenant_id,email,normalized_email,display_name,password_algorithm,password_salt,password_hash,created_at,updated_at)
       VALUES('user_admin','tenant_admin','admin@example.invalid','admin@example.invalid','平台管理员','scrypt-v1',decode(repeat('11',16),'hex'),decode(repeat('22',32),'hex'),now(),now())`,
    );
    await client.query(
      "UPDATE installation_state SET administrator_user_id='user_admin',initialized_at=now() WHERE singleton=true",
    );
    for (const [tenant, owner] of [
      ["tenant_a", "user_owner_a"],
      ["tenant_b", "user_owner_b"],
    ] as const) {
      await client.query(
        `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
         VALUES($1,'thread_1',$2,$3,'active',now(),now())`,
        [tenant, owner, `${secret} 标题`],
      );
    }
    const runsToCreate = [
      ["tenant_a", "run_a1", "succeeded", "2026-11-19T00:00:00Z"],
      ["tenant_a", "run_a2", "failed", "2026-11-19T01:00:00Z"],
      ["tenant_b", "run_b1", "succeeded", "2026-11-19T02:00:00Z"],
    ] as const;
    for (const [tenant, run, status, createdAt] of runsToCreate) {
      await client.query(
        `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
         VALUES($1,$2,'thread_1',$3,$4::timestamptz,$4::timestamptz + interval '30 seconds')`,
        [tenant, run, status, createdAt],
      );
      await client.query(
        `INSERT INTO run_execution_inputs(tenant_id,run_id,thread_id,workspace_id,root_run_id,input_text,initial_projection,initial_projection_digest)
         VALUES($1,$2,'thread_1','workspace_1',$2,$3,'{}'::jsonb,repeat('a',64))`,
        [tenant, run, `请分析 ${run} 的故障并给出原因`],
      );
      await client.query(
        `INSERT INTO execution_attempts(
           tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,
           created_at,updated_at,finished_at
         ) VALUES($1,$2,$3,'thread_1','workspace_1',$3,$4,'finished',
           $5::timestamptz + interval '1 second',$5::timestamptz + interval '20 seconds',
           $5::timestamptz + interval '20 seconds')`,
        [tenant, `${run}_attempt`, run, status, createdAt],
      );
    }
    const events: readonly [string, string, unknown][] = [
      ["agent_event", "0", { type: "thinking.delta", delta: `${secret} 推理` }],
      ["agent_event", "1", { type: "thinking.completed" }],
      [
        "agent_event",
        "2",
        {
          type: "tool.started",
          callId: "call_1",
          name: "read",
          presentation: { action: "read", title: `${secret}.md` },
        },
      ],
      [
        "agent_event",
        "3",
        {
          type: "tool.completed",
          callId: "call_1",
          name: "read",
          isError: true,
          failure: { code: "NOT_FOUND", message: secret },
        },
      ],
      ["agent_event", "4", { type: "message.delta", delta: `${secret} 回复` }],
      ["agent_event", "5", { type: "message.completed", stopReason: "stop" }],
      ["agent_event", "6", { type: "queue.updated", steering: [secret], followUp: [] }],
      ["agent_event", "7", { type: "error", code: "PROVIDER", message: secret }],
      ["run_waiting", "8", { question: secret, checkpointId: "checkpoint_1" }],
    ];
    for (const [kind, sequence, payload] of events) {
      await client.query(
        `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload,occurred_at)
         VALUES('tenant_a','run_a2_attempt',$1::bigint,1,$2::text,$3::jsonb,
           '2026-11-19T01:00:02Z'::timestamptz + make_interval(secs => $4::integer))`,
        // 序号与时间偏移分开传参：同一参数出现在不同类型位置会让 PostgreSQL 推断失败。
        [Number(sequence), kind, JSON.stringify(payload), Number(sequence)],
      );
    }
    for (const [metric, value, unit] of [
      ["model_input_tokens", 100, "tokens"],
      ["model_output_tokens", 20, "tokens"],
      ["model_cache_read_tokens", 50, "tokens"],
      ["model_generation_duration_ms", 1000, "milliseconds"],
    ] as const) {
      for (const observation of ["turn_1", "turn_2"]) {
        await client.query(
          `INSERT INTO thread_continuity_metric_observations(
             tenant_id,observation_id,thread_id,run_id,metric_name,value,unit
           ) VALUES('tenant_a',$1,'thread_1','run_a2',$2,$3,$4)`,
          [`${observation}:${metric}`, metric, value, unit],
        );
      }
    }
    await client.query(
      `INSERT INTO platform_control_operators(user_id,role,status) VALUES
         ('user_viewer','viewer','active'),('user_admin','admin','active')`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  administrator = createPostgresPool({ connectionString: bootstrapUrl });
  const database = new URL(bootstrapUrl).pathname.slice(1).replaceAll('"', '""');
  for (const role of Object.values(roles)) {
    await administrator.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${passwords.get(role)}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
  }
  created = true;
  await administrator.query(
    `GRANT CONNECT ON DATABASE "${database}" TO ${Object.values(roles)
      .map((role) => `"${role}"`)
      .join(",")};
     CREATE SCHEMA "${schema}" AUTHORIZATION "${roles.migratorRole}"`,
  );
  migrator = createPostgresPool({ connectionString: roleUrl(roles.migratorRole), schema });
  control = createPostgresPool({ connectionString: roleUrl(roles.adminControlRole), schema });
  runtime = createPostgresPool({ connectionString: roleUrl(roles.runtimeRole), schema });
  await withTransaction(administrator, (client) =>
    bootstrapEvaluationRole(client, roles.runtimeRole),
  );
  await migrateUp(migrator, security);
  await seed();
});

afterAll(async () => {
  await control?.end();
  await runtime?.end();
  await migrator?.end();
  if (created) {
    await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrator.query(`DROP ROLE IF EXISTS "${evaluationRoleName(roles.runtimeRole)}"`);
    for (const role of Object.values(roles)) {
      await administrator.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  }
  await administrator?.end();
});

let auditSequence = 0;

function service(auditIds: string[] = []) {
  return new RunExplorerService(new PgAdminRunExplorerRepository(control), () => {
    const id = `run_content_audit_${unique}_${auditSequence++}`;
    auditIds.push(id);
    return id;
  });
}

async function auditRows() {
  const result = await administrator.query(
    `SELECT actor_user_id,tenant_id,run_id,attempt_id FROM "${schema}".admin_run_content_access_audits
      WHERE attempt_id IS NOT NULL
      ORDER BY created_at`,
  );
  return result.rows;
}

describe("真实 Admin Control 角色的 Run 浏览器边界", () => {
  it("终端用户反馈绑定 Revision、仅本人可读写并进入无正文聚合", async () => {
    await administrator.query(
      `BEGIN; SET LOCAL session_replication_role=replica;
       INSERT INTO "${schema}".run_agent_snapshots(
         tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content
       ) VALUES('tenant_b','run_b1','thread_1','agent_pinned','revision_pinned',repeat('a',64),'{}'::jsonb);
       COMMIT`,
    );
    await administrator.query(
      `INSERT INTO "${schema}".memberships(tenant_id,id,user_id,role,status,created_at) VALUES
       ('tenant_b','member_owner_b','user_owner_b','owner','active',now()),
       ('tenant_b','member_viewer_b','user_viewer','member','active',now())`,
    );
    const repository = new PgRunFeedbackRepository(runtime);
    const scope = { tenantId: "tenant_b", userId: "user_owner_b" } as never;
    const saved = await repository.execute({
      scope,
      threadId: "thread_1",
      runId: "run_b1",
      operation: "put",
      feedback: { rating: "up", comment: "可用" },
    });
    expect(saved).toMatchObject({
      feedback: { revisionId: "revision_pinned", rating: "up", comment: "可用" },
    });
    const updated = await repository.execute({
      scope,
      threadId: "thread_1",
      runId: "run_b1",
      operation: "put",
      feedback: { rating: "down" },
    });
    expect(updated).toMatchObject({ feedback: { rating: "down" } });
    expect(
      await repository.execute({
        scope: { tenantId: "tenant_b", userId: "user_viewer" } as never,
        threadId: "thread_1",
        runId: "run_b1",
        operation: "get",
      }),
    ).toBe("not_found");
    for (const operation of ["put", "delete"] as const) {
      expect(
        await repository.execute({
          scope: { tenantId: "tenant_b", userId: "user_viewer" } as never,
          threadId: "thread_1",
          runId: "run_b1",
          operation,
          ...(operation === "put" ? { feedback: { rating: "down" as const } } : {}),
        }),
      ).toBe("not_found");
    }
    expect(
      await repository.execute({
        scope,
        threadId: "thread_1",
        runId: "run_b1",
        operation: "get",
      }),
    ).toMatchObject({ feedback: { rating: "down" } });
    const privateRows = await withTenantTransaction(
      runtime,
      { tenantId: "tenant_b", userId: "user_viewer" } as never,
      async (client) => {
        const selected = await client.query(
          "SELECT run_id FROM run_feedback WHERE tenant_id='tenant_b' AND run_id='run_b1'",
        );
        const changed = await client.query(
          "UPDATE run_feedback SET rating='up' WHERE tenant_id='tenant_b' AND run_id='run_b1' AND user_id='user_owner_b'",
        );
        return { selected: selected.rowCount, changed: changed.rowCount };
      },
    );
    expect(privateRows).toEqual({ selected: 0, changed: 0 });
    await expect(
      withTenantTransaction(
        runtime,
        { tenantId: "tenant_b", userId: "user_viewer" } as never,
        (client) =>
          client.query(
            `INSERT INTO run_feedback(tenant_id,run_id,revision_id,user_id,rating)
             VALUES('tenant_b','run_b1','revision_pinned','user_viewer','up')`,
          ),
      ),
    ).rejects.toThrow();
    expect(
      await repository.execute({
        scope: { tenantId: "tenant_a", userId: "user_owner_a" } as never,
        threadId: "thread_1",
        runId: "run_b1",
        operation: "put",
        feedback: { rating: "up" },
      }),
    ).toBe("not_found");
    expect(
      await repository.execute({
        scope,
        threadId: "thread_1",
        runId: "run_b1",
        operation: "put",
        feedback: { rating: "up", comment: "x".repeat(2001) },
      }),
    ).toBe("bad_request");
    expect(
      await repository.execute({
        scope,
        threadId: "thread_1",
        runId: "run_b1",
        operation: "delete",
      }),
    ).toEqual({ feedback: null });
    const forbidden = await administrator.query(
      `INSERT INTO "${schema}".run_feedback(tenant_id,run_id,revision_id,user_id,rating,comment)
       VALUES('tenant_b','run_b1','revision_pinned','user_owner_b','up','已审核内容') RETURNING run_id`,
    );
    expect(forbidden.rows).toHaveLength(1);
    const noContent = await new PgAdminRunExplorerRepository(control).getRun({
      actorUserId: "user_admin",
      tenantId: "tenant_b",
      runId: "run_b1",
    });
    expect(noContent?.feedback).toBeUndefined();
    const auditedContent = await new PgAdminRunExplorerRepository(control).getRun({
      actorUserId: "user_admin",
      tenantId: "tenant_b",
      runId: "run_b1",
      inputAuditId: `feedback_audit_${unique}`,
    });
    expect(auditedContent?.feedback).toMatchObject([{ rating: "up", comment: "已审核内容" }]);
    const feedbackMetrics = await new PgAdminControlRepository(
      control,
      {} as never,
      "unused",
    ).readAgentMetrics({
      actorUserId: "user_admin",
      from: "2026-11-19T02:00:00.000Z",
      to: "2026-11-19T03:00:00.000Z",
    });
    expect(feedbackMetrics).toMatchObject([
      { feedbackUpCount: 1, feedbackDownCount: 0, feedbackUpRate: 1, feedbackDownRate: 0 },
    ]);
    await administrator.query(
      `DELETE FROM "${schema}".run_feedback WHERE tenant_id='tenant_b' AND run_id='run_b1'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".run_agent_snapshots WHERE tenant_id='tenant_b' AND run_id='run_b1'`,
    );
  });

  it("Agent 指标仅呈现无正文的按小时聚合且默认排除 Playground 与评测来源", async () => {
    await administrator.query(
      `INSERT INTO "${schema}".runs(tenant_id,id,thread_id,status,created_at,updated_at,origin)
       VALUES('tenant_a','run_evaluation_metrics','thread_1','running',
         '2026-11-19T04:00:00Z','2026-11-19T04:00:20Z','evaluation')`,
    );
    await administrator.query(
      `BEGIN;
       SET LOCAL session_replication_role=replica;
       INSERT INTO "${schema}".execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,
         created_at,updated_at,finished_at
       ) VALUES('tenant_a','run_evaluation_attempt','run_evaluation_metrics','thread_1',
         'workspace_1','run_evaluation_metrics','recovery_required','finished',
         '2026-11-19T04:00:01Z','2026-11-19T04:00:20Z','2026-11-19T04:00:20Z');
       COMMIT;`,
    );
    await administrator.query(
      `INSERT INTO "${schema}".runs(tenant_id,id,thread_id,status,created_at,updated_at,origin)
       VALUES('tenant_a','run_waiting_metrics','thread_1','waiting',
         '2026-11-19T05:00:00Z','2026-11-19T05:01:00Z','normal')`,
    );
    await administrator.query(
      `BEGIN;
       SET LOCAL session_replication_role=replica;
       INSERT INTO "${schema}".execution_attempts(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,
         created_at,updated_at,finished_at
       ) VALUES('tenant_a','run_waiting_attempt','run_waiting_metrics','thread_1',
         'workspace_1','run_waiting_metrics','waiting','finished',
         '2026-11-19T05:00:01Z','2026-11-19T05:01:00Z','2026-11-19T05:01:00Z');
       COMMIT;`,
    );
    await administrator.query(
      `INSERT INTO "${schema}".run_model_pricing_snapshots(
         tenant_id,run_id,model_id,currency,input_per_million,output_per_million,cache_read_per_million
       ) VALUES('tenant_a','run_a2','model-a','USD',1,2,0.5)`,
    );
    await administrator.query(
      `INSERT INTO "${schema}".thread_continuity_metric_observations(
         tenant_id,observation_id,thread_id,run_id,metric_name,value,unit
       ) VALUES('tenant_a','model-rounds-metric','thread_1','run_a2','model_generation_count',2,'count')`,
    );
    await administrator.query(
      `INSERT INTO "${schema}".thread_continuity_metric_observations(
         tenant_id,observation_id,thread_id,run_id,metric_name,value,unit
       ) VALUES('tenant_a','unpriced-model-round','thread_1','run_a1','model_generation_count',1,'count')`,
    );
    const rows = await new PgAdminControlRepository(
      control,
      {} as never,
      "unused",
    ).readAgentMetrics({
      actorUserId: "user_admin",
      from: "2026-11-19T00:00:00.000Z",
      to: "2026-11-20T00:00:00.000Z",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !["playground", "evaluation"].includes(row.origin))).toBe(true);
    expect(
      rows.find(
        (row) => row.tenantId === "tenant_a" && row.origin === "normal" && row.currency === "USD",
      ),
    ).toMatchObject({
      cost: expect.closeTo(0.00033),
      averageModelRounds: 2,
      failedToolCalls: 1,
      toolFailureRate: 1,
      failureRate: 1,
      latencyP50Ms: 20_000,
    });
    expect(
      rows.find(
        (row) => row.tenantId === "tenant_a" && row.origin === "normal" && row.currency === null,
      ),
    ).toMatchObject({ runCount: 1, averageModelRounds: 1, cost: null });
    const evaluationRows = await new PgAdminControlRepository(
      control,
      {} as never,
      "unused",
    ).readAgentMetrics({
      actorUserId: "user_admin",
      from: "2026-11-19T00:00:00.000Z",
      to: "2026-11-20T00:00:00.000Z",
      origin: "evaluation",
    });
    expect(evaluationRows.length).toBeGreaterThan(0);
    expect(evaluationRows.every((row) => row.origin === "evaluation")).toBe(true);
    expect(evaluationRows[0]).toMatchObject({ resultUnknownCount: 1, resultUnknownRate: 1 });
    const waitingRows = await new PgAdminControlRepository(
      control,
      {} as never,
      "unused",
    ).readAgentMetrics({
      actorUserId: "user_admin",
      from: "2026-11-19T05:00:00.000Z",
      to: "2026-11-19T06:00:00.000Z",
    });
    expect(waitingRows).toMatchObject([
      { runCount: 1, latencyP50Ms: null, latencyP90Ms: null, latencyP99Ms: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    await expect(control.query("SELECT * FROM runs")).rejects.toMatchObject({ code: "42501" });
    await administrator.query(
      `DELETE FROM "${schema}".execution_attempts WHERE tenant_id='tenant_a' AND attempt_id='run_waiting_attempt'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".runs WHERE tenant_id='tenant_a' AND id='run_waiting_metrics'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".execution_attempts WHERE tenant_id='tenant_a' AND attempt_id='run_evaluation_attempt'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".runs WHERE tenant_id='tenant_a' AND id='run_evaluation_metrics'`,
    );
  });

  it("指标视图 EXPLAIN 将原始时间窗口下推到 Run 创建时间索引", async () => {
    const client = await administrator.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan=off");
      await client.query("SET LOCAL enable_bitmapscan=off");
      await client.query("SELECT set_config('app.user_id','user_admin',true)");
      await client.query(
        `SELECT set_config('app.agent_metrics_from','2026-11-19T00:00:00Z',true),
                set_config('app.agent_metrics_to','2026-11-20T00:00:00Z',true),
                set_config('app.agent_metrics_origin','',true)`,
      );
      const plan = await client.query<{ readonly "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT window_start,agent_definition_id,agent_revision_id,tenant_id,origin,currency,
                run_count,succeeded_count,failed_count,result_unknown_count,
                success_rate,failure_rate,result_unknown_rate,tool_failure_rate,
                latency_p50_ms,latency_p90_ms,latency_p99_ms,average_model_rounds,
                tool_calls,failed_tool_calls,input_tokens,output_tokens,cache_read_tokens,cost
           FROM "${schema}".admin_agent_metrics_hourly
          ORDER BY window_start,agent_definition_id,agent_revision_id,tenant_id,currency
          LIMIT 10001`,
      );
      const planRoot = plan.rows[0]?.["QUERY PLAN"] as
        | readonly { readonly Plan?: Record<string, unknown> }[]
        | undefined;
      const scanNodes: Record<string, unknown>[] = [];
      const visit = (node: unknown) => {
        if (typeof node !== "object" || node === null) return;
        const record = node as Record<string, unknown>;
        if (record["Relation Name"] === "runs") scanNodes.push(record);
        for (const value of Object.values(record)) {
          if (Array.isArray(value)) value.forEach(visit);
          else if (typeof value === "object" && value !== null) visit(value);
        }
      };
      visit(planRoot?.[0]?.Plan);
      const runScan = scanNodes.find((node) => node["Index Name"] === "runs_metrics_created_idx");
      expect(runScan).toBeDefined();
      const indexCondition = String(runScan?.["Index Cond"]);
      expect(indexCondition).toContain("created_at >=");
      expect(indexCondition).toContain("created_at <");
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("指标查询并发达到上限时快速拒绝，而不排队占用连接", async () => {
    const client = await administrator.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(6711329,2403)");
      const repository = new PgAdminControlRepository(control, {} as never, "unused");
      await expect(
        repository.readAgentMetrics({
          actorUserId: "user_admin",
          from: "2026-11-19T00:00:00.000Z",
          to: "2026-11-20T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("Run 用量计价读取 Agent 固定 Provider Revision，而非平台活动 Revision", async () => {
    const providerConfig = (inputPrice: number) => ({
      providerKey: "pinned_provider",
      displayName: "Pinned Provider",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.invalid/v1",
      secretRef: "deployment:model",
      defaultModelId: "pinned-model",
      models: [
        {
          id: "pinned-model",
          name: "Pinned Model",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
          pricing: {
            currency: inputPrice === 7 ? "USD" : "EUR",
            inputPerMillion: inputPrice,
            outputPerMillion: 3,
            cacheReadPerMillion: 1,
          },
        },
      ],
    });
    await administrator.query(
      `BEGIN; SET LOCAL search_path TO "${schema}"; SET LOCAL session_replication_role=replica`,
    );
    for (const [revision, price] of [
      [1, 7],
      [2, 90],
    ] as const) {
      await administrator.query(
        `INSERT INTO admin_control_config_revisions(
           object_kind,object_key,revision,configuration,configuration_digest,created_by
         ) VALUES('model_provider','pinned_provider',$1,$2::jsonb,$3,'user_admin')`,
        [revision, JSON.stringify(providerConfig(price)), String(revision).repeat(64)],
      );
    }
    await administrator.query(
      `INSERT INTO admin_control_active_configs(
         object_kind,object_key,revision,generation,activated_by,reason
       ) VALUES('model_provider','pinned_provider',2,1,'user_admin','测试切换活动版本')`,
    );
    await administrator.query(
      `INSERT INTO run_agent_snapshots(
         tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content
       ) VALUES('tenant_b','run_b1','thread_1','agent_pinned','revision_pinned',repeat('a',64),
         '{"model":{"mode":"pinned","providerKey":"pinned_provider","providerRevision":1,"modelId":"pinned-model"}}'::jsonb)`,
    );
    await administrator.query("COMMIT");
    const metrics = new PgThreadContinuityMetrics(runtime);
    await metrics.recordModelUsage({
      tenantId: "tenant_b" as never,
      threadId: "thread_1" as never,
      runId: "run_b1" as never,
      observationId: "integration:model-usage:pinned-revision",
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 50_000,
      generationDurationMs: 500,
    });
    const result = await administrator.query(
      `SELECT model_id,currency,input_per_million,output_per_million,cache_read_per_million
         FROM "${schema}".run_model_pricing_snapshots WHERE tenant_id='tenant_b' AND run_id='run_b1'`,
    );
    expect(result.rows[0]).toMatchObject({
      model_id: "pinned-model",
      currency: "USD",
      input_per_million: "7.000000",
      output_per_million: "3.000000",
      cache_read_per_million: "1.000000",
    });
    await administrator.query(
      `DELETE FROM "${schema}".thread_continuity_metric_observations
        WHERE tenant_id='tenant_b' AND observation_id LIKE 'integration:model-usage:pinned-revision:%'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".run_model_pricing_snapshots WHERE tenant_id='tenant_b' AND run_id='run_b1'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".run_agent_snapshots WHERE tenant_id='tenant_b' AND run_id='run_b1'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".admin_control_active_configs WHERE object_kind='model_provider' AND object_key='pinned_provider'`,
    );
    await administrator.query(
      `DELETE FROM "${schema}".admin_control_config_revisions WHERE object_kind='model_provider' AND object_key='pinned_provider'`,
    );
  });

  it("目录身份只通过受限目录视图枚举有轨迹的 Tenant", async () => {
    const client = await administrator.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(
        `INSERT INTO run_trajectory_entries(
         tenant_id,thread_id,run_id,attempt_id,sequence,source,event_type,occurred_at,
         monotonic_offset_ms,sha256,size,persistence_status,blob_operation_id,expires_at
       ) VALUES('tenant_a','thread_1','run_a2','run_a2_attempt',1,'runtime','test',now(),
         0,repeat('a',64),1,'pending','trace-'||repeat('b',64),now()+interval '1 day')`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const directory = createPostgresPool({
      connectionString: roleUrl(roles.trajectoryDirectoryRole),
      schema,
    });
    try {
      await expect(listRunTrajectoryCleanupTenants(directory)).resolves.toEqual(["tenant_a"]);
      await expect(listRunTrajectoryCleanupTenants(runtime)).rejects.toMatchObject({
        code: "42501",
      });
      for (const sql of [
        "SELECT * FROM run_trajectory_entries",
        "SELECT * FROM tenants",
        "UPDATE worker_tenant_assignments SET generation=generation WHERE false",
      ]) {
        await expect(directory.query(sql)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await directory.end();
    }
  });

  it("相同 Agent Thread 的 followUp Session 可各自保存相同 sequence", async () => {
    for (const [turn, digest] of [
      ["turn-first", "a".repeat(64)],
      ["turn-follow-up", "b".repeat(64)],
    ] as const) {
      await administrator.query(
        `INSERT INTO "${schema}".run_trajectory_entries(
           tenant_id,thread_id,run_id,attempt_id,agent_thread_id,agent_turn_id,sequence,
           source,event_type,occurred_at,monotonic_offset_ms,sha256,size,persistence_status,
           blob_operation_id,expires_at
         ) VALUES('tenant_a','thread_1','run_a2','run_a2_attempt','agent_child',$1,1,
           'runtime','session_event',now(),0,$2,1,'pending',$3,now()+interval '1 day')`,
        [turn, digest, `trace-${digest}`],
      );
    }
    const result = await administrator.query(
      `SELECT agent_thread_id,agent_turn_id,sequence FROM "${schema}".run_trajectory_entries
        WHERE tenant_id='tenant_a' AND attempt_id='run_a2_attempt' AND agent_thread_id='agent_child'
        ORDER BY agent_turn_id`,
    );
    expect(result.rows).toEqual([
      { agent_thread_id: "agent_child", agent_turn_id: "turn-first", sequence: "1" },
      { agent_thread_id: "agent_child", agent_turn_id: "turn-follow-up", sequence: "1" },
    ]);
  });

  it("stage_verified 后取消保留 pending 锚点，重启的清理器先删除 staging 再删除索引", async () => {
    const controller = new AbortController();
    const repository = new PgBlobLifecycleRepository(runtime);
    const cas = repository.compareAndSet.bind(repository);
    vi.spyOn(repository, "compareAndSet").mockImplementation(async (input) => {
      const applied = await cas(input);
      if (applied && input.next.status === "staged") controller.abort();
      return applied;
    });
    const staging = new Set<string>();
    const blobs = {
      async putStaging(input) {
        if (input.expectedSha256 === undefined) throw new Error("缺少 staging 摘要");
        staging.add(input.uploadId);
        return {
          kind: "staging",
          tenantId: input.scope.tenantId,
          purpose: input.purpose,
          uploadId: input.uploadId,
          size: input.body.byteLength,
          sha256: input.expectedSha256,
          mediaType: input.mediaType,
        };
      },
      async deleteStaging(_scope, ref) {
        staging.delete(ref.uploadId);
      },
    } satisfies Pick<BlobStore, "putStaging" | "deleteStaging">;
    const adapter = new DurableTraceBlobPersistenceAdapter(repository, blobs as BlobStore);
    const store = new PgRunTrajectoryStore(runtime, blobs as BlobStore, adapter);
    const context = {
      tenantId: "tenant_a",
      runId: "run_a2",
      attemptId: "run_a2_attempt",
      threadId: "thread_1",
    };
    const event = {
      schemaVersion: 1 as const,
      sequence: 21,
      occurredAt: new Date().toISOString(),
      monotonicOffsetMs: 1,
      source: "pi" as const,
      type: "message",
      event: {},
    };
    await expect(
      store.persist({ context, event }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(controller.signal.aborted).toBe(true);
    expect(staging.size).toBe(1);
    const expired = await administrator.query(
      `UPDATE "${schema}".run_trajectory_entries SET expires_at=now() WHERE sequence=21 RETURNING persistence_status`,
    );
    expect(expired.rows).toEqual([{ persistence_status: "pending" }]);
    const recovery = new DurableTraceBlobPersistenceAdapter(
      new PgBlobLifecycleRepository(runtime),
      blobs as BlobStore,
    );
    const restarted = new PgRunTrajectoryStore(
      runtime,
      blobs as BlobStore,
      undefined,
      30,
      undefined,
      recovery,
    );
    await expect(restarted.cleanupExpired("tenant_a", 1)).resolves.toBe(1);
    expect(staging.size).toBe(0);
    await expect(restarted.cleanupExpired("tenant_a", 1)).resolves.toBe(0);
  });

  it("已提交 Blob、索引仍 pending 时，在同一有界批次绑定、释放并回收", async () => {
    const lifecycle = randomUUID(),
      incarnation = randomUUID();
    const connection = await administrator.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(`SET LOCAL search_path TO "${schema}"`);
      await connection.query(`INSERT INTO run_trajectory_entries(tenant_id,thread_id,run_id,attempt_id,sequence,source,event_type,occurred_at,monotonic_offset_ms,sha256,size,persistence_status,blob_operation_id,expires_at)
        VALUES('tenant_a','thread_1','run_a2','run_a2_attempt',22,'pi','test',now(),0,repeat('c',64),3,'pending','trace-'||repeat('d',64),now());
        INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot) VALUES ('tenant_a','trace-'||repeat('d',64),'completed',0,'{}')`);
      await connection.query(
        `INSERT INTO blob_lifecycles(tenant_id,lifecycle_id,purpose,sha256,size,state,current_incarnation_id,generation) VALUES('tenant_a',$1,'trace',repeat('c',64),3,'active',$2,1)`,
        [lifecycle, incarnation],
      );
      await connection.query(
        `INSERT INTO blob_incarnations(tenant_id,lifecycle_id,purpose,sha256,size,incarnation_id,physical_object_key,state) VALUES('tenant_a',$1,'trace',repeat('c',64),3,$2,'trace/stable','active')`,
        [lifecycle, incarnation],
      );
      await connection.query(
        `INSERT INTO blob_references(tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,staging_upload_id,lifecycle_id,incarnation_id,physical_object_key) VALUES('tenant_a','ref_trace','trace-'||repeat('d',64),'stable','trace',repeat('c',64),3,'text/plain','upload',$1,$2,'trace/stable')`,
        [lifecycle, incarnation],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    const gc = vi.fn(async () => {
      const result = await administrator.query(
        `SELECT e.persistence_status,r.state FROM "${schema}".run_trajectory_entries e JOIN "${schema}".blob_references r USING(tenant_id) WHERE e.blob_reference_id=r.reference_id AND e.sequence=22`,
      );
      expect(result.rows).toEqual([{ persistence_status: "stored", state: "released" }]);
      return "deleted" as const;
    });
    const store = new PgRunTrajectoryStore(
      runtime,
      {} as BlobStore,
      undefined,
      30,
      { collectIfUnreachable: gc },
      { recoverForRetention: async () => "completed" },
    );
    await expect(store.cleanupExpired("tenant_a", 1)).resolves.toBe(1);
    expect(gc).toHaveBeenCalledTimes(1);
    await expect(store.cleanupExpired("tenant_a", 1)).resolves.toBe(0);
  });

  it("未终结的旧提交不会反复占满小批次", async () => {
    await administrator.query(`INSERT INTO "${schema}".run_trajectory_entries(
       tenant_id,thread_id,run_id,attempt_id,sequence,source,event_type,occurred_at,monotonic_offset_ms,sha256,size,persistence_status,blob_operation_id,expires_at,updated_at)
       SELECT 'tenant_b','thread_1','run_b1','run_b1_attempt',n,'pi','test',now(),0,repeat('e',64),1,'pending',
              'trace-'||lpad(n::text,64,'0'),now()-interval '1 day',now()-interval '2 days' FROM generate_series(23,24) n`);
    const tried: number[] = [];
    const store = new PgRunTrajectoryStore(runtime, {} as BlobStore, undefined, 30, undefined, {
      recoverForRetention: async ({ operationId }) => {
        const n = Number(operationId.slice(-2));
        tried.push(n);
        return n === 23 ? "deferred" : "abandoned";
      },
    });
    await expect(store.cleanupExpired("tenant_b", 1)).resolves.toBe(0);
    await expect(store.cleanupExpired("tenant_b", 1)).resolves.toBe(1);
    expect(tried).toEqual([23, 24]);
  });

  it("管理员列表显示问题并支持关键词搜索，接入目录固定初始化管理员空间", async () => {
    const explorer = service();
    const allRuns = await explorer.listRuns("user_admin");
    expect(allRuns.items).toHaveLength(3);
    expect(allRuns.contentAccess).toBe(true);
    expect(allRuns.items[0]).toMatchObject({
      threadTitle: `${secret} 标题`,
      userInput: expect.stringContaining("故障并给出原因"),
    });
    expect(allRuns.items.some((run) => run.userInput?.includes("run_a1"))).toBe(true);
    const page = await explorer.listRuns("user_admin", { search: "run_a1" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.userInput).toContain("run_a1");
    expect(page.items[0]?.threadTitle).toContain(`${secret} 标题`);

    const integrations = new PgIntegrationAdminRepository(control);
    const tenants = await integrations.listTenants("user_admin");
    await expect(integrations.listKeys("user_admin", "tenant_admin")).resolves.toEqual([]);
    expect(tenants.find((item) => item.isDefault)).toMatchObject({
      tenantId: "tenant_admin",
      displayName: "admin@example.invalid",
      kind: "personal",
    });
    expect(tenants.find((item) => item.tenantId === "tenant_team")).toMatchObject({
      displayName: "团队空间",
      kind: "team",
      isDefault: false,
    });
  });

  it("Playground 来源受管理员个人空间约束，普通 Run 不能关联 Mock", async () => {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id','tenant_a',true)");
      await client.query("SELECT set_config('app.user_id','user_viewer',true)");
      await client.query("SELECT set_config('app.playground_acceptance','true',true)");
      await expect(
        client.query(
          `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at,origin)
         VALUES('tenant_a','run_forged_playground','thread_1','queued',now(),now(),'playground')`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    await expect(
      administrator.query(
        `INSERT INTO "${schema}".run_playground_mocks(tenant_id,run_id,mock_results,idempotency_key,request_digest)
       VALUES('tenant_a','run_a1','{"lookup":{"ok":true}}'::jsonb,'test-mock-key',repeat('a',64))`,
      ),
    ).rejects.toMatchObject({ code: "23503" });

    for (const origin of ["api", "evaluation"] as const) {
      await expect(
        administrator.query(
          `INSERT INTO "${schema}".run_playground_mocks(tenant_id,run_id,origin,mock_results,idempotency_key,request_digest)
           VALUES('tenant_a','run_a1',$1,'{"lookup":{"ok":true}}'::jsonb,$2,repeat('b',64))`,
          [origin, `test-mock-${origin}`],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("持久化 Playground 来源同时阻止状态与 Artifact 业务 Webhook 入队", async () => {
    await administrator.query(
      `INSERT INTO "${schema}".tenant_webhooks(
         tenant_id,id,name,endpoint_url,event_types,secret_ciphertext,created_by_user_id,created_at
       ) VALUES('tenant_a','webhook_pg','测试订阅','https://hooks.invalid/receive',
         ARRAY['run.succeeded','artifact.published'],'{}'::jsonb,'user_owner_a',now())`,
    );
    await administrator.query(
      `UPDATE "${schema}".runs SET origin='playground' WHERE tenant_id='tenant_a' AND id='run_a1'`,
    );
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id','tenant_a',true)");
      await enqueueRunStatusWebhook(client, {
        tenantId: "tenant_a",
        runId: "run_a1",
        status: "succeeded",
        runVersion: 2,
        occurredAt: "2026-11-21T00:00:00.000Z",
      });
      await enqueueWebhookEvent({
        client,
        tenantId: "tenant_a",
        payload: artifactWebhookPayload({
          tenantId: "tenant_a",
          artifactId: "artifact_playground",
          runId: "run_a1",
          occurredAt: "2026-11-21T00:00:00.000Z",
        }),
      });
      const pending = await client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM webhook_outbox WHERE tenant_id='tenant_a'`,
      );
      expect(pending.rows[0]?.count).toBe("0");
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await administrator.query(
        `UPDATE "${schema}".runs SET origin='normal' WHERE tenant_id='tenant_a' AND id='run_a1'`,
      );
    }
  });

  it("跨 Tenant 列表按 Tenant、状态与时间筛选，并汇总耗时、调用与 Token", async () => {
    const explorer = service();
    const all = await explorer.listRuns("user_viewer");
    expect(all.items.map((item) => `${item.tenantId}/${item.runId}`)).toEqual([
      "tenant_b/run_b1",
      "tenant_a/run_a2",
      "tenant_a/run_a1",
    ]);
    expect(all.contentAccess).toBe(false);

    const tenantA = await explorer.listRuns("user_viewer", { tenantId: "tenant_a" });
    expect(tenantA.items.map((item) => item.runId)).toEqual(["run_a2", "run_a1"]);
    const failed = await explorer.listRuns("user_viewer", { status: "failed" });
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]).toMatchObject({
      tenantId: "tenant_a",
      runId: "run_a2",
      attemptCount: 1,
      durationMs: 20_000,
      modelCalls: 2,
      toolCalls: 1,
      failedToolCalls: 1,
      errorCount: 1,
      agentDefinitionId: null,
      origin: "normal",
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 100,
        generationDurationMs: 2000,
      },
    });
    const window = await explorer.listRuns("user_viewer", {
      createdFrom: "2026-11-19T00:30:00Z",
      createdTo: "2026-11-19T01:30:00Z",
    });
    expect(window.items.map((item) => item.runId)).toEqual(["run_a2"]);
    expect(
      (await explorer.listRuns("user_viewer", { agentDefinitionId: "agent_default" })).items,
    ).toEqual([]);

    const firstPage = await explorer.listRuns("user_viewer", { limit: 2 });
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await explorer.listRuns("user_viewer", {
      limit: 2,
      ...(firstPage.nextCursor === undefined ? {} : { cursor: firstPage.nextCursor }),
    });
    expect(secondPage.items.map((item) => item.runId)).toEqual(["run_a1"]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(JSON.stringify([all, failed])).not.toContain("SECRET");
  });

  it("业务指标和用户目录不计 Playground，但诊断保留同一 Run 的耗时和 Token", async () => {
    const client = await administrator.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`INSERT INTO user_accounts(user_id,personal_tenant_id,email,normalized_email,display_name,password_algorithm,password_salt,password_hash,created_at,updated_at)
        VALUES ('user_owner_b','tenant_b','example@test.invalid','example@test.invalid','测试用户','scrypt-v1',decode(repeat('00',16),'hex'),decode(repeat('00',32),'hex'),now(),now())`);
      await client.query(`INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at,is_playground)
        VALUES ('tenant_b','thread_test','user_owner_b','试运行','active',now(),now(),true)`);
      // 与另一租户的普通 Run 同 ID，排除指标必须使用完整的 Tenant/Run 身份。
      await client.query(`INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at,origin)
        VALUES ('tenant_b','run_a2','thread_test','running',now(),now(),'playground')`);
      await client.query(`INSERT INTO thread_continuity_metric_observations(tenant_id,observation_id,thread_id,run_id,metric_name,value,unit)
        VALUES ('tenant_b','model:turn_1','thread_test','run_a2','model_output_tokens',900,'tokens')`);
      await client.query(`SET LOCAL ROLE "${roles.adminControlRole}"`);
      await client.query("SELECT set_config('app.user_id','user_admin',true)");
      expect(
        (
          await client.query(
            "SELECT runs_total,runs_running,conversations_total,model_output_tokens_24h FROM admin_runtime_statistics",
          )
        ).rows,
      ).toEqual([
        {
          runs_total: "3",
          runs_running: "0",
          conversations_total: "2",
          model_output_tokens_24h: "40",
        },
      ]);
      expect(
        (
          await client.query(
            "SELECT conversation_count,run_count FROM admin_user_directory WHERE user_id='user_owner_b'",
          )
        ).rows,
      ).toEqual([{ conversation_count: "1", run_count: "1" }]);
      expect(
        (
          await client.query(
            "SELECT output_tokens FROM admin_run_directory WHERE tenant_id='tenant_b' AND run_id='run_a2' AND origin='playground'",
          )
        ).rows,
      ).toEqual([{ output_tokens: "900" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("结构视图在数据库内剥离正文，详情只返回结构时间线且不写审计", async () => {
    const outline = await control.connect();
    try {
      await outline.query("BEGIN READ ONLY");
      await outline.query("SELECT set_config('app.user_id','user_viewer',true)");
      const rows = await outline.query("SELECT * FROM admin_run_event_outline");
      expect(rows.rows).toHaveLength(9);
      expect(JSON.stringify(rows.rows)).not.toContain("SECRET");
      const directory = await outline.query("SELECT * FROM admin_run_directory");
      expect(JSON.stringify(directory.rows)).not.toContain("SECRET");
      await outline.query("COMMIT");
    } finally {
      outline.release();
    }

    const detail = await service().getRunDetail("user_viewer", "tenant_a", "run_a2");
    expect(JSON.stringify(detail)).not.toContain("SECRET");
    expect(detail.timeline.records.map((record) => [record.kind, record.summary])).toEqual([
      ["reasoning", "模型推理"],
      ["tool", "read"],
      ["assistant", "模型回复"],
      ["runtime", "队列：steering 1，follow-up 0"],
      ["runtime", "PROVIDER"],
      ["waiting", "等待用户回答"],
    ]);
    expect(detail.timeline.records[1]).toMatchObject({
      status: "failed",
      durationMs: 1000,
      detail: { failureCode: "NOT_FOUND", action: "read" },
    });
    expect(await auditRows()).toEqual([]);
  });

  it("没有正文权限时服务端拒绝，数据库也拒绝写审计并隐藏正文", async () => {
    await expect(
      service().readRunContent("user_viewer", "tenant_a", "run_a2"),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    // 绕过服务直接调用存储层时，RLS 拒绝非 admin 写审计，正文读取随事务失败。
    await expect(
      new PgAdminRunExplorerRepository(control).readContent({
        actorUserId: "user_viewer",
        tenantId: "tenant_a",
        runId: "run_a2",
        attemptId: "run_a2_attempt",
        auditId: `forged_audit_${unique}`,
      }),
    ).rejects.toBeDefined();
    const client = await control.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.user_id','user_admin',true)");
      // 有效 admin 未在本事务写审计时同样读不到正文。
      expect((await client.query("SELECT * FROM admin_run_event_content")).rows).toEqual([]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await auditRows()).toEqual([]);
  });

  it("admin 每次读取正文都写入审计，审计号不能在后续事务复用", async () => {
    const auditIds: string[] = [];
    const explorer = service(auditIds);
    const content = await explorer.readRunContent("user_admin", "tenant_a", "run_a2");
    expect(JSON.stringify(content.timeline)).toContain(`${secret} 回复`);
    expect(content.auditId).toBe(auditIds[1]);
    await explorer.readRunContent("user_admin", "tenant_a", "run_a2", "run_a2_attempt");
    expect(await auditRows()).toEqual([
      {
        actor_user_id: "user_admin",
        tenant_id: "tenant_a",
        run_id: "run_a2",
        attempt_id: "run_a2_attempt",
      },
      {
        actor_user_id: "user_admin",
        tenant_id: "tenant_a",
        run_id: "run_a2",
        attempt_id: "run_a2_attempt",
      },
    ]);

    const client = await control.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.user_id','user_admin',true)");
      await client.query("SELECT set_config('app.run_content_audit_id',$1,true)", [
        content.auditId,
      ]);
      expect((await client.query("SELECT * FROM admin_run_event_content")).rows).toEqual([]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("admin 列表读取用户输入时同事务记录筛选摘要和返回数，不保存正文", async () => {
    const auditIds: string[] = [];
    const explorer = service(auditIds);
    const page = await explorer.listRuns("user_admin", { search: "run_a1", limit: 10 });
    expect(page.items).toHaveLength(1);
    const result = await administrator.query(
      `SELECT query_summary,returned_run_count FROM "${schema}".admin_run_content_access_audits
       WHERE audit_id=$1`,
      [auditIds[0]],
    );
    expect(result.rows[0]).toMatchObject({
      query_summary: expect.objectContaining({ search: "run_a1", limit: 10 }),
      returned_run_count: 1,
    });
    expect(JSON.stringify(result.rows[0])).not.toContain(secret);
  });

  it("Admin Control 不取得 Run 底表权限，非控制面会话看不到任何视图行", async () => {
    for (const table of ["runs", "execution_attempts", "run_events", "threads"]) {
      await expect(control.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
        code: "42501",
      });
    }
    for (const view of ["admin_run_directory", "admin_run_event_outline"]) {
      expect((await control.query(`SELECT * FROM ${view}`)).rows).toEqual([]);
    }
    await migrator.query(
      "UPDATE platform_control_operators SET status='disabled' WHERE user_id='user_admin'",
    );
    try {
      await expect(service().listRuns("user_admin")).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
      });
      await expect(
        new PgAdminRunExplorerRepository(control).readContent({
          actorUserId: "user_admin",
          tenantId: "tenant_a",
          runId: "run_a2",
          attemptId: "run_a2_attempt",
          auditId: `disabled_audit_${unique}`,
        }),
      ).rejects.toBeDefined();
    } finally {
      await migrator.query(
        "UPDATE platform_control_operators SET status='active' WHERE user_id='user_admin'",
      );
    }
  });

  it("完整轨迹分页仅允许管理员，且每次读取先写独立审计", async () => {
    const store = new PgRunTrajectoryStore(control, {} as never, undefined);
    const auditId = `trajectory_audit_${unique}`;
    const auditCountBefore = (await auditRows()).length;
    await expect(
      store.readPage({
        actorUserId: "user_admin",
        auditId,
        tenantId: "tenant_a",
        runId: "run_a2",
        attemptId: "run_a2_attempt",
        limit: 50,
      }),
    ).resolves.toMatchObject({ records: [], bytes: 0, hasMore: false });
    expect(await auditRows()).toContainEqual({
      actor_user_id: "user_admin",
      tenant_id: "tenant_a",
      run_id: "run_a2",
      attempt_id: "run_a2_attempt",
    });

    await expect(
      store.readPage({
        actorUserId: "user_viewer",
        auditId: `trajectory_viewer_audit_${unique}`,
        tenantId: "tenant_a",
        runId: "run_a2",
        attemptId: "run_a2_attempt",
        limit: 50,
      }),
    ).rejects.toBeDefined();
    expect(await auditRows()).toHaveLength(auditCountBefore + 1);
  });

  it("真实 Runtime 写入的轨迹在受审计的 Tenant 事务内可由后台读取", async () => {
    const objects = new Map<string, S3PutObjectInput>();
    const storage: S3ObjectClient = {
      async put(input) {
        objects.set(input.key, input);
      },
      async head(key) {
        return objects.get(key)?.descriptor;
      },
      async get(key) {
        const object = objects.get(key);
        if (object === undefined) return undefined;
        return {
          contentLength: object.body.byteLength,
          body: (async function* () {
            yield object.body;
          })(),
        };
      },
      async copy({ sourceKey, destinationKey }) {
        const object = objects.get(sourceKey);
        if (object === undefined) throw new Error("缺少轨迹 staging 对象");
        objects.set(destinationKey, object);
      },
      async delete(key) {
        objects.delete(key);
      },
      async presignGet() {
        throw new Error("不允许为后台轨迹生成签名 URL");
      },
    };
    const repository = new PgBlobLifecycleRepository(runtime);
    const blobs = new S3BlobStore(storage, repository, {
      bucket: "test-trajectory",
      maxBlobSizeBytes: 1024 * 1024,
    });
    const writer = new PgRunTrajectoryStore(
      runtime,
      blobs,
      new DurableTraceBlobPersistenceAdapter(repository, blobs),
    );
    const reader = new PgRunTrajectoryStore(control, blobs, undefined);
    const context = {
      tenantId: "tenant_b",
      runId: "run_b1",
      attemptId: "run_b1_attempt",
      threadId: "thread_1",
    };
    const event = {
      schemaVersion: 1 as const,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      monotonicOffsetMs: 2,
      source: "runtime" as const,
      type: "session_created",
      event: { model: "test-model" },
    };
    await writer.persist({ context, event });
    const directoryWithoutAudit = await withTenantTransaction(
      control,
      {
        tenantId: context.tenantId,
        userId: "user_admin",
      },
      (client) => client.query("SELECT attempt_id FROM admin_run_trajectory_directory"),
    );
    expect(directoryWithoutAudit.rows).toEqual([]);
    const page = await reader.readPage({
      ...context,
      auditId: `trajectory_${unique}`,
      actorUserId: "user_admin",
      limit: 1,
    });
    expect(page.records).toEqual([
      { ...event, agentThreadId: "", agentTurnId: "", storedAt: event.occurredAt },
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("Agent 指标迁移可安全回退并重新应用", async () => {
    await administrator.query(
      `INSERT INTO "${schema}".thread_continuity_metric_observations(
         tenant_id,observation_id,thread_id,run_id,metric_name,value,unit
       ) VALUES('tenant_a','legacy-model-call:output','thread_1','run_a1','model_output_tokens',0,'tokens')`,
    );
    const migrations = await loadMigrations();
    const metricsMigration = migrations.find((migration) => migration.name === "agent_metrics");
    if (metricsMigration === undefined) throw new Error("Agent 指标迁移缺失");
    const migrationContract = await loadPostgreSqlMigrationContract();
    const previousVersion = metricsMigration.version - 1;
    await expect(
      migrateDown(migrator, {
        ...security,
        targetVersion: previousVersion,
        allowDestructive: true,
        environment: "test",
        runtimeRole: roles.runtimeRole,
      }),
    ).resolves.toHaveLength(previousVersion);
    expect(
      (await administrator.query(`SELECT to_regclass('"${schema}".run_feedback') AS table`)).rows[0]
        ?.table,
    ).toBeNull();
    expect(
      (
        await administrator.query(
          `SELECT to_regclass('"${schema}".admin_agent_metrics_hourly') AS view`,
        )
      ).rows[0]?.view,
    ).toBeNull();
    await expect(migrateUp(migrator, security)).resolves.toHaveLength(migrationContract.count);
    const backfilled = await administrator.query(
      `SELECT value,unit FROM "${schema}".thread_continuity_metric_observations
        WHERE tenant_id='tenant_a' AND observation_id='legacy-model-call:count'`,
    );
    expect(backfilled.rows).toEqual([{ value: 1, unit: "count" }]);
  });
});
