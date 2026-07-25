import {
  prepareWorkspaceRevision,
  type IsoTimestamp,
  type Run,
  type Workspace,
  type WorkspaceRevisionCommit,
} from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type {
  AgentSessionFactoryPort,
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  ExecutionAttemptStatus,
  ExecutionFence,
  ExecutionPersistencePort,
  ExecutionScope,
  ExecutionStage,
  RuntimeEventV1,
  RuntimeMutation,
  RuntimeMutationResult,
  RuntimeOutboxV1,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  StableWorkerErrorCode,
  WorkerAgentSessionPort,
  WorkspaceRevisionCandidate,
  WorkspaceRevisionVerifierPort,
} from "./ports.js";
import { assertProtocolSize } from "./ports.js";

export interface RunWorkerOptions {
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatMs?: number;
  readonly runTimeoutMs?: number;
}

export type RunWorkerResult =
  | { readonly outcome: "succeeded" | "waiting" | "failed" | "cancelled" }
  | { readonly outcome: "recovery_required"; readonly code: StableWorkerErrorCode }
  | {
      readonly outcome: "ignored";
      readonly reason:
        | "busy"
        | "terminal"
        | "waiting_for_answer"
        | "not_found"
        | "scope_mismatch"
        | "recovery_required";
    }
  | { readonly outcome: "retryable"; readonly code: "PERSISTENCE_UNAVAILABLE" }
  | { readonly outcome: "fence_lost" };

interface WorkerDependencies {
  readonly persistence: ExecutionPersistencePort;
  readonly revisions: WorkspaceRevisionVerifierPort;
  readonly sandboxes: SandboxSessionRegistryPort;
  readonly sessions: AgentSessionFactoryPort;
  readonly cancellation: CancellationPort;
  readonly artifacts: ArtifactPublicationPort;
  readonly clock: ClockPort;
}

interface ExecutionContext {
  readonly scope: ExecutionScope;
  fence: ExecutionFence;
  attemptVersion: number;
  nextEventSequence: number;
  databaseNow: IsoTimestamp;
  readonly attemptId: string;
  run: Run;
  workspace: Workspace;
  stopped?: "cancelled" | "timeout" | "fence_lost" | "unavailable" | "scope_mismatch";
  agentFailure?: StableWorkerErrorCode;
  successfulStop: boolean;
  adapterRejected: boolean;
}

type AppliedMutation = Extract<RuntimeMutationResult, { outcome: "applied" | "already_applied" }>;

export class RunWorker {
  readonly #leaseDurationMs: number;
  readonly #heartbeatMs: number;
  readonly #runTimeoutMs: number;

  constructor(
    private readonly dependencies: WorkerDependencies,
    private readonly options: RunWorkerOptions,
  ) {
    this.#leaseDurationMs = positive(options.leaseDurationMs ?? 30_000, "leaseDurationMs");
    this.#heartbeatMs = positive(options.heartbeatMs ?? 10_000, "heartbeatMs");
    this.#runTimeoutMs = positive(options.runTimeoutMs ?? 15 * 60_000, "runTimeoutMs");
    if (this.#heartbeatMs * 2 >= this.#leaseDurationMs) {
      throw new Error("heartbeatMs 必须小于 leaseDurationMs 的一半");
    }
    if (!options.workerId.trim()) throw new Error("workerId 不能为空");
  }

  async execute(scope: ExecutionScope): Promise<RunWorkerResult> {
    assertScope(scope);
    const claim = await this.dependencies.persistence.claim({
      scope,
      workerId: this.options.workerId,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (claim.outcome !== "claimed") {
      if (claim.outcome === "unavailable") {
        return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
      }
      return { outcome: "ignored", reason: claim.outcome };
    }
    if (!claimMatches(scope, claim.fence, claim.snapshot.run.id, claim.snapshot.workspace.id)) {
      const released = await this.dependencies.persistence.mutate({
        idempotencyKey: `${claim.snapshot.attempt.attemptId}/claim/scope-mismatch`,
        fence: claim.fence,
        expectedAttemptVersion: claim.snapshot.attempt.version,
        nextAttemptStatus: "recovery_required",
        events: [
          {
            schemaVersion: 1,
            kind: "attempt_state_changed",
            sequence: claim.snapshot.attempt.nextEventSequence,
            occurredAt: claim.databaseNow,
            payload: {
              status: "recovery_required",
              stage: "claimed",
              code: "PROTOCOL",
            },
          },
        ],
        outbox: [
          {
            schemaVersion: 1,
            kind: "runtime_alert",
            idempotencyKey: `${claim.snapshot.attempt.attemptId}/alert/PROTOCOL`,
            state: "pending",
            occurredAt: claim.databaseNow,
            payload: { code: "PROTOCOL", attemptId: claim.snapshot.attempt.attemptId },
          },
        ],
        releaseFences: true,
      });
      return isApplied(released)
        ? { outcome: "ignored", reason: "scope_mismatch" }
        : { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
    }

    const context: ExecutionContext = {
      scope,
      fence: claim.fence,
      attemptVersion: claim.snapshot.attempt.version,
      nextEventSequence: claim.snapshot.attempt.nextEventSequence,
      databaseNow: claim.databaseNow,
      attemptId: claim.snapshot.attempt.attemptId,
      run: claim.snapshot.run,
      workspace: claim.snapshot.workspace,
      successfulStop: false,
      adapterRejected: false,
    };
    const cancellation = this.dependencies.cancellation.signalFor(scope);
    let session: WorkerAgentSessionPort | undefined;
    let sandbox: SandboxSessionRef | undefined;
    let cleanupDisposition: "pause" | "close" = "close";
    let cleanupSettled = false;
    let unsubscribe: (() => void) | undefined;
    let eventChain = Promise.resolve();
    const executionAbort = new AbortController();

    const stopSession = () => {
      if (session) void session.abort().catch(() => undefined);
    };
    const onCancel = () => {
      context.stopped = "cancelled";
      executionAbort.abort("run_cancelled");
      stopSession();
    };
    cancellation.addEventListener("abort", onCancel, { once: true });
    if (cancellation.aborted) onCancel();
    const timeout = this.dependencies.clock.schedule(this.#runTimeoutMs, () => {
      context.stopped = "timeout";
      executionAbort.abort("run_timeout");
      stopSession();
    });
    const heartbeat = this.dependencies.clock.startHeartbeat(this.#heartbeatMs, async () => {
      const inspected = await this.dependencies.persistence.inspectAndRenew({
        fence: context.fence,
        leaseDurationMs: this.#leaseDurationMs,
      });
      if (inspected.outcome === "active") {
        context.fence = inspected.fence;
        context.databaseNow = inspected.databaseNow;
        context.run = inspected.run;
        context.workspace = inspected.workspace;
        return;
      }
      context.stopped = inspected.outcome === "cancelled" ? "cancelled" : inspected.outcome;
      stopSession();
    });

    try {
      const preAcquire = await this.stopPoint(context, cancellation);
      if (preAcquire) return await this.finishStopped(context, preAcquire);

      const acquisition = await this.dependencies.sandboxes.acquire({
        scope,
        signal: executionAbort.signal,
      });
      const postAcquire = await this.stopPoint(context, cancellation);
      if (acquisition.outcome === "ready") sandbox = acquisition.session;
      if (postAcquire) {
        if (sandbox && (postAcquire === "cancelled" || postAcquire === "timeout")) {
          const intent = await this.applyMutation(context, {
            idempotencyKey: `${context.attemptId}/sandbox/cleanup-intent`,
            nextAttemptStatus: "running",
            nextStage: "cleanup_intent_persisted",
            events: [attemptEvent(context, "running", "cleanup_intent_persisted")],
            outbox: [cleanupOutbox(context, sandbox, "pending", "close")],
          });
          if (isApplied(intent)) return await this.finishStopped(context, postAcquire, sandbox);
        }
        if (sandbox) await this.bestEffortOrphanCleanup(scope, sandbox);
        return await this.finishStopped(context, postAcquire);
      }
      if (acquisition.outcome === "unknown") {
        return await this.requireRecovery(context, "SANDBOX_UNKNOWN", [
          cleanupUnknownOutbox(context, acquisition.event, undefined),
        ]);
      }
      if (acquisition.outcome === "failed") {
        return await this.requireRecovery(context, acquisition.code, []);
      }
      sandbox = acquisition.session;

      // Sandbox 一旦可见，第一笔持久化必须是 cleanup intent；此提交前禁止创建或启动模型。
      const cleanupIntent = cleanupOutbox(context, sandbox, "pending", "close");
      const intent = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/sandbox/cleanup-intent`,
        nextAttemptStatus: "running",
        nextStage: "cleanup_intent_persisted",
        events: [attemptEvent(context, "running", "cleanup_intent_persisted")],
        outbox: [cleanupIntent],
      });
      if (!isApplied(intent)) return await this.handleMutationFailure(context, intent);

      const preSession = await this.stopPoint(context, cancellation);
      if (preSession) return await this.finishStopped(context, preSession, sandbox);
      session = await this.dependencies.sessions.create({
        scope,
        sandbox: sandbox.sandbox,
        rolloutProjection: claim.snapshot.rolloutProjection,
      });
      const postSession = await this.stopPoint(context, cancellation);
      if (postSession) return await this.finishStopped(context, postSession, sandbox);

      unsubscribe = session.subscribe((event) => {
        eventChain = eventChain.then(async () => {
          if (context.stopped) return;
          try {
            const encoded = agentEvent(context, event);
            const persisted = await this.applyMutation(context, {
              idempotencyKey: `${context.attemptId}/event/${encoded.sequence}`,
              events: [encoded],
              outbox: [],
            });
            if (!isApplied(persisted)) {
              context.stopped = persisted.outcome === "fence_lost" ? "fence_lost" : "unavailable";
              stopSession();
              return;
            }
            updateAgentState(context, event);
          } catch {
            context.adapterRejected = true;
            context.agentFailure = "EVENT_REJECTED";
            stopSession();
          }
        });
      });

      const modelCheckpoint = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/model-execution-started`,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [attemptEvent(context, "running", "model_execution_started")],
        outbox: [],
      });
      if (!isApplied(modelCheckpoint))
        return await this.handleMutationFailure(context, modelCheckpoint);

      const promptText = claim.snapshot.answer ?? claim.snapshot.input;
      const turn = await session.runPrompt(promptText);
      await eventChain;
      const postModel = await this.stopPoint(context, cancellation);
      if (postModel) return await this.finishStopped(context, postModel, sandbox);
      if (context.adapterRejected) {
        return await this.requireRecovery(context, "EVENT_REJECTED", [], sandbox);
      }
      if (context.agentFailure) {
        return await this.finalizeWithCleanup(
          context,
          sandbox,
          "failed",
          context.agentFailure,
          undefined,
        );
      }
      if (turn.kind === "completed" && !context.successfulStop) {
        return await this.finalizeWithCleanup(context, sandbox, "failed", "PROTOCOL", undefined);
      }

      const modelSettled = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/model-settled`,
        nextStage: "model_settled",
        events: [attemptEvent(context, "running", "model_settled")],
        outbox: [],
      });
      if (!isApplied(modelSettled)) return await this.handleMutationFailure(context, modelSettled);

      const preVerify = await this.stopPoint(context, cancellation);
      if (preVerify) return await this.finishStopped(context, preVerify, sandbox);
      const candidate = await this.dependencies.revisions.verify({
        scope,
        sandbox: sandbox.sandbox,
      });
      const postVerify = await this.stopPoint(context, cancellation);
      if (postVerify) return await this.finishStopped(context, postVerify, sandbox);
      const revision =
        candidate === undefined
          ? undefined
          : prepareRevision(context.run, context.workspace, context, candidate);
      const verified = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/workspace-verified`,
        nextStage: "workspace_verified",
        events: [attemptEvent(context, "running", "workspace_verified")],
        outbox: [],
      });
      if (!isApplied(verified)) return await this.handleMutationFailure(context, verified);

      if (turn.kind === "waiting") {
        assertRolloutProjection(turn.rolloutProjection);
        const postCheckpoint = await this.stopPoint(context, cancellation);
        if (postCheckpoint) return await this.finishStopped(context, postCheckpoint, sandbox);
        cleanupDisposition = "pause";
        const settled = await this.settleSandbox(context, sandbox, "pause");
        cleanupSettled = settled.outcome === "settled";
        if (settled.outcome !== "settled") return settled.result;
        const waiting = await this.applyMutation(context, {
          idempotencyKey: `${context.attemptId}/final/waiting`,
          nextAttemptStatus: "waiting",
          nextStage: "finished",
          events: [waitingEvent(context, turn.question, turn.rolloutProjection.checkpointId)],
          outbox: [],
          rolloutProjection: turn.rolloutProjection,
          ...(revision === undefined ? {} : { workspaceRevision: revision }),
          nextRunStatus: "waiting",
          releaseFences: true,
        });
        return isApplied(waiting)
          ? { outcome: "waiting" }
          : await this.handleMutationFailure(context, waiting);
      }

      const preArtifact = await this.stopPoint(context, cancellation);
      if (preArtifact) return await this.finishStopped(context, preArtifact, sandbox);
      await this.dependencies.artifacts.assertReadyForCompletion({
        scope,
        ...(revision === undefined ? {} : { workspaceRevisionId: revision.revision.id }),
      });
      const postArtifact = await this.stopPoint(context, cancellation);
      if (postArtifact) return await this.finishStopped(context, postArtifact, sandbox);

      const settled = await this.settleSandbox(context, sandbox, "close");
      cleanupSettled = settled.outcome === "settled";
      if (settled.outcome !== "settled") return settled.result;
      const final = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/final/succeeded`,
        nextAttemptStatus: "succeeded",
        nextStage: "finished",
        events: [attemptEvent(context, "succeeded", "finished")],
        outbox: [],
        ...(revision === undefined ? {} : { workspaceRevision: revision }),
        nextRunStatus: "succeeded",
        releaseFences: true,
      });
      return isApplied(final)
        ? { outcome: "succeeded" }
        : await this.handleMutationFailure(context, final);
    } catch {
      await eventChain.catch(() => undefined);
      if (context.stopped) return await this.finishStopped(context, context.stopped, sandbox);
      return await this.requireRecovery(context, "INTERNAL", [], sandbox);
    } finally {
      timeout.cancel();
      cancellation.removeEventListener("abort", onCancel);
      const cleanup =
        sandbox && !cleanupSettled
          ? this.bestEffortPendingCleanup(context, sandbox, cleanupDisposition)
          : Promise.resolve();
      await Promise.allSettled([
        heartbeat.stop(),
        cleanup,
        Promise.resolve().then(() => unsubscribe?.()),
        Promise.resolve().then(() => session?.dispose()),
      ]);
    }
  }

  private async stopPoint(
    context: ExecutionContext,
    cancellation: AbortSignal,
  ): Promise<ExecutionContext["stopped"]> {
    if (cancellation.aborted) context.stopped = "cancelled";
    if (context.stopped) return context.stopped;
    const inspected = await this.dependencies.persistence.inspectAndRenew({
      fence: context.fence,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (inspected.outcome === "active") {
      context.fence = inspected.fence;
      context.databaseNow = inspected.databaseNow;
      context.run = inspected.run;
      context.workspace = inspected.workspace;
      return undefined;
    }
    context.stopped = inspected.outcome === "cancelled" ? "cancelled" : inspected.outcome;
    return context.stopped;
  }

  /** 清理阶段即使业务已取消也要继续，只重新确认双栅栏和基础设施可用性。 */
  private async fencePoint(
    context: ExecutionContext,
  ): Promise<"fence_lost" | "unavailable" | "scope_mismatch" | undefined> {
    const inspected = await this.dependencies.persistence.inspectAndRenew({
      fence: context.fence,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (inspected.outcome === "active") {
      context.fence = inspected.fence;
      context.databaseNow = inspected.databaseNow;
      context.run = inspected.run;
      context.workspace = inspected.workspace;
      return undefined;
    }
    if (inspected.outcome === "cancelled") return undefined;
    return inspected.outcome;
  }

  private async applyMutation(
    context: ExecutionContext,
    input: Omit<RuntimeMutation, "fence" | "expectedAttemptVersion">,
  ): Promise<RuntimeMutationResult> {
    for (const event of input.events) assertProtocolSize(event);
    for (const outbox of input.outbox) assertProtocolSize(outbox);
    const command: RuntimeMutation = {
      ...input,
      fence: context.fence,
      expectedAttemptVersion: context.attemptVersion,
    };
    let result = await this.dependencies.persistence.mutate(command);
    if (result.outcome === "response_unknown") {
      const recovered = await this.dependencies.persistence.readMutation({
        scope: context.scope,
        idempotencyKey: input.idempotencyKey,
      });
      if (recovered.outcome === "not_found") return { outcome: "unavailable" };
      result = recovered;
    }
    if (isApplied(result)) {
      context.attemptVersion = result.attemptVersion;
      context.nextEventSequence = result.nextEventSequence;
      context.databaseNow = result.databaseNow;
    }
    return result;
  }

  private async settleSandbox(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    disposition: "pause" | "close",
  ): Promise<
    | { readonly outcome: "settled" }
    | { readonly outcome: "recovery"; readonly result: RunWorkerResult }
  > {
    const started = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/sandbox/settle-started/${disposition}`,
      nextAttemptStatus: "finalizing",
      nextStage: "finalizing",
      events: [attemptEvent(context, "finalizing", "finalizing")],
      outbox: [cleanupOutbox(context, sandbox, "started", disposition)],
    });
    if (!isApplied(started)) {
      return { outcome: "recovery", result: await this.handleMutationFailure(context, started) };
    }
    try {
      const preSettle = await this.fencePoint(context);
      if (preSettle) {
        return {
          outcome: "recovery",
          result: await this.finishStopped(context, preSettle, sandbox),
        };
      }
      const settlement = await this.dependencies.sandboxes.settle({
        scope: context.scope,
        session: sandbox,
        cleanupIntentId: cleanupIntentKey(context, sandbox),
        disposition,
      });
      const postSettle = await this.fencePoint(context);
      if (postSettle) {
        return {
          outcome: "recovery",
          result: await this.finishStopped(context, postSettle, sandbox),
        };
      }
      if (settlement.outcome === "unknown") {
        return {
          outcome: "recovery",
          result: await this.requireRecovery(context, "SANDBOX_UNKNOWN", [
            cleanupUnknownOutbox(context, settlement.event, sandbox, disposition),
          ]),
        };
      }
      const completed = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/sandbox/settle-completed/${disposition}`,
        nextStage: "sandbox_settled",
        events: [attemptEvent(context, "finalizing", "sandbox_settled")],
        outbox: [cleanupOutbox(context, sandbox, "completed", disposition)],
      });
      return isApplied(completed)
        ? { outcome: "settled" }
        : { outcome: "recovery", result: await this.handleMutationFailure(context, completed) };
    } catch {
      const pending = cleanupOutbox(context, sandbox, "pending", disposition, "INTERNAL");
      return {
        outcome: "recovery",
        result: await this.requireRecovery(context, "INTERNAL", [pending]),
      };
    }
  }

  private async finalizeWithCleanup(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    runStatus: "failed" | "cancelled",
    code: StableWorkerErrorCode,
    revision: WorkspaceRevisionCommit | undefined,
  ): Promise<RunWorkerResult> {
    const settled = await this.settleSandbox(context, sandbox, "close");
    if (settled.outcome !== "settled") return settled.result;
    const final = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/final/${runStatus}`,
      nextAttemptStatus: runStatus,
      nextStage: "finished",
      events: [attemptEvent(context, runStatus, "finished", code)],
      outbox: [],
      ...(revision === undefined ? {} : { workspaceRevision: revision }),
      nextRunStatus: runStatus,
      releaseFences: true,
    });
    return isApplied(final)
      ? { outcome: runStatus }
      : await this.handleMutationFailure(context, final);
  }

  private async finalizeWithoutRevision(
    context: ExecutionContext,
    runStatus: "failed" | "cancelled",
    code: StableWorkerErrorCode,
  ): Promise<RunWorkerResult> {
    const final = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/final/${runStatus}`,
      nextAttemptStatus: runStatus,
      nextStage: "finished",
      events: [attemptEvent(context, runStatus, "finished", code)],
      outbox: [],
      nextRunStatus: runStatus,
      releaseFences: true,
    });
    return isApplied(final)
      ? { outcome: runStatus }
      : await this.handleMutationFailure(context, final);
  }

  private async finishStopped(
    context: ExecutionContext,
    stopped: NonNullable<ExecutionContext["stopped"]>,
    sandbox?: SandboxSessionRef,
  ): Promise<RunWorkerResult> {
    if (stopped === "cancelled") {
      return sandbox
        ? await this.finalizeWithCleanup(context, sandbox, "cancelled", "CANCELLED", undefined)
        : await this.finalizeWithoutRevision(context, "cancelled", "CANCELLED");
    }
    if (stopped === "timeout") {
      return sandbox
        ? await this.finalizeWithCleanup(context, sandbox, "failed", "TIMEOUT", undefined)
        : await this.finalizeWithoutRevision(context, "failed", "TIMEOUT");
    }
    if (stopped === "fence_lost" || stopped === "scope_mismatch") return { outcome: "fence_lost" };
    return await this.requireRecovery(context, "PERSISTENCE_UNAVAILABLE", []);
  }

  private async requireRecovery(
    context: ExecutionContext,
    code: StableWorkerErrorCode,
    outbox: readonly RuntimeOutboxV1[],
    sandbox?: SandboxSessionRef,
  ): Promise<RunWorkerResult> {
    const alert = alertOutbox(context, code);
    const mutation = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/recovery/${code}`,
      nextAttemptStatus: "recovery_required",
      events: [attemptEvent(context, "recovery_required", currentStage(context), code)],
      outbox: [...outbox, alert],
      releaseFences: true,
    });
    if (sandbox) await this.bestEffortOrphanCleanup(context.scope, sandbox);
    return isApplied(mutation)
      ? { outcome: "recovery_required", code }
      : await this.handleMutationFailure(context, mutation);
  }

  private async handleMutationFailure(
    _context: ExecutionContext,
    result: RuntimeMutationResult,
  ): Promise<RunWorkerResult> {
    if (
      result.outcome === "fence_lost" ||
      result.outcome === "conflict" ||
      result.outcome === "scope_mismatch"
    ) {
      return { outcome: "fence_lost" };
    }
    return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
  }

  private async bestEffortPendingCleanup(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    disposition: "pause" | "close",
  ): Promise<void> {
    try {
      await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/sandbox/finally-pending/${disposition}`,
        outbox: [cleanupOutbox(context, sandbox, "pending", disposition, "INTERNAL")],
        events: [],
      });
    } catch {
      // cleanup intent 已在模型启动前持久化；finally 失败由 Outbox 重试，不覆盖主结果。
    }
  }

  private async bestEffortOrphanCleanup(
    scope: ExecutionScope,
    sandbox: SandboxSessionRef,
  ): Promise<void> {
    await this.dependencies.sandboxes
      .settle({
        scope,
        session: sandbox,
        cleanupIntentId: `registry:${sandbox.registryId}:orphan-cleanup`,
        disposition: "close",
      })
      .catch(() => undefined);
  }
}

function prepareRevision(
  run: Parameters<typeof prepareWorkspaceRevision>[0]["rootRun"],
  workspace: Parameters<typeof prepareWorkspaceRevision>[0]["workspace"],
  context: ExecutionContext,
  candidate: WorkspaceRevisionCandidate,
): WorkspaceRevisionCommit {
  return prepareWorkspaceRevision({
    workspace,
    rootRun: run,
    leaseEpoch: context.fence.workspaceLease.epoch,
    revisionId: candidate.revisionId,
    objectKey: candidate.objectKey,
    digest: candidate.digest,
    now: context.databaseNow,
  });
}

function attemptEvent(
  context: ExecutionContext,
  status: ExecutionAttemptStatus,
  stage: ExecutionStage,
  code?: StableWorkerErrorCode,
): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "attempt_state_changed",
    sequence: context.nextEventSequence,
    occurredAt: context.databaseNow,
    payload: { status, stage, ...(code === undefined ? {} : { code }) },
  };
  assertProtocolSize(event);
  return event;
}

function waitingEvent(
  context: ExecutionContext,
  question: string,
  checkpointId: string,
): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "run_waiting",
    sequence: context.nextEventSequence,
    occurredAt: context.databaseNow,
    payload: { question: question.slice(0, 4_000), checkpointId },
  };
  assertProtocolSize(event);
  return event;
}

function agentEvent(context: ExecutionContext, payload: RuntimeAgentEvent): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "agent_event",
    sequence: context.nextEventSequence,
    occurredAt: context.databaseNow,
    payload: sanitizeAgentEvent(payload),
  };
  assertProtocolSize(event);
  return event;
}

function sanitizeAgentEvent(event: RuntimeAgentEvent): RuntimeAgentEvent {
  if (event.type !== "error") return event;
  const messages: Readonly<Record<typeof event.code, string>> = {
    ABORTED: "模型调用已中止",
    PROVIDER: "模型 Provider 调用失败",
    PROTOCOL: "模型协议响应无效",
  };
  return { ...event, message: messages[event.code] };
}

function cleanupOutbox(
  context: ExecutionContext,
  sandbox: SandboxSessionRef,
  state: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }>["state"],
  disposition: "pause" | "close",
  retryCode?: StableWorkerErrorCode,
): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: cleanupIntentKey(context, sandbox),
    state,
    occurredAt: context.databaseNow,
    payload: {
      registryId: sandbox.registryId,
      providerSandboxId: sandbox.providerSandboxId,
      disposition,
      ...(retryCode === undefined ? {} : { retryCode }),
    },
  };
}

function cleanupIntentKey(context: ExecutionContext, sandbox: SandboxSessionRef): string {
  return `${context.attemptId}/sandbox/${sandbox.registryId}/cleanup`;
}

function assertRolloutProjection(
  projection: Parameters<AgentSessionFactoryPort["create"]>[0]["rolloutProjection"],
): void {
  if (
    projection.schemaVersion !== 1 ||
    !projection.checkpointId.trim() ||
    projection.turns.length > 200 ||
    new TextEncoder().encode(JSON.stringify(projection)).byteLength > 64 * 1024
  ) {
    throw new Error("EVENT_REJECTED");
  }
}

function cleanupUnknownOutbox(
  context: ExecutionContext,
  event: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }>["payload"]["uncertainEvent"],
  sandbox?: SandboxSessionRef,
  disposition: "pause" | "close" = "close",
): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: sandbox
      ? cleanupIntentKey(context, sandbox)
      : `${context.attemptId}/sandbox/unknown/${event?.requestId ?? "missing"}`,
    state: "unknown",
    occurredAt: context.databaseNow,
    payload: {
      registryId: sandbox?.registryId ?? `acquire:${event?.requestId ?? "unknown"}`,
      providerSandboxId: sandbox?.providerSandboxId ?? event?.sandboxId ?? "unknown",
      disposition,
      ...(event === undefined ? {} : { uncertainEvent: event }),
      retryCode: "SANDBOX_UNKNOWN",
    },
  };
}

function alertOutbox(context: ExecutionContext, code: StableWorkerErrorCode): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "runtime_alert",
    idempotencyKey: `${context.attemptId}/alert/${code}`,
    state: "pending",
    occurredAt: context.databaseNow,
    payload: { code, attemptId: context.attemptId },
  };
}

function updateAgentState(context: ExecutionContext, event: RuntimeAgentEvent): void {
  if (event.type === "message.completed" && event.stopReason === "stop") {
    context.successfulStop = true;
  }
  if (event.type === "error") {
    context.agentFailure = event.code === "ABORTED" ? "CANCELLED" : event.code;
  }
  if (event.type === "compaction.forbidden") context.agentFailure = "PROTOCOL";
}

function currentStage(context: ExecutionContext): ExecutionStage {
  return context.successfulStop ? "model_settled" : "model_execution_started";
}

function isApplied(result: RuntimeMutationResult): result is AppliedMutation {
  return result.outcome === "applied" || result.outcome === "already_applied";
}

function assertScope(scope: ExecutionScope): void {
  if (scope.rootRunId !== scope.runId) throw new Error("单 Agent 阶段要求 rootRunId 等于 runId");
}

function claimMatches(
  scope: ExecutionScope,
  fence: ExecutionFence,
  runId: string,
  workspaceId: string,
): boolean {
  return !(
    fence.scope.tenantId !== scope.tenantId ||
    fence.scope.threadId !== scope.threadId ||
    fence.scope.runId !== scope.runId ||
    fence.scope.rootRunId !== scope.rootRunId ||
    fence.scope.workspaceId !== scope.workspaceId ||
    runId !== scope.runId ||
    workspaceId !== scope.workspaceId ||
    fence.workspaceLease.rootRunId !== scope.rootRunId
  );
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
