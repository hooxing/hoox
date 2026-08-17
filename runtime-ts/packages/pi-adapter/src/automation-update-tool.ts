import type { ScheduledTask, ScheduledTaskMutation } from "@aisay/automation";
import type { ToolObservationResult } from "@aisay/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

const strict = { additionalProperties: false } as const;
const OverlapSchema = Type.Union([Type.Literal("coalesce"), Type.Literal("skip")]);
export const AutomationUpdateToolArgumentsSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("create"),
      name: Type.String({ minLength: 1, maxLength: 120 }),
      instruction: Type.String({ minLength: 1, maxLength: 16384 }),
      first_run_at: Type.String({ minLength: 20, maxLength: 40 }),
      rrule: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      timezone: Type.String({ minLength: 1, maxLength: 100 }),
      overlap_policy: Type.Optional(OverlapSchema),
    },
    strict,
  ),
  Type.Object(
    {
      action: Type.Literal("update"),
      task_id: Type.String({ minLength: 1, maxLength: 200 }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
      first_run_at: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
      rrule: Type.Optional(
        Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
      ),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      overlap_policy: Type.Optional(OverlapSchema),
    },
    strict,
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("delete")]),
      task_id: Type.String({ minLength: 1, maxLength: 200 }),
    },
    strict,
  ),
]);
export type AutomationUpdateToolArguments = Static<typeof AutomationUpdateToolArgumentsSchema>;

export interface AutomationUpdatePiToolExecutorPort {
  apply(input: {
    readonly callId: string;
    readonly arguments: AutomationUpdateToolArguments;
    readonly signal?: AbortSignal;
  }): Promise<ScheduledTask>;
  projectError(error: unknown): Readonly<{
    status: "failed";
    code: string;
    message: string;
    correctable: boolean;
    fatal: boolean;
  }>;
}

export function automationToolMutation(
  args: AutomationUpdateToolArguments,
  currentThreadId: string,
): ScheduledTaskMutation {
  if (args.action === "create")
    return {
      action: "create",
      sourceThreadId: currentThreadId,
      targetThreadId: currentThreadId,
      name: args.name,
      instruction: args.instruction,
      firstRunAt: args.first_run_at,
      ...(args.rrule === undefined ? {} : { rrule: args.rrule }),
      timezone: args.timezone,
      ...(args.overlap_policy === undefined ? {} : { overlapPolicy: args.overlap_policy }),
    };
  if (args.action !== "update") return { action: args.action, taskId: args.task_id };
  return {
    action: "update",
    taskId: args.task_id,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.instruction === undefined ? {} : { instruction: args.instruction }),
    ...(args.first_run_at === undefined ? {} : { firstRunAt: args.first_run_at }),
    ...(args.rrule === undefined ? {} : { rrule: args.rrule }),
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
    ...(args.overlap_policy === undefined ? {} : { overlapPolicy: args.overlap_policy }),
  };
}

export function createAutomationUpdatePiTool(
  executor: AutomationUpdatePiToolExecutorPort,
  recordControlledReceipt: (
    callId: string,
    toolName: "automation_update",
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>,
) {
  const invalid = createSchemaInvalidArgumentsBridge<AutomationUpdateToolArguments>(
    AutomationUpdateToolArgumentsSchema,
    (token) => ({ action: "pause", task_id: `invalid-${token}` }),
    (value) =>
      "task_id" in value && value.task_id.startsWith("invalid-")
        ? value.task_id.slice(8)
        : undefined,
  );
  return defineTool({
    name: "automation_update",
    label: "管理定时任务",
    executionMode: "sequential",
    description:
      "创建、修改、暂停、恢复或删除当前对话的定时任务。仅在用户明确要求定时、周期或未来自动执行时调用。首次时间必须是带时区的 ISO 8601；重复规则首版支持 FREQ=MINUTELY、HOURLY、DAILY 与 INTERVAL。",
    parameters: AutomationUpdateToolArgumentsSchema,
    prepareArguments: invalid.prepareArguments,
    execute: async (callId, args, signal) => {
      let task: ScheduledTask | undefined;
      let failure: ReturnType<AutomationUpdatePiToolExecutorPort["projectError"]> | undefined;
      if (invalid.consume(args))
        failure = {
          status: "failed",
          code: "AUTOMATION_ARGUMENTS_INVALID",
          message: "定时任务参数无效",
          correctable: true,
          fatal: false,
        };
      else {
        try {
          task = await executor.apply({
            callId,
            arguments: args,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          failure = executor.projectError(error);
        }
      }
      const observation = await recordControlledReceipt(
        callId,
        "automation_update",
        failure === undefined ? "succeeded" : "failed",
      );
      if (observation.outcome !== "recorded" && observation.outcome !== "replayed")
        throw new Error("automation_update Tool Observation 未能形成 durable 事实");
      if (failure !== undefined) throw new Error(JSON.stringify(failure));
      return { content: [{ type: "text" as const, text: JSON.stringify(task) }], details: {} };
    },
  });
}
