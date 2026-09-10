import type {
  ThreadSandboxLifecycleClaim,
  ThreadSandboxLifecycleResolution,
} from "@hoox/persistence";
import { FakeSandboxGateway } from "@hoox/sandbox/testing";
import { describe, expect, it, vi } from "vitest";
import {
  CubeThreadSandboxLifecycleResolver,
  ThreadSandboxLifecycleConsumer,
  ThreadSandboxLifecycleRouterResolver,
  type ThreadSandboxLifecycleStore,
} from "./thread-sandbox-lifecycle-consumer.js";

const claim = (
  overrides: Partial<ThreadSandboxLifecycleClaim> = {},
): ThreadSandboxLifecycleClaim => ({
  tenantId: "tenant-test",
  threadId: "thread-test",
  sessionId: "thread-session-test",
  generation: 1,
  effectId: "sandbox-effect-test",
  effectKind: "pause",
  providerKey: "cube",
  providerSandboxId: "fake-1",
  mode: "execute",
  token: "sandbox-effect-claim-test",
  claimGeneration: 1,
  ...overrides,
});

class FakeStore implements ThreadSandboxLifecycleStore {
  next: ThreadSandboxLifecycleClaim | undefined;
  remoteStarted = 0;
  resolutions: ThreadSandboxLifecycleResolution[] = [];

  async claimNext(): Promise<ThreadSandboxLifecycleClaim | undefined> {
    const result = this.next;
    this.next = undefined;
    return result;
  }

  async markRemoteStarted(): Promise<boolean> {
    this.remoteStarted += 1;
    return true;
  }

  async resolve(
    _claim: ThreadSandboxLifecycleClaim,
    resolution: ThreadSandboxLifecycleResolution,
  ): Promise<boolean> {
    this.resolutions.push(resolution);
    return true;
  }
}

describe("Thread Sandbox lifecycle consumer", () => {
  it("托管回收使用旧实例绑定的网关和超时，读取失败时不调用默认供应商", async () => {
    const pause = vi.fn(async () => undefined);
    const kill = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ pause, kill }));
    const inspect = vi.fn(async () => "paused" as const);
    const session = vi.fn(async () => ({
      gateway: { connect, inspect } as never,
      timeoutMs: 45000,
    }));
    const requireProvider = vi.fn(() => {
      throw new Error("不应使用活动默认供应商");
    });
    const resolver = new ThreadSandboxLifecycleRouterResolver({ require: requireProvider }, 90000, {
      session,
    });
    const old = claim({ providerKey: "tencent-ags" });
    await expect(resolver.execute(old)).resolves.toBe("paused");
    expect(connect).toHaveBeenCalledWith(old.providerSandboxId, { timeoutMs: 45000 });
    await expect(resolver.reconcile(old)).resolves.toBe("paused");
    await expect(resolver.execute({ ...old, effectKind: "terminate" })).resolves.toBe("terminated");
    expect(kill).toHaveBeenCalledWith({ timeoutMs: 45000, ignoreNotFound: true });
    session.mockRejectedValue(new Error("配置不可用"));
    await expect(resolver.execute(old)).resolves.toBe("unknown");
    expect(requireProvider).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("AGS 生命周期只路由到持久 Provider，过渡态保留 unknown", async () => {
    const pause = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ pause }));
    const inspect = vi.fn(async () => "unknown" as const);
    const requireProvider = vi.fn((key: string) => {
      if (key !== "tencent-ags") throw new Error("禁止错误 Provider 路由");
      return { connect, inspect } as never;
    });
    const resolver = new ThreadSandboxLifecycleRouterResolver({ require: requireProvider }, 1000);
    const agsClaim = claim({ providerKey: "tencent-ags", providerSandboxId: "sbi-test" });
    await expect(resolver.execute(agsClaim)).resolves.toBe("paused");
    expect(connect).toHaveBeenCalledWith("sbi-test", { timeoutMs: 1000 });
    await expect(resolver.reconcile(agsClaim)).resolves.toBe("unknown");
    expect(requireProvider).toHaveBeenCalledWith("tencent-ags");
    expect(pause).toHaveBeenCalledOnce();
  });

  it("pending pause 先写 remote marker，确认后只收敛 paused", async () => {
    const gateway = new FakeSandboxGateway();
    await gateway.create({ templateId: "fake" });
    const store = new FakeStore();
    store.next = claim();
    const consumer = new ThreadSandboxLifecycleConsumer(
      store,
      new CubeThreadSandboxLifecycleResolver(gateway, 1_000),
      "worker-test",
      30_000,
    );

    await expect(consumer.drainTenant("tenant-test")).resolves.toBe(1);
    expect(store.remoteStarted).toBe(1);
    expect(store.resolutions).toEqual(["paused"]);
    expect(await gateway.inspect("fake-1")).toBe("paused");
  });

  it("unknown 对账不重放原 effect；running 只生成新的 pause intent", async () => {
    const gateway = new FakeSandboxGateway();
    await gateway.create({ templateId: "fake" });
    const store = new FakeStore();
    store.next = claim({ mode: "reconcile" });
    const consumer = new ThreadSandboxLifecycleConsumer(
      store,
      new CubeThreadSandboxLifecycleResolver(gateway, 1_000),
      "worker-test",
      30_000,
    );

    await expect(consumer.drainTenant("tenant-test")).resolves.toBe(1);
    expect(store.remoteStarted).toBe(0);
    expect(store.resolutions).toEqual(["retry_pause"]);
    expect(await gateway.inspect("fake-1")).toBe("running");
  });

  it("terminate 对账明确 NOT_FOUND 后收敛 terminated", async () => {
    const gateway = new FakeSandboxGateway();
    const store = new FakeStore();
    store.next = claim({ mode: "reconcile", effectKind: "terminate" });
    const consumer = new ThreadSandboxLifecycleConsumer(
      store,
      new CubeThreadSandboxLifecycleResolver(gateway, 1_000),
      "worker-test",
      30_000,
    );

    await expect(consumer.drainTenant("tenant-test")).resolves.toBe(1);
    expect(store.resolutions).toEqual(["terminated"]);
  });
});
