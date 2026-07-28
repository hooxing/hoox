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
  claim_expires_at: Date | string | null;
  database_now?: Date | string;
}

type RecoveryEffect = "connect" | "create" | "materialize";
interface SandboxProof {
  readonly registryId: string;
  readonly providerSandboxId: string;
  readonly generation: number;
}
type SandboxRecoveryFact =
  | { readonly kind: "sandbox_reused"; readonly registryId: string; readonly generation: number }
  | {
      readonly kind: "sandbox_rebuilt";
      readonly reason:
        | "missing"
        | "ttl_expired"
        | "generation_mismatch"
        | "scope_mismatch"
        | "base_revision_mismatch";
    };
type StrictDecision =
  | {
      readonly outcome: "resume";
      readonly workspace: "unchanged" | "replan";
      readonly sandbox:
        | {
            readonly kind: "sandbox_reused";
            readonly registryId: string;
            readonly generation: number;
          }
        | {
            readonly kind: "sandbox_rebuilt";
            readonly reason:
              | "missing"
              | "ttl_expired"
              | "generation_mismatch"
              | "scope_mismatch"
              | "base_revision_mismatch";
          };
    }
  | { readonly outcome: "workspace_head_unavailable"; readonly requestAutomaticRetry: false }
  | {
      readonly outcome: "workspace_conflict";
      readonly expectedHead?: string;
      readonly actualHead?: string;
    }
  | {
      readonly outcome: "external_effect_unknown";
      readonly effect: RecoveryEffect | "pause";
      readonly requestAutomaticRetry: false;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isSafePositiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function assertSandboxProof(value: unknown): asserts value is SandboxProof {
  if (!isPlainRecord(value)) throw new TypeError("Sandbox 副作用证明无效");
  if (
    !isNonEmptyIdentifier(value.registryId) ||
    !isNonEmptyIdentifier(value.providerSandboxId) ||
    !isSafePositiveGeneration(value.generation)
  ) {
    throw new TypeError("Sandbox 副作用证明无效");
  }
}

function parseStoredProof(payload: unknown): SandboxProof {
  if (!isPlainRecord(payload)) throw new TypeError("Sandbox 副作用 outbox 载荷无效");
  const proof = payload.proof;
  assertSandboxProof(proof);
  return proof;
}

function sameProof(left: SandboxProof, right: SandboxProof): boolean {
  return (
    left.registryId === right.registryId &&
    left.providerSandboxId === right.providerSandboxId &&
    left.generation === right.generation
  );
}

/** 将公共方法收到的 JSON 决策收紧为迁移能够持久化的恢复语义。 */
function assertStrictDecision(value: object): StrictDecision {
  if (!isPlainRecord(value) || typeof value.outcome !== "string") {
    throw new TypeError("waiting 恢复决策无效");
  }
  if (value.outcome === "workspace_head_unavailable") {
    if (value.requestAutomaticRetry !== false) throw new TypeError("Workspace 不可用决策无效");
    return { outcome: value.outcome, requestAutomaticRetry: false };
  }
  if (value.outcome === "workspace_conflict") {
    if (
      (value.expectedHead !== undefined && typeof value.expectedHead !== "string") ||
      (value.actualHead !== undefined && typeof value.actualHead !== "string")
    ) {
      throw new TypeError("Workspace 冲突决策无效");
    }
    return {
      outcome: value.outcome,
      ...(value.expectedHead === undefined ? {} : { expectedHead: value.expectedHead }),
      ...(value.actualHead === undefined ? {} : { actualHead: value.actualHead }),
    };
  }
  if (value.outcome === "external_effect_unknown") {
    if (
      !["pause", "connect", "create", "materialize"].includes(value.effect as string) ||
      value.requestAutomaticRetry !== false
    ) {
      throw new TypeError("未知外部副作用决策无效");
    }
    return {
      outcome: value.outcome,
      effect: value.effect as RecoveryEffect | "pause",
      requestAutomaticRetry: false,
    };
  }
  if (
    value.outcome !== "resume" ||
    (value.workspace !== "unchanged" && value.workspace !== "replan")
  ) {
    throw new TypeError("恢复决策无效");
  }
  if (!isPlainRecord(value.sandbox) || typeof value.sandbox.kind !== "string") {
    throw new TypeError("Sandbox 恢复计划无效");
  }
  if (value.sandbox.kind === "sandbox_reused") {
    if (
      !isNonEmptyIdentifier(value.sandbox.registryId) ||
      !isSafePositiveGeneration(value.sandbox.generation)
    ) {
      throw new TypeError("Sandbox 复用计划无效");
    }
    return {
      outcome: "resume",
      workspace: value.workspace,
      sandbox: {
        kind: value.sandbox.kind,
        registryId: value.sandbox.registryId,
        generation: value.sandbox.generation,
      },
    };
  }
  if (
    value.sandbox.kind !== "sandbox_rebuilt" ||
    ![
      "missing",
      "ttl_expired",
      "generation_mismatch",
      "scope_mismatch",
      "base_revision_mismatch",
    ].includes(value.sandbox.reason as string)
  ) {
    throw new TypeError("Sandbox 重建计划无效");
  }
  return {
    outcome: "resume",
    workspace: value.workspace,
    sandbox: {
      kind: value.sandbox.kind,
      reason: value.sandbox.reason as Extract<
        SandboxRecoveryFact,
        { kind: "sandbox_rebuilt" }
      >["reason"],
    },
  };
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

  async record(
    input: PgWaitingCheckpointInput,
  ): Promise<"created" | "already_exists" | "conflict"> {
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
          input.workspaceHeadAtWait.outcome === "found"
            ? input.workspaceHeadAtWait.revisionId
            : null,
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

  async observeWorkspaceHead(
    scope: ExecutionScope,
  ): Promise<
    | { readonly outcome: "found"; readonly revisionId: ReturnType<typeof workspaceRevisionId> }
    | { readonly outcome: "empty" }
    | { readonly outcome: "unavailable" }
  > {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: scope.tenantId },
        async (client) => {
          const result = await client.query<{ current_revision_id: string | null }>(
            `SELECT current_revision_id FROM workspaces
            WHERE tenant_id=$1 AND id=$2 AND thread_id=$3`,
            [scope.tenantId, scope.workspaceId, scope.threadId],
          );
          const row = result.rows[0];
          if (row === undefined) return { outcome: "unavailable" } as const;
          return row.current_revision_id === null
            ? ({ outcome: "empty" } as const)
            : ({
                outcome: "found",
                revisionId: workspaceRevisionId(row.current_revision_id),
              } as const);
        },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async claim(input: {
    readonly scope: ExecutionScope;
    readonly checkpointId: string;
    readonly workerId: string;
  }) {
    const token = randomUUID();
    return withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      const existing = await this.lockByScope(client, input.scope, input.checkpointId);
      if (existing === undefined) return { outcome: "not_found" as const };
      const state = await client.query<{ database_now: Date; waiting: boolean }>(
        `SELECT clock_timestamp() AS database_now,
          EXISTS(SELECT 1 FROM runs run JOIN execution_attempts attempt
            ON attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
           WHERE run.tenant_id=$1 AND run.id=$2 AND run.status='waiting'
             AND attempt.attempt_id=$3 AND attempt.status='waiting') AS waiting`,
        [existing.tenant_id, existing.run_id, existing.attempt_id],
      );
      const databaseNow = state.rows[0]?.database_now;
      if (databaseNow === undefined || state.rows[0]?.waiting !== true) {
        return { outcome: "resolved" as const };
      }
      if (existing.state === "resolved" || existing.state === "unknown") {
        return { outcome: "resolved" as const };
      }
      const leaseExpired =
        existing.claim_expires_at !== null &&
        new Date(existing.claim_expires_at).getTime() <= databaseNow.getTime();
      if (existing.state === "effect_pending") {
        if (!leaseExpired) return { outcome: "busy" as const };
        const pending = await client.query<{ effect: RecoveryEffect }>(
          `SELECT effect FROM waiting_recovery_effect_outbox
            WHERE tenant_id=$1 AND checkpoint_id=$2 AND state='pending' FOR UPDATE`,
          [existing.tenant_id, existing.checkpoint_id],
        );
        if (pending.rows[0] !== undefined) {
          await this.persistUnknown(client, existing, pending.rows[0].effect);
          return { outcome: "resolved" as const };
        }
      } else if (existing.state === "claimed" && !leaseExpired) {
        return { outcome: "busy" as const };
      }
      const result = await client.query<RecoveryRow>(
        `UPDATE waiting_recovery_checkpoints SET state='claimed',claim_owner=$3,claim_token=$4,
           claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+make_interval(secs=>$5),
           updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2
          RETURNING *,clock_timestamp() AS database_now`,
        [existing.tenant_id, existing.checkpoint_id, input.workerId, token, this.leaseSeconds],
      );
      const row = result.rows[0];
      if (row === undefined) return { outcome: "busy" as const };
      return { outcome: "claimed" as const, claim: this.mapClaim(row) };
    });
  }

  async beginEffect(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly decision: object;
    readonly observedWorkspaceHead:
      | { readonly outcome: "found"; readonly revisionId: string }
      | { readonly outcome: "empty" };
    readonly effect: RecoveryEffect;
  }) {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.claim.checkpoint.scope.tenantId },
      async (client) => {
        const row = await this.lockClaim(client, input.claim);
        if (row === undefined) return { outcome: "claim_lost" as const };
        const decision = assertStrictDecision(input.decision);
        if (decision.outcome !== "resume") {
          throw new TypeError("非 resume 决策不能授权 Sandbox 副作用");
        }
        const expectedEffects =
          decision.sandbox.kind === "sandbox_reused"
            ? (["connect"] as const)
            : (["create", "materialize"] as const);
        if (!(expectedEffects as readonly RecoveryEffect[]).includes(input.effect)) {
          throw new TypeError("Sandbox 副作用与恢复计划不匹配");
        }
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
        if (input.effect === "connect") {
          const reusable = await client.query(
            `SELECT 1 FROM sandbox_registry registry
              WHERE registry.tenant_id=$1 AND registry.registry_id=$2
                AND registry.provider_sandbox_id=$3 AND registry.attempt_id=$4
                AND registry.state='paused' AND registry.generation=$5
                AND $5=$6 AND $7>clock_timestamp()`,
            [
              row.tenant_id,
              row.registry_id,
              row.provider_sandbox_id,
              row.attempt_id,
              row.sandbox_generation,
              row.sandbox_expected_generation,
              row.sandbox_expires_at,
            ],
          );
          if (reusable.rowCount !== 1) return { outcome: "claim_lost" as const };
        }
        const prior = await client.query<{ state: string; payload: unknown }>(
          `SELECT state,payload FROM waiting_recovery_effect_outbox
            WHERE tenant_id=$1 AND checkpoint_id=$2 AND effect=$3 FOR UPDATE`,
          [row.tenant_id, row.checkpoint_id, input.effect],
        );
        const priorRow = prior.rows[0];
        if (priorRow?.state === "completed") {
          return {
            outcome: "already_completed" as const,
            proof: parseStoredProof(priorRow.payload),
          };
        }
        if (priorRow !== undefined) return { outcome: "already_started" as const };
        let priorProof: SandboxProof | undefined;
        if (input.effect === "materialize") {
          const create = await client.query<{ payload: unknown }>(
            `SELECT payload FROM waiting_recovery_effect_outbox
              WHERE tenant_id=$1 AND checkpoint_id=$2 AND effect='create' AND state='completed'`,
            [row.tenant_id, row.checkpoint_id],
          );
          if (create.rows[0] === undefined) return { outcome: "claim_lost" as const };
          priorProof = parseStoredProof(create.rows[0].payload);
        }
        const intentId = `waiting:${row.checkpoint_id}:${row.claim_epoch}:${input.effect}`;
        const inserted = await client.query(
          `INSERT INTO waiting_recovery_effect_outbox(
           tenant_id,checkpoint_id,intent_id,claim_epoch,effect,state,payload
         ) VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb)
         ON CONFLICT (tenant_id,checkpoint_id,effect) DO NOTHING`,
          [
            row.tenant_id,
            row.checkpoint_id,
            intentId,
            row.claim_epoch,
            input.effect,
            JSON.stringify({ plan: decision }),
          ],
        );
        if (inserted.rowCount !== 1) return { outcome: "already_started" as const };
        await client.query(
          `UPDATE waiting_recovery_checkpoints SET state='effect_pending',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
          [row.tenant_id, row.checkpoint_id],
        );
        return {
          outcome: "authorized" as const,
          intentId,
          ...(priorProof === undefined ? {} : { priorProof }),
        };
      },
    );
  }

  async markUnknown(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly intentId: string;
    readonly effect: "connect" | "create" | "materialize";
  }) {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.claim.checkpoint.scope.tenantId },
      async (client) => {
        const row = await this.lockClaim(client, input.claim, false);
        if (row === undefined) return "claim_lost" as const;
        const decision = {
          outcome: "external_effect_unknown",
          effect: input.effect,
          requestAutomaticRetry: false,
        };
        const updated = await client.query(
          `UPDATE waiting_recovery_effect_outbox SET state='unknown',
             payload=payload||jsonb_build_object('unknownEffect',$5::text),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3 AND effect=$4 AND state='pending'`,
          [row.tenant_id, row.checkpoint_id, input.intentId, input.effect, input.effect],
        );
        if (updated.rowCount !== 1) return "claim_lost" as const;
        await client.query(
          `UPDATE waiting_recovery_checkpoints SET state='unknown',decision=$3::jsonb,
             claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
          [row.tenant_id, row.checkpoint_id, JSON.stringify(decision)],
        );
        return "unknown" as const;
      },
    );
  }

  async completeEffect(input: {
    readonly claim: PgWaitingRecoveryClaim;
    readonly intentId: string;
    readonly effect: RecoveryEffect;
    readonly proof: SandboxProof;
  }) {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.claim.checkpoint.scope.tenantId },
      async (client) => {
        const row = await this.lockClaim(client, input.claim);
        if (row === undefined) return "claim_lost" as const;
        assertSandboxProof(input.proof);
        if (input.effect === "connect") {
          // 先把 provider 回执绑定到 checkpoint 的可信身份，再允许改变 registry 状态。
          // 不能让持有本 checkpoint claim 的调用者借错误 proof 修改同 Attempt 的其他 Sandbox。
          if (
            input.proof.registryId !== row.registry_id ||
            input.proof.providerSandboxId !== row.provider_sandbox_id ||
            input.proof.generation !== Number(row.sandbox_generation)
          ) {
            return "claim_lost" as const;
          }
          const connected = await client.query(
            `UPDATE sandbox_registry SET state='ready',updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND registry_id=$2 AND provider_sandbox_id=$3
                AND attempt_id=$4 AND generation=$5 AND state='paused'`,
            [
              row.tenant_id,
              row.registry_id,
              row.provider_sandbox_id,
              row.attempt_id,
              row.sandbox_generation,
            ],
          );
          if (connected.rowCount !== 1) return "claim_lost" as const;
        } else if (input.effect === "create") {
          const created = await client.query(
            `INSERT INTO sandbox_registry(
               tenant_id,registry_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
               provider_sandbox_id,request_id,state,actual_ttl_seconds,generation
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',600,$10)
             ON CONFLICT DO NOTHING`,
            [
              row.tenant_id,
              input.proof.registryId,
              row.attempt_id,
              row.run_id,
              row.thread_id,
              row.workspace_id,
              row.root_run_id,
              input.proof.providerSandboxId,
              input.intentId,
              input.proof.generation,
            ],
          );
          if (created.rowCount !== 1) return "claim_lost" as const;
        } else {
          const createProof = await client.query<{ payload: unknown }>(
            `SELECT payload FROM waiting_recovery_effect_outbox
              WHERE tenant_id=$1 AND checkpoint_id=$2 AND effect='create' AND state='completed'`,
            [row.tenant_id, row.checkpoint_id],
          );
          if (
            createProof.rows[0] === undefined ||
            !sameProof(parseStoredProof(createProof.rows[0].payload), input.proof)
          ) {
            return "claim_lost" as const;
          }
          const registered = await client.query(
            `SELECT 1 FROM sandbox_registry WHERE tenant_id=$1 AND registry_id=$2
              AND provider_sandbox_id=$3 AND generation=$4 AND state='ready'`,
            [
              row.tenant_id,
              input.proof.registryId,
              input.proof.providerSandboxId,
              input.proof.generation,
            ],
          );
          if (registered.rowCount !== 1) return "claim_lost" as const;
        }
        const updated = await client.query(
          `UPDATE waiting_recovery_effect_outbox SET state='completed',
             payload=payload||jsonb_build_object('proof',$5::jsonb),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND intent_id=$3 AND effect=$4 AND state='pending'`,
          [
            row.tenant_id,
            row.checkpoint_id,
            input.intentId,
            input.effect,
            JSON.stringify(input.proof),
          ],
        );
        return updated.rowCount === 1 ? ("completed" as const) : ("claim_lost" as const);
      },
    );
  }

  /** intent 已提交但 Worker 消失时，过期租约只能收敛为 UNKNOWN，绝不重新投递副作用。 */
  async reconcileExpiredEffect(scope: ExecutionScope, checkpointId: string) {
    return withTenantTransaction(this.pool, { tenantId: scope.tenantId }, async (client) => {
      const row = await this.lockByScope(client, scope, checkpointId);
      if (row === undefined || row.state !== "effect_pending" || row.claim_token === null) {
        return "unchanged" as const;
      }
      const expired = await client.query<{
        expired: boolean;
        effect: "connect" | "create" | "materialize";
      }>(
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
        `UPDATE waiting_recovery_effect_outbox SET state='unknown',
           payload=payload||jsonb_build_object('unknownEffect',effect),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2 AND state='pending'`,
        [scope.tenantId, checkpointId],
      );
      await client.query(
        `UPDATE waiting_recovery_checkpoints SET state='unknown',decision=$3::jsonb,
           claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,
           updated_at=clock_timestamp() WHERE tenant_id=$1 AND checkpoint_id=$2`,
        [scope.tenantId, checkpointId, JSON.stringify(decision)],
      );
      return "unknown" as const;
    });
  }

  async resolve(input: { readonly claim: PgWaitingRecoveryClaim; readonly decision: object }) {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.claim.checkpoint.scope.tenantId },
      async (client) => {
        const row = await this.lockClaim(client, input.claim, false);
        if (row === undefined) return "claim_lost" as const;
        const existing = await client.query<{ state: string }>(
          `SELECT state FROM waiting_recovery_checkpoints WHERE tenant_id=$1 AND checkpoint_id=$2 FOR UPDATE`,
          [row.tenant_id, row.checkpoint_id],
        );
        if (existing.rows[0]?.state === "resolved") return "already_resolved" as const;
        const decision = assertStrictDecision(input.decision);
        const fact = await this.recoveryFactForDecision(client, row, decision);
        if (fact === "missing_proof") return "claim_lost" as const;
        if (fact !== undefined) await this.appendFacts(client, row, fact);
        await client.query(
          `UPDATE waiting_recovery_checkpoints SET state='resolved',decision=$3::jsonb,
           claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND checkpoint_id=$2`,
          [row.tenant_id, row.checkpoint_id, JSON.stringify(decision)],
        );
        return "resolved" as const;
      },
    );
  }

  private async appendFacts(client: PoolClient, row: RecoveryRow, fact: object): Promise<void> {
    const raw = fact as {
      kind?: string;
      registryId?: string;
      generation?: number;
      reason?: string;
    };
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
        row.tenant_id,
        row.thread_id,
        row.run_id,
        row.attempt_id,
        rollout.agent_thread_id,
        rolloutSequence,
        rolloutSequence === 0 ? null : rolloutSequence - 1,
        previous?.kind ?? null,
        previous?.normalized_tool_call_id ?? null,
        body,
        digest,
      ],
    );
  }

  /**
   * 公共仓储不接收调用方声称的恢复事实：只有当前决定与已完成 outbox 证明相互印证时才生成事件。
   * 这避免任意调用者借由 resolve 把“复用/重建成功”伪造成可见审计事实。
   */
  private async recoveryFactForDecision(
    client: PoolClient,
    row: RecoveryRow,
    decision: StrictDecision,
  ): Promise<SandboxRecoveryFact | undefined | "missing_proof"> {
    if (decision.outcome !== "resume") return undefined;
    const completed = await client.query<{ effect: RecoveryEffect; payload: unknown }>(
      `SELECT effect,payload FROM waiting_recovery_effect_outbox
        WHERE tenant_id=$1 AND checkpoint_id=$2 AND state='completed' FOR UPDATE`,
      [row.tenant_id, row.checkpoint_id],
    );
    const proofFor = (effect: RecoveryEffect): SandboxProof | undefined => {
      const record = completed.rows.find((item) => item.effect === effect);
      return record === undefined ? undefined : parseStoredProof(record.payload);
    };
    if (decision.sandbox.kind === "sandbox_reused") {
      const proof = proofFor("connect");
      if (
        proof === undefined ||
        proof.registryId !== decision.sandbox.registryId ||
        proof.generation !== decision.sandbox.generation ||
        proof.registryId !== row.registry_id ||
        proof.providerSandboxId !== row.provider_sandbox_id ||
        proof.generation !== Number(row.sandbox_generation)
      ) {
        return "missing_proof";
      }
      return {
        kind: "sandbox_reused",
        registryId: proof.registryId,
        generation: proof.generation,
      };
    }
    const create = proofFor("create");
    const materialize = proofFor("materialize");
    if (create === undefined || materialize === undefined || !sameProof(create, materialize)) {
      return "missing_proof";
    }
    return { kind: "sandbox_rebuilt", reason: decision.sandbox.reason };
  }

  /** effect_pending 的租约一旦过期，副作用是否已抵达外部系统已无法证明，只能终止自动恢复。 */
  private async persistUnknown(
    client: PoolClient,
    row: RecoveryRow,
    effect: RecoveryEffect,
  ): Promise<void> {
    const decision = {
      outcome: "external_effect_unknown",
      effect,
      requestAutomaticRetry: false,
    } as const;
    await client.query(
      `UPDATE waiting_recovery_effect_outbox SET state='unknown',
         payload=payload||jsonb_build_object('unknownEffect',effect),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND checkpoint_id=$2 AND effect=$3 AND state='pending'`,
      [row.tenant_id, row.checkpoint_id, effect],
    );
    await client.query(
      `UPDATE waiting_recovery_checkpoints SET state='unknown',decision=$3::jsonb,
         claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND checkpoint_id=$2 AND state='effect_pending'`,
      [row.tenant_id, row.checkpoint_id, JSON.stringify(decision)],
    );
  }

  private async lockByScope(client: PoolClient, scope: ExecutionScope, checkpointId: string) {
    const result = await client.query<RecoveryRow>(
      `SELECT * FROM waiting_recovery_checkpoints WHERE tenant_id=$1 AND checkpoint_id=$2
        AND run_id=$3 AND thread_id=$4 AND workspace_id=$5 AND root_run_id=$6
        AND base_revision_id IS NOT DISTINCT FROM $7 FOR UPDATE`,
      [
        scope.tenantId,
        checkpointId,
        scope.runId,
        scope.threadId,
        scope.workspaceId,
        scope.rootRunId,
        scope.baseRevisionId ?? null,
      ],
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
      [
        claim.checkpoint.scope.tenantId,
        claim.checkpoint.checkpointId,
        claim.checkpoint.scope.runId,
        claim.checkpoint.scope.threadId,
        claim.checkpoint.scope.workspaceId,
        claim.checkpoint.scope.rootRunId,
        claim.checkpoint.scope.baseRevisionId ?? null,
        claim.claimToken,
        claim.claimEpoch,
      ],
    );
    return result.rows[0];
  }

  private mapClaim(row: RecoveryRow): PgWaitingRecoveryClaim {
    if (row.database_now === undefined) throw new Error("waiting claim 缺少数据库时间");
    const scope: ExecutionScope = {
      tenantId: tenantId(row.tenant_id),
      threadId: threadId(row.thread_id),
      runId: runId(row.run_id),
      rootRunId: runId(row.root_run_id),
      workspaceId: workspaceId(row.workspace_id),
      ...(row.base_revision_id === null
        ? {}
        : { baseRevisionId: workspaceRevisionId(row.base_revision_id) }),
    };
    return {
      claimToken: row.claim_token ?? "",
      claimEpoch: Number(row.claim_epoch),
      databaseNow: isoTimestamp(new Date(row.database_now).toISOString()),
      checkpoint: {
        checkpointId: row.checkpoint_id,
        scope,
        workspaceHeadAtWait:
          row.workspace_head_state === "found"
            ? {
                outcome: "found" as const,
                revisionId: workspaceRevisionId(row.workspace_head_revision_id ?? ""),
              }
            : { outcome: "empty" as const },
        ...(row.registry_id === null
          ? {}
          : {
              sandbox: {
                registryId: row.registry_id,
                providerSandboxId: row.provider_sandbox_id ?? "",
                tenantId: row.tenant_id,
                threadId: row.thread_id,
                workspaceId: row.workspace_id,
                ...(row.base_revision_id === null
                  ? {}
                  : { baseRevisionId: workspaceRevisionId(row.base_revision_id) }),
                generation: Number(row.sandbox_generation),
                expectedGeneration: Number(row.sandbox_expected_generation),
                pausedAt: isoTimestamp(new Date(row.sandbox_paused_at ?? "").toISOString()),
                expiresAt: isoTimestamp(new Date(row.sandbox_expires_at ?? "").toISOString()),
                lifecycle: row.sandbox_lifecycle as
                  | "paused"
                  | "pause_unknown"
                  | "connect_unknown"
                  | "create_unknown"
                  | "materialize_unknown",
              },
            }),
      },
    };
  }
}
