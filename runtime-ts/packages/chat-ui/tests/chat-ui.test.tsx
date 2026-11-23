// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HooxClient, RunStreamEvent } from "@hoox/sdk";
import { AssistantMarkdown } from "../src/markdown-view.js";
import { ChatWidget } from "../src/chat-widget.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function mount(element: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return host;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
});

async function submitMessage(host: HTMLElement, value: string) {
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("缺少输入框");
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    host
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function runEvent(
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled",
  items = [],
): RunStreamEvent {
  return {
    event: "run-events",
    id: "attempt-0",
    data: {
      run: {
        id: "run_embed",
        threadId: "thread_embed",
        tenantId: "tenant_embed",
        status,
        createdAt: "",
        updatedAt: "",
      },
      page: { attemptId: "attempt", items },
    },
  };
}

describe("chat-ui Markdown", () => {
  it("拒绝原始 HTML、脚本、危险链接和远程图片", () => {
    const host = mount(
      <AssistantMarkdown
        text={
          '<img src=x onerror="alert(1)"><script>alert(1)</script> [x](javascript:alert(1)) ![p](https://tracker.invalid/p.png)'
        }
      />,
    );
    expect(host.querySelector("script, img")).toBeNull();
    expect(host.innerHTML).not.toContain("javascript:");
    expect(host.innerHTML).not.toContain("onerror");
    expect(host.textContent).toContain("图片：p");
  });

  it("增量呈现流式回复并接受主题 token 覆盖", () => {
    const host = document.createElement("div");
    document.body.append(host);
    hosts.push(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<AssistantMarkdown text="你好" streaming />));
    act(() => root.render(<AssistantMarkdown text="你好，世界" streaming />));
    expect(host.textContent).toContain("你好，世界");
    act(() =>
      root.render(
        <ChatWidget
          client={{} as HooxClient}
          agentDefinitionId="agent_demo"
          locale="en"
          theme={{ accentColor: "tomato", borderRadius: "20px" }}
        />,
      ),
    );
    expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("Type a message…");
    expect(
      (host.querySelector(".hoox-chat") as HTMLElement).style.getPropertyValue(
        "--hoox-chat-accent",
      ),
    ).toBe("tomato");
  });
});

describe("ChatWidget 客户端工具", () => {
  it("转发工具调用给宿主处理器并显示流式回复", async () => {
    const toolHandler = vi.fn(async () => "账户已确认");
    const action = {
      threadId: "thread_embed",
      runId: "run_embed",
      callId: "call_embed",
      toolName: "account_lookup",
      arguments: { accountId: "42" },
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const event = (
      type: string,
      payload: Record<string, unknown>,
      status: "running" | "waiting" | "succeeded" = "running",
    ): RunStreamEvent => ({
      event: "run-events",
      id: "attempt_embed-0",
      data: {
        run: {
          id: "run_embed",
          threadId: "thread_embed",
          tenantId: "tenant_embed",
          status,
          createdAt: "",
          updatedAt: "",
        },
        page: {
          attemptId: "attempt_embed",
          items: [
            {
              eventId: `attempt_embed-${type}`,
              sequence: 0,
              type,
              kind: "agent_event",
              payload,
              occurredAt: "",
            },
          ],
        },
      },
    });
    let streamAttempt = 0;
    const client = {
      createThread: vi.fn(async () => ({ id: "thread_embed" })),
      createRun: vi.fn(async () => ({ id: "run_embed" })),
      streamRunEvents: vi.fn(async function* () {
        if (streamAttempt++ === 0) yield event("requires_action", action, "waiting");
        else yield event("message.delta", { delta: "已查询账户" }, "succeeded");
      }),
      submitToolResult: vi.fn(async () => ({ callId: "call_embed", accepted: true as const })),
      listArtifacts: vi.fn(async () => ({ items: [] })),
    } as unknown as HooxClient;
    const host = mount(
      <ChatWidget
        client={client}
        agentDefinitionId="agent_demo"
        tools={{ account_lookup: toolHandler }}
      />,
    );
    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("缺少输入框");
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      valueSetter?.call(textarea, "查询账户");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(toolHandler).toHaveBeenCalledWith(
      { accountId: "42" },
      expect.objectContaining({ callId: "call_embed" }),
    );
    expect(client.submitToolResult).toHaveBeenCalledWith(
      "thread_embed",
      "run_embed",
      {
        callId: "call_embed",
        outcome: "succeeded",
        result: "账户已确认",
      },
      expect.any(Object),
    );
    expect(host.textContent).toContain("已查询账户");
  });

  it("失败终态显示不含内部错误的状态提示", async () => {
    const client = {
      createThread: vi.fn(async () => ({ id: "thread_embed" })),
      createRun: vi.fn(async () => ({ id: "run_embed" })),
      streamRunEvents: vi.fn(async function* () {
        yield runEvent("failed");
      }),
      listArtifacts: vi.fn(async () => ({ items: [] })),
    } as unknown as HooxClient;
    const host = mount(<ChatWidget client={client} agentDefinitionId="agent_demo" />);
    await submitMessage(host, "触发失败");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("暂时无法完成请求");
  });

  it("卸载时取消 Artifact 请求，且迟到结果不能覆盖较新的预览", async () => {
    const artifact = (id: string) => ({
      id,
      runId: "run_embed",
      threadId: "thread_embed",
      name: `${id}.txt`,
      mediaType: "text/plain",
      size: 1,
      createdAt: "",
    });
    let resolveFirst: ((value: { artifact: object; text: string }) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const client = {
      createThread: vi.fn(async () => ({ id: "thread_embed" })),
      createRun: vi.fn(async () => ({ id: "run_embed" })),
      streamRunEvents: vi.fn(async function* () {
        yield runEvent("succeeded");
      }),
      listArtifacts: vi.fn(async () => ({ items: [artifact("one"), artifact("two")] })),
      previewArtifact: vi.fn(
        (_threadId: string, _runId: string, id: string, options?: { signal?: AbortSignal }) => {
          if (id === "one") {
            firstSignal = options?.signal;
            return new Promise<{ artifact: object; text: string }>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve({ artifact: {}, text: "second preview" });
        },
      ),
    } as unknown as HooxClient;
    const host = mount(<ChatWidget client={client} agentDefinitionId="agent_demo" />);
    await submitMessage(host, "完成任务");
    const previewButtons = host.querySelectorAll(".hoox-chat-artifacts button");
    await act(async () => {
      (previewButtons[0] as HTMLButtonElement).click();
      (previewButtons[2] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(host.textContent).toContain("second preview");
    await act(async () => {
      resolveFirst?.({ artifact: {}, text: "stale preview" });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("stale preview");

    await act(async () => (previewButtons[0] as HTMLButtonElement).click());
    const unmountSignal = firstSignal;
    const root = roots.at(-1);
    if (!root) throw new Error("缺少 React root");
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(unmountSignal?.aborted).toBe(true);
  });

  it("并发客户端工具全部结束前保持忙碌状态", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const makeAction = (callId: string, sequence: number) => ({
      eventId: `attempt-${sequence}`,
      sequence,
      type: "requires_action",
      kind: "agent_event" as const,
      payload: {
        threadId: "thread_embed",
        runId: "run_embed",
        callId,
        toolName: "slow_action",
        arguments: { callId },
        deadline: new Date(Date.now() + 60_000).toISOString(),
      },
      occurredAt: "",
    });
    const client = {
      createThread: vi.fn(async () => ({ id: "thread_embed" })),
      createRun: vi.fn(async () => ({ id: "run_embed" })),
      streamRunEvents: vi.fn(async function* () {
        yield {
          ...runEvent("waiting"),
          data: {
            ...runEvent("waiting").data,
            page: { attemptId: "attempt", items: [makeAction("one", 0), makeAction("two", 1)] },
          },
        };
        yield runEvent("succeeded");
      }),
      submitToolResult: vi.fn(async () => ({ accepted: true as const })),
      listArtifacts: vi.fn(async () => ({ items: [] })),
    } as unknown as HooxClient;
    const host = mount(
      <ChatWidget
        client={client}
        agentDefinitionId="agent_demo"
        tools={{
          slow_action: async (args) =>
            new Promise<string>((resolve) => {
              if (args.callId === "one") releaseFirst = () => resolve("one");
              else releaseSecond = () => resolve("two");
            }),
        }}
      />,
    );
    await submitMessage(host, "并发操作");
    expect(host.textContent).toContain("正在处理页面操作");
    await act(async () => {
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("正在处理页面操作");
    await act(async () => {
      releaseSecond?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain("正在处理页面操作");
  });
});
