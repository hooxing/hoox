import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExplorerService } from "../../runtime-ts/packages/admin-control/src/index.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { PgAdminRunExplorerRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-run-explorer.js";
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
      `INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES
         ('tenant_a','personal','user_owner_a',now()),('tenant_b','personal','user_owner_b',now())`,
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
         VALUES('tenant_a','run_a2_attempt',$1,1,$2,$3::jsonb,
           '2026-11-19T01:00:02Z'::timestamptz + ($1::int * interval '1 second'))`,
        [sequence, kind, JSON.stringify(payload)],
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
  await migrateUp(migrator, security);
  await seed();
});

afterAll(async () => {
  await control?.end();
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
      origin: null,
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
