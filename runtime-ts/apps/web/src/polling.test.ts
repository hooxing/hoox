import { describe, expect, it, vi } from "vitest";
import { EVENT_PAGE_LIMIT, type RunEvent, type RunEventPage } from "./api.js";
import { CurrentRunPoll, drainEventPages, MAX_EVENT_PAGES_PER_POLL } from "./polling.js";

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
      nextAfter: 1,
      hasMore: false,
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
    expect(result).toMatchObject({ nextAfter: EVENT_PAGE_LIMIT, hasMore: false });
    expect(listPage.mock.calls).toEqual([
      [-1, EVENT_PAGE_LIMIT],
      [EVENT_PAGE_LIMIT - 1, EVENT_PAGE_LIMIT],
    ]);
  });

  it("单轮达到页数上限后保留游标并由下一轮继续", async () => {
    const pages = Array.from({ length: MAX_EVENT_PAGES_PER_POLL + 1 }, (_, sequence) =>
      sequence < MAX_EVENT_PAGES_PER_POLL
        ? { attemptId: "attempt_1", items: [event(sequence)], hasMore: true }
        : { attemptId: "attempt_1", items: [event(sequence)], hasMore: false },
    );
    const listPage = vi
      .fn<(after: number, limit: number) => Promise<RunEventPage>>()
      .mockImplementation(async () => pages.shift() ?? { attemptId: "attempt_1", items: [] });

    const first = await drainEventPages(listPage, -1, "attempt_1");
    expect(first).toMatchObject({
      nextAfter: MAX_EVENT_PAGES_PER_POLL - 1,
      hasMore: true,
    });
    expect(first.items).toHaveLength(MAX_EVENT_PAGES_PER_POLL);
    expect(listPage).toHaveBeenCalledTimes(MAX_EVENT_PAGES_PER_POLL);

    const second = await drainEventPages(listPage, first.nextAfter, first.attemptId);
    expect(second).toMatchObject({
      items: [event(MAX_EVENT_PAGES_PER_POLL)],
      nextAfter: MAX_EVENT_PAGES_PER_POLL,
      hasMore: false,
    });
    expect(listPage).toHaveBeenLastCalledWith(MAX_EVENT_PAGES_PER_POLL - 1, EVENT_PAGE_LIMIT);
  });
});

describe("CurrentRunPoll", () => {
  it("新 Run 同步生效后拒绝旧 Run 的迟到响应", () => {
    const current = new CurrentRunPoll();
    const oldRun = current.activate("thread_1", "run_1");
    const newRun = current.activate("thread_1", "run_2");

    expect(current.isCurrent(oldRun)).toBe(false);
    expect(current.isCurrent(newRun)).toBe(true);
    // 旧 effect 的 cleanup 不能反向使新 Run 失效。
    current.invalidate(oldRun);
    expect(current.isCurrent(newRun)).toBe(true);
  });

  it("切换线程会立即使在途 Run 响应失效", () => {
    const current = new CurrentRunPoll();
    const oldRun = current.activate("thread_1", "run_1");

    current.invalidate();

    expect(current.isCurrent(oldRun)).toBe(false);
  });
});
