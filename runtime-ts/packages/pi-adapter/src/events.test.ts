import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { mapPiEvent } from "./events.js";

describe("Pi 运行事件映射", () => {
  it("把 Runtime turn hook 错误归类为协议错误，不误报 Provider", () => {
    expect(
      mapPiEvent({
        type: "message_end",
        message: fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "TypeError: THREAD_CONTEXT_UNSUPPORTED_ASSISTANT_ITEM",
        }),
      }),
    ).toEqual({ type: "error", code: "PROTOCOL", message: "模型协议响应无效" });
  });

  it("真实模型错误仍归类为 Provider", () => {
    expect(
      mapPiEvent({
        type: "message_end",
        message: fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "upstream unavailable",
        }),
      }),
    ).toEqual({ type: "error", code: "PROVIDER", message: "模型 Provider 调用失败" });
  });

  it("图片工具结果只把文本说明投影到 Thread Context", () => {
    const mapped = mapPiEvent({
      type: "turn_end",
      message: fauxAssistantMessage(
        fauxToolCall("read", { path: "/workspace/chart.png" }, { id: "call_image" }),
        { stopReason: "toolUse" },
      ),
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "call_image",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          isError: false,
          timestamp: 1,
        },
      ],
    });

    expect(mapped).toMatchObject({
      type: "turn.completed",
      toolResults: [
        {
          toolName: "read",
          text: "Read image file [image/png]",
          isError: false,
        },
      ],
    });
    expect(JSON.stringify(mapped)).not.toContain("iVBORw0KGgo");
  });
});
