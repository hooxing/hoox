import { describe, expect, it } from "vitest";
import {
  PgThreadContinuityMetrics,
  threadContinuityCohortBucket,
} from "./thread-continuity-rollout.js";

describe("Thread continuity rollout cohort", () => {
  it("同一 Tenant/Thread 永远得到同一万分桶", () => {
    const first = threadContinuityCohortBucket("tenant-a", "thread-a");
    expect(first).toBe(threadContinuityCohortBucket("tenant-a", "thread-a"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(10_000);
  });

  it("Tenant 与 Thread 都参与 cohort identity", () => {
    expect(threadContinuityCohortBucket("tenant-a", "thread-a")).not.toBe(
      threadContinuityCohortBucket("tenant-b", "thread-a"),
    );
    expect(threadContinuityCohortBucket("tenant-a", "thread-a")).not.toBe(
      threadContinuityCohortBucket("tenant-a", "thread-b"),
    );
  });

  it("拒绝空 identity，不把 rollout 参数偷偷固化进算法", () => {
    expect(() => threadContinuityCohortBucket("", "thread-a")).toThrow(
      "Thread rollout identity 无效",
    );
    expect(threadContinuityCohortBucket.length).toBe(2);
  });

  it("指标端口在接触数据库前拒绝非有限值和高基数维度", async () => {
    const metrics = new PgThreadContinuityMetrics({} as never);
    const base = {
      tenantId: "tenant-a" as never,
      threadId: "thread-a" as never,
      observationId: "observation-a",
      metricName: "context_rebuild_latency_ms" as const,
      unit: "milliseconds" as const,
    };
    await expect(metrics.record({ ...base, value: Number.NaN })).rejects.toThrow(
      "Thread continuity metric 无效",
    );
    await expect(metrics.record({ ...base, value: 1, outcome: "x".repeat(65) })).rejects.toThrow(
      "Thread continuity metric 无效",
    );
  });
});
