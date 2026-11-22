import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tenantId, userId } from "@hoox/domain";
import { expect, it } from "vitest";
import { WebhookDispatcher } from "../../runtime-ts/apps/scheduler/src/webhook-dispatcher.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import {
  enqueueRunStatusWebhook,
  PgWebhookOutboxStore,
  PgWebhookRepository,
} from "../../runtime-ts/packages/persistence/src/pg-webhooks.js";
import {
  verifyWebhookSignature,
  WebhookSecretCipher,
} from "../../runtime-ts/packages/persistence/src/webhook-crypto.js";

it("Webhook 保留数据卷升级：旧 Tenant 经角色预置与迁移后可完成签名投递", async () => {
  const bootstrap = process.env.DATABASE_BOOTSTRAP_URL;
  if (!bootstrap) throw new Error("缺少测试管理连接");
  const adminUrl = new URL(bootstrap);
  const suffix = randomBytes(6).toString("hex");
  const db = `it_demo_${suffix}`;
  const schema = "demo_schema";
  const role = (name: string) => `it_demo_${name}_${suffix}`;
  const legacy = {
    runtimeRole: role("runtime"),
    migratorRole: role("migrator"),
    skillPublisherRole: role("skill"),
    teamCoordinatorRole: role("team"),
    workerCoordinatorRole: role("worker"),
    adminControlRole: role("admin"),
  };
  const roles = { ...legacy, webhookDispatcherRole: role("webhook") };
  const cluster = createPostgresPool({ connectionString: bootstrap });
  const password = randomBytes(24).toString("hex");
  const pools: Pool[] = [];
  const scratch = await mkdtemp(join(tmpdir(), "hoox-demo-webhook-"));
  const pool = (login?: string) => {
    const url = new URL(adminUrl);
    url.pathname = `/${db}`;
    if (login) {
      url.username = login;
      url.password = password;
    }
    const result = createPostgresPool({ connectionString: url.href, schema });
    pools.push(result);
    return result;
  };
  let created = false;
  try {
    // 预置脚本会收紧数据库级 PUBLIC 授权，只在本用例新建的数据库中运行。
    await cluster.query(`CREATE DATABASE "${db}"`);
    created = true;
    const admin = pool();
    await admin.query(
      `REVOKE ALL ON DATABASE "${db}" FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM PUBLIC`,
    );
    for (const name of Object.values(legacy)) {
      await admin.query(
        `CREATE ROLE ${name} LOGIN NOINHERIT PASSWORD '${password}'; GRANT CONNECT ON DATABASE "${db}" TO ${name}`,
      );
    }
    await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${roles.migratorRole}`);
    const migrations = fileURLToPath(
      new URL("../../runtime-ts/packages/persistence/migrations/", import.meta.url),
    );
    const files = await readdir(migrations);
    const boundary = files.find((file) => file.endsWith("_webhooks.up.sql"))?.split("_")[0];
    if (!boundary) throw new Error("缺少 Webhook 迁移");
    for (const file of files.filter((file) => file.endsWith(".sql") && file.slice(0, 4) < boundary))
      await copyFile(join(migrations, file), join(scratch, file));
    const migrator = pool(roles.migratorRole);
    await migrateUp(migrator, { ...legacy, schema, directory: scratch });
    await admin.query(
      `INSERT INTO app_users(id,created_at) VALUES ('user_demo',now()); INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES ('tenant_demo','personal','user_demo',now())`,
    );
    await admin.query(
      `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
         VALUES ('tenant_demo','membership_demo','user_demo','owner','active',now());
       INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
         VALUES ('tenant_demo','thread_demo','user_demo','Demo','active',now(),now());
       INSERT INTO runs(tenant_id,id,thread_id,status,version,created_at,updated_at)
         VALUES ('tenant_demo','run_demo','thread_demo','running',1,now(),now())`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: adminUrl.hostname,
      PGPORT: adminUrl.port || "5432",
      PGPASSWORD: decodeURIComponent(adminUrl.password),
      POSTGRES_USER: decodeURIComponent(adminUrl.username),
      POSTGRES_DB: db,
      DATABASE_SCHEMA: schema,
    };
    for (const [key, value] of Object.entries(roles)) {
      const prefix = `DATABASE_${key
        .replace(/Role$/, "")
        .replace(/[A-Z]/g, (c) => `_${c}`)
        .toUpperCase()}`;
      env[`${prefix}_ROLE`] = value;
      env[`${prefix}_PASSWORD`] = password;
    }
    const script = fileURLToPath(new URL("../../deploy/demo/postgres-init.sh", import.meta.url));
    for (let i = 0; i < 2; i++) {
      if (spawnSync("sh", [script], { env, stdio: "ignore" }).status !== 0)
        throw new Error("保留数据卷的 PostgreSQL 角色预置失败");
    }
    await migrateUp(migrator, { ...roles, schema });
    expect((await admin.query("SELECT id,origin FROM runs")).rows).toEqual([
      { id: "run_demo", origin: "normal" },
    ]);
    const key = join(scratch, "tls.key");
    const cert = join(scratch, "tls.crt");
    if (
      spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=receiver.test",
          "-addext",
          "subjectAltName=DNS:receiver.test",
        ],
        { stdio: "ignore" },
      ).status !== 0
    )
      throw new Error("无法生成临时接收端证书");
    const ca = await readFile(cert);
    const cipher = new WebhookSecretCipher(randomBytes(32).toString("hex"));
    const secret = randomBytes(32).toString("hex");
    const verified: string[] = [];
    const server = createServer({ key: await readFile(key), cert: ca }, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const id = String(req.headers["x-hoox-event-id"]);
      const body = Buffer.concat(chunks);
      const valid = verifyWebhookSignature(
        secret,
        String(req.headers["x-hoox-timestamp"]),
        id,
        body,
        String(req.headers["x-hoox-signature"]),
      );
      if (valid) verified.push(JSON.parse(body.toString()).id);
      res.writeHead(valid ? 204 : 400).end();
    });
    await new Promise<void>((resolve, reject) =>
      server.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法分配接收端端口");
      const url = new URL(`https://receiver.test:${address.port}/event`);
      const scope = { tenantId: tenantId("tenant_demo"), userId: userId("user_demo") };
      const runtime = pool(roles.runtimeRole);
      await new PgWebhookRepository(runtime).create({
        scope,
        id: "wh_demo",
        name: "demo",
        endpointUrl: url.href,
        eventTypes: ["run.succeeded"],
        secret: cipher.encrypt(scope.tenantId, "wh_demo", secret),
      });
      await withTenantTransaction(runtime, scope, async (client) => {
        const transitioned = await client.query(
          `UPDATE runs SET status='succeeded',version=version+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND id=$2 AND status='running' AND version=1`,
          [scope.tenantId, "run_demo"],
        );
        expect(transitioned.rowCount).toBe(1);
        await enqueueRunStatusWebhook(client, {
          tenantId: scope.tenantId,
          runId: "run_demo",
          runVersion: 2,
          status: "succeeded",
          occurredAt: new Date().toISOString(),
        });
        await enqueueRunStatusWebhook(client, {
          tenantId: scope.tenantId,
          runId: "run_missing",
          runVersion: 2,
          status: "succeeded",
          occurredAt: new Date().toISOString(),
        });
      });
      expect(
        (await admin.query("SELECT source_run_id,source_run_origin,state FROM webhook_outbox"))
          .rows,
      ).toEqual([{ source_run_id: "run_demo", source_run_origin: "normal", state: "pending" }]);
      const dispatcher = new WebhookDispatcher({
        store: new PgWebhookOutboxStore(pool(roles.webhookDispatcherRole)),
        cipher,
        owner: "smoke",
        ca,
        resolveTarget: async (endpoint) => {
          if (endpoint !== url.href) throw new Error("投递地址与测试接收端不符");
          return {
            url,
            hostname: url.hostname,
            servername: url.hostname,
            hostHeader: url.host,
            address: "127.0.0.1",
            addresses: ["127.0.0.1"],
          };
        },
      });
      await dispatcher.pump();
      await dispatcher.close();
      expect(verified).toHaveLength(1);
      expect(
        (await admin.query("SELECT event_id,state,attempts FROM webhook_outbox")).rows,
      ).toEqual([{ event_id: verified[0], state: "delivered", attempts: 1 }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    try {
      await Promise.all(pools.map((p) => p.end()));
      if (created) {
        await cluster.query(`DROP DATABASE "${db}"`);
        for (const name of Object.values(roles)) await cluster.query(`DROP ROLE IF EXISTS ${name}`);
      }
    } finally {
      await cluster.end();
      await rm(scratch, { recursive: true, force: true });
    }
  }
});
