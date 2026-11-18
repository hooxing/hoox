import { describe, expect, it } from "vitest";
import { PgThreadContinuityMetrics } from "./thread-continuity.js";

describe("Thread continuity 指标", () => {
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

  it("模型用量端口在接触数据库前拒绝小数 token 和无效时长", async () => {
    const metrics = new PgThreadContinuityMetrics({} as never);
    const base = {
      tenantId: "tenant-a" as never,
      threadId: "thread-a" as never,
      runId: "run-a" as never,
      observationId: "attempt-a:model-usage:1",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      generationDurationMs: 500,
    };
    await expect(metrics.recordModelUsage({ ...base, outputTokens: 1.5 })).rejects.toThrow(
      "模型用量观测无效",
    );
    await expect(
      metrics.recordModelUsage({ ...base, generationDurationMs: Number.NaN }),
    ).rejects.toThrow("模型用量观测无效");
  });
});
