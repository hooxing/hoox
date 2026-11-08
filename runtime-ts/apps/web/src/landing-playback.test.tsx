// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConversationBlocks } from "./event-view.js";
import { BookCase } from "./landing-book-case.js";
import { bookPlaybackFrame, playbackDurationMs } from "./landing-playback.js";

let container: HTMLDivElement;
let root: Root;
let intersect: IntersectionObserverCallback;
const disconnect = vi.fn();
let hidden = false;
let reducedMotion = false;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hidden = false;
  reducedMotion = false;
  disconnect.mockClear();
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: reducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = async () => {
  await act(async () => root.render(<BookCase />));
};
const show = async (visible = true) => {
  await act(async () =>
    intersect(
      [{ isIntersecting: visible } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
};
const advance = async (time: number) => {
  await act(async () => vi.advanceTimersByTime(time));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === label);
const click = async (label: string) => {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => target?.click());
};

describe("公开案例的本地流式回放", () => {
  it("四秒内完成三个阶段，保留流式输出与末尾交付边界", () => {
    expect(playbackDurationMs).toBe(3_840);
    expect(bookPlaybackFrame(256).finished).toBe(false);
    expect(
      bookPlaybackFrame(256).events.find((event) => event.type === "message.delta")?.payload,
    ).toEqual({ delta: "正在读取资料，梳" });
    expect(
      bookPlaybackFrame(1_280).events.filter((event) => event.type === "tool.started"),
    ).toHaveLength(2);
    expect(
      bookPlaybackFrame(2_560).events.filter((event) => event.type === "tool.started"),
    ).toHaveLength(3);
    expect(bookPlaybackFrame(3_808).finished).toBe(false);
    expect(bookPlaybackFrame(3_840).finished).toBe(true);
  });
  it("进入可见区域才逐步输出，完成后交付文件，不访问用户 API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await render();
    const initial = container.querySelector(".landing-transcript")?.textContent;
    expect(container.textContent).toContain("执行回放");
    expect(container.querySelector(".run-status.is-running")).not.toBeNull();
    expect(container.querySelector(".inline-artifact-delivery")).toBeNull();
    await advance(1_000);
    expect(container.querySelector(".landing-transcript")?.textContent).toBe(initial);
    await show();
    await advance(256);
    expect(container.querySelector(".agent-answer-block")?.textContent).toBe("正在读取资料，梳");
    expect(container.querySelector(".inline-artifact-delivery")).toBeNull();
    await advance(playbackDurationMs);
    expect(container.querySelector(".run-status.is-succeeded")).not.toBeNull();
    expect(container.querySelector(".inline-artifact-delivery")?.textContent).toContain(
      "国富论-思维导图.html",
    );
    expect(container.querySelector(".inline-artifact-delivery")?.textContent).toContain(
      "国富论-思维导图.md",
    );
    expect(container.querySelector(".artifact-actions")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("允许暂停、继续及重播，重播清除上一轮交付状态", async () => {
    await render();
    await show();
    await advance(800);
    await click("暂停回放");
    const paused = container.querySelector(".landing-transcript")?.textContent;
    expect(container.textContent).toContain("回放已暂停");
    await advance(5_000);
    expect(container.querySelector(".landing-transcript")?.textContent).toBe(paused);
    await click("继续回放");
    await advance(playbackDurationMs);
    await click("再次回放");
    expect(container.querySelector(".inline-artifact-delivery")).toBeNull();
    expect(container.querySelector(".run-status.is-running")).not.toBeNull();
    expect(container.querySelector(".agent-answer-block")?.textContent).toBe("正");
  });
  it("离屏、后台标签页和卸载均停止计时", async () => {
    await render();
    await show();
    await advance(640);
    await show(false);
    const offscreen = container.querySelector(".landing-transcript")?.textContent;
    await advance(1_000);
    expect(container.querySelector(".landing-transcript")?.textContent).toBe(offscreen);
    await show();
    hidden = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(1_000);
    expect(container.querySelector(".landing-transcript")?.textContent).toBe(offscreen);
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(640);
    expect(container.querySelector(".landing-transcript")?.textContent).not.toBe(offscreen);
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
  it("减少动态效果时直接展示完整交付，不自动播放", async () => {
    reducedMotion = true;
    await render();
    expect(container.querySelector(".inline-artifact-delivery")).not.toBeNull();
    expect(container.querySelector(".run-status.is-running")).toBeNull();
    expect(button("再次回放")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("回放事件使用实际工具投影，最终没有未完成动作", () => {
    const blocks = buildConversationBlocks(bookPlaybackFrame(playbackDurationMs).events);
    expect(blocks.filter((block) => block.type === "tool").map((block) => block.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(blocks.filter((block) => block.type === "answer").map((block) => block.text)).toContain(
      "两份思维导图已准备好。",
    );
  });
});
