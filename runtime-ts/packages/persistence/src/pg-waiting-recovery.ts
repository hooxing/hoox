import { createHash, randomUUID } from "node:crypto";
import {
  isoTimestamp,
  runId,
  tenantId,
  threadId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import type { ExecutionScope } from "@cube-runtime/run-contracts";
import type { Pool, PoolClient } from "pg";
import { withTenantTransaction } from "./postgres.js";

export interface PgWaitingCheckpointInput {
  readonly scope: ExecutionScope;
  readonly attemptId: string;
  readonly checkpointId: string;
  readonly workspaceHeadAtWait:
    | { readonly outcome: "found"; readonly revisionId: string }
    | { readonly outcome: "empty" };
  readonly sandbox?: {
    readonly registryId: string;
    readonly providerSandboxId: string;
    readonly generation: number;
    readonly expectedGeneration: number;
    readonly lifecycle: string;
    readonly pausedAt: string;
    readonly expiresAt: string;
  };
}

interface RecoveryRow {
  state: "pending" | "claimed" | "effect_pending" | "resolved" | "unknown";
  tenant_id: string;
  checkpoint_id: string;
  attempt_id: string;
  run_id: string;
  thread_id: string;
  workspace_id: string;
  root_run_id: string;
  base_revision_id: string | null;
  workspace_head_state: "found" | "empty";
  workspace_head_revision_id: string | null;
  registry_id: string | null;
  provider_sandbox_id: string | null;
  sandbox_generation: string | null;
  sandbox_expected_generation: string | null;
  sandbox_lifecycle: string | null;
  sandbox_paused_at: Date | string | null;
  sandbox_expires_at: Date | string | null;
  claim_token: string | null;
  claim_epoch: string;
  database_now?: Date | string;
}

export interface PgWaitingRecoveryClaim {
  readonly claimToken: string;
  readonly claimEpoch: number;
  readonly databaseNow: ReturnType<typeof isoTimestamp>;
  readonly checkpoint: {
    readonly checkpointId: string;
    readonly scope: ExecutionScope;
    readonly workspaceHeadAtWait:
      | { readonly outcome: "found"; readonly revisionId: ReturnType<typeof workspaceRevisionId> }
      | { readonly outcome: "empty" };
    readonly sandbox?: {
      readonly registryId: string;
      readonly providerSandboxId: string;
      readonly tenantId: string;
      readonly threadId: string;
      readonly workspaceId: string;
      readonly baseRevisionId?: ReturnType<typeof workspaceRevisionId>;
      readonly generation: number;
      readonly expectedGeneration: number;
      readonly pausedAt: ReturnType<typeof isoTimestamp>;
      readonly expiresAt: ReturnType<typeof isoTimestamp>;
      readonly lifecycle:
        | "paused"
        | "pause_unknown"
        | "connect_unknown"
        | "create_unknown"
        | "materialize_unknown";
    };
  };
}

/** ADR-0033 的最小 PG 事实源；所有 lease/TTL 判断均使用数据库 clock_timestamp()。 */
export class PgWaitingRecoveryStore {
  constructor(
    private readonly pool: Pool,
    private readonly leaseSeconds = 30,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
      throw new TypeError("waiting recovery leaseSeconds 无效");
    }
  }

  async record(input: PgWaitingCheckpointInput): Promise<"created" | "already_exists" | "conflict"> {
    return withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      const sandbox = input.sandbox;
      const result = await client.query(
        `INSERT INTO waiting_recovery_checkpoints(
           tenant_id,checkpoint_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
           base_revision_id,workspace_head_state,workspace_head_revision_id,
           registry_id,provider_sandbox_id,sandbox_generation,sandbox_expected_generation,
           sandbox_lifecycle,sandbox_paused_at,sandbox_expires_at
         ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
           FROM execution_attempts attempt JOIN runs run
             ON run.tenant_id=attempt.tenant_id AND run.id=attempt.run_id
           JOIN workspaces workspace
             ON workspace.tenant_id=attempt.tenant_id AND workspace.id=attempt.workspace_id
            AND workspace.thread_id=attempt.thread_id
          WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$3 AND attempt.run_id=$4
            AND attempt.thread_id=$5 AND attempt.workspace_id=$6 AND attempt.root_run_id=$7
            AND attempt.base_revision_id IS NOT DISTINCT FROM $8
            AND attempt.status='waiting' AND run.status='waiting'
            AND (($9='found' AND workspace.current_revision_id=$10)
              OR ($9='empty' AND workspace.current_revision_id IS NULL))
            AND EXISTS (
              SELECT 1 FROM run_events event
               WHERE event.tenant_id=attempt.tenant_id AND event.attempt_id=attempt.attempt_id
                 AND event.kind='run_waiting' AND event.payload->>'checkpointId'=$2
            )
            AND EXISTS (
              SELECT 1 FROM runtime_rollout_checkpoints rollout_checkpoint
               WHERE rollout_checkpoint.tenant_id=attempt.tenant_id
                 AND rollout_checkpoint.attempt_id=attempt.attempt_id
                 AND rollout_checkpoint.checkpoint_id=$2
            )
         ON CONFLICT (tenant_id,checkpoint_id) DO NOTHING`,
        [
          input.scope.tenantId,
          input.checkpointId,
          input.attemptId,
          input.scope.runId,
          input.scope.threadId,
          input.scope.workspaceId,
          input.scope.rootRunId,
          input.scope.baseRevisionId ?? null,
          input.workspaceHeadAtWait.outcome,
          input.workspaceHeadAtWait.outcome === "found" ? input.workspaceHeadAtWait.revisionId : null,
          sandbox?.registryId ?? null,
          sandbox?.providerSandboxId ?? null,
          sandbox?.generation ?? null,
          sandbox?.expectedGeneration ?? null,
          sandbox?.lifecycle ?? null,
          sandbox?.pausedAt ?? null,
          sandbox?.expiresAt ?? null,
        ],
      );
      if (result.rowCount === 1) return "created";
      const existing = await this.lockByScope(client, input.scope, input.checkpointId);
      const same =
        existing !== undefined &&
        existing.workspace_head_state === input.workspaceHeadAtWait.outcome &&
        (existing.workspace_head_revision_id ?? undefined) ===
          (input.workspaceHeadAtWait.outcome === "found"
            ? input.workspaceHeadAtWait.revisionId
            : undefined) &&
        (existing.registry_id ?? undefined) === sandbox?.registryId &&
        (existing.provider_sandbox_id ?? undefined) === sandbox?.providerSandboxId &&
        (existing.sandbox_generation === null ? undefined : Number(existing.sandbox_generation)) ===
          sandbox?.generation &&
        (existing.sandbox_expected_generation === null
          ? undefined
          : Number(existing.sandbox_expected_generation)) === sandbox?.expectedGeneration &&
        (existing.sandbox_lifecycle ?? undefined) === sandbox?.lifecycle &&
        (existing.sandbox_paused_at === null
          ? undefined
          : new Date(existing.sandbox_paused_at).toISOString()) ===
          (sandbox === undefined ? undefined : new Date(sandbox.pausedAt).toISOString()) &&
        (existing.sandbox_expires_at === null
          ? undefined
          : new Date(existing.sandbox_expires_at).toISOString()) ===
          (sandbox === undefined ? undefined : new Date(sandbox.expiresAt).toISOString());
      return same ? "already_exists" : "conflict";
    });
  }

  async observeWorkspaceHead(scope: ExecutionScope): Promise<
    | { readonly outcome: "found"; readonly revisionId: ReturnType<typeof workspaceRevisionId> }
    | { readonly outcome: "empty" }
    | { readonly outcome: "unavailable" }
  > {
    try {
      return await withTenantTransaction(this.pool, { tenantId: scope.tenantId }, async (client) => {
        const result = await client.query<{ current_revision_id: string | null }>(
          `SELECT current_revision_id FROM workspaces
            WHERE tenant_id=$1 AND id=$2 AND thread_id=$3`,
          [scope.tenantId, scope.workspaceId, scope.threadId],
        );
        const row = result.rows[0];
        if (row === undefined) return { outcome: "unavailable" } as const;
        return row.current_revision_id === null
          ? ({ outcome: "empty" } as const)
          : ({ outcome: "found", revisionId: workspaceRevisionId(row.current_revision_id) } as const);
      });
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async claim(input: { readonly scope: ExecutionScope; readonly checkpointId: string; readonly workerId: string }) {
    const token = randomUUID();
    return withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      const result = await client.query<RecoveryRow>(
        `UPDATE waiting_recovery_checkpoints checkpoint SET
           state='claimed',claim_owner=$8,claim_token=$9,claim_epoch=claim_epoch+1,
           claim_expires_at=clock_timestamp()+make_interval(secs=>$10),updated_at=clock_timestamp()
         FROM runs run, execution_attempts attempt
         WHERE checkpoint.tenant_id=$1 AND checkpoint.checkpoint_id=$2
           AND checkpoint.run_id=$3 AND checkpoint.thread_id=$4 AND checkpoint.workspace_id=$5
           AND checkpoint.root_run_id=$6 AND checkpoint.base_revision_id IS NOT DISTINCT FROM $7
           AND run.tenant_id=checkpoint.tenant_id AND run.id=checkpoint.run_id AND run.status='waiting'
           AND attempt.tenant_id=checkpoint.tenant_id AND attempt.attempt_id=checkpoint.attempt_id
           AND attempt.status='waiting'
           AND (checkpoint.state='pending' OR
             (checkpoint.state='claimed' AND checkpoint.claim_expires_at<=clock_timestamp()))
         RETURNING checkpoint.*,clock_timestamp() AS database_now`,
        [
          input.scope.tenantId,
          input.checkpointId,
          input.scope.runId,
          input.scope.threadId,
          input.scope.workspaceId,
          input.scope.rootRunId,
          input.scope.baseRevisionId ?? null,
          input.workerId,
          token,
          this.leaseSeconds,
        ],
      );
      const row = result.rows[0];
      if (row !== undefined) return { outcome: "claimed" as const, claim: this.mapClaim(row) };
      const existing = await this.lockByScope(client, input.scope, input.checkpointId);
      if (existing === undefined) return { outcome: "not_found" as const };
      return {
        outcome:
          existing.state === "resolved" || existing.state === "unknown"
            ? ("resolved" as const)
            : ("busy" as const),
      };
    });
  }

  async beginEffect(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly decision: object;
    readonly observedWorkspaceHead:
      | { readonly outcome: "found"; readonly revisionId: string }
      | { readonly outcome: "empty" };
    readonly effect: "connect" | "create" | "materialize";
  }) {
    return withTenantTransaction(this.pool, { tenantId: input.claim.checkpoint.scope.tenantId }, async (client) => {
      const row = await this.lockClaim(client, input.claim);
      if (row === undefined) return { outcome: "claim_lost" as const };
      const head = await client.query<{ matches: boolean }>(
        `SELECT CASE WHEN $4='found' THEN current_revision_id=$5
                    ELSE current_revision_id IS NULL END AS matches
           FROM workspaces WHERE tenant_id=$1 AND id=$2 AND thread_id=$3 FOR UPDATE`,
        [
          row.tenant_id,
          row.workspace_id,
          row.thread_id,
          input.observedWorkspaceHead.outcome,
          input.observedWorkspaceHead.outcome === "found"
            ? input.observedWorkspaceHead.revisionId
            : null,
        ],
      );
      if (head.rows[0]?.matches !== true) return { outcome: "claim_lost" as const };
      const intentId = `waiting:${row.checkpoint_id}:${row.claim_epoch}:${input.effect}`;
      const inserted = await client.query(
        `INSERT INTO waiting_recovery_effect_outbox(
           tenant_id,checkpoint_id,intent_id,claim_epoch,effect,state,payload
         ) VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb)
         ON CONFLICT (tenant_id,checkpoint_id) DO NOTHING`,
        [
          row.tenant_id,
          row.checkpoint_id,
          intentId,
          row.claim_epoch,
          input.effect,
          JSON.stringify(input.decision),
        ],
      );
      if (inserted.rowCount !== 1) return { outcome: "already_started" as const };
      await client.query(
        `UPDATE waiting_recovery_checkpoints SET state='effect_pending',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [row.tenant_id, row.checkpoint_id],
      );
      return { outcome: "authorized" as const, intentId };
    });
  }

  async markUnknown(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly intentId: string;
    readonly effect: "connect" | "create" | "materialize";
  }) {
    return withTenantTransaction(this.pool, { tenantId: input.claim.checkpoint.scope.tenantId }, async (client) => {
      const row = await this.lockClaim(client, input.claim, false);
      if (row === undefined) return "claim_lost" as const;
      const decision = { outcome: "external_effect_unknown", effect: input.effect, requestAutomaticRetry: false };
      const updated = await client.query(
        `UPDATE waiting_recovery_effect_outbox SET state='unknown',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3 AND effect=$4 AND state='pending'`,
        [row.tenant_id, row.checkpoint_id, input.intentId, input.effect],
      );
      if (updated.rowCount !== 1) return "claim_lost" as const;
      await client.query(
        `UPDATE waiting_recovery_checkpoints SET state='unknown',decision=$3::jsonb,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [row.tenant_id, row.checkpoint_id, JSON.stringify(decision)],
      );
      return "unknown" as const;
    });
  }

  async completeEffect(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly intentId: string;
    readonly effect: "connect" | "create" | "materialize";
  }) {
    return withTenantTransaction(this.pool, { tenantId: input.claim.checkpoint.scope.tenantId }, async (client) => {
      const row = await this.lockClaim(client, input.claim);
      if (row === undefined) return "claim_lost" as const;
      const updated = await client.query(
        `UPDATE waiting_recovery_effect_outbox SET state='completed',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3 AND effect=$4 AND state='pending'`,
        [row.tenant_id, row.checkpoint_id, input.intentId, input.effect],
      );
      return updated.rowCount === 1 ? ("completed" as const) : ("claim_lost" as const);
    });
  }

  /** intent 已提交但 Worker 消失时，过期租约只能收敛为 UNKNOWN，绝不重新投递副作用。 */
  async reconcileExpiredEffect(scope: ExecutionScope, checkpointId: string) {
    return withTenantTransaction(this.pool, { tenantId: scope.tenantId }, async (client) => {
      const row = await this.lockByScope(client, scope, checkpointId);
      if (
        row === undefined ||
        row.state !== "effect_pending" ||
        row.claim_token === null
      ) {
        return "unchanged" as const;
      }
      const expired = await client.query<{ expired: boolean; effect: "connect" | "create" | "materialize" }>(
        `SELECT checkpoint.claim_expires_at<=clock_timestamp() AS expired,effect.effect
           FROM waiting_recovery_checkpoints checkpoint
           JOIN waiting_recovery_effect_outbox effect USING(tenant_id,checkpoint_id)
          WHERE checkpoint.tenant_id=$1 AND checkpoint.checkpoint_id=$2
            AND effect.state='pending' FOR UPDATE OF effect`,
        [scope.tenantId, checkpointId],
      );
      const fact = expired.rows[0];
      if (fact?.expired !== true) return "unchanged" as const;
      const decision = {
        outcome: "external_effect_unknown",
        effect: fact.effect,
        requestAutomaticRetry: false,
      };
      await client.query(
        `UPDATE waiting_recovery_effect_outbox SET state='unknown',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND state='pending'`,
        [scope.tenantId, checkpointId],
      );
      await client.query(
        `UPDATE waiting_recovery_checkpoints SET state='unknown',decision=$3::jsonb,
           updated_at=clock_timestamp() WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, checkpointId, JSON.stringify(decision)],
      );
      return "unknown" as const;
    });
  }

  async resolve(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly decision: object;
    readonly sandboxFact?: object;
  }) {
    return withTenantTransaction(this.pool, { tenantId: input.claim.checkpoint.scope.tenantId }, async (client) => {
      const row = await this.lockClaim(client, input.claim, false);
      if (row === undefined) return "claim_lost" as const;
      const existing = await client.query<{ state: string }>(
        `SELECT state FROM waiting_recovery_checkpoints WHERE tenant_id=$1 AND checkpoint_id=$2 FOR UPDATE`,
        [row.tenant_id, row.checkpoint_id],
      );
      if (existing.rows[0]?.state === "resolved") return "already_resolved" as const;
      if (input.sandboxFact !== undefined) {
        const factKind = (input.sandboxFact as { kind?: string }).kind;
        const requiredEffects =
          factKind === "sandbox_reused" ? ["connect"] : ["create", "materialize"];
        const effects = await client.query<{ effect: string; state: string }>(
          `SELECT effect,state FROM waiting_recovery_effect_outbox
            WHERE tenant_id=$1 AND checkpoint_id=$2 FOR UPDATE`,
          [row.tenant_id, row.checkpoint_id],
        );
        if (
          requiredEffects.some(
            (required) =>
              !effects.rows.some((effect) => effect.effect === required && effect.state === "completed"),
          )
        ) {
          return "claim_lost" as const;
        }
        await this.appendFacts(client, row, input.sandboxFact);
      }
      await client.query(
        `UPDATE waiting_recovery_checkpoints SET state='resolved',decision=$3::jsonb,
           claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [row.tenant_id, row.checkpoint_id, JSON.stringify(input.decision)],
      );
      return "resolved" as const;
    });
  }

  private async appendFacts(client: PoolClient, row: RecoveryRow, fact: object): Promise<void> {
    const raw = fact as { kind?: string; registryId?: string; generation?: number; reason?: string };
    const eventFact =
      raw.kind === "sandbox_reused"
        ? {
            decision: raw.kind,
            checkpointId: row.checkpoint_id,
            registryId: raw.registryId,
            generation: raw.generation,
          }
        : raw.kind === "sandbox_rebuilt"
          ? { decision: raw.kind, checkpointId: row.checkpoint_id, reason: raw.reason }
          : fact;
    const attempt = await client.query<{ next_event_sequence: string }>(
      `SELECT next_event_sequence FROM execution_attempts
        WHERE tenant_id=$1 AND attempt_id=$2 AND status='waiting' FOR UPDATE`,
      [row.tenant_id, row.attempt_id],
    );
    const sequence = Number(attempt.rows[0]?.next_event_sequence);
    if (!Number.isSafeInteger(sequence)) throw new Error("waiting Attempt 已丢失");
    await client.query(
      `INSERT INTO run_events(tenant_id,attempt_id,sequence,schema_version,kind,payload)
       VALUES($1,$2,$3,1,'sandbox_recovery_decided',$4::jsonb)`,
      [row.tenant_id, row.attempt_id, sequence, JSON.stringify(eventFact)],
    );
    await client.query(
      `UPDATE execution_attempts SET next_event_sequence=next_event_sequence+1,version=version+1,
         updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2`,
      [row.tenant_id, row.attempt_id],
    );
    const stream = await client.query<{ agent_thread_id: string }>(
      `SELECT agent_thread_id FROM runtime_rollout_streams
        WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE`,
      [row.tenant_id, row.attempt_id],
    );
    const rollout = stream.rows[0];
    if (rollout === undefined) throw new Error("waiting Rollout stream 已丢失");
    const tail = await client.query<{
      sequence: string;
      kind: string;
      normalized_tool_call_id: string;
    }>(
      `SELECT sequence::text,kind,normalized_tool_call_id FROM runtime_rollout_entries
        WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3
        ORDER BY sequence DESC LIMIT 1`,
      [row.tenant_id, row.attempt_id, rollout.agent_thread_id],
    );
    const previous = tail.rows[0];
    const rolloutSequence = previous === undefined ? 0 : Number(previous.sequence) + 1;
    const body = JSON.stringify(eventFact);
    const digest = createHash("sha256").update(body).digest("hex");
    await client.query(
      `INSERT INTO runtime_rollout_entries(
         tenant_id,thread_id,run_id,attempt_id,agent_thread_id,sequence,kind,
         previous_sequence,previous_kind,previous_tool_call_id,body,body_digest,is_truncated
       ) VALUES($1,$2,$3,$4,$5,$6,'sandbox_recovery',$7,$8,$9,$10::jsonb,$11,false)`,
      [
        row.tenant_id,row.thread_id,row.run_id,row.attempt_id,rollout.agent_thread_id,rolloutSequence,
        rolloutSequence === 0 ? null : rolloutSequence - 1,
        previous?.kind ?? null,
        previous?.normalized_tool_call_id ?? null,
        body,digest,
      ],
    );
  }

  private async lockByScope(client: PoolClient, scope: ExecutionScope, checkpointId: string) {
    const result = await client.query<RecoveryRow>(
      `SELECT * FROM waiting_recovery_checkpoints WHERE tenant_id=$1 AND checkpoint_id=$2
        AND run_id=$3 AND thread_id=$4 AND workspace_id=$5 AND root_run_id=$6
        AND base_revision_id IS NOT DISTINCT FROM $7 FOR UPDATE`,
      [scope.tenantId, checkpointId, scope.runId, scope.threadId, scope.workspaceId, scope.rootRunId, scope.baseRevisionId ?? null],
    );
    return result.rows[0];
  }

  private async lockClaim(client: PoolClient, claim: PgWaitingRecoveryClaim, requireLease = true) {
    const result = await client.query<RecoveryRow>(
      `SELECT * FROM waiting_recovery_checkpoints WHERE tenant_id=$1 AND checkpoint_id=$2
        AND run_id=$3 AND thread_id=$4 AND workspace_id=$5 AND root_run_id=$6
        AND base_revision_id IS NOT DISTINCT FROM $7 AND claim_token=$8 AND claim_epoch=$9
        AND state IN ('claimed','effect_pending')
        ${requireLease ? "AND claim_expires_at>clock_timestamp()" : ""} FOR UPDATE`,
      [claim.checkpoint.scope.tenantId, claim.checkpoint.checkpointId, claim.checkpoint.scope.runId,
        claim.checkpoint.scope.threadId, claim.checkpoint.scope.workspaceId, claim.checkpoint.scope.rootRunId,
        claim.checkpoint.scope.baseRevisionId ?? null, claim.claimToken, claim.claimEpoch],
    );
    return result.rows[0];
  }

  private mapClaim(row: RecoveryRow): PgWaitingRecoveryClaim {
    if (row.database_now === undefined) throw new Error("waiting claim 缺少数据库时间");
    const scope: ExecutionScope = {
      tenantId: tenantId(row.tenant_id), threadId: threadId(row.thread_id), runId: runId(row.run_id),
      rootRunId: runId(row.root_run_id), workspaceId: workspaceId(row.workspace_id),
      ...(row.base_revision_id === null ? {} : { baseRevisionId: workspaceRevisionId(row.base_revision_id) }),
    };
    return {
      claimToken: row.claim_token ?? "",
      claimEpoch: Number(row.claim_epoch),
      databaseNow: isoTimestamp(new Date(row.database_now).toISOString()),
      checkpoint: {
        checkpointId: row.checkpoint_id,
        scope,
        workspaceHeadAtWait: row.workspace_head_state === "found"
          ? { outcome: "found" as const, revisionId: workspaceRevisionId(row.workspace_head_revision_id ?? "") }
          : { outcome: "empty" as const },
        ...(row.registry_id === null ? {} : { sandbox: {
          registryId: row.registry_id, providerSandboxId: row.provider_sandbox_id ?? "",
          tenantId: row.tenant_id, threadId: row.thread_id, workspaceId: row.workspace_id,
          ...(row.base_revision_id === null ? {} : { baseRevisionId: workspaceRevisionId(row.base_revision_id) }),
          generation: Number(row.sandbox_generation), expectedGeneration: Number(row.sandbox_expected_generation),
          pausedAt: isoTimestamp(new Date(row.sandbox_paused_at ?? "").toISOString()),
          expiresAt: isoTimestamp(new Date(row.sandbox_expires_at ?? "").toISOString()),
          lifecycle: row.sandbox_lifecycle as
            | "paused"
            | "pause_unknown"
            | "connect_unknown"
            | "create_unknown"
            | "materialize_unknown",
        } }),
      },
    };
  }
}
