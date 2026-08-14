import { randomUUID } from "node:crypto";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import type { SandboxProviderKey } from "@cube-runtime/sandbox";
import type { Pool } from "pg";
import { withTenantTransaction } from "./postgres.js";

export interface ThreadSandboxLifecycleClaim {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly effectId: string;
  readonly effectKind: "pause" | "resume" | "terminate";
  readonly providerKey: SandboxProviderKey;
  readonly providerSandboxId: string;
  readonly mode: "execute" | "reconcile";
  readonly token: string;
  readonly claimGeneration: number;
}

export type ThreadSandboxLifecycleResolution =
  | "paused"
  | "terminated"
  | "unknown"
  | "retry_pause"
  | "retry_terminate";

/** Scheduler 的单租户 effect/retention store；UNKNOWN 只查询对账，不重放原 effect。 */
export class PgThreadSandboxLifecycleConsumerStore {
  constructor(
    private readonly pool: Pool,
    private readonly pausedRetentionSeconds: number,
    private readonly retentionSchedulerEnabled: boolean,
  ) {
    if (
      !Number.isSafeInteger(pausedRetentionSeconds) ||
      pausedRetentionSeconds < 1 ||
      pausedRetentionSeconds > 31_536_000
    ) {
      throw new TypeError("pausedRetentionSeconds 无效");
    }
  }

  async claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<ThreadSandboxLifecycleClaim | undefined> {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        // 已越过 remote marker 的过期 started 绝不能重放；先固化 UNKNOWN 再参与 query 对账。
        const uncertain = await client.query<{
          session_id: string;
          generation: string;
          effect_id: string;
        }>(
          `UPDATE sandbox_lifecycle_effects
              SET state='unknown',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                  completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND state='started' AND remote_call_started_at IS NOT NULL
              AND claim_expires_at <= clock_timestamp()
            RETURNING session_id,generation::text,effect_id`,
          [input.tenantId],
        );
        for (const row of uncertain.rows) {
          await client.query(
            `UPDATE thread_sandbox_sessions
                SET state='unknown',current_effect_id=$4,updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
                AND state IN ('pausing','resuming','paused','running')`,
            [input.tenantId, row.session_id, Number(row.generation), row.effect_id],
          );
        }

        if (this.retentionSchedulerEnabled) {
          const expired = await client.query<{
            session_id: string;
            generation: string;
            provider_key: SandboxProviderKey;
            provider_sandbox_id: string;
          }>(
            `SELECT session_id,generation::text,provider_key,provider_sandbox_id
               FROM thread_sandbox_sessions session
              WHERE tenant_id=$1 AND state='paused'
                AND retention_expires_at <= clock_timestamp()
                AND NOT EXISTS (
                  SELECT 1 FROM thread_sandbox_leases lease
                   WHERE lease.tenant_id=session.tenant_id AND lease.session_id=session.session_id
                     AND lease.released_at IS NULL
                )
              ORDER BY retention_expires_at FOR UPDATE SKIP LOCKED LIMIT 1`,
            [input.tenantId],
          );
          const row = expired.rows[0];
          if (row !== undefined) {
            const effectId = `sandbox-effect-${randomUUID()}`;
            const operationId = `retention/${row.session_id}/${row.generation}`;
            const effect = await client.query<{ effect_id: string }>(
              `INSERT INTO sandbox_lifecycle_effects(
                 tenant_id,effect_id,operation_id,request_digest,session_id,generation,
                 effect_kind,state,provider_key,provider_sandbox_id,expected_session_state
               ) VALUES ($1,$2,$3,$4,$5,$6,'terminate','pending',$7,$8,'paused')
               ON CONFLICT (tenant_id,operation_id) DO UPDATE
                 SET updated_at=sandbox_lifecycle_effects.updated_at
               RETURNING effect_id`,
              [
                input.tenantId,
                effectId,
                operationId,
                digestCanonical({ operationId }),
                row.session_id,
                Number(row.generation),
                row.provider_key,
                row.provider_sandbox_id,
              ],
            );
            const durableEffectId = effect.rows[0]?.effect_id;
            if (durableEffectId !== undefined) {
              // 没有 terminating 状态；到期 Session 先隔离，禁止新 Run 在 terminate effect
              // 完成前重新 resume 同一 provider ID。新 Run 可以从事实源 cold rebuild 新 generation。
              await client.query(
                `UPDATE thread_sandbox_sessions
                    SET state='unknown',current_effect_id=$4,updated_at=clock_timestamp()
                  WHERE tenant_id=$1 AND session_id=$2 AND generation=$3 AND state='paused'
                    AND NOT EXISTS (
                      SELECT 1 FROM thread_sandbox_leases lease
                       WHERE lease.tenant_id=$1 AND lease.session_id=$2
                         AND lease.released_at IS NULL
                    )`,
                [input.tenantId, row.session_id, Number(row.generation), durableEffectId],
              );
            }
          }
        }

        const candidate = await client.query<{
          session_id: string;
          generation: string;
          effect_id: string;
          effect_kind: "pause" | "resume" | "terminate";
          provider_key: SandboxProviderKey;
          provider_sandbox_id: string;
          state: "pending" | "started" | "unknown";
          claim_generation: string;
          thread_id: string;
          run_id: string | null;
        }>(
          `SELECT effect.session_id,effect.generation::text,effect.effect_id,effect.effect_kind,
                  session.provider_key,effect.provider_sandbox_id,effect.state,effect.claim_generation::text,
                  session.thread_id,effect.run_id
             FROM sandbox_lifecycle_effects effect
             JOIN thread_sandbox_sessions session
               ON session.tenant_id=effect.tenant_id AND session.session_id=effect.session_id
            WHERE effect.tenant_id=$1 AND effect.provider_sandbox_id IS NOT NULL
              AND (
                effect.state='pending'
                OR (effect.state='started' AND effect.remote_call_started_at IS NULL)
                OR effect.state='unknown'
              )
              AND (effect.claim_expires_at IS NULL OR effect.claim_expires_at <= clock_timestamp())
              AND (effect.state='unknown' OR effect.effect_kind IN ('pause','terminate'))
            ORDER BY CASE effect.state WHEN 'pending' THEN 0 WHEN 'started' THEN 1 ELSE 2 END,
                     effect.created_at
            FOR UPDATE OF effect SKIP LOCKED LIMIT 1`,
          [input.tenantId],
        );
        const row = candidate.rows[0];
        if (row === undefined) return undefined;
        const token = `sandbox-effect-claim-${randomUUID()}`;
        const claimed = await client.query(
          `UPDATE sandbox_lifecycle_effects
              SET state=CASE WHEN state='pending' THEN 'started' ELSE state END,
                  claim_token=$3,claimed_by=$4,claim_generation=claim_generation+1,
                  claim_expires_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
                  updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND effect_id=$2
              AND state IN ('pending','started','unknown')`,
          [input.tenantId, row.effect_id, token, input.workerId, input.leaseMs],
        );
        if (claimed.rowCount !== 1) return undefined;
        return {
          tenantId: input.tenantId,
          threadId: row.thread_id,
          ...(row.run_id === null ? {} : { runId: row.run_id }),
          sessionId: row.session_id,
          generation: Number(row.generation),
          effectId: row.effect_id,
          effectKind: row.effect_kind,
          providerKey: row.provider_key,
          providerSandboxId: row.provider_sandbox_id,
          mode: row.state === "unknown" ? "reconcile" : "execute",
          token,
          claimGeneration: Number(row.claim_generation) + 1,
        };
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  async markRemoteStarted(claim: ThreadSandboxLifecycleClaim): Promise<boolean> {
    if (claim.mode !== "execute") return false;
    return withTenantTransaction(this.pool, { tenantId: claim.tenantId }, async (client) => {
      const result = await client.query(
        `UPDATE sandbox_lifecycle_effects
            SET remote_call_started_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND effect_id=$2 AND session_id=$3 AND generation=$4
            AND state='started' AND claim_token=$5 AND claim_generation=$6
            AND claim_expires_at > clock_timestamp() AND remote_call_started_at IS NULL`,
        [
          claim.tenantId,
          claim.effectId,
          claim.sessionId,
          claim.generation,
          claim.token,
          claim.claimGeneration,
        ],
      );
      return result.rowCount === 1;
    });
  }

  async resolve(
    claim: ThreadSandboxLifecycleClaim,
    resolution: ThreadSandboxLifecycleResolution,
  ): Promise<boolean> {
    return withTenantTransaction(
      this.pool,
      { tenantId: claim.tenantId },
      async (client) => {
        const locked = await client.query<{ state: string }>(
          `SELECT state FROM sandbox_lifecycle_effects
            WHERE tenant_id=$1 AND effect_id=$2 AND session_id=$3 AND generation=$4
              AND claim_token=$5 AND claim_generation=$6
            FOR UPDATE`,
          [
            claim.tenantId,
            claim.effectId,
            claim.sessionId,
            claim.generation,
            claim.token,
            claim.claimGeneration,
          ],
        );
        if (locked.rows[0] === undefined) return false;
        if (resolution === "retry_pause" || resolution === "retry_terminate") {
          const nextKind = resolution === "retry_pause" ? "pause" : "terminate";
          const nextEffectId = `sandbox-effect-${randomUUID()}`;
          const operationId = `${claim.effectId}/reconcile/${claim.claimGeneration}`;
          await client.query(
            `UPDATE sandbox_lifecycle_effects
                SET state='failed_not_applied',claim_token=NULL,claimed_by=NULL,
                    claim_expires_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND effect_id=$2`,
            [claim.tenantId, claim.effectId],
          );
          await client.query(
            `INSERT INTO sandbox_lifecycle_effects(
               tenant_id,effect_id,operation_id,request_digest,session_id,generation,
               effect_kind,state,provider_sandbox_id,expected_session_state
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,'unknown')`,
            [
              claim.tenantId,
              nextEffectId,
              operationId,
              digestCanonical({ operationId }),
              claim.sessionId,
              claim.generation,
              nextKind,
              claim.providerSandboxId,
            ],
          );
          await client.query(
            `UPDATE thread_sandbox_sessions
                SET state='unknown',current_effect_id=$4,updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND session_id=$2 AND generation=$3`,
            [claim.tenantId, claim.sessionId, claim.generation, nextEffectId],
          );
          return true;
        }
        const effectState = resolution === "unknown" ? "unknown" : "succeeded";
        const effect = await client.query(
          `UPDATE sandbox_lifecycle_effects
              SET state=$7,resulting_session_state=$8,provider_receipt_digest=$9,
                  claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                  completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND effect_id=$2 AND session_id=$3 AND generation=$4
              AND claim_token=$5 AND claim_generation=$6`,
          [
            claim.tenantId,
            claim.effectId,
            claim.sessionId,
            claim.generation,
            claim.token,
            claim.claimGeneration,
            effectState,
            resolution === "paused" || resolution === "terminated" ? resolution : null,
            digestCanonical({ resolution }),
          ],
        );
        let sessionRowCount: number | null;
        if (resolution === "paused") {
          const session = await client.query(
            `UPDATE thread_sandbox_sessions
                SET state='paused',current_effect_id=NULL,paused_at=clock_timestamp(),
                    retention_expires_at=clock_timestamp()+($5::bigint*interval '1 second'),
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
                AND current_effect_id=$4`,
            [
              claim.tenantId,
              claim.sessionId,
              claim.generation,
              claim.effectId,
              this.pausedRetentionSeconds,
            ],
          );
          sessionRowCount = session.rowCount;
        } else if (resolution === "terminated") {
          const session = await client.query(
            `UPDATE thread_sandbox_sessions
                SET state='terminated',current_effect_id=NULL,terminated_at=clock_timestamp(),
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
                AND state IN ('paused','unknown','pausing','resuming')`,
            [claim.tenantId, claim.sessionId, claim.generation],
          );
          sessionRowCount = session.rowCount;
        } else {
          const session = await client.query(
            `UPDATE thread_sandbox_sessions
                SET state='unknown',current_effect_id=$4,updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
                AND state IN ('running','paused','pausing','resuming','unknown')`,
            [claim.tenantId, claim.sessionId, claim.generation, claim.effectId],
          );
          sessionRowCount = session.rowCount;
        }
        if (effect.rowCount !== 1 || sessionRowCount !== 1) {
          throw new Error("Thread Sandbox lifecycle consumer CAS 冲突");
        }
        return true;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }
}
