import { describe, expect, it } from "vitest";
import { initialWorkspaceState, mergeEvents, workspaceReducer } from "./state.js";

describe("mergeEvents", () => {
  it("按序号去重并保持事件顺序", () => {
    const event = (sequence: number) => ({
      eventId: `evt_${sequence}`,
      sequence,
      occurredAt: "2026-01-01T00:00:00Z",
      kind: "agent_event",
      type: "text",
      payload: "x",
    });
    expect(
      mergeEvents([event(2)], [event(1), event(2), event(3)]).map((value) => value.sequence),
    ).toEqual([1, 2, 3]);
  });

  it("Attempt 变化时替换同 sequence 的旧事件", () => {
    const oldEvent = {
      eventId: "event-1",
      sequence: 1,
      occurredAt: "",
      kind: "agent_event",
      type: "message.delta",
      payload: { delta: "旧" },
    };
    const newEvent = { ...oldEvent, payload: { delta: "新" } };
    const afterFirst = workspaceReducer(initialWorkspaceState, {
      type: "events",
      page: { attemptId: "attempt_1", items: [oldEvent] },
    });
    const afterRecovery = workspaceReducer(afterFirst, {
      type: "events",
      page: { attemptId: "attempt_2", items: [newEvent] },
    });
    expect(afterRecovery).toMatchObject({ eventAttemptId: "attempt_2", events: [newEvent] });
  });
});
