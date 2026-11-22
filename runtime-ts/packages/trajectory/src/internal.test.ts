import { describe, expect, it, vi } from "vitest";
import {
  InternalTrajectoryAttemptRecorder,
  type InternalTrajectoryDiagnosticRecord,
  type InternalTrajectoryDiagnosticsPort,
  snapshotInternalTrajectoryValue,
} from "./internal.js";

describe("snapshotInternalTrajectoryValue", () => {
  it("保留完整普通事件并显式编码 JSON 不支持的值", () => {
    const circular: Record<string, unknown> = { command: "echo ok" };
    circular.self = circular;
    const snapshot = snapshotInternalTrajectoryValue({
      args: { path: "/workspace/a.txt", optional: undefined },
      binary: new Uint8Array([0, 1, 255]),
      count: 3n,
      infinity: Number.POSITIVE_INFINITY,
      circular,
    });

    expect(snapshot).toEqual({
      args: {
        optional: { $cubeInternalType: "undefined" },
        path: "/workspace/a.txt",
      },
      binary: { $cubeInternalType: "bytes", encoding: "base64", value: "AAH/" },
      circular: {
        command: "echo ok",
        self: { $cubeInternalType: "reference", value: "$.circular" },
      },
      count: { $cubeInternalType: "bigint", value: "3" },
      infinity: { $cubeInternalType: "number", value: "Infinity" },
    });
  });
});

describe("InternalTrajectoryAttemptRecorder", () => {
  it("按接收顺序分配精确时间和独立 sequence", async () => {
    const records: InternalTrajectoryDiagnosticRecord[] = [];
    const diagnostics: InternalTrajectoryDiagnosticsPort = {
      persist: vi.fn(async (record) => {
        records.push(record);
      }),
    };
    const wallTimes = [new Date("2026-08-15T10:00:00.000Z"), new Date("2026-08-15T10:00:00.025Z")];
    const monotonicTimes = [100, 100, 125];
    const recorder = new InternalTrajectoryAttemptRecorder(
      {
        tenantId: "tenant_1",
        threadId: "thread_1",
        runId: "run_1",
        attemptId: "attempt_1",
      },
      diagnostics,
      {
        now: () => wallTimes.shift() as Date,
        monotonicNow: () => monotonicTimes.shift() as number,
      },
    );

    recorder.record("pi", "turn_start", { type: "turn_start" });
    recorder.record("pi", "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "call_1",
      args: { cmd: "pwd" },
    });
    await recorder.drain();

    expect(records.map((record) => record.event)).toEqual([
      {
        schemaVersion: 1,
        sequence: 1,
        occurredAt: "2026-08-15T10:00:00.000Z",
        monotonicOffsetMs: 0,
        source: "pi",
        type: "turn_start",
        event: { type: "turn_start" },
      },
      {
        schemaVersion: 1,
        sequence: 2,
        occurredAt: "2026-08-15T10:00:00.025Z",
        monotonicOffsetMs: 25,
        source: "pi",
        type: "tool_execution_start",
        event: {
          args: { cmd: "pwd" },
          toolCallId: "call_1",
          type: "tool_execution_start",
        },
      },
    ]);
  });

  it("在诊断数据离开记录器前移除认证头和凭据字段", async () => {
    const persist = vi.fn(async (_record: InternalTrajectoryDiagnosticRecord) => undefined);
    const recorder = new InternalTrajectoryAttemptRecorder(
      { tenantId: "tenant_1", threadId: "thread_1", runId: "run_1", attemptId: "attempt_1" },
      { persist },
    );
    recorder.record("pi", "request", {
      headers: { authorization: "Bearer secret", "x-api-key": "key-secret" },
      apiKey: "provider-secret",
      prompt: "保留请求逻辑内容",
    });
    await recorder.drain();
    expect(persist.mock.calls[0]?.[0].event.event).toEqual({
      apiKey: "[REDACTED]",
      headers: "[REDACTED]",
      prompt: "保留请求逻辑内容",
    });
    expect(JSON.stringify(persist.mock.calls)).not.toContain("secret");
  });

  it("诊断失败不阻断后续事件", async () => {
    const persisted: number[] = [];
    const failureObserver = vi.fn();
    const recorder = new InternalTrajectoryAttemptRecorder(
      {
        tenantId: "tenant_1",
        threadId: "thread_1",
        runId: "run_1",
        attemptId: "attempt_1",
      },
      {
        persist: vi.fn(async (record) => {
          if (record.event.sequence === 1) throw new Error("disk full");
          persisted.push(record.event.sequence);
        }),
        onFailure: failureObserver,
      },
    );
    recorder.record("pi", "agent_start", { type: "agent_start" });
    recorder.record("pi", "turn_start", { type: "turn_start" });
    await recorder.drain();
    expect(persisted).toEqual([2]);
    expect(failureObserver).toHaveBeenCalledWith({ attemptId: "attempt_1", sequence: 1 });
  });
});
