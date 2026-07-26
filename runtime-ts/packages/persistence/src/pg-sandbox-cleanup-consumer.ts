import { randomUUID } from "node:crypto";
import { withTenantTransaction, type Pool } from "./postgres.js";

export interface CleanupClaim {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly registryId: string;
  readonly providerSandboxId: string;
  readonly idempotencyKey: string;
  readonly disposition: "close" | "pause";
  readonly token: string;
  readonly generation: number;
}

/**
 * Scheduler 只能在明确 Tenant 作用域内领取；不提供跨租户扫描接口，避免绕过 FORCE RLS。
 * 远端调用开始前先写入 remote_call_started_at，崩溃后协调器只会收敛 unknown，绝不猜测重试。
 */
export class PgSandboxCleanupConsumerStore {
  constructor(private readonly pool: Pool) {}

  async claimNext(input: { readonly tenantId: string; readonly workerId: string; readonly leaseMs: number }): Promise<CleanupClaim | undefined> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 600_000) throw new TypeError("cleanup leaseMs 无效");
    return withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      // 已跨越远端调用边界的过期 claim 只能变 unknown；不能再次派发 close。
      await client.query(
        `UPDATE cleanup_outbox SET state='unknown',claim_token=NULL,claimed_by=NULL,claim_lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND state='started' AND remote_call_started_at IS NOT NULL
            AND claim_lease_expires_at <= clock_timestamp()`, [input.tenantId],
      );
      const candidate = await client.query<any>(
        `SELECT c.* FROM cleanup_outbox c
          JOIN execution_attempts a ON a.tenant_id=c.tenant_id AND a.attempt_id=c.attempt_id
          LEFT JOIN run_claims rc ON rc.tenant_id=a.tenant_id AND rc.attempt_id=a.attempt_id AND rc.released_at IS NULL
          LEFT JOIN workspace_write_leases wl ON wl.tenant_id=a.tenant_id AND wl.workspace_id=a.workspace_id AND wl.root_run_id=a.root_run_id AND wl.epoch=rc.workspace_lease_epoch
         WHERE c.tenant_id=$1 AND c.state IN ('pending','started') AND c.retry_at <= clock_timestamp()
           AND (c.claim_lease_expires_at IS NULL OR c.claim_lease_expires_at <= clock_timestamp())
           AND NOT (a.status IN ('claimed','running','finalizing') AND rc.expires_at > clock_timestamp() AND wl.expires_at > clock_timestamp())
           AND (c.state='started' OR c.disposition IS NULL)
         ORDER BY c.updated_at FOR UPDATE OF c,a SKIP LOCKED LIMIT 1`, [input.tenantId],
      );
      const row = candidate.rows[0]; if (row === undefined) return undefined;
      const token = `cleanup-${randomUUID()}`;
      const disposition = row.state === 'started' ? row.disposition : 'close';
      await client.query(
        `UPDATE cleanup_outbox SET state='started',disposition=$4,claim_token=$5,claimed_by=$6,
           claim_generation=claim_generation+1,claim_lease_expires_at=clock_timestamp()+($7::bigint*interval '1 millisecond'),
           attempt_count=attempt_count+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3`,
        [input.tenantId,row.attempt_id,row.idempotency_key,disposition,token,input.workerId,input.leaseMs],
      );
      return { tenantId: input.tenantId,attemptId:row.attempt_id,registryId:row.registry_id,providerSandboxId:row.provider_sandbox_id,idempotencyKey:row.idempotency_key,disposition,token,generation:Number(row.claim_generation)+1 } as CleanupClaim;
    }, { isolationLevel: "SERIALIZABLE" });
  }

  async markRemoteStarted(claim: CleanupClaim): Promise<boolean> { return this.transition(claim, "remote"); }
  async complete(claim: CleanupClaim): Promise<boolean> { return this.transition(claim, "completed"); }
  async unknown(claim: CleanupClaim): Promise<boolean> { return this.transition(claim, "unknown"); }
  private async transition(claim: CleanupClaim, next: "remote" | "completed" | "unknown"): Promise<boolean> {
    return withTenantTransaction(this.pool,{tenantId:claim.tenantId},async client => {
      const result=await client.query(
        `UPDATE cleanup_outbox SET ${next === 'remote' ? "remote_call_started_at=clock_timestamp()" : `state='${next}',claim_token=NULL,claimed_by=NULL,claim_lease_expires_at=NULL`},updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3 AND state='started' AND claim_token=$4 AND claim_generation=$5`,
        [claim.tenantId,claim.attemptId,claim.idempotencyKey,claim.token,claim.generation]);
      return result.rowCount===1;
    },{isolationLevel:"SERIALIZABLE"});
  }
}
