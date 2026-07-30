// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, Run, RunEvent } from "./api.js";
import {
  ActivityPanel,
  NavigationSidebar,
  RunStatusBadge,
  RunTimeline,
  shouldOpenActivityPanel,
  ThreadCreate,
} from "./workspace-view.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("工作台展示组件", () => {
  const running: Run = {
    id: "run-1",
    threadId: "thread-1",
    status: "running",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  it("将运行状态转换为面向用户的中文状态", () => {
    const html = renderToStaticMarkup(<RunStatusBadge status="waiting" />);

    expect(html).toContain("等待输入");
    expect(html).toContain("is-waiting");
  });

  it("右侧只保留本次运行产物，不渲染安全摘要或事件", () => {
    const artifacts: readonly Artifact[] = [];
    const html = renderToStaticMarkup(
      <ActivityPanel
        isOpen
        artifacts={artifacts}
        onToggle={() => undefined}
        onPreview={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(html).toContain("本次运行产物");
    expect(html).not.toContain("安全摘要");
    expect(html).not.toContain("activity-log");
  });

  it("运行组件仅展示紧凑进度，隐藏内部事件和工具调用标识", () => {
    const events: readonly RunEvent[] = [
      {
        eventId: "event-1",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.started",
        payload: { name: "web_search", callId: "call-private", secret: "不应展示" },
      },
      {
        eventId: "event-2",
        sequence: 2,
        occurredAt: "",
        kind: "agent_event",
        type: "received runtime event",
        payload: { secret: "仍不应展示" },
      },
    ];
    const html = renderToStaticMarkup(<RunTimeline run={running} events={events} />);

    expect(html).toContain("正在搜索网页");
    expect(html).toContain("已运行");
    expect(html).not.toContain("call-private");
    expect(html).not.toContain("不应展示");
    expect(html).not.toContain("received runtime event");
  });

  it("waiting 显示需要输入的问题与已有回复，不显示运行中动画或时长", () => {
    const waiting: Run = { ...running, status: "waiting" };
    const html = renderToStaticMarkup(
      <RunTimeline
        run={waiting}
        events={[
          {
            eventId: "event-1",
            sequence: 1,
            occurredAt: "",
            kind: "agent_event",
            type: "message.delta",
            payload: { delta: "请先确认范围。" },
          },
          {
            eventId: "event-2",
            sequence: 2,
            occurredAt: "",
            kind: "run_waiting",
            type: "run_waiting",
            payload: { question: "需要处理哪个地区？", checkpointId: "不应展示" },
          },
        ]}
      />,
    );

    expect(html).toContain("需要你的输入");
    expect(html).toContain("需要处理哪个地区？");
    expect(html).toContain("请先确认范围。");
    expect(html).not.toContain("已运行");
    expect(html).not.toContain("spin");
    expect(html).not.toContain("checkpointId");
  });

  it("新建会话不要求填写标题，后续点击仍然有效", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onCreate = vi.fn();

    act(() => {
      root.render(<ThreadCreate actionLoading={false} onCreate={onCreate} />);
    });
    const button = container.querySelector("button");
    if (button === null) throw new Error("未渲染新建会话按钮");
    act(() => {
      button.click();
      button.click();
    });
    expect(onCreate).toHaveBeenCalledTimes(2);

    act(() => {
      root.render(<ThreadCreate actionLoading onCreate={onCreate} />);
    });
    const disabledButton = container.querySelector("button");
    expect(disabledButton?.disabled).toBe(true);
    act(() => disabledButton?.click());
    expect(onCreate).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("无论屏幕尺寸，无产物时默认收起右侧产物栏", () => {
    expect(shouldOpenActivityPanel(true)).toBe(false);
    expect(shouldOpenActivityPanel(false)).toBe(false);
  });

  it("移动会话抽屉管理 inert、Escape 与焦点往返", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const returnFocusRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    const renderDrawer = (isOpen: boolean) => (
      <>
        <button ref={returnFocusRef} type="button">
          打开导航
        </button>
        <NavigationSidebar
          isCompact
          isOpen={isOpen}
          returnFocusRef={returnFocusRef}
          onClose={onClose}
        >
          <input data-navigation-initial-focus aria-label="标题" />
        </NavigationSidebar>
      </>
    );

    act(() => root.render(renderDrawer(true)));
    const input = container.querySelector<HTMLInputElement>("input");
    expect(document.activeElement).toBe(input);
    act(() => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.render(renderDrawer(false)));
    const sidebar = container.querySelector("aside");
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(sidebar?.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(returnFocusRef.current);

    act(() => root.unmount());
    container.remove();
  });
});
