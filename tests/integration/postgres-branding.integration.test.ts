import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BRANDING } from "../../runtime-ts/packages/protocol/src/branding.js";
import {
  migrateUp,
  migrateDown,
  loadMigrations,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  PgBrandingRepository,
  PgPublicBrandingRepository,
} from "../../runtime-ts/packages/persistence/src/pg-branding.js";
import {
  createPostgresPool,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";
import { bootstrapRuntimeAccess } from "../../runtime-ts/packages/persistence/src/role-bootstrap.js";

const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL;
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const schema = `it_brand_${suffix}`;
const roles = {
  runtimeRole: `it_brand_rt_${suffix}`,
  migratorRole: `it_brand_mg_${suffix}`,
  skillPublisherRole: `it_brand_sp_${suffix}`,
  workerCoordinatorRole: `it_brand_wc_${suffix}`,
  teamCoordinatorRole: `it_brand_tc_${suffix}`,
  adminControlRole: `it_brand_ac_${suffix}`,
};
const security = { schema, ...roles };
const passwords = new Map(
  Object.values(roles).map((role) => [role, randomBytes(24).toString("hex")]),
);
let administrator: Pool;
let migrator: Pool;
let runtime: Pool;
let control: Pool;
const createdRoles: string[] = [];

function rolePool(role: string): Pool {
  const url = new URL(bootstrapUrl!);
  url.username = role;
  url.password = passwords.get(role)!;
  return createPostgresPool({ connectionString: url.toString(), schema });
}
describe("PostgreSQL 平台品牌", () => {
  beforeAll(async () => {
    if (!bootstrapUrl) throw new Error("品牌 PostgreSQL 测试缺少 DATABASE_BOOTSTRAP_URL");
    administrator = createPostgresPool({ connectionString: bootstrapUrl });
    for (const role of Object.values(roles)) {
      await administrator.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${passwords.get(role)}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      createdRoles.push(role);
    }
    const database = new URL(bootstrapUrl).pathname.slice(1).replaceAll('"', '""');
    await administrator.query(
      `GRANT CONNECT ON DATABASE "${database}" TO ${createdRoles.map((role) => `"${role}"`).join(",")}`,
    );
    await administrator.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${roles.migratorRole}"`);
    migrator = rolePool(roles.migratorRole);
    runtime = rolePool(roles.runtimeRole);
    control = rolePool(roles.adminControlRole);
    await migrateUp(migrator, security);
    await bootstrapRuntimeAccess(migrator, security);
    for (const [id, role, status] of [
      ["brand_admin", "admin", "active"],
      ["brand_operator", "operator", "active"],
      ["brand_viewer", "viewer", "active"],
      ["brand_disabled", "admin", "disabled"],
    ]) {
      await administrator.query(
        `INSERT INTO "${schema}".app_users(id,created_at) VALUES ($1,now())`,
        [id],
      );
      await migrator.query(
        "INSERT INTO platform_control_operators(user_id,role,status) VALUES ($1,$2,$3)",
        [id, role, status],
      );
    }
  });
  afterAll(async () => {
    await Promise.all([runtime?.end(), control?.end(), migrator?.end()]);
    if (administrator) {
      await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      for (const role of createdRoles.reverse())
        await administrator.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
      await administrator.end();
    }
  });
  it("公开视图只包含白名单，无内部元数据；Runtime 没有底表与审计 ACL", async () => {
    expect(await new PgPublicBrandingRepository(runtime).read()).toEqual(DEFAULT_BRANDING);
    const projection = await runtime.query("SELECT * FROM public_branding");
    expect(Object.keys(projection.rows[0]!)).toEqual(["configuration"]);
    expect(Object.keys(projection.rows[0]!.configuration).sort()).toEqual(
      Object.keys(DEFAULT_BRANDING).sort(),
    );
    await expect(runtime.query("SELECT * FROM platform_branding")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(runtime.query("SELECT * FROM platform_branding_audits")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(runtime.query("UPDATE public_branding SET configuration='{}'")).rejects.toThrow();
  });
  it("只有有效平台管理员可修改，非管理员和禁用管理员无法读写管理设置", async () => {
    const repository = new PgBrandingRepository(control);
    for (const actor of ["brand_operator", "brand_viewer", "brand_disabled", "brand_missing"]) {
      await expect(repository.read(actor)).rejects.toMatchObject({ kind: "forbidden" });
      await expect(
        repository.save(actor, {
          requestId: `denied_${actor}`,
          expectedGeneration: 0,
          configuration: DEFAULT_BRANDING,
        }),
      ).rejects.toMatchObject({ kind: "forbidden" });
    }
    expect((await repository.read("brand_admin")).generation).toBe(0);
  });
  it("保存与审计原子、幂等重试不重复写审计、并发更新拒绝覆盖", async () => {
    const repository = new PgBrandingRepository(control);
    const input = {
      requestId: "branding_save_1",
      expectedGeneration: 0,
      configuration: {
        ...DEFAULT_BRANDING,
        productName: "定制平台",
        primaryColor: "#ffff00",
        hiddenModules: ["team_spaces" as const],
        footerLinks: [{ text: "支持", url: "https://example.invalid/help" }],
      },
    };
    expect((await repository.save("brand_admin", input)).generation).toBe(1);
    expect((await repository.save("brand_admin", input)).generation).toBe(1);
    await expect(
      repository.save("brand_admin", { ...input, configuration: DEFAULT_BRANDING }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      repository.save("brand_admin", { ...input, requestId: "branding_stale" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(await new PgPublicBrandingRepository(runtime).read()).toEqual(input.configuration);
    const audit = await migrator.query(
      "SELECT actor_user_id,generation FROM platform_branding_audits",
    );
    expect(audit.rows).toEqual([{ actor_user_id: "brand_admin", generation: 1 }]);
    await migrator.query(
      "ALTER TABLE platform_branding_audits ADD CONSTRAINT test_audit_failure CHECK (generation < 2)",
    );
    await expect(
      repository.save("brand_admin", {
        ...input,
        expectedGeneration: 1,
        requestId: "branding_audit_fail",
      }),
    ).rejects.toThrow();
    expect((await repository.read("brand_admin")).generation).toBe(1);
    await migrator.query("ALTER TABLE platform_branding_audits DROP CONSTRAINT test_audit_failure");
    const concurrent = await Promise.allSettled(
      ["branding_race_a", "branding_race_b"].map((requestId) =>
        repository.save("brand_admin", { ...input, expectedGeneration: 1, requestId }),
      ),
    );
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("迁移可 down/up，重建后默认值不变且重新收敛权限", async () => {
    const migrations = await loadMigrations();
    const position = migrations.findIndex((migration) => migration.name === "platform_branding");
    expect(position).toBeGreaterThan(0);
    await migrateDown(migrator, {
      ...security,
      targetVersion: migrations[position - 1]!.version,
      allowDestructive: true,
      environment: "test",
    });
    expect(
      (await migrator.query("SELECT to_regclass('public_branding') AS relation")).rows[0]!.relation,
    ).toBeNull();
    await migrateUp(migrator, security);
    await bootstrapRuntimeAccess(migrator, security);
    expect(await new PgPublicBrandingRepository(runtime).read()).toEqual(DEFAULT_BRANDING);
  });
});
