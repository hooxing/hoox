import { describe, expect, it } from "vitest";
import { combineDeepSeekTrajectoryProjections, projectInternalTrajectory } from "./deepseek.js";
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
  it("将同一次 Assistant 流聚合为一个逻辑记录，同时保留原始事件统计和范围", () => {
    const projection = projectInternalTrajectory([
      event(1, 0, "session_created", {
        type: "session_created",
        model: { api: "openai-completions", provider: "deepseek", id: "deepseek-v4" },
      }),
      event(2, 5, "prompt", { type: "prompt", text: "检查失败原因" }),
      event(3, 10, "agent_start", { type: "agent_start" }),
      event(4, 12, "turn_start", { type: "turn_start" }),
      event(5, 20, "message_start", {
        type: "message_start",
        message: { role: "assistant", content: [], responseId: "chatcmpl-1" },
      }),
      event(6, 30, "message_update", {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "先读取",
          partial: {
            role: "assistant",
            responseId: "chatcmpl-1",
            content: [{ type: "thinking", thinking: "先读取" }],
          },
        },
      }),
      event(7, 35, "message_update", {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "完成",
          partial: {
            role: "assistant",
            responseId: "chatcmpl-1",
            content: [
              { type: "thinking", thinking: "先读取" },
              { type: "text", text: "完成" },
            ],
          },
        },
      }),
      event(8, 50, "message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          api: "openai-completions",
          responseId: "chatcmpl-1",
          content: [
            { type: "thinking", thinking: "先读取日志" },
            { type: "text", text: "定位完成" },
          ],
          usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5 },
          stopReason: "stop",
        },
      }),
      event(9, 60, "turn_end", { type: "turn_end" }),
      event(10, 65, "agent_end", { type: "agent_end" }),
    ]);

    expect(projection.stats).toEqual({
      events: 10,
      records: 3,
      turns: 1,
      calls: 0,
      failedCalls: 0,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
      modelDurationMs: 30,
      outputTokensPerSecond: 20 / 0.03,
      cacheHitRate: 80 / 180,
      durationMs: 65,
    });
    expect(projection.records.map((record) => record.eventType)).toEqual([
      "session_created",
      "prompt",
      "assistant_generation",
    ]);
    expect(projection.records.at(-1)).toMatchObject({
      sequence: 5,
      sequenceEnd: 8,
      rawEventCount: 4,
      kind: "assistant",
      summary: "定位完成",
      durationMs: 30,
      detail: {
        type: "assistant_generation",
        responseId: "chatcmpl-1",
        stream: {
          sequenceStart: 5,
          sequenceEnd: 8,
          rawEventCount: 4,
          firstDeltaSequence: 6,
          timeToFirstDeltaMs: 10,
          updateCounts: { thinking_delta: 1, text_delta: 1 },
        },
      },
    });
  });

  it("将工具 start、update、end 聚合为一个记录并保留完整结果", () => {
    const projection = projectInternalTrajectory([
      event(1, 0, "turn_start", { type: "turn_start" }),
      event(2, 2, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "/workspace/log.txt" },
      }),
      event(3, 5, "tool_execution_update", {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "read",
        partialResult: "读取中",
      }),
      event(4, 8, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: { content: [{ type: "text", text: "完整正文" }] },
        isError: false,
      }),
      event(5, 9, "message_start", {
        type: "message_start",
        message: { role: "toolResult", toolCallId: "call_1", toolName: "read" },
      }),
      event(6, 10, "message_end", {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "完整正文" }],
        },
      }),
      event(7, 11, "turn_end", { type: "turn_end" }),
    ]);

    expect(projection.stats).toMatchObject({
      events: 7,
      records: 1,
      calls: 1,
      failedCalls: 0,
      modelDurationMs: 0,
      outputTokensPerSecond: null,
      cacheHitRate: null,
    });
    expect(projection.records).toHaveLength(1);
    expect(projection.records[0]).toMatchObject({
      eventType: "tool_execution",
      sequence: 2,
      sequenceEnd: 4,
      rawEventCount: 3,
      label: "read",
      durationMs: 6,
      detail: {
        type: "tool_execution",
        callId: "call_1",
        end: { result: { content: [{ text: "完整正文", type: "text" }] } },
      },
    });
  });

  it("保留失败工具并标红，缺少 start 时仍生成可诊断记录", () => {
    const projection = projectInternalTrajectory([
      event(1, 0, "turn_start", { type: "turn_start" }),
      event(2, 8, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: "bad",
        toolName: "read",
        result: { content: [{ type: "text", text: "ENOENT" }] },
        isError: true,
      }),
    ]);

    expect(projection.stats.failedCalls).toBe(1);
    expect(projection.records[0]).toMatchObject({
      isError: true,
      durationMs: 0,
      sequence: 2,
      sequenceEnd: 2,
      rawEventCount: 1,
    });
  });
});

describe("combineDeepSeekTrajectoryProjections", () => {
  it("把同一 Thread 的多个 Run 连续编号为不同 Turn，并保留原始 Run/Attempt 定位", () => {
    const projection = (text: string) =>
      projectInternalTrajectory([
        event(1, 0, "prompt", { type: "prompt", text }),
        event(2, 1, "turn_start", { type: "turn_start" }),
        event(3, 2, "message_start", {
          type: "message_start",
          message: { role: "assistant" },
        }),
        event(4, 7, "message_end", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `回答：${text}` }],
            usage: { input: 20, output: 10, cacheRead: 30, cacheWrite: 0 },
          },
        }),
        event(5, 10, "turn_end", { type: "turn_end" }),
      ]);

    const combined = combineDeepSeekTrajectoryProjections([
      { runId: "run_1", attemptId: "attempt_1", projection: projection("第一条") },
      { runId: "run_2", attemptId: "attempt_2", projection: projection("第二条") },
    ]);

    expect(combined.turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(
      combined.records
        .filter((record) => record.eventType === "prompt")
        .map((record) => ({
          turn: record.turn,
          summary: record.summary,
          source: record.source,
          offset: record.monotonicOffsetMs,
        })),
    ).toEqual([
      {
        turn: 1,
        summary: "第一条",
        source: { runId: "run_1", attemptId: "attempt_1" },
        offset: 0,
      },
      {
        turn: 2,
        summary: "第二条",
        source: { runId: "run_2", attemptId: "attempt_2" },
        offset: 10,
      },
    ]);
    expect(combined.stats).toMatchObject({
      turns: 2,
      events: 10,
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 60,
      modelDurationMs: 10,
      outputTokensPerSecond: 2_000,
      cacheHitRate: 0.6,
      durationMs: 20,
    });
  });
});
