import { type Static, Type } from "@sinclair/typebox";
import { RunDtoSchema, ThreadDtoSchema } from "./dto.js";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const ThreadPathSchema = Type.Object({ threadId: IdSchema }, strict);
export type ThreadPath = Static<typeof ThreadPathSchema>;

export const RunPathSchema = Type.Object({ threadId: IdSchema, runId: IdSchema }, strict);
export type RunPath = Static<typeof RunPathSchema>;

export const CreateThreadRequestSchema = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export type CreateThreadRequest = Static<typeof CreateThreadRequestSchema>;

export const CreateRunRequestSchema = Type.Object({}, strict);
export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;

export const ThreadListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  },
  strict,
);
export type ThreadListQuery = Static<typeof ThreadListQuerySchema>;

export const ThreadPageDtoSchema = Type.Object(
  {
    items: Type.Array(ThreadDtoSchema, { maxItems: 100 }),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { ...strict, $id: "v1.ThreadPageDto" },
);
export type ThreadPageDto = Static<typeof ThreadPageDtoSchema>;

export const HealthDtoSchema = Type.Object(
  { status: Type.Literal("ok"), checkedAt: IsoTimestampSchema },
  { ...strict, $id: "v1.HealthDto" },
);

export const ThreadSuccessEnvelopeSchema = successEnvelopeSchema(ThreadDtoSchema);
export const ThreadPageSuccessEnvelopeSchema = successEnvelopeSchema(ThreadPageDtoSchema);
export const RunSuccessEnvelopeSchema = successEnvelopeSchema(RunDtoSchema);
export const HealthSuccessEnvelopeSchema = successEnvelopeSchema(HealthDtoSchema);
