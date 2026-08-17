import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  CollapseProcessForFinalAnswerToolArgumentsSchema,
  createCollapseProcessForFinalAnswerPiTool,
} from "./collapse-process-for-final-answer-tool.js";

describe("collapse_process_for_final_answer Pi 工具", () => {
  it("使用稳定空参数并明确可选折叠与独占调用约束", async () => {
    const record = vi.fn(async () => ({
      outcome: "recorded" as const,
      observation: "recorded",
      isTruncated: false,
    }));
    const tool = createCollapseProcessForFinalAnswerPiTool(record);

    expect(tool.name).toBe("collapse_process_for_final_answer");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.description).toContain("可选的展示工具");
    expect(tool.description).toContain("直接回答、简短任务或几乎没有过程内容时不要调用");
    expect(tool.description).toContain("不得输出任何可见文本");
    expect(tool.description).toContain("只输出一次");
    expect(Value.Check(CollapseProcessForFinalAnswerToolArgumentsSchema, {})).toBe(true);
    expect(Value.Check(CollapseProcessForFinalAnswerToolArgumentsSchema, { text: "答案" })).toBe(
      false,
    );

    const result = await tool.execute("call-final", {}, undefined, () => undefined, {} as never);

    expect(record).toHaveBeenCalledWith(
      "call-final",
      "collapse_process_for_final_answer",
      "succeeded",
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: "ready",
          instruction: "过程内容已进入折叠阶段。现在只输出一次最终答复，不再调用任何工具。",
        }),
      },
    ]);
    expect("terminate" in result).toBe(false);
  });

  it("durable 回执未形成时拒绝进入折叠阶段", async () => {
    const tool = createCollapseProcessForFinalAnswerPiTool(async () => ({ outcome: "conflict" }));

    await expect(
      tool.execute("call-conflict", {}, undefined, () => undefined, {} as never),
    ).rejects.toThrow("未能形成 durable 事实");
  });
});
