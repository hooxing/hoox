import { randomUUID } from "node:crypto";
import type {
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  ExecutionScope,
  HeartbeatTask,
  OrphanSandboxCleanupPort,
  RecoveryMetricsPort,
  SandboxAcquireResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  ScheduledTask,
  WorkspaceRevisionVerifierPort,
} from "@cube-runtime/run-contracts";
import {
  CubeSandboxGateway,
  type CubeGatewayOptions,
  SandboxRuntimeError,
  type UncertainLifecycleEvent,
} from "@cube-runtime/sandbox";
import type { PgClaimedRunDispatch, PgRunDispatchOutbox } from "@cube-runtime/persistence";
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

export class ProcessCancellation implements CancellationPort {
  private readonly controller = new AbortController();

  signalFor(_scope: ExecutionScope): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.controller.abort(new Error("Agent Worker 正在关闭"));
  }
}

/** CubeSandbox 的生产 Session registry；PG 包装器会在返回 Worker 前提交 registry 事实。 */
export class CubeSandboxSessionRegistry
  implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort
{
  readonly gateway: CubeSandboxGateway;
  private uncertainCreate: UncertainLifecycleEvent | undefined;

  constructor(
    options: CubeGatewayOptions,
    private readonly templateId: string,
    private readonly ttlSeconds = 120,
  ) {
    this.gateway = new CubeSandboxGateway({
      ...options,
      maxCreateTtlSeconds: ttlSeconds,
      timeout: ttlSeconds,
      onUncertainLifecycle: (event) => {
        this.uncertainCreate = event;
      },
    });
  }

  probe(): Promise<void> {
    return this.gateway.probe();
  }

  async acquire(input: {
    readonly scope: ExecutionScope;
    readonly signal: AbortSignal;
  }): Promise<SandboxAcquireResult> {
    this.uncertainCreate = undefined;
    try {
      const sandbox = await this.gateway.create(
        { templateId: this.templateId, ttlSeconds: this.ttlSeconds },
        { signal: input.signal },
      );
      const session: SandboxSessionRef = Object.freeze({
        registryId: `registry-${randomUUID()}`,
        providerSandboxId: sandbox.id,
        mode: "created",
        sandbox,
      });
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

  async settle(
    input: Parameters<SandboxSessionRegistryPort["settle"]>[0],
  ): Promise<SandboxSettlementResult> {
    try {
      if (input.disposition === "pause") await input.session.sandbox.pause();
      else await input.session.sandbox.kill({ ignoreNotFound: true });
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

/** 当前生产纵向不发布 Workspace revision；Sandbox 是短生命周期执行区。 */
export class EphemeralWorkspaceRevisionVerifier implements WorkspaceRevisionVerifierPort {
  async verify(): Promise<undefined> {
    return undefined;
  }
}

/** 未启用 Artifact Router 时不存在 required declaration，完成门确定通过。 */
export class NoDeclaredArtifactCompletionGate implements ArtifactPublicationPort {
  async assertReadyForCompletion(): Promise<void> {}
}

export class NoopRecoveryMetrics implements RecoveryMetricsPort {
  async recordOrphanCleanup(): Promise<void> {}
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
    },
  ) {}

  start(): void {
    if (this.closed || this.timer !== undefined)
      throw new Error("Agent Worker polling loop 状态无效");
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => this.schedule(this.options.pollIntervalMs));
    }, delay);
  }

  private async tick(): Promise<void> {
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
