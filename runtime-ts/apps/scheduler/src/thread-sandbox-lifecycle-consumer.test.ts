import type {
  ThreadSandboxLifecycleClaim,
  ThreadSandboxLifecycleResolution,
} from "@aisay/persistence";
import { FakeSandboxGateway } from "@aisay/sandbox/testing";
import { describe, expect, it } from "vitest";
import {
  CubeThreadSandboxLifecycleResolver,
  ThreadSandboxLifecycleConsumer,
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
