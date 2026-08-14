import type { RuntimeMutation } from "./ports.js";
import { describe, expect, it } from "vitest";
import { isExternalCancellationFinalizationMutation } from "./mutation-protocol.js";

function cancellationMutation(): RuntimeMutation {
  return {
    schemaVersion: 1,
    commandDigest: "a".repeat(64),
    idempotencyKey: "attempt-test/final/cancelled",
    fence: {},
    expectedAttemptVersion: 3,
    nextAttemptStatus: "cancelled",
    nextStage: "finished",
    events: [
      {
        schemaVersion: 1,
        kind: "agent_event",
        sequence: 4,
        payload: {
          type: "runtime.notice",
          level: "error",
          code: "CANCELLED",
          message: "任务已取消",
          source: "terminal_fallback",
        },
      },
      {
        schemaVersion: 1,
        kind: "attempt_state_changed",
        sequence: 5,
        payload: { status: "cancelled", stage: "finished", code: "CANCELLED" },
      },
    ],
    outbox: [],
    nextRunStatus: "cancelled",
    releaseFences: true,
  } as unknown as RuntimeMutation;
}

describe("外部取消终态 mutation 窄门", () => {
  it("只接受固定取消终态，并拒绝取消后继续写模型或 Workspace", () => {
    const valid = cancellationMutation();
    expect(isExternalCancellationFinalizationMutation(valid, "attempt-test")).toBe(true);
    expect(
      isExternalCancellationFinalizationMutation(
        { ...valid, idempotencyKey: "attempt-test/event/6" },
        "attempt-test",
      ),
    ).toBe(false);
    expect(
      isExternalCancellationFinalizationMutation(
        { ...valid, nextAttemptStatus: "succeeded" },
        "attempt-test",
      ),
    ).toBe(false);
    expect(
      isExternalCancellationFinalizationMutation(
        { ...valid, workspaceChange: {} as never },
        "attempt-test",
      ),
    ).toBe(false);
  });
});
