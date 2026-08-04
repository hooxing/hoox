import { randomUUID } from "node:crypto";
import type { PgClaimedRunDispatch, PgRunDispatchOutbox } from "@cube-runtime/persistence";
import type {
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  ExecutionScope,
  HeartbeatTask,
  OrphanSandboxCleanupPort,
  SandboxAcquireResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  ScheduledTask,
  ThreadSandboxProviderPort,
  WorkspaceRevisionVerifierPort,
} from "@cube-runtime/run-contracts";
import {
  type CubeGatewayOptions,
  CubeSandboxGateway,
  SandboxRuntimeError,
  type TenantResourceVolumePort,
  type TrustedSandboxSessionCapability,
  type UncertainLifecycleEvent,
} from "@cube-runtime/sandbox";
import type { RunWorker, RunWorkerResult } from "./run-worker.js";

export class SystemWorkerClock implements ClockPort {
  schedule(delayMs: number, callback: () => void): ScheduledTask {
    const timer = setTimeout(callback, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }

  startHeartbeat(intervalMs: number, callback: () => Promise<void>): HeartbeatTask {
    let stopped = false;
    let active = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped) return;
      active = active.then(callback);
    }, intervalMs);
    return Object.freeze({
      async stop() {
        stopped = true;
        clearInterval(timer);
        await active;
      },
    });
  }
}

const NEVER_CANCELLED_SIGNAL = new AbortController().signal;

/** 业务取消由 PostgreSQL Run 状态提供；进程信号绝不能伪装成用户取消。 */
export class DatabaseRunCancellation implements CancellationPort {
  signalFor(_scope: ExecutionScope): AbortSignal {
    return NEVER_CANCELLED_SIGNAL;
  }
}

export class ProcessShutdown {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  request(): void {
    this.controller.abort(new Error("Agent Worker 正在关闭"));
  }
}

/**
 * 发布的候选引用尚未能与 RuntimeMutation 原子交接时，生产 Worker 必须保持 fail-closed。
 * 这一检查放在模型 Session 创建之前：模板残留、上次执行残留或 /workspace 缺失都不能被模型
 * 读取，更不能在后续 verify 中被误当成用户变更发布。
 */
export class FailClosedWorkspaceRevisionVerifier implements WorkspaceRevisionVerifierPort {
  async materialize(
    input: Parameters<WorkspaceRevisionVerifierPort["materialize"]>[0],
  ): Promise<void> {
    // 空目录 verifier 不具备将 committed head 物化为 Sandbox 的能力。带 checkpoint 仍继续执行
    // 会让模型在空目录中工作并把文件静默丢失，因此必须在模型前拒绝。
    if (input.expectedCurrentRevisionId !== undefined) {
      throw new Error("WORKSPACE_REVISION_MATERIALIZATION_REQUIRED");
    }
    await assertEmptyWorkspaceRoot(input.sandbox);
  }

  async verify(input: Parameters<WorkspaceRevisionVerifierPort["verify"]>[0]): Promise<undefined> {
    // Session 内模型/工具可能写入文件；模型结束后的再次检查保证不会把未发布内容成功关闭。
    await assertEmptyWorkspaceRoot(input.sandbox);
    return undefined;
  }
}

async function assertEmptyWorkspaceRoot(session: SandboxSessionRef): Promise<void> {
  const result = await session.sandbox.command(
    `if [ ! -d /workspace ] || [ -L /workspace ]; then exit 72; fi
if ! workspace_entry=$(find -P /workspace -mindepth 1 -print -quit); then exit 74; fi
if [ -n "$workspace_entry" ]; then exit 73; fi`,
  );
  if (result.exitCode !== 0) throw new Error("WORKSPACE_REVISION_PUBLICATION_REQUIRED");
}

/** CubeSandbox 的生产 Session registry；PG 包装器会在返回 Worker 前提交 registry 事实。 */
export class CubeSandboxSessionRegistry
  implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort, ThreadSandboxProviderPort
{
  readonly gateway: CubeSandboxGateway;
  private uncertainCreate: UncertainLifecycleEvent | undefined;
  /**
   * Workspace capability 不只绑定对象身份：必须绑定 acquire 时已经由 Run fence 审核过的完整
   * ExecutionScope。否则攻击者可把同一 SandboxSessionRef 重放到另一 tenant/thread/workspace。
   */
  private readonly workspaceBindings = new WeakMap<object, WorkspaceCapabilityBinding>();

  constructor(
    options: CubeGatewayOptions,
    private readonly templateId: string,
    private readonly ttlSeconds = 120,
    private readonly lifecycleTimeoutMs = 90_000,
    private readonly resourceVolume?: TenantResourceVolumePort,
  ) {
    if (
      !Number.isSafeInteger(lifecycleTimeoutMs) ||
      lifecycleTimeoutMs < 1 ||
      lifecycleTimeoutMs > 600_000
    ) {
      throw new TypeError("Sandbox lifecycle timeout 无效");
    }
    this.gateway = new CubeSandboxGateway({
      ...options,
      maxCreateTtlSeconds: ttlSeconds,
      timeout: ttlSeconds,
      onUncertainLifecycle: (event) => {
        this.uncertainCreate = event;
      },
    });
  }

  async probe(): Promise<void> {
    await Promise.all([this.gateway.probe(), this.resourceVolume?.probe()]);
  }

  async acquire(input: {
    readonly scope: ExecutionScope;
    readonly signal: AbortSignal;
    readonly requiresResourceFilesystem: boolean;
  }): Promise<SandboxAcquireResult> {
    this.uncertainCreate = undefined;
    try {
      const volume = input.requiresResourceFilesystem
        ? await this.resourceVolume?.ensure({
            tenantId: input.scope.tenantId,
            signal: input.signal,
          })
        : undefined;
      const sandbox = await this.gateway.create(
        {
          templateId: this.templateId,
          ttlSeconds: this.ttlSeconds,
          ...(volume === undefined ? {} : { volumeMounts: [volume] }),
        },
        { signal: input.signal, timeoutMs: this.lifecycleTimeoutMs },
      );
      const session = this.bindSession(input.scope, `registry-${randomUUID()}`, sandbox, "created");
      return { outcome: "ready", session };
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "UNKNOWN") {
        return {
          outcome: "unknown",
          event:
            this.uncertainCreate ??
            fallbackUncertainEvent(`create-${randomUUID()}`, this.ttlSeconds),
        };
      }
      return { outcome: "failed", code: "SANDBOX_FAILED" };
    }
  }

  async create(
    input: Parameters<ThreadSandboxProviderPort["create"]>[0],
  ): Promise<SandboxAcquireResult> {
    this.uncertainCreate = undefined;
    try {
      const volume = await this.resourceVolume?.ensure({
        tenantId: input.scope.tenantId,
        signal: input.signal,
      });
      const sandbox = await this.gateway.create(
        {
          templateId: this.templateId,
          ttlSeconds: this.ttlSeconds,
          lifecycle: { onTimeout: "pause", autoResume: true },
          ...(volume === undefined ? {} : { volumeMounts: [volume] }),
        },
        { signal: input.signal, timeoutMs: this.lifecycleTimeoutMs },
      );
      return {
        outcome: "ready",
        session: this.bindSession(input.scope, input.registryId, sandbox, "created"),
      };
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "UNKNOWN") {
        return {
          outcome: "unknown",
          event:
            this.uncertainCreate ??
            fallbackUncertainEvent(`create-${randomUUID()}`, this.ttlSeconds),
        };
      }
      return { outcome: "failed", code: "SANDBOX_FAILED" };
    }
  }

  async connect(
    input: Parameters<ThreadSandboxProviderPort["connect"]>[0],
  ): Promise<SandboxAcquireResult | { readonly outcome: "not_found" }> {
    try {
      const sandbox = await this.gateway.connect(input.providerSandboxId, {
        signal: input.signal,
        timeoutMs: this.lifecycleTimeoutMs,
      });
      return {
        outcome: "ready",
        session: this.bindSession(input.scope, input.registryId, sandbox, "connected"),
      };
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "NOT_FOUND") {
        return { outcome: "not_found" };
      }
      return error instanceof SandboxRuntimeError && error.code === "TIMEOUT"
        ? { outcome: "unknown", event: fallbackUncertainEvent(input.registryId, this.ttlSeconds) }
        : { outcome: "failed", code: "SANDBOX_FAILED" };
    }
  }

  async settle(
    input: Parameters<SandboxSessionRegistryPort["settle"]>[0],
  ): Promise<SandboxSettlementResult> {
    try {
      if (input.disposition === "pause") {
        await input.session.sandbox.pause({ timeoutMs: this.lifecycleTimeoutMs });
      } else {
        await input.session.sandbox.kill({
          timeoutMs: this.lifecycleTimeoutMs,
          ignoreNotFound: true,
        });
      }
      return { outcome: "settled" };
    } catch {
      return {
        outcome: "unknown",
        event: fallbackUncertainEvent(
          input.cleanupIntentId,
          this.ttlSeconds,
          input.session.providerSandboxId,
        ),
      };
    }
  }

  closeOrphan(
    input: Parameters<OrphanSandboxCleanupPort["closeOrphan"]>[0],
  ): Promise<SandboxSettlementResult> {
    return this.settle({
      ...input,
      cleanupIntentId: `registry:${input.session.registryId}:orphan-cleanup`,
      disposition: "close",
    });
  }

  private bindSession(
    scope: ExecutionScope,
    registryId: string,
    sandbox: SandboxSessionRef["sandbox"],
    mode: SandboxSessionRef["mode"],
  ): SandboxSessionRef {
    const session: SandboxSessionRef = Object.freeze({
      registryId,
      providerSandboxId: sandbox.id,
      mode,
      sandbox,
    });
    this.workspaceBindings.set(
      session,
      Object.freeze({
        registryId,
        providerSandboxId: sandbox.id,
        scope: freezeExecutionScope(scope),
      }),
    );
    return session;
  }

  workspaceCapability(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
  }): TrustedSandboxSessionCapability {
    const recorded = this.workspaceBindings.get(input.session);
    if (
      recorded === undefined ||
      recorded.registryId !== input.session.registryId ||
      recorded.providerSandboxId !== input.session.providerSandboxId ||
      input.session.sandbox.id !== input.session.providerSandboxId ||
      !sameExecutionScope(recorded.scope, input.scope)
    ) {
      throw new Error("未授予 Sandbox Workspace capability");
    }
    const binding = Object.freeze({
      sessionId: recorded.providerSandboxId,
      generation: 1,
      scope: Object.freeze({
        tenantId: recorded.scope.tenantId,
        threadId: recorded.scope.threadId,
        workspaceId: recorded.scope.workspaceId,
      }),
    });
    return Object.freeze({
      async current() {
        // 不能回读调用方可变对象；上面的 capability 已在 registry 私有 WeakSet 中完成对象身份校验。
        return binding;
      },
    });
  }
}

interface WorkspaceCapabilityBinding {
  readonly registryId: string;
  readonly providerSandboxId: string;
  readonly scope: ExecutionScope;
}

function freezeExecutionScope(scope: ExecutionScope): ExecutionScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    runId: scope.runId,
    rootRunId: scope.rootRunId,
    workspaceId: scope.workspaceId,
    ...(scope.baseRevisionId === undefined ? {} : { baseRevisionId: scope.baseRevisionId }),
  });
}

function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
}

function fallbackUncertainEvent(
  requestId: string,
  actualTtlSeconds: number,
  sandboxId?: string,
): UncertainLifecycleEvent {
  return {
    kind: "sandbox_create_outcome_unknown",
    stage: sandboxId === undefined ? "create_response" : "cleanup_after_create",
    requestId,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    actualTtlSeconds,
    occurredAt: new Date().toISOString(),
  };
}

/** 未启用 Artifact Router 时不存在 required declaration，完成门确定通过。 */
export class NoDeclaredArtifactCompletionGate implements ArtifactPublicationPort {
  async assertReadyForCompletion(): Promise<void> {}
}

interface DispatchQueue {
  claim(input: {
    readonly tenantId: string;
    readonly dispatcherId: string;
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }): ReturnType<PgRunDispatchOutbox["claim"]>;
  acknowledge(input: {
    readonly claim: PgClaimedRunDispatch;
    readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
    readonly retryAfterMilliseconds?: number;
  }): Promise<void>;
}

/** 单租户生产消费闭环：领取 durable dispatch，事务外执行 RunWorker，再以 dispatch fence ack。 */
export class AgentWorkerPollingLoop {
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly queue: DispatchQueue,
    private readonly worker: Pick<RunWorker, "execute">,
    private readonly options: {
      readonly tenantId: string;
      readonly workerId: string;
      readonly pollIntervalMs: number;
      readonly dispatchLeaseMs: number;
      /** 周期性收敛已具 durable anchor 的维护任务；失败不阻塞 dispatch，下一 tick 重试。 */
      readonly maintenance?: () => Promise<unknown>;
    },
  ) {}

  start(): void {
    if (this.closed || this.timer !== undefined)
      throw new Error("Agent Worker polling loop 状态无效");
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.inFlight;
  }

  stopAccepting(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  drain(): Promise<void> {
    return this.inFlight;
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => this.schedule(this.options.pollIntervalMs));
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.options.maintenance?.();
    } catch {
      // 维护任务必须保持幂等 durable anchor；当前 tick 失败后由下一 tick 重试。
    }
    let claims: readonly PgClaimedRunDispatch[];
    try {
      claims = await this.queue.claim({
        tenantId: this.options.tenantId,
        dispatcherId: this.options.workerId,
        limit: 1,
        leaseMilliseconds: this.options.dispatchLeaseMs,
      });
    } catch {
      return;
    }
    for (const claim of claims) {
      if (this.closed) {
        try {
          await this.queue.acknowledge({
            claim,
            outcome: "defer",
            // 与 PgRunDispatchOutbox 的最小重试约束一致，确保 ack 真正释放 dispatch claim。
            retryAfterMilliseconds: 1_000,
          });
        } catch {
          // claim lease 会过期；关闭后的 claim 绝不交给 RunWorker 执行。
        }
        continue;
      }
      const result = await this.executeSafely(claim.scope);
      try {
        await this.queue.acknowledge({ claim, ...acknowledgement(result) });
      } catch {
        // claim lease 会过期并由后续 tick 重领；RunWorker 的 Attempt claim 保证执行幂等。
      }
    }
  }

  private async executeSafely(scope: PgClaimedRunDispatch["scope"]): Promise<RunWorkerResult> {
    try {
      return await this.worker.execute(scope as ExecutionScope);
    } catch {
      return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
    }
  }
}

function acknowledgement(result: RunWorkerResult): {
  readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
  readonly retryAfterMilliseconds?: number;
} {
  if (
    result.outcome === "succeeded" ||
    result.outcome === "failed" ||
    result.outcome === "cancelled"
  ) {
    return { outcome: "terminal" };
  }
  if (result.outcome === "waiting") return { outcome: "waiting" };
  if (result.outcome === "ignored") {
    if (result.reason === "terminal") return { outcome: "terminal" };
    if (result.reason === "waiting_for_answer") return { outcome: "waiting" };
    return { outcome: "defer", retryAfterMilliseconds: 5_000 };
  }
  if (result.outcome === "recovery_required") return { outcome: "dispatched" };
  return { outcome: "defer", retryAfterMilliseconds: 5_000 };
}
