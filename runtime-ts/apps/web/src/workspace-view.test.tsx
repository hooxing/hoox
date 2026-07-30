// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, RunEvent } from "./api.js";
import {
  ActivityPanel,
  InlineArtifactDelivery,
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
    const html = renderToStaticMarkup(
      <ActivityPanel
        isOpen
        events={events}
        modelWireTraces={[]}
        modelWireTraceHasMore={false}
        modelWireTraceUnavailable={false}
        onToggle={() => undefined}
        onLoadModelWireTrace={async () => new Uint8Array()}
        onLoadMoreModelWireTraces={async () => undefined}
      />,
    );

    expect(html).toContain("工具 read_file（call-1）完成");
    expect(html).not.toContain("不应展示");
  });

  it("交付物在 Agent 回复区内联展示，并保留预览和下载操作", () => {
    const artifacts: readonly Artifact[] = [
      {
        id: "artifact-1",
        name: "结果.txt",
        mediaType: "text/plain; charset=utf-8",
        status: "published",
        createdAt: "",
        updatedAt: "",
      },
    ];
    const html = renderToStaticMarkup(
      <InlineArtifactDelivery
        artifacts={artifacts}
        onPreview={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(html).toContain("inline-artifact-delivery");
    expect(html).toContain("本次回复的可下载产物");
    expect(html).toContain('aria-label="预览 结果.txt"');
    expect(html).toContain('aria-label="下载 结果.txt"');
  });

  it("没有交付物时不渲染内联交付区域", () => {
    const html = renderToStaticMarkup(
      <InlineArtifactDelivery
        artifacts={[]}
        onPreview={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("未发布或发布失败的交付物禁用预览和下载", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const artifacts: readonly Artifact[] = [
      {
        id: "artifact-publishing",
        name: "上传中.txt",
        mediaType: "text/plain; charset=utf-8",
        status: "publishing",
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "artifact-failed",
        name: "失败.txt",
        mediaType: "text/plain; charset=utf-8",
        status: "failed",
        createdAt: "",
        updatedAt: "",
      },
    ];

    act(() => {
      root.render(
        <InlineArtifactDelivery
          artifacts={artifacts}
          onPreview={() => undefined}
          onDownload={() => undefined}
        />,
      );
    });

    for (const artifact of artifacts) {
      expect(
        container.querySelector<HTMLButtonElement>(`[aria-label="预览 ${artifact.name}"]`)
          ?.disabled,
      ).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(`[aria-label="下载 ${artifact.name}"]`)
          ?.disabled,
      ).toBe(true);
    }
    act(() => root.unmount());
  });

  it("没有事件时显示运行中的明确空态", () => {
    const html = renderToStaticMarkup(<RunTimeline events={[]} />);

    expect(html).toContain("正在等待第一条活动");
  });

  it("在运行对话中将助手增量文本渲染为 Markdown", () => {
    const html = renderToStaticMarkup(
      <RunTimeline
        events={[
          {
            eventId: "event-markdown",
            sequence: 1,
            occurredAt: "",
            kind: "agent_event",
            type: "message.delta",
            payload: { delta: "## 结论\n\n- 支持 **Markdown**" },
          },
        ]}
      />,
    );

    expect(html).toContain("<h2>结论</h2>");
    expect(html).toContain("<li>支持 <strong>Markdown</strong></li>");
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
