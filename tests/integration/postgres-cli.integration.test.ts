import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAdminControlApiApp,
  type AdminControlApiDependencies,
} from "../../runtime-ts/apps/admin-control-api/src/app.js";
import { createAdminSessionAuthResolver } from "../../runtime-ts/apps/admin-control-api/src/session-auth.js";
import { createAdminAccessTokenAuthResolver } from "../../runtime-ts/apps/admin-control-api/src/session-auth.js";
import { runCli } from "../../runtime-ts/packages/cli/src/cli.js";
import { createProductionJwtAuthResolver } from "../../runtime-ts/packages/identity/src/production-jwt-auth.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  bootstrapEvaluationRole,
  evaluationRoleName,
} from "../../runtime-ts/packages/persistence/src/evaluation-role.js";
import { PgAgentDefinitionRepository } from "../../runtime-ts/packages/persistence/src/pg-agent-definition.js";
import { PgAdminAccessTokenRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-access-tokens.js";
import {
  createPostgresPool,
  withTransaction,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { bootstrapRuntimeAccess } from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";
import { serializeAgentConfiguration } from "../../runtime-ts/packages/protocol/src/agent-configuration.js";

const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL;
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_cli_${suffix}`;
const roles = {
  runtimeRole: `it_cli_rt_${suffix}`,
  migratorRole: `it_cli_mg_${suffix}`,
  skillPublisherRole: `it_cli_sp_${suffix}`,
  workerCoordinatorRole: `it_cli_wc_${suffix}`,
  teamCoordinatorRole: `it_cli_tc_${suffix}`,
  adminControlRole: `it_cli_ac_${suffix}`,
};
const security = { schema, ...roles };
const passwords = new Map(
  Object.values(roles).map((role) => [role, randomBytes(24).toString("hex")]),
);
const createdRoles: string[] = [];
const signingKey = randomBytes(32);
const issuer = "https://issuer.example.invalid/control";
const audience = "hoox-admin-control-api";
let administrator: Pool;
let migrator: Pool;
let control: Pool;
let repository: PgAgentDefinitionRepository;
let accessTokens: PgAdminAccessTokenRepository;
let app: ReturnType<typeof createAdminControlApiApp>;
let origin: string;
let directory: string;
let source: string;
let yaml: string;

function rolePool(role: string): Pool {
  const password = passwords.get(role);
  if (!bootstrapUrl || !password) throw new Error("CLI 测试数据库配置缺失");
  const url = new URL(bootstrapUrl);
  url.username = role;
  url.password = password;
  return createPostgresPool({ connectionString: url.toString(), schema });
}

function credential(actor = "cli_admin", overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT", kid: "cli-test-key" })}.${encode({ iss: issuer, aud: audience, sub: actor, iat: now - 60, nbf: now - 60, exp: now + 300, ...overrides })}`;
  return `${unsigned}.${createHmac("sha256", signingKey).update(unsigned).digest("base64url")}`;
}

async function cli(args: string[], token = credential()) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli([...args, "--json"], {
    env: { HOOX_URL: origin, HOOX_TOKEN: token },
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      errors.push(text);
    },
  });
  expect(errors).toEqual([]);
  expect(output.join("").includes(token)).toBe(false);
  return { code, data: JSON.parse(output.join("")) as Record<string, unknown> };
}

async function cliWithToken(args: string[], token: string) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli([...args, "--json"], {
    env: { HOOX_URL: origin, HOOX_TOKEN: token },
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
  });
  expect(errors).toEqual([]);
  expect(output.join("").includes(token)).toBe(false);
  return { code, data: JSON.parse(output.join("")) as Record<string, unknown> };
}

async function fetchWithContext(
  label: string,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw new Error(`请求失败：${label}`, { cause: error });
  }
}

describe("PostgreSQL hoox CLI 与既有后台 JWT", () => {
  beforeAll(async () => {
    if (!bootstrapUrl) throw new Error("CLI PostgreSQL 测试缺少 DATABASE_BOOTSTRAP_URL");
    administrator = createPostgresPool({ connectionString: bootstrapUrl });
    for (const role of Object.values(roles)) {
      await administrator.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${passwords.get(role)}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      createdRoles.push(role);
    }
    await withTransaction(administrator, (client) =>
      bootstrapEvaluationRole(client, roles.runtimeRole),
    );
    createdRoles.push(evaluationRoleName(roles.runtimeRole));
    const database = new URL(bootstrapUrl).pathname.slice(1).replaceAll('"', '""');
    await administrator.query(
      `GRANT CONNECT ON DATABASE "${database}" TO ${createdRoles.map((role) => `"${role}"`).join(",")}`,
    );
    await administrator.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${roles.migratorRole}"`);
    migrator = rolePool(roles.migratorRole);
    control = rolePool(roles.adminControlRole);
    await migrateUp(migrator, security);
    await bootstrapRuntimeAccess(migrator, security);
    for (const [actor, role, status] of [
      ["cli_admin", "admin", "active"],
      ["cli_viewer", "viewer", "active"],
      ["cli_disabled", "admin", "disabled"],
    ]) {
      await administrator.query(
        `INSERT INTO "${schema}".app_users(id,created_at) VALUES ($1,now())`,
        [actor],
      );
      await migrator.query(
        "INSERT INTO platform_control_operators(user_id,role,status) VALUES ($1,$2,$3)",
        [actor, role, status],
      );
    }
    repository = new PgAgentDefinitionRepository(control);
    accessTokens = new PgAdminAccessTokenRepository(control);
    const initial = await repository.readAdminRevision(
      "cli_admin",
      "agent_default",
      "agent_default_revision_1",
    );
    if (!initial) throw new Error("CLI 测试缺少默认 Agent Revision");
    yaml = serializeAgentConfiguration({
      schemaVersion: 1,
      definition: { id: "agent_cli_roundtrip", availability: { mode: "all_tenants" } },
      revision: {
        content: { ...initial.content, displayName: "CLI 往返测试" },
        versionNotes: "占位测试配置",
      },
    });
    directory = await mkdtemp(join(tmpdir(), "hoox-cli-postgres-"));
    source = join(directory, "agent.yaml");
    await writeFile(source, yaml);
    app = createAdminControlApiApp({
      agents: repository,
      auth: createAdminAccessTokenAuthResolver(
        accessTokens,
        createAdminSessionAuthResolver(
          "http://127.0.0.1:1",
          createProductionJwtAuthResolver({
            issuer,
            audience,
            keys: [{ kid: "cli-test-key", secret: signingKey }],
            clockSkewSeconds: 1,
            maxTokenLifetimeSeconds: 3600,
          }),
        ),
      ),
      accessTokens,
      controlAccess: {
        async resolveRole(actor) {
          const role = await administrator.query<{ role: string; status: string }>(
            `SELECT role,status FROM "${schema}".platform_control_operators WHERE user_id=$1`,
            [actor],
          );
          return role.rows[0]?.status === "active" ? role.rows[0].role : undefined;
        },
      },
      control: {} as AdminControlApiDependencies["control"],
      identity: {} as AdminControlApiDependencies["identity"],
      modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
      skills: {} as AdminControlApiDependencies["skills"],
      readiness: { async probe() {} },
    });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    await Promise.all([control?.end(), migrator?.end()]);
    if (administrator) {
      await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      for (const role of createdRoles.reverse())
        await administrator.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
      await administrator.end();
    }
  });

  it("真实 JWT push → pull 草稿字节一致，默认只导出发布版本，导入导出均以调用者审计", async () => {
    expect((await cli(["validate", source, "--remote"])).code).toBe(0);
    const pushed = await cli(["push", source]);
    expect(pushed.code).toBe(0);
    expect(pushed.data).toMatchObject({ definitionId: "agent_cli_roundtrip", status: "draft" });
    const revisionId = String(pushed.data.revisionId);
    expect((await cli(["pull", "agent_cli_roundtrip"])).code).toBe(2);
    const output = join(directory, "exported.yaml");
    expect(
      (await cli(["pull", "agent_cli_roundtrip", "--revision", revisionId, "-o", output])).code,
    ).toBe(0);
    expect(await readFile(output, "utf8")).toBe(yaml);
    const audit = await administrator.query<{ action: string; actor_user_id: string }>(
      `SELECT action,actor_user_id FROM "${schema}".agent_definition_audits WHERE definition_id=$1 ORDER BY audit_id`,
      ["agent_cli_roundtrip"],
    );
    expect(audit.rows).toEqual([
      { action: "imported", actor_user_id: "cli_admin" },
      { action: "exported", actor_user_id: "cli_admin" },
    ]);
    await repository.publish({
      actorUserId: "cli_admin",
      definitionId: "agent_cli_roundtrip",
      revisionId,
      expectedGeneration: 0,
      idempotencyKey: "cli-publish-placeholder",
    });
    const pulled = await cli(["pull", "agent_cli_roundtrip"]);
    expect(pulled.code).toBe(0);
    expect(pulled.data.yaml).toBe(yaml);
    const appended = await cli([
      "push",
      source,
      "--definition",
      "agent_cli_roundtrip",
      "--expected-generation",
      "1",
    ]);
    expect(appended.code).toBe(0);
    expect(appended.data.revisionId).not.toBe(revisionId);
    expect(
      (await repository.listRevisions("cli_admin", "agent_cli_roundtrip"))?.definition
        .currentRevisionId,
    ).toBe(revisionId);
  });

  it("重试在服务端提交后丢失响应，仍只创建一个草稿并写一次导入审计", async () => {
    const retrySource = join(directory, "retry.yaml");
    await writeFile(retrySource, yaml.replaceAll("agent_cli_roundtrip", "agent_cli_retry"));
    const output: string[] = [];
    let lost = false;
    const code = await runCli(["push", retrySource, "--json"], {
      env: { HOOX_URL: origin, HOOX_TOKEN: credential() },
      stdout: (text) => {
        output.push(text);
      },
      stderr: () => {
        throw new Error("不应写入 stderr");
      },
      sleep: async () => undefined,
      fetcher: async (url, init) => {
        const response = await fetch(url, init);
        if (!lost) {
          lost = true;
          await response.text();
          throw new Error("测试故障：已提交响应丢失");
        }
        return response;
      },
    });
    expect(code).toBe(0);
    const history = await repository.listRevisions("cli_admin", "agent_cli_retry");
    expect(history?.items).toHaveLength(1);
    const count = await administrator.query<{ count: string }>(
      `SELECT count(*)::text FROM "${schema}".agent_definition_audits WHERE definition_id=$1 AND action='imported'`,
      ["agent_cli_retry"],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("错误 audience、过期 JWT 和公开 API Key 不能用作后台凭据", async () => {
    for (const token of [
      credential("cli_admin", { aud: "hoox-api" }),
      credential("cli_admin", { exp: Math.floor(Date.now() / 1000) - 30 }),
      "hoox_key_placeholder_not_for_admin",
    ]) {
      expect((await cli(["validate", source, "--remote"], token)).code).toBe(3);
    }
  });

  it("既有后台授权实时复核：viewer 不可写，禁用和失去角色的创建者不可读写", async () => {
    expect((await cli(["push", source, "--dry-run"], credential("cli_viewer"))).code).toBe(3);
    expect((await cli(["push", source, "--dry-run"], credential("cli_disabled"))).code).toBe(3);
    const token = credential();
    await migrator.query(
      "UPDATE platform_control_operators SET status='disabled' WHERE user_id='cli_admin'",
    );
    try {
      expect((await cli(["push", source, "--dry-run"], token)).code).toBe(3);
      expect((await cli(["pull", "agent_cli_roundtrip"], token)).code).toBe(3);
    } finally {
      await migrator.query(
        "UPDATE platform_control_operators SET status='active' WHERE user_id='cli_admin'",
      );
    }
  });

  it("访问令牌仅返回一次、哈希存储，并以 CLI push → pull 字节往返", async () => {
    const response = await fetchWithContext(
      "创建访问令牌",
      `${origin}/v1/admin/control/access-tokens`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential()}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "CI 配置占位令牌",
          scopes: ["agent-config:read", "agent-config:write"],
        }),
      },
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      data: { token: string; accessToken: { id: string; expiresAt: string } };
    };
    const token = created.data.token;
    expect(token).toMatch(/^hoox_at_[A-Za-z0-9_-]{43}$/u);
    const expiration = Date.parse(created.data.accessToken.expiresAt);
    expect(expiration).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(expiration).toBeLessThan(Date.now() + 91 * 86_400_000);
    const stored = await administrator.query<{ token_hash: Buffer; token_salt: Buffer }>(
      `SELECT token_hash,token_salt FROM "${schema}".admin_access_tokens WHERE id=$1`,
      [created.data.accessToken.id],
    );
    expect(stored.rows[0]?.token_hash.equals(Buffer.from(token))).toBe(false);
    expect(stored.rows[0]?.token_salt.byteLength).toBe(16);
    const listed = await fetchWithContext(
      "列出访问令牌",
      `${origin}/v1/admin/control/access-tokens`,
      { headers: { authorization: `Bearer ${credential()}` } },
    );
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(token);

    const tokenSource = join(directory, "access-token-agent.yaml");
    const tokenYaml = yaml.replaceAll("agent_cli_roundtrip", "agent_access_token_roundtrip");
    await writeFile(tokenSource, tokenYaml);
    const pushed = await cliWithToken(["push", tokenSource], token);
    expect(pushed.code).toBe(0);
    const output = join(directory, "access-token-export.yaml");
    const pulled = await cliWithToken(
      [
        "pull",
        "agent_access_token_roundtrip",
        "--revision",
        String(pushed.data.revisionId),
        "-o",
        output,
      ],
      token,
    );
    expect(pulled.code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(tokenYaml);
    const audits = await administrator.query<{ result: string; route: string }>(
      `SELECT result,route FROM "${schema}".admin_access_token_audits WHERE token_id=$1 ORDER BY audit_id`,
      [created.data.accessToken.id],
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows.every((row) => row.result === "allowed")).toBe(true);
    expect(
      audits.rows.some((row) =>
        row.route.startsWith("POST /v1/admin/control/agent-definitions/import"),
      ),
    ).toBe(true);
    expect(audits.rows.some((row) => row.route.includes("/export"))).toBe(true);
    const usage = await control.query<{ last_used_at: Date; last_use_audited_at: Date }>(
      "SELECT last_used_at,last_use_audited_at FROM admin_access_tokens WHERE id=$1",
      [created.data.accessToken.id],
    );
    expect(usage.rows[0]?.last_used_at).toBeInstanceOf(Date);

    let revoke: Response;
    try {
      revoke = await fetch(
        `${origin}/v1/admin/control/access-tokens/${created.data.accessToken.id}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${credential()}` },
        },
      );
    } catch (error) {
      throw new Error("撤销访问令牌请求失败", { cause: error });
    }
    expect(revoke.status).toBe(200);
    expect((await cliWithToken(["pull", "agent_access_token_roundtrip"], token)).code).toBe(3);
  });

  it("只读令牌不能 push，不能访问其他后台接口，创建者失权后立即拒绝", async () => {
    const created = await accessTokens.create("cli_admin", {
      name: "CI 只读令牌",
      scopes: ["agent-config:read"],
    });
    const source = join(directory, "readonly-agent.yaml");
    await writeFile(source, yaml.replaceAll("agent_cli_roundtrip", "agent_readonly_denied"));
    expect((await cliWithToken(["validate", source, "--remote"], created.token)).code).toBe(0);
    expect((await cliWithToken(["pull", "agent_default"], created.token)).code).toBe(0);
    expect((await cliWithToken(["push", source], created.token)).code).toBe(3);
    const denied = await fetch(`${origin}/v1/admin/control/access`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(denied.status).toBe(403);

    await migrator.query(
      "UPDATE platform_control_operators SET status='disabled' WHERE user_id='cli_admin'",
    );
    const lost = await fetch(`${origin}/v1/admin/control/agent-definitions`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(lost.status).toBe(403);
    await migrator.query(
      "UPDATE platform_control_operators SET status='active' WHERE user_id='cli_admin'",
    );
    const records = await administrator.query<{ result: string }>(
      `SELECT result FROM "${schema}".admin_access_token_audits WHERE token_id=$1 ORDER BY audit_id`,
      [created.accessToken.id],
    );
    expect(records.rows).toHaveLength(6);
    expect(records.rows.filter((row) => row.result === "allowed")).toHaveLength(3);
    expect(records.rows.filter((row) => row.result === "denied")).toHaveLength(3);
  });

  it("过期令牌被拒绝，并节流 last-used 更新但逐请求审计", async () => {
    const active = await accessTokens.create("cli_admin", {
      name: "CI 使用时间令牌",
      scopes: ["agent-config:read"],
    });
    const listUrl = `${origin}/v1/admin/control/agent-definitions/agent_default/revisions/agent_default_revision_1/export`;
    const headers = { authorization: `Bearer ${active.token}` };
    expect((await fetch(listUrl, { headers })).status).toBe(200);
    const first = await control.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM admin_access_tokens WHERE id=$1",
      [active.accessToken.id],
    );
    expect((await fetch(listUrl, { headers })).status).toBe(200);
    const second = await control.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM admin_access_tokens WHERE id=$1",
      [active.accessToken.id],
    );
    expect(second.rows[0]?.last_used_at).toEqual(first.rows[0]?.last_used_at);
    const expired = await accessTokens.create("cli_admin", {
      name: "CI 过期令牌",
      scopes: ["agent-config:read"],
    });
    await administrator.query(
      `UPDATE "${schema}".admin_access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`,
      [expired.accessToken.id],
    );
    expect(
      (await fetch(listUrl, { headers: { authorization: `Bearer ${expired.token}` } })).status,
    ).toBe(401);
    const audits = await administrator.query<{ result: string }>(
      `SELECT result FROM "${schema}".admin_access_token_audits WHERE token_id=$1 ORDER BY audit_id`,
      [active.accessToken.id],
    );
    expect(audits.rows.map((row) => row.result)).toEqual(["allowed", "allowed"]);
    const expiredAudits = await administrator.query<{ result: string }>(
      `SELECT result FROM "${schema}".admin_access_token_audits WHERE token_id=$1`,
      [expired.accessToken.id],
    );
    expect(expiredAudits.rows).toEqual([{ result: "denied" }]);
  });
});
