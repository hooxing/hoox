// 单次 Run 的 Sandbox 懒准备状态机：acquire → cleanup intent → Workspace 物化 → 历史入口。
// 所有失败都以 throw 交还 RunWorker.execute 的统一收敛分支；需要改写终态结果时写入
// failureResult，由收敛分支优先返回。
import { type ExecutionPhaseTimingObserver, measureExecutionPhase } from "@hoox/domain";
import type {
  AgentSessionFactoryPort,
  RecoveryMetricsPort,
  RuntimeMutation,
  RuntimeMutationResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  ThreadSandboxSessionLifecyclePort,
  WorkspaceRevisionVerifierPort,
} from "./ports.js";
import type { ExecutionContext } from "./run-worker-context.js";
import { isApplied } from "./run-worker-fact-matching.js";
import { cleanupOutbox, cleanupUnknownOutbox } from "./run-worker-outbox.js";
import {
  prepareHistoryEntrypoints,
  probeResourceFilesystemDataPlane,
} from "./run-worker-resource-probe.js";
import { reportWorkspaceMaterializeFailure } from "./run-worker-workspace-failures.js";

export type EnsureSandboxReady = Parameters<
  AgentSessionFactoryPort["create"]
>[0]["ensureSandboxReady"];
type EnsureSandboxReadyRequest = Parameters<EnsureSandboxReady>[0];
type ThreadSandboxAcquisition = Awaited<ReturnType<ThreadSandboxSessionLifecyclePort["acquire"]>>;

/** RunWorker 提供的执行期操作；都已绑定当前 ExecutionContext 与取消信号。 */
export interface SandboxPreparationOperations<Result> {
  stopPoint(): Promise<ExecutionContext["stopped"]>;
  applyMutation(
    input: Omit<
      RuntimeMutation,
      | "schemaVersion"
      | "commandDigest"
      | "fence"
      | "expectedAttemptVersion"
      | "expectedProjectionVersion"
    >,
  ): Promise<RuntimeMutationResult>;
  handleMutationFailure(result: RuntimeMutationResult): Promise<Result>;
  bestEffortOrphanCleanup(
    sandbox: SandboxSessionRef,
    reason: Parameters<RecoveryMetricsPort["recordOrphanCleanup"]>[0]["reason"],
  ): Promise<void>;
  recordWorkspaceMaterialization(startedAt: number, outcome: "ready" | "failed"): Promise<void>;
}

export interface SandboxPreparationInput<Result> {
  readonly context: ExecutionContext;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly threadSandboxSessionReuseEnabled: boolean;
  readonly historyFilesystemEnabled: boolean;
  readonly directAttachmentPaths: readonly string[];
  readonly signal: AbortSignal;
  readonly phaseTiming?: ExecutionPhaseTimingObserver;
  readonly sandboxes: SandboxSessionRegistryPort;
  readonly threadSandboxes?: ThreadSandboxSessionLifecyclePort;
  readonly revisions: WorkspaceRevisionVerifierPort;
  readonly operations: SandboxPreparationOperations<Result>;
}

export class RunSandboxPreparation<Result> {
  #sandbox: SandboxSessionRef | undefined;
  #resourceFilesystemMounted = false;
  #preparation: Promise<SandboxSessionRef> | undefined;
  #failureResult: Result | undefined;

  constructor(private readonly input: SandboxPreparationInput<Result>) {}

  /** 当前已取得的 Sandbox；准备中途失败并已退役时回到 undefined。 */
  get current(): SandboxSessionRef | undefined {
    return this.#sandbox;
  }

  /** 准备过程中已收敛出的终态（例如 UNKNOWN 事实未能持久化）。 */
  get failureResult(): Result | undefined {
    return this.#failureResult;
  }

  readonly ensureReady: EnsureSandboxReady = async (request) => {
    const { context } = this.input;
    const preparationTiming = this.#timingFor(request);
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
    if (this.#preparation !== undefined) {
      const prepared = await this.#preparation;
      this.#assertResourceFilesystemMounted();
      return prepared;
    }
    if (this.#sandbox !== undefined) {
      this.#assertResourceFilesystemMounted();
      return this.#sandbox;
    }
    this.#preparation ??= this.#prepare(preparationTiming);
    return await this.#preparation;
  };

  #timingFor(request: EnsureSandboxReadyRequest): ExecutionPhaseTimingObserver | undefined {
    const phaseTiming = this.input.phaseTiming;
    if (phaseTiming === undefined || request.reason !== "tool") return phaseTiming;
    return {
      record: (span) =>
        phaseTiming.record({
          ...span,
          toolCallId: request.call.callId,
          toolName: request.call.toolName,
        }),
    };
  }

  /** /resources 同时承载附件与公开 Skill 市场；任何 Sandbox 工具都必须看到同一虚拟目录。 */
  #assertResourceFilesystemMounted(): void {
    if (!this.#resourceFilesystemMounted) {
      this.input.context.agentFailure = "SANDBOX_FAILED";
      throw new Error("当前 Run 的 Sandbox 无法在创建后追加 ResourceFS mount");
    }
  }

  async #prepare(timing: ExecutionPhaseTimingObserver | undefined): Promise<SandboxSessionRef> {
    const { context, operations } = this.input;
    const preAcquire = await operations.stopPoint();
    if (preAcquire) throw new Error("Sandbox acquire 前运行已停止");

    const requiresMaterialization = this.input.threadSandboxSessionReuseEnabled
      ? await this.#acquireThreadSandbox(timing)
      : await this.#acquireRunSandbox(timing);

    const acquired = this.#sandbox;
    if (acquired === undefined) {
      context.agentFailure = "SANDBOX_FAILED";
      throw new Error("Sandbox acquire 未返回 Session");
    }
    const postAcquire = await operations.stopPoint();
    if (
      postAcquire !== undefined &&
      postAcquire !== "cancelled" &&
      postAcquire !== "timeout" &&
      postAcquire !== "agent_revision_revoked"
    ) {
      await this.#discardAcquired(acquired, postAcquire);
      throw new Error("Sandbox acquire 后运行已停止");
    }

    // acquire 可能发生在模型执行阶段；cleanup intent 是正交生命周期事实，不回退主阶段。
    const intent = await operations.applyMutation({
      idempotencyKey: `${context.attemptId}/sandbox/cleanup-intent`,
      events: [],
      outbox:
        context.threadSandboxLease === undefined
          ? [cleanupOutbox(context, acquired, "pending")]
          : [],
    });
    if (!isApplied(intent)) {
      await this.#discardAcquired(acquired, intent.outcome);
      this.#failureResult = await operations.handleMutationFailure(intent);
      throw new Error("Sandbox cleanup intent 未能持久化");
    }
    // 取消、撤销与超时仍需先固化 cleanup intent，才能由终态收敛路径回收 Sandbox。
    if (postAcquire) throw new Error("Sandbox acquire 后运行已停止");

    const preMaterialize = await operations.stopPoint();
    if (preMaterialize) throw new Error("Workspace 物化前运行已停止");
    await this.#materializeWorkspace(acquired, requiresMaterialization, timing);
    if (this.input.historyFilesystemEnabled) {
      try {
        await measureExecutionPhase(timing, "workspace_history_prepare", () =>
          prepareHistoryEntrypoints(acquired.sandbox, context.scope.threadId, this.input.signal),
        );
      } catch {
        context.agentFailure = "SANDBOX_FAILED";
        throw new Error("历史目录固定入口准备失败");
      }
    }
    const postMaterialize = await operations.stopPoint();
    if (postMaterialize) throw new Error("Workspace 物化后运行已停止");
    return acquired;
  }

  /** Thread 级复用：复用前验证 ResourceFS 数据面，缺失时退役旧 generation 并冷恢复一次。 */
  async #acquireThreadSandbox(timing: ExecutionPhaseTimingObserver | undefined): Promise<boolean> {
    const { context } = this.input;
    const lifecycle = this.input.threadSandboxes;
    if (lifecycle === undefined) throw new Error("Thread Sandbox lifecycle 缺失");
    let acquisition = await this.#threadAcquire(lifecycle, timing);
    if (acquisition.outcome !== "ready") {
      context.agentFailure =
        acquisition.outcome === "unknown" ? "SANDBOX_UNKNOWN" : acquisition.code;
      throw new Error("Thread Sandbox acquire 失败");
    }
    this.#adoptThreadAcquisition(acquisition);
    if (!acquisition.resourceFilesystemMounted) {
      context.agentFailure = "SANDBOX_FAILED";
      throw new Error("Thread Sandbox ResourceFS 能力事实缺失");
    }
    if (acquisition.source === "cold_created") return acquisition.requiresMaterialization;

    const probe = await this.#probeResourceFilesystem(acquisition.session, timing);
    if (probe === "failed") {
      context.agentFailure = "SANDBOX_FAILED";
      throw new Error("复用 Thread Sandbox 的 ResourceFS 数据面验证失败");
    }
    if (probe !== "missing") return acquisition.requiresMaterialization;

    const stale = acquisition;
    delete context.threadSandboxLease;
    const retired = await lifecycle
      .terminate({
        scope: context.scope,
        attemptId: context.attemptId,
        session: stale.session,
        lease: stale.lease,
        reason: "resource_filesystem_data_plane_missing",
      })
      .catch(() => "unknown" as const);
    this.#sandbox = undefined;
    this.#resourceFilesystemMounted = false;
    if (retired !== "settled") {
      context.agentFailure = retired === "unknown" ? "SANDBOX_UNKNOWN" : "SANDBOX_FAILED";
      throw new Error("失效 Thread Sandbox generation 退役失败");
    }
    acquisition = await this.#threadAcquire(lifecycle, timing);
    if (acquisition.outcome !== "ready") {
      context.agentFailure =
        acquisition.outcome === "unknown" ? "SANDBOX_UNKNOWN" : acquisition.code;
      throw new Error("Thread Sandbox 冷恢复 acquire 失败");
    }
    this.#adoptThreadAcquisition(acquisition);
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
    const recoveredProbe = await this.#probeResourceFilesystem(acquisition.session, timing);
    if (recoveredProbe !== "ready") {
      context.agentFailure = "SANDBOX_FAILED";
      throw new Error("冷恢复 Thread Sandbox 的 ResourceFS 数据面仍不可用");
    }
    return acquisition.requiresMaterialization;
  }

  #threadAcquire(
    lifecycle: ThreadSandboxSessionLifecyclePort,
    timing: ExecutionPhaseTimingObserver | undefined,
  ): Promise<ThreadSandboxAcquisition> {
    const { context } = this.input;
    return measureExecutionPhase(timing, "sandbox_acquire", () =>
      lifecycle.acquire({
        scope: context.scope,
        attemptId: context.attemptId,
        owner: this.input.workerId,
        leaseDurationMs: this.input.leaseDurationMs,
        signal: this.input.signal,
        requiresResourceFilesystem: true,
        ...(timing === undefined ? {} : { phaseTiming: timing }),
      }),
    );
  }

  #adoptThreadAcquisition(
    acquisition: Extract<ThreadSandboxAcquisition, { readonly outcome: "ready" }>,
  ): void {
    this.#sandbox = acquisition.session;
    this.#resourceFilesystemMounted = acquisition.resourceFilesystemMounted;
    this.input.context.threadSandboxLease = acquisition.lease;
  }

  async #probeResourceFilesystem(
    session: SandboxSessionRef,
    timing: ExecutionPhaseTimingObserver | undefined,
  ): Promise<"ready" | "missing" | "failed"> {
    const probe = await measureExecutionPhase(timing, "sandbox_resource_probe", () =>
      probeResourceFilesystemDataPlane(session.sandbox, {
        threadId: this.input.context.scope.threadId,
        historyFilesystemEnabled: this.input.historyFilesystemEnabled,
        directAttachmentPaths: this.input.directAttachmentPaths,
        signal: this.input.signal,
      }),
    );
    return probe.outcome;
  }

  /** Run 级一次性 Sandbox：UNKNOWN 必须先固化清理事实，才能把失败交给收敛分支。 */
  async #acquireRunSandbox(timing: ExecutionPhaseTimingObserver | undefined): Promise<boolean> {
    const { context, operations } = this.input;
    let acquisition: Awaited<ReturnType<SandboxSessionRegistryPort["acquire"]>>;
    try {
      acquisition = await measureExecutionPhase(timing, "sandbox_acquire", () =>
        this.input.sandboxes.acquire({
          scope: context.scope,
          signal: this.input.signal,
          requiresResourceFilesystem: true,
          ...(timing === undefined ? {} : { phaseTiming: timing }),
        }),
      );
    } catch {
      context.agentFailure = "SANDBOX_FAILED";
      throw new Error("Sandbox acquire 失败");
    }
    if (acquisition.outcome === "unknown") {
      const unknownFact = await operations.applyMutation({
        idempotencyKey: `${context.attemptId}/sandbox/acquire-unknown/${acquisition.event.requestId}`,
        events: [],
        outbox: [cleanupUnknownOutbox(context, acquisition.event)],
      });
      if (!isApplied(unknownFact)) {
        this.#failureResult = await operations.handleMutationFailure(unknownFact);
        throw new Error("Sandbox acquire UNKNOWN 事实未能持久化");
      }
      context.agentFailure = "SANDBOX_UNKNOWN";
      throw new Error("Sandbox acquire 结果未知");
    }
    if (acquisition.outcome === "failed") {
      context.agentFailure = acquisition.code;
      throw new Error("Sandbox acquire 失败");
    }
    this.#sandbox = acquisition.session;
    this.#resourceFilesystemMounted = true;
    return true;
  }

  /** acquire 后检查点失败：Run 级 Sandbox 走孤儿清理，Thread 级 Sandbox 终止当前 lease。 */
  async #discardAcquired(
    acquired: SandboxSessionRef,
    reason: Parameters<RecoveryMetricsPort["recordOrphanCleanup"]>[0]["reason"],
  ): Promise<void> {
    const { context } = this.input;
    if (context.threadSandboxLease === undefined) {
      await this.input.operations.bestEffortOrphanCleanup(acquired, reason);
    } else {
      await this.input.threadSandboxes
        ?.terminate({
          scope: context.scope,
          attemptId: context.attemptId,
          session: acquired,
          lease: context.threadSandboxLease,
          reason: "checkpoint_failed",
        })
        .catch(() => "unknown");
    }
    this.#sandbox = undefined;
    delete context.threadSandboxLease;
  }

  async #materializeWorkspace(
    acquired: SandboxSessionRef,
    requiresMaterialization: boolean,
    timing: ExecutionPhaseTimingObserver | undefined,
  ): Promise<void> {
    const { context, operations } = this.input;
    const materializeStartedAt = Date.now();
    try {
      if (requiresMaterialization) {
        await measureExecutionPhase(timing, "workspace_materialize", () =>
          this.input.revisions.materialize({
            scope: context.scope,
            attemptId: context.attemptId,
            ...(context.currentRevisionId === undefined
              ? {}
              : { expectedCurrentRevisionId: context.currentRevisionId }),
            sandbox: acquired,
            // Workspace journal 的 operationKey 是受限协议字段；不得复用含 `/` 的路径样式键。
            operationKey: `${context.attemptId}:workspace:materialize`,
            signal: this.input.signal,
            ...(timing === undefined ? {} : { phaseTiming: timing }),
          }),
        );
      }
      if (context.threadSandboxLease !== undefined && requiresMaterialization) {
        const attested = await this.input.threadSandboxes?.attestMaterialized({
          scope: context.scope,
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
        await operations.recordWorkspaceMaterialization(materializeStartedAt, "ready");
      }
    } catch (error) {
      if (requiresMaterialization) {
        await operations.recordWorkspaceMaterialization(materializeStartedAt, "failed");
      }
      reportWorkspaceMaterializeFailure(error);
      context.agentFailure = "WORKSPACE_CONFLICT";
      throw new Error("Workspace 物化失败");
    }
  }
}
