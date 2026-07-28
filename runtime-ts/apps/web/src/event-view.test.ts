import { describe, expect, it } from "vitest";
import { eventSummary } from "./event-view.js";

describe("eventSummary", () => {
  it("显示 delta 而不序列化全部 payload", () => {
    expect(
      eventSummary({
        eventId: "event-1",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "message.delta",
        payload: { type: "message.delta", delta: "逐字输出", private: "不应显示" },
      }),
    ).toBe("逐字输出");
  });

  it("只显示工具的安全标识字段", () => {
    expect(
      eventSummary({
        eventId: "event-2",
        sequence: 2,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.completed",
        payload: { name: "write_artifact", callId: "call_1", receipt: { secret: "不应显示" } },
      }),
    ).toBe("工具 write_artifact（call_1）完成");
  });
});
