import type { PgClaimedRunDispatch, PgClaimedWorkerTenantAssignment } from "@hoox/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkerPollingLoop } from "./production-worker-runtime.js";
import { performWorkerMaintenance } from "./worker-maintenance.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(input: {
  readonly tenants: readonly string[];
  readonly maintenance: (tenantId: string) => Promise<unknown>;
  readonly runs?: boolean;
  readonly execute?: () => Promise<void>;
  readonly claimAssignment?: () => Promise<void>;
  readonly settle?: () => Promise<void>;
}) {
  const ready = new Map(input.tenants.map((id) => [id, { generation: 0, availableAt: 0 }]));
  const executed: string[] = [];
  const dispatched = new Set<string>();
  const claimed: PgClaimedWorkerTenantAssignment[] = [];
  const settled: PgClaimedWorkerTenantAssignment[] = [];
  const loop = new AgentWorkerPollingLoop(
    {
      claim: async () => {
        const next = [...ready].find(([, entry]) => entry.availableAt <= Date.now());
        if (next === undefined) return undefined;
        const [tenantId, entry] = next;
        entry.generation += 1;
        entry.availableAt = Date.now() + 100;
        const assignment = {
          tenantId,
          generation: entry.generation,
          claimToken: `claim-${tenantId}-${entry.generation}`,
          workerId: "worker",
        };
        claimed.push(assignment);
        await input.claimAssignment?.();
        return assignment;
      },
      settle: async (assignment) => {
        await input.settle?.();
        settled.push(assignment);
        const entry = ready.get(assignment.tenantId);
        if (entry?.generation !== assignment.generation || entry.availableAt <= Date.now()) {
          return false;
        }
        ready.delete(assignment.tenantId);
        return true;
      },
    },
    {
      claim: async ({ tenantId }) => {
        if (!input.runs || dispatched.has(tenantId)) return [];
        dispatched.add(tenantId);
        return [
          {
            outboxId: `outbox-${tenantId}`,
            generation: 1,
            claimToken: `dispatch-${tenantId}`,
            scope: {
              tenantId,
              threadId: `thread-${tenantId}`,
              runId: `run-${tenantId}`,
              rootRunId: `run-${tenantId}`,
              workspaceId: `workspace-${tenantId}`,
            },
          },
        ] satisfies PgClaimedRunDispatch[];
      },
      acknowledge: async () => undefined,
    },
    {
      execute: async ({ tenantId }) => {
        executed.push(tenantId);
        await input.execute?.();
        return { outcome: "succeeded" };
      },
    },
    {
      workerId: "worker",
      pollIntervalMs: 10,
      tenantAssignmentLeaseMs: 100,
      dispatchLeaseMs: 30_000,
      concurrencySettings: {
        workerMaxConcurrentRuns: 1,
        userMaxConcurrentRunsPerTenant: 1,
      },
      maintenance: input.maintenance,
    },
  );
  return { loop, ready, executed, claimed, settled };
}

describe("Worker 独立维护调度", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("慢维护不阻塞本轮 Run 或另一个 Tenant 的 Run 启动", async () => {
    const release = deferred();
    const maintenance = vi.fn(async () => release.promise);
    const { loop, executed, settled } = fixture({ tenants: ["a", "b"], runs: true, maintenance });
    loop.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(executed).toEqual(["a", "b"]);
    expect(maintenance).toHaveBeenCalledTimes(2);
    expect(settled).toEqual([]);
    const closing = loop.close();
    release.resolve();
    await closing;
    expect(settled.map(({ tenantId }) => tenantId)).toEqual(["a", "b"]);
  });

  it("Run 槽满仍发现并执行其他 Tenant 的维护", async () => {
    const release = deferred();
    const maintenance = vi.fn(async (_tenantId: string) => undefined);
    const { loop, executed } = fixture({
      tenants: ["a", "b"],
      runs: true,
      execute: () => release.promise,
      maintenance,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(executed).toEqual(["a"]);
    expect(maintenance.mock.calls.map(([tenantId]) => tenantId)).toEqual(["a", "b"]);
    release.resolve();
    await loop.close();
  });

  it("同 Tenant 租约过期重领不并发维护，新 generation 再维护后才 settle", async () => {
    const release = deferred();
    let calls = 0;
    const { loop, claimed, settled } = fixture({
      tenants: ["a"],
      maintenance: async () => {
        calls += 1;
        if (calls === 1) await release.promise;
      },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(110);
    expect(calls).toBe(1);
    expect(claimed.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(settled).toEqual([]);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(settled.map(({ generation }) => generation)).toEqual([2]);
    await loop.close();
  });

  it("旧 settle 等待期间新 generation 到达，必须重跑维护并收敛最新租约", async () => {
    const release = deferred();
    const maintenance = vi.fn(async () => undefined);
    const { loop, settled } = fixture({
      tenants: ["a"],
      maintenance,
      settle: () => release.promise,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(110);
    expect(maintenance).toHaveBeenCalledTimes(1);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance).toHaveBeenCalledTimes(2);
    expect(settled.map(({ generation }) => generation)).toEqual([1, 2]);
    await loop.close();
  });

  it("stopAccepting 后不启动已经排入微任务但尚未开始的维护", async () => {
    const maintenance = vi.fn(async () => undefined);
    let stop: () => void = () => undefined;
    const { loop, settled } = fixture({
      tenants: ["a"],
      runs: true,
      maintenance,
      execute: async () => stop(),
    });
    stop = () => loop.stopAccepting();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await loop.drain();
    expect(maintenance).not.toHaveBeenCalled();
    expect(settled).toEqual([]);
  });

  it("最多并行四个 Tenant，饱和仍启动 Run，未维护的 Tenant 保留租约后重试", async () => {
    const release = deferred();
    const started: string[] = [];
    const { loop, executed, settled } = fixture({
      tenants: ["a", "b", "c", "d", "e"],
      runs: true,
      maintenance: async (tenantId) => {
        started.push(tenantId);
        await release.promise;
      },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(executed).toEqual(["a", "b", "c", "d", "e"]);
    expect(settled).toEqual([]);
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(settled.map(({ tenantId }) => tenantId)).toContain("e");
    await loop.close();
  });

  it("维护失败保持租约等待过期，其他 Tenant 不被失败重试饿死", async () => {
    const calls: string[] = [];
    const { loop, settled } = fixture({
      tenants: ["a", "b"],
      maintenance: async (tenantId) => {
        calls.push(tenantId);
        if (tenantId === "a") throw new Error("维护失败");
      },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(90);
    expect(calls).toEqual(["a", "b"]);
    expect(settled.map(({ tenantId }) => tenantId)).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual(["a", "b", "a"]);
    await loop.close();
  });

  it("关闭等待活跃维护及 settle，不启动饱和未开始的维护", async () => {
    const release = deferred();
    const releaseSettle = deferred();
    const maintenance = vi.fn(async () => release.promise);
    const { loop, ready } = fixture({
      tenants: ["a", "b", "c", "d", "e"],
      maintenance,
      settle: () => releaseSettle.promise,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(maintenance).toHaveBeenCalledTimes(4);
    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    releaseSettle.resolve();
    await closing;
    expect(maintenance).toHaveBeenCalledTimes(4);
    expect(ready.has("e")).toBe(true);
  });

  it("Tenant claim 在停机后返回时不启动维护也不 settle", async () => {
    const release = deferred();
    const maintenance = vi.fn(async () => undefined);
    const { loop, ready, settled } = fixture({
      tenants: ["a"],
      maintenance,
      claimAssignment: () => release.promise,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    const closing = loop.close();
    release.resolve();
    await closing;
    expect(maintenance).not.toHaveBeenCalled();
    expect(settled).toEqual([]);
    expect(ready.has("a")).toBe(true);
  });

  it("停机不补跑维护中重领的新 generation，也不提前 settle 它", async () => {
    const release = deferred();
    const maintenance = vi.fn(async () => release.promise);
    const { loop, settled } = fixture({ tenants: ["a"], maintenance });
    loop.start();
    await vi.advanceTimersByTimeAsync(110);
    const closing = loop.close();
    release.resolve();
    await closing;
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([]);
  });
});

describe("生产维护组合", () => {
  const base = {
    recoverResourceBlobs: async () => ({ claimed: 0, converged: 0 }),
    drainMemory: async () => undefined,
    drainScheduledTasks: async () => undefined,
    resourceBlobBatchLimit: 16,
  };

  it("一个子任务失败仍等待其他已启动副作用结束", async () => {
    const release = deferred();
    let finished = false;
    const maintenance = performWorkerMaintenance({
      ...base,
      drainMemory: async () => {
        throw new Error("维护失败");
      },
      drainScheduledTasks: async () => {
        await release.promise;
        finished = true;
      },
    });
    const result = expect(maintenance).rejects.toThrow("WORKER_MAINTENANCE_INCOMPLETE");
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve();
    await result;
    expect(finished).toBe(true);
  });

  it.each([
    { claimed: 2, converged: 1 },
    { claimed: 16, converged: 16 },
  ])("Blob 部分失败或满批时保留后续清扫机会：%j", async (result) => {
    await expect(
      performWorkerMaintenance({ ...base, recoverResourceBlobs: async () => result }),
    ).rejects.toThrow("WORKER_MAINTENANCE_INCOMPLETE");
  });

  it("Blob 未满批且所有维护成功时允许 settle", async () => {
    await expect(
      performWorkerMaintenance({
        ...base,
        recoverResourceBlobs: async () => ({ claimed: 2, converged: 2 }),
      }),
    ).resolves.toBeUndefined();
  });
});
