// @vitest-environment jsdom

import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, HistoryFile, Run, RunEvent } from "./api.js";
import {
  activeHistoryMention,
  ConversationComposer,
  EmptyConversation,
  formatArtifactSize,
  formatArtifactType,
  InlineArtifactDelivery,
  NavigationSidebar,
  NewThreadAgentWelcome,
  RunStatusBadge,
  RunTimeline,
  RunTranscript,
  shouldInitiallyCollapseUserRequest,
  ThreadCreate,
  ThreadHeader,
  ThreadTranscript,
  userRequestCollapsedHeight,
} from "./workspace-view.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function agentEvent(
  sequence: number,
  type: string,
  payload: unknown,
  occurredAt = "2026-08-16T00:00:00.000Z",
): RunEvent {
  return {
    eventId: `agent-event-${sequence}`,
    sequence,
    occurredAt,
    kind: "agent_event",
    type,
    payload,
  };
}

describe("工作台展示组件", () => {
  const running: Run = {
    id: "run-1",
    threadId: "thread-1",
    status: "running",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  it("对已结束助手回答回显并保存当前用户反馈与附言", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const feedbackApi = {
      getRunFeedback: vi.fn(async () => ({ feedback: null })),
      putRunFeedback: vi.fn(
        async (_threadId: string, _runId: string, rating: "up" | "down", comment?: string) => ({
          feedback: {
            runId: "run-1",
            revisionId: "revision-1",
            userId: "user-1",
            rating,
            ...(comment ? { comment } : {}),
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
        }),
      ),
      deleteRunFeedback: vi.fn(async () => ({ feedback: null })),
    };
    try {
      await act(async () =>
        root.render(
          <ThreadTranscript
            messages={[]}
            currentRun={{ ...running, status: "succeeded" }}
            threadId="thread-1"
            feedbackApi={feedbackApi}
          />,
        ),
      );
      expect(feedbackApi.getRunFeedback).toHaveBeenCalledWith("thread-1", "run-1");
      const buttons = container.querySelectorAll<HTMLButtonElement>(".run-feedback button");
      await act(async () => buttons[0]?.click());
      const textarea = container.querySelector<HTMLTextAreaElement>(".run-feedback textarea");
      if (textarea === null) throw new Error("反馈附言输入框缺失");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          textarea,
          "很有帮助",
        );
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const submit = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".run-feedback button"),
      ).find((button) => button.textContent === "提交反馈");
      await act(async () => submit?.click());
      expect(feedbackApi.putRunFeedback).toHaveBeenCalledWith(
        "thread-1",
        "run-1",
        "up",
        "很有帮助",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("保存期间锁定附言，保存成功后清除读取错误", async () => {
    let resolvePut!: (value: {
      feedback: {
        runId: string;
        revisionId: string;
        userId: string;
        rating: "up" | "down";
        createdAt: string;
        updatedAt: string;
      };
    }) => void;
    const feedbackApi = {
      getRunFeedback: vi.fn(async () => {
        throw new Error("读取失败");
      }),
      putRunFeedback: vi.fn(
        () =>
          new Promise<Parameters<typeof resolvePut>[0]>((resolve) => {
            resolvePut = resolve;
          }),
      ),
      deleteRunFeedback: vi.fn(async () => ({ feedback: null })),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ThreadTranscript
            messages={[]}
            currentRun={{ ...running, status: "succeeded" }}
            threadId="thread-1"
            feedbackApi={feedbackApi}
          />,
        ),
      );
      expect(container.textContent).toContain("反馈读取失败");
      const buttons = container.querySelectorAll<HTMLButtonElement>(".run-feedback button");
      await act(async () => buttons[0]?.click());
      const submit = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".run-feedback button"),
      ).find((button) => button.textContent === "提交反馈");
      await act(async () => submit?.click());
      const textarea = container.querySelector<HTMLTextAreaElement>(".run-feedback textarea");
      expect(textarea?.disabled).toBe(true);
      await act(async () =>
        resolvePut({
          feedback: {
            runId: "run-1",
            revisionId: "revision-1",
            userId: "user-1",
            rating: "up",
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
        }),
      );
      expect(textarea?.disabled).toBe(false);
      expect(container.textContent).not.toContain("反馈读取失败");
      expect(container.textContent).toContain("已保存");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("迟到的反馈读取不会覆盖加载期间编辑的草稿", async () => {
    let resolveFeedback!: (value: { feedback: null }) => void;
    const feedbackApi = {
      getRunFeedback: vi.fn(
        () => new Promise<{ feedback: null }>((resolve) => (resolveFeedback = resolve)),
      ),
      putRunFeedback: vi.fn(async (_threadId: string, _runId: string, rating: "up" | "down") => ({
        feedback: {
          runId: "run-1",
          revisionId: "revision-1",
          userId: "user-1",
          rating,
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      })),
      deleteRunFeedback: vi.fn(async () => ({ feedback: null })),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ThreadTranscript
            messages={[]}
            currentRun={{ ...running, status: "succeeded" }}
            threadId="thread-1"
            feedbackApi={feedbackApi}
          />,
        ),
      );
      const buttons = container.querySelectorAll<HTMLButtonElement>(".run-feedback button");
      await act(async () => buttons[0]?.click());
      const textarea = container.querySelector<HTMLTextAreaElement>(".run-feedback textarea");
      if (textarea === null) throw new Error("反馈附言输入框缺失");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          textarea,
          "编辑中的草稿",
        );
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => resolveFeedback({ feedback: null }));
      expect(textarea.value).toBe("编辑中的草稿");
      expect(container.textContent).toContain("有未提交的反馈草稿");
      expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
      expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("更改已保存评分时只选中当前草稿评分", async () => {
    const feedbackApi = {
      getRunFeedback: vi.fn(async () => ({
        feedback: {
          runId: "run-1",
          revisionId: "revision-1",
          userId: "user-1",
          rating: "up" as const,
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      })),
      putRunFeedback: vi.fn(async () => ({
        feedback: {
          runId: "run-1",
          revisionId: "revision-1",
          userId: "user-1",
          rating: "down" as const,
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      })),
      deleteRunFeedback: vi.fn(async () => ({ feedback: null })),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ThreadTranscript
            messages={[]}
            currentRun={{ ...running, status: "succeeded" }}
            threadId="thread-1"
            feedbackApi={feedbackApi}
          />,
        ),
      );
      await act(async () => await Promise.resolve());
      const buttons = container.querySelectorAll<HTMLButtonElement>(".run-feedback button");
      await act(async () => buttons[1]?.click());
      expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
      expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it.each(["native", "PTC"])("%s 真实组件共用安全工具展示，失败不混入模型正文", (mode) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const child = mode === "PTC" ? { parentCallId: "parent" } : {};
    const message = '<img src="x"> **文件暂时无法读取**';
    const raw = JSON.stringify({
      presentation: { title: "原始参数不可展示" },
      failure: { code: "FORGED_ERROR", message: "原始输出不可展示" },
    });
    const started = [
      agentEvent(0, "message.delta", { delta: "独立模型正文。" }),
      agentEvent(1, "message.completed", {}),
      agentEvent(2, "tool.started", {
        name: "run_code",
        callId: "parent",
        presentation: { action: "other", title: "编排工具调用" },
      }),
      agentEvent(3, "tool.started", {
        ...child,
        name: "read",
        callId: "read",
        presentation: { action: "read", title: "需求说明.md" },
        args: raw,
      }),
    ];
    const completed = [
      ...started,
      agentEvent(4, "tool.completed", { ...child, name: "read", callId: "read" }),
      agentEvent(5, "tool.started", {
        ...child,
        name: "exec_command",
        callId: "exec",
        presentation: { action: "command", title: "检查运行环境" },
      }),
      agentEvent(6, "tool.completed", {
        ...child,
        name: "exec_command",
        callId: "exec",
        isError: true,
        failure: { code: "EXEC_UNAVAILABLE", message },
        output: raw,
      }),
      agentEvent(7, "tool.completed", { name: "run_code", callId: "parent" }),
      agentEvent(8, "tool.failed", { ...child, name: "read", callId: "legacy", output: raw }),
    ];
    try {
      act(() => root.render(<RunTranscript run={running} events={started} />));
      expect(container.querySelector(".activity-group > summary")?.textContent).toContain(
        "正在读取 · 需求说明.md",
      );
      act(() => root.render(<RunTranscript run={running} events={completed} />));
      const tools = container.querySelectorAll(".tool-activity");
      expect(tools).toHaveLength(4);
      expect(tools[0]?.textContent).toBe("已完成· 编排工具调用");
      expect(tools[1]?.textContent).toBe("已读取· 需求说明.md");
      expect(tools[2]?.textContent).toContain("命令步骤未完成· 检查运行环境");
      expect(tools[2]?.classList.contains("is-failed")).toBe(true);
      const failure = tools[2]?.querySelector(".tool-failure-detail");
      expect(failure?.textContent).toBe(message);
      expect(container.textContent).not.toContain("EXEC_UNAVAILABLE");
      expect(failure?.querySelector("img, strong, script")).toBeNull();
      expect(tools[3]?.textContent).toBe("读取步骤未完成");
      expect(tools[3]?.querySelector(".tool-failure-detail")).toBeNull();
      expect(container.querySelector(".assistant-markdown")?.textContent).toBe("独立模型正文。");
      expect(container.querySelector(".assistant-markdown .tool-failure-detail")).toBeNull();
      expect(container.textContent).not.toContain("原始参数不可展示");
      expect(container.textContent).not.toContain("原始输出不可展示");
      expect(container.textContent).not.toContain("FORGED_ERROR");
      const replay = document.createElement("div");
      replay.innerHTML = renderToStaticMarkup(<RunTranscript run={running} events={completed} />);
      expect(Array.from(tools, (tool) => tool.textContent)).toEqual(
        Array.from(replay.querySelectorAll(".tool-activity"), (tool) => tool.textContent),
      );
    } finally {
      act(() => root.unmount());
    }
  });
  it("将运行状态转换为面向用户的中文状态", () => {
    const html = renderToStaticMarkup(<RunStatusBadge status="waiting" />);

    expect(html).toContain("等待输入");
    expect(html).toContain("is-waiting");
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
  });

  it("流式回复进入持久对话后保留正文 DOM", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const events = [agentEvent(0, "message.delta", { delta: "持续显示的回复" })];
    try {
      act(() =>
        root.render(
          <ThreadTranscript messages={[]} currentRun={running} currentRunEvents={events} />,
        ),
      );
      const paragraph = container.querySelector(".assistant-markdown p");
      expect(paragraph?.textContent).toBe("持续显示的回复");
      act(() =>
        root.render(
          <ThreadTranscript
            messages={[
              {
                role: "assistant",
                runId: running.id,
                sequence: 1,
                text: "持续显示的回复",
                createdAt: running.createdAt,
              },
            ]}
            currentRun={{ ...running, status: "succeeded" }}
            currentRunEvents={[...events, agentEvent(1, "message.completed", {})]}
          />,
        ),
      );
      expect(container.querySelector(".assistant-markdown p")).toBe(paragraph);
      expect(container.querySelectorAll(".assistant-markdown p")).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("多 Agent 时显示选择器、欢迎语和可填入输入框的建议问题", () => {
    const salesAgent = {
      id: "agent_sales",
      displayName: "销售助手",
      description: "销售",
      welcomeMessage: "想跟进哪位客户？",
      suggestedQuestions: ["整理本周线索"],
    };
    const agents = [
      { id: "agent_default", displayName: "默认助手", description: "默认", suggestedQuestions: [] },
      salesAgent,
    ];
    const onSelect = vi.fn();
    const onSuggestedQuestion = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <NewThreadAgentWelcome
            agents={agents}
            selectedAgentId="agent_sales"
            onSelect={onSelect}
            onSuggestedQuestion={onSuggestedQuestion}
          />,
        ),
      );
      expect(container.querySelector("select")?.value).toBe("agent_sales");
      expect(container.textContent).toContain("想跟进哪位客户？");
      const suggestion = container.querySelector(".suggested-question");
      expect(suggestion?.textContent).toBe("整理本周线索");
      act(() => suggestion?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(onSuggestedQuestion).toHaveBeenCalledWith("整理本周线索");
      act(() =>
        root.render(
          <NewThreadAgentWelcome
            agents={[salesAgent]}
            selectedAgentId="agent_sales"
            onSelect={onSelect}
            onSuggestedQuestion={onSuggestedQuestion}
          />,
        ),
      );
      expect(container.querySelector("select")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("会话空状态使用透明横版品牌图", () => {
    const html = renderToStaticMarkup(<EmptyConversation />);

    expect(html).toContain('class="welcome-logo compact"');
    expect(html).toContain('src="/brand/hoox-horizontal-transparent.png"');
    expect(html).not.toContain("✦");
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

  it("失败运行没有模型回复时仍显示按稳定错误码生成的兜底回复", () => {
    const failed: Run = { ...running, status: "failed" };
    const html = renderToStaticMarkup(
      <RunTranscript
        run={failed}
        events={[
          {
            eventId: "failed-state",
            sequence: 1,
            occurredAt: "",
            kind: "attempt_state_changed",
            type: "attempt_state_changed",
            payload: { status: "failed", stage: "finished", code: "SANDBOX_FAILED" },
          },
        ]}
      />,
    );

    expect(html).toContain("Sandbox 连续调用失败，本次任务未能完成。");
  });

  it("已有 Runtime 兜底回复时不再追加第二条页面兜底", () => {
    const failed: Run = { ...running, status: "failed" };
    const message = "模型服务调用失败，本次任务未能完成，请稍后重试。";
    const html = renderToStaticMarkup(
      <RunTranscript
        run={failed}
        events={[
          {
            eventId: "runtime-notice",
            sequence: 1,
            occurredAt: "",
            kind: "agent_event",
            type: "runtime.notice",
            payload: {
              level: "error",
              code: "PROVIDER",
              message,
              source: "terminal_fallback",
            },
          },
        ]}
      />,
    );

    expect(html.match(new RegExp(message, "gu"))).toHaveLength(1);
  });

  it("最终答复提交后默认折叠过程，并保持最终消息为普通正文", () => {
    const completed: Run = { ...running, status: "succeeded" };
    const html = renderToStaticMarkup(
      <RunTranscript
        run={completed}
        events={[
          agentEvent(1, "message.delta", { delta: "过程说明" }),
          agentEvent(2, "message.completed", { stopReason: "stop" }),
          agentEvent(3, "finalization.started", { callId: "call-final" }),
          agentEvent(4, "message.delta", { delta: "清晰的最终答复" }),
          agentEvent(5, "message.completed", { stopReason: "stop" }),
          agentEvent(6, "final_answer.committed", { callId: "call-final" }),
        ]}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    const process = container.querySelector(".final-answer-process");
    expect(process).not.toBeNull();
    expect(process?.hasAttribute("open")).toBe(false);
    expect(process?.textContent).toContain("过程说明");
    expect(container.querySelector(".agent-turn-blocks > .agent-answer-block")?.textContent).toBe(
      "清晰的最终答复",
    );
  });

  it("阶段尚未提交时显示整理状态，异常终止后恢复展开全部过程", () => {
    const phaseEvents = [
      agentEvent(1, "message.delta", { delta: "尚未完成的过程" }),
      agentEvent(2, "message.completed", { stopReason: "stop" }),
      agentEvent(3, "finalization.started", { callId: "call-pending" }),
    ];
    const live = renderToStaticMarkup(<RunTranscript run={running} events={phaseEvents} />);
    expect(live).toContain("查看执行过程");
    expect(live).toContain("正在整理最终答复…");

    const failed = renderToStaticMarkup(
      <RunTranscript run={{ ...running, status: "failed" }} events={phaseEvents} />,
    );
    expect(failed).toContain("尚未完成的过程");
    expect(failed).not.toContain("final-answer-process");
    expect(failed).not.toContain("正在整理最终答复…");
  });

  it("历史最终答复先用 phase 折叠，用户展开后才加载完整过程事件", async () => {
    const loadRunEvents = vi.fn(async () => [
      agentEvent(1, "message.delta", { delta: "从原始事件恢复的过程" }),
      agentEvent(2, "message.completed", { stopReason: "stop" }),
      agentEvent(3, "finalization.started", { callId: "call-history" }),
      agentEvent(4, "message.delta", { delta: "历史最终答复" }),
      agentEvent(5, "message.completed", { stopReason: "stop" }),
      agentEvent(6, "final_answer.committed", { callId: "call-history" }),
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <ThreadTranscript
          messages={[
            {
              sequence: 1,
              runId: "run-history",
              role: "assistant",
              text: "持久化过程摘要",
              phase: "commentary",
              createdAt: "2026-08-16T00:00:00.000Z",
            },
            {
              sequence: 2,
              runId: "run-history",
              role: "assistant",
              text: "历史最终答复",
              phase: "final_answer",
              createdAt: "2026-08-16T00:00:01.000Z",
            },
          ]}
          loadRunEvents={loadRunEvents}
        />,
      ),
    );

    expect(loadRunEvents).not.toHaveBeenCalled();
    const details = container.querySelector<HTMLDetailsElement>(".final-answer-process");
    expect(details?.open).toBe(false);
    await act(async () => {
      if (details === null) throw new Error("测试缺少过程折叠区");
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
      await Promise.resolve();
    });

    expect(loadRunEvents).toHaveBeenCalledWith("run-history");
    expect(container.textContent).toContain("从原始事件恢复的过程");
    act(() => root.unmount());
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
    expect(container.querySelector(".assistant-message")?.getAttribute("aria-label")).toBe("Hoox");
    expect(container.querySelector(".assistant-message .message-label")?.textContent).toBe("Hoox");
    expect(container.querySelector(".assistant-message .message-avatar")?.textContent).toContain(
      "H",
    );
    expect(container.textContent).not.toContain("你的请求");
  });

  it("用户消息在发送后继续展示图片附件，并在等价消息刷新时复用预览", async () => {
    const loadAttachmentUrl = vi.fn(async () => "https://example.test/sunflower.png");
    const container = document.createElement("div");
    const root = createRoot(container);
    const renderTranscript = () => (
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            role: "user",
            text: "这是啥东西",
            attachments: [
              {
                resourceId: "resource_sunflower",
                versionId: "version_sunflower",
                name: "向日葵.png",
                mediaType: "image/png",
                sizeBytes: 940,
              },
            ],
            createdAt: "2026-08-25T00:00:00.000Z",
          },
        ]}
        loadAttachmentUrl={loadAttachmentUrl}
      />
    );

    await act(async () => {
      root.render(renderTranscript());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadAttachmentUrl).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "resource_sunflower", versionId: "version_sunflower" }),
    );
    expect(container.querySelector<HTMLImageElement>(".user-request-attachment img")?.src).toBe(
      "https://example.test/sunflower.png",
    );
    expect(container.querySelector(".user-request-attachment-meta")?.textContent).toContain(
      "向日葵.png",
    );
    expect(container.querySelector(".message-card .user-request-attachments")).toBeNull();
    expect(container.querySelector(".user-request > .user-request-attachments")).not.toBeNull();

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="预览图片 向日葵.png"]')?.click(),
    );
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "图片预览：向日葵.png",
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')?.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      root.render(renderTranscript());
      await Promise.resolve();
    });

    expect(loadAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLImageElement>(".user-request-attachment img")?.src).toBe(
      "https://example.test/sunflower.png",
    );
    act(() => root.unmount());
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
            text: "本次运行未产生 Workspace revision。",
            createdAt: "2026-08-01T00:00:01.000Z",
          },
          {
            sequence: 3,
            role: "runtime",
            text: "运行失败；未提交工作不视为成功。",
            createdAt: "2026-08-01T00:00:02.000Z",
          },
        ]}
      />,
    );

    expect(html).not.toContain("运行已完成。");
    expect(html).not.toContain("本次运行未产生 Workspace revision。");
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

  it("状态栏只展示当前状态，单个已结束思考只保留一层折叠", () => {
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
    expect(settled.querySelector(".activity-group")).toBeNull();
    expect(settledDetails?.open).toBe(false);
    expect(settledDetails?.textContent).toContain("思考完成");
    expect(settledDetails?.querySelector("summary")?.textContent).toBe("思考完成");
    expect(settledDetails?.textContent).toContain("先检查依赖，再生成文档。");
  });

  it("单个已结束工具活动直接展示，多个活动仍使用执行阶段折叠区", () => {
    const singleToolEvents: readonly RunEvent[] = [
      {
        eventId: "tool-start",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.started",
        payload: {
          name: "read",
          callId: "call-1",
          presentation: { action: "read", title: "需求说明.md" },
        },
      },
      {
        eventId: "tool-end",
        sequence: 2,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.completed",
        payload: { name: "read", callId: "call-1", isError: false },
      },
    ];
    const answerEvent: RunEvent = {
      eventId: "answer",
      sequence: 5,
      occurredAt: "",
      kind: "agent_event",
      type: "message.delta",
      payload: { delta: "处理完成。" },
    };
    const singleHtml = renderToStaticMarkup(
      <RunTranscript
        run={{ ...running, status: "succeeded" }}
        events={[...singleToolEvents, answerEvent]}
      />,
    );
    const multipleHtml = renderToStaticMarkup(
      <RunTranscript
        run={{ ...running, status: "succeeded" }}
        events={[
          {
            eventId: "thinking-delta",
            sequence: 1,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.delta",
            payload: { delta: "先确认文件。" },
          },
          {
            eventId: "thinking-end",
            sequence: 2,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.completed",
            payload: {},
          },
          ...singleToolEvents.map((event) => ({ ...event, sequence: event.sequence + 2 })),
          answerEvent,
        ]}
      />,
    );

    const single = document.createElement("div");
    single.innerHTML = singleHtml;
    expect(single.querySelector(".activity-group")).toBeNull();
    expect(single.querySelector(".tool-activity")?.textContent).toContain("已读取· 需求说明.md");

    const multiple = document.createElement("div");
    multiple.innerHTML = multipleHtml;
    expect(multiple.querySelector(".activity-group")).not.toBeNull();
    expect(multiple.querySelector(".thinking-activity")?.tagName).toBe("DETAILS");
  });

  it("正文后的新一轮思考不会留下多个正在思考状态", () => {
    const html = renderToStaticMarkup(
      <RunTranscript
        run={running}
        events={[
          {
            eventId: "thinking-first",
            sequence: 1,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.delta",
            payload: { delta: "先分析请求。" },
          },
          {
            eventId: "answer",
            sequence: 2,
            occurredAt: "",
            kind: "agent_event",
            type: "message.delta",
            payload: { delta: "好的，我先执行工具。" },
          },
          {
            eventId: "answer-end",
            sequence: 3,
            occurredAt: "",
            kind: "agent_event",
            type: "message.completed",
            payload: { stopReason: "toolUse" },
          },
          {
            eventId: "thinking-second",
            sequence: 4,
            occurredAt: "",
            kind: "agent_event",
            type: "thinking.delta",
            payload: { delta: "根据工具结果继续分析。" },
          },
        ]}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelectorAll(".activity-group.is-running")).toHaveLength(1);
    expect(container.textContent?.match(/正在思考/gu)).toHaveLength(1);
    expect(container.querySelector(".thinking-activity > summary")?.textContent).toBe("思考完成");
    expect(container.textContent).toContain("好的，我先执行工具。");
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

  it("同一 Run 的 steer 用户消息切开前后 Agent 段并保持上下文顺序", () => {
    const succeeded: Run = { ...running, status: "succeeded" };
    const html = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            runId: running.id,
            role: "user",
            text: "创建 hello.py",
            createdAt: "2026-08-16T00:00:00.000Z",
          },
          {
            sequence: 2,
            runId: running.id,
            role: "assistant",
            text: "好的，我来创建文件。",
            createdAt: "2026-08-16T00:00:01.000Z",
          },
          {
            sequence: 3,
            runId: running.id,
            role: "user",
            text: "算了，不要了",
            createdAt: "2026-08-16T00:00:02.000Z",
          },
          {
            sequence: 4,
            runId: running.id,
            role: "assistant",
            text: "好的，已停止后续操作。",
            createdAt: "2026-08-16T00:00:03.000Z",
          },
        ]}
        currentRun={succeeded}
        currentRunEvents={[
          agentEvent(1, "thinking.delta", { delta: "准备创建文件。" }, "2026-08-16T00:00:00.200Z"),
          agentEvent(2, "thinking.completed", {}, "2026-08-16T00:00:00.300Z"),
          agentEvent(
            3,
            "message.delta",
            { delta: "好的，我来创建文件。" },
            "2026-08-16T00:00:00.400Z",
          ),
          agentEvent(4, "message.completed", { stopReason: "toolUse" }, "2026-08-16T00:00:00.500Z"),
          agentEvent(
            5,
            "thinking.delta",
            { delta: "用户取消了任务。" },
            "2026-08-16T00:00:02.200Z",
          ),
          agentEvent(6, "thinking.completed", {}, "2026-08-16T00:00:02.300Z"),
          agentEvent(
            7,
            "message.delta",
            { delta: "好的，已停止后续操作。" },
            "2026-08-16T00:00:02.400Z",
          ),
          agentEvent(8, "message.completed", { stopReason: "stop" }, "2026-08-16T00:00:02.500Z"),
        ]}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const transcript = container.querySelector(".assistant-transcript");
    const messages = Array.from(transcript?.children ?? []);

    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.className)).toEqual([
      "message user-request",
      "message assistant-message agent-turn",
      "message user-request",
      "message assistant-message agent-turn",
    ]);
    expect(messages[1]?.textContent).toContain("准备创建文件。");
    expect(messages[1]?.textContent).toContain("好的，我来创建文件。");
    expect(messages[1]?.textContent).not.toContain("用户取消了任务。");
    expect(messages[3]?.textContent).toContain("用户取消了任务。");
    expect(messages[3]?.textContent).toContain("好的，已停止后续操作。");
    expect(messages[3]?.textContent).not.toContain("准备创建文件。");
  });

  it("steer 后的新回复尚未写入上下文时仍显示在用户消息之后", () => {
    const html = renderToStaticMarkup(
      <ThreadTranscript
        messages={[
          {
            sequence: 1,
            runId: running.id,
            role: "user",
            text: "创建 hello.py",
            createdAt: "2026-08-16T00:00:00.000Z",
          },
          {
            sequence: 2,
            runId: running.id,
            role: "assistant",
            text: "好的，我来创建文件。",
            createdAt: "2026-08-16T00:00:01.000Z",
          },
          {
            sequence: 3,
            runId: running.id,
            role: "user",
            text: "算了，不要了",
            createdAt: "2026-08-16T00:00:02.000Z",
          },
        ]}
        currentRun={running}
        currentRunEvents={[
          agentEvent(
            1,
            "message.delta",
            { delta: "好的，我来创建文件。" },
            "2026-08-16T00:00:00.400Z",
          ),
          agentEvent(2, "message.completed", { stopReason: "toolUse" }, "2026-08-16T00:00:00.500Z"),
          agentEvent(
            3,
            "message.delta",
            { delta: "正在响应取消请求。" },
            "2026-08-16T00:00:02.200Z",
          ),
        ]}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const transcript = container.querySelector(".assistant-transcript");
    const messages = Array.from(transcript?.children ?? []);

    expect(messages).toHaveLength(4);
    expect(messages[1]?.textContent).toContain("好的，我来创建文件。");
    expect(messages[1]?.textContent).not.toContain("正在响应取消请求。");
    expect(messages[2]?.textContent).toContain("算了，不要了");
    expect(messages[3]?.textContent).toContain("正在响应取消请求。");
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

  it("支持从输入框粘贴上传，并为图片显示预览、为普通文件显示类型图标", async () => {
    const createObjectURL = vi.fn(() => "blob:composer-preview");
    const revokeObjectURL = vi.fn();
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const image = new File(["image"], "截图.png", { type: "image/png", lastModified: 1 });
    const archive = new File(["archive"], "材料.zip", {
      type: "application/zip",
      lastModified: 2,
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const [files, setFiles] = useState<readonly File[]>([]);
      return (
        <ConversationComposer
          input=""
          files={files}
          disabled={false}
          showQueueAction={false}
          onChange={() => undefined}
          onFilesChange={setFiles}
          onQueue={() => undefined}
          onSubmit={() => undefined}
        />
      );
    }

    try {
      act(() => root.render(<Harness />));
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      if (textarea === null) throw new Error("未渲染任务输入框");
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [image, archive], items: [] } as unknown as DataTransfer,
      });
      await act(async () => {
        textarea.dispatchEvent(paste);
        await Promise.resolve();
      });

      expect(paste.defaultPrevented).toBe(true);
      const textPaste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(textPaste, "clipboardData", {
        value: { files: [], items: [] } as unknown as DataTransfer,
      });
      act(() => textarea.dispatchEvent(textPaste));
      expect(textPaste.defaultPrevented).toBe(false);
      expect(container.querySelectorAll(".composer-file")).toHaveLength(2);
      expect(createObjectURL).toHaveBeenCalledWith(image);
      expect(container.querySelector<HTMLImageElement>(".composer-file-preview")?.src).toBe(
        "blob:composer-preview",
      );
      act(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="预览图片 截图.png"]')?.click(),
      );
      expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
        "图片预览：截图.png",
      );
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(
        container.querySelector('[data-file-kind="archive"] [data-file-icon="zip"]'),
      ).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>(".send-button")?.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:composer-preview");
      if (createObjectUrlDescriptor === undefined)
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
      else Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
      if (revokeObjectUrlDescriptor === undefined)
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      else Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
    }
  });

  it("为已选择的历史图片加载缩略图预览", async () => {
    const historyImage: HistoryFile = {
      threadId: "thread_image",
      taskName: "图片分析",
      resourceId: "resource_image",
      versionId: "version_image",
      name: "现场照片.jpg",
      entryName: "现场照片.jpg",
      path: "/resources/resource_image/version_image/现场照片.jpg",
      mediaType: "image/jpeg",
      sizeBytes: 1024,
      attachedAt: "2026-08-28T01:00:00.000Z",
    };
    const previewHistoryFile = vi.fn(async () => "https://example.test/history-preview.jpg");
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ConversationComposer
          input=""
          files={[]}
          selectedHistoryFiles={[historyImage]}
          historyFileApi={{ listHistoryFiles: vi.fn(), previewHistoryFile }}
          disabled={false}
          showQueueAction={false}
          onChange={() => undefined}
          onFilesChange={() => undefined}
          onHistoryFilesChange={() => undefined}
          onQueue={() => undefined}
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewHistoryFile).toHaveBeenCalledWith(historyImage);
    expect(container.querySelector<HTMLImageElement>(".composer-file-preview")?.src).toBe(
      "https://example.test/history-preview.jpg",
    );
    act(() => root.unmount());
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
    expect(container.querySelector(".brand")?.textContent).toBe("");
    expect(container.querySelector<HTMLImageElement>(".brand-logo")?.getAttribute("src")).toBe(
      "/brand/hoox-horizontal-transparent.png",
    );
    expect(container.querySelector<HTMLImageElement>(".brand-logo")?.getAttribute("alt")).toBe(
      "Hoox",
    );
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
