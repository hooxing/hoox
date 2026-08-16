import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  BeginFinalAnswerToolArgumentsSchema,
  createBeginFinalAnswerPiTool,
} from "./begin-final-answer-tool.js";

describe("begin_final_answer Pi 工具", () => {
  it("使用稳定空参数并在 durable 回执后继续模型循环", async () => {
    const record = vi.fn(async () => ({
      outcome: "recorded" as const,
      observation: "recorded",
      isTruncated: false,
    }));
    const tool = createBeginFinalAnswerPiTool(record);

    expect(tool.name).toBe("begin_final_answer");
    expect(tool.executionMode).toBe("sequential");
    expect(Value.Check(BeginFinalAnswerToolArgumentsSchema, {})).toBe(true);
    expect(Value.Check(BeginFinalAnswerToolArgumentsSchema, { text: "答案" })).toBe(false);

    const result = await tool.execute("call-final", {}, undefined, () => undefined, {} as never);

    expect(record).toHaveBeenCalledWith("call-final", "begin_final_answer", "succeeded");
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: "ready",
          instruction: "现在输出一条独立、清晰、完整的最终答复，不再调用其他工具。",
        }),
      },
    ]);
    expect("terminate" in result).toBe(false);
  });

  it("durable 回执未形成时拒绝进入最终答复", async () => {
    const tool = createBeginFinalAnswerPiTool(async () => ({ outcome: "conflict" }));

    await expect(
      tool.execute("call-conflict", {}, undefined, () => undefined, {} as never),
    ).rejects.toThrow("未能形成 durable 事实");
  });
});
