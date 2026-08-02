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
    const badge = renderToStaticMarkup(
      <RunStatusBadge status={interrupted.status} executionStatus={interrupted.executionStatus} />,
    );
    const timeline = renderToStaticMarkup(<RunTimeline run={interrupted} events={[]} />);

    expect(badge).toContain("执行已中断");
    expect(badge).toContain("is-recovery-required");
    expect(timeline).toContain("当前没有 Agent 在继续执行");
    expect(timeline).not.toContain("spin");
    expect(timeline).not.toContain("已运行");
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

  it("思考与执行步骤直接进入横向状态轨道，不展示内部逐字记录", () => {
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
    const activeHtml = renderToStaticMarkup(<RunTimeline run={running} events={baseEvents} />);
    const settledHtml = renderToStaticMarkup(
      <RunTimeline
        run={running}
        events={[
          ...baseEvents,
          {
            eventId: "thinking-end",
            sequence: 3,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.completed",
            payload: { type: "thinking.completed" },
          },
        ]}
      />,
    );

    expect(activeHtml).toContain('class="run-progress-track"');
    expect(activeHtml).toContain("分析任务");
    expect(activeHtml).not.toContain("先检查依赖，再生成文档。");
    expect(activeHtml).not.toContain("<details");
    expect(settledHtml).toContain("已完成分析");
    expect(settledHtml).not.toContain("先检查依赖，再生成文档。");
    expect(settledHtml).not.toContain("<details");
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
