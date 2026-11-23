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
});
