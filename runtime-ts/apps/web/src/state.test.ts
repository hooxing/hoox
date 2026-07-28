import { describe, expect, it } from "vitest";
import { mergeEvents } from "./state.js";

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
});
