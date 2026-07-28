import { describe, expect, it, vi } from "vitest";
import { EVENT_PAGE_LIMIT, type RunEvent, type RunEventPage } from "./api.js";
import { drainEventPages } from "./polling.js";

function event(sequence: number): RunEvent {
  return {
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "",
    kind: "agent_event",
    type: "message.delta",
    payload: { delta: `${sequence}` },
  };
}

describe("drainEventPages", () => {
  it("Attempt 变化时即使首个终态查询为空也从 -1 重取", async () => {
    const listPage = vi
      .fn<(after: number, limit: number) => Promise<RunEventPage>>()
      .mockResolvedValueOnce({ attemptId: "attempt_2", items: [] })
      .mockResolvedValueOnce({ attemptId: "attempt_2", items: [event(0), event(1)] });

    await expect(drainEventPages(listPage, 42, "attempt_1")).resolves.toEqual({
      attemptId: "attempt_2",
      items: [event(0), event(1)],
    });
    expect(listPage.mock.calls).toEqual([
      [42, EVENT_PAGE_LIMIT],
      [-1, EVENT_PAGE_LIMIT],
    ]);
  });

  it("连续读取超过单页上限的全部事件", async () => {
    const first = Array.from({ length: EVENT_PAGE_LIMIT }, (_, sequence) => event(sequence));
    const listPage = vi
      .fn<(after: number, limit: number) => Promise<RunEventPage>>()
      .mockResolvedValueOnce({ attemptId: "attempt_1", items: first })
      .mockResolvedValueOnce({ attemptId: "attempt_1", items: [event(EVENT_PAGE_LIMIT)] });

    const result = await drainEventPages(listPage, -1, undefined);
    expect(result.items).toHaveLength(EVENT_PAGE_LIMIT + 1);
    expect(listPage.mock.calls).toEqual([
      [-1, EVENT_PAGE_LIMIT],
      [EVENT_PAGE_LIMIT - 1, EVENT_PAGE_LIMIT],
    ]);
  });
});
