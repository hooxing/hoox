// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, RunEvent } from "./api.js";
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
  it("将运行状态转换为面向用户的中文状态", () => {
    const html = renderToStaticMarkup(<RunStatusBadge status="waiting" />);

    expect(html).toContain("等待输入");
    expect(html).toContain("is-waiting");
  });

  it("活动面板只使用事件安全摘要，不渲染原始工具回执", () => {
    const events: readonly RunEvent[] = [
      {
        eventId: "event-1",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.completed",
        payload: { name: "read_file", callId: "call-1", secret: "不应展示" },
      },
    ];
    const artifacts: readonly Artifact[] = [];
    const html = renderToStaticMarkup(
      <ActivityPanel
        isOpen
        events={events}
        artifacts={artifacts}
        modelWireTraces={[]}
        modelWireTraceHasMore={false}
        modelWireTraceUnavailable={false}
        onToggle={() => undefined}
        onPreview={() => undefined}
        onDownload={() => undefined}
        onLoadModelWireTrace={async () => new Uint8Array()}
        onLoadMoreModelWireTraces={async () => undefined}
      />,
    );

    expect(html).toContain("工具 read_file（call-1）完成");
    expect(html).not.toContain("不应展示");
  });

  it("没有事件时显示运行中的明确空态", () => {
    const html = renderToStaticMarkup(<RunTimeline events={[]} />);

    expect(html).toContain("正在等待第一条活动");
  });

  it("创建请求进行中时禁用标题输入并阻止 Enter 重入", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onCreate = vi.fn();

    act(() => {
      root.render(
        <ThreadCreate
          title="分析任务"
          actionLoading={false}
          onChange={() => undefined}
          onCreate={onCreate}
        />,
      );
    });
    const input = container.querySelector("input");
    if (input === null) throw new Error("未渲染标题输入框");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ThreadCreate
          title="分析任务"
          actionLoading
          onChange={() => undefined}
          onCreate={onCreate}
        />,
      );
    });
    const disabledInput = container.querySelector("input");
    expect(disabledInput?.disabled).toBe(true);
    act(() =>
      disabledInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("窄屏首次进入时默认收起活动侧栏", () => {
    expect(shouldOpenActivityPanel(true)).toBe(false);
    expect(shouldOpenActivityPanel(false)).toBe(true);
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
