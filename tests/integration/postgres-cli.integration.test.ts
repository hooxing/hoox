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
import { AdminControlService } from "../../runtime-ts/packages/admin-control/src/index.js";
import { runCli } from "../../runtime-ts/packages/cli/src/cli.js";
import { createProductionJwtAuthResolver } from "../../runtime-ts/packages/identity/src/production-jwt-auth.js";
import { migrateDown, migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  bootstrapEvaluationRole,
  evaluationRoleName,
} from "../../runtime-ts/packages/persistence/src/evaluation-role.js";
import { PgAgentDefinitionRepository } from "../../runtime-ts/packages/persistence/src/pg-agent-definition.js";
import { PgAdminAccessTokenRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-access-tokens.js";
import { PgAdminControlRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
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
let controlRepository: PgAdminControlRepository;
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
      ["cli_admin2", "admin", "active"],
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
    for (const actor of ["cli_admin", "cli_admin2"]) {
      const tenant = `tenant_${actor}`;
      await administrator.query(
        `INSERT INTO "${schema}".tenants(id,kind,owner_user_id,display_name,created_by_user_id,created_at)
         VALUES($1,'personal',$2,NULL,NULL,now())`,
        [tenant, actor],
      );
      await administrator.query(
        `INSERT INTO "${schema}".user_accounts(
           user_id,personal_tenant_id,email,normalized_email,display_name,
           password_algorithm,password_salt,password_hash,created_at,updated_at
         ) VALUES($1,$2,$3,$3,$4,'scrypt-v1',decode(repeat('11',16),'hex'),
                  decode(repeat('22',32),'hex'),now(),now())`,
        [actor, tenant, `${actor}@example.invalid`, `${actor} 管理员`],
      );
    }
    repository = new PgAgentDefinitionRepository(control);
    accessTokens = new PgAdminAccessTokenRepository(control);
    controlRepository = new PgAdminControlRepository(control, {} as never);
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
      evaluations: {
        async listSuites() {
          return [];
        },
      } as never,
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
      controlAccess: controlRepository,
      control: new AdminControlService(controlRepository, {} as never, {} as never, []),
      identity: {} as AdminControlApiDependencies["identity"],
      modelCatalog: {} as AdminControlApiDependencies["modelCatalog"],
      skills: {} as AdminControlApiDependencies["skills"],
      readiness: { async probe() {} },
    });
    app.get("/v1/admin/control/agent-definitions/:definitionId/future-read-route", async () => ({
      ok: true,
    }));
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
    expect(audits.rows.every((row) => row.result === "scope_allowed")).toBe(true);
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
    const encodedEvaluation = await fetch(
      `${origin}/v1/admin/control/agent-definitions/agent_default/%65valuations`,
      { headers: { authorization: `Bearer ${created.token}` } },
    );
    expect(encodedEvaluation.status).toBe(403);
    const futureRoute = await fetch(
      `${origin}/v1/admin/control/agent-definitions/agent_default/future-read-route`,
      { headers: { authorization: `Bearer ${created.token}` } },
    );
    expect(futureRoute.status).toBe(403);
    const evaluationsPrefixSource = join(directory, "evaluations-prefix-agent.yaml");
    const evaluationsPrefixYaml = yaml.replaceAll(
      "agent_cli_roundtrip",
      "evaluations_prefix_agent",
    );
    await writeFile(evaluationsPrefixSource, evaluationsPrefixYaml);
    const evaluationsPrefixPush = await cli(["push", evaluationsPrefixSource]);
    expect(evaluationsPrefixPush.code).toBe(0);
    const evaluationsPrefixRevision = String(evaluationsPrefixPush.data.revisionId);
    const evaluationsPrefixOutput = join(directory, "evaluations-prefix-export.yaml");
    expect(
      (
        await cliWithToken(
          [
            "pull",
            "evaluations_prefix_agent",
            "--revision",
            evaluationsPrefixRevision,
            "-o",
            evaluationsPrefixOutput,
          ],
          created.token,
        )
      ).code,
    ).toBe(0);
    expect(await readFile(evaluationsPrefixOutput, "utf8")).toBe(evaluationsPrefixYaml);
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
    expect(records.rows).toHaveLength(9);
    expect(records.rows.filter((row) => row.result === "scope_allowed")).toHaveLength(4);
    expect(records.rows.filter((row) => row.result === "scope_denied")).toHaveLength(5);
  });

  it("令牌认证对路由变体默认拒绝", async () => {
    const created = await accessTokens.create("cli_admin", {
      name: "CI 路由变体令牌",
      scopes: ["agent-config:read"],
    });
    const base = "/v1/admin/control/agent-definitions";
    const headers = { authorization: `Bearer ${created.token}` };
    for (const path of [
      `${base}/`,
      base.replace("agent-definitions", "Agent-definitions"),
      `${base}//`,
    ]) {
      const response = await fetch(`${origin}${path}`, { headers });
      expect(response.status, path).not.toBe(200);
    }
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await fetch(`${origin}${base}`, { method, headers });
      expect(response.status, method).not.toBe(200);
    }
  });

  it("真实停用用户入口撤销其令牌并立即使账号身份失效", async () => {
    const token = await accessTokens.create("cli_admin", {
      name: "CI 停用用户令牌",
      scopes: ["agent-config:read"],
    });
    const disabled = await fetch(`${origin}/v1/admin/control/users/cli_admin/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential("cli_admin2")}`,
        "content-type": "application/json",
        "idempotency-key": "disable-cli-admin-token-001",
      },
      body: JSON.stringify({ status: "disabled", reason: "访问令牌停用回归测试" }),
    });
    expect(disabled.status).toBe(200);
    expect(await controlRepository.resolveRole("cli_admin")).toBeUndefined();
    const stored = await administrator.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "${schema}".admin_access_tokens WHERE id=$1`,
      [token.accessToken.id],
    );
    expect(stored.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(
      (
        await fetch(`${origin}/v1/admin/control/agent-definitions`, {
          headers: { authorization: `Bearer ${token.token}` },
        })
      ).status,
    ).toBe(401);
    const reenabled = await fetch(`${origin}/v1/admin/control/users/cli_admin/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential("cli_admin2")}`,
        "content-type": "application/json",
        "idempotency-key": "reenable-cli-admin-token-001",
      },
      body: JSON.stringify({ status: "active", reason: "恢复后续隔离集成测试" }),
    });
    expect(reenabled.status).toBe(200);
    expect(await controlRepository.resolveRole("cli_admin")).toBe("admin");
  });

  it("审计明确表示作用域通过，不把领域授权拒绝记作请求获准", async () => {
    const token = await accessTokens.create("cli_viewer", {
      name: "CI 查看作用域令牌",
      scopes: ["agent-config:read"],
    });
    const response = await fetch(
      `${origin}/v1/admin/control/agent-definitions/agent_default/revisions/agent_default_revision_1/export`,
      { headers: { authorization: `Bearer ${token.token}` } },
    );
    expect(response.status).toBe(401);
    const audit = await administrator.query<{ result: string }>(
      `SELECT result FROM "${schema}".admin_access_token_audits WHERE token_id=$1`,
      [token.accessToken.id],
    );
    expect(audit.rows).toEqual([{ result: "scope_allowed" }]);
  });

  it("并发创建受创建者与全局配额限制，列表最多返回配置数量", async () => {
    const baseline = await administrator.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${schema}".admin_access_tokens
        WHERE revoked_at IS NULL AND expires_at>now()`,
    );
    const quotaRepository = new PgAdminAccessTokenRepository(control, undefined, {
      perCreator: 2,
      global: Number(baseline.rows[0]?.count ?? 0) + 3,
      listLimit: 2,
    });
    const create = (creator: string, index: number) =>
      quotaRepository.create(creator, {
        name: `配额测试 ${creator} ${index}`,
        scopes: ["agent-config:read"],
      });
    const concurrent = await Promise.allSettled([
      create("quota_creator", 1),
      create("quota_creator", 2),
      create("quota_creator", 3),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    await create("quota_other_creator", 1);
    await expect(create("quota_global_limit", 1)).rejects.toThrow(
      "ADMIN_ACCESS_TOKEN_QUOTA_EXCEEDED",
    );
    expect((await quotaRepository.list()).items).toHaveLength(2);
  });

  it("超过单页的有效令牌可遍历并逐一撤销", async () => {
    const seeded = await administrator.query<{ id: string }>(
      `INSERT INTO "${schema}".admin_access_tokens
         (id,name,scopes,created_by,token_prefix,token_salt,token_hash,created_at,expires_at)
       SELECT gen_random_uuid(),'分页覆盖 ' || item,
              ARRAY['agent-config:read']::text[],'cli_admin2',
              substr(md5(random()::text),1,16),decode(repeat('11',16),'hex'),
              decode(repeat('22',32),'hex'),now()-item*interval '1 millisecond',
              now()+interval '90 days'
         FROM generate_series(1,205) item
       RETURNING id`,
    );
    const ids = new Set(seeded.rows.map((row) => row.id));
    const headers = { authorization: `Bearer ${credential("cli_admin")}` };
    const found = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ status: "active", limit: "200" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await fetch(`${origin}/v1/admin/control/access-tokens?${query}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const envelope = (await response.json()) as {
        readonly data: {
          readonly items: readonly { id: string; name: string }[];
          readonly nextCursor: string | null;
        };
      };
      for (const token of envelope.data.items) {
        if (ids.has(token.id)) found.add(token.id);
      }
      cursor = envelope.data.nextCursor;
    } while (cursor !== null);
    expect(found).toEqual(ids);
    const results: Response[] = [];
    for (const id of ids) {
      const response = await fetch(`${origin}/v1/admin/control/access-tokens/${id}`, {
        method: "DELETE",
        headers,
      });
      results.push(response);
    }
    expect(results.every((response) => response.status === 200)).toBe(true);
  });

  it("大量历史记录不会隐藏较早的有效令牌，状态筛选可访问历史页", async () => {
    const oldActive = await accessTokens.create("old_history_user", {
      name: "历史记录中的有效令牌",
      scopes: ["agent-config:read"],
    });
    await administrator.query(
      `UPDATE "${schema}".admin_access_tokens SET created_at=now()-interval '2 years' WHERE id=$1`,
      [oldActive.accessToken.id],
    );
    await administrator.query(
      `INSERT INTO "${schema}".admin_access_tokens
         (id,name,scopes,created_by,token_prefix,token_salt,token_hash,created_at,expires_at,revoked_at)
       SELECT gen_random_uuid(),'历史撤销 ' || item,ARRAY['agent-config:read']::text[],
              'cli_admin2',substr(md5(random()::text),1,16),decode(repeat('11',16),'hex'),
              decode(repeat('22',32),'hex'),now()-item*interval '1 millisecond',
              now()+interval '90 days',now()
         FROM generate_series(1,205) item`,
    );
    const active = await accessTokens.list();
    let cursor = active.nextCursor;
    const activeIds = new Set(active.items.map((token) => token.id));
    while (cursor !== null) {
      const page = await accessTokens.list({ cursor });
      for (const token of page.items) activeIds.add(token.id);
      cursor = page.nextCursor;
    }
    expect(activeIds.has(oldActive.accessToken.id)).toBe(true);
    const revoked = await accessTokens.list({ status: "revoked" });
    expect(revoked.items).toHaveLength(200);
    expect(revoked.nextCursor).not.toBeNull();
  });

  it("0038 迁移通过正式入口执行 up、down、up", async () => {
    const applied = await migrateUp(migrator, security);
    const migration = applied.find(
      (record) => record.name === "admin_access_token_scope_and_account_policy",
    );
    expect(migration).toBeDefined();
    if (!migration) throw new Error("缺少后台访问令牌账户策略迁移");
    const down = await migrateDown(migrator, {
      ...security,
      targetVersion: migration.version - 1,
      allowDestructive: true,
      environment: "test",
    });
    expect(down.some((record) => record.version === migration.version)).toBe(false);
    expect(
      (
        await administrator.query(
          `SELECT 1 FROM pg_policies WHERE schemaname=$1 AND policyname='user_accounts_admin_control_read_policy'`,
          [schema],
        )
      ).rowCount,
    ).toBe(0);
    const replayed = await migrateUp(migrator, security);
    expect(replayed.find((record) => record.version === migration.version)?.checksum).toBe(
      migration.checksum,
    );
    expect(
      (
        await administrator.query(
          `SELECT 1 FROM pg_policies WHERE schemaname=$1 AND policyname='user_accounts_admin_control_read_policy'`,
          [schema],
        )
      ).rowCount,
    ).toBe(1);
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
    expect(audits.rows.map((row) => row.result)).toEqual(["scope_allowed", "scope_allowed"]);
    const expiredAudits = await administrator.query<{ result: string }>(
      `SELECT result FROM "${schema}".admin_access_token_audits WHERE token_id=$1`,
      [expired.accessToken.id],
    );
    expect(expiredAudits.rows).toEqual([{ result: "credential_rejected" }]);
  });
});
