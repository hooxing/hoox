import type { ToolObservationResult } from "@hoox/context-policy";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

const strict = { additionalProperties: false } as const;

export const SkillToolArgumentsSchema = Type.Object(
  {
    skill: Type.String({
      description: "AVAILABLE_SKILLS 中的精确名称，不含前导斜杠；不要猜测名称。",
      minLength: 1,
      maxLength: 128,
    }),
    args: Type.Optional(
      Type.String({ description: "原样传给 Skill 的可选参数。", maxLength: 16 * 1024 }),
    ),
  },
  strict,
);
export type SkillToolArguments = Static<typeof SkillToolArgumentsSchema>;

export interface SkillPiToolExecutorPort {
  invoke(input: {
    readonly callId: string;
    readonly skill: string;
    readonly args?: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  projectError(error: unknown): Readonly<{
    status: "failed";
    code: string;
    message: string;
    correctable: boolean;
    fatal: boolean;
  }>;
}

export function createSkillPiTool(
  executor: SkillPiToolExecutorPort,
  recordControlledReceipt: (
    callId: string,
    toolName: string,
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>,
) {
  const invalidArguments = createSchemaInvalidArgumentsBridge<SkillToolArguments>(
    SkillToolArgumentsSchema,
    (token) => ({ skill: `invalid-${token}` }),
    (value) =>
      value.skill.startsWith("invalid-") ? value.skill.slice("invalid-".length) : undefined,
  );
  const tool: AgentTool<typeof SkillToolArgumentsSchema, unknown> = {
    name: "skill",
    label: "调用 Skill",
    description:
      "调用当前用户为本次 Run 安装的 Skill。任务被 AVAILABLE_SKILLS 中某项覆盖时先加载完整指令；当前 Turn 已有显式 Skill 指令时不要重复调用。",
    executionMode: "sequential",
    parameters: SkillToolArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, args, signal) => {
      let text: string | undefined;
      let failure: ReturnType<SkillPiToolExecutorPort["projectError"]> | undefined;
      if (invalidArguments.consume(args)) {
        failure = Object.freeze({
          status: "failed" as const,
          code: "SKILL_ARGUMENTS_INVALID",
          message: "skill 参数无效",
          correctable: true,
          fatal: false,
        });
      } else {
        try {
          text = await executor.invoke({
            callId,
            skill: args.skill,
            ...(args.args === undefined ? {} : { args: args.args }),
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          failure = executor.projectError(error);
        }
      }
      const observation = await recordControlledReceipt(
        callId,
        "skill",
        failure === undefined ? "succeeded" : "failed",
      );
      if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
        throw new Error("skill Tool Observation 未能形成 durable 事实");
      }
      if (failure !== undefined) throw new Error(JSON.stringify(failure));
      return { content: [{ type: "text" as const, text: text ?? "" }], details: {} };
    },
  };
  return tool;
}
