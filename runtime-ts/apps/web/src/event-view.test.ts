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

  it("保留流式片段边界的空格与 Markdown 换行", () => {
    const progress = buildRunProgress([
      event(1, "message.delta", { delta: "你好" }),
      event(2, "message.delta", { delta: " 世界\n\n" }),
      event(3, "message.delta", { delta: "- 第一项\n- 第二项" }),
    ]);

    expect(progress.finalMessage).toBe("你好 世界\n\n- 第一项\n- 第二项");
  });

  it("保留独立空格、空行与代码围栏边界片段", () => {
    const progress = buildRunProgress([
      event(1, "message.delta", { delta: "正文" }),
      event(2, "message.delta", { delta: "\n\n" }),
      event(3, "message.delta", { delta: "下一段" }),
      event(4, "message.delta", { delta: " " }),
      event(5, "message.delta", { delta: "```ts\n" }),
      event(6, "message.delta", { delta: "const ok = true;\n" }),
      event(7, "message.delta", { delta: "```" }),
    ]);

    expect(progress.finalMessage).toBe("正文\n\n下一段 ```ts\nconst ok = true;\n```");
  });

  it("不截断超过 16k 的多段正文，并以线性聚合保留全部文本", () => {
    const first = "甲".repeat(12_000);
    const second = ` 世界\n${"乙".repeat(12_000)}`;
    const progress = buildRunProgress([
      event(1, "message.delta", { delta: first }),
      event(2, "message.delta", { delta: second }),
    ]);

    expect(progress.finalMessage).toBe(`${first}${second}`);
    expect(progress.finalMessage).toHaveLength(24_004);
  });

  it("将 waiting 问题投影为受限的用户输入提示", () => {
    const progress = buildRunProgress([
      event(1, "message.delta", { delta: "我需要确认一个选项。" }),
      event(2, "run_waiting", { question: "请选择目标地区。", checkpointId: "不应展示" }),
    ]);

    expect(progress.finalMessage).toBe("我需要确认一个选项。");
    expect(progress.waitingQuestion).toBe("请选择目标地区。");
  });

  it("waiting 问题不截断，且仅在规范化后全文相等时去重", () => {
    const question = `请确认：${"甲".repeat(800)}`;
    const partial = buildRunProgress([
      event(1, "message.delta", { delta: `此前提到${question}，但还需要补充。` }),
      event(2, "run_waiting", { question }),
    ]);
    const same = buildRunProgress([
      event(1, "message.delta", { delta: "  请确认范围\n" }),
      event(2, "run_waiting", { question: "请确认范围" }),
    ]);

    expect(partial.waitingQuestion).toBe(question);
    expect(partial.waitingQuestion).toHaveLength(804);
    expect(same.waitingQuestion).toBeUndefined();
  });

  it("为未识别工具提供安全的通用动作", () => {
    expect(toolActionLabel("private_tool")).toBe("正在处理任务…");
  });
});
