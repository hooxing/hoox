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

  async claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<CleanupClaim | undefined> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 600_000)
      throw new TypeError("cleanup leaseMs 无效");
    if (!boundedText(input.workerId, 200)) throw new TypeError("cleanup workerId 无效");
    return withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        // 已跨越远端调用边界的过期 claim 只能变 unknown；不能再次派发 close。
        await client.query(
          `UPDATE cleanup_outbox SET state='unknown',claim_token=NULL,claimed_by=NULL,claim_lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND state='started' AND remote_call_started_at IS NOT NULL
            AND (claim_lease_expires_at IS NULL OR claim_lease_expires_at <= clock_timestamp())
            AND NOT EXISTS (
              SELECT 1 FROM execution_attempts attempt
              JOIN run_claims run_claim ON run_claim.tenant_id=attempt.tenant_id AND run_claim.attempt_id=attempt.attempt_id
                AND run_claim.released_at IS NULL AND run_claim.expires_at > clock_timestamp()
              JOIN workspace_write_leases workspace_lease ON workspace_lease.tenant_id=attempt.tenant_id
                AND workspace_lease.workspace_id=attempt.workspace_id AND workspace_lease.root_run_id=attempt.root_run_id
                AND workspace_lease.epoch=run_claim.workspace_lease_epoch AND workspace_lease.expires_at > clock_timestamp()
              WHERE attempt.tenant_id=cleanup_outbox.tenant_id AND attempt.attempt_id=cleanup_outbox.attempt_id
                AND attempt.status IN ('claimed','running','finalizing')
            )`,
          [input.tenantId],
        );
        await client.query(
          `UPDATE sandbox_registry registry SET state='unknown',updated_at=clock_timestamp()
           FROM cleanup_outbox cleanup
          WHERE cleanup.tenant_id=$1 AND cleanup.state='unknown' AND cleanup.remote_call_started_at IS NOT NULL
            AND cleanup.tenant_id=registry.tenant_id AND cleanup.registry_id=registry.registry_id
            AND registry.state IN ('closing','pausing')`,
          [input.tenantId],
        );
        const candidate = await client.query<{
          attempt_id: string;
          registry_id: string;
          provider_sandbox_id: string;
          idempotency_key: string;
          state: "pending" | "started";
          disposition: "close" | "pause" | null;
          claim_generation: string;
          status: string;
          workspace_id: string;
        }>(
          `SELECT c.*,a.status,a.workspace_id FROM cleanup_outbox c
          JOIN execution_attempts a ON a.tenant_id=c.tenant_id AND a.attempt_id=c.attempt_id
          LEFT JOIN run_claims rc ON rc.tenant_id=a.tenant_id AND rc.attempt_id=a.attempt_id AND rc.released_at IS NULL
          LEFT JOIN workspace_write_leases wl ON wl.tenant_id=a.tenant_id AND wl.workspace_id=a.workspace_id AND wl.root_run_id=a.root_run_id AND wl.epoch=rc.workspace_lease_epoch
         WHERE c.tenant_id=$1 AND c.state IN ('pending','started') AND c.retry_at <= clock_timestamp()
           AND (c.claim_lease_expires_at IS NULL OR c.claim_lease_expires_at <= clock_timestamp())
           -- LEFT JOIN 缺行会产生 NULL；NULL 不能当成“仍活动”，否则已释放 Attempt 永远无法 cleanup。
           AND NOT COALESCE((a.status IN ('claimed','running','finalizing') AND rc.expires_at > clock_timestamp() AND wl.expires_at > clock_timestamp()), false)
           -- started 的 disposition 是第一次领取时决定的事实，恢复只能沿用，绝不能改写。
           AND (c.state='pending' OR (c.disposition IS NOT NULL AND c.remote_call_started_at IS NULL))
         ORDER BY c.updated_at FOR UPDATE OF c,a SKIP LOCKED LIMIT 1`,
          [input.tenantId],
        );
        const row = candidate.rows[0];
        if (row === undefined) return undefined;
        // 候选筛选后的二次锁定避免 SERIALIZABLE 快照落在 heartbeat 续租之前。
        // 锁顺序固定为 cleanup/attempt → run claim → workspace lease，所有 consumer 一致。
        const currentClaim = await client.query<{ expires_at: Date }>(
          `SELECT expires_at FROM run_claims WHERE tenant_id=$1 AND attempt_id=$2 AND released_at IS NULL FOR UPDATE`,
          [input.tenantId, row.attempt_id],
        );
        const currentLease = await client.query<{ expires_at: Date }>(
          `SELECT expires_at FROM workspace_write_leases WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE`,
          [input.tenantId, row.workspace_id],
        );
        const now = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        const databaseNow = now.rows[0]?.now.getTime();
        if (databaseNow === undefined) throw new Error("cleanup 数据库时钟缺失");
        if (
          ["claimed", "running", "finalizing"].includes(row.status) &&
          currentClaim.rows[0] !== undefined &&
          currentLease.rows[0] !== undefined &&
          currentClaim.rows[0].expires_at.getTime() > databaseNow &&
          currentLease.rows[0].expires_at.getTime() > databaseNow
        )
          return undefined;
        const token = `cleanup-${randomUUID()}`;
        const disposition = row.state === "started" ? row.disposition : "close";
        const claimed = await client.query(
          `UPDATE cleanup_outbox SET state='started',
           disposition=CASE WHEN state='pending' THEN 'close' ELSE disposition END,claim_token=$4,claimed_by=$5,
           claim_generation=claim_generation+1,claim_lease_expires_at=clock_timestamp()+($6::bigint*interval '1 millisecond'),
           attempt_count=attempt_count+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3
           AND (state='pending' OR (state='started' AND disposition IS NOT NULL AND remote_call_started_at IS NULL))`,
          [
            input.tenantId,
            row.attempt_id,
            row.idempotency_key,
            token,
            input.workerId,
            input.leaseMs,
          ],
        );
        if (claimed.rowCount !== 1) return undefined;
        return {
          tenantId: input.tenantId,
          attemptId: row.attempt_id,
          registryId: row.registry_id,
          providerSandboxId: row.provider_sandbox_id,
          idempotencyKey: row.idempotency_key,
          disposition,
          token,
          generation: Number(row.claim_generation) + 1,
        } as CleanupClaim;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  async markRemoteStarted(claim: CleanupClaim): Promise<boolean> {
    return this.transition(claim, "remote");
  }
  async complete(claim: CleanupClaim): Promise<boolean> {
    return this.transition(claim, "completed");
  }
  async unknown(claim: CleanupClaim): Promise<boolean> {
    return this.transition(claim, "unknown");
  }
  private async transition(
    claim: CleanupClaim,
    next: "remote" | "completed" | "unknown",
  ): Promise<boolean> {
    return withTenantTransaction(
      this.pool,
      { tenantId: claim.tenantId },
      async (client) => {
        const result = await client.query<{ registry_id: string; disposition: "close" | "pause" }>(
          `UPDATE cleanup_outbox SET ${next === "remote" ? "remote_call_started_at=clock_timestamp()" : `state='${next}',claim_token=NULL,claimed_by=NULL,claim_lease_expires_at=NULL`},updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3 AND state='started' AND claim_token=$4 AND claim_generation=$5
            AND registry_id=$6 AND provider_sandbox_id=$7 AND disposition=$8
            ${next === "remote" ? "AND claim_lease_expires_at > clock_timestamp()" : ""}
          RETURNING registry_id,disposition`,
          [
            claim.tenantId,
            claim.attemptId,
            claim.idempotencyKey,
            claim.token,
            claim.generation,
            claim.registryId,
            claim.providerSandboxId,
            claim.disposition,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) return false;
        const registryState =
          next === "remote"
            ? row.disposition === "pause"
              ? "pausing"
              : "closing"
            : next === "completed"
              ? row.disposition === "pause"
                ? "paused"
                : "closed"
              : "unknown";
        const registry = await client.query(
          `UPDATE sandbox_registry SET state=$3,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2
            AND state ${next === "remote" ? "IN ('ready','paused')" : "IN ('closing','pausing')"}`,
          [claim.tenantId, row.registry_id, registryState],
        );
        // cleanup 已经推进后，registry 未同步意味着两个持久事实源分叉。
        // 必须抛出使整个事务回滚，绝不能以 false 提交半个状态机。
        if (registry.rowCount !== 1) {
          throw new Error("Cleanup 与 Sandbox registry 状态同步失败");
        }
        return true;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }
}

function boundedText(value: string, maximum: number): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}
