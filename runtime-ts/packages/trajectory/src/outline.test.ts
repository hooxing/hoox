import type { RuntimeEventV1 } from "@hoox/run-contracts";
import { describe, expect, it } from "vitest";
import { type ObservedRuntimeEvent, outlineTrajectory, projectTrajectory } from "./index.js";

const secret = "SECRET-正文-不得出现";

function observed(sequence: number, event: Omit<RuntimeEventV1, "sequence">): ObservedRuntimeEvent {
  return {
    event: { ...event, sequence } as RuntimeEventV1,
    observedAt: new Date(Date.UTC(2026, 10, 19, 0, 0, sequence)).toISOString(),
  };
}

function agent(sequence: number, payload: unknown): ObservedRuntimeEvent {
  return observed(sequence, {
    schemaVersion: 1,
    kind: "agent_event",
    payload,
  } as Omit<RuntimeEventV1, "sequence">);
}

describe("outlineTrajectory", () => {
  it("从含正文的完整投影中只保留结构、标识、枚举与计数", () => {
    const full = projectTrajectory([
      observed(0, {
        schemaVersion: 1,
        kind: "attempt_state_changed",
        payload: { status: "running", stage: "model_execution_started" },
      }),
      agent(1, { type: "thinking.delta", delta: `${secret} 推理` }),
      agent(2, { type: "thinking.completed" }),
      agent(3, {
        type: "tool.started",
        callId: "call-1",
        name: "read",
        presentation: { action: "read", title: `${secret}.md` },
      }),
      agent(4, {
        type: "tool.completed",
        callId: "call-1",
        name: "read",
        isError: true,
        failure: { code: "NOT_FOUND", message: secret },
      }),
      agent(5, { type: "message.delta", delta: `${secret} 回复` }),
      agent(6, { type: "message.completed", stopReason: "stop" }),
      agent(7, { type: "queue.updated", steering: [secret], followUp: [secret, secret] }),
      agent(8, {
        type: "todo.updated",
        snapshot: { schemaVersion: 1, version: 3, todos: [{ content: secret }] },
      }),
      agent(9, { type: "error", code: "PROVIDER", message: secret }),
      observed(10, {
        schemaVersion: 1,
        kind: "run_waiting",
        payload: { question: secret, checkpointId: "checkpoint-1" },
      }),
      observed(11, {
        schemaVersion: 1,
        kind: "artifact_correction_requested",
        payload: { round: 1, maxRounds: 2, code: "ARTIFACT_NOT_READY", feedback: secret },
      }),
    ]);
    expect(JSON.stringify(full)).toContain(secret);

    const outline = outlineTrajectory(full);

    expect(JSON.stringify(outline)).not.toContain("SECRET");
    expect(outline.stats).toEqual(full.stats);
    expect(outline.records.map((record) => record.summary)).toEqual([
      "running · model_execution_started",
      "模型推理",
      "read",
      "模型回复",
      "队列：steering 1，follow-up 2",
      "任务清单更新到版本 3",
      "PROVIDER",
      "等待用户回答",
      "交付物修正 1/2",
    ]);
    expect(outline.records.find((record) => record.kind === "tool")).toMatchObject({
      status: "failed",
      durationMs: 1000,
      detail: { callId: "call-1", isError: true, action: "read", failureCode: "NOT_FOUND" },
    });
    expect(outline.records.find((record) => record.kind === "assistant")?.detail).toEqual({
      stopReason: "stop",
    });
    expect(outline.records.find((record) => record.kind === "reasoning")?.detail).toBeUndefined();
  });

  it("数据库剥离正文后的事件仍可投影为同形时间线", () => {
    const outline = outlineTrajectory(
      projectTrajectory([
        agent(0, { type: "thinking.delta", delta: "" }),
        agent(1, { type: "tool.started", callId: "c", name: "write", presentation: {} }),
        agent(2, { type: "tool.completed", callId: "c", name: "write", isError: false }),
      ]),
    );
    expect(outline.records.map((record) => [record.kind, record.summary])).toEqual([
      ["reasoning", "模型推理"],
      ["tool", "write"],
    ]);
  });
});
