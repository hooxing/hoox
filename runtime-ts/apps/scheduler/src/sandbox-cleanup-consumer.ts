import type { CleanupClaim } from "@hoox/persistence";
import {
  type SandboxGateway,
  type SandboxProviderRegistry,
  SandboxRuntimeError,
} from "@hoox/sandbox";

export interface SandboxCleanupResolver {
  settle(
    input: Pick<CleanupClaim, "registryId" | "providerKey" | "providerSandboxId" | "disposition">,
  ): Promise<"settled" | "unknown">;
}

/** 消费器只依赖原子领取/栅栏协议，便于完整模拟每个崩溃窗口而不伪造 PostgreSQL SQL。 */
export interface SandboxCleanupStore {
  claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<CleanupClaim | undefined>;
  markRemoteStarted(claim: CleanupClaim): Promise<boolean>;
  complete(claim: CleanupClaim): Promise<boolean>;
  unknown(claim: CleanupClaim): Promise<boolean>;
}

/**
 * 这里只通过持久化 providerKey + providerSandboxId 重新连接，不保存或复用 Worker 的内存 session。
 * Provider 未启用时 registry.require 失败并保持 unknown，禁止静默回退到默认 Provider。
 */
export class SandboxCleanupRouterResolver implements SandboxCleanupResolver {
  constructor(
    private readonly providers: Pick<SandboxProviderRegistry, "require">,
    private readonly timeoutMs = 90_000,
  ) {}

  async settle(
    input: Pick<CleanupClaim, "registryId" | "providerKey" | "providerSandboxId" | "disposition">,
  ): Promise<"settled" | "unknown"> {
    try {
      const gateway = this.providers.require(input.providerKey);
      const sandbox = await gateway.connect(input.providerSandboxId, {
        timeoutMs: this.timeoutMs,
      });
      if (input.disposition === "pause") await sandbox.pause({ timeoutMs: this.timeoutMs });
      else await sandbox.kill({ timeoutMs: this.timeoutMs, ignoreNotFound: true });
      return "settled";
    } catch (error) {
      // close 的“不存在”意味着目标已不再占用资源；pause 不存在无法推断为已暂停。
      if (
        input.disposition === "close" &&
        error instanceof SandboxRuntimeError &&
        error.code === "NOT_FOUND"
      )
        return "settled";
      return "unknown";
    }
  }
}

/** 兼容单 Cube 装配；生产多 Provider 路径使用 SandboxCleanupRouterResolver。 */
export class CubeSandboxCleanupResolver extends SandboxCleanupRouterResolver {
  constructor(gateway: SandboxGateway, timeoutMs = 90_000) {
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

/** 每个实例独占轮询对象；不得与 dispatch 或其他 Scheduler 工作共用可变单例。 */
export class SandboxCleanupConsumer {
  private stopping = false;
  constructor(
    private readonly store: SandboxCleanupStore,
    private readonly resolver: SandboxCleanupResolver,
    private readonly workerId: string,
    private readonly leaseMs = 210_000,
  ) {
    // connect 和 pause/kill 各自都可能等待 90 秒；以 210 秒总 lease 留出 30 秒状态写回余量。
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 210_000 || leaseMs > 600_000)
      throw new TypeError("cleanup lease 必须覆盖远端操作和安全余量");
  }

  /** 一次只领取一条，调用方以其自身生命周期调度下一次，避免关闭后又开始新的远端调用。 */
  async drainTenant(tenantId: string): Promise<number> {
    if (this.stopping) return 0;
    const claim = await this.store.claimNext({
      tenantId,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (claim === undefined || this.stopping) return 0;
    // 这条写入是不可逆远端边界；之后任意崩溃都只能收敛 unknown，禁止重复 settle。
    if (!(await this.store.markRemoteStarted(claim))) return 0;
    try {
      const settled = await this.resolver.settle(claim);
      // 返回值代表已持久化完成，而不是仅尝试过远端调用；状态写回 CAS 失败不能记为成功。
      if (settled === "settled") return (await this.store.complete(claim)) ? 1 : 0;
      return (await this.store.unknown(claim)) ? 1 : 0;
    } catch {
      // Store 的异常不能触发第二次远端调用；下次 recovery 看到 started 会收敛 unknown。
      return (await this.store.unknown(claim).catch(() => false)) ? 1 : 0;
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
  }
}

/**
 * 可关闭轮询器只在单一、显式租户内消费。跨租户扫描属于后续 dispatch/调度编排，
 * 不能借由绕过 RLS 的数据库查询混入此消费者。
 */
export class SandboxCleanupPollingLoop {
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly consumer: SandboxCleanupConsumer,
    private readonly tenantId: string,
    private readonly intervalMs: number,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 600_000) {
      throw new TypeError("cleanup 轮询间隔无效");
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
