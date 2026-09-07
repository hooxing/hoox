import { describe, expect, it, vi } from "vitest";
import { RunPhaseTimingCollector } from "./run-phase-diagnostics.js";

describe("Run 内部阶段诊断", () => {
  it("串行写入独立序号，首条写入失败仍保存后续阶段", async () => {
    const context = {
      tenantId: "tenant_1",
      threadId: "thread_1",
      runId: "run_1",
      attemptId: "attempt_1",
    };
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(undefined);
    const collector = new RunPhaseTimingCollector(context, { persist });
    const span = {
      phase: "tool_execute" as const,
      startedAt: "2026-09-07T00:00:00.000Z",
      durationMs: 5,
      status: "succeeded" as const,
    };
    collector.record(span);
    collector.record({ ...span, durationMs: Number.NaN });
    collector.record({ ...span, toolCallId: "call-2" });
    await expect(collector.drain()).resolves.toBeUndefined();
    expect(persist.mock.calls.map(([record]) => record.sequence)).toEqual([1, 2]);
    expect(persist.mock.calls[1]?.[0]).toEqual({
      ...span,
      context,
      sequence: 2,
      toolCallId: "call-2",
    });
  });
});
