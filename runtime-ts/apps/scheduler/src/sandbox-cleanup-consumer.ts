import type { CleanupClaim } from "@cube-runtime/persistence";
import { SandboxRuntimeError, type SandboxGateway } from "@cube-runtime/sandbox";

export interface SandboxCleanupResolver {
  settle(input: Pick<CleanupClaim, "registryId" | "providerSandboxId" | "disposition">): Promise<"settled" | "unknown">;
}

/** 消费器只依赖原子领取/栅栏协议，便于完整模拟每个崩溃窗口而不伪造 PostgreSQL SQL。 */
export interface SandboxCleanupStore {
  claimNext(input: { readonly tenantId: string; readonly workerId: string; readonly leaseMs: number }): Promise<CleanupClaim | undefined>;
  markRemoteStarted(claim: CleanupClaim): Promise<boolean>;
  complete(claim: CleanupClaim): Promise<boolean>;
  unknown(claim: CleanupClaim): Promise<boolean>;
}

/**
 * 这里只通过 providerSandboxId 重新连接，不保存或复用 Worker 的内存 session。
 * 若上游明确返回不存在，资源已经不需要清理；任何其他错误都保持 unknown，交给人工核对。
 */
export class CubeSandboxCleanupResolver implements SandboxCleanupResolver {
  constructor(private readonly gateway: SandboxGateway, private readonly timeoutMs = 90_000) {}

  async settle(input: Pick<CleanupClaim, "registryId" | "providerSandboxId" | "disposition">): Promise<"settled" | "unknown"> {
    try {
      const sandbox = await this.gateway.connect(input.providerSandboxId, { timeoutMs: this.timeoutMs });
      if (input.disposition === "pause") await sandbox.pause({ timeoutMs: this.timeoutMs });
      else await sandbox.kill({ timeoutMs: this.timeoutMs, ignoreNotFound: true });
      return "settled";
    } catch (error) {
      // close 的“不存在”意味着目标已不再占用资源；pause 不存在无法推断为已暂停。
      if (input.disposition === "close" && error instanceof SandboxRuntimeError && error.code === "NOT_FOUND") return "settled";
      return "unknown";
    }
  }
}

/** 每个实例独占轮询对象；不得与 dispatch 或其他 Scheduler 工作共用可变单例。 */
export class SandboxCleanupConsumer {
  private stopping = false;
  constructor(
    private readonly store: SandboxCleanupStore,
    private readonly resolver: SandboxCleanupResolver,
    private readonly workerId: string,
    private readonly leaseMs = 120_000,
  ) {
    // Cube connect/settle 默认最多 90 秒，额外 30 秒覆盖连接抖动和状态写回；不能用 30 秒 lease 包裹 90 秒远端调用。
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 120_000 || leaseMs > 600_000) throw new TypeError("cleanup lease 必须覆盖远端操作和安全余量");
  }

  /** 一次只领取一条，调用方以其自身生命周期调度下一次，避免关闭后又开始新的远端调用。 */
  async drainTenant(tenantId: string): Promise<number> {
    if (this.stopping) return 0;
    const claim = await this.store.claimNext({ tenantId, workerId: this.workerId, leaseMs: this.leaseMs });
    if (claim === undefined || this.stopping) return 0;
    // 这条写入是不可逆远端边界；之后任意崩溃都只能收敛 unknown，禁止重复 settle。
    if (!(await this.store.markRemoteStarted(claim))) return 0;
    try {
      const settled = await this.resolver.settle(claim);
      if (settled === "settled") await this.store.complete(claim);
      else await this.store.unknown(claim);
    } catch {
      // Store 的异常不能触发第二次远端调用；下次 recovery 看到 started 会收敛 unknown。
      await this.store.unknown(claim).catch(() => undefined);
    }
    return 1;
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
      this.inFlight = this.consumer.drainTenant(this.tenantId).then(
        () => undefined,
        () => undefined,
      ).finally(() => {
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
