import type { CleanupClaim, PgSandboxCleanupConsumerStore } from "@cube-runtime/persistence";

export interface SandboxCleanupResolver {
  settle(input: Pick<CleanupClaim, "registryId" | "providerSandboxId" | "disposition">): Promise<"settled" | "unknown">;
}

/** 每个实例持有独立轮询对象；不得与 dispatch 或其他 Scheduler 工作共用可变单例。 */
export class SandboxCleanupConsumer {
  private stopping = false;
  constructor(private readonly store: PgSandboxCleanupConsumerStore, private readonly resolver: SandboxCleanupResolver, private readonly workerId: string, private readonly leaseMs = 30_000) {}
  async drainTenant(tenantId: string): Promise<number> {
    if (this.stopping) return 0;
    const claim = await this.store.claimNext({ tenantId, workerId: this.workerId, leaseMs: this.leaseMs });
    if (claim === undefined) return 0;
    // 这条写入是不可逆远端边界；之后任意崩溃都只能收敛 unknown，禁止重复 settle。
    if (!(await this.store.markRemoteStarted(claim))) return 0;
    try {
      const settled = await this.resolver.settle(claim);
      if (settled === "settled") await this.store.complete(claim); else await this.store.unknown(claim);
    } catch { await this.store.unknown(claim); }
    return 1;
  }
  async close(): Promise<void> { this.stopping = true; }
}
