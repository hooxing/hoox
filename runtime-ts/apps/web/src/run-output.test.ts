import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Run, type RunEventPage, type RuntimeApi } from "./api.js";
import { followRunOutput, RunOutputBuffer } from "./run-output.js";

const run: Run = {
  id: "run_1",
  threadId: "thread_1",
  status: "running",
  createdAt: "2026-09-04T00:00:00Z",
  updatedAt: "2026-09-04T00:00:00Z",
};
function page(sequences: number[], attemptId = "attempt_1", type = "message.delta"): RunEventPage {
  return {
    attemptId,
    hasMore: false,
    items: sequences.map((sequence) => ({
      eventId: `${attemptId}-${sequence}`,
      sequence,
      kind: "agent_event",
      type,
      payload: { delta: `${sequence}` },
      occurredAt: run.createdAt,
    })),
  };
}
function follow(
  streamEvents: RuntimeApi["streamEvents"],
  overrides: Partial<Parameters<typeof followRunOutput>[0]> = {},
) {
  const onPage = vi.fn();
  const onError = vi.fn();
  const controller = new AbortController();
  const api = {
    streamEvents,
    listEvents: vi.fn(async () => page([0])),
    getRun: vi.fn(async () => run),
  };
  const done = followRunOutput({
    api,
    threadId: run.threadId,
    runId: run.id,
    signal: controller.signal,
    onPage,
    onRun: vi.fn(),
    onSettled: vi.fn(),
    onError,
    ...overrides,
  });
  return { done, api, onPage, onError, controller };
}

afterEach(() => vi.useRealTimers());
describe("实时正文消费", () => {
  it("首字立即发布，连续文字在 50ms 内合并，控制事件立即排空", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const buffer = new RunOutputBuffer(publish);
    buffer.push(page([0]));
    expect(publish).toHaveBeenCalledOnce();
    buffer.push(page([1]));
    buffer.push(page([2]));
    vi.advanceTimersByTime(49);
    expect(publish).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(
      publish.mock.calls[1]?.[0].items.map((item: { sequence: number }) => item.sequence),
    ).toEqual([1, 2]);
    buffer.push(page([3]));
    buffer.push(page([4], "attempt_1", "message.completed"));
    expect(publish.mock.calls[2]?.[0].items).toHaveLength(2);
    buffer.push(page([5]));
    buffer.cancel();
    vi.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("断线按已接收游标补读并去重，新 Attempt 从零开始", async () => {
    vi.useFakeTimers();
    const stream = vi
      .fn<RuntimeApi["streamEvents"]>()
      .mockImplementationOnce(async (_thread, _run, _cursor, _signal, receive) => {
        receive(page([0, 1]), run);
        throw new TypeError("network");
      })
      .mockImplementationOnce(async (_thread, _run, cursor, _signal, receive) => {
        expect(cursor).toEqual({ after: 1, attemptId: "attempt_1" });
        receive(page([1, 2]), run);
        receive(page([0], "attempt_2"), run);
        return "settled";
      });
    const result = follow(stream);
    await vi.advanceTimersByTimeAsync(250);
    await result.done;
    expect(
      result.onPage.mock.calls.map(([value]) => [
        value.attemptId,
        value.items.map((item: { sequence: number }) => item.sequence),
      ]),
    ).toEqual([
      ["attempt_1", [0, 1]],
      ["attempt_2", [0]],
    ]);
    expect(result.onError).not.toHaveBeenCalled();
  });

  it("不连续页不会提前推进游标，重试后整页文字仍可呈现", async () => {
    vi.useFakeTimers();
    const stream = vi
      .fn<RuntimeApi["streamEvents"]>()
      .mockImplementationOnce(async (_thread, _run, _cursor, _signal, receive) => {
        receive(page([0, 2]), run);
        return "settled";
      })
      .mockImplementationOnce(async (_thread, _run, cursor, _signal, receive) => {
        expect(cursor).toEqual({ after: -1, attemptId: undefined });
        receive(page([0, 1, 2]), run);
        return "settled";
      });
    const result = follow(stream);
    await vi.advanceTimersByTimeAsync(250);
    await result.done;
    expect(result.onPage).toHaveBeenCalledExactlyOnceWith(page([0, 1, 2]));
  });

  it("取消连接后丢弃尚未提交的文字，也不接受迟到回调", async () => {
    vi.useFakeTimers();
    let receive!: Parameters<RuntimeApi["streamEvents"]>[4];
    const result = follow(async (_thread, _run, _cursor, signal, callback) => {
      receive = callback;
      callback(page([0]), run);
      callback(page([1]), run);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "settled";
    });
    result.controller.abort();
    receive(page([2]), run);
    await result.done;
    vi.runAllTimers();
    expect(result.onPage).toHaveBeenCalledExactlyOnceWith(page([0]));
  });

  it("旧服务降级轮询时正文不等待 Run 状态接口", async () => {
    let resolveRun!: (value: Run) => void;
    const getRun = vi.fn(
      () =>
        new Promise<Run>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const onPage = vi.fn();
    const api = {
      streamEvents: vi.fn(async () => {
        throw new ApiError("not found", 404, false);
      }),
      listEvents: vi.fn(async () => page([0])),
      getRun,
    };
    const result = follow(api.streamEvents, { api, onPage });
    await vi.waitFor(() => expect(getRun).toHaveBeenCalledOnce());
    expect(onPage).toHaveBeenCalledOnce();
    resolveRun({ ...run, status: "succeeded" });
    await result.done;
  });
});
