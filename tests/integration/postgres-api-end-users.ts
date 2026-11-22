import {
  createRun,
  createThread,
  createWorkspace,
  isoTimestamp,
  runId,
  threadId,
  workspaceId,
  type Tenant,
  type User,
} from "@hoox/domain";
import type { CoreRepositories, TenantScope } from "@hoox/persistence/postgres";
import { afterEach, describe, expect, it } from "vitest";
import { PgApiKeyRepository } from "../../runtime-ts/packages/persistence/src/pg-api-keys.js";
import { PgIntegrationAdminRepository } from "../../runtime-ts/packages/persistence/src/pg-integration-admin.js";
import { PgAdminControlRepository } from "../../runtime-ts/packages/persistence/src/pg-admin-control.js";
import { ModelProviderCredentialCipher } from "../../runtime-ts/packages/persistence/src/model-provider-credential.js";
import { PgLocalAccountRepository } from "../../runtime-ts/packages/persistence/src/pg-local-account.js";
import {
  withTenantTransaction,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

export function apiEndUserTests(
  context: () => {
    administrativePool: Pool;
    schema: string;
    runtimePool: Pool;
    migratorPool: Pool;
    adminControlPool: Pool;
    repositories: CoreRepositories;
    createFixture(suffix: string): Promise<{ scope: TenantScope; user: User; tenant: Tenant }>;
  },
) {
  describe("PostgreSQL API 终端用户映射", () => {
    const fixtureActors = new Set<string>();
    afterEach(async () => {
      if (fixtureActors.size === 0) return;
      await context().migratorPool.query(
        "DELETE FROM integration_admin_audits WHERE actor_user_id=ANY($1::text[])",
        [[...fixtureActors]],
      );
      fixtureActors.clear();
    });
    async function fixture(suffix: string) {
      const deps = context();
      const owner = await deps.createFixture(`end_user_${suffix}`);
      fixtureActors.add(owner.user.id);
      await deps.migratorPool.query(
        "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
        [owner.user.id],
      );
      const integrations = new PgIntegrationAdminRepository(deps.adminControlPool);
      const created = await integrations.createKey(owner.user.id, owner.tenant.id, {
        name: "终端用户映射",
        scopes: ["threads:read", "end-users:represent"],
      });
      const apiKeys = new PgApiKeyRepository(deps.runtimePool);
      const now = new Date().toISOString();
      const principal = await apiKeys.authenticateKey({ token: created.token, now });
      if (principal === undefined) throw new Error("集成身份未认证");
      return { ...deps, owner, integrations, created, apiKeys, now, principal };
    }

    it("空间级映射跨 Key 稳定，并发幂等且不同空间隔离", async () => {
      const env = await fixture("idempotent");
      const { principal, now } = env;
      try {
        const mapped = await Promise.all(
          Array.from({ length: 8 }, () =>
            env.apiKeys.mapEndUser({ principal, externalId: "Customer:42", now }),
          ),
        );
        expect(
          new Set(mapped.map((item) => (typeof item === "object" ? item.userId : item))).size,
        ).toBe(1);
        const first = mapped[0];
        if (typeof first !== "object") throw new Error("未创建映射");
        expect(await env.apiKeys.mapEndUser({ principal, externalId: "Customer:42", now })).toEqual(
          first,
        );
        const lower = await env.apiKeys.mapEndUser({ principal, externalId: "customer:42", now });
        expect(lower).not.toEqual(first);
        const rotated = await env.integrations.rotateKey(
          env.owner.user.id,
          env.owner.tenant.id,
          env.created.key.id,
        );
        const rotatedPrincipal = await env.apiKeys.authenticateKey({ token: rotated.token, now });
        if (rotatedPrincipal === undefined) throw new Error("轮换后认证失败");
        expect(
          await env.apiKeys.mapEndUser({
            principal: rotatedPrincipal,
            externalId: "Customer:42",
            now,
          }),
        ).toEqual(first);
        const secondCreator = await env.createFixture("end_user_second_creator");
        fixtureActors.add(secondCreator.user.id);
        await env.migratorPool.query(
          "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
          [secondCreator.user.id],
        );
        const second = await env.integrations.createKey(
          secondCreator.user.id,
          env.owner.tenant.id,
          {
            name: "空间内另一个 Key",
            scopes: ["threads:read", "end-users:represent"],
          },
        );
        try {
          const secondPrincipal = await env.apiKeys.authenticateKey({ token: second.token, now });
          if (secondPrincipal === undefined) throw new Error("第二个集成身份未认证");
          expect(
            await env.apiKeys.mapEndUser({
              principal: secondPrincipal,
              externalId: "Customer:42",
              now,
            }),
          ).toEqual(first);
        } finally {
          await withTenantTransaction(env.migratorPool, env.owner.scope, (client) =>
            client.query("UPDATE api_keys SET scopes=ARRAY['threads:read'] WHERE id=$1", [
              second.key.id,
            ]),
          );
        }
        const duplicates = await env.migratorPool.query(
          "SELECT count(*)::int AS total FROM api_end_users WHERE integration_tenant_id=$1 AND external_id='Customer:42'",
          [env.owner.tenant.id],
        );
        expect(duplicates.rows[0]?.total).toBe(1);
        await expect(
          env.migratorPool.query(
            `INSERT INTO api_end_users(integration_tenant_id,created_by_api_key_id,created_by_integration_user_id,external_id,user_id,personal_tenant_id,created_at)
           SELECT integration_tenant_id,created_by_api_key_id,created_by_integration_user_id,external_id,user_id,personal_tenant_id,created_at FROM api_end_users WHERE user_id=$1`,
            [first.userId],
          ),
        ).rejects.toMatchObject({ code: "23505" });
        for (const invalidId of ["", "bad id", "a".repeat(129), "a\n"]) {
          await expect(
            env.migratorPool.query(
              `INSERT INTO api_end_users(integration_tenant_id,created_by_api_key_id,created_by_integration_user_id,external_id,user_id,personal_tenant_id,created_at)
             SELECT integration_tenant_id,created_by_api_key_id,created_by_integration_user_id,$2,user_id,personal_tenant_id,created_at FROM api_end_users WHERE user_id=$1`,
              [first.userId, invalidId],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        }
        expect(
          await new PgLocalAccountRepository(env.runtimePool).findProfileByUserId(
            first.userId,
            first.tenantId,
          ),
        ).toBeUndefined();
        const otherOwner = await env.createFixture("end_user_other_space");
        fixtureActors.add(otherOwner.user.id);
        await env.migratorPool.query(
          "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'admin','active')",
          [otherOwner.user.id],
        );
        const otherKey = await env.integrations.createKey(
          otherOwner.user.id,
          otherOwner.tenant.id,
          { name: "另一空间 Key", scopes: ["threads:read", "end-users:represent"] },
        );
        try {
          const otherPrincipal = await env.apiKeys.authenticateKey({ token: otherKey.token, now });
          if (otherPrincipal === undefined) throw new Error("另一空间 Key 未认证");
          const isolated = await env.apiKeys.mapEndUser({
            principal: otherPrincipal,
            externalId: "Customer:42",
            now,
          });
          expect(isolated).not.toEqual(first);
        } finally {
          await withTenantTransaction(env.migratorPool, otherOwner.scope, (client) =>
            client.query("UPDATE api_keys SET scopes=ARRAY['threads:read'] WHERE id=$1", [
              otherKey.key.id,
            ]),
          );
        }
      } finally {
        await withTenantTransaction(env.migratorPool, env.owner.scope, (client) =>
          client.query("UPDATE api_keys SET scopes=ARRAY['threads:read'] WHERE id=$1", [
            env.created.key.id,
          ]),
        );
      }
    });

    it("不同终端用户的 Thread、Run、Workspace 经真实 RLS 隔离，集成身份也不可见", async () => {
      const env = await fixture("isolation");
      try {
        const scopes = await Promise.all(
          ["left", "right"].map((externalId) =>
            env.apiKeys.mapEndUser({ principal: env.principal, externalId, now: env.now }),
          ),
        );
        const [left, right] = scopes;
        if (typeof left !== "object" || typeof right !== "object")
          throw new Error("终端用户映射缺失");
        const tenant = await env.repositories.tenants.get(left);
        if (tenant === undefined) throw new Error("个人空间缺失");
        const now = isoTimestamp(env.now);
        const thread = createThread({
          id: threadId("thread_end_user_rls"),
          tenant: tenant.tenant,
          user: tenant.user,
          membership: tenant.membership,
          title: "隔离对话",
          now,
        });
        expect((await env.repositories.threads.create(left, thread)).outcome).toBe("created");
        const run = createRun({ id: runId("run_end_user_rls"), thread, now });
        expect((await env.repositories.runs.create(left, run)).outcome).toBe("created");
        const workspace = createWorkspace({
          id: workspaceId("workspace_end_user_rls"),
          thread,
          now,
        });
        expect((await env.repositories.workspaces.create(left, workspace)).outcome).toBe("created");
        expect(await env.repositories.threads.get(left, thread.id)).toBeDefined();
        for (const scope of [right, env.principal]) {
          expect(await env.repositories.threads.get(scope, thread.id)).toBeUndefined();
          expect(await env.repositories.runs.get(scope, run.id)).toBeUndefined();
          expect(await env.repositories.workspaces.getById(scope, workspace.id)).toBeUndefined();
          for (const table of ["threads", "runs", "workspaces"]) {
            const hidden = await withTenantTransaction(env.runtimePool, scope, (client) =>
              client.query(`SELECT id FROM ${table} WHERE tenant_id=$1`, [left.tenantId]),
            );
            expect(hidden.rowCount).toBe(0);
          }
        }
        expect(
          await env.repositories.tenants.get({ tenantId: right.tenantId, userId: left.userId }),
        ).toBeUndefined();
        await expect(
          withTenantTransaction(env.runtimePool, left, (client) =>
            client.query("UPDATE api_end_users SET status='active'"),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await withTenantTransaction(env.migratorPool, env.owner.scope, (client) =>
          client.query("UPDATE api_keys SET scopes=ARRAY['threads:read'] WHERE id=$1", [
            env.created.key.id,
          ]),
        );
      }
    });

    it("后台目录显示来源并支持停用/恢复，无作用域或失效集成身份不能创建映射", async () => {
      const env = await fixture("management");
      let mappedScope: TenantScope | undefined;
      try {
        const input = { principal: env.principal, externalId: "customer:manage", now: env.now };
        const mapped = await env.apiKeys.mapEndUser(input);
        if (typeof mapped !== "object") throw new Error("终端用户映射缺失");
        mappedScope = mapped;
        await env.administrativePool.query(
          `INSERT INTO "${env.schema}".threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at,is_playground)
           VALUES($1,'thread_end_user_directory_playground',$2,'目录隔离','active',$3,$3,true)`,
          [mapped.tenantId, mapped.userId, env.now],
        );
        const control = new PgAdminControlRepository(
          env.adminControlPool,
          new ModelProviderCredentialCipher("end-user-test-placeholder-at-least-32-bytes"),
        );
        const listed = await control.listUsers({
          actorUserId: env.owner.user.id,
          query: "customer:manage",
          limit: 100,
        });
        expect(listed.items).toEqual([
          expect.objectContaining({
            userId: mapped.userId,
            source: "api_mapping",
            displayName: "customer:manage",
            email: "",
            status: "active",
            activeSessions: 0,
            conversationCount: 0,
            runCount: 0,
          }),
        ]);
        const viewer = await env.createFixture("end_user_viewer");
        await env.migratorPool.query(
          "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,'viewer','active')",
          [viewer.user.id],
        );
        expect(
          (await control.listUsers({ actorUserId: viewer.user.id, limit: 100 })).items,
        ).toEqual([]);
        const mutation = {
          actorUserId: env.owner.user.id,
          targetUserId: mapped.userId,
          reason: "后台用户管理",
          idempotencyKey: "end-user-disable-0001",
          requestDigest: "a".repeat(64),
          status: "disabled" as const,
        };
        expect((await control.updateUserStatus(mutation)).outcome).toBe("applied");
        expect((await control.updateUserStatus(mutation)).outcome).toBe("replayed");
        expect(await env.apiKeys.mapEndUser(input)).toBe("disabled");
        expect(
          (
            await control.updateUserStatus({
              ...mutation,
              idempotencyKey: "end-user-enable-0001",
              requestDigest: "b".repeat(64),
              status: "active",
            })
          ).outcome,
        ).toBe("applied");
        expect(await env.apiKeys.mapEndUser(input)).toEqual(mapped);
        const audits = await env.migratorPool.query(
          "SELECT status FROM admin_user_account_audits WHERE target_user_id=$1 ORDER BY created_at",
          [mapped.userId],
        );
        expect(audits.rows.map((row) => row.status)).toEqual(["disabled", "active"]);
        expect(await env.apiKeys.mapEndUser({ ...input, externalId: "bad id" })).toBeUndefined();
        expect(
          await env.apiKeys.mapEndUser({
            ...input,
            externalId: "unauthorized",
            principal: { ...env.principal, scopes: ["threads:read"] },
          }),
        ).toBeUndefined();
        await withTenantTransaction(env.migratorPool, env.owner.scope, (client) =>
          client.query("UPDATE api_keys SET scopes=ARRAY['threads:read'] WHERE id=$1", [
            env.created.key.id,
          ]),
        );
        expect(
          await env.apiKeys.mapEndUser({ ...input, externalId: "stale-scopes" }),
        ).toBeUndefined();
        await env.integrations.revokeKey(
          env.owner.user.id,
          env.owner.tenant.id,
          env.created.key.id,
        );
        expect(await env.apiKeys.mapEndUser(input)).toBeUndefined();
      } finally {
        if (mappedScope !== undefined) {
          await env.administrativePool.query(
            `DELETE FROM "${env.schema}".threads WHERE tenant_id=$1 AND id='thread_end_user_directory_playground'`,
            [mappedScope.tenantId],
          );
        }
        await env.migratorPool.query(
          "DELETE FROM admin_user_account_audits WHERE target_user_id IN (SELECT user_id FROM api_end_users WHERE integration_tenant_id=$1)",
          [env.owner.tenant.id],
        );
        await withTenantTransaction(env.migratorPool, env.owner.scope, (client) =>
          client.query("UPDATE api_keys SET scopes=ARRAY['threads:read'] WHERE id=$1", [
            env.created.key.id,
          ]),
        );
      }
    });
  });
}
