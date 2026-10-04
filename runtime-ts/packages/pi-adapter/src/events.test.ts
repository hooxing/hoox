import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { mapPiEvent, projectToolPresentation } from "./events.js";

describe("Pi 运行事件映射", () => {
  it("从真实工具参数生成受限的用户可读展示信息", () => {
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "call-write",
        toolName: "write",
        args: { path: "/workspace/output/report.docx", content: "不应进入事件" },
      }),
    ).toMatchObject({
      presentation: { action: "write", title: "output/report.docx" },
    });
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "/workspace/reports/行业报告.md", ignored: "不得透传" },
      }),
    ).toEqual({
      type: "tool.started",
      callId: "call-read",
      name: "read",
      presentation: { action: "read", title: "reports/行业报告.md" },
    });
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "call-command",
        toolName: "exec_command",
        args: {
          cmd: "find /workspace -type f",
          user_facing_purpose: "查看当前目录中的文件",
        },
      }),
    ).toMatchObject({
      presentation: { action: "command", title: "查看当前目录中的文件" },
    });
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "call-deliver",
        toolName: "deliver_file",
        args: { path: "/workspace/output/deepseek.pptx", name: "DeepSeek介绍.pptx" },
      }),
    ).toMatchObject({
      presentation: { action: "deliver", title: "DeepSeek介绍.pptx" },
    });
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "call-todo",
        toolName: "todo_write",
        args: { todos: [{ id: "first", content: "第一步", status: "pending" }] },
      }),
    ).toMatchObject({
      presentation: { action: "other", title: "更新任务清单" },
    });
  });

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

  it.each(["MODEL_CONTINUATION_REJECTED", "PROVIDER_BINDING_DRIFT"])(
    "把 Runtime 本地续轮阻断 %s 归类为协议错误",
    (errorMessage) => {
      expect(
        mapPiEvent({
          type: "message_end",
          message: fauxAssistantMessage("", { stopReason: "error", errorMessage }),
        }),
      ).toEqual({ type: "error", code: "PROTOCOL", message: "模型协议响应无效" });
    },
  );

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

describe("工具展示与安全失败投影", () => {
  it.each([
    [
      "read",
      { path: "/workspace/reports/a.md", content: "private-body" },
      { action: "read", title: "reports/a.md" },
    ],
    [
      "edit",
      { path: "/workspace/a.md", oldText: "private-body" },
      { action: "edit", title: "a.md" },
    ],
    [
      "exec_command",
      { cmd: "private-command", user_facing_purpose: "检查环境" },
      { action: "command", title: "检查环境" },
    ],
    ["run_code", { code: "private-source" }, { action: "other", title: "编排工具调用" }],
    ["skill", { skill: "pdf", args: "private-body" }, { action: "read", title: "加载技能 pdf" }],
    ["spawn_agent", { instruction: "private-body" }, { action: "other", title: "启动协作任务" }],
    ["send_message", { message: "private-body" }, { action: "other", title: "发送协作消息" }],
    ["automation_update", { prompt: "private-body" }, { action: "other", title: "管理定时任务" }],
  ] as const)("%s 的正常与 PTC 共用投影只含展示字段", (name, args, presentation) => {
    expect(projectToolPresentation(name, args)).toEqual(presentation);
    expect(
      mapPiEvent({ type: "tool_execution_start", toolCallId: "call", toolName: name, args }),
    ).toEqual({ type: "tool.started", callId: "call", name, presentation });
  });
  it("缺少用途不回退到命令，未知名称不猜参数", () => {
    expect(projectToolPresentation("exec_command", { cmd: "private-command" })).toEqual({
      action: "command",
    });
    expect(projectToolPresentation("toString", { title: "private-body" })).toBeUndefined();
    expect(projectToolPresentation("unknown", { path: "private-body" })).toBeUndefined();
    expect(
      projectToolPresentation("read", { path: `/workspace/${"a".repeat(300)}` })?.title,
    ).toHaveLength(240);
  });
  it.each([true, false])("正常模式终态只在失败时附加受限诊断：%s", (isError) => {
    const result = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      isError,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "READ_NOT_FOUND",
              message: "private-provider-error",
              details: { secret: "private-secret" },
            }),
          },
        ],
        details: { secret: "private-secret" },
      },
    });
    expect(result).toEqual({
      type: "tool.completed",
      callId: "call",
      name: "read",
      isError,
      ...(isError
        ? { failure: { code: "READ_NOT_FOUND", message: "指定文件或目录不存在，请检查路径" } }
        : {}),
    });
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("未知正常模式错误不透传宿主诊断", () => {
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "sample",
        isError: true,
        result: { content: [{ type: "text", text: "private-secret" }], details: {} },
      }),
    ).toMatchObject({
      failure: { code: "TOOL_FAILED", message: "工具调用失败，请根据任务状态检查后再决定是否重试" },
    });
  });
});
