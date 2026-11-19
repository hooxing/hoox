import { runId, tenantId, threadId } from "@hoox/domain";
import type {
  ThreadSandboxLifecycleClaim,
  ThreadSandboxLifecycleResolution,
} from "@hoox/persistence/maintenance";
import type { PgThreadContinuityMetrics } from "@hoox/persistence/thread";
import {
  type SandboxGateway,
  type SandboxProviderRegistry,
  SandboxRuntimeError,
} from "@hoox/sandbox";
import type { ManagedSandboxGatewayResolver } from "./managed-sandbox-gateway.js";

export interface ThreadSandboxLifecycleStore {
  claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<ThreadSandboxLifecycleClaim | undefined>;
  markRemoteStarted(claim: ThreadSandboxLifecycleClaim): Promise<boolean>;
  resolve(
    claim: ThreadSandboxLifecycleClaim,
    resolution: ThreadSandboxLifecycleResolution,
  ): Promise<boolean>;
}

export class ThreadSandboxLifecycleRouterResolver {
  constructor(
    private readonly providers: Pick<SandboxProviderRegistry, "require">,
    private readonly timeoutMs: number,
    private readonly managed?: Pick<ManagedSandboxGatewayResolver, "session">,
  ) {}

  async execute(claim: ThreadSandboxLifecycleClaim): Promise<ThreadSandboxLifecycleResolution> {
    try {
      const { gateway, timeoutMs } =
        this.managed === undefined
          ? { gateway: this.providers.require(claim.providerKey), timeoutMs: this.timeoutMs }
          : await this.managed.session(claim);
      const sandbox = await gateway.connect(claim.providerSandboxId, {
        timeoutMs,
      });
      if (claim.effectKind === "pause") {
        await sandbox.pause({ timeoutMs });
        return "paused";
      }
      await sandbox.kill({ timeoutMs, ignoreNotFound: true });
      return "terminated";
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "NOT_FOUND") {
        return "terminated";
      }
      return "unknown";
    }
  }

  async reconcile(claim: ThreadSandboxLifecycleClaim): Promise<ThreadSandboxLifecycleResolution> {
    try {
      const { gateway, timeoutMs } =
        this.managed === undefined
          ? { gateway: this.providers.require(claim.providerKey), timeoutMs: this.timeoutMs }
          : await this.managed.session(claim);
      const state = await gateway.inspect(claim.providerSandboxId, {
        timeoutMs,
      });
      if (state === "not_found") return "terminated";
      if (claim.effectKind === "pause") {
        return state === "paused" ? "paused" : state === "running" ? "retry_pause" : "unknown";
      }
      if (claim.effectKind === "terminate") {
        return state === "running" || state === "paused" ? "retry_terminate" : "unknown";
      }
      // resume UNKNOWN 后不把无 lease 的环境重新交给 Run；明确存在时转为 terminate intent。
      return state === "running" || state === "paused" ? "retry_terminate" : "unknown";
    } catch {
      return "unknown";
    }
  }
}

/** 兼容单 Cube 装配；生产多 Provider 路径使用 ThreadSandboxLifecycleRouterResolver。 */
export class CubeThreadSandboxLifecycleResolver extends ThreadSandboxLifecycleRouterResolver {
  constructor(gateway: SandboxGateway, timeoutMs: number) {
    super(
      {
        require(providerKey) {
          if (providerKey !== "cube")
            throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox Provider 未启用");
          return gateway as ReturnType<SandboxProviderRegistry["require"]>;
        },
      },
      timeoutMs,
    );
  }
}

export class ThreadSandboxLifecycleConsumer {
  private stopping = false;

  constructor(
    private readonly store: ThreadSandboxLifecycleStore,
    private readonly resolver: Pick<ThreadSandboxLifecycleRouterResolver, "execute" | "reconcile">,
    private readonly workerId: string,
    private readonly leaseMs: number,
    private readonly metrics?: Pick<PgThreadContinuityMetrics, "record">,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600_000) {
      throw new TypeError("Thread Sandbox lifecycle lease 无效");
    }
  }

  async drainTenant(tenantId: string): Promise<number> {
    if (this.stopping) return 0;
    const claim = await this.store.claimNext({
      tenantId,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (claim === undefined || this.stopping) return 0;
    if (claim.mode === "execute" && !(await this.store.markRemoteStarted(claim))) return 0;
    const resolution =
      claim.mode === "execute"
        ? await this.resolver.execute(claim)
        : await this.resolver.reconcile(claim);
    const resolved = await this.store.resolve(claim, resolution).catch(() => false);
    if (resolved) await this.recordMetrics(claim, resolution).catch(() => undefined);
    return resolved ? 1 : 0;
  }

  private async recordMetrics(
    claim: ThreadSandboxLifecycleClaim,
    resolution: ThreadSandboxLifecycleResolution,
  ): Promise<void> {
    if (this.metrics === undefined) return;
    const common = {
      tenantId: tenantId(claim.tenantId),
      threadId: threadId(claim.threadId),
      ...(claim.runId === undefined ? {} : { runId: runId(claim.runId) }),
      outcome: resolution,
    } as const;
    if (claim.effectKind === "resume") {
      await this.metrics.record({
        ...common,
        observationId: `${claim.effectId}:resume-total`,
        metricName: "sandbox_resume_total",
        value: 1,
        unit: "count",
        path: "resume",
      });
    }
    if (resolution === "unknown") {
      await this.metrics.record({
        ...common,
        observationId: `${claim.effectId}:unknown-total`,
        metricName: "sandbox_unknown_total",
        value: 1,
        unit: "count",
        reason: claim.effectKind,
      });
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
  }
}

export class ThreadSandboxLifecyclePollingLoop {
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly consumer: ThreadSandboxLifecycleConsumer,
    private readonly tenantId: string,
    private readonly intervalMs: number,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 600_000) {
      throw new TypeError("Thread Sandbox lifecycle 轮询间隔无效");
    }
  }

  start(): void {
    if (this.timer !== undefined || this.stopping) return;
    const tick = () => {
      if (this.stopping || this.inFlight !== undefined) return;
      this.inFlight = this.consumer
        .drainTenant(this.tenantId)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.inFlight = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.consumer.close();
    await this.inFlight;
  }
}
