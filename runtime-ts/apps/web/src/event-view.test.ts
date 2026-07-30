import { describe, expect, it } from "vitest";
import { buildRunProgress, toolActionLabel } from "./event-view.js";

const event = (sequence: number, type: string, payload: unknown) => ({
  eventId: `event-${sequence}`,
  sequence,
  occurredAt: "",
  kind: "agent_event",
  type,
  payload,
});

describe("用户运行进度投影", () => {
  it("将工具调用投影为用户可理解动作，并忽略内部生命周期", () => {
    const progress = buildRunProgress([
      event(1, "model_execution_started", { trace: "不应显示" }),
      event(2, "tool.started", { name: "web_search", callId: "call-private-1" }),
      event(3, "cleanup_intent_persisted", { secret: "不应显示" }),
      event(4, "tool.completed", { name: "web_search", callId: "call-private-1" }),
    ]);

    expect(progress.steps).toEqual([
      { id: "call-private-1", label: "正在搜索网页…", status: "completed", count: 1 },
    ]);
    expect(JSON.stringify(progress)).not.toContain("cleanup_intent_persisted");
    expect(progress.currentAction).toBe("正在搜索网页…");
  });

  it("合并连续同类完成步骤，保留失败状态和最终回复", () => {
    const progress = buildRunProgress([
      event(1, "tool.started", { name: "write_artifact", callId: "call-1" }),
      event(2, "tool.completed", { name: "write_artifact", callId: "call-1" }),
      event(3, "tool.started", { name: "write_artifact", callId: "call-2" }),
      event(4, "tool.completed", { name: "write_artifact", callId: "call-2" }),
      event(5, "tool.failed", { name: "shell_command", callId: "call-3" }),
      event(6, "message.delta", { delta: "已生成报告。" }),
    ]);

    expect(progress.steps).toEqual([
      { id: "call-1", label: "正在生成文件…", status: "completed", count: 2 },
      { id: "call-3", label: "正在执行代码…", status: "failed", count: 1 },
    ]);
    expect(progress.finalMessage).toBe("已生成报告。");
  });

  it("为未识别工具提供安全的通用动作", () => {
    expect(toolActionLabel("private_tool")).toBe("正在处理任务…");
  });
});
