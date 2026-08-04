import { randomUUID } from "node:crypto";
import type {
  ExecutionScope,
  ThreadSandboxAcquireResult,
  ThreadSandboxLeaseRefV1,
  ThreadSandboxProviderPort,
  ThreadSandboxSessionLifecyclePort,
  ThreadSandboxTerminalCommandV1,
  ThreadSandboxTerminalReceiptV1,
  ThreadContinuityMetricsPort,
} from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import type { Pool, PoolClient } from "pg";
import { withTenantTransaction } from "./postgres.js";

interface SessionRow {
  readonly session_id: string;
  readonly registry_id: string;
  readonly provider_sandbox_id: string;
  readonly generation: string;
  readonly state: "running" | "pausing" | "paused" | "resuming";
  readonly materialized_revision_id: string | null;
  readonly materialization_attested: boolean;
  readonly resource_filesystem_mounted: boolean;
  readonly paused_at: Date | null;
  readonly retention_expires_at: Date | null;
  readonly updated_at: Date;
}

interface LeaseRow {
  readonly lease_id: string;
  readonly lease_token: string;
  readonly lease_epoch: string;
  readonly run_id: string;
  readonly attempt_id: string | null;
  readonly expires_at: Date;
}

type PreparedAcquisition =
  | { readonly kind: "cold"; readonly generation: number }
  | { readonly kind: "wait" }
  | { readonly kind: "lease_conflict" }
  | {
      readonly kind: "connect";
      readonly row: SessionRow;
      readonly lease: ThreadSandboxLeaseRefV1;
      readonly effectId?: string;
      readonly source: "running_handoff" | "paused_resumed";
    }
  | {
      readonly kind: "retire";
      readonly row: SessionRow;
      readonly lease: ThreadSandboxLeaseRefV1;
      readonly effectId?: undefined;
      readonly source: "running_handoff" | "paused_resumed";
      readonly reason:
        | "retention_expired"
        | "revision_attestation_mismatch"
        | "resource_filesystem_capability_mismatch";
    };
type PreparedReusable = Extract<PreparedAcquisition, { readonly row: SessionRow }>;

export interface ThreadSandboxSessionOptions {
  readonly pausedRetentionSeconds: number;
  readonly transitionWaitMs: number;
}

/** 必须在 Run terminal、Workspace/Context 写入和队列激活所在的同一事务调用。 */
export async function applyThreadSandboxTerminal(
  client: PoolClient,
  input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly command: ThreadSandboxTerminalCommandV1;
    readonly currentRevisionId?: string;
    readonly nextRunId?: string;
    readonly databaseNow: string;
    readonly handoffLeaseMs: number;
  },
): Promise<ThreadSandboxTerminalReceiptV1> {
  const lease = await client.query<{
    readonly provider_sandbox_id: string;
    readonly lease_epoch: string;
  }>(
    `SELECT session.provider_sandbox_id,sandbox_lease.lease_epoch::text
       FROM thread_sandbox_leases sandbox_lease
       JOIN thread_sandbox_sessions session
         ON session.tenant_id=sandbox_lease.tenant_id AND session.session_id=sandbox_lease.session_id
      WHERE sandbox_lease.tenant_id=$1 AND sandbox_lease.session_id=$2
        AND sandbox_lease.lease_id=$3 AND sandbox_lease.lease_token=$4
        AND sandbox_lease.run_id=$5 AND sandbox_lease.attempt_id=$6
        AND sandbox_lease.released_at IS NULL AND sandbox_lease.expires_at > clock_timestamp()
        AND session.generation=$7 AND session.thread_id=$8 AND session.workspace_id=$9
        AND session.state='running'
      FOR UPDATE OF sandbox_lease,session`,
    [
      input.scope.tenantId,
      input.command.sessionId,
      input.command.leaseId,
      input.command.leaseToken,
      input.scope.runId,
      input.attemptId,
      input.command.generation,
      input.scope.threadId,
      input.scope.workspaceId,
    ],
  );
  const row = lease.rows[0];
  if (row === undefined) throw new Error("Thread Sandbox terminal lease 已失效");
  const released = await client.query(
    `UPDATE thread_sandbox_leases
        SET released_at=$6,updated_at=$6
      WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND lease_token=$4
        AND lease_epoch=$5 AND released_at IS NULL`,
    [
      input.scope.tenantId,
      input.command.sessionId,
      input.command.leaseId,
      input.command.leaseToken,
      Number(row.lease_epoch),
      input.databaseNow,
    ],
  );
  if (released.rowCount !== 1) throw new Error("Thread Sandbox terminal lease release CAS 冲突");
  if (input.nextRunId !== undefined) {
    const nextEpoch = Number(row.lease_epoch) + 1;
    await client.query(
      `INSERT INTO thread_sandbox_leases(
         tenant_id,session_id,lease_id,lease_token,lease_epoch,run_id,attempt_id,owner,expires_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,NULL,'thread-handoff',
                 $7::timestamptz+($8::bigint*interval '1 millisecond'),$7,$7)`,
      [
        input.scope.tenantId,
        input.command.sessionId,
        `sandbox-lease-${randomUUID()}`,
        `sandbox-token-${randomUUID()}`,
        nextEpoch,
        input.nextRunId,
        input.databaseNow,
        input.handoffLeaseMs,
      ],
    );
    const session = await client.query(
      `UPDATE thread_sandbox_sessions
          SET materialized_revision_id=$4,materialization_attested=true,updated_at=$5
        WHERE tenant_id=$1 AND session_id=$2 AND generation=$3 AND state='running'`,
      [
        input.scope.tenantId,
        input.command.sessionId,
        input.command.generation,
        input.currentRevisionId ?? null,
        input.databaseNow,
      ],
    );
    if (session.rowCount !== 1) throw new Error("Thread Sandbox handoff CAS 冲突");
    return {
      schemaVersion: 1,
      outcome: "handed_off",
      sessionId: input.command.sessionId,
      generation: input.command.generation,
      nextRunId: input.nextRunId as ExecutionScope["runId"],
    };
  }
  const effectId = `sandbox-effect-${randomUUID()}`;
  const operationId = `${input.attemptId}/sandbox/${input.command.sessionId}/terminal-pause`;
  await client.query(
    `INSERT INTO sandbox_lifecycle_effects(
       tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,state,
       run_id,attempt_id,provider_sandbox_id,expected_session_state,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'pause','pending',$7,$8,$9,'running',$10,$10)`,
    [
      input.scope.tenantId,
      effectId,
      operationId,
      digestCanonical({ operationId, providerSandboxId: row.provider_sandbox_id }),
      input.command.sessionId,
      input.command.generation,
      input.scope.runId,
      input.attemptId,
      row.provider_sandbox_id,
      input.databaseNow,
    ],
  );
  const session = await client.query(
    `UPDATE thread_sandbox_sessions
        SET state='pausing',current_effect_id=$4,materialized_revision_id=$5,
            materialization_attested=true,updated_at=$6
      WHERE tenant_id=$1 AND session_id=$2 AND generation=$3 AND state='running'`,
    [
      input.scope.tenantId,
      input.command.sessionId,
      input.command.generation,
      effectId,
      input.currentRevisionId ?? null,
      input.databaseNow,
    ],
  );
  if (session.rowCount !== 1) throw new Error("Thread Sandbox pause intent CAS 冲突");
  return {
    schemaVersion: 1,
    outcome: "effect_pending",
    sessionId: input.command.sessionId,
    generation: input.command.generation,
    effectId,
    effectKind: "pause",
  };
}

/**
 * 阶段 5 Thread Sandbox 协调器。所有 Provider 调用之前都有 durable effect；调用结果未知时
 * 只隔离 provider ID，不重放同一个 effect。Workspace/Context 始终从既有事实源恢复。
 */
export class PgThreadSandboxSessionLifecycle implements ThreadSandboxSessionLifecyclePort {
  readonly #pausedRetentionSeconds: number;
  readonly #transitionWaitMs: number;

  constructor(
    private readonly pool: Pool,
    private readonly provider: ThreadSandboxProviderPort,
    options: ThreadSandboxSessionOptions,
    private readonly metrics?: ThreadContinuityMetricsPort,
  ) {
    this.#pausedRetentionSeconds = boundedInteger(
      options.pausedRetentionSeconds,
      1,
      31_536_000,
      "pausedRetentionSeconds",
    );
    this.#transitionWaitMs = boundedInteger(
      options.transitionWaitMs,
      1,
      600_000,
      "transitionWaitMs",
    );
  }

  async acquire(
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
  ): Promise<ThreadSandboxAcquireResult> {
    const startedAt = Date.now();
    const deadline = Date.now() + this.#transitionWaitMs;
    for (;;) {
      let prepared: PreparedAcquisition;
      try {
        prepared = await withTenantTransaction(
          this.pool,
          { tenantId: input.scope.tenantId },
          (client) => this.prepareExisting(client, input),
          { isolationLevel: "SERIALIZABLE" },
        );
      } catch {
        return { outcome: "failed", code: "PERSISTENCE_UNAVAILABLE" };
      }
      if (prepared.kind === "wait") {
        if (input.signal.aborted) return { outcome: "failed", code: "SANDBOX_FAILED" };
        if (Date.now() >= deadline) {
          return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
        }
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (prepared.kind === "lease_conflict") return { outcome: "failed", code: "SANDBOX_FAILED" };
      if (prepared.kind === "cold") {
        return this.observeAcquire(
          input,
          await this.coldCreate(input, prepared.generation),
          startedAt,
        );
      }
      await this.recordCachedSessionAge(input, prepared);
      if (prepared.kind === "retire") {
        const connected = await this.provider.connect({
          scope: input.scope,
          registryId: prepared.row.registry_id,
          providerSandboxId: prepared.row.provider_sandbox_id,
          signal: input.signal,
        });
        if (connected.outcome === "not_found") {
          if (
            !(await this.finishMissingConnect(input.scope, prepared).then(
              () => true,
              () => false,
            ))
          ) {
            return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
          }
          return this.observeAcquire(
            input,
            await this.coldCreate(input, Number(prepared.row.generation) + 1),
            startedAt,
          );
        }
        if (connected.outcome !== "ready") {
          await this.finishUnknownConnect(input.scope, prepared).catch(() => undefined);
          return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
        }
        const retired = await this.terminate({
          scope: input.scope,
          attemptId: input.attemptId,
          session: connected.session,
          lease: prepared.lease,
          reason: prepared.reason,
        });
        if (retired === "unknown") {
          return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
        }
        if (retired === "lease_lost") return { outcome: "failed", code: "SANDBOX_FAILED" };
        if (prepared.reason === "revision_attestation_mismatch") {
          await this.recordAcquireMetric(input, {
            observationId: `${input.attemptId}:sandbox:revision-mismatch`,
            metricName: "sandbox_revision_mismatch_total",
            value: 1,
            unit: "count",
            reason: "revision_attestation",
          });
        }
        return this.observeAcquire(
          input,
          await this.coldCreate(input, Number(prepared.row.generation) + 1),
          startedAt,
        );
      }
      const connected = await this.provider.connect({
        scope: input.scope,
        registryId: prepared.row.registry_id,
        providerSandboxId: prepared.row.provider_sandbox_id,
        signal: input.signal,
      });
      if (connected.outcome === "not_found") {
        if (
          !(await this.finishMissingConnect(input.scope, prepared).then(
            () => true,
            () => false,
          ))
        ) {
          return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
        }
        return this.observeAcquire(
          input,
          await this.coldCreate(input, Number(prepared.row.generation) + 1),
          startedAt,
        );
      }
      if (connected.outcome !== "ready") {
        await this.finishUnknownConnect(input.scope, prepared).catch(() => undefined);
        return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
      }
      if (prepared.effectId !== undefined) {
        const committed = await this.finishResume(input.scope, prepared).catch(() => false);
        if (!committed) {
          await this.provider
            .settle({
              scope: input.scope,
              session: connected.session,
              cleanupIntentId: `${prepared.effectId}/orphan`,
              disposition: "close",
            })
            .catch(() => undefined);
          return this.observeAcquire(input, { outcome: "unknown" }, startedAt);
        }
      }
      return this.observeAcquire(
        input,
        {
          outcome: "ready",
          session: connected.session,
          lease: prepared.lease,
          resourceFilesystemMounted: prepared.row.resource_filesystem_mounted,
          requiresMaterialization: false,
          source: prepared.source,
        },
        startedAt,
      );
    }
  }

  private async observeAcquire(
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
    result: ThreadSandboxAcquireResult,
    startedAt: number,
  ): Promise<ThreadSandboxAcquireResult> {
    if (result.outcome !== "ready") {
      if (result.outcome === "unknown") {
        await this.recordAcquireMetric(input, {
          observationId: `${input.attemptId}:sandbox:acquire-unknown`,
          metricName: "sandbox_unknown_total",
          value: 1,
          unit: "count",
          reason: "acquire",
        });
      }
      return result;
    }
    const latency = Math.max(0, Date.now() - startedAt);
    if (result.source === "cold_created") {
      await Promise.all([
        this.recordAcquireMetric(input, {
          observationId: `${input.attemptId}:sandbox:cold-total`,
          metricName: "sandbox_cold_rebuild_total",
          value: 1,
          unit: "count",
          path: "cold",
          outcome: "ready",
        }),
        this.recordAcquireMetric(input, {
          observationId: `${input.attemptId}:sandbox:create-latency`,
          metricName: "sandbox_create_latency_ms",
          value: latency,
          unit: "milliseconds",
          path: "cold",
          outcome: "ready",
        }),
      ]);
    } else if (result.source === "paused_resumed") {
      await Promise.all([
        this.recordAcquireMetric(input, {
          observationId: `${input.attemptId}:sandbox:resume-total`,
          metricName: "sandbox_resume_total",
          value: 1,
          unit: "count",
          path: "resume",
          outcome: "ready",
        }),
        this.recordAcquireMetric(input, {
          observationId: `${input.attemptId}:sandbox:resume-latency`,
          metricName: "sandbox_resume_latency_ms",
          value: latency,
          unit: "milliseconds",
          path: "resume",
          outcome: "ready",
        }),
      ]);
    } else {
      await this.recordAcquireMetric(input, {
        observationId: `${input.attemptId}:sandbox:handoff-total`,
        metricName: "sandbox_handoff_total",
        value: 1,
        unit: "count",
        path: "handoff",
        outcome: "ready",
      });
    }
    return result;
  }

  private async recordAcquireMetric(
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
    metric: Omit<
      Parameters<ThreadContinuityMetricsPort["record"]>[0],
      "tenantId" | "threadId" | "runId"
    >,
  ): Promise<void> {
    await this.metrics
      ?.record({
        tenantId: input.scope.tenantId,
        threadId: input.scope.threadId,
        runId: input.scope.runId,
        ...metric,
      })
      .catch(() => undefined);
  }

  private async recordCachedSessionAge(
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
    prepared: PreparedReusable,
  ): Promise<void> {
    if (prepared.row.paused_at !== null) {
      await this.recordAcquireMetric(input, {
        observationId: `${input.attemptId}:sandbox:paused-seconds`,
        metricName: "sandbox_paused_seconds",
        value: Math.max(0, (Date.now() - prepared.row.paused_at.getTime()) / 1_000),
        unit: "seconds",
        path: "resume",
      });
      return;
    }
    if (prepared.source === "running_handoff") {
      await this.recordAcquireMetric(input, {
        observationId: `${input.attemptId}:sandbox:idle-running-seconds`,
        metricName: "sandbox_idle_running_seconds",
        value: Math.max(0, (Date.now() - prepared.row.updated_at.getTime()) / 1_000),
        unit: "seconds",
        path: "handoff",
      });
    }
  }

  async attestMaterialized(
    input: Parameters<ThreadSandboxSessionLifecyclePort["attestMaterialized"]>[0],
  ): Promise<"attested" | "lease_lost" | "unavailable"> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const valid = await lockLease(client, input.scope, input.attemptId, input.lease);
          if (!valid) return "lease_lost" as const;
          const updated = await client.query(
            `UPDATE thread_sandbox_sessions
                SET materialized_revision_id=$4,materialization_attested=true,
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND session_id=$2 AND generation=$3 AND state='running'`,
            [
              input.scope.tenantId,
              input.lease.sessionId,
              input.lease.generation,
              input.revisionId ?? null,
            ],
          );
          return updated.rowCount === 1 ? ("attested" as const) : ("lease_lost" as const);
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return "unavailable";
    }
  }

  async completeTerminalEffect(
    input: Parameters<ThreadSandboxSessionLifecyclePort["completeTerminalEffect"]>[0],
  ): Promise<"settled" | "unknown" | "not_owner"> {
    const started = await this.startEffect(
      input.scope.tenantId,
      input.receipt.sessionId,
      input.receipt.generation,
      input.receipt.effectId,
      "pause",
    ).catch(() => false);
    if (!started) return "not_owner";
    const result = await this.provider
      .settle({
        scope: input.scope,
        session: input.session,
        cleanupIntentId: input.receipt.effectId,
        disposition: "pause",
      })
      .catch(() => ({ outcome: "unknown" as const }));
    const terminal = result.outcome === "settled" ? "succeeded" : "unknown";
    const recorded = await this.finishEffect({
      tenantId: input.scope.tenantId,
      sessionId: input.receipt.sessionId,
      generation: input.receipt.generation,
      effectId: input.receipt.effectId,
      effectKind: "pause",
      terminal,
    }).catch(() => false);
    return terminal === "succeeded" && recorded ? "settled" : "unknown";
  }

  async terminate(
    input: Parameters<ThreadSandboxSessionLifecyclePort["terminate"]>[0],
  ): Promise<"settled" | "unknown" | "lease_lost"> {
    const effectId = `sandbox-effect-${randomUUID()}`;
    const operationId = `${input.attemptId}/sandbox/${input.lease.sessionId}/terminate/${input.reason}`;
    try {
      const prepared = await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          if (!(await lockLease(client, input.scope, input.attemptId, input.lease))) return false;
          await client.query(
            `INSERT INTO sandbox_lifecycle_effects(
               tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,
               state,run_id,attempt_id,provider_sandbox_id,expected_session_state
             ) VALUES ($1,$2,$3,$4,$5,$6,'terminate','pending',$7,$8,$9,'running')`,
            [
              input.scope.tenantId,
              effectId,
              operationId,
              digestCanonical({ operationId, reason: input.reason }),
              input.lease.sessionId,
              input.lease.generation,
              input.scope.runId,
              input.attemptId,
              input.session.providerSandboxId,
            ],
          );
          return true;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
      if (!prepared) return "lease_lost";
      if (
        !(await this.startEffect(
          input.scope.tenantId,
          input.lease.sessionId,
          input.lease.generation,
          effectId,
          "terminate",
        ))
      )
        return "unknown";
      const result = await this.provider
        .settle({
          scope: input.scope,
          session: input.session,
          cleanupIntentId: effectId,
          disposition: "close",
        })
        .catch(() => ({ outcome: "unknown" as const }));
      const terminal = result.outcome === "settled" ? "succeeded" : "unknown";
      const recorded = await this.finishEffect({
        tenantId: input.scope.tenantId,
        sessionId: input.lease.sessionId,
        generation: input.lease.generation,
        effectId,
        effectKind: "terminate",
        terminal,
      });
      return terminal === "succeeded" && recorded ? "settled" : "unknown";
    } catch {
      return "unknown";
    }
  }

  private async prepareExisting(
    client: PoolClient,
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
  ): Promise<PreparedAcquisition> {
    if (!(await activeAttemptExists(client, input.scope, input.attemptId))) {
      return { kind: "lease_conflict" };
    }
    const result = await client.query<SessionRow>(
      `SELECT session_id,registry_id,provider_sandbox_id,generation::text,state,
              materialized_revision_id,materialization_attested,resource_filesystem_mounted,paused_at,
              retention_expires_at,updated_at
         FROM thread_sandbox_sessions
        WHERE tenant_id=$1 AND thread_id=$2 AND workspace_id=$3
          AND state IN ('running','pausing','paused','resuming')
        ORDER BY thread_sandbox_sessions.generation DESC LIMIT 1 FOR UPDATE`,
      [input.scope.tenantId, input.scope.threadId, input.scope.workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) return this.prepareColdGeneration(client, input);
    if (row.state === "pausing" || row.state === "resuming") return { kind: "wait" };
    if (row.state === "paused" && row.retention_expires_at !== null) {
      const now = await databaseNow(client);
      if (row.retention_expires_at.getTime() <= now.getTime()) {
        const lease = await attachLease(client, input, row);
        return lease === undefined
          ? { kind: "lease_conflict" }
          : {
              kind: "retire",
              row,
              lease,
              source: "paused_resumed",
              reason: "retention_expired",
            };
      }
    }
    const lease = await attachLease(client, input, row);
    if (lease === undefined) return { kind: "lease_conflict" };
    if (input.requiresResourceFilesystem && !row.resource_filesystem_mounted) {
      return {
        kind: "retire",
        row,
        lease,
        source: row.state === "paused" ? "paused_resumed" : "running_handoff",
        reason: "resource_filesystem_capability_mismatch",
      };
    }
    const revisionMatches =
      row.materialization_attested &&
      (row.materialized_revision_id ?? undefined) === input.scope.baseRevisionId;
    if (!revisionMatches) {
      return {
        kind: "retire",
        row,
        lease,
        source: row.state === "paused" ? "paused_resumed" : "running_handoff",
        reason: "revision_attestation_mismatch",
      };
    }
    if (row.state === "running") {
      return { kind: "connect", row, lease, source: "running_handoff" };
    }
    const effectId = `sandbox-effect-${randomUUID()}`;
    const operationId = `${input.attemptId}/sandbox/${row.session_id}/resume`;
    await client.query(
      `INSERT INTO sandbox_lifecycle_effects(
         tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,state,
         run_id,attempt_id,provider_sandbox_id,expected_session_state,claim_token,claimed_by,
         claim_generation,claim_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'resume','started',$7,$8,$9,'paused',$10,$11,1,
                 clock_timestamp()+($12::bigint*interval '1 millisecond'))`,
      [
        input.scope.tenantId,
        effectId,
        operationId,
        digestCanonical({ operationId, providerSandboxId: row.provider_sandbox_id }),
        row.session_id,
        Number(row.generation),
        input.scope.runId,
        input.attemptId,
        row.provider_sandbox_id,
        `sandbox-effect-claim-${randomUUID()}`,
        input.owner,
        this.#transitionWaitMs,
      ],
    );
    await client.query(
      `UPDATE sandbox_lifecycle_effects
          SET remote_call_started_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND effect_id=$2`,
      [input.scope.tenantId, effectId],
    );
    const transitioned = await client.query(
      `UPDATE thread_sandbox_sessions
          SET state='resuming',current_effect_id=$4,paused_at=NULL,retention_expires_at=NULL,
              updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_id=$2 AND generation=$3 AND state='paused'`,
      [input.scope.tenantId, row.session_id, Number(row.generation), effectId],
    );
    if (transitioned.rowCount !== 1) throw new Error("Sandbox resume CAS 冲突");
    return { kind: "connect", row, lease, effectId, source: "paused_resumed" };
  }

  private async prepareColdGeneration(
    client: PoolClient,
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
  ): Promise<Extract<PreparedAcquisition, { kind: "cold" | "wait" }>> {
    const latestCreate = await client.query<{
      effect_id: string;
      state: string;
      claim_expires_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT effect.effect_id,effect.state,effect.claim_expires_at,effect.updated_at
         FROM sandbox_lifecycle_effects effect
         JOIN execution_attempts attempt
           ON attempt.tenant_id=effect.tenant_id AND attempt.attempt_id=effect.attempt_id
        WHERE effect.tenant_id=$1 AND attempt.thread_id=$2 AND attempt.workspace_id=$3
          AND effect.effect_kind='create'
        ORDER BY effect.generation DESC LIMIT 1 FOR UPDATE OF effect`,
      [input.scope.tenantId, input.scope.threadId, input.scope.workspaceId],
    );
    const inFlight = latestCreate.rows[0];
    if (inFlight?.state === "started") {
      const now = await databaseNow(client);
      const deadline =
        inFlight.claim_expires_at?.getTime() ??
        inFlight.updated_at.getTime() + this.#transitionWaitMs;
      if (deadline > now.getTime()) return { kind: "wait" };
      await client.query(
        `UPDATE sandbox_lifecycle_effects
            SET state='unknown',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                completed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND effect_id=$2 AND state='started'`,
        [input.scope.tenantId, inFlight.effect_id],
      );
    }
    return { kind: "cold", generation: await nextGeneration(client, input.scope) };
  }

  private async coldCreate(
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
    generation: number,
  ): Promise<ThreadSandboxAcquireResult> {
    const sessionId = `thread-session-${randomUUID()}`;
    const registryId = `thread-registry-${randomUUID()}`;
    const effectId = `sandbox-effect-${randomUUID()}`;
    const operationId = `${input.attemptId}/sandbox/create/${generation}`;
    try {
      await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          if (!(await activeAttemptExists(client, input.scope, input.attemptId))) {
            throw new Error("Sandbox create 的 Attempt 栅栏已失效");
          }
          await client.query(
            `INSERT INTO sandbox_lifecycle_effects(
               tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,
               state,run_id,attempt_id,expected_session_state,claim_token,claimed_by,
               claim_generation,claim_expires_at,remote_call_started_at
             ) VALUES ($1,$2,$3,$4,$5,$6,'create','started',$7,$8,NULL,$9,$10,1,
                       clock_timestamp()+($11::bigint*interval '1 millisecond'),clock_timestamp())`,
            [
              input.scope.tenantId,
              effectId,
              operationId,
              digestCanonical({ operationId, registryId }),
              sessionId,
              generation,
              input.scope.runId,
              input.attemptId,
              `sandbox-create-claim-${randomUUID()}`,
              input.owner,
              this.#transitionWaitMs,
            ],
          );
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return { outcome: "failed", code: "PERSISTENCE_UNAVAILABLE" };
    }
    const created = await this.provider.create({
      scope: input.scope,
      registryId,
      signal: input.signal,
      requiresResourceFilesystem: input.requiresResourceFilesystem,
    });
    if (created.outcome !== "ready") {
      await (created.outcome === "unknown"
        ? this.markCreateTerminal(input.scope.tenantId, effectId, "unknown")
        : this.markCreateTerminal(input.scope.tenantId, effectId, "failed_not_applied")
      ).catch(() => undefined);
      return created.outcome === "unknown"
        ? { outcome: "unknown" }
        : { outcome: "failed", code: created.code };
    }
    try {
      const lease = await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          if (!(await activeAttemptExists(client, input.scope, input.attemptId))) {
            throw new Error("Sandbox create receipt 的 Attempt 栅栏已失效");
          }
          await client.query(
            `INSERT INTO thread_sandbox_sessions(
               tenant_id,session_id,thread_id,workspace_id,registry_id,provider_sandbox_id,
               generation,state,materialization_attested,resource_filesystem_mounted
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',false,$8)`,
            [
              input.scope.tenantId,
              sessionId,
              input.scope.threadId,
              input.scope.workspaceId,
              registryId,
              created.session.providerSandboxId,
              generation,
              input.requiresResourceFilesystem,
            ],
          );
          const lease = await insertLease(client, input, sessionId, generation, 1);
          const effect = await client.query(
            `UPDATE sandbox_lifecycle_effects
                SET state='succeeded',provider_sandbox_id=$3,resulting_session_state='running',
                    provider_receipt_digest=$4,claim_token=NULL,claimed_by=NULL,
                    claim_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND effect_id=$2 AND state='started'`,
            [
              input.scope.tenantId,
              effectId,
              created.session.providerSandboxId,
              digestCanonical({
                outcome: "created",
                providerSandboxId: created.session.providerSandboxId,
              }),
            ],
          );
          if (effect.rowCount !== 1) throw new Error("Sandbox create receipt CAS 冲突");
          return lease;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
      return {
        outcome: "ready",
        session: created.session,
        lease,
        resourceFilesystemMounted: input.requiresResourceFilesystem,
        requiresMaterialization: true,
        source: "cold_created",
      };
    } catch {
      await this.provider
        .settle({
          scope: input.scope,
          session: created.session,
          cleanupIntentId: `${effectId}/orphan`,
          disposition: "close",
        })
        .catch(() => undefined);
      await this.markCreateTerminal(input.scope.tenantId, effectId, "unknown").catch(
        () => undefined,
      );
      return { outcome: "unknown" };
    }
  }

  private async finishResume(
    scope: ExecutionScope,
    prepared: Extract<PreparedAcquisition, { kind: "connect" }>,
  ): Promise<boolean> {
    if (prepared.effectId === undefined) return true;
    return withTenantTransaction(
      this.pool,
      { tenantId: scope.tenantId },
      async (client) => {
        const effect = await client.query(
          `UPDATE sandbox_lifecycle_effects
              SET state='succeeded',resulting_session_state='running',
                  provider_receipt_digest=$3,claim_token=NULL,claimed_by=NULL,
                  claim_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND effect_id=$2 AND state='started'
            RETURNING 1`,
          [scope.tenantId, prepared.effectId, digestCanonical({ outcome: "connected" })],
        );
        const session = await client.query(
          `UPDATE thread_sandbox_sessions
              SET state='running',current_effect_id=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
              AND state='resuming' AND current_effect_id=$4`,
          [
            scope.tenantId,
            prepared.row.session_id,
            Number(prepared.row.generation),
            prepared.effectId,
          ],
        );
        if (effect.rowCount !== 1 || session.rowCount !== 1)
          throw new Error("Sandbox resume receipt CAS 冲突");
        return true;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  private async finishMissingConnect(
    scope: ExecutionScope,
    prepared: PreparedReusable,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: scope.tenantId }, async (client) => {
      if (prepared.effectId !== undefined) {
        await client.query(
          `UPDATE sandbox_lifecycle_effects
              SET state='failed_not_applied',resulting_session_state=NULL,
                  claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                  completed_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND effect_id=$2 AND state='started'`,
          [scope.tenantId, prepared.effectId],
        );
      }
      const observationEffectId = `sandbox-effect-${randomUUID()}`;
      const operationId = `${scope.runId}/sandbox/${prepared.row.session_id}/provider-not-found/${prepared.row.generation}`;
      await client.query(
        `INSERT INTO sandbox_lifecycle_effects(
           tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,state,
           run_id,provider_sandbox_id,expected_session_state,resulting_session_state,
           provider_receipt_digest,completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'terminate','succeeded',$7,$8,$9,'terminated',$10,
                   clock_timestamp())`,
        [
          scope.tenantId,
          observationEffectId,
          operationId,
          digestCanonical({ operationId, observation: "not_found" }),
          prepared.row.session_id,
          Number(prepared.row.generation),
          scope.runId,
          prepared.row.provider_sandbox_id,
          prepared.row.state,
          digestCanonical({ outcome: "not_found" }),
        ],
      );
      await terminateSessionAndReleaseLease(
        client,
        scope.tenantId,
        prepared.row.session_id,
        prepared.lease,
      );
    });
  }

  private async finishUnknownConnect(
    scope: ExecutionScope,
    prepared: PreparedReusable,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: scope.tenantId }, async (client) => {
      const effectId = prepared.effectId ?? `sandbox-effect-${randomUUID()}`;
      if (prepared.effectId === undefined) {
        const operationId = `${scope.runId}/sandbox/${prepared.row.session_id}/connect`;
        await client.query(
          `INSERT INTO sandbox_lifecycle_effects(
             tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,state,
             run_id,provider_sandbox_id,expected_session_state,completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'resume','unknown',$7,$8,'running',clock_timestamp())`,
          [
            scope.tenantId,
            effectId,
            operationId,
            digestCanonical({ operationId }),
            prepared.row.session_id,
            Number(prepared.row.generation),
            scope.runId,
            prepared.row.provider_sandbox_id,
          ],
        );
      } else {
        await client.query(
          `UPDATE sandbox_lifecycle_effects
              SET state='unknown',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                  completed_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND effect_id=$2 AND state='started'`,
          [scope.tenantId, effectId],
        );
      }
      await client.query(
        `UPDATE thread_sandbox_sessions
            SET state='unknown',current_effect_id=$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_id=$2 AND generation=$3`,
        [scope.tenantId, prepared.row.session_id, Number(prepared.row.generation), effectId],
      );
      await releaseLease(client, scope.tenantId, prepared.lease);
    });
  }

  private async startEffect(
    tenantId: string,
    sessionId: string,
    generation: number,
    effectId: string,
    effectKind: "pause" | "terminate",
  ): Promise<boolean> {
    return withTenantTransaction(this.pool, { tenantId }, async (client) => {
      const claimToken = `sandbox-effect-claim-${randomUUID()}`;
      const effect = await client.query(
        `UPDATE sandbox_lifecycle_effects
            SET state='started',claim_token=$6,claimed_by='thread-lifecycle-inline',
                claim_generation=claim_generation+1,
                claim_expires_at=clock_timestamp()+($7::bigint*interval '1 millisecond'),
                remote_call_started_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND effect_id=$2 AND session_id=$3 AND generation=$4
            AND effect_kind=$5 AND state='pending' AND remote_call_started_at IS NULL
            AND claim_token IS NULL`,
        [tenantId, effectId, sessionId, generation, effectKind, claimToken, this.#transitionWaitMs],
      );
      return effect.rowCount === 1;
    });
  }

  private async finishEffect(input: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly effectId: string;
    readonly effectKind: "pause" | "terminate";
    readonly terminal: "succeeded" | "unknown";
  }): Promise<boolean> {
    return withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      const resultingState =
        input.terminal === "unknown"
          ? "unknown"
          : input.effectKind === "pause"
            ? "paused"
            : "terminated";
      const effect = await client.query(
        `UPDATE sandbox_lifecycle_effects
            SET state=$5,resulting_session_state=$6,provider_receipt_digest=$7,
                claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                completed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND effect_id=$2 AND session_id=$3 AND generation=$4
            AND effect_kind=$8 AND state='started'`,
        [
          input.tenantId,
          input.effectId,
          input.sessionId,
          input.generation,
          input.terminal,
          input.terminal === "unknown" ? null : resultingState,
          digestCanonical({ outcome: input.terminal }),
          input.effectKind,
        ],
      );
      let sessionRowCount: number | null;
      if (resultingState === "paused") {
        const session = await client.query(
          `UPDATE thread_sandbox_sessions
              SET state='paused',current_effect_id=NULL,paused_at=clock_timestamp(),
                  retention_expires_at=clock_timestamp()+($5::bigint*interval '1 second'),
                  updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
              AND state='pausing' AND current_effect_id=$4`,
          [
            input.tenantId,
            input.sessionId,
            input.generation,
            input.effectId,
            this.#pausedRetentionSeconds,
          ],
        );
        sessionRowCount = session.rowCount;
      } else if (resultingState === "terminated") {
        const session = await client.query(
          `UPDATE thread_sandbox_sessions
              SET state='terminated',current_effect_id=NULL,terminated_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
              AND state IN ('running','paused')`,
          [input.tenantId, input.sessionId, input.generation],
        );
        sessionRowCount = session.rowCount;
        await client.query(
          `UPDATE thread_sandbox_leases
              SET released_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND session_id=$2 AND released_at IS NULL`,
          [input.tenantId, input.sessionId],
        );
      } else {
        const session = await client.query(
          `UPDATE thread_sandbox_sessions
              SET state='unknown',current_effect_id=$4,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND session_id=$2 AND generation=$3
              AND state IN ('running','pausing','paused','resuming')`,
          [input.tenantId, input.sessionId, input.generation, input.effectId],
        );
        sessionRowCount = session.rowCount;
        await client.query(
          `UPDATE thread_sandbox_leases
              SET released_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND session_id=$2 AND released_at IS NULL`,
          [input.tenantId, input.sessionId],
        );
      }
      if (effect.rowCount !== 1 || sessionRowCount !== 1)
        throw new Error("Sandbox effect receipt CAS 冲突");
      return true;
    });
  }

  private async markCreateTerminal(
    tenantId: string,
    effectId: string,
    state: "failed_not_applied" | "unknown",
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_lifecycle_effects
            SET state=$3,claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                completed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND effect_id=$2 AND state='started'`,
        [tenantId, effectId, state],
      ),
    );
  }
}

async function activeAttemptExists(
  client: PoolClient,
  scope: ExecutionScope,
  attemptId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM execution_attempts attempt
       JOIN run_claims claim ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
       JOIN workspace_write_leases lease
         ON lease.tenant_id=attempt.tenant_id AND lease.workspace_id=attempt.workspace_id
        AND lease.root_run_id=attempt.root_run_id AND lease.epoch=claim.workspace_lease_epoch
      WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2 AND attempt.run_id=$3
        AND attempt.thread_id=$4 AND attempt.workspace_id=$5 AND attempt.root_run_id=$6
        AND attempt.base_revision_id IS NOT DISTINCT FROM $7
        AND attempt.status IN ('claimed','running','finalizing')
        AND claim.released_at IS NULL AND claim.expires_at > clock_timestamp()
        AND lease.expires_at > clock_timestamp()
      FOR UPDATE OF attempt,claim,lease`,
    [
      scope.tenantId,
      attemptId,
      scope.runId,
      scope.threadId,
      scope.workspaceId,
      scope.rootRunId,
      scope.baseRevisionId ?? null,
    ],
  );
  return result.rowCount === 1;
}

async function nextGeneration(client: PoolClient, scope: ExecutionScope): Promise<number> {
  const result = await client.query<{ generation: string }>(
    `SELECT COALESCE(max(candidate.generation),0)::text AS generation
       FROM (
         SELECT generation FROM thread_sandbox_sessions
          WHERE tenant_id=$1 AND thread_id=$2 AND workspace_id=$3
         UNION ALL
         SELECT effect.generation FROM sandbox_lifecycle_effects effect
         JOIN execution_attempts attempt
           ON attempt.tenant_id=effect.tenant_id AND attempt.attempt_id=effect.attempt_id
          WHERE effect.tenant_id=$1 AND attempt.thread_id=$2 AND attempt.workspace_id=$3
            AND effect.effect_kind='create'
       ) candidate`,
    [scope.tenantId, scope.threadId, scope.workspaceId],
  );
  return Number(result.rows[0]?.generation ?? "0") + 1;
}

async function attachLease(
  client: PoolClient,
  input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
  row: SessionRow,
): Promise<ThreadSandboxLeaseRefV1 | undefined> {
  const result = await client.query<LeaseRow>(
    `SELECT lease_id,lease_token,lease_epoch::text,run_id,attempt_id,expires_at
       FROM thread_sandbox_leases
      WHERE tenant_id=$1 AND session_id=$2 AND released_at IS NULL FOR UPDATE`,
    [input.scope.tenantId, row.session_id],
  );
  let existing = result.rows[0];
  const now = await databaseNow(client);
  if (existing !== undefined && existing.expires_at.getTime() <= now.getTime()) {
    await client.query(
      `UPDATE thread_sandbox_leases SET released_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND released_at IS NULL`,
      [input.scope.tenantId, row.session_id, existing.lease_id],
    );
    existing = undefined;
  }
  if (existing !== undefined) {
    if (existing.run_id !== input.scope.runId) return undefined;
    if (existing.attempt_id !== null && existing.attempt_id !== input.attemptId) return undefined;
    const attached = await client.query(
      `UPDATE thread_sandbox_leases
          SET attempt_id=$4,owner=$5,expires_at=clock_timestamp()+($6::bigint*interval '1 millisecond'),
              updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND released_at IS NULL
          AND (attempt_id IS NULL OR attempt_id=$4)`,
      [
        input.scope.tenantId,
        row.session_id,
        existing.lease_id,
        input.attemptId,
        input.owner,
        input.leaseDurationMs,
      ],
    );
    return attached.rowCount === 1 ? leaseRef(row, existing) : undefined;
  }
  const epochResult = await client.query<{ epoch: string }>(
    `SELECT COALESCE(max(lease_epoch),0)::text AS epoch FROM thread_sandbox_leases
      WHERE tenant_id=$1 AND session_id=$2`,
    [input.scope.tenantId, row.session_id],
  );
  return insertLease(
    client,
    input,
    row.session_id,
    Number(row.generation),
    Number(epochResult.rows[0]?.epoch ?? "0") + 1,
  );
}

async function insertLease(
  client: PoolClient,
  input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
  sessionId: string,
  generation: number,
  epoch: number,
): Promise<ThreadSandboxLeaseRefV1> {
  const lease: ThreadSandboxLeaseRefV1 = {
    schemaVersion: 1,
    sessionId,
    generation,
    leaseId: `sandbox-lease-${randomUUID()}`,
    leaseToken: `sandbox-token-${randomUUID()}`,
    leaseEpoch: epoch,
  };
  await client.query(
    `INSERT INTO thread_sandbox_leases(
       tenant_id,session_id,lease_id,lease_token,lease_epoch,run_id,attempt_id,owner,expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+($9::bigint*interval '1 millisecond'))`,
    [
      input.scope.tenantId,
      sessionId,
      lease.leaseId,
      lease.leaseToken,
      epoch,
      input.scope.runId,
      input.attemptId,
      input.owner,
      input.leaseDurationMs,
    ],
  );
  return lease;
}

function leaseRef(row: SessionRow, lease: LeaseRow): ThreadSandboxLeaseRefV1 {
  return {
    schemaVersion: 1,
    sessionId: row.session_id,
    generation: Number(row.generation),
    leaseId: lease.lease_id,
    leaseToken: lease.lease_token,
    leaseEpoch: Number(lease.lease_epoch),
  };
}

async function lockLease(
  client: PoolClient,
  scope: ExecutionScope,
  attemptId: string,
  lease: ThreadSandboxLeaseRefV1,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM thread_sandbox_leases sandbox_lease
       JOIN thread_sandbox_sessions session
         ON session.tenant_id=sandbox_lease.tenant_id AND session.session_id=sandbox_lease.session_id
      WHERE sandbox_lease.tenant_id=$1 AND sandbox_lease.session_id=$2
        AND sandbox_lease.lease_id=$3 AND sandbox_lease.lease_token=$4
        AND sandbox_lease.lease_epoch=$5 AND sandbox_lease.run_id=$6
        AND sandbox_lease.attempt_id=$7 AND sandbox_lease.released_at IS NULL
        AND sandbox_lease.expires_at > clock_timestamp()
        AND session.generation=$8 AND session.thread_id=$9 AND session.workspace_id=$10
      FOR UPDATE OF sandbox_lease,session`,
    [
      scope.tenantId,
      lease.sessionId,
      lease.leaseId,
      lease.leaseToken,
      lease.leaseEpoch,
      scope.runId,
      attemptId,
      lease.generation,
      scope.threadId,
      scope.workspaceId,
    ],
  );
  return result.rowCount === 1;
}

async function releaseLease(
  client: PoolClient,
  tenantId: string,
  lease: ThreadSandboxLeaseRefV1,
): Promise<void> {
  await client.query(
    `UPDATE thread_sandbox_leases SET released_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND lease_token=$4
        AND lease_epoch=$5 AND released_at IS NULL`,
    [tenantId, lease.sessionId, lease.leaseId, lease.leaseToken, lease.leaseEpoch],
  );
}

async function terminateSessionAndReleaseLease(
  client: PoolClient,
  tenantId: string,
  sessionId: string,
  lease: ThreadSandboxLeaseRefV1,
): Promise<void> {
  await client.query(
    `UPDATE thread_sandbox_sessions
        SET state='terminated',current_effect_id=NULL,terminated_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND session_id=$2 AND generation=$3`,
    [tenantId, sessionId, lease.generation],
  );
  await releaseLease(client, tenantId, lease);
}

async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error("数据库时钟缺失");
  return now;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} 无效`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
