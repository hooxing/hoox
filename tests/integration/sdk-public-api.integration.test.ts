import { randomBytes, randomUUID } from "node:crypto";
import {
  apiKeyScope,
  createPersonalTenant,
  createUser,
  isoTimestamp,
  membershipId,
  runId,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@hoox/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "../../runtime-ts/apps/api/src/app.js";
import { createApiCreateCapability } from "../../runtime-ts/apps/api/src/capabilities.js";
import { createThreadCursorCodec } from "../../runtime-ts/apps/api/src/cursor.js";
import { createApiKeyToken, hashApiKey } from "../../runtime-ts/packages/identity/src/api-key.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  bootstrapEvaluationRole,
  evaluationRoleName,
} from "../../runtime-ts/packages/persistence/src/evaluation-role.js";
import { PgApiKeyRepository } from "../../runtime-ts/packages/persistence/src/pg-api-keys.js";
import { PgClientToolResults } from "../../runtime-ts/packages/persistence/src/pg-client-tool-calls.js";
import {
  PgArchiveThreadCommand,
  PgCoreRepositories,
  PgRenamePersonalThreadCommand,
} from "../../runtime-ts/packages/persistence/src/pg-core-repositories.js";
import { PgRunDispatchCreation } from "../../runtime-ts/packages/persistence/src/pg-run-dispatch.js";
import { PgThreadCreation } from "../../runtime-ts/packages/persistence/src/pg-thread-creation.js";
import {
  createPostgresPool,
  type Pool,
  withTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { PgRunExperienceReadRepository } from "../../runtime-ts/packages/persistence/src/runtime.js";
import { ClientTools, HooxClient } from "../../runtime-ts/packages/sdk/src/index.js";

const suffix = `${process.pid}_${randomBytes(5).toString("hex")}`;
const schema = `it_sdk_${suffix}`;
const roles = {
  runtimeRole: `it_sdk_rt_${suffix}`,
  migratorRole: `it_sdk_mg_${suffix}`,
  skillPublisherRole: `it_sdk_sp_${suffix}`,
  workerCoordinatorRole: `it_sdk_wc_${suffix}`,
  teamCoordinatorRole: `it_sdk_tc_${suffix}`,
  adminControlRole: `it_sdk_ac_${suffix}`,
};
const createdRoles: string[] = [];
const pools: Pool[] = [];
let admin: Pool;
let runtime: Pool;
let schemaCreated = false;
let app: ReturnType<typeof createApiApp> | undefined;
let origin: string;
let apiKey: string;

beforeAll(async () => {
  const bootstrap = process.env.DATABASE_BOOTSTRAP_URL;
  if (!bootstrap) throw new Error("SDK 集成测试需要 DATABASE_BOOTSTRAP_URL，且必须使用隔离数据库");
  const base = new URL(bootstrap);
  const database = base.pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/u.test(database)) throw new Error("测试数据库名称无效");
  admin = createPostgresPool({ connectionString: bootstrap, schema, maxConnections: 2 });
  for (const role of Object.values(roles)) {
    const password = randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    createdRoles.push(role);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    const url = new URL(bootstrap);
    url.username = role;
    url.password = password;
    const pool = createPostgresPool({ connectionString: url.href, schema, maxConnections: 4 });
    pools.push(pool);
  }
  await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${roles.migratorRole}"`);
  schemaCreated = true;
  const migrator = pools[1];
  if (!migrator || !pools[0]) throw new Error("隔离数据库角色未初始化");
  runtime = pools[0];
  await withTransaction(admin, (client) => bootstrapEvaluationRole(client, roles.runtimeRole));
  await migrateUp(migrator, { ...roles, schema });
  const repositories = new PgCoreRepositories(runtime);
  const now = isoTimestamp(new Date().toISOString());
  const owner = createUser(userId(`sdk_owner_${suffix}`), now);
  const personal = createPersonalTenant({
    id: tenantId(`sdk_tenant_${suffix}`),
    ownerMembershipId: membershipId(`sdk_member_${suffix}`),
    owner,
    createdAt: now,
  });
  await repositories.tenants.createPersonal({
    user: owner,
    tenant: personal.tenant,
    membership: personal.ownerMembership,
  });
  const token = createApiKeyToken();
  apiKey = token;
  await new PgApiKeyRepository(admin).create({
    scope: { tenantId: personal.tenant.id, userId: owner.id },
    createdBy: owner.id,
    keyHash: hashApiKey(token),
    prefix: token.slice(0, 12),
    name: "SDK 集成测试",
    scopes: [
      "threads:read",
      "threads:create",
      "runs:read",
      "runs:create",
      "tool-results:submit",
      "end-users:represent",
    ].map(apiKeyScope),
    now,
  });
  app = createApiApp(
    {
      auth: { resolve: async () => undefined },
      repositories,
      apiKeys: new PgApiKeyRepository(runtime),
      clientToolResults: new PgClientToolResults(runtime),
      experience: new PgRunExperienceReadRepository(runtime),
      createCapability: createApiCreateCapability({
        threadCreation: new PgThreadCreation(runtime),
        enqueueOutbox: new PgRunDispatchCreation(runtime),
      }),
      archiveThread: new PgArchiveThreadCommand(runtime),
      renamePersonalThread: new PgRenamePersonalThreadCommand(runtime),
      cursorCodec: createThreadCursorCodec({
        activeKid: "sdk-test",
        keys: [{ kid: "sdk-test", secret: randomBytes(32).toString("base64url") }],
        clock: { now: () => isoTimestamp(new Date().toISOString()) },
        ttlMilliseconds: 60_000,
        maximumTtlMilliseconds: 60_000,
      }),
      readiness: {
        probe: async () => {
          await runtime.query("SELECT 1");
        },
      },
      clock: { now: () => isoTimestamp(new Date().toISOString()) },
      ids: {
        thread: () => threadId(`thread_${randomUUID()}`),
        run: () => runId(`run_${randomUUID()}`),
        workspace: () => workspaceId(`workspace_${randomUUID()}`),
      },
    },
    { logger: false },
  );
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await Promise.all(pools.map((pool) => pool.end()));
  if (!admin) return;
  if (!schema.startsWith(`it_sdk_${process.pid}_`)) throw new Error("拒绝清理非本测试的资源");
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS "${evaluationRoleName(roles.runtimeRole)}"`);
  for (const role of createdRoles.reverse()) {
    await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
  }
  await admin.end();
});

// 只控制 Worker 的持久事件输入；HTTP 鉴权、终端用户映射、SSE 与工具结果提交均走真实实现。
async function waitingRun(
  thread: { id: string; tenantId: string },
  run: { id: string },
  count: number,
) {
  const attempt = `attempt_${randomUUID()}`;
  const callId = `call_${randomUUID()}`;
  const action = {
    threadId: thread.id,
    runId: run.id,
    callId,
    toolName: "lookup",
    arguments: { city: "上海" },
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  await admin.query("UPDATE runs SET status='waiting' WHERE tenant_id=$1 AND id=$2", [
    thread.tenantId,
    run.id,
  ]);
  await admin.query(
    `INSERT INTO execution_attempts(tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,status,stage,model_execution_started,finished_at)
    SELECT tenant_id,$3,run_id,thread_id,workspace_id,root_run_id,'waiting','model_execution_started',true,clock_timestamp() FROM run_execution_inputs WHERE tenant_id=$1 AND run_id=$2`,
    [thread.tenantId, run.id, attempt],
  );
  await admin.query(
    "INSERT INTO effect_invocations(tenant_id,attempt_id,call_id,tool_name) VALUES($1,$2,$3,'lookup')",
    [thread.tenantId, attempt, callId],
  );
  await admin.query(
    `INSERT INTO client_tool_calls(tenant_id,run_id,thread_id,attempt_id,call_id,tool_name,arguments,deadline) VALUES($1,$2,$3,$4,$5,'lookup',$6,$7)`,
    [thread.tenantId, run.id, thread.id, attempt, callId, action.arguments, action.deadline],
  );
  for (let sequence = 0; sequence <= count; sequence += 1) {
    await admin.query(
      "INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload) VALUES($1,$2,$3,1,$4,$5)",
      [
        thread.tenantId,
        attempt,
        sequence,
        sequence === count ? "run_waiting" : "agent_event",
        sequence === count ? action : { type: "message.delta", text: "消息" },
      ],
    );
  }
  return { attempt, callId };
}

describe("SDK 与本地公开 API / PostgreSQL", () => {
  it.each([false, true])(
    "创建 Thread → 流式 Run → 工具回传 → 完成（断线=%s）",
    async (disconnect) => {
      let interrupted = false;
      const cursors: (string | null)[] = [];
      let run: { id: string };
      let thread: { id: string; tenantId: string };
      let attempt: string;
      const fetcher: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/tool-results") && response.ok) {
          const result = await admin.query(
            "SELECT outcome,response_text FROM client_tool_calls WHERE tenant_id=$1 AND run_id=$2",
            [thread.tenantId, run.id],
          );
          expect(result.rows).toEqual([{ outcome: "succeeded", response_text: "上海：晴" }]);
          await admin.query("UPDATE runs SET status='succeeded' WHERE tenant_id=$1 AND id=$2", [
            thread.tenantId,
            run.id,
          ]);
          await admin.query(
            "INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload) VALUES($1,$2,36,1,'agent_event',$3)",
            [thread.tenantId, attempt, { type: "message.completed", text: "完成" }],
          );
        }
        if (!String(input).includes("/events/stream")) return response;
        cursors.push(new Headers(init?.headers).get("Last-Event-ID"));
        if (!disconnect || interrupted || !response.body) return response;
        interrupted = true;
        const reader = response.body.getReader();
        let text = "";
        const decoder = new TextDecoder();
        while (!text.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        await reader.cancel();
        return new Response(text.slice(0, text.indexOf("\n\n") + 2), { headers: response.headers });
      };
      const client = new HooxClient({
        baseUrl: origin,
        apiKey,
        endUser: "Customer:SDK",
        fetch: fetcher,
      });
      thread = await client.createThread(
        { title: "SDK 流式对话" },
        { idempotencyKey: `thread-${randomUUID()}` },
      );
      run = await client.createRun(
        thread.id,
        { input: "查询上海天气" },
        { idempotencyKey: `run-${randomUUID()}` },
      );
      const fixture = await waitingRun(thread, run, disconnect ? 35 : 0);
      attempt = fixture.attempt;
      let executions = 0;
      const tools = new ClientTools().register("lookup", (args) => {
        expect(args).toEqual({ city: "上海" });
        executions += 1;
        return "上海：晴";
      });
      const ids: string[] = [];
      for await (const event of tools.stream(client, thread.id, run.id, {
        retry: { initialDelayMs: 1, maxDelayMs: 5 },
        signal: AbortSignal.timeout(15_000),
      })) {
        if (event.event === "run-events")
          ids.push(...event.data.page.items.map((item) => item.eventId));
      }
      expect(executions).toBe(1);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(disconnect ? 37 : 2);
      if (disconnect) expect(cursors).toContain(`${attempt}-31`);
      expect((await client.getRun(thread.id, run.id)).status).toBe("succeeded");
      const other = new HooxClient({ baseUrl: origin, apiKey, endUser: "Customer:Other" });
      await expect(other.getThread(thread.id)).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
    },
  );
});
