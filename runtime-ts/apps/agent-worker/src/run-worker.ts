import {
  applyTodoWrite,
  type IsoTimestamp,
  type Run,
  type Sha256Digest,
  type TodoSnapshot,
  type TodoWriteCommand,
  type Workspace,
  type WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { SandboxHandle } from "@cube-runtime/sandbox";
import { WorkspaceApplicationError, WorkspaceDependencyError } from "@cube-runtime/workspace";
import { AgentSupervisor, rootAgentThreadId } from "./agent-supervisor.js";
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
  AgentControlPersistencePort,
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
  ThreadContextAppendCommandV1,
  ThreadContextBodyPersistencePort,
  ThreadContinuityMetricsPort,
  ThreadSandboxLeaseRefV1,
  ThreadSandboxSessionLifecyclePort,
  ValidatedWorkspaceChange,
  WorkerAgentSessionPort,
  WorkspaceRevisionCandidate,
  WorkspaceRevisionVerifierPort,
} from "./ports.js";
import { assertProtocolSize } from "./ports.js";
import type { RunEventDiagnosticsPort } from "./run-event-diagnostics.js";
import { WorkspaceMaterializationStageError } from "./workspace-runtime.js";

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

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

async function preparePersonalHistoryEntrypoints(
  sandbox: SandboxHandle,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("历史目录 Thread ID 无效");
  const internalTarget = `/resources/.thread-files/${threadId}/files`;
  const command = `set -eu
history_target='/resources/history'
thread_target='${internalTarget}'
[ -d "$history_target" ] || exit 71
ensure_link() {
  link="$1"
  target="$2"
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] || exit 73
  elif [ -e "$link" ]; then
    exit 74
  else
    ln -s "$target" "$link"
  fi
}
ensure_link /history "$history_target"
prepare_thread_entrypoint() {
  link='/thread-files'
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$thread_target" ] || exit 73
  elif [ -d "$link" ]; then
    [ -z "$(find "$link" -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 74
    rmdir "$link"
    ln -s "$thread_target" "$link"
  elif [ -e "$link" ]; then
    exit 74
  else
    ln -s "$thread_target" "$link"
  fi
}
prepare_thread_entrypoint`;
  const result = await sandbox.command(command, { signal, timeoutMs: 30_000 }).catch((error) => {
    console.warn(`HISTORY_ENTRYPOINT_FAILED category=${historyEntrypointFailureCategory(error)}`);
    throw error;
  });
  if (result.exitCode !== 0) {
    console.warn(`HISTORY_ENTRYPOINT_FAILED category=exit_${result.exitCode}`);
    throw new Error("个人历史目录固定入口准备失败");
  }
}

function historyEntrypointFailureCategory(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "command_exception";
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/u.test(code)
    ? code.toLowerCase()
    : "command_exception";
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
  /** TODO(codex-alignment): 旧装配 ABI；新 Run 完成流程不再读取该门。 */
  readonly artifacts: ArtifactPublicationPort;
  readonly clock: ClockPort;
  readonly metrics: RecoveryMetricsPort;
  readonly threadContextBodies?: ThreadContextBodyPersistencePort;
  readonly threadSandboxes?: ThreadSandboxSessionLifecyclePort;
  readonly continuityMetrics?: ThreadContinuityMetricsPort;
  /** development 敏感诊断镜像；失败不得改变 durable Run 语义。 */
  readonly runEventDiagnostics?: RunEventDiagnosticsPort;
  readonly agentControl?: AgentControlPersistencePort;
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
  todo?: TodoSnapshot;
  stopped?: "cancelled" | "shutdown" | "timeout" | "fence_lost" | "unavailable" | "scope_mismatch";
  agentFailure?: StableWorkerErrorCode;
  modelCompleted: boolean;
  modelStopReason?: "stop" | "length" | "toolUse";
  eventAcceptanceOpen: boolean;
  adapterRejected: boolean;
  contextTurnOrdinal: number;
  abortPromise?: Promise<void>;
  abortSession?: () => Promise<void>;
  threadSandboxLease?: ThreadSandboxLeaseRefV1;
}

const OUTPUT_LIMIT_CONTINUATION_PROMPT =
  "上一轮因模型输出长度上限中止。请从当前状态继续：若任务尚未完成，继续使用工具完成剩余工作；若已完成，只给出简洁最终答复。不要重复已经完成的步骤。";

interface ToolStartedGate {
  readonly name: string;
  readonly committed: Promise<void>;
  authorizationRequested: boolean;
  todoWriteRequested: boolean;
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
        try {
          await context.durableLane.run(async () => {
            if (context.stopped) return;
            const inspected = await this.dependencies.persistence.inspectAndRenew({
              fence: context.fence,
              leaseDurationMs: this.#leaseDurationMs,
            });
            if (inspected.outcome === "active" && inspectionMatches(context, inspected)) {
              acceptInspection(context, inspected);
              if (context.threadSandboxLease !== undefined) {
                const renewed = await this.dependencies.threadSandboxes?.renew({
                  scope: context.scope,
                  attemptId: context.attemptId,
                  lease: context.threadSandboxLease,
                  leaseDurationMs: this.#leaseDurationMs,
                });
                if (renewed !== "renewed") {
                  context.stopped = renewed === "lease_lost" ? "fence_lost" : "unavailable";
                }
              }
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
      const ensureSandboxReady: Parameters<
        AgentSessionFactoryPort["create"]
      >[0]["ensureSandboxReady"] = async (request) => {
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
            const acquisition = await lifecycle.acquire({
              scope,
              attemptId: context.attemptId,
              owner: this.options.workerId,
              leaseDurationMs: this.#leaseDurationMs,
              signal: executionAbort.signal,
              requiresResourceFilesystem,
            });
            if (acquisition.outcome !== "ready") {
              context.agentFailure =
                acquisition.outcome === "unknown" ? "SANDBOX_UNKNOWN" : acquisition.code;
              throw new Error("Thread Sandbox acquire 失败");
            }
            sandbox = acquisition.session;
            sandboxResourceFilesystemMounted = acquisition.resourceFilesystemMounted;
            context.threadSandboxLease = acquisition.lease;
            requiresMaterialization = acquisition.requiresMaterialization;
          } else {
            let acquisition: Awaited<ReturnType<SandboxSessionRegistryPort["acquire"]>>;
            try {
              acquisition = await this.dependencies.sandboxes.acquire({
                scope,
                signal: executionAbort.signal,
                requiresResourceFilesystem,
              });
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
              await this.dependencies.revisions.materialize({
                scope,
                attemptId: context.attemptId,
                ...(context.currentRevisionId === undefined
                  ? {}
                  : { expectedCurrentRevisionId: context.currentRevisionId }),
                sandbox: acquired,
                // Workspace journal 的 operationKey 是受限协议字段；不得复用含 `/` 的路径样式键。
                operationKey: `${context.attemptId}:workspace:materialize`,
                signal: executionAbort.signal,
              });
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
          if (
            this.options.historyFilesystemEnabled === true &&
            claim.snapshot.tenantKind === "personal"
          ) {
            try {
              await preparePersonalHistoryEntrypoints(
                acquired.sandbox,
                scope.threadId,
                executionAbort.signal,
              );
            } catch {
              context.agentFailure = "SANDBOX_FAILED";
              throw new Error("个人历史目录固定入口准备失败");
            }
          }
          const postMaterialize = await this.stopPoint(context, cancellation);
          if (postMaterialize) throw new Error("Workspace 物化后运行已停止");
          return acquired;
        })();
        return await sandboxPreparation;
      };

      let promptInput = {
        text: claim.snapshot.answer ?? claim.snapshot.input,
        attachments: claim.snapshot.answer === undefined ? (claim.snapshot.attachments ?? []) : [],
      };
      const preSession = await this.stopPoint(context, cancellation);
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
      await agentSupervisor?.initialize();
      session = await this.dependencies.sessions.create({
        scope,
        attemptId: context.attemptId,
        fence: context.fence,
        ensureSandboxReady,
        rolloutProjection: claim.snapshot.rolloutProjection,
        initialInputText: promptInput.text,
        ...(claim.snapshot.skills === undefined ? {} : { skillSnapshot: claim.snapshot.skills }),
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
                const append = await this.prepareTurnContextAppend(context, event);
                const persisted = await this.applyMutation(context, {
                  idempotencyKey: append.idempotencyKey,
                  events: [],
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
                const throughSequence = persisted.receipt.threadContext.lastSequence;
                if (this.options.threadInputRoutingV2Enabled !== true) return { throughSequence };
                // 先持久化完整 assistant/tool 配对，再观察 steer；绝不把 user message 插进工具配对中间。
                const pending = await this.dependencies.persistence.readPendingThreadSteer({
                  fence: context.fence,
                });
                if (pending.outcome === "pending") {
                  const steered = await this.applyMutation(context, {
                    idempotencyKey: `${context.attemptId}/steer/${pending.receiptId}`,
                    events: [],
                    outbox: [],
                    threadSteer: {
                      receiptId: pending.receiptId,
                      targetTurnId: pending.targetTurnId,
                      bodyDigest: pending.bodyDigest,
                    },
                  });
                  if (!isApplied(steered)) {
                    closeEventAcceptance(context);
                    context.stopped =
                      steered.outcome === "fence_lost" || steered.outcome === "scope_mismatch"
                        ? "fence_lost"
                        : "unavailable";
                    throw new Error("Thread steer 安全点提交失败");
                  }
                  return {
                    throughSequence,
                    steer: {
                      receiptId: pending.receiptId,
                      inputText: pending.inputText,
                      ...(pending.attachments === undefined
                        ? {}
                        : { attachments: pending.attachments }),
                    },
                  };
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
      });
      context.abortSession = async () => {
        await session?.drainRejectedToolReceipts?.();
        await Promise.all([
          session?.abort().catch(() => undefined),
          agentSupervisor?.abortAll().catch(() => undefined),
        ]);
      };
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

      const modelCheckpoint = await this.applyMutation(context, {
        idempotencyKey: `${context.attemptId}/stage/model-execution-started`,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [attemptEvent(context, "running", "model_execution_started")],
        outbox: [],
      });
      if (!isApplied(modelCheckpoint)) return await this.handleMutationFailure(modelCheckpoint);

      let steerReceiptId: string | undefined;
      let outputLimitContinuationRound = 0;
      let outputLimitContinuationUsed = false;
      const correctionRound = 0;
      let workspaceChange: ValidatedWorkspaceChange | undefined;

      // TODO(codex-alignment): waiting 仍复用历史单轮循环骨架；后续清理不可达 correction 命名。
      for (;;) {
        const preModel = await this.stopPoint(context, cancellation);
        if (preModel) return await this.finishStopped(context, preModel, sandbox);
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
        const preparedInput = await session.prepareInput(promptInput);
        const modelAuthorization = await this.authorizeEffect(context, cancellation, modelEffect, {
          callId: modelCallId,
          toolName: "pi_model",
          argsDigest: digestCanonical({
            prompt: promptInput.text,
            attachments: promptInput.attachments,
          }),
        });
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
        if (turn.kind === "failed_with_response") {
          return await this.finalizeWithCleanup(
            context,
            sandbox,
            "failed",
            turn.code,
            cancellation,
            true,
          );
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
          const pending = await this.dependencies.persistence.readPendingThreadSteer({
            fence: context.fence,
          });
          if (pending.outcome === "pending") {
            const applied = await this.applyMutation(context, {
              idempotencyKey: `${context.attemptId}/steer/${pending.receiptId}`,
              events: [],
              outbox: [],
              threadSteer: {
                receiptId: pending.receiptId,
                targetTurnId: pending.targetTurnId,
                bodyDigest: pending.bodyDigest,
              },
            });
            if (!isApplied(applied)) return await this.handleMutationFailure(applied);
            promptInput = {
              text: pending.inputText,
              attachments: pending.attachments ?? [],
            };
            steerReceiptId = pending.receiptId;
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

        if (sandbox !== undefined) {
          const preVerify = await this.stopPoint(context, cancellation);
          if (preVerify) return await this.finishStopped(context, preVerify, sandbox);
          let candidate: WorkspaceRevisionCandidate | undefined;
          try {
            candidate = await this.dependencies.revisions.verify({
              scope,
              attemptId: context.attemptId,
              ...(context.currentRevisionId === undefined
                ? {}
                : { expectedCurrentRevisionId: context.currentRevisionId }),
              sandbox,
              operationKey: `${context.attemptId}:workspace:publish:${correctionRound}`,
              signal: executionAbort.signal,
            });
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
              const settled = await this.settleSandbox(context, sandbox, "pause");
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
            await this.completeThreadSandboxTerminalEffect(context, sandbox, waiting);
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
          const settled = await this.settleSandbox(context, sandbox, "close");
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
        await this.completeThreadSandboxTerminalEffect(context, sandbox, final);
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
      timeout.cancel();
      cancellation.removeEventListener("abort", onCancel);
      shutdown?.removeEventListener("abort", onShutdown);
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

  private async stopPoint(
    context: ExecutionContext,
    cancellation: AbortSignal,
  ): Promise<ExecutionContext["stopped"]> {
    return await context.durableLane.run(async () => {
      refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
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
          refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
          return context.stopped;
        }
        context.stopped = inspected.outcome === "cancelled" ? "cancelled" : inspected.outcome;
        refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      } catch {
        context.stopped = "unavailable";
        refreshLocalStop(context, cancellation, this.dependencies.shutdownSignal);
      }
      return context.stopped;
    });
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
      try {
        const inspected = await this.dependencies.persistence.inspectAndRenew({
          fence: context.fence,
          leaseDurationMs: this.#leaseDurationMs,
        });
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
          result: await this.requireRecovery(context, "SANDBOX_FAILED", []),
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
          settled === "unknown" ? "SANDBOX_UNKNOWN" : "SANDBOX_FAILED",
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
      const settled = await this.settleSandbox(context, sandbox, "close");
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
      const settled = await this.settleSandbox(context, sandbox, "close");
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
  ): Promise<RunWorkerResult> {
    if (context.abortPromise) await context.abortPromise;
    const final = await this.applyMutation(context, {
      idempotencyKey: `${context.attemptId}/final/${runStatus}`,
      nextAttemptStatus: runStatus,
      nextStage: "finished",
      events: terminalFailureEvents(context, runStatus, "finished", code, responseAlreadyProvided),
      outbox: [],
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
      await this.completeThreadSandboxTerminalEffect(context, retainedSandbox, final);
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
    if (stopped === "shutdown") {
      return await this.requireRecovery(context, "WORKER_SHUTDOWN", []);
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

function terminalFailureEvents(
  context: ExecutionContext,
  status: "failed" | "cancelled" | "recovery_required",
  stage: ExecutionStage,
  code: StableWorkerErrorCode,
  responseAlreadyProvided: boolean,
): readonly RuntimeEventV1[] {
  if (responseAlreadyProvided) return [attemptEvent(context, status, stage, code)];
  return [
    agentEventAt(context.nextEventSequence, {
      type: "runtime.notice",
      level: "error",
      code,
      message: terminalFailureMessage(status, code),
      source: "terminal_fallback",
    }),
    rawAttemptEvent(context.nextEventSequence + 1, status, stage, code),
  ];
}

function terminalFailureMessage(
  status: "failed" | "cancelled" | "recovery_required" | "waiting" | "succeeded",
  code: StableWorkerErrorCode,
): string {
  if (status === "cancelled" || code === "CANCELLED") {
    return "任务已取消；未完成或未提交的工作不视为成功。";
  }
  const messages: Readonly<Record<StableWorkerErrorCode, string>> = {
    CANCELLED: "任务已取消；未完成或未提交的工作不视为成功。",
    CONTEXT_TOO_LARGE: "上下文仍然超出模型窗口，本次任务未能完成。",
    TIMEOUT: "任务运行超时，本次任务未能完成。",
    PROVIDER: "模型服务调用失败，本次任务未能完成，请稍后重试。",
    PROTOCOL: "模型响应未形成有效终态，本次任务未能完成。",
    EVENT_REJECTED: "运行事件无法可靠保存，本次任务已中断。",
    WORKER_SHUTDOWN: "执行 Worker 已停止，本次任务已中断。",
    PERSISTENCE_UNAVAILABLE: "运行状态暂时无法可靠保存，本次任务已中断。",
    FENCE_LOST: "运行执行权已转移，本次任务已中断，未确认的工作不视为成功。",
    SANDBOX_UNKNOWN: "Sandbox 状态无法确认，本次任务已中断，未确认的修改不视为成功。",
    SANDBOX_FAILED: "Sandbox 连续调用失败，本次任务未能完成。",
    WORKSPACE_CONFLICT: "工作区验证或提交发生冲突，本次修改未确认成功。",
    ARTIFACT_NOT_READY: "交付文件尚未可靠发布，本次交付未确认成功。",
    IDEMPOTENCY_CONFLICT: "运行状态发生幂等冲突，本次任务已中断。",
    INTERNAL: "系统内部处理失败，本次任务未能完成。",
  };
  return messages[code];
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

function terminalContextAppend(
  context: ExecutionContext,
  status: "waiting" | "succeeded" | "failed" | "cancelled",
  workspaceChange?: ValidatedWorkspaceChange,
  code?: StableWorkerErrorCode,
): ThreadContextAppendCommandV1 {
  const key = `${context.attemptId}/context/final/${status}`;
  const entries: ThreadContextAppendCommandV1["entries"][number][] = [];
  if (status === "succeeded") {
    const workspaceBody =
      workspaceChange !== undefined
        ? { outcome: "committed", revisionId: workspaceChange.revisionId }
        : { outcome: "unchanged", revisionId: context.currentRevisionId ?? null };
    entries.push({
      entryId: `${key}/workspace`,
      kind: workspaceChange !== undefined ? "workspace_committed" : "workspace_unchanged",
      body: inlineContextBody(workspaceBody),
    });
  }
  const terminalBody = {
    status,
    ...(code === undefined
      ? {}
      : { code, userFacingMessage: terminalFailureMessage(status, code) }),
  };
  entries.push({
    entryId: `${key}/terminal`,
    kind: "run_terminal",
    body: inlineContextBody(terminalBody),
  });
  return { schemaVersion: 1, idempotencyKey: key, entries };
}

function inlineContextBody(value: Readonly<Record<string, unknown>>) {
  return {
    storage: "inline" as const,
    value,
    sha256: digestCanonical(value),
    size: Buffer.byteLength(JSON.stringify(value), "utf8"),
  };
}

function agentEvent(context: ExecutionContext, payload: RuntimeAgentEvent): RuntimeEventV1 {
  return agentEventAt(context.nextEventSequence, payload);
}

function agentEventAt(sequence: number, payload: RuntimeAgentEvent): RuntimeEventV1 {
  const event: RuntimeEventV1 = {
    schemaVersion: 1,
    kind: "agent_event",
    sequence,
    payload: sanitizeAgentEvent(payload),
  };
  assertProtocolSize(event);
  return event;
}

function sanitizeAgentEvent(event: RuntimeAgentEvent): RuntimeAgentEvent {
  if (event.type !== "error") return event;
  if (event.code === "CONTEXT_TOO_LARGE") return { ...event, message: "上下文超出模型窗口" };
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

function terminalSandboxCommand(lease: ThreadSandboxLeaseRefV1) {
  return {
    schemaVersion: 1 as const,
    sessionId: lease.sessionId,
    generation: lease.generation,
    leaseId: lease.leaseId,
    leaseToken: lease.leaseToken,
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

/**
 * Run 的公开错误码必须保持稳定，不能把驱动、对象键或路径写入事件；开发进程日志只记录
 * 固定分类，供区分 Workspace head、Sandbox 数据面和依赖结果未知。
 */
function reportWorkspaceMaterializeFailure(error: unknown): void {
  const category =
    error instanceof WorkspaceMaterializationStageError
      ? workspaceMaterializationCategory(error)
      : error instanceof WorkspaceApplicationError
        ? workspaceApplicationCategory(error)
        : error instanceof WorkspaceDependencyError
          ? workspaceDependencyCategory(error)
          : "unclassified";
  console.warn(`WORKSPACE_MATERIALIZE_FAILED category=${category}`);
}

/** Workspace candidate 发布与物化同样只记录固定分类，避免异常正文越过 Worker 边界。 */
function reportWorkspaceVerifyFailure(error: unknown): void {
  const category =
    error instanceof WorkspaceApplicationError
      ? workspaceApplicationCategory(error)
      : error instanceof WorkspaceDependencyError
        ? workspaceDependencyCategory(error)
        : "unclassified";
  console.warn(`WORKSPACE_VERIFY_FAILED category=${category}`);
}

function workspaceMaterializationCategory(error: WorkspaceMaterializationStageError): string {
  const stage = new Set([
    "load_current_manifest",
    "open_workspace",
    "baseline_snapshot",
    "baseline_list",
    "baseline_release",
    "materializer",
  ]).has(error.stage)
    ? error.stage
    : undefined;
  if (stage === undefined) return "unclassified";
  const detail = new Set([
    "invalid_operation_key",
    "invalid_scope",
    "invalid_sandbox_session",
    "invalid_manifest",
    "invalid_revision",
    "other_application",
    "dependency",
    "unclassified",
  ]).has(error.detail ?? "")
    ? error.detail
    : undefined;
  return `stage_${stage}${detail === undefined ? "" : `_${detail}`}`;
}

function workspaceApplicationCategory(error: WorkspaceApplicationError): string {
  const code = new Map([
    ["INVALID_INPUT", "invalid_input"],
    ["OPERATION_CONFLICT", "operation_conflict"],
    ["OPERATION_IN_PROGRESS", "operation_in_progress"],
    ["ACCESS_DENIED", "access_denied"],
    ["INTEGRITY_MISMATCH", "integrity_mismatch"],
    ["LIMIT_EXCEEDED", "limit_exceeded"],
    ["CANCELLED", "cancelled"],
    ["UNSAFE_SANDBOX_ENTRY", "unsafe_sandbox_entry"],
    ["DEPENDENCY_FAILED", "dependency_failed"],
    ["RESULT_UNKNOWN", "result_unknown"],
  ]).get(error.code);
  if (code === undefined) return "unclassified";
  return `application_${code}${
    error.diagnostic === "candidate_stream_pending" ? "_candidate_stream_pending" : ""
  }`;
}

function workspaceDependencyCategory(error: WorkspaceDependencyError): string {
  switch (error.result) {
    case "known":
      return "dependency_known";
    case "unknown":
      return "dependency_unknown";
    default:
      return "unclassified";
  }
}

function updateAgentState(context: ExecutionContext, event: RuntimeAgentEvent): void {
  if (event.type === "message.completed") {
    context.modelStopReason = event.stopReason;
    context.modelCompleted = event.stopReason === "stop";
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
  const gate = {
    name: event.name,
    committed,
    authorizationRequested: false,
    todoWriteRequested: false,
    resolve,
  };
  context.toolStartedGates.set(event.callId, gate);
  return gate;
}

function closeEventAcceptance(context: ExecutionContext): void {
  context.eventAcceptanceOpen = false;
}

function refreshLocalStop(
  context: ExecutionContext,
  cancellation: AbortSignal,
  shutdown: AbortSignal | undefined,
): void {
  if (shutdown?.aborted) {
    context.stopped = "shutdown";
  } else if (cancellation.aborted && context.stopped !== "shutdown") {
    context.stopped = "cancelled";
  }
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
  const expectedContextEntries =
    command.threadSteer === undefined ? command.threadContextAppend?.entries.length : 1;
  const threadContextMatches =
    expectedContextEntries === undefined
      ? receipt.threadContext === undefined
      : receipt.threadContext?.schemaVersion === 1 &&
        receipt.threadContext.entryCount === expectedContextEntries &&
        Number.isSafeInteger(receipt.threadContext.firstSequence) &&
        receipt.threadContext.firstSequence > 0 &&
        receipt.threadContext.lastSequence ===
          receipt.threadContext.firstSequence + expectedContextEntries - 1;
  const threadSteerMatches =
    command.threadSteer === undefined
      ? receipt.threadSteer === undefined
      : receipt.threadSteer?.receiptId === command.threadSteer.receiptId &&
        receipt.threadSteer.targetTurnId === command.threadSteer.targetTurnId &&
        receipt.threadSteer.bodyDigest === command.threadSteer.bodyDigest &&
        receipt.threadSteer.appliedContextSequence === receipt.threadContext?.firstSequence;
  const effectInvocationMatches =
    command.effectInvocation === undefined
      ? receipt.effectInvocation === undefined
      : receipt.effectInvocation?.callId === command.effectInvocation.callId &&
        receipt.effectInvocation.toolName === command.effectInvocation.toolName;
  const threadSandboxMatches =
    command.threadSandboxTerminal === undefined
      ? receipt.threadSandbox === undefined
      : receipt.threadSandbox?.schemaVersion === 1 &&
        receipt.threadSandbox.sessionId === command.threadSandboxTerminal.sessionId &&
        receipt.threadSandbox.generation === command.threadSandboxTerminal.generation &&
        (receipt.threadSandbox.outcome === "effect_pending"
          ? receipt.threadSandbox.effectKind === "pause" &&
            receipt.threadSandbox.effectId.trim().length > 0
          : receipt.threadSandbox.nextRunId.trim().length > 0);
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
    workspaceMatches &&
    threadContextMatches &&
    threadSteerMatches &&
    threadSandboxMatches
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
