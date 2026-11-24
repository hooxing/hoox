import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapEvaluationRole,
  evaluationRoleName,
} from "../../runtime-ts/packages/persistence/src/evaluation-role.js";
import { withTransaction } from "../../runtime-ts/packages/persistence/src/postgres.js";
import { AdminControlService } from "../../runtime-ts/packages/admin-control/src/index.js";
import { migrateUp } from "../../runtime-ts/packages/persistence/src/migrations.js";
import { ModelProviderCredentialCipher } from "../../runtime-ts/packages/persistence/src/model-provider-credential.js";
import {
  PgAdminControlRepository,
  PgRuntimeControlConfigurationRepository,
} from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
import {
  createPostgresPool,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { bootstrapRuntimeAccess } from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`标题模型权限集成测试缺少 ${name}；不会输出配置值`);
  return value;
}

const bootstrapUrl = requiredEnvironment("DATABASE_BOOTSTRAP_URL");
const unique = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_title_acl_${unique}`;
const roles = {
  runtimeRole: `it_ttl_runtime_${unique}`,
  migratorRole: `it_ttl_migrator_${unique}`,
  skillPublisherRole: `it_ttl_publisher_${unique}`,
  workerCoordinatorRole: `it_ttl_worker_${unique}`,
  teamCoordinatorRole: `it_ttl_team_${unique}`,
  adminControlRole: `it_ttl_control_${unique}`,
};
const security = { ...roles, schema };
const passwords = new Map(
  Object.values(roles).map((role) => [role, randomBytes(24).toString("hex")]),
);
const cipher = new ModelProviderCredentialCipher(
  "integration-title-credential-root-at-least-32-bytes",
);
let administrator!: Pool;
let migrator!: Pool;
let runtime!: Pool;
let control!: Pool;
let created = false;
let nextSettingsRevision = 1;

function roleUrl(role: string): string {
  const url = new URL(bootstrapUrl);
  url.username = role;
  const password = passwords.get(role);
  if (password === undefined) throw new Error("测试数据库角色缺少凭据");
  url.password = password;
  return url.toString();
}

async function insertRevision(kind: string, key: string, revision: number, configuration: unknown) {
  const json = JSON.stringify(configuration);
  await migrator.query(
    `INSERT INTO admin_control_config_revisions(
       object_kind,object_key,revision,configuration,configuration_digest,created_by
     ) VALUES($1,$2,$3,$4::jsonb,$5,'title_acl_admin')`,
    [kind, key, revision, json, createHash("sha256").update(json).digest("hex")],
  );
}

async function activateTitle(revision: number | false | undefined) {
  const settingsRevision = nextSettingsRevision++;
  await insertRevision("runtime_settings", "global", settingsRevision, {
    workerMaxConcurrentRuns: 20,
    userMaxConcurrentRunsPerTenant: 2,
    compactionSoftLimitPercent: 80,
    compactionTargetPercent: 55,
    compactionRecentUserTokens: 4096,
    compactionMaxOutputTokens: 4096,
    compactionTimeoutMs: 60_000,
    ...(revision === undefined
      ? {}
      : {
          titleGeneration:
            revision === false
              ? { enabled: false }
              : {
                  enabled: true,
                  providerKey: "title-b",
                  providerRevision: revision,
                  modelId: "title",
                },
        }),
  });
  await migrator.query(
    `INSERT INTO admin_control_active_configs(object_kind,object_key,revision,generation,activated_by,reason)
     VALUES('runtime_settings','global',$1,$1,'title_acl_admin','权限测试')
     ON CONFLICT(object_kind) DO UPDATE SET revision=EXCLUDED.revision,generation=EXCLUDED.generation`,
    [settingsRevision],
  );
}

async function readableModels(): Promise<string[]> {
  const result = await runtime.query<{ key: string }>(
    "SELECT object_key||':'||revision::text AS key FROM admin_control_config_revisions WHERE object_kind='model_provider' ORDER BY object_key,revision",
  );
  return result.rows.map((row) => row.key);
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
  runtime = createPostgresPool({ connectionString: roleUrl(roles.runtimeRole), schema });
  control = createPostgresPool({ connectionString: roleUrl(roles.adminControlRole), schema });
  await withTransaction(administrator, (client) =>
    bootstrapEvaluationRole(client, roles.runtimeRole),
  );
  await migrateUp(migrator, security);
  await administrator.query(
    `INSERT INTO "${schema}".app_users(id,created_at) VALUES('title_acl_admin',clock_timestamp())`,
  );
  await migrator.query(
    "INSERT INTO platform_control_operators(user_id,role,status) VALUES('title_acl_admin','admin','active')",
  );
  for (const [key, revision] of [
    ["main-a", 1],
    ["title-b", 1],
    ["title-b", 2],
    ["unrelated-c", 1],
  ] as const) {
    await insertRevision("model_provider", key, revision, {
      providerKey: key,
      displayName: "权限测试模型",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.invalid/v1",
      credential: cipher.encrypt(key, "integration-test-key"),
      defaultModelId: "title",
      models: [
        {
          id: "title",
          name: "标题模型",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      ],
    });
  }
  await migrator.query(
    `INSERT INTO admin_control_active_configs(object_kind,object_key,revision,generation,activated_by,reason)
     VALUES('model_provider','main-a',1,1,'title_acl_admin','主模型保持独立')`,
  );
});

afterAll(async () => {
  await runtime?.end();
  await control?.end();
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

describe("真实 Runtime 角色的标题模型精确授权", () => {
  it("主模型 A 与独立标题 B 的旧修订可同时读取，无关模型和 B 新修订不可读", async () => {
    const identity = await runtime.query(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    expect(identity.rows).toEqual([
      { current_user: roles.runtimeRole, rolsuper: false, rolbypassrls: false },
    ]);
    await activateTitle(1);
    expect(await readableModels()).toEqual(["main-a:1", "title-b:1"]);
    const repository = new PgRuntimeControlConfigurationRepository(runtime, cipher);
    const resolved = await repository.resolveTitleModelConfiguration();
    expect(resolved?.modelId).toBe("title");
    expect(resolved?.baseUrl).toBe("https://model.example.invalid/v1");
    expect(resolved?.apiKey === "integration-test-key").toBe(true);
    const owner = await administrator.query(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
      [`${schema}.runtime_title_model_reference`],
    );
    expect(owner.rows).toEqual([{ owner: roles.migratorRole }]);
    const privileges = await runtime.query(
      `SELECT has_table_privilege(current_user,'runtime_title_model_reference','INSERT') AS can_insert,
              has_table_privilege(current_user,'runtime_title_model_reference','UPDATE') AS can_update,
              has_table_privilege(current_user,'runtime_title_model_reference','DELETE') AS can_delete`,
    );
    expect(privileges.rows).toEqual([{ can_insert: false, can_update: false, can_delete: false }]);
    await expect(runtime.query("DELETE FROM runtime_title_model_reference")).rejects.toBeDefined();
    await expect(
      runtime.query(
        "UPDATE admin_control_active_configs SET revision=2 WHERE object_kind='runtime_settings'",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("切换标题引用立即撤销旧修订，重复 ACL bootstrap 不扩大授权", async () => {
    await activateTitle(2);
    await bootstrapRuntimeAccess(migrator, security);
    expect(await readableModels()).toEqual(["main-a:1", "title-b:2"]);
    const reference = await runtime.query("SELECT * FROM runtime_title_model_reference");
    expect(reference.rows).toEqual([{ provider_key: "title-b", provider_revision: "2" }]);
  });

  it("显式关闭或取消后台接管后不能沿历史设置读取标题凭据", async () => {
    await activateTitle(false);
    expect(await readableModels()).toEqual(["main-a:1"]);
    expect(
      await new PgRuntimeControlConfigurationRepository(
        runtime,
        cipher,
      ).resolveTitleModelConfiguration(),
    ).toBeNull();
    await activateTitle(undefined);
    expect(await readableModels()).toEqual(["main-a:1"]);
    expect(
      await new PgRuntimeControlConfigurationRepository(
        runtime,
        cipher,
      ).resolveTitleModelConfiguration(),
    ).toBeUndefined();
    expect((await runtime.query("SELECT * FROM runtime_title_model_reference")).rows).toEqual([]);
  });

  it("数据库形状约束允许合法标题和压缩开关，拒绝缺字段、空值及夹带密钥", async () => {
    const settings = {
      workerMaxConcurrentRuns: 19,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60_000,
    };
    const title = {
      enabled: true,
      providerKey: "title-b",
      providerRevision: 1,
      modelId: "title",
    };
    let revision = 100;
    for (const addition of [
      { titleGeneration: { enabled: false }, compactionEnabled: false },
      { titleGeneration: title, compactionEnabled: true },
      { compactionEnabled: false },
    ]) {
      await expect(
        insertRevision("runtime_settings", "global", revision++, {
          ...settings,
          ...addition,
        }),
      ).resolves.toBeUndefined();
    }
    for (const addition of [
      { titleGeneration: null },
      { titleGeneration: { enabled: true } },
      { titleGeneration: { ...title, providerRevision: -1 } },
      { titleGeneration: { ...title, apiKey: "forbidden-placeholder" } },
      { titleGeneration: { enabled: false, apiKey: "forbidden-placeholder" } },
      { compactionEnabled: null },
      { compactionEnabled: "false" },
    ]) {
      await expect(
        insertRevision("runtime_settings", "global", revision++, {
          ...settings,
          ...addition,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(await readableModels()).toEqual(["main-a:1"]);
  });

  it("真实管理角色通过服务保存标题设置后，Runtime 仅获得所选修订", async () => {
    const repository = new PgAdminControlRepository(control, cipher);
    const service = new AdminControlService(
      repository,
      repository,
      { probeModel: async () => undefined, probeMemory: async () => undefined },
      [],
    );
    const saved = await service.saveRuntimeSettingsConfiguration(
      {
        actorUserId: "title_acl_admin",
        idempotencyKey: "title-model-service-save",
        requestDigest: "a".repeat(64),
      },
      {
        expectedGeneration: await repository.generation("title_acl_admin"),
        workerMaxConcurrentRuns: 18,
        userMaxConcurrentRunsPerTenant: 2,
        compactionSoftLimitPercent: 80,
        compactionTargetPercent: 55,
        compactionRecentUserTokens: 4096,
        compactionMaxOutputTokens: 4096,
        compactionTimeoutMs: 60_000,
        compactionEnabled: true,
        titleGeneration: {
          enabled: true,
          providerKey: "title-b",
          providerRevision: 1,
          modelId: "title",
        },
      },
    );
    expect(saved.status).toBe("active");
    expect(saved.configuration.titleGeneration).toEqual({
      enabled: true,
      providerKey: "title-b",
      providerRevision: 1,
      modelId: "title",
    });
    expect(await readableModels()).toEqual(["main-a:1", "title-b:1"]);
  });
});
