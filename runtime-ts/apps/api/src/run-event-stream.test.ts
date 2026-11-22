import type { RunDto } from "@hoox/protocol";
import { describe, expect, it, vi } from "vitest";
import { openRunEventStream, type RunEventStreamRead } from "./run-event-stream.js";

function readValue(
  sequences: number[],
  status = "running",
  attemptId = "attempt_1",
  hasMore = false,
): RunEventStreamRead {
  return {
    run: { id: "run_1", threadId: "thread_1", status } as RunDto,
    page: {
      outcome: "found",
      attemptId,
      hasMore,
      events: sequences.map((sequence) => ({
        sequence,
        kind: "agent_event",
        payload: { type: "message.delta", delta: "文字" },
        occurredAt: "2026-09-04T00:00:00.000Z",
      })),
    },
  };
}
function frames(text: string) {
  return text
    .trim()
    .split("\n\n")
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1] ?? "null"));
}
describe("Run SSE 生命周期", () => {
  it("分页全部排空后才完成，带公共类型且释放订阅", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(readValue([0], "succeeded", "attempt_1", true))
      .mockResolvedValueOnce(readValue([1], "succeeded"));
    const unwatch = vi.fn();
    const stream = await openRunEventStream({
      cursor: { after: -1 },
      signal: new AbortController().signal,
      read,
      watch: () => unwatch,
      publicType: (_kind, payload) => String(payload.type),
    });
    let text = "";
    for await (const chunk of stream) text += chunk;
    expect(text).toContain("id: attempt_1-0\nevent: run-events");
    expect(text).toContain("id: attempt_1-1\nevent: run-events");
    expect(frames(text)).toMatchObject([
      { page: { items: [{ sequence: 0, type: "message.delta" }] } },
      { page: { items: [{ sequence: 1 }] } },
      { reason: "settled" },
    ]);
    expect(read.mock.calls.map(([after]) => after)).toEqual([-1, 0]);
    expect(unwatch).toHaveBeenCalledOnce();
  });

  it("读取过程中到达的唤醒不会丢失，切换 Attempt 时重新读取零号事件", async () => {
    let wake!: () => void;
    const read = vi
      .fn()
      .mockImplementationOnce(async () => {
        wake();
        return readValue([4]);
      })
      .mockResolvedValueOnce(readValue([], "succeeded", "attempt_2"))
      .mockResolvedValueOnce(readValue([0], "succeeded", "attempt_2"));
    const stream = await openRunEventStream({
      cursor: { after: 3, attemptId: "attempt_1" },
      signal: new AbortController().signal,
      read,
      watch: (callback) => {
        wake = callback;
        return vi.fn();
      },
      publicType: (kind) => kind,
      retryMs: 60_000,
    });
    let text = "";
    for await (const chunk of stream) text += chunk;
    expect(read.mock.calls.map(([after]) => after)).toEqual([3, 4, -1]);
    expect(frames(text)[1]).toMatchObject({
      page: { attemptId: "attempt_2", items: [{ sequence: 0 }] },
    });
  });

  it("通知缺失也会定时补读，定期续连保留已发送游标", async () => {
    const read = vi.fn(async () => readValue([0]));
    const unwatch = vi.fn();
    const stream = await openRunEventStream({
      cursor: { after: -1 },
      signal: new AbortController().signal,
      read,
      watch: () => unwatch,
      publicType: (kind) => kind,
      retryMs: 5,
      lifetimeMs: 1,
    });
    let text = "";
    for await (const chunk of stream) text += chunk;
    expect(frames(text).at(-1)).toEqual({ reason: "renew" });
    expect(unwatch).toHaveBeenCalledOnce();
  });

  it("初次鉴权读取失败和浏览器断开都会释放订阅", async () => {
    const unwatch = vi.fn();
    const controller = new AbortController();
    const options = {
      cursor: { after: -1 },
      signal: controller.signal,
      watch: () => unwatch,
      publicType: (kind: string) => kind,
    };
    await expect(
      openRunEventStream({
        ...options,
        read: async () => {
          throw new Error("denied");
        },
      }),
    ).rejects.toThrow("denied");
    const stream = await openRunEventStream({ ...options, read: async () => readValue([]) });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    controller.abort();
    await closed;
    expect(unwatch).toHaveBeenCalledTimes(2);
  });
});
