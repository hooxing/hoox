import { isoTimestamp } from "@hoox/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalAccountAuthService } from "../../runtime-ts/apps/api/src/local-account-auth.js";
import { PgLocalAccountRepository } from "../../runtime-ts/packages/persistence/src/pg-local-account.js";
import { PgInstallationRepository } from "../../runtime-ts/packages/persistence/src/pg-installation.js";
import {
  createPostgresPool,
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

// 此用例消耗一次性安装状态，只允许由专用的空预览数据库显式启用。
describe.skipIf(process.env.HOOX_INSTALLATION_TEST_ISOLATED !== "true")(
  "真实 PostgreSQL 首次管理员初始化",
  () => {
    let pool: Pool;
    let installation: PgInstallationRepository;
    let administratorId: string;
    let session: Awaited<ReturnType<ReturnType<typeof createLocalAccountAuthService>["register"]>>;
    const now = isoTimestamp("2026-11-15T08:00:00.000Z");
    beforeAll(() => {
      const url = process.env.DATABASE_URL!;
      if (!new URL(url).pathname.startsWith("/hoox_setup_"))
        throw new Error("安装测试仅允许 hoox_setup_ 专用空数据库");
      pool = createPostgresPool({
        connectionString: url,
        schema: process.env.DATABASE_SCHEMA!,
        applicationName: "hoox-installation-integration",
      });
      installation = new PgInstallationRepository(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("迁移后由运维新增的禁用管理员也关闭首次安装", async () => {
      const migrator = createPostgresPool({
        connectionString: process.env.DATABASE_BOOTSTRAP_URL!,
        schema: process.env.DATABASE_SCHEMA!,
        applicationName: "hoox-installation-legacy-test",
      });
      try {
        await migrator.query(
          "INSERT INTO app_users(id,created_at) VALUES('legacy_admin',clock_timestamp())",
        );
        await migrator.query(
          "INSERT INTO platform_control_operators(user_id,role,status) VALUES('legacy_admin','admin','disabled')",
        );
        expect(await installation.initialized()).toBe(true);
        const service = createLocalAccountAuthService({
          repository: new PgLocalAccountRepository(pool),
          clock: { now: () => now },
          initialAdministrator: true,
        });
        await expect(
          service.register({
            displayName: "竞争安装",
            email: "legacy-race@example.invalid",
            password: "installation-test-password",
          }),
        ).rejects.toMatchObject({ kind: "conflict" });
      } finally {
        await migrator.query("DELETE FROM platform_control_operators WHERE user_id='legacy_admin'");
        await migrator.query("DELETE FROM app_users WHERE id='legacy_admin'");
        await migrator.end();
      }
      expect(await installation.initialized()).toBe(false);
    });

    it("并发初始化只创建一个管理员、账号、租户和会话，失败事务没有残留", async () => {
      expect(await installation.initialized()).toBe(false);
      const service = createLocalAccountAuthService({
        repository: new PgLocalAccountRepository(pool),
        clock: { now: () => now },
        initialAdministrator: true,
      });
      const results = await Promise.allSettled([
        service.register({
          displayName: "管理员甲",
          email: "first@example.invalid",
          password: "installation-test-password",
        }),
        service.register({
          displayName: "管理员乙",
          email: "second@example.invalid",
          password: "installation-test-password",
        }),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      expect(successful.length).toBe(1);
      expect(results.filter((result) => result.status === "rejected").length).toBe(1);
      session = (successful[0] as PromiseFulfilledResult<typeof session>).value;
      administratorId = session.profile.id;
      expect(await installation.initialized()).toBe(true);
      expect(await installation.isAdministrator(administratorId)).toBe(true);
      const principal = await service.resolve({
        authorization: `Bearer ${session.accessToken}`,
        requestId: "installation-test",
      });
      expect(principal?.userId).toBe(administratorId);
      const login = await service.login({
        email: session.profile.email,
        password: "installation-test-password",
      });
      expect(login.profile.id).toBe(administratorId);
      await expect(
        service.register({
          displayName: "管理员丙",
          email: "third@example.invalid",
          password: "installation-test-password",
        }),
      ).rejects.toMatchObject({ kind: "conflict" });
    });

    it("同邮箱 Better Auth 注册不能接管本地管理员", async () => {
      const result = await new PgLocalAccountRepository(pool).exchangeBetterAuthIdentity({
        userId: "user_attacker",
        personalTenantId: "tenant_attacker",
        membershipId: "membership_attacker",
        email: session.profile.email,
        displayName: "冒名账号",
        betterAuthUserId: "better_auth_attacker",
        createdAt: now,
        sessionExpiresAt: "2026-12-15T08:00:00.000Z",
        sessionTokenDigest: "a".repeat(64),
      });
      expect(result).toBe("conflict");
      expect(await installation.canAccessControl(administratorId)).toBe(true);
    });

    it("既有 viewer、operator 与 Skill 管理身份保留权限入口，禁用后拒绝", async () => {
      const migrator = createPostgresPool({
        connectionString: process.env.DATABASE_BOOTSTRAP_URL!,
        schema: process.env.DATABASE_SCHEMA!,
        applicationName: "hoox-installation-role-test",
      });
      try {
        for (const role of ["viewer", "operator"]) {
          const id = `existing_${role}`;
          await migrator.query(
            "INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())",
            [id],
          );
          await migrator.query(
            "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,$2,'active')",
            [id, role],
          );
          expect(await installation.canAccessControl(id)).toBe(true);
          expect(await installation.isAdministrator(id)).toBe(false);
          await migrator.query(
            "UPDATE platform_control_operators SET status='disabled' WHERE user_id=$1",
            [id],
          );
          expect(await installation.canAccessControl(id)).toBe(false);
        }
        const skill = await migrator.query(
          "SELECT role,status FROM platform_skill_operators WHERE user_id=$1",
          [administratorId],
        );
        expect(skill.rows).toEqual([{ role: "admin", status: "active" }]);
      } finally {
        await migrator.end();
      }
    });

    it("Runtime 不能重置安装状态、删除状态或将其他用户提权", async () => {
      await expect(pool.query("DELETE FROM installation_state")).rejects.toMatchObject({
        code: "42501",
      });
      const reset = await pool.query(
        "UPDATE installation_state SET administrator_user_id=NULL,initialized_at=NULL WHERE singleton=true",
      );
      expect(reset.rowCount).toBe(0);
      await expect(
        withTenantTransaction(
          pool,
          { tenantId: "tenant_attacker", userId: "user_attacker" },
          async (client) => {
            await client.query(
              "INSERT INTO platform_control_operators(user_id,role,status) VALUES('user_attacker','admin','active')",
            );
          },
        ),
      ).rejects.toBeDefined();
      expect(await installation.initialized()).toBe(true);
      expect(await installation.isAdministrator("user_attacker")).toBe(false);
      expect(await installation.isAdministrator(administratorId)).toBe(true);
    });
  },
);
