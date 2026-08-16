import type { ToolObservationResult } from "@aisay/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const strict = { additionalProperties: false } as const;

export const BeginFinalAnswerToolArgumentsSchema = Type.Object({}, strict);

const BEGIN_FINAL_ANSWER_RESULT = JSON.stringify({
  status: "ready",
  instruction: "现在输出一条独立、清晰、完整的最终答复，不再调用其他工具。",
});

/**
 * 该工具只形成阶段事实，不终止 Agent 循环；下一次模型采样仍输出标准 assistant message。
 */
export function createBeginFinalAnswerPiTool(
  recordControlledReceipt: (
    callId: string,
    toolName: "begin_final_answer",
    outcome: "succeeded",
  ) => Promise<ToolObservationResult>,
) {
  return defineTool({
    name: "begin_final_answer",
    label: "开始最终答复",
    description:
      "仅当任务已经完成、无需再调用任何工具时调用。调用成功后，立即输出一条独立、清晰、完整的最终答复；不要在最终答复中继续调用工具。",
    executionMode: "sequential",
    parameters: BeginFinalAnswerToolArgumentsSchema,
    execute: async (callId) => {
      const observation = await recordControlledReceipt(callId, "begin_final_answer", "succeeded");
      if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
        throw new Error("begin_final_answer Tool Observation 未能形成 durable 事实");
      }
      return {
        content: [{ type: "text" as const, text: BEGIN_FINAL_ANSWER_RESULT }],
        details: {},
      };
    },
  });
}
