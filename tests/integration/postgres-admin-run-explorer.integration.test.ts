import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExplorerService } from "../../runtime-ts/packages/admin-control/src/index.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  artifactWebhookPayload,
  enqueueRunStatusWebhook,
  enqueueWebhookEvent,
} from "../../runtime-ts/packages/persistence/src/pg-webhooks.js";
import { PgAdminRunExplorerRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-run-explorer.js";
import { PgIntegrationAdminRepository } from "../../runtime-ts/packages/persistence/src/pg-integration-admin.js";
import {
  createPostgresPool,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

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
  await migrateUp(migrator, security);
  await seed();
});

afterAll(async () => {
  await control?.end();
  await runtime?.end();
  await migrator?.end();
  if (created) {
    await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const role of Object.values(roles)) {
      await administrator.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  }
  await administrator?.end();
});

function service(auditIds: string[] = []) {
  let next = 0;
  return new RunExplorerService(new PgAdminRunExplorerRepository(control), () => {
    const id = `run_content_audit_${unique}_${next++}`;
    auditIds.push(id);
    return id;
  });
}

async function auditRows() {
  const result = await administrator.query(
    `SELECT actor_user_id,tenant_id,run_id,attempt_id FROM "${schema}".admin_run_content_access_audits
      ORDER BY created_at`,
  );
  return result.rows;
}

describe("真实 Admin Control 角色的 Run 浏览器边界", () => {
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
    expect(content.auditId).toBe(auditIds[0]);
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
      await client.query("SELECT set_config('app.run_content_audit_id',$1,true)", [auditIds[0]]);
      expect((await client.query("SELECT * FROM admin_run_event_content")).rows).toEqual([]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
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
});
