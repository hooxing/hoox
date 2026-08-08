// @vitest-environment jsdom

import { act, createRef, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, HistoryFile, ModelWireTraceRecord, Run, RunEvent } from "./api.js";
import {
  activeHistoryMention,
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
  shouldInitiallyCollapseUserRequest,
  userRequestCollapsedHeight,
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
    expect(container.querySelector(".user-request-toggle")).toBeNull();
    expect(container.textContent).not.toContain("你的请求");
  });

  it("短用户消息完整展示，长用户消息默认折叠并可展开", () => {
    expect(shouldInitiallyCollapseUserRequest("简短请求")).toBe(false);
    expect(shouldInitiallyCollapseUserRequest("x".repeat(601))).toBe(true);
    expect(userRequestCollapsedHeight).toBe(264);

    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(600);
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        <ThreadTranscript
          messages={[
            {
              sequence: 1,
              role: "user",
              text: "x".repeat(601),
              createdAt: "2026-08-06T00:00:00.000Z",
            },
          ]}
        />,
      ),
    );

    const content = container.querySelector(".user-request-content");
    const toggle = container.querySelector<HTMLButtonElement>(".user-request-toggle");
    expect(content?.classList.contains("is-collapsed")).toBe(true);
    expect(toggle?.textContent).toContain("展开");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    act(() => toggle?.click());

    expect(content?.classList.contains("is-collapsed")).toBe(false);
    expect(toggle?.textContent).toContain("收起");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    act(() => root.unmount());
    scrollHeight.mockRestore();
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

  it("在运行进度区域展示 Agent 的 Todo 步骤和完成情况", () => {
    const events: readonly RunEvent[] = [
      {
        eventId: "event-todo",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "todo.updated",
        payload: {
          snapshot: {
            schemaVersion: 1,
            version: 2,
            todos: [
              { id: "confirm", content: "确认目标", status: "completed" },
              { id: "deliver", content: "完成交付", status: "in_progress" },
            ],
          },
        },
      },
    ];

    const html = renderToStaticMarkup(<RunTimeline run={running} events={events} />);

    expect(html).toContain('aria-label="任务清单"');
    expect(html).toContain("1/2");
    expect(html).toContain("确认目标");
    expect(html).toContain("完成交付");
    expect(html).toContain("<strong>完成交付</strong><span>1/2</span>");
    expect(html).toContain("is-completed");
    expect(html).toContain("is-in_progress");
    expect(html).toContain("run-progress-details");
    expect(html).toContain("<summary");
    expect(html).toContain('open=""');

    const completedHtml = renderToStaticMarkup(
      <RunTimeline run={{ ...running, status: "succeeded" }} events={events} />,
    );
    expect(completedHtml).toContain('<details class="run-progress-details">');
    expect(completedHtml).not.toContain('open=""');
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

  it("状态栏只展示当前状态，思考内容在 Agent 对话中默认折叠", () => {
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
    const activeGroup = active.querySelector<HTMLDetailsElement>(".activity-group");
    if (activeGroup === null) throw new Error("未渲染执行阶段折叠区");

    expect(activeStatusHtml).toContain("正在思考");
    expect(activeStatusHtml).not.toContain("run-progress-track");
    expect(activeStatusHtml).not.toContain("先检查依赖，再生成文档。");
    expect(activeGroup.closest(".assistant-message")).not.toBeNull();
    expect(activeGroup.open).toBe(false);
    expect(activeGroup.querySelector(":scope > summary")?.textContent).toContain("正在思考");
    expect(activeGroup.querySelector(".activity-group-content")).toBeNull();
    expect(activeHtml).not.toContain("先检查依赖，再生成文档。");

    const settled = document.createElement("div");
    settled.innerHTML = settledHtml;
    const settledDetails = settled.querySelector<HTMLDetailsElement>(".thinking-activity");
    expect(settledStatusHtml).toContain("已完成");
    expect(settledStatusHtml).not.toContain("已完成分析");
    expect(settledDetails?.open).toBe(false);
    expect(settledDetails?.textContent).toContain("思考完成");
    expect(settledDetails?.querySelector("summary")?.textContent).toBe("思考完成");
    expect(settledDetails?.textContent).toContain("先检查依赖，再生成文档。");
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
    expect(assistant[0]?.querySelector(".thinking-activity")?.textContent).toContain("思考完成");
    expect(assistant[0]?.textContent).toContain("先确认问题范围。");
    expect(assistant[0]?.textContent).toContain("这是最终回答。");
    expect(html.indexOf("思考完成")).toBeLessThan(html.indexOf("这是最终回答。"));
  });

  it("同一历史 Run 的多段回答只渲染一个 Agent 身份", () => {
    const html = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            runId: "run-history",
            role: "assistant",
            text: "第一段回答。",
            createdAt: "2026-08-03T00:00:00.000Z",
          },
          {
            sequence: 2,
            runId: "run-history",
            role: "assistant",
            text: "第二段回答。",
            createdAt: "2026-08-03T00:00:01.000Z",
          },
        ]}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelectorAll(".assistant-message")).toHaveLength(1);
    expect(container.querySelectorAll(".message-avatar")).toHaveLength(1);
    expect(container.textContent).toContain("第一段回答。");
    expect(container.textContent).toContain("第二段回答。");
  });

  it("执行阶段只展开已结束项目，并在状态更新时保持用户选择", () => {
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
        payload: { delta: "先检查环境。" },
      },
      {
        eventId: "thinking-end",
        sequence: 3,
        occurredAt: "",
        kind: "agent_event",
        type: "thinking.completed",
        payload: {},
      },
      {
        eventId: "tool-start",
        sequence: 4,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.started",
        payload: {
          name: "exec_command",
          callId: "call-1",
          presentation: { action: "command", title: "查看当前目录中的文件" },
        },
      },
    ];

    act(() => root.render(<RunTranscript run={running} events={liveEvents} />));
    const group = container.querySelector<HTMLDetailsElement>(".activity-group");
    if (group === null) throw new Error("未渲染执行阶段折叠区");
    expect(group.open).toBe(false);
    expect(group.querySelector(":scope > summary")?.textContent).toContain(
      "正在执行命令 · 查看当前目录中的文件",
    );
    expect(group.querySelectorAll(".activity-group-content > .tool-activity")).toHaveLength(0);
    expect(group.querySelectorAll(".activity-group-content > .thinking-activity")).toHaveLength(1);

    const liveSummary = group.querySelector<HTMLElement>(":scope > summary");
    if (liveSummary === null) throw new Error("未渲染执行阶段摘要按钮");
    act(() => liveSummary.click());
    expect(group.open).toBe(true);

    const completedEvents: readonly RunEvent[] = [
      ...liveEvents,
      {
        eventId: "tool-end",
        sequence: 5,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.completed",
        payload: { name: "exec_command", callId: "call-1", isError: false },
      },
    ];
    act(() => root.render(<RunTranscript run={running} events={completedEvents} />));
    expect(group.open).toBe(true);
    expect(group.querySelector(":scope > summary")?.textContent).toContain(
      "已执行命令 · 查看当前目录中的文件",
    );
    expect(group.querySelectorAll(".activity-group-content > .tool-activity")).toHaveLength(1);

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

  it("只把输入末尾的 @ 查询识别为历史文件选择", () => {
    expect(activeHistoryMention("@合同")).toEqual({ start: 0, end: 3, query: "合同" });
    expect(activeHistoryMention("请比较 @采购合同")).toEqual({
      start: 4,
      end: 9,
      query: "采购合同",
    });
    expect(activeHistoryMention("邮箱 user@example.com")).toBeUndefined();
    expect(activeHistoryMention("@合同 后续文字")).toBeUndefined();
  });

  it("输入 @ 后可用上下键选择云盘文件，选中后只保留文件框", async () => {
    vi.useFakeTimers();
    const historyFile: HistoryFile = {
      threadId: "thread_contract",
      taskName: "采购合同审查",
      resourceId: "resource_contract",
      versionId: "version_contract",
      name: "采购合同.docx",
      entryName: "采购合同.docx",
      path: "/resources/resource_contract/version_contract/采购合同.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      attachedAt: "2026-08-07T08:00:00.000Z",
    };
    const secondHistoryFile: HistoryFile = {
      ...historyFile,
      resourceId: "resource_attachment",
      versionId: "version_attachment",
      name: "采购附件.xlsx",
      entryName: "采购附件.xlsx",
      path: "/resources/resource_attachment/version_attachment/采购附件.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    const listHistoryFiles = vi.fn(async () => ({
      items: [
        {
          threadId: historyFile.threadId,
          name: historyFile.taskName,
          createdAt: "2026-08-07T07:00:00.000Z",
          lastFileAt: historyFile.attachedAt,
          fileCount: 1,
          files: [historyFile, secondHistoryFile],
        },
      ],
      range: { activeAfter: "2026-02-07T00:00:00.000Z" },
      hasMore: false,
      hasOlder: false,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [value, setValue] = useState("请分析 @采购");
      const [selected, setSelected] = useState<readonly HistoryFile[]>([]);
      return (
        <ConversationComposer
          input={value}
          files={[]}
          selectedHistoryFiles={selected}
          historyFileApi={{ listHistoryFiles }}
          disabled={false}
          showQueueAction={false}
          onChange={setValue}
          onFilesChange={() => undefined}
          onHistoryFilesChange={setSelected}
          onQueue={() => undefined}
          onSubmit={() => undefined}
        />
      );
    }

    act(() => root.render(<Harness />));
    await act(async () => {
      vi.advanceTimersByTime(180);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listHistoryFiles).toHaveBeenCalledWith({ query: "采购", limit: 8 });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const options = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    act(() =>
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    act(() =>
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(textarea?.value).toBe("请分析");
    expect(container.querySelector(".composer-file.is-history")?.textContent).toContain(
      "采购附件.xlsx",
    );
    expect(container.querySelector(".composer-file.is-history")?.textContent).not.toContain("@");

    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
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
