import { afterEach, describe, expect, it, vi } from "vitest";
import { measureExecutionPhase } from "./execution-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("内部执行计时", () => {
  it("用单调时钟记录关联工具，保留原始结果且不泄露操作内容", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(22.5);
    const record = vi.fn();
    const result = { secret: "private-body" };
    await expect(
      measureExecutionPhase({ record }, "tool_execute", async () => result, {
        toolCallId: "call-1",
        toolName: "read",
      }),
    ).resolves.toBe(result);
    expect(record).toHaveBeenCalledWith({
      phase: "tool_execute",
      startedAt: expect.any(String),
      durationMs: 12.5,
      status: "succeeded",
      toolCallId: "call-1",
      toolName: "read",
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-body");
  });

  it("操作失败仍有耗时；诊断异常不能替换原异常或成功结果", async () => {
    const failure = new Error("operation failed");
    const record = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    await expect(
      measureExecutionPhase({ record }, "file_read", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(record.mock.calls[0]).toEqual([expect.objectContaining({ status: "failed" })]);
    await expect(measureExecutionPhase({ record }, "file_read", async () => 42)).resolves.toBe(42);
  });
});
