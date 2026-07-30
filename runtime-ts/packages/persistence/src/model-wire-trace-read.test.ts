import { describe, expect, it } from "vitest";
import { mapModelWireTraceRow } from "./model-wire-trace-read.js";

const row = {
  attempt_id: "attempt_1",
  model_turn: "2",
  transport_attempt: "1",
  part: "response",
  capture_status: "aborted",
  persistence_status: "not_captured",
  capture_error_code: "BODY_UNREADABLE",
  http_status: 502,
  sha256: null,
  size: null,
  created_at: new Date("2026-07-30T00:00:00.000Z"),
  expires_at: "2026-08-06T00:00:00.000Z",
  body_available: false,
};

describe("模型网络诊断只读投影", () => {
  it("区分模型轮次、HTTP 重试与采集失败码", () => {
    expect(mapModelWireTraceRow(row)).toEqual({
      attemptId: "attempt_1",
      modelTurn: 2,
      transportAttempt: 1,
      part: "response",
      captureStatus: "aborted",
      persistenceStatus: "not_captured",
      captureErrorCode: "BODY_UNREADABLE",
      httpStatus: 502,
      bodyAvailable: false,
      createdAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
    });
  });

  it.each([
    { ...row, model_turn: "9007199254740992" },
    { ...row, capture_error_code: "LEAK_PROVIDER_ERROR" },
    { ...row, sha256: "not-a-digest" },
    { ...row, http_status: 99 },
  ])("数据库事实形状异常时拒绝宽松投影", (invalid) => {
    expect(() => mapModelWireTraceRow(invalid)).toThrow();
  });
});
