import { createHash, randomUUID } from "node:crypto";
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

/** 停用原因：Owner 手动停用，或投递次数耗尽后由 Dispatcher 自动停用。 */
export const WEBHOOK_DISABLED_BY_OWNER = "disabled_by_owner";
export const WEBHOOK_DISABLED_ATTEMPTS_EXHAUSTED = "delivery_attempts_exhausted";

export class PgWebhookRepository {
  constructor(private readonly pool: Pool) {}
  async list(scope: TenantScope): Promise<readonly TenantWebhook[]> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query<WebhookRow>(
        `SELECT ${selectColumns} FROM tenant_webhooks
          WHERE tenant_id=$1 AND disabled_reason IS DISTINCT FROM 'deleted_by_owner' ORDER BY created_at DESC,id`,
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
  /**
   * 订阅级停用：提交后 Dispatcher 不再领取该订阅的任何投递（含积压），新事件也不再入队。
   * 停用前已领取的投递在发送前复核时会被结算为 `webhook_disabled`；已通过复核、正在发送的
   * 那一次请求可能仍会到达接收端。删除是逻辑删除，保留记录以满足 Outbox 外键并隔离并发；不可恢复。
   */
  async disable(scope: TenantScope, id: string): Promise<TenantWebhook | undefined> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query<WebhookRow>(
        `UPDATE tenant_webhooks SET disabled_at=COALESCE(disabled_at,clock_timestamp()),disabled_reason=COALESCE(disabled_reason,$3) WHERE tenant_id=$1 AND id=$2 AND disabled_reason IS DISTINCT FROM 'deleted_by_owner' RETURNING ${selectColumns}`,
        [scope.tenantId, id, WEBHOOK_DISABLED_BY_OWNER],
      );
      return r.rows[0] ? mapRow(r.rows[0]) : undefined;
    });
  }
  async remove(scope: TenantScope, id: string): Promise<boolean> {
    return scoped(this.pool, scope, async (c) => {
      // 逻辑删除保留外键目标，避免与业务事务的 Outbox 入队竞争并回滚 Run 状态。
      const r = await c.query(
        `UPDATE tenant_webhooks SET disabled_at=COALESCE(disabled_at,clock_timestamp()),disabled_reason='deleted_by_owner'
          WHERE tenant_id=$1 AND id=$2 AND disabled_reason IS DISTINCT FROM 'deleted_by_owner'`,
        [scope.tenantId, id],
      );
      return r.rowCount === 1;
    });
  }
  /**
   * 轮换只更新订阅密文；Outbox 不保存密钥，Dispatcher 在每次发送前复核时读取当前密钥。
   * 只有轮换提交时已通过复核的在途尝试可能使用旧密钥。
   */
  async rotate(scope: TenantScope, id: string, secret: EncryptedWebhookSecret): Promise<boolean> {
    return scoped(this.pool, scope, async (c) => {
      const r = await c.query(
        `UPDATE tenant_webhooks SET secret_ciphertext=$3::jsonb WHERE tenant_id=$1 AND id=$2 AND disabled_reason IS DISTINCT FROM 'deleted_by_owner'`,
        [scope.tenantId, id, JSON.stringify(secret)],
      );
      return r.rowCount === 1;
    });
  }
}

/** 投递载荷：顶层与 `data` 字段均为封闭白名单，新增字段必须同步更新参考契约与白名单测试。 */
export interface RunWebhookPayload {
  readonly id: string;
  readonly type: Exclude<WebhookEventType, "artifact.published">;
  readonly createdAt: string;
  readonly data: { readonly runId: string; readonly status: string };
}
export interface ArtifactWebhookPayload {
  readonly id: string;
  readonly type: "artifact.published";
  readonly createdAt: string;
  readonly data: { readonly artifactId: string; readonly runId: string };
}

// 事件 ID 由业务事实确定性派生：同一状态转换或同一 Artifact 发布无论重放多少次都得到同一 ID，
// 配合 (tenant_id,webhook_id,event_id) 唯一约束保证不重复入队。
function deterministicEventId(parts: readonly string[]): string {
  return `evt_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 40)}`;
}

const runStatusEvents: Readonly<Record<string, RunWebhookPayload["type"]>> = Object.freeze({
  waiting: "run.waiting",
  succeeded: "run.succeeded",
  failed: "run.failed",
  cancelled: "run.cancelled",
});

/** 构造 Run 状态事件；非事件状态（queued、running）返回 undefined。`runVersion` 为转换后的行版本。 */
export function runWebhookPayload(input: {
  readonly tenantId: string;
  readonly runId: string;
  readonly status: string;
  readonly runVersion: string | number | bigint;
  readonly occurredAt: string;
}): RunWebhookPayload | undefined {
  const type = runStatusEvents[input.status];
  if (type === undefined) return undefined;
  const id = deterministicEventId([
    "run-status-v1",
    input.tenantId,
    input.runId,
    String(input.runVersion),
    input.status,
  ]);
  return Object.freeze({
    id,
    type,
    createdAt: input.occurredAt,
    data: Object.freeze({ runId: input.runId, status: input.status }),
  });
}

/** Artifact 发布事件只公开 Artifact 与 Run 标识；文件名、路径和下载地址不得外发。 */
export function artifactWebhookPayload(input: {
  readonly tenantId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly occurredAt: string;
}): ArtifactWebhookPayload {
  return Object.freeze({
    id: deterministicEventId(["artifact-published-v1", input.tenantId, input.artifactId]),
    type: "artifact.published",
    createdAt: input.occurredAt,
    data: Object.freeze({ artifactId: input.artifactId, runId: input.runId }),
  });
}

/**
 * 在写入状态变化的同一 PostgreSQL 事务内为该 Tenant 每个启用且订阅该类型的 Webhook 入队。
 * 事务回滚则不入队；同一事件 ID 重复调用由唯一约束去重。Outbox 不保存地址或密钥快照。
 */
export async function enqueueWebhookEvent(input: {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly payload: RunWebhookPayload | ArtifactWebhookPayload;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO webhook_outbox(
       tenant_id,id,webhook_id,event_id,event_type,payload,source_run_id,source_run_origin
     )
     SELECT $1,'delivery_'||replace(gen_random_uuid()::text,'-',''),webhook.id,$2,$3,$4::jsonb,
            source_run.id,source_run.origin
       FROM tenant_webhooks webhook
       JOIN runs source_run ON source_run.tenant_id=$1 AND source_run.id=$5
      WHERE webhook.tenant_id=$1 AND webhook.disabled_at IS NULL AND webhook.event_types @> ARRAY[$3]::text[]
        AND source_run.origin<>'playground'
     ON CONFLICT(tenant_id,webhook_id,event_id) DO NOTHING`,
    [
      input.tenantId,
      input.payload.id,
      input.payload.type,
      JSON.stringify(input.payload),
      input.payload.data.runId,
    ],
  );
}

/** Run 状态转换的统一入队入口；调用方必须在提交该转换的同一事务内、确认转换已生效后调用。 */
export async function enqueueRunStatusWebhook(
  client: PoolClient,
  input: Parameters<typeof runWebhookPayload>[0],
): Promise<void> {
  const payload = runWebhookPayload(input);
  if (payload !== undefined)
    await enqueueWebhookEvent({ client, tenantId: input.tenantId, payload });
}

export const WEBHOOK_MAX_ATTEMPTS = 12;

export interface ClaimedWebhookDelivery {
  readonly tenantId: string;
  readonly id: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly endpointUrl: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly claimToken: string;
}

export type WebhookSendPermit =
  | { readonly outcome: "send"; readonly secretCiphertext: EncryptedWebhookSecret }
  | { readonly outcome: "skip" };

export type WebhookSettlement =
  | { readonly kind: "delivered" }
  | { readonly kind: "retry"; readonly errorCode: string; readonly delayMs: number }
  | { readonly kind: "exhausted"; readonly errorCode: string };

interface ClaimRow extends QueryResultRow {
  tenant_id: string;
  id: string;
  webhook_id: string;
  event_id: string;
  endpoint_url: string;
  payload: unknown;
  attempts: number;
  claim_token: string;
}

/**
 * Webhook Dispatcher 的 Outbox 存储。只能以 Dispatcher 专属角色连接：该角色跨 Tenant 读取
 * Outbox 与订阅的投递列，只能把订阅改为停用，不能读取任何业务表。
 */
export class PgWebhookOutboxStore {
  readonly #maxAttempts: number;
  readonly #leaseMs: number;
  constructor(
    private readonly pool: Pool,
    options: { readonly maxAttempts?: number; readonly leaseMs?: number } = {},
  ) {
    this.#maxAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
    this.#leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1)
      throw new TypeError("WEBHOOK_MAX_ATTEMPTS_INVALID");
    if (!Number.isInteger(this.#leaseMs) || this.#leaseMs < 1_000)
      throw new TypeError("WEBHOOK_LEASE_INVALID");
  }

  get leaseMs(): number {
    return this.#leaseMs;
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /**
   * 领取一条到期投递并计入一次尝试。次数上限在领取时强制：次数已耗尽且租约已过期的记录
   * 在同一事务中原子结算为 `disabled`，并停用整个订阅，因此进程崩溃后的租约恢复不会超发。
   * `excludedTenantIds` 用于同一进程内的 Tenant 公平：已有在途投递的 Tenant 不再占用其他槽位。
   */
  async claim(input: {
    readonly owner: string;
    readonly excludedTenantIds?: readonly string[];
  }): Promise<ClaimedWebhookDelivery | undefined> {
    return withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          `UPDATE webhook_outbox
              SET state='disabled',last_error_code='playground_source',claim_token=NULL,claim_expires_at=NULL
            WHERE source_run_origin='playground'
              AND state IN ('pending','claimed')
              AND (state='pending' OR claim_expires_at<clock_timestamp())`,
        );
        await client.query(
          `WITH exhausted AS (
           SELECT tenant_id,id FROM webhook_outbox
            WHERE source_run_origin IN ('normal','evaluation','api')
              AND state IN ('pending','claimed') AND attempts >= $1
              AND (state='pending' OR claim_expires_at < clock_timestamp())
            ORDER BY next_attempt_at,created_at
            FOR UPDATE SKIP LOCKED LIMIT 100
         ), settled AS (
           UPDATE webhook_outbox o
              SET state='disabled',last_error_code='attempts_exhausted',claim_token=NULL,claim_expires_at=NULL
             FROM exhausted e WHERE o.tenant_id=e.tenant_id AND o.id=e.id
           RETURNING o.tenant_id,o.webhook_id
         )
         UPDATE tenant_webhooks w SET disabled_at=clock_timestamp(),disabled_reason=$2
           FROM (SELECT DISTINCT tenant_id,webhook_id FROM settled) s
          WHERE w.tenant_id=s.tenant_id AND w.id=s.webhook_id AND w.disabled_at IS NULL`,
          [this.#maxAttempts, WEBHOOK_DISABLED_ATTEMPTS_EXHAUSTED],
        );
        const result = await client.query<ClaimRow>(
          `WITH candidate AS (
           SELECT o.tenant_id,o.id,w.endpoint_url FROM webhook_outbox o
             JOIN tenant_webhooks w ON w.tenant_id=o.tenant_id AND w.id=o.webhook_id
            WHERE o.source_run_origin IN ('normal','evaluation','api')
              AND o.state IN ('pending','claimed') AND o.next_attempt_at<=clock_timestamp()
              AND (o.state='pending' OR o.claim_expires_at<clock_timestamp())
              AND o.attempts < $2 AND w.disabled_at IS NULL
              AND NOT (o.tenant_id = ANY($3::text[]))
            ORDER BY o.next_attempt_at,o.created_at
            FOR UPDATE OF o SKIP LOCKED LIMIT 1
         )
         UPDATE webhook_outbox o
            SET state='claimed',claim_token=$1,
                claim_expires_at=clock_timestamp()+($4::text||' milliseconds')::interval,
                attempts=o.attempts+1
           FROM candidate c WHERE o.tenant_id=c.tenant_id AND o.id=c.id
         RETURNING o.tenant_id,o.id,o.webhook_id,o.event_id,c.endpoint_url,o.payload,o.attempts,o.claim_token`,
          [
            `${input.owner}:${randomUUID()}`,
            this.#maxAttempts,
            [...(input.excludedTenantIds ?? [])],
            this.#leaseMs,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        return Object.freeze({
          tenantId: row.tenant_id,
          id: row.id,
          webhookId: row.webhook_id,
          eventId: row.event_id,
          endpointUrl: row.endpoint_url,
          payload: row.payload,
          attempts: row.attempts,
          claimToken: row.claim_token,
        });
      },
      { deadlineMs: 5_000 },
    );
  }

  /**
   * 发送前复核：仅当本次领取仍有效、剩余租约覆盖整个发送时限且订阅仍启用时返回当前密钥。
   * 订阅已停用时把这条已领取但未发出的投递结算为 `disabled`（`webhook_disabled`）；
   * 领取已失效时返回 skip，由新的持有者处理。
   */
  async permitSend(
    delivery: ClaimedWebhookDelivery,
    sendBudgetMs: number,
  ): Promise<WebhookSendPermit> {
    return withTransaction(
      this.pool,
      async (client) => {
        const current = await client.query<{
          secret_ciphertext: EncryptedWebhookSecret;
          disabled: boolean;
          source_run_origin: string;
        }>(
          `SELECT w.secret_ciphertext,w.disabled_at IS NOT NULL AS disabled,o.source_run_origin
           FROM webhook_outbox o
           JOIN tenant_webhooks w ON w.tenant_id=o.tenant_id AND w.id=o.webhook_id
          WHERE o.tenant_id=$1 AND o.id=$2 AND o.state='claimed' AND o.claim_token=$3
            AND o.claim_expires_at > clock_timestamp()+($4::text||' milliseconds')::interval
          FOR UPDATE OF o`,
          [delivery.tenantId, delivery.id, delivery.claimToken, Math.max(0, sendBudgetMs)],
        );
        const row = current.rows[0];
        if (row === undefined) return { outcome: "skip" } as const;
        if (row.source_run_origin === "playground") {
          await client.query(
            `UPDATE webhook_outbox
              SET state='disabled',last_error_code='playground_source',claim_token=NULL,claim_expires_at=NULL
            WHERE tenant_id=$1 AND id=$2 AND state='claimed' AND claim_token=$3`,
            [delivery.tenantId, delivery.id, delivery.claimToken],
          );
          return { outcome: "skip" } as const;
        }
        // 未知来源不能发送，也不能自动结算为 Playground；保留事实以供后续核查。
        if (
          !(["normal", "evaluation", "api"] as const).includes(
            row.source_run_origin as "normal" | "evaluation" | "api",
          )
        )
          return { outcome: "skip" } as const;
        if (row.disabled) {
          await client.query(
            `UPDATE webhook_outbox
              SET state='disabled',last_error_code='webhook_disabled',claim_token=NULL,claim_expires_at=NULL
            WHERE tenant_id=$1 AND id=$2 AND state='claimed' AND claim_token=$3`,
            [delivery.tenantId, delivery.id, delivery.claimToken],
          );
          return { outcome: "skip" } as const;
        }
        return { outcome: "send", secretCiphertext: row.secret_ciphertext } as const;
      },
      { deadlineMs: 5_000 },
    );
  }

  /** 以领取令牌结算一次；令牌已被租约恢复替换时为 no-op。次数耗尽同时停用整个订阅。 */
  async settle(delivery: ClaimedWebhookDelivery, settlement: WebhookSettlement): Promise<void> {
    await withTransaction(
      this.pool,
      async (client) => {
        const key = [delivery.tenantId, delivery.id, delivery.claimToken];
        if (settlement.kind === "delivered") {
          await client.query(
            `UPDATE webhook_outbox
              SET state='delivered',delivered_at=clock_timestamp(),last_error_code=NULL,
                  claim_token=NULL,claim_expires_at=NULL
            WHERE tenant_id=$1 AND id=$2 AND state='claimed' AND claim_token=$3`,
            key,
          );
          return;
        }
        if (settlement.kind === "retry") {
          await client.query(
            `UPDATE webhook_outbox
              SET state='pending',last_error_code=$4,claim_token=NULL,claim_expires_at=NULL,
                  next_attempt_at=clock_timestamp()+($5::text||' milliseconds')::interval
            WHERE tenant_id=$1 AND id=$2 AND state='claimed' AND claim_token=$3`,
            [...key, settlement.errorCode, Math.max(0, Math.trunc(settlement.delayMs))],
          );
          return;
        }
        const updated = await client.query(
          `UPDATE webhook_outbox
            SET state='disabled',last_error_code=$4,claim_token=NULL,claim_expires_at=NULL
          WHERE tenant_id=$1 AND id=$2 AND state='claimed' AND claim_token=$3`,
          [...key, settlement.errorCode],
        );
        if (updated.rowCount === 1)
          await client.query(
            `UPDATE tenant_webhooks SET disabled_at=clock_timestamp(),disabled_reason=$3
            WHERE tenant_id=$1 AND id=$2 AND disabled_at IS NULL`,
            [delivery.tenantId, delivery.webhookId, WEBHOOK_DISABLED_ATTEMPTS_EXHAUSTED],
          );
      },
      { deadlineMs: 5_000 },
    );
  }
}
