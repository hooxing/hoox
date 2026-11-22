import { randomBytes, randomUUID } from "node:crypto";
import {
  apiKeyAttributes,
  isoTimestamp,
  tenantId,
  userId,
  type ApiKeyAttributes,
} from "@hoox/domain";
import { createApiKeyToken, hashApiKey } from "@hoox/identity";
import type { Pool, PoolClient } from "pg";
import type { TenantScope } from "./ports.js";
import { PgApiKeyRepository } from "./pg-api-keys.js";
import { PgWebhookRepository } from "./pg-webhooks.js";
import { withTransaction } from "./postgres.js";
import type { WebhookSecretCipher } from "./webhook-crypto.js";

export class IntegrationAdminError extends Error {
  constructor(readonly code: "NOT_AUTHORIZED" | "NOT_FOUND" | "UNAVAILABLE") {
    super(`INTEGRATION_ADMIN_${code}`);
  }
}

interface IntegrationRepositories {
  readonly keys: PgApiKeyRepository;
  readonly webhooks: PgWebhookRepository;
  readonly scope: TenantScope;
}

export class PgIntegrationAdminRepository {
  constructor(
    private readonly pool: Pool,
    private readonly cipher?: WebhookSecretCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async authorize(client: PoolClient, actor: string, tenant: string): Promise<void> {
    await client.query(
      "SELECT set_config('app.user_id',$1,true),set_config('app.integration_admin_user_id',$1,true),set_config('app.tenant_id',$2,true)",
      [actor, tenant],
    );
    const authorized = await client.query(
      "SELECT user_id FROM platform_control_operators WHERE user_id=$1 AND status='active' AND role='admin'",
      [actor],
    );
    if (authorized.rowCount !== 1) throw new IntegrationAdminError("NOT_AUTHORIZED");
    const target = await client.query("SELECT id FROM tenants WHERE id=$1", [tenant]);
    if (target.rowCount !== 1) throw new IntegrationAdminError("NOT_FOUND");
  }

  async listTenants(actor: string) {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT set_config('app.user_id',$1,true)", [actor]);
      const result = await client.query<{
        tenant_id: string;
        display_name: string;
        kind: "personal" | "team";
        is_default: boolean;
      }>(
        `SELECT tenant_id,display_name,kind,is_default
           FROM admin_integration_tenant_directory
          ORDER BY is_default DESC,display_name,tenant_id`,
      );
      if (result.rowCount === 0) {
        const authorized = await client.query(
          "SELECT 1 FROM platform_control_operators WHERE user_id=$1 AND status='active' AND role='admin'",
          [actor],
        );
        if (authorized.rowCount !== 1) throw new IntegrationAdminError("NOT_AUTHORIZED");
      }
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            tenantId: row.tenant_id,
            displayName: row.display_name,
            kind: row.kind,
            isDefault: row.is_default,
          }),
        ),
      );
    });
  }

  assertAccess(actor: string, tenant: string): Promise<void> {
    return withTransaction(this.pool, (client) => this.authorize(client, actor, tenant));
  }

  private run<T>(
    actor: string,
    tenant: string,
    action: string,
    operation: (repositories: IntegrationRepositories) => Promise<T>,
    objectId: (value: T) => string = () => tenant,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await this.authorize(client, actor, tenant);
      const transact = <Result>(callback: (connection: PoolClient) => Promise<Result>) =>
        callback(client);
      const result = await operation({
        keys: new PgApiKeyRepository(this.pool, transact),
        webhooks: new PgWebhookRepository(this.pool, transact),
        scope: { tenantId: tenantId(tenant), userId: userId(actor) },
      });
      await client.query(
        "INSERT INTO integration_admin_audits(id,actor_user_id,tenant_id,action,object_id) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), actor, tenant, action, objectId(result)],
      );
      return result;
    });
  }

  listKeys(actor: string, tenant: string) {
    return this.run(actor, tenant, "api_key.list", ({ keys, scope }) => keys.list(scope));
  }

  createKey(actor: string, tenant: string, input: Omit<ApiKeyAttributes, "createdAt">) {
    return this.run(
      actor,
      tenant,
      "api_key.create",
      async ({ keys, scope }) => {
        const now = isoTimestamp(this.now().toISOString());
        const attributes = apiKeyAttributes({ ...input, createdAt: now });
        const token = createApiKeyToken();
        const key = await keys.create({
          ...attributes,
          scope,
          createdBy: actor,
          keyHash: hashApiKey(token),
          prefix: token.slice(0, 12),
          now,
        });
        return { key, token };
      },
      (result) => result.key.id,
    );
  }

  rotateKey(actor: string, tenant: string, id: string) {
    return this.run(
      actor,
      tenant,
      "api_key.rotate",
      async ({ keys, scope }) => {
        const token = createApiKeyToken();
        const key = await keys.rotate(scope, id, hashApiKey(token), token.slice(0, 12));
        if (key === undefined) throw new IntegrationAdminError("NOT_FOUND");
        return { key, token };
      },
      () => id,
    );
  }

  revokeKey(actor: string, tenant: string, id: string) {
    return this.run(
      actor,
      tenant,
      "api_key.revoke",
      async ({ keys, scope }) => {
        const key = await keys.revoke(scope, id, this.now().toISOString());
        if (key === undefined) throw new IntegrationAdminError("NOT_FOUND");
        return key;
      },
      () => id,
    );
  }

  listWebhooks(actor: string, tenant: string) {
    return this.run(actor, tenant, "webhook.list", ({ webhooks, scope }) => webhooks.list(scope));
  }

  createWebhook(
    actor: string,
    tenant: string,
    input: Pick<
      Parameters<PgWebhookRepository["create"]>[0],
      "name" | "endpointUrl" | "eventTypes"
    >,
  ) {
    return this.run(
      actor,
      tenant,
      "webhook.create",
      async ({ webhooks, scope }) => {
        if (this.cipher === undefined) throw new IntegrationAdminError("UNAVAILABLE");
        const id = `wh_${randomUUID()}`;
        const secret = randomBytes(32).toString("base64url");
        const webhook = await webhooks.create({
          ...input,
          name: input.name.trim(),
          scope,
          id,
          secret: this.cipher.encrypt(tenant, id, secret),
        });
        return { webhook, secret };
      },
      (result) => result.webhook.id,
    );
  }

  rotateWebhook(actor: string, tenant: string, id: string) {
    return this.run(
      actor,
      tenant,
      "webhook.rotate",
      async ({ webhooks, scope }) => {
        if (this.cipher === undefined) throw new IntegrationAdminError("UNAVAILABLE");
        const secret = randomBytes(32).toString("base64url");
        if (!(await webhooks.rotate(scope, id, this.cipher.encrypt(tenant, id, secret))))
          throw new IntegrationAdminError("NOT_FOUND");
        return { secret };
      },
      () => id,
    );
  }

  disableWebhook(actor: string, tenant: string, id: string) {
    return this.run(
      actor,
      tenant,
      "webhook.disable",
      async ({ webhooks, scope }) => {
        const webhook = await webhooks.disable(scope, id);
        if (webhook === undefined) throw new IntegrationAdminError("NOT_FOUND");
        return { webhook };
      },
      () => id,
    );
  }

  removeWebhook(actor: string, tenant: string, id: string) {
    return this.run(
      actor,
      tenant,
      "webhook.delete",
      async ({ webhooks, scope }) => {
        if (!(await webhooks.remove(scope, id))) throw new IntegrationAdminError("NOT_FOUND");
        return { deleted: true };
      },
      () => id,
    );
  }
}
