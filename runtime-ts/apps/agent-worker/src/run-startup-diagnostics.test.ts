import { describe, expect, it, vi } from "vitest";
import { RunStartupTimingCollector } from "./run-startup-diagnostics.js";

describe("Run 首模启动耗时诊断", () => {
  it("记录分段耗时并只发布一次首模前快照", async () => {
    let monotonicNow = 100;
    const persist = vi.fn(async () => undefined);
    const collector = new RunStartupTimingCollector(
      {
        tenantId: "tenant_dev_1",
        threadId: "thread_dev_1",
        runId: "run_dev_1",
        attemptId: "attempt_dev_1",
      },
      { persist },
      100,
      {
        now: () => new Date("2026-08-28T09:30:00.000Z"),
        monotonicNow: () => monotonicNow,
      },
    );

    await collector.measure("run_claim", async () => {
      monotonicNow = 112.5;
    });
    collector.record("memory_retrieve", 3.25);
    collector.publish();
    collector.record("prepare_input", 99);
    collector.publish();
    await collector.drain();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith({
      context: {
        tenantId: "tenant_dev_1",
        threadId: "thread_dev_1",
        runId: "run_dev_1",
        attemptId: "attempt_dev_1",
      },
      observedAt: "2026-08-28T09:30:00.000Z",
      totalDurationMs: 12.5,
      spans: [
        { phase: "run_claim", durationMs: 12.5 },
        { phase: "memory_retrieve", durationMs: 3.25 },
      ],
    });
  });

  it("同步或异步诊断写入失败都不会向 Run 传播", async () => {
    const collector = new RunStartupTimingCollector(
      {
        tenantId: "tenant_dev_1",
        threadId: "thread_dev_1",
        runId: "run_dev_1",
        attemptId: "attempt_dev_1",
      },
      { persist: async () => Promise.reject(new Error("disk unavailable")) },
    );

    collector.publish();
    await expect(collector.drain()).resolves.toBeUndefined();

    const synchronous = new RunStartupTimingCollector(
      {
        tenantId: "tenant_dev_1",
        threadId: "thread_dev_1",
        runId: "run_dev_2",
        attemptId: "attempt_dev_2",
      },
      {
        persist: () => {
          throw new Error("synchronous disk failure");
        },
      },
    );
    expect(() => synchronous.publish()).not.toThrow();
    await expect(synchronous.drain()).resolves.toBeUndefined();
  });
});
