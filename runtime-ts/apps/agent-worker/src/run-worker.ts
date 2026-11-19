import {
  applyTodoWrite,
  type ExecutionPhaseTimingObserver,
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
  AgentSessionFactoryPort,
  ArtifactPublicationPort,
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
  RunStartupTimingPhase,
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
import {
  RunPhaseTimingCollector,
  type RunPhaseTimingDiagnosticsPort,
} from "./run-phase-diagnostics.js";
import {
  RunStartupTimingCollector,
  type RunStartupTimingDiagnosticsPort,
} from "./run-startup-diagnostics.js";
import type { AppliedMutation, ExecutionContext } from "./run-worker-context.js";
import {
  directAttachmentProbePaths,
  prepareHistoryEntrypoints,
  probeResourceFilesystemDataPlane,
} from "./run-worker-resource-probe.js";
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
  reportWorkspaceMaterializeFailure,
  reportWorkspaceVerifyFailure,
  validateWorkspaceCandidate,
} from "./run-worker-workspace-failures.js";
import {
  applyFinalizationTransition,
  classifyFinalizationTurn,
  closeEventAcceptance,
  refreshLocalStop,
  registerToolStarted,
  updateAgentState,
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

export interface RunWorkerOptions {
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatMs?: number;
  readonly runTimeoutMs?: number;
  readonly externalEffectPermitMs?: number;
  /** TODO(codex-alignment): 旧调用方兼容字段，简化交付协议稳定后删除。 */
  readonly maxArtifactCorrectionRounds?: number;
  /** TODO(codex-alignment): 旧调用方兼容字段，简化交付协议稳定后删除。 */
  readonly artifactCorrectionPromptBudgetBytes?: number;
  readonly threadContextWriteEnabled?: boolean;
  readonly threadInputRoutingV2Enabled?: boolean;
  readonly threadSandboxSessionReuseEnabled?: boolean;
  readonly historyFilesystemEnabled?: boolean;
  readonly subagentsEnabled?: boolean;
}

type PendingThreadSteer = Extract<
  Awaited<ReturnType<ExecutionPersistencePort["readPendingThreadSteers"]>>,
  { readonly outcome: "pending" }
>["items"][number];

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
  /** TODO(codex-alignment): 旧装配 ABI；新 Run 完成流程不再读取该门。 */
  readonly artifacts: ArtifactPublicationPort;
  readonly clock: ClockPort;
  readonly metrics: RecoveryMetricsPort;
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

  async execute(scope: ExecutionScope): Promise<RunWorkerResult> {
    assertScope(scope);
    const startupStartedAt = performance.now();
    const claim = await this.dependencies.persistence.claim({
      scope,
      workerId: this.options.workerId,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (claim.outcome !== "claimed") {
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
      contextTurnOrdinal: 0,
    };
    const phaseTiming =
      this.dependencies.phaseTimingDiagnostics === undefined
        ? undefined
        : new RunPhaseTimingCollector(
            {
              tenantId: scope.tenantId,
              threadId: scope.threadId,
              runId: scope.runId,
              attemptId: context.attemptId,
            },
            this.dependencies.phaseTimingDiagnostics,
          );
    if (phaseTiming !== undefined) {
      context.phaseTiming = phaseTiming;
      // 同一数据库时钟的创建到领取间隔，重试 Attempt 仍以 Run 创建为起点，不冒充 Broker 排队。
      phaseTiming.record({
        phase: "run_queue_wait",
        startedAt: context.run.createdAt,
        durationMs: Math.max(0, Date.parse(claim.databaseNow) - Date.parse(context.run.createdAt)),
        status: "succeeded",
      });
    }
    const startupTiming =
      this.dependencies.startupTimingDiagnostics === undefined
        ? undefined
        : new RunStartupTimingCollector(
            {
              tenantId: scope.tenantId,
              threadId: scope.threadId,
              runId: scope.runId,
              attemptId: context.attemptId,
            },
            this.dependencies.startupTimingDiagnostics,
            startupStartedAt,
          );
    startupTiming?.record("run_claim", performance.now() - startupStartedAt);
    const measureStartup = <T>(
      phase: RunStartupTimingPhase,
      operation: () => Promise<T>,
    ): Promise<T> =>
      startupTiming === undefined ? operation() : startupTiming.measure(phase, operation);
    const startupTimingObserver =
      startupTiming === undefined
        ? undefined
        : {
            record: (phase: RunStartupTimingPhase, durationMs: number) =>
              startupTiming.record(phase, durationMs),
            modelInvocationStarting: () => startupTiming.publish(),
          };
    const cancellation = this.dependencies.cancellation.signalFor(scope);
    const shutdown = this.dependencies.shutdownSignal;
    let session: WorkerAgentSessionPort | undefined;
    let sandbox: SandboxSessionRef | undefined;
    let sandboxResourceFilesystemMounted = false;
    let sandboxPreparation: Promise<SandboxSessionRef> | undefined;
    let sandboxPreparationResult: RunWorkerResult | undefined;
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
      if (context.stopped === "shutdown") return;
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

    try {
      try {
        assertControlledRolloutProjection(claim.snapshot.rolloutProjection);
      } catch {
        return await this.requireRecovery(context, "EVENT_REJECTED", []);
      }
      let directAttachmentPaths: readonly string[];
      try {
        directAttachmentPaths = directAttachmentProbePaths(
          claim.snapshot.input,
          claim.snapshot.answer === undefined ? (claim.snapshot.attachments ?? []) : [],
        );
      } catch {
        return await this.requireRecovery(context, "PROTOCOL", []);
      }
      const ensureSandboxReady: Parameters<
        AgentSessionFactoryPort["create"]
      >[0]["ensureSandboxReady"] = async (request) => {
        const preparationTiming =
          phaseTiming === undefined || request.reason !== "tool"
            ? phaseTiming
            : {
                record: (span: Parameters<ExecutionPhaseTimingObserver["record"]>[0]) =>
                  phaseTiming.record({
                    ...span,
                    toolCallId: request.call.callId,
                    toolName: request.call.toolName,
                  }),
              };
        if (request.reason === "tool") {
          const call = request.call;
          const gate = context.toolStartedGates.get(call.callId);
          if (gate === undefined || gate.name !== call.toolName) {
            context.adapterRejected = true;
            context.agentFailure = "PROTOCOL";
            throw new Error("Sandbox 准备缺少匹配的 tool.started");
          }
          await gate.committed;
          if (!context.eventAcceptanceOpen || context.adapterRejected) {
            throw new Error("tool.started 未能持久化，拒绝准备 Sandbox");
          }
        }
        // acquire 后会先设置 ref，再继续物化 Workspace；并发调用必须等待同一个完整准备 Promise，
        // 不能仅因 ref 已可见就提前取得尚未 ready 的 Sandbox。
        // /resources 同时承载附件与公开 Skill 市场；任何 Sandbox 工具都必须看到同一虚拟目录。
        const requiresResourceFilesystem = true;
        if (sandboxPreparation !== undefined) {
          const prepared = await sandboxPreparation;
          if (requiresResourceFilesystem && !sandboxResourceFilesystemMounted) {
            context.agentFailure = "SANDBOX_FAILED";
            throw new Error("当前 Run 的 Sandbox 无法在创建后追加 ResourceFS mount");
          }
          return prepared;
        }
        if (sandbox !== undefined) {
          if (requiresResourceFilesystem && !sandboxResourceFilesystemMounted) {
            context.agentFailure = "SANDBOX_FAILED";
            throw new Error("当前 Run 的 Sandbox 无法在创建后追加 ResourceFS mount");
          }
          return sandbox;
        }
        sandboxPreparation ??= (async () => {
          const preAcquire = await this.stopPoint(context, cancellation);
          if (preAcquire) throw new Error("Sandbox acquire 前运行已停止");

          let requiresMaterialization = true;
          if (this.options.threadSandboxSessionReuseEnabled === true) {
            const lifecycle = this.dependencies.threadSandboxes;
            if (lifecycle === undefined) throw new Error("Thread Sandbox lifecycle 缺失");
            let acquisition = await measureExecutionPhase(
              preparationTiming,
              "sandbox_acquire",
              () =>
                lifecycle.acquire({
                  scope,
                  attemptId: context.attemptId,
                  owner: this.options.workerId,
                  leaseDurationMs: this.#leaseDurationMs,
                  signal: executionAbort.signal,
                  requiresResourceFilesystem,
                  ...(preparationTiming === undefined ? {} : { phaseTiming: preparationTiming }),
                }),
            );
            if (acquisition.outcome !== "ready") {
              context.agentFailure =
                acquisition.outcome === "unknown" ? "SANDBOX_UNKNOWN" : acquisition.code;
              throw new Error("Thread Sandbox acquire 失败");
            }
            sandbox = acquisition.session;
            sandboxResourceFilesystemMounted = acquisition.resourceFilesystemMounted;
            context.threadSandboxLease = acquisition.lease;
            requiresMaterialization = acquisition.requiresMaterialization;
            if (!acquisition.resourceFilesystemMounted) {
              context.agentFailure = "SANDBOX_FAILED";
              throw new Error("Thread Sandbox ResourceFS 能力事实缺失");
            }
            if (acquisition.source !== "cold_created") {
              const probeSession = acquisition.session;
              const probe = await measureExecutionPhase(
                preparationTiming,
                "sandbox_resource_probe",
                () =>
                  probeResourceFilesystemDataPlane(probeSession.sandbox, {
                    threadId: scope.threadId,
                    historyFilesystemEnabled: this.options.historyFilesystemEnabled === true,
                    directAttachmentPaths,
                    signal: executionAbort.signal,
                  }),
              );
              if (probe.outcome === "failed") {
                context.agentFailure = "SANDBOX_FAILED";
                throw new Error("复用 Thread Sandbox 的 ResourceFS 数据面验证失败");
              }
              if (probe.outcome === "missing") {
                const stale = acquisition;
                delete context.threadSandboxLease;
                const retired = await lifecycle
                  .terminate({
                    scope,
                    attemptId: context.attemptId,
                    session: stale.session,
                    lease: stale.lease,
                    reason: "resource_filesystem_data_plane_missing",
                  })
                  .catch(() => "unknown" as const);
                sandbox = undefined;
                sandboxResourceFilesystemMounted = false;
                if (retired !== "settled") {
                  context.agentFailure =
                    retired === "unknown" ? "SANDBOX_UNKNOWN" : "SANDBOX_FAILED";
                  throw new Error("失效 Thread Sandbox generation 退役失败");
                }
                acquisition = await measureExecutionPhase(
                  preparationTiming,
                  "sandbox_acquire",
                  () =>
                    lifecycle.acquire({
                      scope,
                      attemptId: context.attemptId,
                      owner: this.options.workerId,
                      leaseDurationMs: this.#leaseDurationMs,
                      signal: executionAbort.signal,
                      requiresResourceFilesystem,
                      ...(preparationTiming === undefined
                        ? {}
                        : { phaseTiming: preparationTiming }),
                    }),
                );
                if (acquisition.outcome !== "ready") {
                  context.agentFailure =
                    acquisition.outcome === "unknown" ? "SANDBOX_UNKNOWN" : acquisition.code;
                  throw new Error("Thread Sandbox 冷恢复 acquire 失败");
                }
                sandbox = acquisition.session;
                sandboxResourceFilesystemMounted = acquisition.resourceFilesystemMounted;
                context.threadSandboxLease = acquisition.lease;
                requiresMaterialization = acquisition.requiresMaterialization;
                if (
                  acquisition.source !== "cold_created" ||
                  acquisition.lease.generation <= stale.lease.generation ||
                  acquisition.lease.sessionId === stale.lease.sessionId ||
                  !acquisition.resourceFilesystemMounted ||
                  !acquisition.requiresMaterialization
                ) {
                  context.agentFailure = "SANDBOX_FAILED";
                  throw new Error("Thread Sandbox 冷恢复没有切换到新的完整 generation");
                }
                const recoveredSession = acquisition.session;
                const recoveredProbe = await measureExecutionPhase(
                  preparationTiming,
                  "sandbox_resource_probe",
                  () =>
                    probeResourceFilesystemDataPlane(recoveredSession.sandbox, {
                      threadId: scope.threadId,
                      historyFilesystemEnabled: this.options.historyFilesystemEnabled === true,
                      directAttachmentPaths,
                      signal: executionAbort.signal,
                    }),
                );
                if (recoveredProbe.outcome !== "ready") {
                  context.agentFailure = "SANDBOX_FAILED";
                  throw new Error("冷恢复 Thread Sandbox 的 ResourceFS 数据面仍不可用");
                }
              }
            }
          } else {
            let acquisition: Awaited<ReturnType<SandboxSessionRegistryPort["acquire"]>>;
            try {
              acquisition = await measureExecutionPhase(preparationTiming, "sandbox_acquire", () =>
                this.dependencies.sandboxes.acquire({
                  scope,
                  signal: executionAbort.signal,
                  requiresResourceFilesystem,
                  ...(preparationTiming === undefined ? {} : { phaseTiming: preparationTiming }),
                }),
              );
            } catch {
              context.agentFailure = "SANDBOX_FAILED";
              throw new Error("Sandbox acquire 失败");
            }
            if (acquisition.outcome === "unknown") {
              const unknownFact = await this.applyMutation(context, {
                idempotencyKey: `${context.attemptId}/sandbox/acquire-unknown/${acquisition.event.requestId}`,
                events: [],
                outbox: [cleanupUnknownOutbox(context, acquisition.event)],
              });
              if (!isApplied(unknownFact)) {
                sandboxPreparationResult = await this.handleMutationFailure(unknownFact);
                throw new Error("Sandbox acquire UNKNOWN 事实未能持久化");
              }
              context.agentFailure = "SANDBOX_UNKNOWN";
              throw new Error("Sandbox acquire 结果未知");
            }
            if (acquisition.outcome === "failed") {
              context.agentFailure = acquisition.code;
              throw new Error("Sandbox acquire 失败");
            }
            sandbox = acquisition.session;
            sandboxResourceFilesystemMounted = requiresResourceFilesystem;
          }

          const acquired = sandbox;
          if (acquired === undefined) {
            context.agentFailure = "SANDBOX_FAILED";
            throw new Error("Sandbox acquire 未返回 Session");
          }
          const postAcquire = await this.stopPoint(context, cancellation);
          if (
            postAcquire !== undefined &&
            postAcquire !== "cancelled" &&
            postAcquire !== "timeout"
          ) {
            if (context.threadSandboxLease === undefined) {
              await this.bestEffortOrphanCleanup(scope, acquired, postAcquire);
            } else {
              await this.dependencies.threadSandboxes
                ?.terminate({
                  scope,
                  attemptId: context.attemptId,
                  session: acquired,
                  lease: context.threadSandboxLease,
                  reason: "checkpoint_failed",
                })
                .catch(() => "unknown");
            }
            sandbox = undefined;
            delete context.threadSandboxLease;
            throw new Error("Sandbox acquire 后运行已停止");
          }

          // acquire 可能发生在模型执行阶段；cleanup intent 是正交生命周期事实，不回退主阶段。
          const intent = await this.applyMutation(context, {
            idempotencyKey: `${context.attemptId}/sandbox/cleanup-intent`,
            events: [],
            outbox:
              context.threadSandboxLease === undefined
                ? [cleanupOutbox(context, acquired, "pending")]
                : [],
          });
          if (!isApplied(intent)) {
            if (context.threadSandboxLease === undefined) {
              await this.bestEffortOrphanCleanup(scope, acquired, intent.outcome);
            } else {
              await this.dependencies.threadSandboxes
                ?.terminate({
                  scope,
                  attemptId: context.attemptId,
                  session: acquired,
                  lease: context.threadSandboxLease,
                  reason: "checkpoint_failed",
                })
                .catch(() => "unknown");
            }
            sandbox = undefined;
            delete context.threadSandboxLease;
            sandboxPreparationResult = await this.handleMutationFailure(intent);
            throw new Error("Sandbox cleanup intent 未能持久化");
          }
          if (postAcquire) throw new Error("Sandbox acquire 后运行已停止");

          const preMaterialize = await this.stopPoint(context, cancellation);
          if (preMaterialize) throw new Error("Workspace 物化前运行已停止");
          const materializeStartedAt = Date.now();
          try {
            if (requiresMaterialization) {
              await measureExecutionPhase(preparationTiming, "workspace_materialize", () =>
                this.dependencies.revisions.materialize({
                  scope,
                  attemptId: context.attemptId,
                  ...(context.currentRevisionId === undefined
                    ? {}
                    : { expectedCurrentRevisionId: context.currentRevisionId }),
                  sandbox: acquired,
                  // Workspace journal 的 operationKey 是受限协议字段；不得复用含 `/` 的路径样式键。
                  operationKey: `${context.attemptId}:workspace:materialize`,
                  signal: executionAbort.signal,
                  ...(preparationTiming === undefined ? {} : { phaseTiming: preparationTiming }),
                }),
              );
            }
            if (context.threadSandboxLease !== undefined && requiresMaterialization) {
              const attested = await this.dependencies.threadSandboxes?.attestMaterialized({
                scope,
                attemptId: context.attemptId,
                lease: context.threadSandboxLease,
                ...(context.currentRevisionId === undefined
                  ? {}
                  : { revisionId: context.currentRevisionId }),
              });
              if (attested !== "attested") {
                throw new Error("THREAD_SANDBOX_ATTESTATION_FAILED");
              }
            }
            if (requiresMaterialization) {
              await this.recordWorkspaceMaterialization(context, materializeStartedAt, "ready");
            }
          } catch (error) {
            if (requiresMaterialization) {
              await this.recordWorkspaceMaterialization(context, materializeStartedAt, "failed");
            }
            reportWorkspaceMaterializeFailure(error);
            context.agentFailure = "WORKSPACE_CONFLICT";
            throw new Error("Workspace 物化失败");
          }
          if (this.options.historyFilesystemEnabled === true) {
            try {
              await measureExecutionPhase(preparationTiming, "workspace_history_prepare", () =>
                prepareHistoryEntrypoints(acquired.sandbox, scope.threadId, executionAbort.signal),
              );
            } catch {
              context.agentFailure = "SANDBOX_FAILED";
              throw new Error("历史目录固定入口准备失败");
            }
          }
          const postMaterialize = await this.stopPoint(context, cancellation);
          if (postMaterialize) throw new Error("Workspace 物化后运行已停止");
          return acquired;
        })();
        return await sandboxPreparation;
      };

      const initialUserText = claim.snapshot.answer ?? claim.snapshot.input;
      const personalizationUserId =
        claim.snapshot.requestedByUserId ?? claim.snapshot.memorySubjectUserId;
      if (this.dependencies.personalizations !== undefined && personalizationUserId === undefined) {
        throw new Error("Run 缺少个性化用户身份");
      }
      const personalizationSnapshot =
        this.dependencies.personalizations === undefined
          ? undefined
          : await measureStartup(
              "personalization_resolve",
              () =>
                this.dependencies.personalizations?.resolveForRun({
                  scope: {
                    tenantId: scope.tenantId,
                    userId: userId(personalizationUserId as string),
                  },
                }) as Promise<RunPersonalizationSnapshot>,
            );
      let promptInput = {
        text: await measureStartup("memory_retrieve", () =>
          this.withRetrievedMemory(claim.snapshot, scope, initialUserText),
        ),
        attachments: claim.snapshot.answer === undefined ? (claim.snapshot.attachments ?? []) : [],
      };
      const preSession = await measureStartup("pre_session_stop_point", () =>
        this.stopPoint(context, cancellation),
      );
      if (preSession) return await this.finishStopped(context, preSession);
      const agentSupervisor =
        this.options.subagentsEnabled !== true || this.dependencies.agentControl === undefined
          ? undefined
          : new AgentSupervisor({
              persistence: this.dependencies.agentControl,
              rootAgentThreadId: rootAgentThreadId(context.attemptId),
              attemptId: context.attemptId,
              fence: context.fence,
              createSession: async (child) =>
                await this.dependencies.sessions.create({
                  scope,
                  attemptId: context.attemptId,
                  fence: context.fence,
                  agent: child.identity,
                  enabledToolNames: child.tools,
                  ensureSandboxReady,
                  rolloutProjection: Object.freeze({
                    schemaVersion: 2 as const,
                    checkpointId: `${child.identity.agentThreadId}:${child.identity.agentTurnId}`,
                    items: Object.freeze([]),
                  }),
                  ...(claim.snapshot.skills === undefined
                    ? {}
                    : { skillSnapshot: claim.snapshot.skills }),
                  ...(personalizationSnapshot === undefined ? {} : { personalizationSnapshot }),
                  ...(child.history === undefined ? {} : { threadActiveHistory: child.history }),
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
              onToolEvent: async (_identity, event) => {
                const gate =
                  event.type === "tool.started" ? registerToolStarted(context, event) : undefined;
                // root 与 Child 共享 Attempt event sequence；必须共用一条编码队列，禁止在进入
                // durable lane 前分别读取同一个 nextEventSequence 并制造伪 conflict。
                const persistence = eventChain.then(async () => {
                  try {
                    if (!context.eventAcceptanceOpen) {
                      throw new Error("SubAgent 工具事件入口已关闭");
                    }
                    const encoded = agentEvent(context, event);
                    const persisted = await this.applyMutation(context, {
                      idempotencyKey: `${context.attemptId}/subagent/tool/${event.callId}/${event.type}`,
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
                      throw new Error(`SubAgent ${event.type} 持久化失败`);
                    }
                  } finally {
                    gate?.resolve();
                  }
                });
                eventChain = persistence.catch(() => undefined);
                return persistence;
              },
            });
      if (agentSupervisor !== undefined) {
        await measureStartup("agent_supervisor_initialize", () => agentSupervisor.initialize());
      }
      const createdSession = await measureStartup("agent_session_create", () =>
        this.dependencies.sessions.create({
          scope,
          attemptId: context.attemptId,
          fence: context.fence,
          ensureSandboxReady,
          rolloutProjection: claim.snapshot.rolloutProjection,
          initialInputText: promptInput.text,
          ...(claim.snapshot.skills === undefined ? {} : { skillSnapshot: claim.snapshot.skills }),
          ...(personalizationSnapshot === undefined ? {} : { personalizationSnapshot }),
          ...(startupTimingObserver === undefined ? {} : { startupTiming: startupTimingObserver }),
          ...(phaseTiming === undefined ? {} : { phaseTiming }),
          ...(claim.snapshot.contextThroughSequence === undefined
            ? {}
            : { contextThroughSequence: claim.snapshot.contextThroughSequence }),
          ...(this.options.threadContextWriteEnabled !== true
            ? {}
            : {
                onTurnSafePoint: async (
                  event: Extract<RuntimeAgentEvent, { type: "turn.completed" }>,
                ) => {
                  // turn 安全点可能从 Pi 的 prepare hook 进入，而流式公开事件仍在异步持久化队列中。
                  // 必须先排空已发布事件，禁止 Thread Context 越过 thinking/message 终态。
                  await eventChain;
                  if (!context.eventAcceptanceOpen) throw new Error("Thread Context 写入口已关闭");
                  const finalization = classifyFinalizationTurn(context, event);
                  const append = await this.prepareTurnContextAppend(
                    context,
                    event,
                    finalization.phase,
                  );
                  const persisted = await this.applyMutation(context, {
                    idempotencyKey: append.idempotencyKey,
                    events:
                      finalization.event === undefined
                        ? []
                        : [agentEvent(context, finalization.event)],
                    outbox: [],
                    threadContextAppend: append,
                  });
                  if (!isApplied(persisted) || persisted.receipt.threadContext === undefined) {
                    closeEventAcceptance(context);
                    context.stopped =
                      persisted.outcome === "fence_lost" || persisted.outcome === "scope_mismatch"
                        ? "fence_lost"
                        : "unavailable";
                    throw new Error("Thread Context turn 安全点提交失败");
                  }
                  applyFinalizationTransition(context, finalization);
                  const throughSequence = persisted.receipt.threadContext.lastSequence;
                  if (this.options.threadInputRoutingV2Enabled !== true) return { throughSequence };
                  // 先持久化完整 assistant/tool 配对，再一次读取当前安全点已经排队的全部 steer；
                  // 新到达的输入留给后续安全点，避免持续写入让本次 Provider continuation 饥饿。
                  const pending = await this.dependencies.persistence.readPendingThreadSteers({
                    fence: context.fence,
                  });
                  if (pending.outcome === "pending") {
                    const steers = [];
                    for (const item of pending.items) {
                      const steered = await this.applyThreadSteer(context, item);
                      if (!isApplied(steered)) {
                        closeEventAcceptance(context);
                        context.stopped =
                          steered.outcome === "fence_lost" || steered.outcome === "scope_mismatch"
                            ? "fence_lost"
                            : "unavailable";
                        throw new Error("Thread steer 安全点提交失败");
                      }
                      steers.push({
                        receiptId: item.receiptId,
                        inputText: item.inputText,
                        ...(item.attachments === undefined
                          ? {}
                          : { attachments: item.attachments }),
                      });
                    }
                    return { throughSequence, steers };
                  }
                  if (pending.outcome !== "none") {
                    closeEventAcceptance(context);
                    context.stopped =
                      pending.outcome === "cancelled"
                        ? "cancelled"
                        : pending.outcome === "fence_lost" || pending.outcome === "scope_mismatch"
                          ? "fence_lost"
                          : "unavailable";
                    throw new Error("Thread steer 安全点不可继续");
                  }
                  return { throughSequence };
                },
              }),
          authorizeToolEffect: (call) =>
            this.authorizeToolEffectAfterStarted(context, cancellation, call),
          writeTodo: (call) => this.writeTodoAfterStarted(context, cancellation, call),
          ...(agentSupervisor === undefined ? {} : { agentControl: agentSupervisor }),
        }),
      );
      session = createdSession;
      context.abortSession = async () => {
        await session?.drainRejectedToolReceipts?.();
        await Promise.all([
          session?.abort().catch(() => undefined),
          agentSupervisor?.abortAll().catch(() => undefined),
        ]);
      };
      const postSession = await measureStartup("post_session_stop_point", () =>
        this.stopPoint(context, cancellation),
      );
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
            // turn.completed 由 awaited onTurnSafePoint 原子提交；这里不能异步重复写入。
            if (event.type === "turn.completed") return;
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

      const modelCheckpoint = await measureStartup("model_checkpoint", () =>
        this.applyMutation(context, {
          idempotencyKey: `${context.attemptId}/stage/model-execution-started`,
          nextAttemptStatus: "running",
          nextStage: "model_execution_started",
          events: [attemptEvent(context, "running", "model_execution_started")],
          outbox: [],
        }),
      );
      if (!isApplied(modelCheckpoint)) return await this.handleMutationFailure(modelCheckpoint);

      let steerReceiptId: string | undefined;
      let outputLimitContinuationRound = 0;
      let outputLimitContinuationUsed = false;
      const correctionRound = 0;
      let workspaceChange: ValidatedWorkspaceChange | undefined;

      // TODO(codex-alignment): waiting 仍复用历史单轮循环骨架；后续清理不可达 correction 命名。
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
        const preparedInput = await measureStartup("prepare_input", () =>
          createdSession.prepareInput(promptInput),
        );
        const modelAuthorization = await measureStartup("model_authorization", () =>
          this.authorizeEffect(context, cancellation, modelEffect, {
            callId: modelCallId,
            toolName: "pi_model",
            argsDigest: digestCanonical({
              prompt: promptInput.text,
              attachments: promptInput.attachments,
            }),
          }),
        );
        context.modelCompleted = false;
        delete context.modelStopReason;
        const turn = await session.runPrompt(preparedInput, modelAuthorization);
        await eventChain;
        if (context.abortPromise) await context.abortPromise;
        const postModel = await this.stopPoint(context, cancellation);
        if (postModel) return await this.finishStopped(context, postModel, sandbox);
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
          return await this.finalizeWithCleanup(
            context,
            sandbox,
            "failed",
            "PROTOCOL",
            cancellation,
          );
        }
        outputLimitContinuationRound = 0;

        if (this.options.threadInputRoutingV2Enabled === true) {
          const pending = await this.dependencies.persistence.readPendingThreadSteers({
            fence: context.fence,
          });
          if (pending.outcome === "pending") {
            // Pi 已经 settled 时没有可承载批量 steering 的活跃 prompt；只消费队首，
            // 其余 receipt 保持 pending，等这次 prompt 的安全点再合并进入后续请求。
            const [item] = pending.items;
            if (item === undefined) throw new Error("Thread steer 批次不能为空");
            const applied = await this.applyThreadSteer(context, item);
            if (!isApplied(applied)) return await this.handleMutationFailure(applied);
            promptInput = {
              text: await this.withRetrievedMemory(claim.snapshot, scope, item.inputText),
              attachments: item.attachments ?? [],
            };
            steerReceiptId = item.receiptId;
            continue;
          }
          if (pending.outcome !== "none") {
            context.stopped =
              pending.outcome === "cancelled"
                ? "cancelled"
                : pending.outcome === "fence_lost" || pending.outcome === "scope_mismatch"
                  ? "fence_lost"
                  : "unavailable";
            return await this.finishStopped(context, context.stopped, sandbox);
          }
        }

        await agentSupervisor?.drain();
        const postAgents = await this.stopPoint(context, cancellation);
        if (postAgents) return await this.finishStopped(context, postAgents, sandbox);
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

        if (sandbox !== undefined && !(await this.shouldDeferWorkspaceSnapshot(context, turn))) {
          const preVerify = await this.stopPoint(context, cancellation);
          if (preVerify) return await this.finishStopped(context, preVerify, sandbox);
          const verifiedSandbox = sandbox;
          let candidate: WorkspaceRevisionCandidate | undefined;
          try {
            candidate = await measureExecutionPhase(context.phaseTiming, "workspace_verify", () =>
              this.dependencies.revisions.verify({
                scope,
                attemptId: context.attemptId,
                ...(context.currentRevisionId === undefined
                  ? {}
                  : { expectedCurrentRevisionId: context.currentRevisionId }),
                sandbox: verifiedSandbox,
                operationKey: `${context.attemptId}:workspace:publish:${correctionRound}`,
                signal: executionAbort.signal,
                ...(context.phaseTiming === undefined ? {} : { phaseTiming: context.phaseTiming }),
              }),
            );
          } catch (error) {
            reportWorkspaceVerifyFailure(error);
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
        }

        if (turn.kind === "waiting") {
          try {
            assertControlledRolloutProjection(turn.rolloutProjection);
          } catch {
            return await this.recoverWithCleanup(context, sandbox, "EVENT_REJECTED", cancellation);
          }
          const preSettle = await this.stopPoint(context, cancellation);
          if (preSettle) return await this.finishStopped(context, preSettle, sandbox);
          if (sandbox !== undefined) {
            if (context.threadSandboxLease === undefined) {
              const settled = await measureExecutionPhase(
                context.phaseTiming,
                "sandbox_settle",
                this.settleSandbox.bind(this, context, sandbox, "pause"),
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

        // deliver_file 的成功已是 published 事实；Run 完成不再依赖声明或修正轮次。
        break;
      }

      if (sandbox === undefined) {
        const finalizing = await this.prepareNoSandboxTerminal(context);
        if (!isApplied(finalizing)) return await this.handleMutationFailure(finalizing);
      } else {
        if (context.threadSandboxLease === undefined) {
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
    } catch {
      closeEventAcceptance(context);
      await eventChain.catch(() => undefined);
      await requestAbort();
      if (sandboxPreparationResult !== undefined) return sandboxPreparationResult;
      if (context.stopped) return await this.finishStopped(context, context.stopped, sandbox);
      if (context.agentFailure !== undefined) {
        if (sandbox === undefined && context.agentFailure === "SANDBOX_FAILED") {
          return await this.finalizeWithoutRevision(context, "failed", "SANDBOX_FAILED");
        }
        return sandbox === undefined
          ? await this.requireRecovery(context, context.agentFailure, [])
          : await this.recoverWithCleanup(context, sandbox, context.agentFailure, cancellation);
      }
      return sandbox
        ? await this.recoverWithCleanup(context, sandbox, "INTERNAL", cancellation)
        : await this.requireRecovery(context, "INTERNAL", []);
    } finally {
      startupTiming?.publish();
      timeout.cancel();
      cancellation.removeEventListener("abort", onCancel);
      this.dependencies.cancellation.release?.(scope);
      shutdown?.removeEventListener("abort", onShutdown);
      closeEventAcceptance(context);
      // abort 完成后才允许取消订阅、释放 Session；cleanup 已由持久 Outbox/Saga 接管。
      await Promise.allSettled([heartbeat.stop()]);
      if (heartbeatInFlight) await Promise.allSettled([heartbeatInFlight]);
      await context.durableLane.drain();
      await Promise.allSettled([context.abortPromise ?? Promise.resolve()]);
      await Promise.allSettled([
        startupTiming?.drain() ?? Promise.resolve(),
        phaseTiming?.drain() ?? Promise.resolve(),
        Promise.resolve().then(() => unsubscribe?.()),
        Promise.resolve().then(() => session?.dispose()),
      ]);
    }
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
    snapshot: Pick<ClaimedExecutionSnapshot, "tenantKind" | "memorySubjectUserId">,
    scope: ExecutionScope,
    userText: string,
  ): Promise<string> {
    const retriever = this.dependencies.memoryRetriever;
    if (
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
            : result.outcome === "cancelled"
              ? "cancelled"
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
            consumed.outcome === "cancelled"
              ? "cancelled"
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
    if (stopped === "cancelled") {
      const retainedThreadSandbox =
        sandbox !== undefined && context.threadSandboxLease !== undefined ? sandbox : undefined;
      const deferredCleanupOutbox =
        sandbox !== undefined && context.threadSandboxLease === undefined
          ? [cleanupOutbox(context, sandbox, "started", "close")]
          : [];
      // API 已提交 cancelled 后，不能再等待外部 Sandbox settle；原子关闭 Attempt，并把
      // 已 armed 的普通 Sandbox 推进为 started，交给 Scheduler 持久清理。
      return await this.finalizeWithoutRevision(
        context,
        "cancelled",
        "CANCELLED",
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
