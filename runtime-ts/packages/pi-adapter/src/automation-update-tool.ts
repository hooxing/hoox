import {
  DEFAULT_AUTOMATION_TIME_ZONE,
  type ScheduledTask,
  type ScheduledTaskMutation,
} from "@hoox/automation";
import type { ToolObservationResult } from "@hoox/context-policy";
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
      first_run_at: Type.String({
        minLength: 20,
        maxLength: 40,
        description:
          "带时区偏移的 ISO 8601 时间；未指定 timezone 时按 Asia/Shanghai（UTC+08:00）换算并携带 +08:00。",
      }),
      rrule: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      timezone: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 100,
          description: "IANA 时区；省略时默认为 Asia/Shanghai（UTC+08:00）。",
        }),
      ),
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

export const AutomationUpdateToolProviderSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("delete"),
      ],
      {
        description:
          "操作类型。create 还需 name、instruction、first_run_at；其余操作还需 task_id。",
      },
    ),
    task_id: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "update、pause、resume、delete 必填；create 省略。",
      }),
    ),
    name: Type.Optional(
      Type.String({ minLength: 1, maxLength: 120, description: "create 必填；update 可选。" }),
    ),
    instruction: Type.Optional(
      Type.String({ minLength: 1, maxLength: 16384, description: "create 必填；update 可选。" }),
    ),
    first_run_at: Type.Optional(
      Type.String({
        minLength: 20,
        maxLength: 40,
        description:
          "create 必填、update 可选。使用带时区偏移的 ISO 8601；未指定 timezone 时按 Asia/Shanghai（UTC+08:00）换算并携带 +08:00。",
      }),
    ),
    rrule: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()])),
    timezone: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: "IANA 时区；省略时默认为 Asia/Shanghai（UTC+08:00）。",
      }),
    ),
    overlap_policy: Type.Optional(OverlapSchema),
  },
  strict,
);

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
      timezone: args.timezone ?? DEFAULT_AUTOMATION_TIME_ZONE,
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
      "创建、修改、暂停、恢复或删除当前对话的定时任务。仅在用户明确要求定时、周期或未来自动执行时调用。首次时间必须是带时区偏移的 ISO 8601；用户未指定时区时，timezone 可省略并默认为 Asia/Shanghai（UTC+08:00），first_run_at 应按东八区换算且携带 +08:00。重复规则首版支持 FREQ=MINUTELY、HOURLY、DAILY 与 INTERVAL。",
    // OpenAI-compatible Provider 要求函数参数的顶层明确为 object；action 分支的严格约束继续由参数桥执行。
    parameters: AutomationUpdateToolProviderSchema,
    prepareArguments: invalid.prepareArguments,
    execute: async (callId, args, signal) => {
      const validatedArgs = args as AutomationUpdateToolArguments;
      let task: ScheduledTask | undefined;
      let failure: ReturnType<AutomationUpdatePiToolExecutorPort["projectError"]> | undefined;
      if (invalid.consume(validatedArgs))
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
            arguments: validatedArgs,
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
