import { describe, expect, it } from "vitest";
import {
  decodeModelWireTraceCursor,
  encodeModelWireTraceCursor,
  InvalidModelWireTraceCursorError,
} from "./model-wire-trace-cursor.js";

const scope = {
  tenantId: "tenant_owner_a",
  userId: "user_owner_a",
  threadId: "thread_1",
  runId: "run_1",
};
const cursor = {
  createdAt: "2026-07-30T00:00:00.000Z",
  attemptId: "attempt_1",
  modelTurn: 2,
  transportAttempt: 1,
  part: "response" as const,
};

describe("模型网络诊断分页游标", () => {
  it("往返保留复合排序位置", () => {
    expect(decodeModelWireTraceCursor(scope, encodeModelWireTraceCursor(scope, cursor))).toEqual(
      cursor,
    );
  });

  it.each([
    { ...scope, tenantId: "tenant_owner_b" },
    { ...scope, userId: "user_owner_b" },
    { ...scope, threadId: "thread_2" },
    { ...scope, runId: "run_2" },
  ])("拒绝跨 scope 重放", (otherScope) => {
    expect(() =>
      decodeModelWireTraceCursor(otherScope, encodeModelWireTraceCursor(scope, cursor)),
    ).toThrow(InvalidModelWireTraceCursorError);
  });

  it.each(["***", "e30", "a".repeat(1_501)])("拒绝非规范或超限载荷", (value) => {
    expect(() => decodeModelWireTraceCursor(scope, value)).toThrow(
      InvalidModelWireTraceCursorError,
    );
  });
});
