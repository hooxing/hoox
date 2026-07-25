import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { WorkspaceRevisionId } from "@cube-runtime/domain";
import type { UncertainLifecycleEvent } from "@cube-runtime/sandbox";
import type {
  AgentSessionFactoryPort,
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  OutboxMessage,
  PersistedRunEvent,
  RunClaim,
  RunCommitResult,
  RunPersistencePort,
  RunScope,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  VerifiedWorkspaceRevision,
  WorkerAgentSessionPort,
  WorkerRunStatus,
  WorkspaceLease,
  WorkspacePort,
  WorkspaceRevisionVerifierPort,
} from "./ports.js";

export interface RunWorkerOptions {
  readonly workerId: string;
  readonly claimLeaseMs?: number;
  readonly workspaceLeaseMs?: number;
  readonly heartbeatMs?: number;
  readonly runTimeoutMs?: number;
}

export type RunWorkerResult =
  | { readonly outcome: "succeeded" | "waiting" | "failed" | "cancelled" | "interrupted" }
  | {
      readonly outcome: "ignored";
      readonly reason: "busy" | "terminal" | "not_found" | "scope_mismatch";
    }
  | { readonly outcome: "fence_lost" }
  | { readonly outcome: "persistence_unavailable" };

interface WorkerDependencies {
  readonly runs: RunPersistencePort;
  readonly workspaces: WorkspacePort;
  readonly revisions: WorkspaceRevisionVerifierPort;
  readonly sandboxes: SandboxSessionRegistryPort;
  readonly sessions: AgentSessionFactoryPort;
  readonly cancellation: CancellationPort;
  readonly artifacts: ArtifactPublicationPort;
  readonly clock: ClockPort;
}

interface Cursor {
  stateVersion: number;
  nextEventSequence: number;
}

interface ExecutionFlags {
  fenceLost: boolean;
  persistenceUnavailable: boolean;
  cancelled: boolean;
  timedOut: boolean;
  successfulStop: boolean;
  agentError?: { readonly code: string; readonly message: string };
}

type FinalRunStatus = Exclude<WorkerRunStatus, "queued" | "running">;

const terminalStatuses = new Set<WorkerRunStatus>(["succeeded", "failed", "cancelled"]);

export class RunWorker {
  readonly #claimLeaseMs: number;
  readonly #workspaceLeaseMs: number;
  readonly #heartbeatMs: number;
  readonly #runTimeoutMs: number;

  constructor(
    private readonly dependencies: WorkerDependencies,
    private readonly options: RunWorkerOptions,
  ) {
    this.#claimLeaseMs = positive(options.claimLeaseMs ?? 30_000, "claimLeaseMs");
    this.#workspaceLeaseMs = positive(options.workspaceLeaseMs ?? 30_000, "workspaceLeaseMs");
    this.#heartbeatMs = positive(options.heartbeatMs ?? 10_000, "heartbeatMs");
    this.#runTimeoutMs = positive(options.runTimeoutMs ?? 15 * 60_000, "runTimeoutMs");
    if (!options.workerId.trim()) throw new Error("workerId 不能为空");
  }

  async execute(scope: RunScope): Promise<RunWorkerResult> {
    assertSingleRootScope(scope);
    const now = this.dependencies.clock.now();
    const claimResult = await this.dependencies.runs.claim({
      scope,
      workerId: this.options.workerId,
      now,
      leaseUntil: plusMs(now, this.#claimLeaseMs),
    });
    if (claimResult.outcome !== "claimed") {
      return { outcome: "ignored", reason: claimResult.outcome };
    }
    const claim = claimResult.claim;
    assertClaimScope(scope, claim);
    if (terminalStatuses.has(claim.snapshot.status)) {
      return { outcome: "ignored", reason: "terminal" };
    }

    const leaseResult = await this.dependencies.workspaces.acquireLease({
      scope,
      workspaceId: claim.snapshot.workspaceId,
      now,
      leaseUntil: plusMs(now, this.#workspaceLeaseMs),
    });
    if (leaseResult.outcome !== "acquired") {
      if (leaseResult.outcome === "scope_mismatch")
        return { outcome: "ignored", reason: "scope_mismatch" };
      return this.finishWithoutWorkspace(
        scope,
        claim,
        leaseResult.outcome === "busy" ? "interrupted" : "failed",
        "workspace.lease_unavailable",
        { outcome: leaseResult.outcome },
      );
    }

    const lease = leaseResult.lease;
    const cursor: Cursor = {
      stateVersion: claim.snapshot.stateVersion,
      nextEventSequence: claim.snapshot.nextEventSequence,
    };
    const flags: ExecutionFlags = {
      fenceLost: false,
      persistenceUnavailable: false,
      cancelled: false,
      timedOut: false,
      successfulStop: false,
    };
    let session: WorkerAgentSessionPort | undefined;
    let sandboxSession: SandboxSessionRef | undefined;
    let eventChain = Promise.resolve();
    let unsubscribe: (() => void) | undefined;
    let workspaceRevisionId = lease.baseRevisionId;
    let settlementAttempted = false;
    const cancellationSignal = this.dependencies.cancellation.signalFor(scope);
    const executionAbort = new AbortController();
    const onCancel = () => {
      flags.cancelled = true;
      executionAbort.abort("run_cancelled");
      if (session) void session.abort().catch(() => undefined);
    };
    cancellationSignal.addEventListener("abort", onCancel, { once: true });
    if (cancellationSignal.aborted) onCancel();

    const abortSession = () => {
      executionAbort.abort("worker_stop");
      if (session) void session.abort().catch(() => undefined);
    };
    const timeout = this.dependencies.clock.schedule(this.#runTimeoutMs, () => {
      flags.timedOut = true;
      abortSession();
    });
    const heartbeat = this.dependencies.clock.startHeartbeat(this.#heartbeatMs, async () => {
      const renewed = await this.renewFences(scope, claim, lease);
      if (renewed !== "renewed") {
        if (renewed === "fence_lost") flags.fenceLost = true;
        else flags.persistenceUnavailable = true;
        abortSession();
      }
    });
    const settleAndFinish = async (
      activeSandbox: SandboxSessionRef,
      status: FinalRunStatus,
      eventType: string,
      payload: unknown,
      disposition: "pause" | "close" = "close",
    ): Promise<RunWorkerResult> => {
      settlementAttempted = true;
      return await this.settleAndFinish(
        scope,
        claim,
        cursor,
        activeSandbox,
        status,
        eventType,
        payload,
        disposition,
      );
    };

    try {
      const acquisition = await this.dependencies.sandboxes.acquire({
        scope,
        workspaceId: claim.snapshot.workspaceId,
        ...(lease.baseRevisionId === undefined ? {} : { baseRevisionId: lease.baseRevisionId }),
        signal: executionAbort.signal,
      });
      if (acquisition.outcome === "unknown") {
        return await this.commitFinal(
          scope,
          claim,
          cursor,
          "failed",
          "sandbox.lifecycle_unknown",
          acquisition.event,
          [unknownOutbox(scope, acquisition.event, this.dependencies.clock.now())],
        );
      }
      if (acquisition.outcome === "failed") {
        return await this.commitFinal(
          scope,
          claim,
          cursor,
          flags.cancelled ? "cancelled" : "failed",
          "sandbox.acquire_failed",
          { code: acquisition.code },
        );
      }
      sandboxSession = acquisition.session;
      session = await this.dependencies.sessions.create({
        scope,
        sandbox: sandboxSession.sandbox,
      });

      unsubscribe = session.subscribe((event) => {
        eventChain = eventChain.then(async () => {
          if (flags.fenceLost || flags.persistenceUnavailable) return;
          const result = await this.persistAgentEvent(scope, claim, cursor, event);
          if (result === "fence_lost") {
            flags.fenceLost = true;
            abortSession();
            return;
          }
          if (result === "unavailable") {
            flags.persistenceUnavailable = true;
            abortSession();
            return;
          }
          updateAgentFlags(flags, event);
        });
      });

      const turn = await session.run({
        mode: claim.snapshot.followUp === undefined ? "prompt" : "follow_up",
        text: claim.snapshot.followUp ?? claim.snapshot.input,
      });
      await eventChain;

      if (flags.fenceLost) return { outcome: "fence_lost" };
      if (flags.persistenceUnavailable) return { outcome: "persistence_unavailable" };

      if (flags.cancelled || flags.timedOut) {
        settlementAttempted = true;
        const settled = await this.dependencies.sandboxes.settle({
          scope,
          session: sandboxSession,
          disposition: "close",
        });
        const outbox =
          settled.outcome === "unknown"
            ? [unknownOutbox(scope, settled.event, this.dependencies.clock.now())]
            : [];
        return await this.commitFinal(
          scope,
          claim,
          cursor,
          flags.cancelled ? "cancelled" : "failed",
          flags.cancelled ? "run.cancelled" : "run.timed_out",
          {},
          outbox,
        );
      }

      if (flags.agentError !== undefined) {
        return await settleAndFinish(sandboxSession, "failed", "agent.failed", flags.agentError);
      }

      if (turn.kind === "waiting") {
        const checkpoint = await this.checkpointWorkspace(scope, claim, lease, sandboxSession);
        if (checkpoint.outcome !== "ready")
          return await this.handleCheckpointFailure(scope, claim, cursor, checkpoint.outcome);
        workspaceRevisionId = checkpoint.revisionId ?? workspaceRevisionId;
        return await settleAndFinish(
          sandboxSession,
          "waiting",
          "run.waiting_for_user",
          { question: turn.question, workspaceRevisionId },
          "pause",
        );
      }

      if (!flags.successfulStop) {
        return await settleAndFinish(
          sandboxSession,
          "failed",
          "agent.missing_success_terminal",
          {},
        );
      }

      const checkpoint = await this.checkpointWorkspace(scope, claim, lease, sandboxSession);
      if (checkpoint.outcome !== "ready")
        return await this.handleCheckpointFailure(scope, claim, cursor, checkpoint.outcome);
      workspaceRevisionId = checkpoint.revisionId ?? workspaceRevisionId;

      // Artifact 本阶段不发布，但完成前必须经过显式端口，后续实现无需改写 Worker 状态机。
      await this.dependencies.artifacts.assertReadyForCompletion({
        scope,
        ...(workspaceRevisionId === undefined ? {} : { workspaceRevisionId }),
      });
      if (cancellationSignal.aborted) flags.cancelled = true;

      return await settleAndFinish(
        sandboxSession,
        flags.cancelled ? "cancelled" : "succeeded",
        flags.cancelled ? "run.cancelled_after_checkpoint" : "run.succeeded",
        { workspaceRevisionId },
      );
    } catch (error) {
      await eventChain.catch(() => undefined);
      if (flags.fenceLost) return { outcome: "fence_lost" };
      if (flags.persistenceUnavailable) return { outcome: "persistence_unavailable" };
      const code = error instanceof Error ? error.name : "UNKNOWN";
      const recoveryOutbox: OutboxMessage[] = [];
      if (sandboxSession !== undefined && !settlementAttempted) {
        settlementAttempted = true;
        try {
          const settlement = await this.dependencies.sandboxes.settle({
            scope,
            session: sandboxSession,
            disposition: "close",
          });
          if (settlement.outcome === "unknown") {
            recoveryOutbox.push(
              unknownOutbox(scope, settlement.event, this.dependencies.clock.now()),
            );
          }
        } catch {
          recoveryOutbox.push(
            recoveryOutboxForException(scope, claim, this.dependencies.clock.now()),
          );
        }
      }
      return await this.commitFinal(
        scope,
        claim,
        cursor,
        flags.cancelled ? "cancelled" : "failed",
        "worker.execution_failed",
        { code },
        recoveryOutbox,
      );
    } finally {
      timeout.cancel();
      cancellationSignal.removeEventListener("abort", onCancel);
      unsubscribe?.();
      session?.dispose();
      await heartbeat.stop().catch(() => undefined);
      await this.dependencies.workspaces
        .releaseLease({
          scope,
          workspaceId: claim.snapshot.workspaceId,
          lease,
        })
        .catch(() => undefined);
    }
  }

  private async persistAgentEvent(
    scope: RunScope,
    claim: RunClaim,
    cursor: Cursor,
    event: RuntimeAgentEvent,
  ): Promise<"committed" | "fence_lost" | "unavailable"> {
    const result = await this.commit(scope, claim, cursor, [
      nextEvent(scope, cursor, event.type, event, this.dependencies.clock.now()),
    ]);
    return commitOutcome(result);
  }

  private async checkpointWorkspace(
    scope: RunScope,
    claim: RunClaim,
    lease: WorkspaceLease,
    session: SandboxSessionRef,
  ): Promise<
    | { readonly outcome: "ready"; readonly revisionId?: WorkspaceRevisionId }
    | { readonly outcome: "lease_lost" | "revision_conflict" | "unavailable" }
  > {
    const renewed = await this.renewFences(scope, claim, lease);
    if (renewed !== "renewed")
      return { outcome: renewed === "fence_lost" ? "lease_lost" : "unavailable" };
    const revision = await this.dependencies.revisions.verify({
      scope,
      workspaceId: claim.snapshot.workspaceId,
      ...(lease.baseRevisionId === undefined ? {} : { baseRevisionId: lease.baseRevisionId }),
      sandbox: session.sandbox,
    });
    if (revision === undefined) return { outcome: "ready" };
    assertVerifiedRevision(revision, lease);
    const result = await this.dependencies.workspaces.commitVerifiedRevision({
      scope,
      workspaceId: claim.snapshot.workspaceId,
      lease,
      revision,
    });
    if (result === "committed" || result === "already_applied") {
      return { outcome: "ready", revisionId: revision.revisionId };
    }
    return { outcome: result };
  }

  private async handleCheckpointFailure(
    scope: RunScope,
    claim: RunClaim,
    cursor: Cursor,
    outcome: "lease_lost" | "revision_conflict" | "unavailable",
  ): Promise<RunWorkerResult> {
    if (outcome === "lease_lost") return { outcome: "fence_lost" };
    const now = this.dependencies.clock.now();
    return await this.commitFinal(
      scope,
      claim,
      cursor,
      "interrupted",
      "workspace.checkpoint_interrupted",
      { outcome },
      [
        {
          idempotencyKey: `${scope.runId}/workspace/recovery/${claim.epoch}`,
          topic: "sandbox.recovery.required",
          occurredAt: now,
          payload: { scope, outcome },
        },
      ],
    );
  }

  private async settleAndFinish(
    scope: RunScope,
    claim: RunClaim,
    cursor: Cursor,
    session: SandboxSessionRef,
    status: FinalRunStatus,
    eventType: string,
    payload: unknown,
    disposition: "pause" | "close" = "close",
  ): Promise<RunWorkerResult> {
    const settlement = await this.dependencies.sandboxes.settle({ scope, session, disposition });
    if (settlement.outcome === "unknown") {
      return await this.commitFinal(
        scope,
        claim,
        cursor,
        "failed",
        "sandbox.lifecycle_unknown",
        settlement.event,
        [unknownOutbox(scope, settlement.event, this.dependencies.clock.now())],
      );
    }
    return await this.commitFinal(scope, claim, cursor, status, eventType, payload);
  }

  private async finishWithoutWorkspace(
    scope: RunScope,
    claim: RunClaim,
    status: FinalRunStatus,
    eventType: string,
    payload: unknown,
  ): Promise<RunWorkerResult> {
    const cursor = {
      stateVersion: claim.snapshot.stateVersion,
      nextEventSequence: claim.snapshot.nextEventSequence,
    };
    return await this.commitFinal(scope, claim, cursor, status, eventType, payload);
  }

  private async commitFinal(
    scope: RunScope,
    claim: RunClaim,
    cursor: Cursor,
    status: FinalRunStatus,
    eventType: string,
    payload: unknown,
    outbox: readonly OutboxMessage[] = [],
  ): Promise<RunWorkerResult> {
    const result = await this.commit(
      scope,
      claim,
      cursor,
      [nextEvent(scope, cursor, eventType, payload, this.dependencies.clock.now())],
      outbox,
      status,
      true,
    );
    if (result.outcome === "fence_lost" || result.outcome === "conflict")
      return { outcome: "fence_lost" };
    if (result.outcome === "unavailable") return { outcome: "persistence_unavailable" };
    return { outcome: status };
  }

  private async commit(
    scope: RunScope,
    claim: RunClaim,
    cursor: Cursor,
    events: readonly PersistedRunEvent[],
    outbox: readonly OutboxMessage[] = [],
    nextStatus?: WorkerRunStatus,
    releaseClaim = false,
  ): Promise<RunCommitResult> {
    const result = await this.dependencies.runs.commit({
      scope,
      claimToken: claim.token,
      claimEpoch: claim.epoch,
      expectedStateVersion: cursor.stateVersion,
      events,
      outbox,
      ...(nextStatus === undefined ? {} : { nextStatus }),
      ...(releaseClaim ? { releaseClaim: true } : {}),
    });
    if (result.outcome === "committed" || result.outcome === "already_applied") {
      cursor.stateVersion = result.stateVersion;
      cursor.nextEventSequence = result.nextEventSequence;
    }
    return result;
  }

  private async renewFences(
    scope: RunScope,
    claim: RunClaim,
    lease: WorkspaceLease,
  ): Promise<"renewed" | "fence_lost" | "unavailable"> {
    const now = this.dependencies.clock.now();
    const run = await this.dependencies.runs.renewClaim({
      scope,
      claimToken: claim.token,
      claimEpoch: claim.epoch,
      now,
      leaseUntil: plusMs(now, this.#claimLeaseMs),
    });
    if (run !== "renewed") return run;
    const workspace = await this.dependencies.workspaces.renewLease({
      scope,
      workspaceId: claim.snapshot.workspaceId,
      lease,
      now,
      leaseUntil: plusMs(now, this.#workspaceLeaseMs),
    });
    return workspace === "renewed"
      ? "renewed"
      : workspace === "lease_lost"
        ? "fence_lost"
        : "unavailable";
  }
}

function nextEvent(
  scope: RunScope,
  cursor: Cursor,
  type: string,
  payload: unknown,
  occurredAt: Date,
): PersistedRunEvent {
  const sequence = cursor.nextEventSequence;
  return {
    sequence,
    idempotencyKey: `${scope.runId}/event/${sequence}`,
    type,
    occurredAt,
    payload,
  };
}

function unknownOutbox(
  scope: RunScope,
  event: UncertainLifecycleEvent,
  occurredAt: Date,
): OutboxMessage {
  return {
    idempotencyKey: `${scope.runId}/sandbox-unknown/${event.requestId}/${event.stage}`,
    topic: "sandbox.lifecycle.unknown",
    occurredAt,
    payload: { scope, event },
  };
}

function recoveryOutboxForException(
  scope: RunScope,
  claim: RunClaim,
  occurredAt: Date,
): OutboxMessage {
  return {
    idempotencyKey: `${scope.runId}/sandbox-settle-recovery/${claim.epoch}`,
    topic: "sandbox.recovery.required",
    occurredAt,
    payload: { scope, reason: "sandbox_settle_exception" },
  };
}

function updateAgentFlags(flags: ExecutionFlags, event: RuntimeAgentEvent): void {
  if (event.type === "message.completed" && event.stopReason === "stop") {
    flags.successfulStop = true;
  }
  if (event.type === "error") flags.agentError = { code: event.code, message: event.message };
  if (event.type === "compaction.forbidden") {
    flags.agentError = { code: "COMPACTION_FORBIDDEN", message: "Pi 触发了被禁用的 Compaction" };
  }
}

function commitOutcome(result: RunCommitResult): "committed" | "fence_lost" | "unavailable" {
  if (result.outcome === "committed" || result.outcome === "already_applied") return "committed";
  if (result.outcome === "fence_lost" || result.outcome === "conflict") return "fence_lost";
  return "unavailable";
}

function assertClaimScope(scope: RunScope, claim: RunClaim): void {
  const snapshot = claim.snapshot;
  if (
    snapshot.tenantId !== scope.tenantId ||
    snapshot.threadId !== scope.threadId ||
    snapshot.runId !== scope.runId ||
    snapshot.rootRunId !== scope.rootRunId
  ) {
    throw new Error("Run claim 所有权范围不一致");
  }
}

function assertSingleRootScope(scope: RunScope): void {
  if (scope.rootRunId !== scope.runId) throw new Error("单 Run Worker 要求 rootRunId 等于 runId");
}

function assertVerifiedRevision(revision: VerifiedWorkspaceRevision, lease: WorkspaceLease): void {
  if (revision.verified !== true || revision.baseRevisionId !== lease.baseRevisionId) {
    throw new Error("Workspace 验证结果与租约基础版本不一致");
  }
  if (!revision.idempotencyKey || !revision.objectKey || !revision.digest) {
    throw new Error("Workspace 验证结果不完整");
  }
}

function plusMs(value: Date, milliseconds: number): Date {
  return new Date(value.valueOf() + milliseconds);
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
