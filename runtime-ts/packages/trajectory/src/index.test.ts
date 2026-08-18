import type { RuntimeEventV1 } from "@hoox/run-contracts";
import { describe, expect, it } from "vitest";
import { type ObservedRuntimeEvent, projectTrajectory } from "./index.js";

function observed(sequence: number, event: Omit<RuntimeEventV1, "sequence">): ObservedRuntimeEvent {
  return {
    event: { ...event, sequence } as RuntimeEventV1,
    observedAt: new Date(Date.UTC(2026, 7, 15, 0, 0, sequence)).toISOString(),
  };
}

describe("projectTrajectory", () => {
  it("聚合推理、回复和工具生命周期并近似模型步骤", () => {
    const projection = projectTrajectory([
      observed(0, {
        schemaVersion: 1,
        kind: "attempt_state_changed",
        payload: { status: "running", stage: "model_execution_started" },
      }),
      observed(1, { schemaVersion: 1, kind: "agent_event", payload: { type: "agent.started" } }),
      observed(2, { schemaVersion: 1, kind: "agent_event", payload: { type: "thinking.started" } }),
      observed(3, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "thinking.delta", delta: "先检查" },
      }),
      observed(4, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "thinking.completed" },
      }),
      observed(5, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "tool.started", callId: "call-1", name: "read" },
      }),
      observed(6, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "tool.completed", callId: "call-1", name: "read", isError: false },
      }),
      observed(7, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "message.delta", delta: "完成。" },
      }),
      observed(8, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "message.completed", stopReason: "stop" },
      }),
    ]);

    expect(projection.stats).toMatchObject({ modelSteps: 2, toolCalls: 1, failedToolCalls: 0 });
    expect(projection.records.find((record) => record.kind === "reasoning")).toMatchObject({
      step: 1,
      summary: "先检查",
      status: "completed",
      durationMs: 2000,
    });
    expect(projection.records.find((record) => record.kind === "tool")).toMatchObject({
      event: "read",
      step: 1,
      status: "completed",
      durationMs: 1000,
    });
    expect(projection.records.find((record) => record.kind === "assistant")).toMatchObject({
      step: 2,
      summary: "完成。",
      status: "completed",
    });
  });

  it("助手正文开始时关闭缺少显式终态的推理块", () => {
    const projection = projectTrajectory([
      observed(0, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "thinking.started" },
      }),
      observed(1, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "thinking.delta", delta: "先分析" },
      }),
      observed(2, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "message.delta", delta: "结论" },
      }),
      observed(3, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "message.completed", stopReason: "stop" },
      }),
    ]);

    expect(projection.stats.modelSteps).toBe(1);
    expect(projection.records.find((record) => record.kind === "reasoning")).toMatchObject({
      status: "completed",
      endSequence: 2,
      durationMs: 2000,
    });
    expect(projection.records.find((record) => record.kind === "assistant")).toMatchObject({
      sequence: 2,
      status: "completed",
    });
  });
  it("保留稳定错误类别和失败工具", () => {
    const projection = projectTrajectory([
      observed(0, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "tool.started", callId: "call-1", name: "exec_command" },
      }),
      observed(1, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "tool.completed", callId: "call-1", name: "exec_command", isError: true },
      }),
      observed(2, {
        schemaVersion: 1,
        kind: "agent_event",
        payload: { type: "error", code: "PROVIDER", message: "模型服务不可用" },
      }),
      observed(3, {
        schemaVersion: 1,
        kind: "attempt_state_changed",
        payload: { status: "failed", stage: "finished", code: "PROVIDER" },
      }),
    ]);

    expect(projection.stats.failedToolCalls).toBe(1);
    expect(projection.stats.errors).toBe(2);
    expect(projection.records.filter((record) => record.status === "failed")).toHaveLength(3);
  });
});
