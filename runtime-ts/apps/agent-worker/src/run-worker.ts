import { PinnedRunModelUnavailableError } from "@hoox/admin-control";
import {
  applyTodoWrite,
  measureExecutionPhase,
  type RunPersonalizationSnapshot,
  type TodoSnapshot,
  type TodoWriteCommand,
  userId,
} from "@hoox/domain";
import { injectRetrievedMemories, type MemoryRetriever } from "@hoox/memory";
import type { RuntimeAgentEvent } from "@hoox/pi-adapter";
import { AgentSupervisor, rootAgentThreadId } from "./agent-supervisor.js";
import { DurableOperationLane } from "./durable-operation-lane.js";
import {
  assertControlledRolloutProjection,
  digestCanonical,
  runtimeMutationDigest,
} from "./mutation-protocol.js";
import type {
  AgentControlPersistencePort,
  AgentUserInput,
  AgentSessionFactoryPort,
  CancellationPort,
  ClaimedExecutionSnapshot,
  ClockPort,
  ConsumedExternalEffectAuthorization,
  ExecutionPersistencePort,
  ExecutionScope,
  ExternalEffectCall,
  ExternalEffectPermit,
  OrphanSandboxCleanupPort,
  RecoveryMetricsPort,
  RuntimeMutation,
  RuntimeMutationResult,
  RuntimeOutboxV1,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  StableWorkerErrorCode,
  ThreadContextAppendCommandV1,
  ThreadContextBodyPersistencePort,
  ThreadContinuityMetricsPort,
  ThreadSandboxSessionLifecyclePort,
  ValidatedWorkspaceChange,
  WorkerAgentSessionPort,
  WorkspaceRevisionCandidate,
  WorkspaceRevisionVerifierPort,
} from "./ports.js";
import { assertProtocolSize } from "./ports.js";
import type { RunEventDiagnosticsPort } from "./run-event-diagnostics.js";
import type { RunPhaseTimingDiagnosticsPort } from "./run-phase-diagnostics.js";
import type { RunStartupTimingDiagnosticsPort } from "./run-startup-diagnostics.js";
import {
  type AppliedMutation,
  type ClaimedExecution,
  createExecutionContext,
  type ExecutionContext,
} from "./run-worker-context.js";
import { type PendingThreadSteer, RunEventPipeline } from "./run-worker-event-pipeline.js";
import { directAttachmentProbePaths } from "./run-worker-resource-probe.js";
import {
  type EnsureSandboxReady,
  RunSandboxPreparation,
} from "./run-worker-sandbox-preparation.js";
import { createRunTimings, type RunTimings } from "./run-worker-timing.js";
import {
  agentEvent,
  agentEventAt,
  attemptEvent,
  rawAttemptEvent,
  terminalContextAppend,
  terminalFailureEvents,
  terminalFailureMessage,
  waitingEvent,
} from "./run-worker-events.js";
import {
  alertOutbox,
  cleanupIntentKey,
  cleanupOutbox,
  cleanupUnknownOutbox,
  rawAlertOutbox,
  recoveryCleanupOutbox,
  terminalSandboxCommand,
} from "./run-worker-outbox.js";
import {
  reportWorkspaceVerifyFailure,
  validateWorkspaceCandidate,
} from "./run-worker-workspace-failures.js";
import {
  closeEventAcceptance,
  refreshLocalStop,
  stopReasonForPendingSteers,
} from "./run-worker-execution-state.js";
import {
  acceptInspection,
  acceptOutboxReceipts,
  appliedSnapshotMatches,
  inspectionMatches,
  isApplied,
  permitMatches,
  receiptMatches,
  snapshotMatches,
} from "./run-worker-fact-matching.js";
import type { WorkerTelemetry } from "./telemetry/runtime.js";

export interface RunWorkerOptions {
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatMs?: number;
  readonly runTimeoutMs?: number;
  readonly externalEffectPermitMs?: number;
  readonly threadContextWriteEnabled?: boolean;
  readonly threadInputRoutingV2Enabled?: boolean;
  readonly threadSandboxSessionReuseEnabled?: boolean;
  readonly historyFilesystemEnabled?: boolean;
  readonly subagentsEnabled?: boolean;
}

type AgentTurnResult = Awaited<ReturnType<WorkerAgentSessionPort["runPrompt"]>>;

/** 单次 execute 的阶段间共享状态；只活在本次 Attempt 内，不是恢复事实源。 */
interface ActiveRun {
  readonly scope: ExecutionScope;
  readonly snapshot: ClaimedExecution["snapshot"];
  readonly context: ExecutionContext;
  readonly cancellation: AbortSignal;
  readonly executionAbort: AbortController;
  readonly timings: RunTimings;
  readonly events: RunEventPipeline;
  readonly requestAbort: () => Promise<void>;
  /** 输入校验通过后才建立；之前的失败不可能已取得 Sandbox。 */
  sandboxes?: RunSandboxPreparation<RunWorkerResult>;
  session?: WorkerAgentSessionPort;
  unsubscribe?: () => void;
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
  /** 进程停机只中止当前执行，不代表用户取消 Run。 */
  readonly shutdownSignal?: AbortSignal;
  readonly clock: ClockPort;
  readonly metrics: RecoveryMetricsPort;
  readonly telemetry?: WorkerTelemetry;
  readonly threadContextBodies?: ThreadContextBodyPersistencePort;
  readonly threadSandboxes?: ThreadSandboxSessionLifecyclePort;
  readonly continuityMetrics?: ThreadContinuityMetricsPort;
  /** development 敏感诊断镜像；失败不得改变 durable Run 语义。 */
  readonly runEventDiagnostics?: RunEventDiagnosticsPort;
  /** development 首模前分段耗时诊断；失败不得阻塞模型请求或改变 Run 语义。 */
  readonly startupTimingDiagnostics?: RunStartupTimingDiagnosticsPort;
  readonly phaseTimingDiagnostics?: RunPhaseTimingDiagnosticsPort;
  readonly agentControl?: AgentControlPersistencePort;
  /** 长期记忆是低信任可选上下文；任何失败都不得改变 Run 终态。 */
  readonly memoryRetriever?: MemoryRetriever;
  readonly personalizations?: Readonly<{
    resolveForRun(input: {
      readonly scope: {
        readonly tenantId: ExecutionScope["tenantId"];
        readonly userId: ReturnType<typeof userId>;
      };
    }): Promise<RunPersonalizationSnapshot>;
  }>;
}

const OUTPUT_LIMIT_CONTINUATION_PROMPT =
  "上一轮因模型输出长度上限中止。请从当前状态继续：若任务尚未完成，继续使用工具完成剩余工作；若已完成，只给出简洁最终答复。不要重复已经完成的步骤。";
const INSPECTION_UNAVAILABLE_RETRY_DELAYS_MS = Object.freeze([5, 15, 45]);

const MUTATION_READBACK_RETRY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);
const MUTATION_UNAVAILABLE_RETRY_DELAYS_MS = Object.freeze([25, 100, 500]);

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
    this.#runTimeoutMs = positive(options.runTimeoutMs ?? 12 * 60 * 60_000, "runTimeoutMs");
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
    if (
      options.threadContextWriteEnabled === true &&
      dependencies.threadContextBodies === undefined
    ) {
      throw new Error("Thread Context 写入已启用但缺少 body persistence");
    }
    if (
      options.threadInputRoutingV2Enabled === true &&
      options.threadContextWriteEnabled !== true
    ) {
      throw new Error("Thread steer 依赖 Thread Context 写入");
    }
    if (
      options.threadSandboxSessionReuseEnabled === true &&
      dependencies.threadSandboxes === undefined
    ) {
      throw new Error("Thread Sandbox 复用已启用但缺少 lifecycle persistence");
    }
    if (options.subagentsEnabled === true && dependencies.agentControl === undefined) {
      throw new Error("SubAgent 已启用但缺少控制面 persistence");
    }
  }

  /**
   * 单次 Attempt 状态机：claim → 会话建立 → 模型循环 → Workspace 校验 → waiting/succeeded 收口。
   * 任一阶段抛出都由 #failAttempt 统一收敛；finally 只释放本地资源，cleanup 由持久 Outbox/Saga 接管。
   */
  async execute(scope: ExecutionScope): Promise<RunWorkerResult> {
    assertScope(scope);
    const startupStartedAt = performance.now();
    const claim = await this.dependencies.persistence.claim({
      scope,
      workerId: this.options.workerId,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (claim.outcome !== "claimed") return await this.#handleUnclaimed(scope, claim);
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
      return await this.#releaseScopeMismatch(claim, durableLane);
    }

    if (this.dependencies.telemetry === undefined) {
      return this.#executeClaimed(scope, claim, durableLane, startupStartedAt);
    }
    return this.dependencies.telemetry.runAttempt(scope, claim.snapshot.attempt.attemptId, () =>
      this.#executeClaimed(scope, claim, durableLane, startupStartedAt),
    );
  }

  async #executeClaimed(
    scope: ExecutionScope,
    claim: ClaimedExecution,
    durableLane: DurableOperationLane,
    startupStartedAt: number,
  ): Promise<RunWorkerResult> {
    const context = createExecutionContext(scope, claim, durableLane);
    const timings = createRunTimings({
      context,
      claimedAt: claim.databaseNow,
      startupStartedAt,
      ...(this.dependencies.phaseTimingDiagnostics === undefined
        ? {}
        : { phaseDiagnostics: this.dependencies.phaseTimingDiagnostics }),
      ...(this.dependencies.startupTimingDiagnostics === undefined
        ? {}
        : { startupDiagnostics: this.dependencies.startupTimingDiagnostics }),
    });
    const cancellation = this.dependencies.cancellation.signalFor(scope);
    const executionAbort = new AbortController();
    const stopSignals = this.#installStopSignals(context, cancellation, executionAbort);
    const run: ActiveRun = {
      scope,
      snapshot: claim.snapshot,
      context,
      cancellation,
      executionAbort,
      timings,
      requestAbort: stopSignals.requestAbort,
      events: new RunEventPipeline(
        context,
        {
          applyMutation: (input) => this.applyMutation(context, input),
          requestAbort: stopSignals.requestAbort,
          prepareTurnContextAppend: (event, phase) =>
            this.prepareTurnContextAppend(context, event, phase),
          applyThreadSteer: (item) => this.applyThreadSteer(context, item),
          readPendingThreadSteers: () =>
            this.dependencies.persistence.readPendingThreadSteers({ fence: context.fence }),
        },
        this.options.threadInputRoutingV2Enabled === true,
      ),
    };

    try {
      return await this.#runAttempt(run);
    } catch (error) {
      return await this.#failAttempt(run, error instanceof PinnedRunModelUnavailableError);
    } finally {
      timings.startup?.publish();
      await stopSignals.dispose();
      await context.durableLane.drain();
      await Promise.allSettled([context.abortPromise ?? Promise.resolve()]);
      await Promise.allSettled([
        timings.startup?.drain() ?? Promise.resolve(),
        timings.phase?.drain() ?? Promise.resolve(),
        Promise.resolve().then(() => run.unsubscribe?.()),
        Promise.resolve().then(() => run.session?.dispose()),
      ]);
    }
  }

  async #handleUnclaimed(
    scope: ExecutionScope,
    claim: Exclude<Awaited<ReturnType<ExecutionPersistencePort["claim"]>>, ClaimedExecution>,
  ): Promise<RunWorkerResult> {
    if (claim.outcome === "recovery_required") {
      // 过期 Attempt 不能继续由普通 claim 重领，但也不能只返回 ignored 让 dispatch
      // 每五秒空转。这里切换到窄恢复命令，只固化“执行已停止”和 Sandbox 清理事实，
      // 不重放模型、工具或猜测业务 succeeded/failed。
      const recovered = await this.dependencies.persistence.recoverExpiredAttempt({
        scope,
        decision: "require_manual_recovery",
      });
      if (recovered === "recovered") {
        return { outcome: "recovery_required", code: "INTERNAL" };
      }
      if (recovered === "unavailable") {
        return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
      }
      return {
        outcome: "ignored",
        reason:
          recovered === "not_expired"
            ? "busy"
            : recovered === "scope_mismatch"
              ? "scope_mismatch"
              : "not_found",
      };
    }
    if (claim.outcome === "unavailable") {
      return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
    }
    if (claim.outcome === "busy") {
      await this.dependencies.continuityMetrics
        ?.record({
          tenantId: scope.tenantId,
          threadId: scope.threadId,
          runId: scope.runId,
          observationId: `${scope.runId}:thread-writer-conflict`,
          metricName: "thread_writer_conflict_total",
          value: 1,
          unit: "count",
          outcome: "busy",
        })
        .catch(() => undefined);
    }
    return { outcome: "ignored", reason: claim.outcome };
  }

  /** claim 快照与调度作用域不一致：不执行任何副作用，只释放栅栏并告警。 */
  async #releaseScopeMismatch(
    claim: ClaimedExecution,
    durableLane: DurableOperationLane,
  ): Promise<RunWorkerResult> {
    const unsigned: Omit<RuntimeMutation, "commandDigest"> = {
      schemaVersion: 1,
      idempotencyKey: `${claim.snapshot.attempt.attemptId}/claim/scope-mismatch`,
      fence: claim.fence,
      expectedAttemptVersion: claim.snapshot.attempt.version,
      nextAttemptStatus: "recovery_required",
      events: [
        agentEventAt(claim.snapshot.attempt.nextEventSequence, {
          type: "runtime.notice",
          level: "error",
          code: "PROTOCOL",
          message: terminalFailureMessage("recovery_required", "PROTOCOL"),
          source: "terminal_fallback",
        }),
        rawAttemptEvent(
          claim.snapshot.attempt.nextEventSequence + 1,
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

  /**
   * 取消、停机、超时与心跳续租都只设置本地停止原因并请求中止 Session；
   * 是否提交 cancelled/failed 由后续停止点在持久事实上判定。
   */
  #installStopSignals(
    context: ExecutionContext,
    cancellation: AbortSignal,
    executionAbort: AbortController,
  ): { readonly requestAbort: () => Promise<void>; dispose(): Promise<void> } {
    const shutdown = this.dependencies.shutdownSignal;
    const requestAbort = (): Promise<void> => {
      closeEventAcceptance(context);
      if (!context.abortPromise) {
        context.abortPromise = context.abortSession?.() ?? Promise.resolve();
      }
      return context.abortPromise;
    };
    const onCancel = () => {
      if (context.stopped === "shutdown") return;
      context.stopped = "cancelled";
      executionAbort.abort("run_cancelled");
      void requestAbort();
    };
    const onShutdown = () => {
      // 运维停止优先于同一时刻的本地取消信号，绝不能提交用户 cancelled 事实。
      context.stopped = "shutdown";
      executionAbort.abort("worker_shutdown");
      void requestAbort();
    };
    cancellation.addEventListener("abort", onCancel, { once: true });
    if (cancellation.aborted) onCancel();
    shutdown?.addEventListener("abort", onShutdown, { once: true });
    if (shutdown?.aborted) onShutdown();
    const timeout = this.dependencies.clock.schedule(this.#runTimeoutMs, () => {
      if (
        context.stopped === "shutdown" ||
        context.stopped === "agent_revision_revoked" ||
        context.stopped === "external_tool_revoked"
      )
        return;
      context.stopped = "timeout";
      executionAbort.abort("run_timeout");
      void requestAbort();
    });
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = this.dependencies.clock.startHeartbeat(this.#heartbeatMs, () => {
      if (heartbeatInFlight) return heartbeatInFlight;
      const task = (async () => {
        await context.durableLane.run(async () => {
          if (context.stopped) return;
          const stopped = await this.renewHeartbeatWithUnavailableRetry(context);
          if (stopped !== undefined) context.stopped = stopped;
        });
        if (context.stopped) await requestAbort().catch(() => undefined);
      })();
      heartbeatInFlight = task;
      const clearHeartbeat = () => {
        if (heartbeatInFlight === task) heartbeatInFlight = undefined;
      };
      void task.then(clearHeartbeat, clearHeartbeat);
      return task;
    });
    return {
      requestAbort,
      dispose: async () => {
        timeout.cancel();
        cancellation.removeEventListener("abort", onCancel);
        this.dependencies.cancellation.release?.(context.scope);
        shutdown?.removeEventListener("abort", onShutdown);
        closeEventAcceptance(context);
        // abort 完成后才允许取消订阅、释放 Session；在途心跳必须先落定，避免与终态 mutation 交错。
        await Promise.allSettled([heartbeat.stop()]);
        if (heartbeatInFlight) await Promise.allSettled([heartbeatInFlight]);
      },
    };
  }

  async #runAttempt(run: ActiveRun): Promise<RunWorkerResult> {
    const { context, snapshot, scope, cancellation } = run;
    if (typeof snapshot.agent === "string")
      return await this.finalizeWithoutRevision(context, "failed", snapshot.agent);
    const { content } = snapshot.agent;
    if (
      content.sandboxTemplateId !== undefined ||
      (content.tools.mode === "configured" && content.tools.clientTools.length > 0)
    ) {
      return await this.finalizeWithoutRevision(
        context,
        "failed",
        "AGENT_CONFIGURATION_UNSUPPORTED",
      );
    }
    try {
      assertControlledRolloutProjection(snapshot.rolloutProjection);
    } catch {
      return await this.requireRecovery(context, "EVENT_REJECTED", []);
    }
    let directAttachmentPaths: readonly string[];
    try {
      directAttachmentPaths = directAttachmentProbePaths(
        snapshot.input,
        snapshot.answer === undefined ? (snapshot.attachments ?? []) : [],
      );
    } catch {
      return await this.requireRecovery(context, "PROTOCOL", []);
    }
    const sandboxes = new RunSandboxPreparation<RunWorkerResult>({
      context,
      workerId: this.options.workerId,
      leaseDurationMs: this.#leaseDurationMs,
      threadSandboxSessionReuseEnabled: this.options.threadSandboxSessionReuseEnabled === true,
      historyFilesystemEnabled: this.options.historyFilesystemEnabled === true,
      directAttachmentPaths,
      signal: run.executionAbort.signal,
      ...(run.timings.phase === undefined ? {} : { phaseTiming: run.timings.phase }),
      sandboxes: this.dependencies.sandboxes,
      ...(this.dependencies.threadSandboxes === undefined
        ? {}
        : { threadSandboxes: this.dependencies.threadSandboxes }),
      revisions: this.dependencies.revisions,
      operations: {
        stopPoint: () => this.stopPoint(context, cancellation),
        applyMutation: (input) => this.applyMutation(context, input),
        handleMutationFailure: (result) => this.handleMutationFailure(result),
        bestEffortOrphanCleanup: (sandbox, reason) =>
          this.bestEffortOrphanCleanup(scope, sandbox, reason),
        recordWorkspaceMaterialization: (startedAt, outcome) =>
          this.recordWorkspaceMaterialization(context, startedAt, outcome),
      },
    });
    run.sandboxes = sandboxes;

    const initialUserText = snapshot.answer ?? snapshot.input;
    const personalizationUserId = snapshot.requestedByUserId ?? snapshot.memorySubjectUserId;
    if (this.dependencies.personalizations !== undefined && personalizationUserId === undefined) {
      throw new Error("Run 缺少个性化用户身份");
    }
    const personalizationSnapshot =
      this.dependencies.personalizations === undefined
        ? undefined
        : await run.timings.measureStartup(
            "personalization_resolve",
            () =>
              this.dependencies.personalizations?.resolveForRun({
                scope: {
                  tenantId: scope.tenantId,
                  userId: userId(personalizationUserId as string),
                },
              }) as Promise<RunPersonalizationSnapshot>,
          );
    const preSession = await run.timings.measureStartup("pre_session_stop_point", () =>
      this.stopPoint(context, cancellation),
    );
    if (preSession) return await this.finishStopped(context, preSession);
    const promptInput: AgentUserInput = {
      text: await run.timings.measureStartup("memory_retrieve", () =>
        this.withRetrievedMemory(snapshot, scope, initialUserText),
      ),
      attachments: snapshot.answer === undefined ? (snapshot.attachments ?? []) : [],
    };
    const agentSupervisor = this.#createAgentSupervisor(
      run,
      sandboxes.ensureReady,
      personalizationSnapshot,
    );
    if (agentSupervisor !== undefined) {
      await run.timings.measureStartup("agent_supervisor_initialize", () =>
        agentSupervisor.initialize(),
      );
    }
    const session = await run.timings.measureStartup("agent_session_create", () =>
      this.#createRootSession(run, {
        ensureSandboxReady: sandboxes.ensureReady,
        initialInputText: promptInput.text,
        personalizationSnapshot,
        agentSupervisor,
      }),
    );
    run.session = session;
    context.abortSession = async () => {
      await session.drainRejectedToolReceipts?.();
      await Promise.all([
        session.abort().catch(() => undefined),
        agentSupervisor?.abortAll().catch(() => undefined),
      ]);
    };
    const postSession = await run.timings.measureStartup("post_session_stop_point", () =>
      this.stopPoint(context, cancellation),
    );
    if (postSession) return await this.finishStopped(context, postSession, sandboxes.current);

    run.unsubscribe = run.events.subscribe(session);

    const modelCheckpoint = await run.timings.measureStartup("model_checkpoint", () =>
      this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/model-execution-started`,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [attemptEvent(context, "running", "model_execution_started")],
        outbox: [],
      }),
    );
    if (!isApplied(modelCheckpoint)) return await this.handleMutationFailure(modelCheckpoint);

    const settled = await this.#runModelLoop(run, session, agentSupervisor, promptInput);
    if (settled.kind === "result") return settled.result;
    return await this.#finishSucceeded(run, settled.workspaceChange);
  }

  #createAgentSupervisor(
    run: ActiveRun,
    ensureSandboxReady: EnsureSandboxReady,
    personalizationSnapshot: RunPersonalizationSnapshot | undefined,
  ): AgentSupervisor | undefined {
    if (this.options.subagentsEnabled !== true || this.dependencies.agentControl === undefined) {
      return undefined;
    }
    const { context, scope, snapshot, cancellation } = run;
    if (typeof snapshot.agent === "string") throw new Error(snapshot.agent);
    const agentSnapshot = snapshot.agent;
    return new AgentSupervisor({
      persistence: this.dependencies.agentControl,
      rootAgentThreadId: rootAgentThreadId(context.attemptId),
      attemptId: context.attemptId,
      fence: context.fence,
      allowedExternalToolVersionIds:
        agentSnapshot.content.tools.mode === "configured"
          ? agentSnapshot.content.tools.externalTools.map((tool) => tool.versionId)
          : [],
      createSession: async (child) =>
        await this.dependencies.sessions.create({
          scope,
          attemptId: context.attemptId,
          fence: context.fence,
          agent: child.identity,
          enabledToolNames: child.tools,
          enabledExternalToolVersionIds: child.externalToolVersionIds,
          ensureSandboxReady,
          rolloutProjection: Object.freeze({
            schemaVersion: 2 as const,
            checkpointId: `${child.identity.agentThreadId}:${child.identity.agentTurnId}`,
            items: Object.freeze([]),
          }),
          agentSnapshot,
          ...(snapshot.skills === undefined ? {} : { skillSnapshot: snapshot.skills }),
          ...(personalizationSnapshot === undefined ? {} : { personalizationSnapshot }),
          ...(child.history === undefined ? {} : { threadActiveHistory: child.history }),
          onExternalToolRevoked: () => {
            context.stopped = "external_tool_revoked";
            run.executionAbort.abort("external_tool_revoked");
          },
          authorizeToolEffect: (call) =>
            this.authorizeToolEffectAfterStarted(context, cancellation, call),
          writeTodo: async () => {
            throw new Error("SUBAGENT_TODO_FORBIDDEN");
          },
        }),
      authorizeModelStart: (child) =>
        this.authorizeEffect(context, cancellation, "agent_model_start", {
          callId: `${child.identity.agentThreadId}:${child.identity.agentTurnId}:model`,
          toolName: "pi_model",
          argsDigest: digestCanonical({ prompt: child.prompt, attachments: [] }),
        }),
      onToolEvent: (_identity, event) => run.events.persistSubagentToolEvent(event),
    });
  }

  #createRootSession(
    run: ActiveRun,
    input: {
      readonly ensureSandboxReady: EnsureSandboxReady;
      readonly initialInputText: string;
      readonly personalizationSnapshot: RunPersonalizationSnapshot | undefined;
      readonly agentSupervisor: AgentSupervisor | undefined;
    },
  ): Promise<WorkerAgentSessionPort> {
    const { context, scope, snapshot, cancellation, timings } = run;
    const { personalizationSnapshot, agentSupervisor } = input;
    if (typeof snapshot.agent === "string") throw new Error(snapshot.agent);
    return this.dependencies.sessions.create({
      scope,
      attemptId: context.attemptId,
      fence: context.fence,
      ensureSandboxReady: input.ensureSandboxReady,
      rolloutProjection: snapshot.rolloutProjection,
      initialInputText: input.initialInputText,
      agentSnapshot: snapshot.agent,
      ...(snapshot.skills === undefined ? {} : { skillSnapshot: snapshot.skills }),
      ...(personalizationSnapshot === undefined ? {} : { personalizationSnapshot }),
      ...(timings.startupObserver === undefined ? {} : { startupTiming: timings.startupObserver }),
      ...(timings.phase === undefined ? {} : { phaseTiming: timings.phase }),
      ...(snapshot.contextThroughSequence === undefined
        ? {}
        : { contextThroughSequence: snapshot.contextThroughSequence }),
      ...(this.options.threadContextWriteEnabled !== true
        ? {}
        : { onTurnSafePoint: (event) => run.events.commitTurnSafePoint(event) }),
      onExternalToolRevoked: () => {
        context.stopped = "external_tool_revoked";
        run.executionAbort.abort("external_tool_revoked");
      },
      authorizeToolEffect: (call) =>
        this.authorizeToolEffectAfterStarted(context, cancellation, call),
      writeTodo: (call) => this.writeTodoAfterStarted(context, cancellation, call),
      ...(agentSupervisor === undefined ? {} : { agentControl: agentSupervisor }),
    });
  }

  /**
   * 模型循环：每轮先签发模型许可再执行 prompt。允许的续跑只有两种——一次有界的输出长度续跑，
   * 以及 Pi 已 settled 后逐条消费的 Thread steer；其余结果都在本轮收口。
   */
  async #runModelLoop(
    run: ActiveRun,
    session: WorkerAgentSessionPort,
    agentSupervisor: AgentSupervisor | undefined,
    initialPrompt: AgentUserInput,
  ): Promise<
    | { readonly kind: "result"; readonly result: RunWorkerResult }
    | { readonly kind: "completed"; readonly workspaceChange?: ValidatedWorkspaceChange }
  > {
    const { context, cancellation } = run;
    const result = (value: RunWorkerResult) => ({ kind: "result", result: value }) as const;
    let promptInput = initialPrompt;
    let steerReceiptId: string | undefined;
    let outputLimitContinuationRound = 0;
    let outputLimitContinuationUsed = false;

    for (;;) {
      // 模型许可签发会在数据库内重验双栅栏与 Run 状态，取消、停机或栅栏丢失都会令其拒绝，
      // 并经外层 catch 收敛为 finishStopped；此前单独的 stopPoint 只多一次续租往返。
      const modelEffect =
        steerReceiptId === undefined && outputLimitContinuationRound === 0
          ? "model_start"
          : "model_continue";
      const modelCallId =
        outputLimitContinuationRound > 0
          ? `${context.attemptId}/model/output-limit/${outputLimitContinuationRound}`
          : steerReceiptId === undefined
            ? `${context.attemptId}/model/start`
            : `${context.attemptId}/model/steer/${steerReceiptId}`;
      const currentPrompt = promptInput;
      const preparedInput = await run.timings.measureStartup("prepare_input", () =>
        session.prepareInput(currentPrompt),
      );
      const modelAuthorization = await run.timings.measureStartup("model_authorization", () =>
        this.authorizeEffect(context, cancellation, modelEffect, {
          callId: modelCallId,
          toolName: "pi_model",
          argsDigest: digestCanonical({
            prompt: currentPrompt.text,
            attachments: currentPrompt.attachments,
          }),
        }),
      );
      context.modelCompleted = false;
      delete context.modelStopReason;
      const turn = await session.runPrompt(preparedInput, modelAuthorization);
      await run.events.drained;
      if (context.abortPromise) await context.abortPromise;
      // SubAgent 在 drain 前仍可能触发 Sandbox 懒准备，因此每次收口都实时读取当前 Sandbox。
      const postModel = await this.stopPoint(context, cancellation);
      if (postModel) {
        return result(await this.finishStopped(context, postModel, run.sandboxes?.current));
      }
      const failed = await this.#settleFailedTurn(run, turn);
      if (failed !== undefined) return result(failed);
      if (
        turn.kind === "completed" &&
        context.modelStopReason === "length" &&
        !outputLimitContinuationUsed
      ) {
        // Provider 已完整提交 length 终态；追加一次有界续跑，避免把推理预算耗尽误报为协议损坏。
        outputLimitContinuationRound = 1;
        outputLimitContinuationUsed = true;
        steerReceiptId = undefined;
        promptInput = { text: OUTPUT_LIMIT_CONTINUATION_PROMPT, attachments: [] };
        continue;
      }
      if (turn.kind === "completed" && !context.modelCompleted) {
        return result(
          await this.finalizeWithCleanup(
            context,
            run.sandboxes?.current,
            "failed",
            "PROTOCOL",
            cancellation,
          ),
        );
      }
      outputLimitContinuationRound = 0;

      const steer = await this.#takeSettledSteer(run);
      if (steer.kind === "result") return steer;
      if (steer.kind === "steer") {
        promptInput = steer.promptInput;
        steerReceiptId = steer.receiptId;
        continue;
      }

      await agentSupervisor?.drain();
      const postAgents = await this.stopPoint(context, cancellation);
      if (postAgents) {
        return result(await this.finishStopped(context, postAgents, run.sandboxes?.current));
      }
      const modelSettled = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/model-settled`,
        nextStage: "model_settled",
        events: [attemptEvent(context, "running", "model_settled")],
        outbox: [],
      });
      if (!isApplied(modelSettled)) return result(await this.handleMutationFailure(modelSettled));

      const verified = await this.#verifyWorkspace(run, turn);
      if (verified.kind === "result") return verified;
      if (turn.kind === "waiting") {
        return result(await this.#finishWaiting(run, turn, verified.workspaceChange));
      }
      // deliver_file 的成功已是 published 事实；Run 完成不再依赖声明或修正轮次。
      return {
        kind: "completed",
        ...(verified.workspaceChange === undefined
          ? {}
          : { workspaceChange: verified.workspaceChange }),
      };
    }
  }

  /** 模型轮次结束后的失败判定；顺序即优先级，返回 undefined 表示可继续收口。 */
  async #settleFailedTurn(
    run: ActiveRun,
    turn: AgentTurnResult,
  ): Promise<RunWorkerResult | undefined> {
    const { context, cancellation } = run;
    const sandbox = run.sandboxes?.current;
    if (turn.kind === "context_too_large") {
      return await this.finalizeWithCleanup(
        context,
        sandbox,
        "failed",
        "CONTEXT_TOO_LARGE",
        cancellation,
      );
    }
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
    return undefined;
  }

  /**
   * Pi 已经 settled 时没有可承载批量 steering 的活跃 prompt；只消费队首，
   * 其余 receipt 保持 pending，等下一次 prompt 的安全点再合并进入后续请求。
   */
  async #takeSettledSteer(
    run: ActiveRun,
  ): Promise<
    | { readonly kind: "none" }
    | { readonly kind: "steer"; readonly receiptId: string; readonly promptInput: AgentUserInput }
    | { readonly kind: "result"; readonly result: RunWorkerResult }
  > {
    if (this.options.threadInputRoutingV2Enabled !== true) return { kind: "none" };
    const { context } = run;
    const pending = await this.dependencies.persistence.readPendingThreadSteers({
      fence: context.fence,
    });
    if (pending.outcome === "pending") {
      const [item] = pending.items;
      if (item === undefined) throw new Error("Thread steer 批次不能为空");
      const applied = await this.applyThreadSteer(context, item);
      if (!isApplied(applied)) {
        return { kind: "result", result: await this.handleMutationFailure(applied) };
      }
      return {
        kind: "steer",
        receiptId: item.receiptId,
        promptInput: {
          text: await this.withRetrievedMemory(run.snapshot, run.scope, item.inputText),
          attachments: item.attachments ?? [],
        },
      };
    }
    if (pending.outcome !== "none") {
      const stopped = stopReasonForPendingSteers(pending.outcome);
      context.stopped = stopped;
      return {
        kind: "result",
        result: await this.finishStopped(context, stopped, run.sandboxes?.current),
      };
    }
    return { kind: "none" };
  }

  /** 有 Sandbox 时校验并固化 Workspace 候选 Revision；校验失败只能进入人工恢复。 */
  async #verifyWorkspace(
    run: ActiveRun,
    turn: AgentTurnResult,
  ): Promise<
    | { readonly kind: "verified"; readonly workspaceChange?: ValidatedWorkspaceChange }
    | { readonly kind: "result"; readonly result: RunWorkerResult }
  > {
    const { context, cancellation, scope } = run;
    const sandbox = run.sandboxes?.current;
    if (sandbox === undefined) return { kind: "verified" };
    // Sandbox 将交接给已排队的 follow-up 时延后快照，由最终暂停前的 Run 一并生成 Revision。
    if (await this.shouldDeferWorkspaceSnapshot(context, turn)) return { kind: "verified" };
    const result = (value: RunWorkerResult) => ({ kind: "result", result: value }) as const;
    const preVerify = await this.stopPoint(context, cancellation);
    if (preVerify) return result(await this.finishStopped(context, preVerify, sandbox));
    let candidate: WorkspaceRevisionCandidate | undefined;
    try {
      candidate = await measureExecutionPhase(context.phaseTiming, "workspace_verify", () =>
        this.dependencies.revisions.verify({
          scope,
          attemptId: context.attemptId,
          ...(context.currentRevisionId === undefined
            ? {}
            : { expectedCurrentRevisionId: context.currentRevisionId }),
          sandbox,
          // 历史修正轮次已移除，`:0` 只为保持 Workspace journal 操作键稳定。
          operationKey: `${context.attemptId}:workspace:publish:0`,
          signal: run.executionAbort.signal,
          ...(context.phaseTiming === undefined ? {} : { phaseTiming: context.phaseTiming }),
        }),
      );
    } catch (error) {
      reportWorkspaceVerifyFailure(error);
      return result(
        await this.recoverWithCleanup(context, sandbox, "WORKSPACE_CONFLICT", cancellation),
      );
    }
    const postVerify = await this.stopPoint(context, cancellation);
    if (postVerify) return result(await this.finishStopped(context, postVerify, sandbox));
    let workspaceChange: ValidatedWorkspaceChange | undefined;
    try {
      workspaceChange = validateWorkspaceCandidate(context, candidate);
    } catch {
      return result(
        await this.recoverWithCleanup(context, sandbox, "WORKSPACE_CONFLICT", cancellation),
      );
    }
    const verified = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/stage/workspace-verified`,
      nextStage: "workspace_verified",
      events: [attemptEvent(context, "running", "workspace_verified")],
      outbox: [],
    });
    if (!isApplied(verified)) return result(await this.handleMutationFailure(verified));
    return { kind: "verified", ...(workspaceChange === undefined ? {} : { workspaceChange }) };
  }

  async #finishWaiting(
    run: ActiveRun,
    turn: Extract<AgentTurnResult, { readonly kind: "waiting" }>,
    workspaceChange: ValidatedWorkspaceChange | undefined,
  ): Promise<RunWorkerResult> {
    const { context, cancellation } = run;
    const sandbox = run.sandboxes?.current;
    try {
      assertControlledRolloutProjection(turn.rolloutProjection);
    } catch {
      return await this.recoverWithCleanup(context, sandbox, "EVENT_REJECTED", cancellation);
    }
    const preSettle = await this.stopPoint(context, cancellation);
    if (preSettle) return await this.finishStopped(context, preSettle, sandbox);
    const killSandbox =
      typeof run.snapshot.agent !== "string" &&
      run.snapshot.agent.content.sandboxIdleAction === "kill";
    if (sandbox !== undefined) {
      if (context.threadSandboxLease === undefined) {
        const settled = await measureExecutionPhase(
          context.phaseTiming,
          "sandbox_settle",
          this.settleSandbox.bind(this, context, sandbox, killSandbox ? "close" : "pause"),
        );
        if (settled.outcome !== "settled") return settled.result;
        const postSettle = await this.stopPoint(context, cancellation);
        if (postSettle) return await this.finishStopped(context, postSettle);
      } else {
        const finalizing = await this.prepareThreadSandboxTerminal(context);
        if (!isApplied(finalizing)) return await this.handleMutationFailure(finalizing);
      }
    }
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
      ...(context.threadSandboxLease === undefined
        ? {}
        : { threadSandboxTerminal: terminalSandboxCommand(context.threadSandboxLease) }),
      ...(this.options.threadContextWriteEnabled === true
        ? { threadContextAppend: terminalContextAppend(context, "waiting") }
        : {}),
    });
    if (!isApplied(waiting)) return await this.handleMutationFailure(waiting);
    if (sandbox !== undefined) {
      await measureExecutionPhase(
        context.phaseTiming,
        "sandbox_settle",
        this.completeThreadSandboxTerminalEffect.bind(this, context, sandbox, waiting),
      );
    }
    return { outcome: "waiting" };
  }

  async #finishSucceeded(
    run: ActiveRun,
    workspaceChange: ValidatedWorkspaceChange | undefined,
  ): Promise<RunWorkerResult> {
    const { context, cancellation } = run;
    const sandbox = run.sandboxes?.current;
    const preSettle = await this.stopPoint(context, cancellation);
    if (preSettle) return await this.finishStopped(context, preSettle, sandbox);
    if (sandbox === undefined) {
      const finalizing = await this.prepareNoSandboxTerminal(context);
      if (!isApplied(finalizing)) return await this.handleMutationFailure(finalizing);
    } else if (context.threadSandboxLease === undefined) {
      const settled = await measureExecutionPhase(
        context.phaseTiming,
        "sandbox_settle",
        this.settleSandbox.bind(this, context, sandbox, "close"),
      );
      if (settled.outcome !== "settled") return settled.result;
      // settle 与 Run success 之间必须同步重验，避免取消被成功覆盖。
      const postSettle = await this.stopPoint(context, cancellation);
      if (postSettle) return await this.finishStopped(context, postSettle);
    } else {
      const finalizing = await this.prepareThreadSandboxTerminal(context);
      if (!isApplied(finalizing)) return await this.handleMutationFailure(finalizing);
    }
    const final = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/final/succeeded`,
      nextAttemptStatus: "succeeded",
      nextStage: "finished",
      events: [attemptEvent(context, "succeeded", "finished")],
      outbox: [],
      ...(workspaceChange === undefined ? {} : { workspaceChange }),
      nextRunStatus: "succeeded",
      releaseFences: true,
      ...(context.threadSandboxLease === undefined
        ? {}
        : { threadSandboxTerminal: terminalSandboxCommand(context.threadSandboxLease) }),
      ...(this.options.threadContextWriteEnabled === true
        ? {
            threadContextAppend: terminalContextAppend(context, "succeeded", workspaceChange),
          }
        : {}),
    });
    if (!isApplied(final)) return await this.handleMutationFailure(final);
    if (sandbox !== undefined) {
      await measureExecutionPhase(
        context.phaseTiming,
        "sandbox_settle",
        this.completeThreadSandboxTerminalEffect.bind(this, context, sandbox, final),
      );
    }
    return { outcome: "succeeded" };
  }

  /**
   * 任意阶段抛出后的统一收敛。优先级：Sandbox 准备已得出的终态 > 本地停止原因 >
   * Agent 失败码 > 固定模型不可用 > INTERNAL；有 Sandbox 时必须走带清理的恢复路径。
   */
  async #failAttempt(run: ActiveRun, pinnedModelUnavailable: boolean): Promise<RunWorkerResult> {
    const { context, cancellation } = run;
    closeEventAcceptance(context);
    await run.events.drained.catch(() => undefined);
    await run.requestAbort();
    const sandbox = run.sandboxes?.current;
    const preparationResult = run.sandboxes?.failureResult;
    if (preparationResult !== undefined) return preparationResult;
    if (context.stopped) return await this.finishStopped(context, context.stopped, sandbox);
    if (context.agentFailure !== undefined) {
      if (sandbox === undefined && context.agentFailure === "SANDBOX_FAILED") {
        return await this.finalizeWithoutRevision(context, "failed", "SANDBOX_FAILED");
      }
      return sandbox === undefined
        ? await this.requireRecovery(context, context.agentFailure, [])
        : await this.recoverWithCleanup(context, sandbox, context.agentFailure, cancellation);
    }
    if (pinnedModelUnavailable) {
      return sandbox === undefined
        ? await this.finalizeWithoutRevision(context, "failed", "PROVIDER")
        : await this.recoverWithCleanup(context, sandbox, "PROVIDER", cancellation);
    }
    return sandbox
      ? await this.recoverWithCleanup(context, sandbox, "INTERNAL", cancellation)
      : await this.requireRecovery(context, "INTERNAL", []);
  }

  private async recordWorkspaceMaterialization(
    context: ExecutionContext,
    startedAt: number,
    outcome: "ready" | "failed",
  ): Promise<void> {
    await this.dependencies.continuityMetrics
      ?.record({
        tenantId: context.scope.tenantId,
        threadId: context.scope.threadId,
        runId: context.scope.runId,
        observationId: `${context.attemptId}:workspace-materialize:${outcome}`,
        metricName: "workspace_materialize_latency_ms",
        value: Math.max(0, Date.now() - startedAt),
        unit: "milliseconds",
        outcome,
      })
      .catch(() => undefined);
  }

  private async withRetrievedMemory(
    snapshot: Pick<ClaimedExecutionSnapshot, "agent" | "tenantKind" | "memorySubjectUserId">,
    scope: ExecutionScope,
    userText: string,
  ): Promise<string> {
    const retriever = this.dependencies.memoryRetriever;
    if (
      typeof snapshot.agent === "string" ||
      (snapshot.agent.content.memory.mode === "configured" &&
        !snapshot.agent.content.memory.longTermEnabled) ||
      retriever === undefined ||
      snapshot.tenantKind === undefined ||
      snapshot.memorySubjectUserId === undefined
    ) {
      return userText;
    }
    try {
      const memories = await retriever.retrieve({
        tenantId: scope.tenantId,
        tenantKind: snapshot.tenantKind,
        userId: snapshot.memorySubjectUserId,
        threadId: scope.threadId,
        runId: scope.runId,
        query: userText,
        topK: 5,
      });
      return injectRetrievedMemories(userText, memories);
    } catch {
      return userText;
    }
  }

  private async stopPoint(
    context: ExecutionContext,
    cancellation: AbortSignal,
  ): Promise<ExecutionContext["stopped"]> {
    return await context.durableLane.run(async () => {
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      if (context.stopped) return context.stopped;
      const inspected = await this.inspectAndRenewWithUnavailableRetry(context);
      if (inspected.outcome === "active") {
        if (!inspectionMatches(context, inspected)) {
          context.stopped = "scope_mismatch";
          return context.stopped;
        }
        acceptInspection(context, inspected);
        if (inspected.agentRevisionRevoked) context.stopped = "agent_revision_revoked";
        refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
        return context.stopped;
      }
      context.stopped = inspected.outcome === "cancelled" ? "cancelled" : inspected.outcome;
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      return context.stopped;
    });
  }

  private async renewHeartbeatWithUnavailableRetry(
    context: ExecutionContext,
  ): Promise<ExecutionContext["stopped"]> {
    const inspected = await this.inspectAndRenewWithUnavailableRetry(context);
    if (inspected.outcome !== "active") {
      return inspected.outcome === "cancelled" ? "cancelled" : inspected.outcome;
    }
    if (!inspectionMatches(context, inspected)) return "scope_mismatch";
    acceptInspection(context, inspected);
    if (inspected.agentRevisionRevoked) return "agent_revision_revoked";

    const renewingSandboxLease = context.threadSandboxLease;
    if (renewingSandboxLease === undefined) return undefined;
    for (let attempt = 0; ; attempt += 1) {
      if (context.stopped || context.threadSandboxLease !== renewingSandboxLease) {
        return context.stopped;
      }
      try {
        const renewed = await this.dependencies.threadSandboxes?.renew({
          scope: context.scope,
          attemptId: context.attemptId,
          lease: renewingSandboxLease,
          leaseDurationMs: this.#leaseDurationMs,
        });
        if (context.threadSandboxLease !== renewingSandboxLease) return undefined;
        if (renewed === "renewed") return undefined;
        if (renewed === "lease_lost") return "fence_lost";
      } catch {
        // unavailable 会在下面统一进入有界重试；明确 lease_lost 绝不重试。
      }
      const retryDelay = INSPECTION_UNAVAILABLE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) return "unavailable";
      await delay(retryDelay);
    }
  }

  private async inspectAndRenewWithUnavailableRetry(
    context: ExecutionContext,
  ): Promise<Awaited<ReturnType<ExecutionPersistencePort["inspectAndRenew"]>>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const inspected = await this.dependencies.persistence.inspectAndRenew({
          fence: context.fence,
          leaseDurationMs: this.#leaseDurationMs,
        });
        if (inspected.outcome !== "unavailable") return inspected;
      } catch {
        // unavailable 会在下面统一进入有界重试；明确 fence/scope 结果绝不重试。
      }

      const retryDelay = INSPECTION_UNAVAILABLE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) return { outcome: "unavailable" };
      // 退避期间继续占用 durable lane，禁止旧 fence 与事件 mutation 或副作用许可交错。
      await delay(retryDelay);
    }
  }

  /** 清理状态推进忽略业务取消，但仍严格校验双栅栏与 scope/head checkpoint。 */
  private async fencePoint(
    context: ExecutionContext,
  ): Promise<"shutdown" | "fence_lost" | "unavailable" | "scope_mismatch" | undefined> {
    return await context.durableLane.run(async () => {
      if (this.dependencies.shutdownSignal?.aborted) context.stopped = "shutdown";
      if (
        context.stopped === "shutdown" ||
        context.stopped === "fence_lost" ||
        context.stopped === "unavailable" ||
        context.stopped === "scope_mismatch"
      ) {
        return context.stopped;
      }
      const inspected = await this.inspectAndRenewWithUnavailableRetry(context);
      if (this.dependencies.shutdownSignal?.aborted) {
        context.stopped = "shutdown";
        return "shutdown";
      }
      if (inspected.outcome === "active") {
        if (!inspectionMatches(context, inspected)) return "scope_mismatch";
        acceptInspection(context, inspected);
        return undefined;
      }
      if (inspected.outcome === "cancelled") return undefined;
      return inspected.outcome;
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
      this.abortAuthorizationFailure(context, "tool_execution");
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    await gate.committed;
    if (gate.authorizationRequested || context.adapterRejected || !context.eventAcceptanceOpen) {
      context.adapterRejected = true;
      context.agentFailure = "PROTOCOL";
      closeEventAcceptance(context);
      this.abortAuthorizationFailure(context, "tool_execution");
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    // callId 在 Attempt 内永久一次性；即使后续授权失败，也不能重新领取许可。
    gate.authorizationRequested = true;
    return await this.authorizeEffect(context, cancellation, "tool_execution", call);
  }

  private async writeTodoAfterStarted(
    context: ExecutionContext,
    cancellation: AbortSignal,
    call: { readonly callId: string; readonly command: TodoWriteCommand },
  ): Promise<TodoSnapshot> {
    const gate = context.toolStartedGates.get(call.callId);
    if (gate === undefined || gate.name !== "todo_write") {
      throw new Error("TODO_PROTOCOL");
    }
    await gate.committed;
    if (gate.todoWriteRequested || context.adapterRejected || !context.eventAcceptanceOpen) {
      throw new Error("TODO_PROTOCOL");
    }
    gate.todoWriteRequested = true;
    refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
    if (context.stopped) throw new Error("TODO_WRITE_STOPPED");

    const snapshot = applyTodoWrite(context.todo, call.command);
    const encoded = agentEvent(context, { type: "todo.updated", snapshot });
    const persisted = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/todo/${call.callId}`,
      events: [encoded],
      outbox: [],
    });
    if (!isApplied(persisted)) {
      closeEventAcceptance(context);
      context.stopped =
        persisted.outcome === "fence_lost" || persisted.outcome === "scope_mismatch"
          ? "fence_lost"
          : "unavailable";
      throw new Error("TODO_PERSISTENCE_UNAVAILABLE");
    }
    context.todo = snapshot;
    return snapshot;
  }

  private async authorizeEffect(
    context: ExecutionContext,
    cancellation: AbortSignal,
    effect: ExternalEffectPermit["effect"],
    call: ExternalEffectCall,
  ): Promise<ConsumedExternalEffectAuthorization> {
    refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
    if (context.stopped) throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    const authorization = await context.durableLane.run(async () => {
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
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
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      if (context.stopped) {
        closeEventAcceptance(context);
        this.abortAuthorizationFailure(context, effect);
        throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
      }
      if (result.outcome !== "authorized" || !permitMatches(context, result.permit, effect, call)) {
        context.stopped =
          result.outcome === "authorized" || result.outcome === "scope_mismatch"
            ? "scope_mismatch"
            : result.outcome === "cancelled" || result.outcome === "agent_revision_revoked"
              ? result.outcome
              : result.outcome === "conflict" || result.outcome === "fence_lost"
                ? "fence_lost"
                : "unavailable";
        closeEventAcceptance(context);
        this.abortAuthorizationFailure(context, effect);
        throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
      }
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      if (context.stopped) {
        closeEventAcceptance(context);
        this.abortAuthorizationFailure(context, effect);
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
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      if (
        consumed.outcome !== "consumed" ||
        context.stopped !== undefined ||
        consumedAtMonotonicMs - monotonicStarted >= this.#externalEffectPermitMs
      ) {
        if (context.stopped === undefined) {
          context.stopped =
            consumed.outcome === "cancelled" || consumed.outcome === "agent_revision_revoked"
              ? consumed.outcome
              : consumed.outcome === "unavailable"
                ? "unavailable"
                : consumed.outcome === "scope_mismatch"
                  ? "scope_mismatch"
                  : "fence_lost";
        }
        closeEventAcceptance(context);
        this.abortAuthorizationFailure(context, effect);
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
    refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
    if (context.stopped) {
      throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    }
    return authorization;
  }

  private abortAuthorizationFailure(
    context: ExecutionContext,
    effect: ExternalEffectPermit["effect"],
  ): void {
    // PiFactory 的屏障必须先持久化固定失败回执，再同步阻断下一 Provider 请求；提前 abort
    // 会让 Pi 丢弃仍在执行的 Tool Promise。其他 Session 实现没有该保证，仍立即中止。
    if (
      effect === "tool_execution" &&
      this.dependencies.sessions.toolRejectionReceiptBarrier === "durable"
    )
      return;
    if (!context.abortPromise) {
      context.abortPromise = context.abortSession?.() ?? Promise.resolve();
    }
  }

  /** 将一条已读取的 durable steer 作为真实 user fact 幂等提交。 */
  private applyThreadSteer(
    context: ExecutionContext,
    item: PendingThreadSteer,
  ): Promise<RuntimeMutationResult> {
    return this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/steer/${item.receiptId}`,
      events: [],
      outbox: [],
      threadSteer: {
        receiptId: item.receiptId,
        targetTurnId: item.targetTurnId,
        bodyDigest: item.bodyDigest,
      },
    });
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
    const result = await context.durableLane.run<RuntimeMutationResult>(async () => {
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
      let result: RuntimeMutationResult;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await measureExecutionPhase(context.phaseTiming, "runtime_persist", () =>
            this.dependencies.persistence.mutate(command),
          );
        } catch {
          result = { outcome: "unavailable" };
        }
        if (result.outcome !== "unavailable") break;
        const retryDelay = MUTATION_UNAVAILABLE_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined) return result;
        // unavailable 明确表示事务没有提交；同一 durable lane 内只能重放字节相同的
        // 幂等命令。四次尝试的最坏连接等待仍小于 30 秒默认租约，避免阻塞 heartbeat 过期。
        await delay(retryDelay);
      }
      if (result.outcome === "response_unknown") {
        // COMMIT 回包未知后，远端端口映射可能同时重置第一次读回连接。完整 scope 下有界
        // 重读是只读且幂等的；not_found 仍不能证明事务未提交。
        for (const delayMs of MUTATION_READBACK_RETRY_DELAYS_MS) {
          if (delayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          }
          const recovered = await measureExecutionPhase(
            context.phaseTiming,
            "runtime_persist",
            () =>
              this.dependencies.persistence.readMutation({
                scope: context.scope,
                idempotencyKey: input.idempotencyKey,
              }),
          );
          if (recovered.outcome === "unavailable" || recovered.outcome === "not_found") continue;
          result = recovered;
          break;
        }
        if (result.outcome === "response_unknown") return result;
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
        this.dependencies.telemetry?.recordMutation(
          context.attemptId,
          input.events,
          input.nextRunStatus,
        );
      }
      return result;
    });
    if (isApplied(result) && input.events.length > 0) {
      await Promise.allSettled(
        input.events.map((event) =>
          this.dependencies.runEventDiagnostics?.persist({
            context: {
              tenantId: context.scope.tenantId,
              threadId: context.scope.threadId,
              runId: context.scope.runId,
              attemptId: context.attemptId,
            },
            event,
          }),
        ),
      );
    }
    return result;
  }

  private async prepareTurnContextAppend(
    context: ExecutionContext,
    event: Extract<RuntimeAgentEvent, { type: "turn.completed" }>,
    phase?: "commentary" | "final_answer",
  ): Promise<ThreadContextAppendCommandV1> {
    const ordinal = context.contextTurnOrdinal;
    context.contextTurnOrdinal += 1;
    const key = `${context.attemptId}/context/turn/${ordinal}`;
    const bodies = this.dependencies.threadContextBodies;
    if (bodies === undefined) throw new Error("Thread Context body persistence 缺失");
    const entries: ThreadContextAppendCommandV1["entries"][number][] = [];
    const assistantText = event.assistant.content
      .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const assistantContent = event.assistant.content
      .filter(
        (item): item is Exclude<typeof item, { type: "toolCall" }> => item.type !== "toolCall",
      )
      .map((item) =>
        item.type === "text"
          ? { type: "text" as const, text: item.text }
          : {
              type: "thinking" as const,
              thinking: item.thinking,
              ...(item.thinkingSignature === undefined
                ? {}
                : { thinkingSignature: item.thinkingSignature }),
              ...(item.redacted === undefined ? {} : { redacted: item.redacted }),
            },
      );
    const assistantBody = {
      role: "assistant",
      text: assistantText,
      content: assistantContent,
      api: event.assistant.api,
      provider: event.assistant.provider,
      model: event.assistant.model,
      stopReason: event.assistant.stopReason,
      timestamp: event.assistant.timestamp,
      ...(phase === undefined ? {} : { phase }),
    };
    entries.push({
      entryId: `${key}/assistant`,
      kind: "assistant_message",
      body: await bodies.persist({
        tenantId: context.scope.tenantId,
        idempotencyKey: `${key}/assistant/body`,
        value: assistantBody,
      }),
    });
    for (const item of event.assistant.content) {
      if (item.type !== "toolCall") continue;
      const body = {
        name: item.name,
        arguments: item.arguments,
        ...(item.thoughtSignature === undefined ? {} : { thoughtSignature: item.thoughtSignature }),
        timestamp: event.assistant.timestamp,
      };
      entries.push({
        entryId: `${key}/tool/${item.id}/call`,
        kind: "tool_call",
        toolCallId: item.id,
        toolName: item.name,
        body: await bodies.persist({
          tenantId: context.scope.tenantId,
          idempotencyKey: `${key}/tool/${item.id}/call/body`,
          value: body,
        }),
      });
    }
    for (const result of event.toolResults) {
      const body = {
        name: result.toolName,
        text: result.text,
        isError: result.isError,
        timestamp: result.timestamp,
      };
      entries.push({
        entryId: `${key}/tool/${result.toolCallId}/result`,
        kind: "tool_result",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        body: await bodies.persist({
          tenantId: context.scope.tenantId,
          idempotencyKey: `${key}/tool/${result.toolCallId}/result/body`,
          value: body,
        }),
      });
    }
    return { schemaVersion: 1, idempotencyKey: key, entries };
  }

  private async settleSandbox(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    disposition: "pause" | "close",
    primaryFailureCode?: StableWorkerErrorCode,
  ): Promise<
    | { readonly outcome: "settled" }
    | { readonly outcome: "recovery"; readonly result: RunWorkerResult }
  > {
    if (context.threadSandboxLease !== undefined) {
      // Thread Session 的失败/取消路径终止可变缓存；success/waiting 由 terminal mutation
      // 原子决定 handoff 或 pause，绝不能在这里提前观察队列。
      if (disposition === "pause") {
        return {
          outcome: "recovery",
          result: await this.requireRecovery(context, "PROTOCOL", []),
        };
      }
      const lifecycle = this.dependencies.threadSandboxes;
      if (lifecycle === undefined) {
        return {
          outcome: "recovery",
          result: await this.requireRecovery(context, primaryFailureCode ?? "SANDBOX_FAILED", []),
        };
      }
      const settled = await lifecycle.terminate({
        scope: context.scope,
        attemptId: context.attemptId,
        session: sandbox,
        lease: context.threadSandboxLease,
        reason: "run_cleanup",
      });
      if (settled === "settled") return { outcome: "settled" };
      return {
        outcome: "recovery",
        result: await this.requireRecovery(
          context,
          primaryFailureCode ?? (settled === "unknown" ? "SANDBOX_UNKNOWN" : "SANDBOX_FAILED"),
          [],
        ),
      };
    }
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
          result: await this.requireRecovery(context, primaryFailureCode ?? "SANDBOX_UNKNOWN", [
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
        result: await this.requireRecovery(context, primaryFailureCode ?? "SANDBOX_FAILED", []),
      };
    }
  }

  private async completeThreadSandboxTerminalEffect(
    context: ExecutionContext,
    sandbox: SandboxSessionRef,
    mutation: AppliedMutation,
  ): Promise<void> {
    const receipt = mutation.receipt.threadSandbox;
    if (context.threadSandboxLease === undefined || receipt?.outcome !== "effect_pending") return;
    // Run terminal 已经提交；此处 UNKNOWN 只改变 Session 缓存状态，不能回滚已提交的
    // Workspace/Context/Run 事实。Scheduler 会继续消费 durable effect。
    await this.dependencies.threadSandboxes
      ?.completeTerminalEffect({ scope: context.scope, session: sandbox, receipt })
      .catch(() => "unknown");
  }

  /**
   * Workspace 快照只在 Sandbox 即将暂停或回收前生成一次。成功收口且队列中已有 follow-up 时，
   * 终态事务会把仍在运行的 Thread Sandbox 交接给下一个 Run，文件随 Sandbox 延续，本次不生成
   * Revision，由最终暂停前的那个 Run 一并快照。
   *
   * 这是性能取舍而非正确性前提：查询后 follow-up 若被取消，终态会暂停一个含未快照改动的
   * Sandbox（与失败 Run 保留 Sandbox 相同）；后续若 Sandbox 在复用前过期或被异常回收，这些
   * 改动会丢失。查询失败、waiting 收口与非 Thread 复用的 Sandbox 一律照常快照。
   */
  private async shouldDeferWorkspaceSnapshot(
    context: ExecutionContext,
    turn: { readonly kind: string },
  ): Promise<boolean> {
    const lifecycle = this.dependencies.threadSandboxes;
    if (
      turn.kind === "waiting" ||
      context.sandboxIdleAction === "kill" ||
      context.threadSandboxLease === undefined ||
      lifecycle?.hasQueuedFollowUp === undefined
    ) {
      return false;
    }
    return lifecycle.hasQueuedFollowUp({ scope: context.scope }).catch(() => false);
  }

  private async prepareThreadSandboxTerminal(
    context: ExecutionContext,
  ): Promise<RuntimeMutationResult> {
    return this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/sandbox/thread-terminal-ready`,
      nextAttemptStatus: "finalizing",
      nextStage: "finalizing",
      events: [attemptEvent(context, "finalizing", "finalizing")],
      outbox: [],
    });
  }

  private async prepareNoSandboxTerminal(
    context: ExecutionContext,
  ): Promise<RuntimeMutationResult> {
    return this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/sandbox/not-required`,
      nextAttemptStatus: "finalizing",
      nextStage: "finalizing",
      events: [attemptEvent(context, "finalizing", "finalizing")],
      outbox: [],
    });
  }

  private async recoverWithCleanup(
    context: ExecutionContext,
    sandbox: SandboxSessionRef | undefined,
    code: StableWorkerErrorCode,
    cancellation: AbortSignal,
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    if (sandbox !== undefined) {
      const settled = await measureExecutionPhase(context.phaseTiming, "sandbox_settle", () =>
        this.settleSandbox(context, sandbox, "close", code),
      );
      if (settled.outcome !== "settled") return settled.result;
    }
    const stopped = await this.stopPoint(context, cancellation);
    if (stopped) return await this.finishStopped(context, stopped);
    return await this.requireRecovery(context, code, []);
  }

  private async finalizeWithCleanup(
    context: ExecutionContext,
    sandbox: SandboxSessionRef | undefined,
    runStatus: "failed" | "cancelled",
    code: StableWorkerErrorCode,
    cancellation: AbortSignal,
    responseAlreadyProvided = false,
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    const retainThreadSandbox =
      sandbox !== undefined &&
      context.threadSandboxLease !== undefined &&
      context.sandboxIdleAction === "pause" &&
      runStatus === "failed" &&
      code === "PROTOCOL" &&
      context.modelStopReason === "length";
    if (retainThreadSandbox && sandbox !== undefined) {
      const stopped = await this.stopPoint(context, cancellation);
      if (stopped === "cancelled") {
        return await this.finalizeWithCleanup(
          context,
          sandbox,
          "cancelled",
          "CANCELLED",
          cancellation,
        );
      }
      if (stopped && stopped !== "timeout")
        return await this.finishStopped(context, stopped, sandbox);
      const finalizing = await this.prepareThreadSandboxTerminal(context);
      if (!isApplied(finalizing)) return await this.handleMutationFailure(finalizing);
      return await this.finalizeWithoutRevision(
        context,
        runStatus,
        code,
        sandbox,
        responseAlreadyProvided,
      );
    }
    if (sandbox !== undefined) {
      const settled = await measureExecutionPhase(context.phaseTiming, "sandbox_settle", () =>
        this.settleSandbox(context, sandbox, "close", code),
      );
      if (settled.outcome !== "settled") return settled.result;
    }
    const stopped = await this.stopPoint(context, cancellation);
    if (stopped === "cancelled")
      return await this.finalizeWithoutRevision(context, "cancelled", "CANCELLED");
    if (stopped && stopped !== "timeout") return await this.finishStopped(context, stopped);
    return await this.finalizeWithoutRevision(
      context,
      runStatus,
      code,
      undefined,
      responseAlreadyProvided,
    );
  }

  private async finalizeWithoutRevision(
    context: ExecutionContext,
    runStatus: "failed" | "cancelled",
    code: StableWorkerErrorCode,
    retainedSandbox?: SandboxSessionRef,
    responseAlreadyProvided = false,
    deferredCleanupOutbox: readonly RuntimeOutboxV1[] = [],
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    const final = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/final/${runStatus}`,
      nextAttemptStatus: runStatus,
      nextStage: "finished",
      events: terminalFailureEvents(context, runStatus, "finished", code, responseAlreadyProvided),
      outbox: deferredCleanupOutbox,
      nextRunStatus: runStatus,
      releaseFences: true,
      ...(retainedSandbox === undefined || context.threadSandboxLease === undefined
        ? {}
        : { threadSandboxTerminal: terminalSandboxCommand(context.threadSandboxLease) }),
      ...(this.options.threadContextWriteEnabled === true
        ? { threadContextAppend: terminalContextAppend(context, runStatus, undefined, code) }
        : {}),
    });
    if (!isApplied(final)) return await this.handleMutationFailure(final);
    if (retainedSandbox !== undefined) {
      await measureExecutionPhase(context.phaseTiming, "sandbox_settle", () =>
        this.completeThreadSandboxTerminalEffect(context, retainedSandbox, final),
      );
    }
    return { outcome: runStatus };
  }

  private async finishStopped(
    context: ExecutionContext,
    stopped: NonNullable<ExecutionContext["stopped"]>,
    sandbox?: SandboxSessionRef,
  ): Promise<RunWorkerResult> {
    closeEventAcceptance(context);
    if (context.abortPromise) await context.abortPromise;
    if (
      stopped === "cancelled" ||
      stopped === "agent_revision_revoked" ||
      stopped === "external_tool_revoked"
    ) {
      const retainedThreadSandbox =
        sandbox !== undefined && context.threadSandboxLease !== undefined ? sandbox : undefined;
      const deferredCleanupOutbox =
        sandbox !== undefined && context.threadSandboxLease === undefined
          ? [cleanupOutbox(context, sandbox, "started", "close")]
          : [];
      // 先持久化停止事实，再让清理消费者处理 Sandbox；未知清理结果不得重开执行。
      return await this.finalizeWithoutRevision(
        context,
        stopped === "cancelled" ? "cancelled" : "failed",
        stopped === "cancelled"
          ? "CANCELLED"
          : stopped === "agent_revision_revoked"
            ? "AGENT_REVISION_REVOKED"
            : "EXTERNAL_TOOL_REVOKED",
        retainedThreadSandbox,
        false,
        deferredCleanupOutbox,
      );
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
    if (stopped === "shutdown") {
      return await this.requireRecovery(
        context,
        "WORKER_SHUTDOWN",
        recoveryCleanupOutbox(context, sandbox),
      );
    }
    if (stopped === "fence_lost" || stopped === "scope_mismatch") return { outcome: "fence_lost" };
    return await this.requireRecovery(
      context,
      "PERSISTENCE_UNAVAILABLE",
      recoveryCleanupOutbox(context, sandbox),
    );
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
      events: terminalFailureEvents(
        context,
        "recovery_required",
        context.actualCommittedStage,
        code,
        false,
      ),
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

function assertScope(scope: ExecutionScope): void {
  if (scope.rootRunId !== scope.runId) throw new Error("单 Agent 阶段要求 rootRunId 等于 runId");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
