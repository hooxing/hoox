import type {
  IsoTimestamp,
  Run,
  Sha256Digest,
  Workspace,
  WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import { DurableOperationLane } from "./durable-operation-lane.js";
import {
  assertControlledRolloutProjection,
  digestCanonical,
  outboxPayloadDigest,
  rolloutProjectionDigest,
  runtimeMutationDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "./mutation-protocol.js";
import type {
  AgentSessionFactoryPort,
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  ConsumedExternalEffectAuthorization,
  ExecutionAttemptSnapshot,
  ExecutionAttemptStatus,
  ExecutionFence,
  ExecutionPersistencePort,
  ExecutionScope,
  ExecutionStage,
  ExternalEffectCall,
  ExternalEffectPermit,
  OrphanSandboxCleanupPort,
  RecoveryMetricsPort,
  RuntimeEventV1,
  RuntimeMutation,
  RuntimeMutationResult,
  RuntimeOutboxReceiptV1,
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
  readonly maxArtifactCorrectionRounds?: number;
  readonly artifactCorrectionPromptBudgetBytes?: number;
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
  readonly orphanSandboxes: OrphanSandboxCleanupPort;
  readonly sessions: AgentSessionFactoryPort;
  readonly cancellation: CancellationPort;
  readonly artifacts: ArtifactPublicationPort;
  readonly clock: ClockPort;
  readonly metrics: RecoveryMetricsPort;
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
  projectionVersion: number;
  readonly durableLane: DurableOperationLane;
  readonly toolStartedGates: Map<string, ToolStartedGate>;
  readonly cleanupFacts: Map<string, CleanupReceiptFacts>;
  stopped?: "cancelled" | "timeout" | "fence_lost" | "unavailable" | "scope_mismatch";
  agentFailure?: StableWorkerErrorCode;
  modelCompleted: boolean;
  eventAcceptanceOpen: boolean;
  adapterRejected: boolean;
  abortPromise?: Promise<void>;
  abortSession?: () => Promise<void>;
}

interface ToolStartedGate {
  readonly name: string;
  readonly committed: Promise<void>;
  authorizationRequested: boolean;
  resolve(): void;
}

interface CleanupReceiptFacts {
  readonly armedAt: IsoTimestamp;
  readonly identityDigest: Sha256Digest;
  readonly disposition?: "pause" | "close";
}

type AppliedMutation = Extract<RuntimeMutationResult, { outcome: "applied" | "already_applied" }>;

export class RunWorker {
  readonly #leaseDurationMs: number;
  readonly #heartbeatMs: number;
  readonly #runTimeoutMs: number;
  readonly #externalEffectPermitMs: number;
  readonly #maxArtifactCorrectionRounds: number;
  readonly #artifactCorrectionPromptBudgetBytes: number;

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
    this.#maxArtifactCorrectionRounds = boundedNonNegativeInteger(
      options.maxArtifactCorrectionRounds ?? 2,
      2,
      "maxArtifactCorrectionRounds",
    );
    this.#artifactCorrectionPromptBudgetBytes = boundedPositiveInteger(
      options.artifactCorrectionPromptBudgetBytes ?? 8 * 1_024,
      8 * 1_024,
      "artifactCorrectionPromptBudgetBytes",
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
    const durableLane = new DurableOperationLane();
    if (
      !snapshotMatches(
        scope,
        claim.fence,
        claim.snapshot.run,
        claim.snapshot.workspace,
        claim.snapshot.attempt,
      )
    ) {
      const unsigned: Omit<RuntimeMutation, "commandDigest"> = {
        schemaVersion: 1,
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
      };
      const released = await durableLane.run(() =>
        this.dependencies.persistence.mutate({
          ...unsigned,
          commandDigest: runtimeMutationDigest(unsigned),
        }),
      );
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
      projectionVersion: claim.snapshot.attempt.projectionVersion,
      durableLane,
      toolStartedGates: new Map(),
      cleanupFacts: new Map(),
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
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = this.dependencies.clock.startHeartbeat(this.#heartbeatMs, () => {
      if (heartbeatInFlight) return heartbeatInFlight;
      const task = (async () => {
        try {
          await context.durableLane.run(async () => {
            if (context.stopped) return;
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
          });
        } catch {
          context.stopped = "unavailable";
        }
        if (context.stopped) await requestAbort().catch(() => undefined);
      })();
      heartbeatInFlight = task;
      const clearHeartbeat = () => {
        if (heartbeatInFlight === task) heartbeatInFlight = undefined;
      };
      void task.then(clearHeartbeat, clearHeartbeat);
      return task;
    });

    try {
      try {
        assertControlledRolloutProjection(claim.snapshot.rolloutProjection);
      } catch {
        return await this.requireRecovery(context, "EVENT_REJECTED", []);
      }
      const preAcquire = await this.stopPoint(context, cancellation);
      if (preAcquire) return await this.finishStopped(context, preAcquire);

      let acquisition: Awaited<ReturnType<SandboxSessionRegistryPort["acquire"]>>;
      try {
        acquisition = await this.dependencies.sandboxes.acquire({
          scope,
          signal: executionAbort.signal,
        });
      } catch {
        return await this.requireRecovery(context, "SANDBOX_FAILED", []);
      }
      if (acquisition.outcome === "ready") sandbox = acquisition.session;
      // UNKNOWN 是 acquire 已发生但结果不确定的独立恢复事实；必须先提交，再响应并发取消/超时。
      if (acquisition.outcome === "unknown") {
        const unknownFact = await this.applyMutation(context, {
          idempotencyKey: `${context.attemptId}/sandbox/acquire-unknown/${acquisition.event.requestId}`,
          events: [],
          outbox: [cleanupUnknownOutbox(context, acquisition.event)],
        });
        if (!isApplied(unknownFact)) return await this.handleMutationFailure(unknownFact);
      }
      const postAcquire = await this.stopPoint(context, cancellation);
      if (postAcquire) {
        if (sandbox && (postAcquire === "cancelled" || postAcquire === "timeout")) {
          const intent = await this.applyMutation(context, {
            idempotencyKey: `${context.attemptId}/sandbox/cleanup-intent`,
            nextAttemptStatus: "running",
            nextStage: "cleanup_intent_persisted",
            events: [attemptEvent(context, "running", "cleanup_intent_persisted")],
            outbox: [cleanupOutbox(context, sandbox, "pending")],
          });
          if (isApplied(intent)) return await this.finishStopped(context, postAcquire, sandbox);
          await this.bestEffortOrphanCleanup(scope, sandbox, intent.outcome);
          return await this.handleMutationFailure(intent);
        }
        if (sandbox) await this.bestEffortOrphanCleanup(scope, sandbox, postAcquire);
        return await this.finishStopped(context, postAcquire);
      }
      if (acquisition.outcome === "unknown") {
        return await this.requireRecovery(context, "SANDBOX_UNKNOWN", []);
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
        outbox: [cleanupOutbox(context, sandbox, "pending")],
      });
      if (!isApplied(intent)) {
        // intent 未被 receipt 证明提交，不能假设 Outbox 存在；registry 事实独立驱动孤儿清理。
        await this.bestEffortOrphanCleanup(scope, sandbox, intent.outcome);
        return await this.handleMutationFailure(intent);
      }

      const preSession = await this.stopPoint(context, cancellation);
      if (preSession) return await this.finishStopped(context, preSession, sandbox);
      session = await this.dependencies.sessions.create({
        scope,
        attemptId: context.attemptId,
        sandbox: sandbox.sandbox,
        rolloutProjection: claim.snapshot.rolloutProjection,
        authorizeToolEffect: (call) =>
          this.authorizeToolEffectAfterStarted(context, cancellation, call),
      });
      context.abortSession = () => session?.abort().catch(() => undefined) ?? Promise.resolve();
      const postSession = await this.stopPoint(context, cancellation);
      if (postSession) return await this.finishStopped(context, postSession, sandbox);

      unsubscribe = session.subscribe((event) => {
        if (!context.eventAcceptanceOpen) return;
        const toolStartedGate =
          event.type === "tool.started" ? registerToolStarted(context, event) : undefined;
        eventChain = eventChain.then(async () => {
          // 协议拒绝或持久化失败会原子关闭入口；已排队事件只 drain。
          if (!context.eventAcceptanceOpen) {
            toolStartedGate?.resolve();
            return;
          }
          try {
            const encoded = agentEvent(context, event);
            const persisted = await this.applyMutation(context, {
              idempotencyKey: `${context.attemptId}/event/${encoded.sequence}`,
              events: [encoded],
              outbox: [],
              ...(event.type === "tool.started"
                ? { effectInvocation: { callId: event.callId, toolName: event.name } }
                : {}),
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
          } finally {
            toolStartedGate?.resolve();
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

      let promptText = claim.snapshot.answer ?? claim.snapshot.input;
      let correctionRound = 0;
      let correctionPromptBytes = 0;
      let workspaceChange: ValidatedWorkspaceChange | undefined;

      // 必需交付物缺失属于可修正业务状态：保持同一 Session、双栅栏和 Attempt，持久化反馈后再启动模型。
      for (;;) {
        const preModel = await this.stopPoint(context, cancellation);
        if (preModel) return await this.finishStopped(context, preModel, sandbox);
        const modelEffect = correctionRound === 0 ? "model_start" : "model_continue";
        const modelCallId =
          correctionRound === 0
            ? `${context.attemptId}/model/start`
            : `${context.attemptId}/model/correction/${correctionRound}`;
        const modelAuthorization = await this.authorizeEffect(context, cancellation, modelEffect, {
          callId: modelCallId,
          toolName: "pi_model",
          argsDigest: digestCanonical({ prompt: promptText }),
        });
        context.modelCompleted = false;
        const turn = await session.runPrompt(promptText, modelAuthorization);
        await eventChain;
        if (context.abortPromise) await context.abortPromise;
        const postModel = await this.stopPoint(context, cancellation);
        if (postModel) return await this.finishStopped(context, postModel, sandbox);
        if (context.adapterRejected) {
          return await this.recoverWithCleanup(
            context,
            sandbox,
            context.agentFailure ?? "EVENT_REJECTED",
            cancellation,
          );
        }
        if (turn.kind === "recovery_required") {
          return await this.recoverWithCleanup(context, sandbox, turn.code, cancellation);
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
          return await this.finalizeWithCleanup(
            context,
            sandbox,
            "failed",
            "PROTOCOL",
            cancellation,
          );
        }

        const modelSettled = await this.applyMutation(context, {
          idempotencyKey:
            correctionRound === 0
              ? `${context.attemptId}/stage/model-settled`
              : `${context.attemptId}/correction/${correctionRound}/model-settled`,
          ...(correctionRound === 0 ? { nextStage: "model_settled" as const } : {}),
          events: [
            attemptEvent(
              context,
              "running",
              correctionRound === 0 ? "model_settled" : "workspace_verified",
            ),
          ],
          outbox: [],
        });
        if (!isApplied(modelSettled)) return await this.handleMutationFailure(modelSettled);

        const preVerify = await this.stopPoint(context, cancellation);
        if (preVerify) return await this.finishStopped(context, preVerify, sandbox);
        let candidate: WorkspaceRevisionCandidate | undefined;
        try {
          candidate = await this.dependencies.revisions.verify({
            scope,
            ...(context.currentRevisionId === undefined
              ? {}
              : { expectedCurrentRevisionId: context.currentRevisionId }),
            sandbox: sandbox.sandbox,
          });
        } catch {
          return await this.recoverWithCleanup(
            context,
            sandbox,
            "WORKSPACE_CONFLICT",
            cancellation,
          );
        }
        const postVerify = await this.stopPoint(context, cancellation);
        if (postVerify) return await this.finishStopped(context, postVerify, sandbox);
        try {
          workspaceChange = validateWorkspaceCandidate(context, candidate);
        } catch {
          return await this.recoverWithCleanup(
            context,
            sandbox,
            "WORKSPACE_CONFLICT",
            cancellation,
          );
        }
        const verified = await this.applyMutation(context, {
          idempotencyKey:
            correctionRound === 0
              ? `${context.attemptId}/stage/workspace-verified`
              : `${context.attemptId}/correction/${correctionRound}/workspace-verified`,
          ...(correctionRound === 0 ? { nextStage: "workspace_verified" as const } : {}),
          events: [attemptEvent(context, "running", "workspace_verified")],
          outbox: [],
        });
        if (!isApplied(verified)) return await this.handleMutationFailure(verified);

        if (turn.kind === "waiting") {
          try {
            assertControlledRolloutProjection(turn.rolloutProjection);
          } catch {
            return await this.recoverWithCleanup(context, sandbox, "EVENT_REJECTED", cancellation);
          }
          const preSettle = await this.stopPoint(context, cancellation);
          if (preSettle) return await this.finishStopped(context, preSettle, sandbox);
          const settled = await this.settleSandbox(context, sandbox, "pause");
          if (settled.outcome !== "settled") return settled.result;
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
        let artifactReady = true;
        try {
          await this.dependencies.artifacts.assertReadyForCompletion({
            scope,
            ...(workspaceChange === undefined
              ? {}
              : { workspaceRevisionId: workspaceChange.revisionId }),
          });
        } catch {
          artifactReady = false;
        }
        // 完成门检查之后先重验取消/租约；取消始终高于修正和成功。
        const postArtifact = await this.stopPoint(context, cancellation);
        if (postArtifact) return await this.finishStopped(context, postArtifact, sandbox);
        if (artifactReady) break;

        if (correctionRound >= this.#maxArtifactCorrectionRounds) {
          return await this.finalizeWithCleanup(
            context,
            sandbox,
            "failed",
            "ARTIFACT_NOT_READY",
            cancellation,
          );
        }
        const nextRound = correctionRound + 1;
        const feedback = artifactCorrectionFeedback(nextRound, this.#maxArtifactCorrectionRounds);
        const feedbackBytes = new TextEncoder().encode(feedback).byteLength;
        if (correctionPromptBytes + feedbackBytes > this.#artifactCorrectionPromptBudgetBytes) {
          return await this.finalizeWithCleanup(
            context,
            sandbox,
            "failed",
            "ARTIFACT_NOT_READY",
            cancellation,
          );
        }
        const feedbackPersisted = await this.applyMutation(context, {
          idempotencyKey: `${context.attemptId}/correction/${nextRound}/feedback`,
          events: [
            artifactCorrectionEvent(
              context,
              nextRound,
              this.#maxArtifactCorrectionRounds,
              feedback,
            ),
          ],
          outbox: [],
        });
        if (!isApplied(feedbackPersisted)) {
          return await this.handleMutationFailure(feedbackPersisted);
        }
        correctionRound = nextRound;
        correctionPromptBytes += feedbackBytes;
        promptText = feedback;
      }

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
      await Promise.allSettled([heartbeat.stop()]);
      if (heartbeatInFlight) await Promise.allSettled([heartbeatInFlight]);
      await context.durableLane.drain();
      await Promise.allSettled([context.abortPromise ?? Promise.resolve()]);
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
    return await context.durableLane.run(async () => {
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
    });
  }

  /** 清理状态推进忽略业务取消，但仍严格校验双栅栏与 scope/head checkpoint。 */
  private async fencePoint(
    context: ExecutionContext,
  ): Promise<"fence_lost" | "unavailable" | "scope_mismatch" | undefined> {
    return await context.durableLane.run(async () => {
      if (
        context.stopped === "fence_lost" ||
        context.stopped === "unavailable" ||
        context.stopped === "scope_mismatch"
      ) {
        return context.stopped;
      }
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
    });
  }

  /** Pi 必须先发布并持久化同一 callId 的 tool.started，之后才允许领取工具许可。 */
  private async authorizeToolEffectAfterStarted(
    context: ExecutionContext,
    cancellation: AbortSignal,
    call: ExternalEffectCall,
  ): Promise<ConsumedExternalEffectAuthorization> {
    const gate = context.toolStartedGates.get(call.callId);
    if (gate === undefined || gate.name !== call.toolName) {
      context.adapterRejected = true;
      context.agentFailure = "PROTOCOL";
      closeEventAcceptance(context);
      if (!context.abortPromise)
        context.abortPromise = context.abortSession?.() ?? Promise.resolve();
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    await gate.committed;
    if (gate.authorizationRequested || context.adapterRejected || !context.eventAcceptanceOpen) {
      context.adapterRejected = true;
      context.agentFailure = "PROTOCOL";
      closeEventAcceptance(context);
      if (!context.abortPromise)
        context.abortPromise = context.abortSession?.() ?? Promise.resolve();
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    // callId 在 Attempt 内永久一次性；即使后续授权失败，也不能重新领取许可。
    gate.authorizationRequested = true;
    return await this.authorizeEffect(context, cancellation, "tool_execution", call);
  }

  private async authorizeEffect(
    context: ExecutionContext,
    cancellation: AbortSignal,
    effect: ExternalEffectPermit["effect"],
    call: ExternalEffectCall,
  ): Promise<ConsumedExternalEffectAuthorization> {
    if (cancellation.aborted) context.stopped = "cancelled";
    if (context.stopped) throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    const authorization = await context.durableLane.run(async () => {
      if (cancellation.aborted) context.stopped = "cancelled";
      if (context.stopped) throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
      const monotonicStarted = performance.now();
      let result: Awaited<ReturnType<ExecutionPersistencePort["issueExternalEffectPermit"]>>;
      try {
        result = await this.dependencies.persistence.issueExternalEffectPermit({
          fence: context.fence,
          expectedAttemptVersion: context.attemptVersion,
          effect,
          call,
          permitDurationMs: this.#externalEffectPermitMs,
        });
      } catch {
        result = { outcome: "unavailable" };
      }
      if (result.outcome !== "authorized" || !permitMatches(context, result.permit, effect, call)) {
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
      if (cancellation.aborted) {
        context.stopped = "cancelled";
        closeEventAcceptance(context);
        if (!context.abortPromise)
          context.abortPromise = context.abortSession?.() ?? Promise.resolve();
        throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
      }
      let consumed: Awaited<ReturnType<ExecutionPersistencePort["consumeExternalEffectPermit"]>>;
      try {
        // issue 与 consume 位于同一 lane 回调，中间不允许 event/heartbeat mutation 插入。
        consumed = await this.dependencies.persistence.consumeExternalEffectPermit({
          fence: context.fence,
          expectedAttemptVersion: context.attemptVersion,
          permit: result.permit,
        });
      } catch {
        consumed = { outcome: "unavailable" };
      }
      const consumedAtMonotonicMs = performance.now();
      if (
        consumed.outcome !== "consumed" ||
        cancellation.aborted ||
        consumedAtMonotonicMs - monotonicStarted >= this.#externalEffectPermitMs
      ) {
        context.stopped =
          cancellation.aborted || consumed.outcome === "cancelled"
            ? "cancelled"
            : consumed.outcome === "unavailable"
              ? "unavailable"
              : consumed.outcome === "scope_mismatch"
                ? "scope_mismatch"
                : "fence_lost";
        closeEventAcceptance(context);
        if (!context.abortPromise)
          context.abortPromise = context.abortSession?.() ?? Promise.resolve();
        throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
      }
      return {
        permit: result.permit,
        consumedAt: consumed.databaseNow,
        consumedAtMonotonicMs,
        maxContinuationDelayMs: Math.max(
          1,
          Math.min(250, Math.floor(this.#externalEffectPermitMs / 4)),
        ),
      };
    });
    if (cancellation.aborted) {
      context.stopped = "cancelled";
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    return authorization;
  }

  private async applyMutation(
    context: ExecutionContext,
    input: Omit<
      RuntimeMutation,
      | "schemaVersion"
      | "commandDigest"
      | "fence"
      | "expectedAttemptVersion"
      | "expectedProjectionVersion"
    >,
  ): Promise<RuntimeMutationResult> {
    for (const event of input.events) assertProtocolSize(event);
    for (const outbox of input.outbox) assertProtocolSize(outbox);
    return await context.durableLane.run(async () => {
      const unsigned: Omit<RuntimeMutation, "commandDigest"> = {
        schemaVersion: 1,
        ...input,
        fence: context.fence,
        expectedAttemptVersion: context.attemptVersion,
        ...(input.rolloutProjection === undefined
          ? {}
          : { expectedProjectionVersion: context.projectionVersion }),
      };
      const command: RuntimeMutation = {
        ...unsigned,
        commandDigest: runtimeMutationDigest(unsigned),
      };
      let result = await this.dependencies.persistence.mutate(command);
      if (result.outcome === "response_unknown") {
        // readback 必须使用原始完整 scope；Revision head 推进不能放宽查询。
        const recovered = await this.dependencies.persistence.readMutation({
          scope: context.scope,
          idempotencyKey: input.idempotencyKey,
        });
        // not_found 不能证明事务未提交，保留 response_unknown 供孤儿清理和恢复指标分类。
        if (recovered.outcome === "not_found") return { outcome: "response_unknown" };
        result = recovered;
      }
      if (isApplied(result)) {
        if (!receiptMatches(context, result, command)) return { outcome: "idempotency_conflict" };
        if (!appliedSnapshotMatches(context, result, input)) return { outcome: "scope_mismatch" };
        context.attemptVersion = result.attemptVersion;
        context.nextEventSequence = result.nextEventSequence;
        context.databaseNow = result.databaseNow;
        context.run = result.run;
        context.workspace = result.workspace;
        context.actualCommittedStage = result.attempt.stage;
        context.actualAttemptStatus = result.attempt.status;
        context.projectionVersion = result.attempt.projectionVersion;
        acceptOutboxReceipts(context, result.receipt.outbox);
        if (result.attempt.currentRevisionId === undefined) delete context.currentRevisionId;
        else context.currentRevisionId = result.attempt.currentRevisionId;
      }
      return result;
    });
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
        result: await this.requireRecovery(context, "SANDBOX_FAILED", []),
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
    if (result.outcome === "idempotency_conflict") {
      return { outcome: "recovery_required", code: "IDEMPOTENCY_CONFLICT" };
    }
    if (result.outcome === "protocol_invalid") {
      return { outcome: "recovery_required", code: "PROTOCOL" };
    }
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
    reason: Parameters<RecoveryMetricsPort["recordOrphanCleanup"]>[0]["reason"],
  ): Promise<void> {
    let cleanupOutcome: "settled" | "unknown" | "failed" = "failed";
    try {
      const result = await this.dependencies.orphanSandboxes.closeOrphan({
        scope,
        session: sandbox,
      });
      cleanupOutcome = result.outcome;
    } catch {
      cleanupOutcome = "failed";
    }
    await this.dependencies.metrics
      .recordOrphanCleanup({ scope, registryId: sandbox.registryId, reason, cleanupOutcome })
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

function artifactCorrectionFeedback(round: number, maxRounds: number): string {
  return [
    `Artifact 完成门未通过（修正轮次 ${round}/${maxRounds}）。`,
    "必需交付物尚未全部发布成功。请检查已经声明的 required deliverable，修正对应文件，",
    "并使用 publish_artifact 发布新的不可变 ResourceVersion；完成后再结束本轮。",
    "不要回显对象键、签名 URL、租户或授权信息。",
  ].join("");
}

function artifactCorrectionEvent(
  context: ExecutionContext,
  round: number,
  maxRounds: number,
  feedback: string,
): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "artifact_correction_requested",
    sequence: context.nextEventSequence,
    payload: { round, maxRounds, code: "ARTIFACT_NOT_READY", feedback },
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
  disposition?: "pause" | "close",
): RuntimeOutboxV1 {
  const base = {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: cleanupIntentKey(context, sandbox),
    armed: true,
    payload: {
      registryId: sandbox.registryId,
      providerSandboxId: sandbox.providerSandboxId,
    },
  } as const;
  if (state === "pending") return { ...base, state };
  if (disposition === undefined) throw new Error("started 后必须一次性决定 cleanup disposition");
  return { ...base, state, payload: { ...base.payload, disposition } };
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
  if (sandbox === undefined) {
    return {
      schemaVersion: 1,
      kind: "sandbox_lifecycle_unknown",
      idempotencyKey: `${context.attemptId}/sandbox/unknown/${event.requestId}`,
      state: "unknown",
      payload: {
        requestId: event.requestId,
        ...(event.sandboxId === undefined ? {} : { sandboxId: event.sandboxId }),
        actualTtlSeconds: event.actualTtlSeconds,
        stage: event.stage,
        uncertainEvent: event,
        retryCode: "SANDBOX_UNKNOWN",
      },
    };
  }
  return {
    schemaVersion: 1,
    kind: "sandbox_cleanup",
    idempotencyKey: cleanupIntentKey(context, sandbox),
    state: "unknown",
    armed: true,
    payload: {
      registryId: sandbox.registryId,
      providerSandboxId: sandbox.providerSandboxId,
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

function registerToolStarted(
  context: ExecutionContext,
  event: Extract<RuntimeAgentEvent, { type: "tool.started" }>,
): ToolStartedGate {
  const existing = context.toolStartedGates.get(event.callId);
  if (existing !== undefined) {
    context.adapterRejected = true;
    context.agentFailure = "PROTOCOL";
    closeEventAcceptance(context);
    existing.resolve();
    return existing;
  }
  let resolve: () => void = () => undefined;
  const committed = new Promise<void>((done) => {
    resolve = done;
  });
  const gate = { name: event.name, committed, authorizationRequested: false, resolve };
  context.toolStartedGates.set(event.callId, gate);
  return gate;
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
    workspace.writerLease.expiresAt === fence.workspaceLease.expiresAt &&
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
    inspected.run.status === "running" &&
    inspected.fence.runClaim.token === context.fence.runClaim.token &&
    inspected.fence.runClaim.epoch === context.fence.runClaim.epoch &&
    inspected.fence.workspaceLease.rootRunId === context.scope.rootRunId &&
    inspected.fence.workspaceLease.epoch === context.fence.workspaceLease.epoch &&
    Date.parse(inspected.fence.runClaim.expiresAt) > Date.parse(context.fence.runClaim.expiresAt) &&
    Date.parse(inspected.fence.workspaceLease.expiresAt) >
      Date.parse(context.fence.workspaceLease.expiresAt) &&
    inspected.workspace.writerLease?.rootRunId === context.scope.rootRunId &&
    inspected.workspace.writerLease.epoch === inspected.fence.workspaceLease.epoch &&
    inspected.workspace.writerLease.expiresAt === inspected.fence.workspaceLease.expiresAt &&
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
  command: Omit<
    RuntimeMutation,
    | "schemaVersion"
    | "commandDigest"
    | "fence"
    | "expectedAttemptVersion"
    | "expectedProjectionVersion"
  >,
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
    result.nextEventSequence === context.nextEventSequence + command.events.length &&
    result.attempt.stage === expectedStage &&
    result.attempt.status === expectedStatus &&
    result.attempt.projectionVersion ===
      (command.rolloutProjection === undefined
        ? context.projectionVersion
        : context.projectionVersion + 1) &&
    result.attempt.currentRevisionId === expectedRevision &&
    (command.nextRunStatus === undefined || result.run.status === command.nextRunStatus) &&
    result.workspace.currentRevisionId === result.attempt.currentRevisionId
  );
}

function receiptMatches(
  context: ExecutionContext,
  result: AppliedMutation,
  command: RuntimeMutation,
): boolean {
  const receipt = result.receipt;
  const outboxMatches =
    receipt.outbox.length === command.outbox.length &&
    receipt.outbox.every((item, index) => {
      const expected = command.outbox[index];
      if (
        expected === undefined ||
        item.kind !== expected.kind ||
        item.idempotencyKey !== expected.idempotencyKey ||
        item.state !== expected.state
      ) {
        return false;
      }
      if (expected.kind !== "sandbox_cleanup") {
        return item.payloadDigest === outboxPayloadDigest(expected);
      }
      if (item.kind !== "sandbox_cleanup") return false;
      const previous = context.cleanupFacts.get(expected.idempotencyKey);
      const expectedArmedAt = previous?.armedAt ?? result.databaseNow;
      const expectedDisposition =
        "disposition" in expected.payload ? expected.payload.disposition : undefined;
      return (
        item.armed === true &&
        item.armedAt === expectedArmedAt &&
        item.identity.registryId === expected.payload.registryId &&
        item.identity.providerSandboxId === expected.payload.providerSandboxId &&
        item.identityDigest === sandboxCleanupIdentityDigest(expected) &&
        item.identityDigest === (previous?.identityDigest ?? item.identityDigest) &&
        (previous?.disposition === undefined || item.disposition === previous.disposition) &&
        item.disposition === expectedDisposition &&
        item.payloadDigest === outboxPayloadDigest(expected, expectedArmedAt)
      );
    });
  const projectionMatches =
    command.rolloutProjection === undefined
      ? receipt.projection === undefined
      : receipt.projection?.schemaVersion === 1 &&
        receipt.projection.previousVersion === context.projectionVersion &&
        receipt.projection.version === context.projectionVersion + 1 &&
        receipt.projection.digest === rolloutProjectionDigest(command.rolloutProjection);
  const workspaceMatches =
    command.workspaceChange === undefined
      ? receipt.workspace === undefined
      : receipt.workspace?.changeDigest === workspaceChangeDigest(command.workspaceChange) &&
        receipt.workspace.previousHead === context.currentRevisionId &&
        receipt.workspace.currentHead === command.workspaceChange.revisionId;
  const effectInvocationMatches =
    command.effectInvocation === undefined
      ? receipt.effectInvocation === undefined
      : receipt.effectInvocation?.callId === command.effectInvocation.callId &&
        receipt.effectInvocation.toolName === command.effectInvocation.toolName;
  return (
    receipt.schemaVersion === 1 &&
    receipt.idempotencyKey === command.idempotencyKey &&
    receipt.commandDigest === command.commandDigest &&
    receipt.previousAttemptVersion === context.attemptVersion &&
    receipt.attemptVersion === context.attemptVersion + 1 &&
    result.attemptVersion === context.attemptVersion + 1 &&
    result.attemptVersion === receipt.attemptVersion &&
    receipt.eventSequenceStart === context.nextEventSequence &&
    receipt.eventSequenceEnd === context.nextEventSequence + command.events.length &&
    result.nextEventSequence === receipt.eventSequenceEnd &&
    outboxMatches &&
    effectInvocationMatches &&
    projectionMatches &&
    workspaceMatches
  );
}

function acceptOutboxReceipts(
  context: ExecutionContext,
  receipts: readonly RuntimeOutboxReceiptV1[],
): void {
  for (const receipt of receipts) {
    if (receipt.kind !== "sandbox_cleanup") continue;
    context.cleanupFacts.set(receipt.idempotencyKey, {
      armedAt: receipt.armedAt,
      identityDigest: receipt.identityDigest,
      ...(receipt.disposition === undefined ? {} : { disposition: receipt.disposition }),
    });
  }
}

function permitMatches(
  context: ExecutionContext,
  permit: ExternalEffectPermit,
  effect: ExternalEffectPermit["effect"],
  call: ExternalEffectCall,
): boolean {
  return (
    permit.effect === effect &&
    permit.callId === call.callId &&
    permit.toolName === call.toolName &&
    permit.argsDigest === call.argsDigest &&
    sameScope(permit.scope, context.scope) &&
    permit.runClaimToken === context.fence.runClaim.token &&
    permit.runClaimEpoch === context.fence.runClaim.epoch &&
    permit.workspaceRootRunId === context.fence.workspaceLease.rootRunId &&
    permit.workspaceLeaseEpoch === context.fence.workspaceLease.epoch &&
    permit.attemptVersion === context.attemptVersion &&
    Date.parse(permit.issuedAt) < Date.parse(permit.expiresAt) &&
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

function boundedNonNegativeInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} 必须是 0 到 ${maximum} 的安全整数`);
  }
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 的安全整数`);
  }
  return value;
}
