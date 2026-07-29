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
  WorkspaceRevisionVerifierPort,
} from "@cube-runtime/run-contracts";
import {
  type CubeGatewayOptions,
  CubeSandboxGateway,
  SandboxRuntimeError,
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

/** 生产默认禁止成功关闭会丢失文件的 Sandbox；revision 发布接通前，非空 Workspace 失败关闭。 */
export class FailClosedWorkspaceRevisionVerifier implements WorkspaceRevisionVerifierPort {
  async materialize(): Promise<void> {
    // 兼容旧部署的安全下限：没有 manifest runtime 时仅允许一个空 Sandbox 进入模型。
  }

  async verify(input: Parameters<WorkspaceRevisionVerifierPort["verify"]>[0]): Promise<undefined> {
    const result = await input.sandbox.sandbox.command(
      `if [ ! -d /workspace ]; then exit 72; fi
if find /workspace -mindepth 1 -print -quit | grep -q .; then exit 73; fi`,
    );
    if (result.exitCode !== 0) {
      throw new Error("WORKSPACE_REVISION_PUBLICATION_REQUIRED");
    }
    return undefined;
  }
}

/** CubeSandbox 的生产 Session registry；PG 包装器会在返回 Worker 前提交 registry 事实。 */
export class CubeSandboxSessionRegistry
  implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort
{
  readonly gateway: CubeSandboxGateway;
  private uncertainCreate: UncertainLifecycleEvent | undefined;
  /** 只有本实例真正 create/connect 并返回的同一对象才能派生 Workspace capability。 */
  private readonly workspaceCapabilities = new WeakSet<object>();

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
      this.workspaceCapabilities.add(session);
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

  workspaceCapability(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
  }): TrustedSandboxSessionCapability {
    if (
      !this.workspaceCapabilities.has(input.session) ||
      input.session.sandbox.id !== input.session.providerSandboxId
    ) {
      throw new Error("未授予 Sandbox Workspace capability");
    }
    const binding = Object.freeze({
      sessionId: input.session.providerSandboxId,
      generation: 1,
      scope: Object.freeze({
        tenantId: input.scope.tenantId,
        threadId: input.scope.threadId,
        workspaceId: input.scope.workspaceId,
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
