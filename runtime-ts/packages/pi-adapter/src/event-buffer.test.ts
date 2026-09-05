import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeBufferedRuntimeEvents } from "./event-buffer.js";
import type { RuntimeAgentEvent } from "./events.js";

afterEach(() => vi.useRealTimers());

function harness() {
  vi.useFakeTimers();
  const listeners = new Set<(event: RuntimeAgentEvent) => void>();
  const subscribe = (listener: (event: RuntimeAgentEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const events: RuntimeAgentEvent[] = [];
  const stop = subscribeBufferedRuntimeEvents(subscribe, (event) => events.push(event));
  return {
    events,
    stop,
    subscribe,
    emit: (event: RuntimeAgentEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

const delta = (text: string): RuntimeAgentEvent => ({ type: "message.delta", delta: text });

describe("公开 Runtime 增量缓冲", () => {
  it("首段非空正文立即发布，后续增量按首个缓冲时间而非持续延长的防抖时间刷新", () => {
    const h = harness();
    h.emit(delta(""));
    h.emit(delta("首字"));
    expect(h.events).toEqual([delta("首字")]);
    h.emit(delta("甲"));
    vi.advanceTimersByTime(49);
    h.emit(delta("乙"));
    expect(h.events).toEqual([delta("首字")]);
    vi.advanceTimersByTime(1);
    expect(h.events).toEqual([delta("首字"), delta("甲乙")]);
    expect(vi.getTimerCount()).toBe(0);
    h.stop();
  });

  it("200 个连续正文分片完整合并，message 终态前同步排空且下一条消息首字不等待", () => {
    const h = harness();
    const text = "文".repeat(200);
    for (const part of text) h.emit(delta(part));
    h.emit({ type: "message.completed", stopReason: "stop" });
    h.emit(delta("下一条"));
    expect(h.events).toEqual([
      delta("文"),
      delta("文".repeat(199)),
      { type: "message.completed", stopReason: "stop" },
      delta("下一条"),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    h.stop();
  });

  it("thinking 保持 100ms 窗口，正文和思考切换不会混合或重排", () => {
    const h = harness();
    h.emit({ type: "thinking.delta", delta: "思考" });
    vi.advanceTimersByTime(99);
    expect(h.events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.events).toEqual([{ type: "thinking.delta", delta: "思考" }]);
    h.emit({ type: "thinking.delta", delta: "后续" });
    h.emit(delta("正文"));
    h.emit(delta("余文"));
    h.emit({ type: "thinking.delta", delta: "再思考" });
    h.emit({ type: "thinking.completed" });
    expect(h.events.slice(1)).toEqual([
      { type: "thinking.delta", delta: "后续" },
      delta("正文"),
      delta("余文"),
      { type: "thinking.delta", delta: "再思考" },
      { type: "thinking.completed" },
    ]);
    h.stop();
  });

  it("按 UTF-8 字节界限及时刷新，跨分片 Unicode 和正文内容保持完整", () => {
    const h = harness();
    h.emit(delta("首"));
    h.emit(delta("文".repeat(341)));
    h.emit(delta("a"));
    expect(h.events.at(-1)).toEqual(delta(`${"文".repeat(341)}a`));
    h.emit(delta("\ud83d"));
    h.emit(delta("\ude00"));
    vi.advanceTimersByTime(50);
    expect(h.events.at(-1)).toEqual(delta("😀"));
    h.stop();
  });

  it("单个大增量原样转发，前置缓冲不拼接、不切片绕过下游事件大小门禁", () => {
    const h = harness();
    const huge = "x".repeat(70 * 1_024);
    h.emit(delta("首"));
    h.emit(delta("待发布"));
    h.emit(delta(huge));
    expect(h.events).toEqual([delta("首"), delta("待发布"), delta(huge)]);
    expect(vi.getTimerCount()).toBe(0);
    h.stop();
  });

  const boundaries: RuntimeAgentEvent[] = [
    { type: "tool.started", callId: "call-a", name: "exec_command" },
    { type: "error", code: "ABORTED", message: "模型调用已中止" },
    { type: "message.completed", stopReason: "toolUse" },
    { type: "agent.settled" },
    {
      type: "turn.completed",
      assistant: {
        content: [{ type: "text", text: "首余" }],
        api: "faux",
        provider: "faux",
        model: "faux",
        stopReason: "stop",
        timestamp: 1,
      },
      toolResults: [],
    },
  ];
  it.each(boundaries)("控制边界 $type 到达前同步发布前驱文字", (boundary) => {
    const h = harness();
    h.emit(delta("首"));
    h.emit(delta("余"));
    h.emit(boundary);
    expect(h.events).toEqual([delta("首"), delta("余"), boundary]);
    expect(vi.getTimerCount()).toBe(0);
    h.stop();
  });

  it("多个订阅独占缓冲，关闭其中一个后不会迟到回调或影响其他订阅", () => {
    const h = harness();
    const other: RuntimeAgentEvent[] = [];
    const stopOther = subscribeBufferedRuntimeEvents(h.subscribe, (event) => other.push(event));
    h.emit(delta("首"));
    h.emit(delta("余"));
    h.stop();
    h.stop();
    vi.advanceTimersByTime(50);
    h.emit({ type: "agent.settled" });
    expect(h.events).toEqual([delta("首")]);
    expect(other).toEqual([delta("首"), delta("余"), { type: "agent.settled" }]);
    stopOther();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flush 回调内取消订阅后不再交付后续控制事件", () => {
    const h = harness();
    h.stop();
    const events: RuntimeAgentEvent[] = [];
    const stop = subscribeBufferedRuntimeEvents(h.subscribe, (event) => {
      events.push(event);
      if (event.type === "message.delta" && event.delta === "余") stop();
    });
    h.emit(delta("首"));
    h.emit(delta("余"));
    h.emit({ type: "tool.started", callId: "call-a", name: "exec_command" });
    expect(events).toEqual([delta("首"), delta("余")]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
