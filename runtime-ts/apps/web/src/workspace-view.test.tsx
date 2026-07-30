// @vitest-environment jsdom

import { act, createRef, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, Run, RunEvent } from "./api.js";
import {
  ActivityPanel,
  ConversationComposer,
  InlineArtifactDelivery,
  NavigationSidebar,
  RunStatusBadge,
  RunTranscript,
  RunTimeline,
  shouldOpenActivityPanel,
  ThreadCreate,
  ThreadHeader,
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

  it("没有产物时不渲染右侧竖栏或无意义入口", () => {
    const artifacts: readonly Artifact[] = [];
    const html = renderToStaticMarkup(
      <ActivityPanel
        isOpen
        artifacts={artifacts}
        onToggle={() => undefined}
        onPreview={() => undefined}
        onDownload={() => undefined}
        returnFocusRef={createRef<HTMLButtonElement>()}
        fallbackFocusRef={createRef<HTMLElement>()}
      />,
    );

    expect(html).toBe("");
  });

  it("有产物时使用可关闭的覆盖式抽屉，关闭后移出辅助技术焦点", () => {
    const artifact: Artifact = {
      id: "artifact-1",
      name: "result.txt",
      status: "published",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const closed = renderToStaticMarkup(
      <ActivityPanel
        isOpen={false}
        artifacts={[artifact]}
        onToggle={() => undefined}
        onPreview={() => undefined}
        onDownload={() => undefined}
        returnFocusRef={createRef<HTMLButtonElement>()}
        fallbackFocusRef={createRef<HTMLElement>()}
      />,
    );

    expect(closed).toContain("activity-panel is-collapsed");
    expect(closed).toContain('aria-hidden="true"');
    expect(closed).toContain("inert");
  });

  it("交付物同时内联在 Agent 正文之后，抽屉不取代阅读路径", () => {
    const artifact: Artifact = {
      id: "artifact-inline",
      name: "summary.md",
      status: "published",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <InlineArtifactDelivery
        artifacts={[artifact]}
        onPreview={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(html).toContain("inline-artifact-delivery");
    expect(html).toContain("本次回复的可下载产物");
    expect(html).toContain("summary.md");
  });

  it("会话头部用文字化操作打开产物抽屉和归档", () => {
    const html = renderToStaticMarkup(
      <ThreadHeader
        thread={{
          id: "thread-1",
          title: "视觉改版",
          status: "active",
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        }}
        run={running}
        artifactCount={2}
        actionLoading={false}
        onArchive={() => undefined}
        onCancel={() => undefined}
        onOpenArtifacts={() => undefined}
        artifactTriggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(html).toContain("产物");
    expect(html).toContain("归档");
    expect(html).toContain("打开本次运行产物，共 2 个");
  });

  it("产物抽屉打开后接管焦点，Escape 或关闭按钮返回入口", () => {
    const artifact: Artifact = {
      id: "artifact-focus",
      name: "focus.txt",
      status: "published",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      const fallbackRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={fallbackRef} tabIndex={-1}>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            产物 1
          </button>
          <ActivityPanel
            isOpen={open}
            artifacts={[artifact]}
            onToggle={() => setOpen(false)}
            onPreview={() => undefined}
            onDownload={() => undefined}
            returnFocusRef={triggerRef}
            fallbackFocusRef={fallbackRef}
          />
        </div>
      );
    }

    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (trigger === null) throw new Error("未渲染产物入口");
    act(() => trigger.click());
    const close = container.querySelector<HTMLButtonElement>("[aria-label='关闭产物抽屉']");
    expect(document.activeElement).toBe(close);
    act(() => close?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    const closeAgain = container.querySelector<HTMLButtonElement>("[aria-label='关闭产物抽屉']");
    act(() => closeAgain?.click());
    expect(document.activeElement).toBe(trigger);
    act(() => root.unmount());
    container.remove();
  });

  it("切换会话移除产物入口时，抽屉关闭后回退到中部工作区", () => {
    const artifact: Artifact = {
      id: "artifact-switch",
      name: "switch.txt",
      status: "published",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [open, setOpen] = useState(false);
      const [showArtifacts, setShowArtifacts] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      const fallbackRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={fallbackRef} tabIndex={-1}>
          <button type="button" onClick={() => setShowArtifacts(false)}>
            切换会话
          </button>
          {showArtifacts && (
            <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
              产物 1
            </button>
          )}
          <ActivityPanel
            isOpen={open}
            artifacts={showArtifacts ? [artifact] : []}
            onToggle={() => setOpen(false)}
            onPreview={() => undefined}
            onDownload={() => undefined}
            returnFocusRef={triggerRef}
            fallbackFocusRef={fallbackRef}
          />
        </div>
      );
    }

    act(() => root.render(<Harness />));
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("产物"),
    );
    if (trigger === undefined) throw new Error("未渲染产物入口");
    act(() => trigger.click());
    const switchThread = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("切换会话"),
    );
    act(() => switchThread?.click());
    expect(document.activeElement).toBe(container.querySelector("div"));
    act(() => root.unmount());
    container.remove();
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

  it("运行中与失败后的部分正文始终在状态卡外完整可见", () => {
    const events: readonly RunEvent[] = [
      {
        eventId: "event-body",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "message.delta",
        payload: { delta: "## 已完成的部分\n\n仍保留这段正文。" },
      },
    ];
    for (const run of [running, { ...running, status: "failed" as const }]) {
      const html = renderToStaticMarkup(
        <>
          <RunTimeline run={run} events={events} />
          <RunTranscript events={events} />
        </>,
      );
      expect(html).toContain("已完成的部分");
      expect(html).toContain("仍保留这段正文。");
      expect(html.indexOf("run-progress")).toBeLessThan(html.indexOf("assistant-transcript"));
      expect(html).not.toContain("final-answer");
    }
  });

  it("waiting 状态卡不混入问题或正文，普通 Agent 正文保留二者", () => {
    const waiting: Run = { ...running, status: "waiting" };
    const events: readonly RunEvent[] = [
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
    ];
    const statusHtml = renderToStaticMarkup(<RunTimeline run={waiting} events={events} />);
    const transcriptHtml = renderToStaticMarkup(<RunTranscript events={events} />);

    expect(statusHtml).toContain("需要你的输入");
    expect(statusHtml).not.toContain("需要处理哪个地区？");
    expect(statusHtml).not.toContain("请先确认范围。");
    expect(statusHtml).not.toContain("spin");
    expect(transcriptHtml).toContain("需要处理哪个地区？");
    expect(transcriptHtml).toContain("请先确认范围。");
    expect(transcriptHtml).toContain("assistant-transcript");
    expect(transcriptHtml).not.toContain("run-progress");
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

  it("任务输入框固定尺寸，发送操作不会被纵向拖拽推出应用壳", () => {
    const html = renderToStaticMarkup(
      <ConversationComposer
        input=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("resize:none");
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
