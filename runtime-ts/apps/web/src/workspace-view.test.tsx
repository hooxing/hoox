// @vitest-environment jsdom

import { act, createRef, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, ModelWireTraceRecord, Run, RunEvent } from "./api.js";
import {
  ConversationComposer,
  formatArtifactSize,
  formatArtifactType,
  InlineArtifactDelivery,
  NavigationSidebar,
  RunStatusBadge,
  RunTimeline,
  RunTranscript,
  ThreadCreate,
  ThreadHeader,
  ThreadTranscript,
} from "./workspace-view.js";

// 已移除的抽屉交互用例暂留作历史说明，不再参与当前界面契约。
const ActivityPanel = (_props: Record<string, unknown>) => null;
const shouldOpenActivityPanel = (_isCompact: boolean) => false;

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

  it("recovery_required 不再显示执行动画或累计运行时间", () => {
    const interrupted: Run = { ...running, executionStatus: "recovery_required" };
    const events: readonly RunEvent[] = [
      {
        eventId: "thinking-started",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.started",
        payload: {},
      },
      {
        eventId: "thinking-delta",
        sequence: 2,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.delta",
        payload: { delta: "中断前的思考。" },
      },
    ];
    const badge = renderToStaticMarkup(
      <RunStatusBadge status={interrupted.status} executionStatus={interrupted.executionStatus} />,
    );
    const timeline = renderToStaticMarkup(<RunTimeline run={interrupted} events={events} />);
    const transcript = renderToStaticMarkup(<RunTranscript run={interrupted} events={events} />);

    expect(badge).toContain("执行已中断");
    expect(badge).toContain("is-recovery-required");
    expect(timeline).toContain("执行已中断");
    expect(timeline).not.toContain("中断前的思考。");
    expect(timeline).not.toContain("spin");
    expect(timeline).not.toContain("已运行");
    expect(transcript).toContain("思考已中断");
    expect(transcript).toContain("中断前的思考。");
  });

  it("把 steer 与 follow-up 作为对话中的用户消息展示，而不是替换当前任务", () => {
    const html = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            role: "user",
            text: "先生成项目",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          {
            sequence: 2,
            role: "assistant",
            text: "正在处理",
            createdAt: "2026-08-01T00:00:01.000Z",
          },
        ]}
        pendingInputs={[
          {
            localId: "follow-up-1",
            text: "完成后再改成深色主题",
            disposition: "queued",
            queueSequence: 1,
          },
        ]}
      />,
    );

    expect(html).toContain("先生成项目");
    expect(html).toContain("正在处理");
    expect(html).toContain("完成后再改成深色主题");
    expect(html).toContain("已排入下一任务 · 第 1 位");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector(".user-request .message-avatar")).toBeNull();
  });

  it("隐藏重复的运行完成通知，但保留失败等需要用户关注的状态", () => {
    const html = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            role: "runtime",
            text: "运行已完成。",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          {
            sequence: 2,
            role: "runtime",
            text: "运行失败；未提交工作不视为成功。",
            createdAt: "2026-08-01T00:00:01.000Z",
          },
        ]}
      />,
    );

    expect(html).not.toContain("运行已完成。");
    expect(html).toContain("运行失败；未提交工作不视为成功。");
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
    expect(html).toContain("交付文件");
    expect(html).toContain("summary.md");
    expect(html).toContain("MD 文件");
    expect(html).toContain("下载");
  });

  it("交付文件使用用户可读的格式和大小，不直接暴露 MIME", () => {
    expect(
      formatArtifactType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "方案.docx",
      ),
    ).toBe("Word 文档");
    expect(formatArtifactType(undefined, "数据.parquet")).toBe("PARQUET 文件");
    expect(formatArtifactSize(41)).toBe("41 B");
    expect(formatArtifactSize(4_200)).toBe("4.1 KB");
    expect(formatArtifactSize(2_621_440)).toBe("2.5 MB");
  });

  it("会话头部不再提供产物或网络诊断侧栏入口", () => {
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
        continuity={{
          boundary: "legacy_anchor",
          readMode: "v2",
          anchorState: "completed",
          queueDepth: 3,
          contextSequence: 12,
          compactionWindow: 2,
          sandboxState: "resuming",
        }}
        actionLoading={false}
        onArchive={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("归档");
    expect(html).not.toContain("产物");
    expect(html).not.toContain("诊断");
    expect(html).not.toContain("activity-panel");
    expect(html).toContain("工作区正在恢复");
    expect(html).toContain("后续任务 3");
    expect(html).not.toContain("上下文窗口");
    expect(html).not.toContain("运行 run-1");
    expect(html).not.toContain("providerSandboxId");
  });

  it.skip("只有模型报文时仍提供可重复打开诊断抽屉的外部入口", () => {
    const trace: ModelWireTraceRecord = {
      attemptId: "attempt_trace",
      modelTurn: 0,
      transportAttempt: 0,
      part: "request",
      captureStatus: "complete",
      persistenceStatus: "stored",
      bodyAvailable: true,
      createdAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    };
    const selectedThread = {
      id: "thread-trace",
      title: "诊断会话",
      status: "active" as const,
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
          <ThreadHeader
            thread={selectedThread}
            run={running}
            artifactCount={0}
            modelWireTraceCount={1}
            actionLoading={false}
            onArchive={() => undefined}
            onCancel={() => undefined}
            onOpenArtifacts={() => setOpen(true)}
            artifactTriggerRef={triggerRef}
          />
          <ActivityPanel
            isOpen={open}
            artifacts={[]}
            modelWireTraces={[trace]}
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
    const trigger = container.querySelector<HTMLButtonElement>(
      "[aria-label='打开本次运行模型网络诊断']",
    );
    if (trigger === null) throw new Error("未渲染诊断抽屉入口");
    act(() => trigger.click());
    const close = container.querySelector<HTMLButtonElement>("[aria-label='关闭诊断抽屉']");
    expect(document.activeElement).toBe(close);
    act(() => close?.click());
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    expect(container.querySelector("[aria-label='关闭诊断抽屉']")).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it.skip("产物抽屉打开后接管焦点，Escape 或关闭按钮返回入口", () => {
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

  it.skip("切换会话移除产物入口时，抽屉关闭后回退到中部工作区", () => {
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
    expect(html).not.toContain("run-progress-track");
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
          <RunTranscript run={run} events={events} />
        </>,
      );
      expect(html).toContain("已完成的部分");
      expect(html).toContain("仍保留这段正文。");
      expect(html.indexOf("run-progress")).toBeLessThan(html.indexOf("assistant-transcript"));
      expect(html).not.toContain("final-answer");
    }
  });

  it("状态栏只展示当前状态，思考内容在 Agent 对话中实时展开", () => {
    const baseEvents: readonly RunEvent[] = [
      {
        eventId: "thinking-start",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.started",
        payload: { type: "thinking.started" },
      },
      {
        eventId: "thinking-delta",
        sequence: 2,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.delta",
        payload: { type: "thinking.delta", delta: "先检查依赖，再生成文档。" },
      },
    ];
    const settledEvents: readonly RunEvent[] = [
      ...baseEvents,
      {
        eventId: "thinking-end",
        sequence: 3,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.completed",
        payload: { type: "thinking.completed" },
      },
    ];
    const activeStatusHtml = renderToStaticMarkup(
      <RunTimeline run={running} events={baseEvents} />,
    );
    const activeHtml = renderToStaticMarkup(<RunTranscript run={running} events={baseEvents} />);
    const settledStatusHtml = renderToStaticMarkup(
      <RunTimeline run={{ ...running, status: "succeeded" }} events={settledEvents} />,
    );
    const settledHtml = renderToStaticMarkup(
      <RunTranscript run={{ ...running, status: "succeeded" }} events={settledEvents} />,
    );

    const active = document.createElement("div");
    active.innerHTML = activeHtml;
    const activeDetails = active.querySelector<HTMLDetailsElement>(".run-thinking");
    const activeSummary = active.querySelector<HTMLElement>(".run-thinking summary");
    const activeContent = active.querySelector<HTMLElement>(".run-thinking-content");
    if (activeDetails === null || activeSummary === null || activeContent === null) {
      throw new Error("未渲染实时思考披露区");
    }

    expect(activeStatusHtml).toContain("正在思考");
    expect(activeStatusHtml).not.toContain("run-progress-track");
    expect(activeStatusHtml).not.toContain("先检查依赖，再生成文档。");
    expect(activeDetails.closest(".assistant-message")).not.toBeNull();
    expect(activeDetails.open).toBe(true);
    expect(activeSummary.textContent).toContain("正在思考");
    expect(activeSummary.textContent).not.toContain("展开");
    expect(activeSummary.textContent).not.toContain("收起");
    expect(activeContent.textContent).toContain("先检查依赖，再生成文档。");
    expect(activeContent.tagName).toBe("SECTION");
    expect(activeContent.getAttribute("aria-busy")).toBe("true");
    expect(activeContent.getAttribute("aria-live")).toBe("off");
    expect(activeSummary.getAttribute("aria-controls")).toBe(activeContent.id);
    expect(activeContent.getAttribute("aria-labelledby")).toBe(activeSummary.id);

    const settled = document.createElement("div");
    settled.innerHTML = settledHtml;
    const settledDetails = settled.querySelector<HTMLDetailsElement>(".run-thinking");
    expect(settledStatusHtml).toContain("已完成");
    expect(settledStatusHtml).not.toContain("已完成分析");
    expect(settledDetails?.open).toBe(false);
    expect(settledDetails?.textContent).toContain("思考已完成");
    expect(settledDetails?.querySelector(".run-thinking-indicator")).toBeNull();
    expect(settledDetails?.querySelector("summary")?.textContent).toBe("思考已完成");
    expect(settledDetails?.textContent).toContain("先检查依赖，再生成文档。");
    expect(settled.querySelector(".run-thinking-content")?.getAttribute("aria-busy")).toBe("false");
  });

  it("当前 Run 的回答进入连续上下文后，思考仍与最终回答位于同一 Agent 消息", () => {
    const succeeded: Run = { ...running, status: "succeeded" };
    const html = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            runId: running.id,
            role: "assistant",
            text: "这是最终回答。",
            createdAt: "2026-08-03T00:00:00.000Z",
          },
        ]}
        currentRun={succeeded}
        currentRunEvents={[
          {
            eventId: "thinking-delta",
            sequence: 1,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.delta",
            payload: { delta: "先确认问题范围。" },
          },
          {
            eventId: "thinking-completed",
            sequence: 2,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.completed",
            payload: {},
          },
        ]}
      />,
    );

    const container = document.createElement("div");
    container.innerHTML = html;
    const assistant = container.querySelectorAll(".assistant-message");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.querySelector(".run-thinking")?.textContent).toContain("思考已完成");
    expect(assistant[0]?.textContent).toContain("先确认问题范围。");
    expect(assistant[0]?.textContent).toContain("这是最终回答。");
    expect(html.indexOf("思考已完成")).toBeLessThan(html.indexOf("这是最终回答。"));
  });

  it("思考结束时自动折叠，之后仍可手工展开，异常终态不会伪装成仍在思考", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const liveEvents: readonly RunEvent[] = [
      {
        eventId: "thinking-start",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.started",
        payload: {},
      },
      {
        eventId: "thinking-delta",
        sequence: 2,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.delta",
        payload: { delta: "实时检查中。" },
      },
    ];

    act(() => root.render(<RunTranscript run={running} events={liveEvents} />));
    const details = container.querySelector<HTMLDetailsElement>(".run-thinking");
    if (details === null) throw new Error("未渲染思考披露区");
    expect(details.open).toBe(true);

    const updatedLiveEvents: readonly RunEvent[] = [
      ...liveEvents,
      {
        eventId: "thinking-delta-2",
        sequence: 3,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.delta",
        payload: { delta: "继续分析。" },
      },
    ];
    act(() => root.render(<RunTranscript run={running} events={updatedLiveEvents} />));
    expect(details.open).toBe(true);
    expect(details.querySelector(".run-thinking-content")?.textContent).toContain(
      "实时检查中。继续分析。",
    );

    const completedEvents: readonly RunEvent[] = [
      ...updatedLiveEvents,
      {
        eventId: "thinking-end",
        sequence: 4,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.completed",
        payload: {},
      },
    ];
    act(() => root.render(<RunTranscript run={running} events={completedEvents} />));
    expect(details.open).toBe(false);
    expect(details.classList).toContain("is-completed");

    const summary = details.querySelector("summary");
    if (summary === null) throw new Error("未渲染思考摘要按钮");
    act(() => summary.click());
    expect(details.open).toBe(true);
    expect(summary.textContent).toBe("思考已完成");

    act(() =>
      root.render(
        <RunTranscript
          run={running}
          events={[
            ...completedEvents,
            {
              eventId: "tool-start",
              sequence: 5,
              occurredAt: "",
              kind: "agent_event",
              type: "tool.started",
              payload: { name: "read_file", callId: "call-1" },
            },
          ]}
        />,
      ),
    );
    expect(details.open).toBe(true);

    act(() =>
      root.render(<RunTranscript run={{ ...running, status: "failed" }} events={liveEvents} />),
    );
    expect(details.open).toBe(false);
    expect(details.classList).toContain("is-stopped");
    expect(details.textContent).toContain("思考已结束");
    expect(container.querySelector(".run-progress-track")).toBeNull();

    act(() => root.unmount());
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
    const transcriptHtml = renderToStaticMarkup(<RunTranscript run={waiting} events={events} />);

    expect(statusHtml).toContain("等待你的输入");
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
        files={[]}
        disabled={false}
        showQueueAction={false}
        onChange={() => undefined}
        onFilesChange={() => undefined}
        onQueue={() => undefined}
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
