import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const StatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("completed"),
  Type.Literal("deleted"),
]);
const OverlapSchema = Type.Union([Type.Literal("coalesce"), Type.Literal("skip")]);

export const ScheduledTaskDtoSchema = Type.Object(
  {
    id: IdSchema,
    tenantId: IdSchema,
    ownerUserId: IdSchema,
    sourceThreadId: IdSchema,
    targetThreadId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    instruction: Type.String({ minLength: 1, maxLength: 16384 }),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
    rrule: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    status: StatusSchema,
    overlapPolicy: OverlapSchema,
    nextRunAt: Type.Optional(IsoTimestampSchema),
    lastRunAt: Type.Optional(IsoTimestampSchema),
    currentRevision: Type.Integer({ minimum: 1 }),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.ScheduledTaskDto" },
);
export type ScheduledTaskDto = Static<typeof ScheduledTaskDtoSchema>;

export const CreateScheduledTaskRequestSchema = Type.Object(
  {
    targetThreadId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    instruction: Type.String({ minLength: 1, maxLength: 16384 }),
    firstRunAt: IsoTimestampSchema,
    rrule: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
    overlapPolicy: Type.Optional(OverlapSchema),
  },
  strict,
);
export type CreateScheduledTaskRequest = Static<typeof CreateScheduledTaskRequestSchema>;

export const ScheduledTaskPathSchema = Type.Object({ taskId: IdSchema }, strict);
export type ScheduledTaskPath = Static<typeof ScheduledTaskPathSchema>;

export const UpdateScheduledTaskRequestSchema = Type.Union([
  Type.Object({ action: Type.Literal("pause") }, strict),
  Type.Object({ action: Type.Literal("resume") }, strict),
  Type.Object({ action: Type.Literal("delete") }, strict),
  Type.Object(
    {
      action: Type.Literal("update"),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
      firstRunAt: Type.Optional(IsoTimestampSchema),
      rrule: Type.Optional(
        Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
      ),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      overlapPolicy: Type.Optional(OverlapSchema),
    },
    strict,
  ),
]);
export type UpdateScheduledTaskRequest = Static<typeof UpdateScheduledTaskRequestSchema>;

export const ScheduledTaskListSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ items: Type.Array(ScheduledTaskDtoSchema) }, strict),
);
export const ScheduledTaskSuccessEnvelopeSchema = successEnvelopeSchema(ScheduledTaskDtoSchema);
