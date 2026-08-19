import { describe, expect, it } from "vitest";
import {
  buildConversationBlocks,
  buildConversationSections,
  buildRunProgress,
  toolActionLabel,
} from "./event-view.js";

const event = (sequence: number, type: string, payload: unknown) => ({
  eventId: `event-${sequence}`,
  sequence,
  occurredAt: "",
  kind: "agent_event",
  type,
  payload,
});

describe("用户运行进度投影", () => {
  it("按原始顺序保留多段思考、回答与工具状态", () => {
    const blocks = buildConversationBlocks([
      event(1, "thinking.delta", { delta: "先分析。" }),
      event(2, "thinking.completed", {}),
      event(3, "message.delta", { delta: "我先搜索资料。" }),
      event(4, "message.completed", {}),
      event(5, "tool.started", {
        name: "web_search",
        callId: "call-1",
        presentation: { title: "AI 行业最新动态" },
      }),
      event(6, "tool.completed", { name: "web_search", callId: "call-1" }),
      event(7, "message.delta", { delta: "资料已经整理完成。" }),
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["thinking", "answer", "tool", "answer"]);
    expect(blocks[2]).toMatchObject({
      type: "tool",
      action: "search",
      title: "AI 行业最新动态",
      status: "completed",
    });
  });

  it("在正文或工具边界收敛旧思考，任意时刻最多保留一个运行块", () => {
    const blocks = buildConversationBlocks([
      event(1, "thinking.started", {}),
      event(2, "thinking.delta", { delta: "第一轮分析。" }),
      event(3, "message.delta", { delta: "我先执行工具。" }),
      event(4, "message.completed", { stopReason: "toolUse" }),
      event(5, "thinking.started", {}),
      event(6, "thinking.delta", { delta: "第二轮分析。" }),
    ]);
    const thinking = blocks.filter((block) => block.type === "thinking");

    expect(thinking.map((block) => block.status)).toEqual(["completed", "running"]);
    expect(thinking.filter((block) => block.status === "running")).toHaveLength(1);
    expect(buildConversationSections(blocks).map((section) => section.type)).toEqual([
      "activity",
      "answer",
      "activity",
    ]);

    const toolBoundary = buildConversationBlocks([
      event(1, "thinking.delta", { delta: "准备执行命令。" }),
      event(2, "tool.started", { name: "exec_command", callId: "call-1" }),
    ]);
    expect(toolBoundary[0]).toMatchObject({ type: "thinking", status: "completed" });
  });
  it("把 Runtime 终态兜底作为已完成的用户可见回复", () => {
    const blocks = buildConversationBlocks([
      event(1, "runtime.notice", {
        level: "error",
        code: "PROVIDER",
        message: "模型服务调用失败，本次任务未能完成，请稍后重试。",
        source: "terminal_fallback",
      }),
    ]);

    expect(blocks).toEqual([
      {
        id: "event-1",
        type: "answer",
        text: "模型服务调用失败，本次任务未能完成，请稍后重试。",
        status: "completed",
      },
    ]);
  });

  it("隐藏阶段工具，并以 durable 标志分隔过程和最终答复", () => {
    const blocks = buildConversationBlocks([
      event(1, "message.delta", { delta: "过程说明" }),
      event(2, "message.completed", { stopReason: "stop" }),
      event(3, "tool.started", {
        name: "collapse_process_for_final_answer",
        callId: "call-final",
      }),
      event(4, "tool.completed", {
        name: "collapse_process_for_final_answer",
        callId: "call-final",
        isError: false,
      }),
      event(5, "finalization.started", { callId: "call-final" }),
      event(6, "message.delta", { delta: "最终答复" }),
      event(7, "message.completed", { stopReason: "stop" }),
      event(8, "final_answer.committed", { callId: "call-final" }),
    ]);

    expect(blocks).toMatchObject([
      { type: "answer", text: "过程说明" },
      { type: "finalization", callId: "call-final", status: "committed" },
      { type: "answer", text: "最终答复" },
    ]);
    expect(blocks.some((block) => block.type === "tool")).toBe(false);
    expect(
      buildRunProgress([
        event(1, "tool.started", {
          name: "collapse_process_for_final_answer",
          callId: "call-final",
        }),
      ]).steps,
    ).toEqual([]);
    expect(
      buildRunProgress([
        event(1, "tool.started", {
          name: "begin_final_answer",
          callId: "call-legacy-final",
        }),
      ]).steps,
    ).toEqual([]);
  });

  it("不把工具原始参数作为展示标题", () => {
    const blocks = buildConversationBlocks([
      event(1, "tool.started", {
        name: "exec_command",
        callId: "call-secret",
        command: "包含敏感信息的命令",
      }),
    ]);

    expect(blocks).toMatchObject([{ type: "tool", action: "command", status: "running" }]);
    expect(JSON.stringify(blocks)).not.toContain("包含敏感信息的命令");
  });

  it("在回答边界内折叠思考和低信息操作，创建与修改文件保持直出", () => {
    const blocks = buildConversationBlocks([
      event(1, "thinking.delta", { delta: "检查环境。" }),
      event(2, "thinking.completed", {}),
      event(3, "tool.started", {
        name: "read",
        callId: "call-read",
        presentation: { action: "read", title: "input.md" },
      }),
      event(4, "tool.completed", { name: "read", callId: "call-read" }),
      event(5, "tool.started", {
        name: "write",
        callId: "call-write",
        presentation: { action: "write", title: "report.docx" },
      }),
      event(6, "tool.completed", { name: "write", callId: "call-write" }),
      event(7, "tool.started", {
        name: "edit",
        callId: "call-edit",
        presentation: { action: "edit", title: "report.md" },
      }),
      event(8, "tool.completed", { name: "edit", callId: "call-edit" }),
      event(9, "message.delta", { delta: "处理完成。" }),
    ]);
    const sections = buildConversationSections(blocks);

    expect(sections.map((section) => section.type)).toEqual(["activity", "tool", "tool", "answer"]);
    expect(sections[0]).toMatchObject({
      type: "activity",
      items: [{ type: "thinking" }, { type: "tool", action: "read" }],
    });
    expect(sections[1]).toMatchObject({ type: "tool", action: "write", title: "report.docx" });
    expect(sections[2]).toMatchObject({ type: "tool", action: "edit", title: "report.md" });
  });
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
    expect(progress.currentAction).toBe("正在准备任务…");
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
    expect(progress.currentAction).toBe("正在回复…");
  });

  it("保留流式片段边界的空格与 Markdown 换行", () => {
    const progress = buildRunProgress([
      event(1, "message.delta", { delta: "你好" }),
      event(2, "message.delta", { delta: " 世界\n\n" }),
      event(3, "message.delta", { delta: "- 第一项\n- 第二项" }),
    ]);

    expect(progress.finalMessage).toBe("你好 世界\n\n- 第一项\n- 第二项");
  });

  it("聚合思考流，并在 thinking_end 后切换为已完成状态", () => {
    const running = buildRunProgress([
      event(1, "thinking.started", {}),
      event(2, "thinking.delta", { delta: "先检查" }),
      event(3, "thinking.delta", { delta: "依赖。" }),
    ]);
    const completed = buildRunProgress([
      event(1, "thinking.started", {}),
      event(2, "thinking.delta", { delta: "先检查依赖。" }),
      event(3, "thinking.completed", {}),
      event(4, "tool.started", { name: "exec_command", callId: "call-thinking" }),
    ]);

    expect(running.thinking).toEqual({ text: "先检查依赖。", status: "running" });
    expect(running.currentAction).toBe("正在思考…");
    expect(completed.thinking).toEqual({ text: "先检查依赖。", status: "completed" });
    expect(completed.currentAction).toBe("正在执行代码…");
  });

  it("以 message.completed 兼容关闭缺少 thinking_end 的思考流", () => {
    const progress = buildRunProgress([
      event(1, "thinking.delta", { delta: "兼容推理内容" }),
      event(2, "message.completed", { stopReason: "toolUse" }),
    ]);

    expect(progress.thinking).toEqual({ text: "兼容推理内容", status: "completed" });
  });

  it("正文或工具开始时立即退出当前思考状态", () => {
    const replying = buildRunProgress([
      event(1, "thinking.delta", { delta: "先分析。" }),
      event(2, "message.delta", { delta: "开始回复。" }),
    ]);
    expect(replying.thinking).toEqual({ text: "先分析。", status: "completed" });
    expect(replying.currentAction).toBe("正在回复…");

    const tooling = buildRunProgress([
      event(1, "thinking.delta", { delta: "先分析。" }),
      event(2, "tool.started", { name: "exec_command", callId: "call-1" }),
    ]);
    expect(tooling.thinking).toEqual({ text: "先分析。", status: "completed" });
    expect(tooling.currentAction).toBe("正在执行代码…");
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

  it("只使用最新的有效 todo.updated 快照作为运行清单", () => {
    const progress = buildRunProgress([
      event(1, "todo.updated", {
        snapshot: {
          schemaVersion: 1,
          version: 1,
          todos: [
            { id: "first", content: "确认目标", status: "pending" },
            { id: "second", content: "完成交付", status: "pending" },
          ],
        },
      }),
      event(2, "todo.updated", { snapshot: { version: 2, todos: [] } }),
      event(3, "todo.updated", {
        snapshot: {
          schemaVersion: 1,
          version: 2,
          todos: [
            { id: "first", content: "确认目标", status: "completed" },
            { id: "second", content: "完成交付", status: "in_progress" },
          ],
        },
      }),
    ]);

    expect(progress.todo).toEqual({
      version: 2,
      todos: [
        { id: "first", content: "确认目标", status: "completed" },
        { id: "second", content: "完成交付", status: "in_progress" },
      ],
    });
    expect(progress.steps).toEqual([]);
  });
});
