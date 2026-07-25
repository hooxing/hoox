import type { IsoTimestamp, Run, Workspace, WorkspaceRevisionId } from "@cube-runtime/domain";
import type { ControlledRolloutProjection, RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type {
  AgentSessionFactoryPort,
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  ExecutionAttemptSnapshot,
  ExecutionAttemptStatus,
  ExecutionFence,
  ExecutionPersistencePort,
  ExecutionScope,
  ExecutionStage,
  ExternalEffectPermit,
  RuntimeEventV1,
  RuntimeMutation,
  RuntimeMutationResult,
  RuntimeOutboxV1,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  StableWorkerErrorCode,
  ValidatedWorkspaceChange,
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
  readonly externalEffectPermitMs?: number;
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
  currentRevisionId?: WorkspaceRevisionId;
  actualCommittedStage: ExecutionStage;
  actualAttemptStatus: ExecutionAttemptStatus;
  stopped?: "cancelled" | "timeout" | "fence_lost" | "unavailable" | "scope_mismatch";
  agentFailure?: StableWorkerErrorCode;
  modelCompleted: boolean;
  eventAcceptanceOpen: boolean;
  adapterRejected: boolean;
  abortPromise?: Promise<void>;
  abortSession?: () => Promise<void>;
}

type AppliedMutation = Extract<RuntimeMutationResult, { outcome: "applied" | "already_applied" }>;

export class RunWorker {
  readonly #leaseDurationMs: number;
  readonly #heartbeatMs: number;
  readonly #runTimeoutMs: number;
  readonly #externalEffectPermitMs: number;

  constructor(
    private readonly dependencies: WorkerDependencies,
    private readonly options: RunWorkerOptions,
  ) {
    this.#leaseDurationMs = positive(options.leaseDurationMs ?? 30_000, "leaseDurationMs");
    this.#heartbeatMs = positive(options.heartbeatMs ?? 10_000, "heartbeatMs");
    this.#runTimeoutMs = positive(options.runTimeoutMs ?? 15 * 60_000, "runTimeoutMs");
    this.#externalEffectPermitMs = positive(
      options.externalEffectPermitMs ?? 3_000,
      "externalEffectPermitMs",
    );
    if (this.#heartbeatMs * 2 >= this.#leaseDurationMs) {
      throw new Error("heartbeatMs 必须小于 leaseDurationMs 的一半");
    }
    if (this.#externalEffectPermitMs >= this.#leaseDurationMs) {
      throw new Error("外部副作用许可必须短于租约");
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
    if (
      !snapshotMatches(
        scope,
        claim.fence,
        claim.snapshot.run,
        claim.snapshot.workspace,
        claim.snapshot.attempt,
      )
    ) {
      const released = await this.dependencies.persistence.mutate({
        idempotencyKey: `${claim.snapshot.attempt.attemptId}/claim/scope-mismatch`,
        fence: claim.fence,
        expectedAttemptVersion: claim.snapshot.attempt.version,
        nextAttemptStatus: "recovery_required",
        events: [
          rawAttemptEvent(
            claim.snapshot.attempt.nextEventSequence,
            "recovery_required",
            "claimed",
            "PROTOCOL",
          ),
        ],
        outbox: [rawAlertOutbox(claim.snapshot.attempt.attemptId, "PROTOCOL")],
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
      ...(claim.snapshot.attempt.currentRevisionId === undefined
        ? {}
        : { currentRevisionId: claim.snapshot.attempt.currentRevisionId }),
      actualCommittedStage: claim.snapshot.attempt.stage,
      actualAttemptStatus: claim.snapshot.attempt.status,
      modelCompleted: false,
      eventAcceptanceOpen: true,
      adapterRejected: false,
    };
    const cancellation = this.dependencies.cancellation.signalFor(scope);
    let session: WorkerAgentSessionPort | undefined;
    let sandbox: SandboxSessionRef | undefined;
    let unsubscribe: (() => void) | undefined;
    let eventChain = Promise.resolve();
    const executionAbort = new AbortController();

    const requestAbort = (): Promise<void> => {
      closeEventAcceptance(context);
      if (!context.abortPromise) {
        context.abortPromise = context.abortSession?.() ?? Promise.resolve();
      }
      return context.abortPromise;
    };
    const onCancel = () => {
      context.stopped = "cancelled";
      executionAbort.abort("run_cancelled");
      void requestAbort();
    };
    cancellation.addEventListener("abort", onCancel, { once: true });
    if (cancellation.aborted) onCancel();
    const timeout = this.dependencies.clock.schedule(this.#runTimeoutMs, () => {
      context.stopped = "timeout";
      executionAbort.abort("run_timeout");
      void requestAbort();
    });
    const heartbeat = this.dependencies.clock.startHeartbeat(this.#heartbeatMs, async () => {
      try {
        const inspected = await this.dependencies.persistence.inspectAndRenew({
          fence: context.fence,
          leaseDurationMs: this.#leaseDurationMs,
        });
        if (inspected.outcome === "active" && inspectionMatches(context, inspected)) {
          acceptInspection(context, inspected);
          return;
        }
        context.stopped =
          inspected.outcome === "active"
            ? "scope_mismatch"
            : inspected.outcome === "cancelled"
              ? "cancelled"
              : inspected.outcome;
      } catch {
        context.stopped = "unavailable";
      }
      await requestAbort();
    });

    try {
      try {
        assertRolloutProjection(claim.snapshot.rolloutProjection);
      } catch {
        return await this.requireRecovery(context, "EVENT_REJECTED", []);
      }
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
          cleanupUnknownOutbox(context, acquisition.event),
        ]);
      }
      if (acquisition.outcome === "failed") {
        return await this.requireRecovery(context, acquisition.code, []);
      }
      sandbox = acquisition.session;

      // Sandbox 可见后的首个 checkpoint 与 cleanup intent 在同一事务中提交。
      const intent = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/sandbox/cleanup-intent`,
        nextAttemptStatus: "running",
        nextStage: "cleanup_intent_persisted",
        events: [attemptEvent(context, "running", "cleanup_intent_persisted")],
        outbox: [cleanupOutbox(context, sandbox, "pending", "close")],
      });
      if (!isApplied(intent)) return await this.handleMutationFailure(intent);

      const preSession = await this.stopPoint(context, cancellation);
      if (preSession) return await this.finishStopped(context, preSession, sandbox);
      session = await this.dependencies.sessions.create({
        scope,
        sandbox: sandbox.sandbox,
        rolloutProjection: claim.snapshot.rolloutProjection,
        authorizeToolEffect: () => this.authorizeEffect(context, cancellation, "tool_execution"),
      });
      context.abortSession = () => session?.abort().catch(() => undefined) ?? Promise.resolve();
      const postSession = await this.stopPoint(context, cancellation);
      if (postSession) return await this.finishStopped(context, postSession, sandbox);

      unsubscribe = session.subscribe((event) => {
        if (!context.eventAcceptanceOpen) return;
        eventChain = eventChain.then(async () => {
          // 协议拒绝或持久化失败会原子关闭入口；已排队事件只 drain。
          if (!context.eventAcceptanceOpen) return;
          try {
            const encoded = agentEvent(context, event);
            const persisted = await this.applyMutation(context, {
              idempotencyKey: `${context.attemptId}/event/${encoded.sequence}`,
              events: [encoded],
              outbox: [],
            });
            if (!isApplied(persisted)) {
              closeEventAcceptance(context);
              context.stopped =
                persisted.outcome === "fence_lost" || persisted.outcome === "scope_mismatch"
                  ? "fence_lost"
                  : "unavailable";
              await requestAbort();
              return;
            }
            if (!context.eventAcceptanceOpen) return;
            updateAgentState(context, event);
          } catch {
            context.adapterRejected = true;
            context.agentFailure = "EVENT_REJECTED";
            closeEventAcceptance(context);
            await requestAbort();
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
      if (!isApplied(modelCheckpoint)) return await this.handleMutationFailure(modelCheckpoint);

      // checkpoint 成功后仍必须同步重验；这是模型副作用窗口前最后一道 stop-point。
      const preModel = await this.stopPoint(context, cancellation);
      if (preModel) return await this.finishStopped(context, preModel, sandbox);
      const modelPermit = await this.authorizeEffect(context, cancellation, "model_start");
      const promptText = claim.snapshot.answer ?? claim.snapshot.input;
      const turn = await session.runPrompt(promptText, modelPermit);
      await eventChain;
      if (context.abortPromise) await context.abortPromise;
      const postModel = await this.stopPoint(context, cancellation);
      if (postModel) return await this.finishStopped(context, postModel, sandbox);
      if (context.adapterRejected) {
        return await this.recoverWithCleanup(context, sandbox, "EVENT_REJECTED", cancellation);
      }
      if (context.agentFailure) {
        return await this.finalizeWithCleanup(
          context,
          sandbox,
          "failed",
          context.agentFailure,
          cancellation,
        );
      }
      if (turn.kind === "completed" && !context.modelCompleted) {
        return await this.finalizeWithCleanup(context, sandbox, "failed", "PROTOCOL", cancellation);
      }

      const modelSettled = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/model-settled`,
        nextStage: "model_settled",
        events: [attemptEvent(context, "running", "model_settled")],
        outbox: [],
      });
      if (!isApplied(modelSettled)) return await this.handleMutationFailure(modelSettled);

      const preVerify = await this.stopPoint(context, cancellation);
      if (preVerify) return await this.finishStopped(context, preVerify, sandbox);
      const candidate = await this.dependencies.revisions.verify({
        scope,
        ...(context.currentRevisionId === undefined
          ? {}
          : { expectedCurrentRevisionId: context.currentRevisionId }),
        sandbox: sandbox.sandbox,
      });
      const postVerify = await this.stopPoint(context, cancellation);
      if (postVerify) return await this.finishStopped(context, postVerify, sandbox);
      const workspaceChange = validateWorkspaceCandidate(context, candidate);
      const verified = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/workspace-verified`,
        nextStage: "workspace_verified",
        events: [attemptEvent(context, "running", "workspace_verified")],
        outbox: [],
      });
      if (!isApplied(verified)) return await this.handleMutationFailure(verified);

      if (turn.kind === "waiting") {
        try {
          assertRolloutProjection(turn.rolloutProjection);
        } catch {
          return await this.recoverWithCleanup(context, sandbox, "EVENT_REJECTED", cancellation);
        }
        const preSettle = await this.stopPoint(context, cancellation);
        if (preSettle) return await this.finishStopped(context, preSettle, sandbox);
        const settled = await this.settleSandbox(context, sandbox, "pause");
        if (settled.outcome !== "settled") return settled.result;
        // settle 返回后、终态事务前再次 stop；取消必须覆盖 waiting/success。
        const postSettle = await this.stopPoint(context, cancellation);
        if (postSettle) return await this.finishStopped(context, postSettle);
        const waiting = await this.applyMutation(context, {
          idempotencyKey: `${context.attemptId}/final/waiting`,
          nextAttemptStatus: "waiting",
          nextStage: "finished",
          events: [waitingEvent(context, turn.question, turn.rolloutProjection.checkpointId)],
          outbox: [],
          rolloutProjection: turn.rolloutProjection,
          ...(workspaceChange === undefined ? {} : { workspaceChange }),
          nextRunStatus: "waiting",
          releaseFences: true,
        });
        return isApplied(waiting)
          ? { outcome: "waiting" }
          : await this.handleMutationFailure(waiting);
      }

      const preArtifact = await this.stopPoint(context, cancellation);
      if (preArtifact) return await this.finishStopped(context, preArtifact, sandbox);
      await this.dependencies.artifacts.assertReadyForCompletion({
        scope,
        ...(workspaceChange === undefined
          ? {}
          : { workspaceRevisionId: workspaceChange.revisionId }),
      });
      const postArtifact = await this.stopPoint(context, cancellation);
      if (postArtifact) return await this.finishStopped(context, postArtifact, sandbox);

      const settled = await this.settleSandbox(context, sandbox, "close");
      if (settled.outcome !== "settled") return settled.result;
      // settle 与 Run success 之间必须同步重验，避免取消被成功覆盖。
      const postSettle = await this.stopPoint(context, cancellation);
      if (postSettle) return await this.finishStopped(context, postSettle);
      const final = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/final/succeeded`,
        nextAttemptStatus: "succeeded",
        nextStage: "finished",
        events: [attemptEvent(context, "succeeded", "finished")],
        outbox: [],
        ...(workspaceChange === undefined ? {} : { workspaceChange }),
        nextRunStatus: "succeeded",
        releaseFences: true,
      });
      return isApplied(final) ? { outcome: "succeeded" } : await this.handleMutationFailure(final);
    } catch {
      closeEventAcceptance(context);
      await eventChain.catch(() => undefined);
      await requestAbort();
      if (context.stopped) return await this.finishStopped(context, context.stopped, sandbox);
      return sandbox
        ? await this.recoverWithCleanup(context, sandbox, "INTERNAL", cancellation)
        : await this.requireRecovery(context, "INTERNAL", []);
    } finally {
      timeout.cancel();
      cancellation.removeEventListener("abort", onCancel);
      closeEventAcceptance(context);
      // abort 完成后才允许取消订阅、释放 Session；cleanup 已由持久 Outbox/Saga 接管。
      await Promise.allSettled([heartbeat.stop(), context.abortPromise ?? Promise.resolve()]);
      await Promise.allSettled([
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
    try {
      const inspected = await this.dependencies.persistence.inspectAndRenew({
        fence: context.fence,
        leaseDurationMs: this.#leaseDurationMs,
      });
      if (inspected.outcome === "active") {
        if (!inspectionMatches(context, inspected)) {
          context.stopped = "scope_mismatch";
          return context.stopped;
        }
        acceptInspection(context, inspected);
        if (cancellation.aborted) context.stopped = "cancelled";
        return context.stopped;
      }
      context.stopped = inspected.outcome === "cancelled" ? "cancelled" : inspected.outcome;
    } catch {
      context.stopped = "unavailable";
    }
    return context.stopped;
  }

  /** 清理状态推进忽略业务取消，但仍严格校验双栅栏与 scope/head checkpoint。 */
  private async fencePoint(
    context: ExecutionContext,
  ): Promise<"fence_lost" | "unavailable" | "scope_mismatch" | undefined> {
    try {
      const inspected = await this.dependencies.persistence.inspectAndRenew({
        fence: context.fence,
        leaseDurationMs: this.#leaseDurationMs,
      });
      if (inspected.outcome === "active") {
        if (!inspectionMatches(context, inspected)) return "scope_mismatch";
        acceptInspection(context, inspected);
        return undefined;
      }
      if (inspected.outcome === "cancelled") return undefined;
      return inspected.outcome;
    } catch {
      return "unavailable";
    }
  }

  private async authorizeEffect(
    context: ExecutionContext,
    cancellation: AbortSignal,
    effect: ExternalEffectPermit["effect"],
  ): Promise<ExternalEffectPermit> {
    if (cancellation.aborted) context.stopped = "cancelled";
    if (context.stopped) throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    const result = await this.dependencies.persistence.issueExternalEffectPermit({
      fence: context.fence,
      expectedAttemptVersion: context.attemptVersion,
      effect,
      permitDurationMs: this.#externalEffectPermitMs,
    });
    if (result.outcome !== "authorized" || !permitMatches(context, result.permit, effect)) {
      context.stopped =
        result.outcome === "authorized" || result.outcome === "scope_mismatch"
          ? "scope_mismatch"
          : result.outcome === "cancelled"
            ? "cancelled"
            : result.outcome === "conflict" || result.outcome === "fence_lost"
              ? "fence_lost"
              : "unavailable";
      closeEventAcceptance(context);
      if (!context.abortPromise)
        context.abortPromise = context.abortSession?.() ?? Promise.resolve();
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    return result.permit;
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
      // readback 必须使用原始完整 scope；Revision head 推进不能放宽查询。
      const recovered = await this.dependencies.persistence.readMutation({
        scope: context.scope,
        idempotencyKey: input.idempotencyKey,
      });
      if (recovered.outcome === "not_found") return { outcome: "unavailable" };
      result = recovered;
    }
    if (isApplied(result)) {
      if (!appliedSnapshotMatches(context, result, input)) return { outcome: "scope_mismatch" };
      context.attemptVersion = result.attemptVersion;
      context.nextEventSequence = result.nextEventSequence;
      context.databaseNow = result.databaseNow;
      context.run = result.run;
      context.workspace = result.workspace;
      context.actualCommittedStage = result.attempt.stage;
      context.actualAttemptStatus = result.attempt.status;
      if (result.attempt.currentRevisionId === undefined) delete context.currentRevisionId;
      else context.currentRevisionId = result.attempt.currentRevisionId;
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
      return { outcome: "recovery", result: await this.handleMutationFailure(started) };
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
        return { outcome: "recovery", result: await this.finishStopped(context, postSettle) };
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
        : { outcome: "recovery", result: await this.handleMutationFailure(completed) };
    } catch {
      // started 不能回退为 pending；保留 Saga checkpoint 交给恢复协调器处理。
      return {
        outcome: "recovery",
        result: await this.requireRecovery(context, "INTERNAL", []),
      };
    }
  }

  private async recoverWithCleanup(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    code: StableWorkerErrorCode,
    cancellation: AbortSignal,
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    const settled = await this.settleSandbox(context, sandbox, "close");
    if (settled.outcome !== "settled") return settled.result;
    const stopped = await this.stopPoint(context, cancellation);
    if (stopped) return await this.finishStopped(context, stopped);
    return await this.requireRecovery(context, code, []);
  }

  private async finalizeWithCleanup(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    runStatus: "failed" | "cancelled",
    code: StableWorkerErrorCode,
    cancellation: AbortSignal,
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    const settled = await this.settleSandbox(context, sandbox, "close");
    if (settled.outcome !== "settled") return settled.result;
    const stopped = await this.stopPoint(context, cancellation);
    if (stopped === "cancelled")
      return await this.finalizeWithoutRevision(context, "cancelled", "CANCELLED");
    if (stopped && stopped !== "timeout") return await this.finishStopped(context, stopped);
    return await this.finalizeWithoutRevision(context, runStatus, code);
  }

  private async finalizeWithoutRevision(
    context: ExecutionContext,
    runStatus: "failed" | "cancelled",
    code: StableWorkerErrorCode,
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    const final = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/final/${runStatus}`,
      nextAttemptStatus: runStatus,
      nextStage: "finished",
      events: [attemptEvent(context, runStatus, "finished", code)],
      outbox: [],
      nextRunStatus: runStatus,
      releaseFences: true,
    });
    return isApplied(final) ? { outcome: runStatus } : await this.handleMutationFailure(final);
  }

  private async finishStopped(
    context: ExecutionContext,
    stopped: NonNullable<ExecutionContext["stopped"]>,
    sandbox?: SandboxSessionRef,
  ): Promise<RunWorkerResult> {
    closeEventAcceptance(context);
    if (context.abortPromise) await context.abortPromise;
    if (stopped === "cancelled") {
      return sandbox
        ? await this.finalizeWithCleanup(
            context,
            sandbox,
            "cancelled",
            "CANCELLED",
            this.dependencies.cancellation.signalFor(context.scope),
          )
        : await this.finalizeWithoutRevision(context, "cancelled", "CANCELLED");
    }
    if (stopped === "timeout") {
      return sandbox
        ? await this.finalizeWithCleanup(
            context,
            sandbox,
            "failed",
            "TIMEOUT",
            this.dependencies.cancellation.signalFor(context.scope),
          )
        : await this.finalizeWithoutRevision(context, "failed", "TIMEOUT");
    }
    if (stopped === "fence_lost" || stopped === "scope_mismatch") return { outcome: "fence_lost" };
    return await this.requireRecovery(context, "PERSISTENCE_UNAVAILABLE", []);
  }

  private async requireRecovery(
    context: ExecutionContext,
    code: StableWorkerErrorCode,
    outbox: readonly RuntimeOutboxV1[],
  ): Promise<RunWorkerResult> {
    closeEventAcceptance(context);
    if (context.abortPromise) await context.abortPromise;
    const mutation = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/recovery/${code}`,
      nextAttemptStatus: "recovery_required",
      events: [attemptEvent(context, "recovery_required", context.actualCommittedStage, code)],
      outbox: [...outbox, alertOutbox(context, code)],
      releaseFences: true,
    });
    return isApplied(mutation)
      ? { outcome: "recovery_required", code }
      : await this.handleMutationFailure(mutation);
  }

  private async handleMutationFailure(result: RuntimeMutationResult): Promise<RunWorkerResult> {
    if (
      result.outcome === "fence_lost" ||
      result.outcome === "conflict" ||
      result.outcome === "scope_mismatch"
    ) {
      return { outcome: "fence_lost" };
    }
    return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
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

function rawAttemptEvent(
  sequence: number,
  status: ExecutionAttemptStatus,
  stage: ExecutionStage,
  code?: StableWorkerErrorCode,
): RuntimeEventV1 {
  return {
    schemaVersion: 1,
    kind: "attempt_state_changed",
    sequence,
    payload: { status, stage, ...(code === undefined ? {} : { code }) },
  };
}

function attemptEvent(
  context: ExecutionContext,
  status: ExecutionAttemptStatus,
  stage: ExecutionStage,
  code?: StableWorkerErrorCode,
): RuntimeEventV1 {
  const event = rawAttemptEvent(context.nextEventSequence, status, stage, code);
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
  state: "pending" | "started" | "completed",
  disposition: "pause" | "close",
): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: cleanupIntentKey(context, sandbox),
    state,
    payload: {
      registryId: sandbox.registryId,
      providerSandboxId: sandbox.providerSandboxId,
      disposition,
    },
  };
}

function cleanupIntentKey(context: ExecutionContext, sandbox: SandboxSessionRef): string {
  return `${context.attemptId}/sandbox/${sandbox.registryId}/cleanup`;
}

function cleanupUnknownOutbox(
  context: ExecutionContext,
  event: NonNullable<
    Extract<
      RuntimeOutboxV1,
      { kind: "sandbox_cleanup"; state: "unknown" }
    >["payload"]["uncertainEvent"]
  >,
  sandbox?: SandboxSessionRef,
  disposition: "pause" | "close" = "close",
): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: sandbox
      ? cleanupIntentKey(context, sandbox)
      : `${context.attemptId}/sandbox/unknown/${event.requestId}`,
    state: "unknown",
    payload: {
      registryId: sandbox?.registryId ?? `acquire:${event.requestId}`,
      providerSandboxId: sandbox?.providerSandboxId ?? event.sandboxId ?? "unknown",
      disposition,
      uncertainEvent: event,
      retryCode: "SANDBOX_UNKNOWN",
    },
  };
}

function rawAlertOutbox(attemptId: string, code: StableWorkerErrorCode): RuntimeOutboxV1 {
  return {
    schemaVersion: 1,
    kind: "runtime_alert",
    idempotencyKey: `${attemptId}/alert/${code}`,
    state: "pending",
    payload: { code, attemptId },
  };
}

function alertOutbox(context: ExecutionContext, code: StableWorkerErrorCode): RuntimeOutboxV1 {
  return rawAlertOutbox(context.attemptId, code);
}

function assertRolloutProjection(projection: ControlledRolloutProjection): void {
  if (
    projection.schemaVersion !== 1 ||
    !projection.checkpointId.trim() ||
    projection.checkpointId.length > 200 ||
    projection.turns.length > 200
  ) {
    throw new Error("EVENT_REJECTED");
  }
  let totalBytes = 0;
  for (const turn of projection.turns) {
    if (turn.role !== "user" && turn.role !== "assistant") throw new Error("EVENT_REJECTED");
    const text = turn.text.trim();
    if (!text || text.length > 16_000 || hasHostAbsolutePath(text)) {
      throw new Error("EVENT_REJECTED");
    }
    totalBytes += new TextEncoder().encode(text).byteLength;
  }
  if (
    totalBytes > 64 * 1024 ||
    new TextEncoder().encode(JSON.stringify(projection)).byteLength > 64 * 1024
  ) {
    throw new Error("EVENT_REJECTED");
  }
}

function hasHostAbsolutePath(text: string): boolean {
  return /(?:[A-Za-z]:[\\/]|\/(?:home|Users|var\/lib|opt|srv)\/)/u.test(text);
}

function validateWorkspaceCandidate(
  context: ExecutionContext,
  candidate: WorkspaceRevisionCandidate | undefined,
): ValidatedWorkspaceChange | undefined {
  if (candidate === undefined) return undefined;
  if (
    candidate.tenantId !== context.scope.tenantId ||
    candidate.threadId !== context.scope.threadId ||
    candidate.workspaceId !== context.scope.workspaceId ||
    candidate.rootRunId !== context.scope.rootRunId ||
    candidate.parentRevisionId !== context.currentRevisionId
  ) {
    throw new Error("WORKSPACE_CONFLICT");
  }
  return candidate;
}

function updateAgentState(context: ExecutionContext, event: RuntimeAgentEvent): void {
  if (event.type === "message.completed" && event.stopReason === "stop") {
    context.modelCompleted = true;
  }
  if (event.type === "error") {
    context.agentFailure = event.code === "ABORTED" ? "CANCELLED" : event.code;
  }
  if (event.type === "compaction.forbidden") context.agentFailure = "PROTOCOL";
}

function closeEventAcceptance(context: ExecutionContext): void {
  context.eventAcceptanceOpen = false;
}

function isApplied(result: RuntimeMutationResult): result is AppliedMutation {
  return result.outcome === "applied" || result.outcome === "already_applied";
}

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
}

function entitiesMatch(scope: ExecutionScope, run: Run, workspace: Workspace): boolean {
  return (
    run.id === scope.runId &&
    run.tenantId === scope.tenantId &&
    run.threadId === scope.threadId &&
    workspace.id === scope.workspaceId &&
    workspace.tenantId === scope.tenantId &&
    workspace.threadId === scope.threadId
  );
}

function snapshotMatches(
  scope: ExecutionScope,
  fence: ExecutionFence,
  run: Run,
  workspace: Workspace,
  attempt: ExecutionAttemptSnapshot,
): boolean {
  return (
    sameScope(scope, fence.scope) &&
    entitiesMatch(scope, run, workspace) &&
    run.status === "running" &&
    attempt.status === "claimed" &&
    attempt.stage === "claimed" &&
    attempt.version === 0 &&
    fence.workspaceLease.rootRunId === scope.rootRunId &&
    workspace.writerLease?.rootRunId === scope.rootRunId &&
    workspace.writerLease.epoch === fence.workspaceLease.epoch &&
    workspace.currentRevisionId === attempt.currentRevisionId
  );
}

function inspectionMatches(
  context: ExecutionContext,
  inspected: Extract<
    Awaited<ReturnType<ExecutionPersistencePort["inspectAndRenew"]>>,
    { outcome: "active" }
  >,
): boolean {
  return (
    sameScope(context.scope, inspected.fence.scope) &&
    entitiesMatch(context.scope, inspected.run, inspected.workspace) &&
    inspected.fence.workspaceLease.rootRunId === context.scope.rootRunId &&
    inspected.workspace.currentRevisionId === context.currentRevisionId
  );
}

function acceptInspection(
  context: ExecutionContext,
  inspected: Extract<
    Awaited<ReturnType<ExecutionPersistencePort["inspectAndRenew"]>>,
    { outcome: "active" }
  >,
): void {
  context.fence = inspected.fence;
  context.databaseNow = inspected.databaseNow;
  context.run = inspected.run;
  context.workspace = inspected.workspace;
}

function appliedSnapshotMatches(
  context: ExecutionContext,
  result: AppliedMutation,
  command: Omit<RuntimeMutation, "fence" | "expectedAttemptVersion">,
): boolean {
  const expectedStage = command.nextStage ?? context.actualCommittedStage;
  const expectedStatus = command.nextAttemptStatus ?? context.actualAttemptStatus;
  const expectedRevision = command.workspaceChange?.revisionId ?? context.currentRevisionId;
  return (
    sameScope(context.scope, result.scope) &&
    entitiesMatch(context.scope, result.run, result.workspace) &&
    result.attempt.attemptId === context.attemptId &&
    result.attempt.version === result.attemptVersion &&
    result.attempt.nextEventSequence === result.nextEventSequence &&
    result.attempt.stage === expectedStage &&
    result.attempt.status === expectedStatus &&
    result.attempt.currentRevisionId === expectedRevision &&
    (command.nextRunStatus === undefined || result.run.status === command.nextRunStatus) &&
    result.workspace.currentRevisionId === result.attempt.currentRevisionId
  );
}

function permitMatches(
  context: ExecutionContext,
  permit: ExternalEffectPermit,
  effect: ExternalEffectPermit["effect"],
): boolean {
  return (
    permit.effect === effect &&
    sameScope(permit.scope, context.scope) &&
    permit.runClaimToken === context.fence.runClaim.token &&
    permit.runClaimEpoch === context.fence.runClaim.epoch &&
    permit.workspaceRootRunId === context.fence.workspaceLease.rootRunId &&
    permit.workspaceLeaseEpoch === context.fence.workspaceLease.epoch &&
    permit.attemptVersion === context.attemptVersion &&
    Date.parse(permit.expiresAt) > Date.parse(context.databaseNow)
  );
}

function assertScope(scope: ExecutionScope): void {
  if (scope.rootRunId !== scope.runId) throw new Error("单 Agent 阶段要求 rootRunId 等于 runId");
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
