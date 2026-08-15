import { describe, expect, it } from "vitest";
import { projectInternalTrajectory } from "./deepseek.js";
import type { InternalTrajectoryEventV1 } from "./internal.js";

function event(
  sequence: number,
  offset: number,
  type: string,
  body: Record<string, unknown>,
): InternalTrajectoryEventV1 {
  return {
    schemaVersion: 1,
    sequence,
    occurredAt: new Date(Date.UTC(2026, 7, 15, 10, 0, 0, offset)).toISOString(),
    monotonicOffsetMs: offset,
    source: type === "prompt" || type === "session_created" ? "runtime" : "pi",
    type,
    event: body as InternalTrajectoryEventV1["event"],
  };
}

describe("projectInternalTrajectory", () => {
  it("按真实 turn、工具耗时和模型 usage 投影 DeepSeek 账本", () => {
    const projection = projectInternalTrajectory([
      event(1, 0, "session_created", {
        type: "session_created",
        model: { provider: "deepseek", id: "deepseek-v4" },
      }),
      event(2, 5, "prompt", { type: "prompt", text: "检查失败原因" }),
      event(3, 10, "agent_start", { type: "agent_start" }),
      event(4, 12, "turn_start", { type: "turn_start" }),
      event(5, 20, "message_update", {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "先读取日志" },
      }),
      event(6, 30, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "exec_command",
        args: { cmd: "cat log" },
      }),
      event(7, 80, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "exec_command",
        result: { content: [{ type: "text", text: "完整输出" }], details: { exitCode: 0 } },
        isError: false,
      }),
      event(8, 100, "message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "定位完成" }],
          usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5 },
          stopReason: "stop",
        },
      }),
      event(9, 110, "turn_end", { type: "turn_end" }),
    ]);

    expect(projection.stats).toEqual({
      events: 9,
      turns: 1,
      calls: 1,
      failedCalls: 0,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
      durationMs: 110,
    });
    expect(projection.turns.map((turn) => turn.turn)).toEqual([0, 1]);
    expect(
      projection.records.find((record) => record.eventType === "tool_execution_end"),
    ).toMatchObject({
      turn: 1,
      lane: "tools",
      label: "exec_command",
      durationMs: 50,
      isError: false,
    });
    expect(
      projection.records.find((record) => record.eventType === "message_update"),
    ).toMatchObject({
      kind: "reasoning",
      summary: "先读取日志",
    });
  });

  it("保留失败工具的完整详情并标红", () => {
    const projection = projectInternalTrajectory([
      event(1, 0, "turn_start", { type: "turn_start" }),
      event(2, 2, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "bad",
        toolName: "read",
        args: { path: "/workspace/missing" },
      }),
      event(3, 8, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: "bad",
        toolName: "read",
        result: { content: [{ type: "text", text: "ENOENT" }] },
        isError: true,
      }),
    ]);
    expect(projection.stats.failedCalls).toBe(1);
    expect(projection.records.at(-1)).toMatchObject({ isError: true, durationMs: 6 });
    expect(projection.records.at(-1)?.detail).toMatchObject({
      result: { content: [{ text: "ENOENT", type: "text" }] },
    });
  });
});
