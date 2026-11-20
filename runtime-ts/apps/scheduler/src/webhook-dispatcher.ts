import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { isIP } from "node:net";
import type { Pool, QueryResultRow } from "pg";
import { validateExternalHttpsTarget } from "@hoox/tool-router";
import {
  signWebhook,
  type EncryptedWebhookSecret,
  type WebhookSecretCipher,
} from "@hoox/persistence/postgres";

interface DeliveryRow extends QueryResultRow {
  tenant_id: string;
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  endpoint_url: string;
  secret_ciphertext: EncryptedWebhookSecret;
  payload: unknown;
  attempts: number;
  claim_token: string;
}
const responseLimit = 64 * 1024;
const maxAttempts = 12;
export class WebhookDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: WebhookSecretCipher,
    private readonly owner: string,
  ) {}
  async runOne(): Promise<boolean> {
    const client = await this.pool.connect();
    let item: DeliveryRow | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query<DeliveryRow>(
        `WITH candidate AS (SELECT tenant_id,id FROM webhook_outbox WHERE state IN ('pending','claimed') AND next_attempt_at<=clock_timestamp() AND (state='pending' OR claim_expires_at<clock_timestamp()) ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE webhook_outbox o SET state='claimed',claim_token=$1,claim_expires_at=clock_timestamp()+interval '30 seconds',attempts=o.attempts+1 FROM candidate c WHERE o.tenant_id=c.tenant_id AND o.id=c.id RETURNING o.tenant_id,o.id,o.webhook_id,o.event_id,o.event_type,o.endpoint_url,o.secret_ciphertext,o.payload,o.attempts,o.claim_token`,
        [`${this.owner}:${randomUUID()}`],
      );
      item = result.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!item) return false;
    try {
      const target = await validateExternalHttpsTarget(item.endpoint_url);
      if (isIP(target.address) === 0) throw new Error("WEBHOOK_TARGET_REJECTED");
      const secret = this.cipher.decrypt(item.tenant_id, item.webhook_id, item.secret_ciphertext);
      const body = Buffer.from(JSON.stringify(item.payload));
      const timestamp = String(Date.now());
      const signature = signWebhook(secret, timestamp, item.event_id, body);
      await send(target, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-hoox-event-id": item.event_id,
        "x-hoox-timestamp": timestamp,
        "x-hoox-signature": signature,
      });
      await this.finish(item, "delivered", null, 0);
    } catch (error) {
      const code =
        error instanceof Error && error.message === "WEBHOOK_TARGET_REJECTED"
          ? "target_rejected"
          : "delivery_failed";
      const terminal = item.attempts >= maxAttempts;
      await this.finish(
        item,
        terminal ? "disabled" : "pending",
        code,
        terminal ? 0 : Math.min(3_600_000, 2_000 * 2 ** Math.min(item.attempts - 1, 10)),
      );
    }
    return true;
  }
  private async finish(
    item: DeliveryRow,
    state: "delivered" | "pending" | "disabled",
    error: string | null,
    delay: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_outbox SET state=$4,last_error_code=$5,next_attempt_at=clock_timestamp()+($6::text||' milliseconds')::interval,claim_token=NULL,claim_expires_at=NULL,delivered_at=CASE WHEN $4='delivered' THEN clock_timestamp() ELSE delivered_at END WHERE tenant_id=$1 AND id=$2 AND state='claimed' AND claim_token=$3`,
      [item.tenant_id, item.id, item.claim_token, state, error, delay],
    );
  }
}
function send(
  target: Awaited<ReturnType<typeof validateExternalHttpsTarget>>,
  body: Buffer,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: target.address,
        port: target.url.port || 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        headers: { ...headers, host: target.hostHeader },
        servername: target.servername,
        rejectUnauthorized: true,
        timeout: 8000,
      },
      (res) => {
        let size = 0;
        res.on("data", (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > responseLimit) req.destroy(new Error("WEBHOOK_RESPONSE_TOO_LARGE"));
        });
        res.on("end", () => {
          if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300)
            resolve();
          else reject(new Error("WEBHOOK_NON_SUCCESS"));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
