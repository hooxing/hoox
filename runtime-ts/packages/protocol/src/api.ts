import { type Static, Type } from "@sinclair/typebox";
import { ArtifactDtoSchema, RunDtoSchema, ThreadDtoSchema } from "./dto.js";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const ThreadPathSchema = Type.Object({ threadId: IdSchema }, strict);
export type ThreadPath = Static<typeof ThreadPathSchema>;

export const RunPathSchema = Type.Object({ threadId: IdSchema, runId: IdSchema }, strict);
export type RunPath = Static<typeof RunPathSchema>;

export const RunArtifactPathSchema = Type.Object(
  { threadId: IdSchema, runId: IdSchema, artifactId: IdSchema },
  strict,
);
export type RunArtifactPath = Static<typeof RunArtifactPathSchema>;

export const RunEventListQuerySchema = Type.Object(
  {
    after: Type.Optional(
      Type.Integer({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER, default: -1 }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
  },
  strict,
);
export type RunEventListQuery = Static<typeof RunEventListQuerySchema>;

export const CreateThreadRequestSchema = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export type CreateThreadRequest = Static<typeof CreateThreadRequestSchema>;

/** API 与数据库共同遵守的 UTF-8 字节上限；字符数不能替代此边界。 */
export const MAX_RUN_INPUT_UTF8_BYTES = 1_048_576;

export const CreateRunRequestSchema = Type.Object(
  {
    // maxLength 仅限制 JSON/校验器工作量；运行时会再按 UTF-8 字节数精确验证。
    input: Type.String({ minLength: 1, maxLength: MAX_RUN_INPUT_UTF8_BYTES }),
  },
  strict,
);
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

export const RunEventDtoSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 3, maxLength: 256 }),
    sequence: Type.Integer({ minimum: 0 }),
    type: Type.String({ minLength: 1, maxLength: 128 }),
    kind: Type.String({ minLength: 1, maxLength: 128 }),
    payload: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown()),
    occurredAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.RunEventDto" },
);
export type RunEventDto = Static<typeof RunEventDtoSchema>;

export const RunEventPageDtoSchema = Type.Object(
  {
    attemptId: Type.Optional(IdSchema),
    items: Type.Array(RunEventDtoSchema, { maxItems: 200 }),
  },
  { ...strict, $id: "v1.RunEventPageDto" },
);
export type RunEventPageDto = Static<typeof RunEventPageDtoSchema>;

export const ArtifactDeliveryDtoSchema = Type.Object(
  {
    artifact: ArtifactDtoSchema,
    url: Type.String({ minLength: 1, maxLength: 8_192 }),
    expiresInSeconds: Type.Integer({ minimum: 1, maximum: 900 }),
    disposition: Type.Union([Type.Literal("preview"), Type.Literal("download")]),
  },
  { ...strict, $id: "v1.ArtifactDeliveryDto" },
);
export type ArtifactDeliveryDto = Static<typeof ArtifactDeliveryDtoSchema>;

export const ArtifactListDtoSchema = Type.Object(
  { items: Type.Array(ArtifactDtoSchema, { maxItems: 200 }) },
  { ...strict, $id: "v1.ArtifactListDto" },
);
export type ArtifactListDto = Static<typeof ArtifactListDtoSchema>;

export const ThreadSuccessEnvelopeSchema = successEnvelopeSchema(ThreadDtoSchema);
export const ThreadPageSuccessEnvelopeSchema = successEnvelopeSchema(ThreadPageDtoSchema);
export const RunSuccessEnvelopeSchema = successEnvelopeSchema(RunDtoSchema);
export const HealthSuccessEnvelopeSchema = successEnvelopeSchema(HealthDtoSchema);
export const RunEventPageSuccessEnvelopeSchema = successEnvelopeSchema(RunEventPageDtoSchema);
export const ArtifactListSuccessEnvelopeSchema = successEnvelopeSchema(ArtifactListDtoSchema);
export const ArtifactDeliverySuccessEnvelopeSchema =
  successEnvelopeSchema(ArtifactDeliveryDtoSchema);
