import type { CleanupClaim } from "@cube-runtime/persistence";
import { describe, expect, it } from "vitest";
import {
  SandboxCleanupConsumer,
  type SandboxCleanupResolver,
  type SandboxCleanupStore,
} from "./sandbox-cleanup-consumer.js";

const claim: CleanupClaim = {
  tenantId: "tenant-a",
  attemptId: "attempt-a",
  registryId: "registry-a",
  providerSandboxId: "sandbox-a",
  idempotencyKey: "cleanup-a",
  disposition: "pause",
  token: "claim-a",
  generation: 1,
};

class FakeStore implements SandboxCleanupStore {
  readonly calls: string[] = [];
  next: CleanupClaim | undefined = claim;
  begin = true;
  completeResult = true;
  unknownResult = true;
  async claimNext(): Promise<CleanupClaim | undefined> {
    this.calls.push("claim");
    const value = this.next;
    this.next = undefined;
    return value;
  }
  async markRemoteStarted(): Promise<boolean> {
    this.calls.push("started");
    return this.begin;
  }
  async complete(): Promise<boolean> {
    this.calls.push("complete");
    return this.completeResult;
  }
  async unknown(): Promise<boolean> {
    this.calls.push("unknown");
    return this.unknownResult;
  }
}

class FakeResolver implements SandboxCleanupResolver {
  readonly dispositions: string[] = [];
  result: "settled" | "unknown" = "settled";
  fail = false;
  async settle(
    input: Pick<CleanupClaim, "registryId" | "providerSandboxId" | "disposition">,
  ): Promise<"settled" | "unknown"> {
    this.dispositions.push(input.disposition);
    if (this.fail) throw new Error("模拟远端响应丢失");
    return this.result;
  }
}

describe("Sandbox Cleanup Consumer 崩溃窗口", () => {
  it("租约必须覆盖连接与远端 settle 的总最坏时间", () => {
    const store = new FakeStore();
    const resolver = new FakeResolver();
    expect(() => new SandboxCleanupConsumer(store, resolver, "worker-a", 209_999)).toThrow(
      "cleanup lease 必须覆盖远端操作和安全余量",
    );
    expect(() => new SandboxCleanupConsumer(store, resolver, "worker-a", 210_000)).not.toThrow();
  });

  it("领取未能写入 remote_call_started 时绝不调用远端", async () => {
    const store = new FakeStore();
    store.begin = false;
    const resolver = new FakeResolver();
    expect(
      await new SandboxCleanupConsumer(store, resolver, "worker-a").drainTenant("tenant-a"),
    ).toBe(0);
    expect(resolver.dispositions).toEqual([]);
    expect(store.calls).toEqual(["claim", "started"]);
  });

  it("已跨越远端边界后响应丢失只收敛 unknown，不会重试 settle", async () => {
    const store = new FakeStore();
    const resolver = new FakeResolver();
    resolver.fail = true;
    const consumer = new SandboxCleanupConsumer(store, resolver, "worker-a");
    expect(await consumer.drainTenant("tenant-a")).toBe(1);
    expect(resolver.dispositions).toEqual(["pause"]);
    expect(store.calls).toEqual(["claim", "started", "unknown"]);
    // 同一实例不能凭内存状态补发；数据库恢复器也会把 remote_call_started 的记录置 unknown。
    expect(await consumer.drainTenant("tenant-a")).toBe(0);
    expect(resolver.dispositions).toHaveLength(1);
  });

  it("远端明确 unknown 以及完成写入失败都不触发第二次调用", async () => {
    const store = new FakeStore();
    const resolver = new FakeResolver();
    resolver.result = "unknown";
    await new SandboxCleanupConsumer(store, resolver, "worker-a").drainTenant("tenant-a");
    expect(store.calls).toEqual(["claim", "started", "unknown"]);
    expect(resolver.dispositions).toEqual(["pause"]);
  });

  it("关闭先阻止新领取", async () => {
    const store = new FakeStore();
    const resolver = new FakeResolver();
    const consumer = new SandboxCleanupConsumer(store, resolver, "worker-a");
    await consumer.close();
    expect(await consumer.drainTenant("tenant-a")).toBe(0);
    expect(store.calls).toEqual([]);
  });
});
