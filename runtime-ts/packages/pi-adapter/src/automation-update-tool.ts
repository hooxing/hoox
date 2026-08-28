import {
  DEFAULT_AUTOMATION_TIME_ZONE,
  normalizeRrule,
  normalizeRunAt,
  normalizeScheduledTaskInstruction,
  normalizeScheduledTaskName,
  normalizeTimeZone,
  type ScheduledTask,
  type ScheduledTaskMutation,
} from "@hoox/automation";
import type { ToolObservationResult } from "@hoox/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

const strict = { additionalProperties: false } as const;
const AutomationActionSchema = Type.Union(
  [
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("delete"),
  ],
  {
    description: "操作类型。create 还需 name、instruction、first_run_at；其余操作还需 task_id。",
  },
);
const TaskIdSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description: "update、pause、resume、delete 必填；create 省略。",
});
const NameSchema = Type.String({
  minLength: 1,
  maxLength: 120,
  description: "create 必填；update 可选。",
});
const InstructionSchema = Type.String({
  minLength: 1,
  maxLength: 16384,
  description: "create 必填；update 可选。",
});
const FirstRunAtSchema = Type.String({
  minLength: 20,
  maxLength: 40,
  description:
    "带时区偏移的 ISO 8601 时间；未指定 timezone 时按 Asia/Shanghai（UTC+08:00）换算并携带 +08:00。",
});
const RruleSchema = Type.String({ minLength: 1, maxLength: 300 });
const TimeZoneSchema = Type.String({
  minLength: 1,
  maxLength: 100,
  description: "IANA 时区；省略时默认为 Asia/Shanghai（UTC+08:00）。",
});
const OverlapSchema = Type.Union([Type.Literal("coalesce"), Type.Literal("skip")]);

const AutomationCreateArgumentsSchema = Type.Object(
  {
    action: Type.Literal("create"),
    name: NameSchema,
    instruction: InstructionSchema,
    first_run_at: FirstRunAtSchema,
    rrule: Type.Optional(RruleSchema),
    timezone: Type.Optional(TimeZoneSchema),
    overlap_policy: Type.Optional(OverlapSchema),
  },
  strict,
);
const AutomationUpdateArgumentsSchema = Type.Object(
  {
    action: Type.Literal("update"),
    task_id: TaskIdSchema,
    name: Type.Optional(NameSchema),
    instruction: Type.Optional(InstructionSchema),
    first_run_at: Type.Optional(FirstRunAtSchema),
    rrule: Type.Optional(Type.Union([RruleSchema, Type.Null()])),
    timezone: Type.Optional(TimeZoneSchema),
    overlap_policy: Type.Optional(OverlapSchema),
  },
  strict,
);
const AutomationControlArgumentsSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("delete")]),
    task_id: TaskIdSchema,
  },
  strict,
);

export const AutomationUpdateToolArgumentsSchema = Type.Union([
  AutomationCreateArgumentsSchema,
  AutomationUpdateArgumentsSchema,
  AutomationControlArgumentsSchema,
]);
export type AutomationUpdateToolArguments = Static<typeof AutomationUpdateToolArgumentsSchema>;

/**
 * Provider 只接收稳定的顶层 object，action 分支的必填与禁止字段由同字段 Schema 组成的
 * Runtime 联合契约校验，避免部分 OpenAI-compatible Provider 对顶层 anyOf 的兼容差异。
 */
export const AutomationUpdateToolProviderSchema = Type.Object(
  {
    action: AutomationActionSchema,
    task_id: Type.Optional(TaskIdSchema),
    name: Type.Optional(NameSchema),
    instruction: Type.Optional(InstructionSchema),
    first_run_at: Type.Optional(FirstRunAtSchema),
    rrule: Type.Optional(Type.Union([RruleSchema, Type.Null()])),
    timezone: Type.Optional(TimeZoneSchema),
    overlap_policy: Type.Optional(OverlapSchema),
  },
  strict,
);

export interface AutomationUpdateErrorDetail {
  readonly field: string;
  readonly reason: string;
}

export class AutomationUpdateArgumentError extends Error {
  readonly code = "AUTOMATION_ARGUMENT_VALUE_INVALID" as const;
  readonly details: readonly AutomationUpdateErrorDetail[];

  constructor(field: string, reason: string) {
    super(reason);
    this.name = "AutomationUpdateArgumentError";
    this.details = Object.freeze([Object.freeze({ field, reason })]);
  }
}

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
    details?: readonly AutomationUpdateErrorDetail[];
  }>;
}

export function automationToolMutation(
  args: AutomationUpdateToolArguments,
  currentThreadId: string,
): ScheduledTaskMutation {
  if (args.action === "create") {
    const rrule = args.rrule;
    return {
      action: "create",
      sourceThreadId: currentThreadId,
      targetThreadId: currentThreadId,
      name: normalizeArgument("name", () => normalizeScheduledTaskName(args.name)),
      instruction: normalizeArgument("instruction", () =>
        normalizeScheduledTaskInstruction(args.instruction),
      ),
      firstRunAt: normalizeFirstRunAt(args.first_run_at),
      ...(rrule === undefined ? {} : { rrule: normalizeAutomationRrule(rrule) }),
      timezone: normalizeArgument("timezone", () =>
        normalizeTimeZone(args.timezone ?? DEFAULT_AUTOMATION_TIME_ZONE),
      ),
      ...(args.overlap_policy === undefined ? {} : { overlapPolicy: args.overlap_policy }),
    };
  }
  if (args.action !== "update") {
    return {
      action: args.action,
      taskId: normalizeTaskId(args.task_id),
    };
  }
  const name = args.name;
  const instruction = args.instruction;
  const firstRunAt = args.first_run_at;
  const rrule = args.rrule;
  const timezone = args.timezone;
  return {
    action: "update",
    taskId: normalizeTaskId(args.task_id),
    ...(name === undefined
      ? {}
      : { name: normalizeArgument("name", () => normalizeScheduledTaskName(name)) }),
    ...(instruction === undefined
      ? {}
      : {
          instruction: normalizeArgument("instruction", () =>
            normalizeScheduledTaskInstruction(instruction),
          ),
        }),
    ...(firstRunAt === undefined ? {} : { firstRunAt: normalizeFirstRunAt(firstRunAt) }),
    ...(rrule === undefined
      ? {}
      : rrule === null
        ? { rrule: null }
        : { rrule: normalizeAutomationRrule(rrule) }),
    ...(timezone === undefined
      ? {}
      : { timezone: normalizeArgument("timezone", () => normalizeTimeZone(timezone)) }),
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
  const invalid = createSchemaInvalidArgumentsBridge<
    AutomationUpdateToolArguments,
    readonly AutomationUpdateErrorDetail[]
  >(
    AutomationUpdateToolArgumentsSchema,
    (token) => ({ action: "pause", task_id: `invalid-${token}` }),
    (value) =>
      "task_id" in value && value.task_id.startsWith("invalid-")
        ? value.task_id.slice(8)
        : undefined,
    automationSchemaIssues,
  );
  return defineTool({
    name: "automation_update",
    label: "管理定时任务",
    executionMode: "sequential",
    description:
      "创建、修改、暂停、恢复或删除当前对话的定时任务。仅在用户明确要求定时、周期或未来自动执行时调用。首次时间必须是带时区偏移的 ISO 8601；用户未指定时区时，timezone 可省略并默认为 Asia/Shanghai（UTC+08:00），first_run_at 应按东八区换算且携带 +08:00。重复规则首版支持 FREQ=MINUTELY、HOURLY、DAILY 与 INTERVAL。",
    parameters: AutomationUpdateToolProviderSchema,
    prepareArguments: invalid.prepareArguments,
    execute: async (callId, args, signal) => {
      const validatedArgs = args as AutomationUpdateToolArguments;
      let task: ScheduledTask | undefined;
      let failure: ReturnType<AutomationUpdatePiToolExecutorPort["projectError"]> | undefined;
      const invalidArguments = invalid.consumeFailure(validatedArgs);
      if (invalidArguments !== undefined)
        failure = {
          status: "failed",
          code: "AUTOMATION_ARGUMENTS_INVALID",
          message: "定时任务参数不符合工具契约，请按 details 修正后重试",
          correctable: true,
          fatal: false,
          ...(invalidArguments.details === undefined ? {} : { details: invalidArguments.details }),
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

function normalizeArgument<T>(field: string, normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw new AutomationUpdateArgumentError(
      field,
      error instanceof Error ? error.message : "字段值无效",
    );
  }
}

function normalizeAutomationRrule(value: string): string {
  const normalized = normalizeArgument("rrule", () => normalizeRrule(value));
  if (normalized === undefined) {
    throw new AutomationUpdateArgumentError("rrule", "RRULE 无效");
  }
  return normalized;
}
function normalizeFirstRunAt(value: string): string {
  if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value)) {
    throw new AutomationUpdateArgumentError("first_run_at", "首次执行时间必须携带时区偏移");
  }
  return normalizeArgument("first_run_at", () => normalizeRunAt(value));
}

function normalizeTaskId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1) {
    throw new AutomationUpdateArgumentError("task_id", "定时任务 ID 不能为空");
  }
  return normalized;
}

function automationSchemaIssues(value: unknown): readonly AutomationUpdateErrorDetail[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze([Object.freeze({ field: "arguments", reason: "参数必须是 JSON 对象" })]);
  }
  const action = (value as { readonly action?: unknown }).action;
  if (
    action !== "create" &&
    action !== "update" &&
    action !== "pause" &&
    action !== "resume" &&
    action !== "delete"
  ) {
    return Object.freeze([
      Object.freeze({
        field: "action",
        reason: "必须是 create、update、pause、resume 或 delete",
      }),
    ]);
  }
  const schema =
    action === "create"
      ? AutomationCreateArgumentsSchema
      : action === "update"
        ? AutomationUpdateArgumentsSchema
        : AutomationControlArgumentsSchema;
  return schemaErrorDetails(schema, value);
}

function schemaErrorDetails(
  schema: TSchema,
  value: unknown,
): readonly AutomationUpdateErrorDetail[] {
  const details: AutomationUpdateErrorDetail[] = [];
  const seen = new Set<string>();
  const append = (field: string, reason: string) => {
    const key = `${field}\u0000${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push(Object.freeze({ field, reason }));
  };
  for (const error of Value.Errors(schema, value)) {
    if (error.keyword === "required") {
      const required = error.params.requiredProperties;
      if (Array.isArray(required)) {
        for (const field of required) {
          if (typeof field === "string") append(field, "缺少必填字段");
        }
      }
      continue;
    }
    if (error.keyword === "additionalProperties") {
      const additional = error.params.additionalProperties;
      if (Array.isArray(additional)) {
        for (const field of additional) {
          if (typeof field === "string") append(field, "当前 action 不允许该字段");
        }
      }
      continue;
    }
    const field = error.instancePath.replace(/^\//u, "").replaceAll("/", ".") || "arguments";
    if (error.keyword === "minLength") {
      append(field, `长度不能少于 ${String(error.params.limit)} 个字符`);
    } else if (error.keyword === "maxLength") {
      append(field, `长度不能超过 ${String(error.params.limit)} 个字符`);
    } else if (error.keyword === "type") {
      append(field, `类型必须是 ${translateSchemaType(error.params.type)}`);
    } else {
      append(field, "取值不符合当前 action 的约束");
    }
  }
  if (details.length === 0) append("arguments", "未通过工具 Schema 校验");
  return Object.freeze(details);
}

function translateSchemaType(value: unknown): string {
  return value === "object"
    ? "对象"
    : value === "string"
      ? "字符串"
      : value === "null"
        ? "null"
        : String(value);
}
