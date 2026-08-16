import type { ToolObservationResult } from "@aisay/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const strict = { additionalProperties: false } as const;

export const CollapseProcessForFinalAnswerToolArgumentsSchema = Type.Object({}, strict);

const COLLAPSE_PROCESS_FOR_FINAL_ANSWER_RESULT = JSON.stringify({
  status: "ready",
  instruction: "过程内容已进入折叠阶段。现在只输出一次最终答复，不再调用任何工具。",
});

/**
 * 该工具只形成可选的展示阶段事实，不终止 Agent 循环；下一次模型采样仍输出标准 assistant message。
 */
export function createCollapseProcessForFinalAnswerPiTool(
  recordControlledReceipt: (
    callId: string,
    toolName: "collapse_process_for_final_answer",
    outcome: "succeeded",
  ) => Promise<ToolObservationResult>,
) {
  return defineTool({
    name: "collapse_process_for_final_answer",
    label: "折叠过程并开始最终答复",
    description:
      "这是一个可选的展示工具，只用于折叠本轮较长的过程内容。仅当最终答复之前已经累积了较多过程性消息、工具执行说明或中间结果，并且折叠这些内容能帮助用户更直接地看到结论时调用。直接回答、简短任务或几乎没有过程内容时不要调用。若选择调用，必须先完成任务并确认不再需要其他工具；同一 assistant 轮次只能调用本工具，不得输出任何可见文本，也不得同时调用其他工具。工具成功后，在下一条 assistant 消息中只输出一次独立、清晰、完整的最终答复。",
    executionMode: "sequential",
    parameters: CollapseProcessForFinalAnswerToolArgumentsSchema,
    execute: async (callId) => {
      const observation = await recordControlledReceipt(
        callId,
        "collapse_process_for_final_answer",
        "succeeded",
      );
      if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
        throw new Error("collapse_process_for_final_answer Tool Observation 未能形成 durable 事实");
      }
      return {
        content: [{ type: "text" as const, text: COLLAPSE_PROCESS_FOR_FINAL_ANSWER_RESULT }],
        details: {},
      };
    },
  });
}
