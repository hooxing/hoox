// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLandingClock } from "./landing-motion.js";

let container: HTMLDivElement;
let root: Root;
let intersect: IntersectionObserverCallback;
let changeMotion: () => void;
let hidden = false;
let reducedMotion = false;
const disconnect = vi.fn();
const removeMotionListener = vi.fn();

function Scene() {
  const clock = useLandingClock(1_000, 100);
  return (
    <section ref={clock.targetRef} data-motion={clock.motionState}>
      <output>{clock.elapsed}</output>
      <button type="button" onClick={clock.togglePause}>
        暂停或继续
      </button>
      <button type="button" onClick={clock.replay}>
        重播
      </button>
    </section>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hidden = false;
  reducedMotion = false;
  disconnect.mockClear();
  removeMotionListener.mockClear();
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reducedMotion;
    },
    addEventListener: (_type: string, listener: () => void) => {
      changeMotion = listener;
    },
    removeEventListener: removeMotionListener,
  }));
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
  await act(async () => root.render(<Scene />));
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
const elapsed = () => Number(container.querySelector("output")?.textContent);
const click = async (index: number) => {
  await act(async () => container.querySelectorAll("button")[index]?.click());
};

describe("首页机制演示的播放边界", () => {
  it("可见后只播放一次，结束清理计时器，重播从起点开始", async () => {
    await render();
    await advance(500);
    expect(elapsed()).toBe(0);
    await show();
    await advance(400);
    expect(elapsed()).toBe(400);
    expect(container.querySelector("section")?.dataset.motion).toBe("playing");
    await advance(1_000);
    expect(elapsed()).toBe(1_000);
    expect(container.querySelector("section")?.dataset.motion).toBe("complete");
    expect(vi.getTimerCount()).toBe(0);
    await show(false);
    await show();
    expect(elapsed()).toBe(1_000);
    await click(1);
    expect(elapsed()).toBe(0);
    await advance(100);
    expect(elapsed()).toBe(100);
  });
  it("离屏、后台与人工暂停不消耗时间，恢复不重放", async () => {
    await render();
    await show();
    await advance(300);
    await show(false);
    await advance(500);
    expect(elapsed()).toBe(300);
    await show();
    hidden = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(500);
    expect(elapsed()).toBe(300);
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await click(0);
    await advance(500);
    expect(elapsed()).toBe(300);
    expect(container.querySelector("section")?.dataset.motion).toBe("paused");
    await click(0);
    await advance(200);
    expect(elapsed()).toBe(500);
  });
  it("实时响应减少动态效果偏好，直接呈现结果且不允许重播动画", async () => {
    await render();
    await show();
    await advance(200);
    reducedMotion = true;
    await act(async () => changeMotion());
    expect(elapsed()).toBe(1_000);
    expect(vi.getTimerCount()).toBe(0);
    await click(1);
    expect(elapsed()).toBe(1_000);
    reducedMotion = false;
    await act(async () => changeMotion());
    expect(elapsed()).toBe(0);
    await advance(100);
    expect(elapsed()).toBe(100);
  });
  it("缺少动画 API 时展示完整结果，卸载清理监听器与计时器", async () => {
    await render();
    await show();
    await advance(100);
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeMotionListener).toHaveBeenCalledWith("change", changeMotion);
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
    vi.stubGlobal("IntersectionObserver", undefined);
    await render();
    expect(elapsed()).toBe(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
