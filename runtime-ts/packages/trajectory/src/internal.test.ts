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

  it("在所有字符串中替换运行时秘密并识别命令行和序列化凭据", async () => {
    const persist = vi.fn(async (_record: InternalTrajectoryDiagnosticRecord) => undefined);
    const recorder = new InternalTrajectoryAttemptRecorder(
      { tenantId: "tenant_1", threadId: "thread_1", runId: "run_1", attemptId: "attempt_1" },
      { persist },
    );
    recorder.addKnownSecrets(["external-secret-value"]);
    recorder.record("pi", "tool_execution_start", {
      command: `curl -H "Authorization: Bearer external-secret-value" --api-key external-secret-value`,
      serialized: '{"webhookSecret":"webhook-value","password":"p@ss"}',
      nested: { token: "token-value" },
      unrelated: "contains external-secret-value",
    });
    await recorder.drain();
    const serialized = JSON.stringify(persist.mock.calls[0]?.[0].event.event);
    expect(serialized).not.toMatch(/external-secret-value|webhook-value|p@ss|token-value/u);
    expect(serialized).toContain("[REDACTED]");
  });

  it.each([
    "Authorization: Basic PRIVATE",
    "Authorization: Bearer PRIVATE",
    "Authorization: Token PRIVATE",
    'Authorization: Digest realm="test", response="PRIVATE"',
    "Authorization: Custom-Scheme opaque PRIVATE",
    "Authorization:\r\n Custom PRIVATE",
    "key=PRIVATE&location=x",
    '{"value":"PRIVATE","name":"Authorization"}',
    '{"Authorization":"Basic PRIVATE"}',
    '{"X-Api-Key":"PRIVATE"}',
    '{"X-Client-Token":"PRIVATE"}',
    '{"Session-Secret":"PRIVATE"}',
    '{"Cookie":"id=a; session=PRIVATE"}',
    '{"label":"token","X-Api-Key":"PRIVATE"}',
    '{"X.Acme-Token":"PRIVATE"}',
    '{"X-Secret":["PRIVATE"]}',
    "Set-Cookie: id=a; other=PRIVATE",
    "curl -H 'Authorization: Other PRIVATE'",
    'curl --header="X-Key: PRIVATE"',
    "curl -u user:PRIVATE",
    "curl --user 'user:pass PRIVATE'",
    "https://user:PRIVATE@example.invalid/index",
    "//user:PRIVATE@example.invalid",
    'https://example.invalid/?key="PRIVATE VALUE"',
    "https://example.invalid/?token=PRIVATE",
    "https://example.invalid/?q=1&key=PRIVATE",
    '[["Authorization","Custom PRIVATE"]]',
    JSON.stringify('{"X-Api-Key":"PRIVATE"}'),
    JSON.stringify('{"Authorization":"Custom PRIVATE"}'),
    "Basic PRIVATE",
    "Bearer PRIVATE",
    "Token PRIVATE",
    'Digest realm="test", response="PRIVATE"',
  ])("未注册凭据也不能进入 persist（样例 %#）", async (text) => {
    const persist = vi.fn(async (_record: InternalTrajectoryDiagnosticRecord) => undefined);
    const recorder = new InternalTrajectoryAttemptRecorder(
      { tenantId: "tenant_a", threadId: "thread_a", runId: "run_a", attemptId: "attempt_a" },
      { persist },
    );
    recorder.record("pi", "request", { text });
    await recorder.drain();
    const result = JSON.stringify(persist.mock.calls[0]?.[0].event.event);
    expect(result.includes("PRIVATE")).toBe(false);
    expect(result).toContain("[REDACTED]");
  });

  it("队列有界，写入超时会取消且 drain 不等待诊断后端", async () => {
    let signal: AbortSignal | undefined;
    const failureObserver = vi.fn();
    const recorder = new InternalTrajectoryAttemptRecorder(
      { tenantId: "tenant_1", threadId: "thread_1", runId: "run_1", attemptId: "attempt_1" },
      {
        persist: vi.fn((_record, options) => {
          signal = options?.signal;
          return new Promise<void>(() => undefined);
        }),
        onFailure: failureObserver,
      },
      undefined,
      { queueLimit: 1, writeDeadlineMs: 10 },
    );
    recorder.record("pi", "turn_start", {});
    recorder.record("pi", "turn_start", {});
    await recorder.drain();
    expect(signal?.aborted).toBe(true);
    expect(failureObserver).toHaveBeenCalledTimes(2);
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
