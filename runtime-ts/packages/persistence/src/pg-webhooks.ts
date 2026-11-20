import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { TenantScope } from "./ports.js";
import { withTransaction } from "./postgres.js";
import type { EncryptedWebhookSecret } from "./webhook-crypto.js";

export type WebhookEventType =
  | "run.waiting"
  | "run.requires_action"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "artifact.published";
export interface TenantWebhook {
  readonly id: string;
  readonly name: string;
  readonly endpointUrl: string;
  readonly eventTypes: readonly WebhookEventType[];
  readonly createdAt: string;
  readonly disabledAt?: string;
  readonly disabledReason?: string;
}
interface WebhookRow extends QueryResultRow {
  id: string;
  name: string;
  endpoint_url: string;
  event_types: WebhookEventType[];
  created_at: Date;
  disabled_at: Date | null;
  disabled_reason: string | null;
}
const selectColumns = "id,name,endpoint_url,event_types,created_at,disabled_at,disabled_reason";
function mapRow(row: WebhookRow): TenantWebhook {
  return Object.freeze({
    id: row.id,
    name: row.name,
    endpointUrl: row.endpoint_url,
    eventTypes: Object.freeze(row.event_types),
    createdAt: row.created_at.toISOString(),
    ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
    ...(row.disabled_reason ? { disabledReason: row.disabled_reason } : {}),
  });
}
async function scoped<T>(
  pool: Pool,
  scope: TenantScope,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
      [scope.tenantId, scope.userId],
    );
    return fn(client);
  });
}
export class PgWebhookRepository {
  constructor(private readonly pool: Pool) {}
  async list(scope: TenantScope): Promise<readonly TenantWebhook[]> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query<WebhookRow>(
        `SELECT webhook.id,webhook.name,webhook.endpoint_url,webhook.event_types,webhook.created_at,
                COALESCE(webhook.disabled_at,terminal.created_at) AS disabled_at,
                COALESCE(webhook.disabled_reason,terminal.last_error_code) AS disabled_reason
           FROM tenant_webhooks webhook
           LEFT JOIN LATERAL (SELECT created_at,last_error_code FROM webhook_outbox
             WHERE tenant_id=webhook.tenant_id AND webhook_id=webhook.id AND state='disabled'
             ORDER BY created_at DESC LIMIT 1) terminal ON true
          WHERE webhook.tenant_id=$1 ORDER BY webhook.created_at DESC,webhook.id`,
        [scope.tenantId],
      );
      return Object.freeze(r.rows.map(mapRow));
    });
  }
  async create(input: {
    scope: TenantScope;
    id?: string;
    name: string;
    endpointUrl: string;
    eventTypes: readonly WebhookEventType[];
    secret: EncryptedWebhookSecret;
  }): Promise<TenantWebhook> {
    return scoped(this.pool, input.scope, async (c) => {
      const id = input.id ?? `wh_${randomUUID()}`;
      const r = await c.query<WebhookRow>(
        `INSERT INTO tenant_webhooks(tenant_id,id,name,endpoint_url,event_types,secret_ciphertext,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,clock_timestamp()) RETURNING ${selectColumns}`,
        [
          input.scope.tenantId,
          id,
          input.name,
          input.endpointUrl,
          input.eventTypes,
          JSON.stringify(input.secret),
          input.scope.userId,
        ],
      );
      const row = r.rows[0];
      if (!row) throw new Error("WEBHOOK_CREATE_NO_ROW");
      return mapRow(row);
    });
  }
  async disable(scope: TenantScope, id: string): Promise<TenantWebhook | undefined> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query<WebhookRow>(
        `UPDATE tenant_webhooks SET disabled_at=COALESCE(disabled_at,clock_timestamp()),disabled_reason=COALESCE(disabled_reason,'disabled_by_owner') WHERE tenant_id=$1 AND id=$2 RETURNING ${selectColumns}`,
        [scope.tenantId, id],
      );
      return r.rows[0] ? mapRow(r.rows[0]) : undefined;
    });
  }
  async remove(scope: TenantScope, id: string): Promise<boolean> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query(`DELETE FROM tenant_webhooks WHERE tenant_id=$1 AND id=$2`, [
        scope.tenantId,
        id,
      ]);
      return r.rowCount === 1;
    });
  }
  async rotate(scope: TenantScope, id: string, secret: EncryptedWebhookSecret): Promise<boolean> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query(
        `UPDATE tenant_webhooks SET secret_ciphertext=$3::jsonb WHERE tenant_id=$1 AND id=$2`,
        [scope.tenantId, id, JSON.stringify(secret)],
      );
      if (r.rowCount === 1)
        await c.query(
          `UPDATE webhook_outbox SET secret_ciphertext=$3::jsonb
            WHERE tenant_id=$1 AND webhook_id=$2 AND state='pending'`,
          [scope.tenantId, id, JSON.stringify(secret)],
        );
      return r.rowCount === 1;
    });
  }
}

/** 在写入状态变化的同一 PostgreSQL 事务内创建投递快照；Outbox 不依赖后续读取业务表。 */
export async function enqueueWebhookEvent(input: {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly payload: unknown;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO webhook_outbox(tenant_id,id,webhook_id,event_id,event_type,endpoint_url,secret_ciphertext,payload)
     SELECT $1,'delivery_'||replace(gen_random_uuid()::text,'-',''),webhook.id,$2,$3,webhook.endpoint_url,webhook.secret_ciphertext,$4::jsonb
       FROM tenant_webhooks webhook
      WHERE webhook.tenant_id=$1 AND webhook.disabled_at IS NULL AND webhook.event_types @> ARRAY[$3]::text[]
        AND NOT EXISTS(SELECT 1 FROM webhook_outbox terminal WHERE terminal.tenant_id=webhook.tenant_id AND terminal.webhook_id=webhook.id AND terminal.state='disabled')
     ON CONFLICT(tenant_id,webhook_id,event_id) DO NOTHING`,
    [input.tenantId, input.eventId, input.eventType, JSON.stringify(input.payload)],
  );
}
