import { type Static, Type } from "@sinclair/typebox";
import { ArtifactDtoSchema, RunDtoSchema, ThreadDtoSchema } from "./dto.js";
import { successEnvelopeSchema } from "./envelopes.js";
import { FileReferenceSchema, MAX_FILE_REFERENCES } from "./file-references.js";
import { IdSchema, IsoTimestampSchema, Sha256DigestSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const ThreadPathSchema = Type.Object({ threadId: IdSchema }, strict);
export type ThreadPath = Static<typeof ThreadPathSchema>;

export const RunPathSchema = Type.Object({ threadId: IdSchema, runId: IdSchema }, strict);
export type RunPath = Static<typeof RunPathSchema>;

export const ThreadInputReceiptPathSchema = Type.Object(
  { threadId: IdSchema, receiptId: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export type ThreadInputReceiptPath = Static<typeof ThreadInputReceiptPathSchema>;

export const RunArtifactPathSchema = Type.Object(
  { threadId: IdSchema, runId: IdSchema, artifactId: IdSchema },
  strict,
);
export type RunArtifactPath = Static<typeof RunArtifactPathSchema>;

export const ModelWireTraceBodyPathSchema = Type.Object(
  {
    threadId: IdSchema,
    runId: IdSchema,
    attemptId: IdSchema,
    modelTurn: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    transportAttempt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    part: Type.Union([Type.Literal("request"), Type.Literal("response")]),
  },
  strict,
);
export type ModelWireTraceBodyPath = Static<typeof ModelWireTraceBodyPathSchema>;

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

/** SSE 重连游标必须同时携带 Attempt；缺失或变化时从当前 Attempt 起点重放。 */
export const RunEventStreamQuerySchema = Type.Object(
  {
    after: Type.Optional(
      Type.Integer({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER, default: -1 }),
    ),
    attemptId: Type.Optional(IdSchema),
  },
  strict,
);
export type RunEventStreamQuery = Static<typeof RunEventStreamQuerySchema>;

export const ThreadContextListQuerySchema = Type.Object(
  {
    after: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  },
  strict,
);
export type ThreadContextListQuery = Static<typeof ThreadContextListQuerySchema>;

export const ModelWireTraceListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1_500 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
  },
  strict,
);
export type ModelWireTraceListQuery = Static<typeof ModelWireTraceListQuerySchema>;

/**
 * Thread 内 Run 的最新快照窗口。该接口不提供跨快照翻页游标：调用方应把结果视为
 * 请求时刻按更新时间倒序截取的最近 N 条，而不是可在并发写入间续接的历史流。
 */
export const ThreadRunListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  },
  strict,
);
export type ThreadRunListQuery = Static<typeof ThreadRunListQuerySchema>;

export const CreateThreadRequestSchema = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export type CreateThreadRequest = Static<typeof CreateThreadRequestSchema>;

export const RenamePersonalThreadRequestSchema = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export type RenamePersonalThreadRequest = Static<typeof RenamePersonalThreadRequestSchema>;

/** API 与数据库共同遵守的 UTF-8 字节上限；字符数不能替代此边界。 */
export const MAX_RUN_INPUT_UTF8_BYTES = 1_048_576;

export const ResourceAttachmentReferenceSchema = Type.Object(
  { resourceId: IdSchema, versionId: IdSchema },
  strict,
);
export type ResourceAttachmentReferenceDto = Static<typeof ResourceAttachmentReferenceSchema>;

export const UploadedResourceDtoSchema = Type.Object(
  {
    resourceId: IdSchema,
    versionId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    path: Type.String({ pattern: "^/resources/", maxLength: 1_024 }),
    mediaType: Type.String({ minLength: 3, maxLength: 255 }),
    sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.UploadedResourceDto" },
);
export type UploadedResourceDto = Static<typeof UploadedResourceDtoSchema>;

export const SkillInvocationRequestSchema = Type.Object(
  {
    skill: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    }),
    args: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
  },
  strict,
);
export type SkillInvocationRequest = Static<typeof SkillInvocationRequestSchema>;

export const CreateRunRequestSchema = Type.Object(
  {
    // maxLength 仅限制 JSON/校验器工作量；运行时会再按 UTF-8 字节数精确验证。
    input: Type.String({ minLength: 1, maxLength: MAX_RUN_INPUT_UTF8_BYTES }),
    skillInvocation: Type.Optional(SkillInvocationRequestSchema),
  },
  strict,
);
export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;

export const CreateThreadInputRequestSchema = Type.Object(
  {
    input: Type.String({ maxLength: MAX_RUN_INPUT_UTF8_BYTES }),
    fileReferences: Type.Optional(
      Type.Array(FileReferenceSchema, { maxItems: MAX_FILE_REFERENCES }),
    ),
    attachments: Type.Optional(
      Type.Array(ResourceAttachmentReferenceSchema, { maxItems: 20, uniqueItems: true }),
    ),
    mode: Type.Union([Type.Literal("auto"), Type.Literal("steer"), Type.Literal("follow_up")]),
    expectedRunId: Type.Optional(IdSchema),
    expectedTurnId: Type.Optional(
      Type.String({ pattern: "^turn-[1-9][0-9]{0,15}$", maxLength: 200 }),
    ),
    fallbackToFollowUp: Type.Optional(Type.Boolean({ default: false })),
    skillInvocation: Type.Optional(SkillInvocationRequestSchema),
  },
  strict,
);
export type CreateThreadInputRequest = Static<typeof CreateThreadInputRequestSchema>;

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
    hasMore: Type.Optional(Type.Boolean()),
  },
  { ...strict, $id: "v1.RunEventPageDto" },
);
export type RunEventPageDto = Static<typeof RunEventPageDtoSchema>;

export const ThreadContextAttachmentDtoSchema = Type.Object(
  {
    resourceId: IdSchema,
    versionId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 512 }),
    mediaType: Type.String({ minLength: 1, maxLength: 256 }),
    sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.ThreadContextAttachmentDto" },
);
export type ThreadContextAttachmentDto = Static<typeof ThreadContextAttachmentDtoSchema>;

export const ThreadContextMessageDtoSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    runId: Type.Optional(IdSchema),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("runtime")]),
    text: Type.String({ maxLength: 8 * 1024 * 1024 }),
    attachments: Type.Optional(Type.Array(ThreadContextAttachmentDtoSchema, { maxItems: 20 })),
    phase: Type.Optional(Type.Union([Type.Literal("commentary"), Type.Literal("final_answer")])),
    createdAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.ThreadContextMessageDto" },
);
export type ThreadContextMessageDto = Static<typeof ThreadContextMessageDtoSchema>;

export const ThreadContextPageDtoSchema = Type.Object(
  {
    items: Type.Array(ThreadContextMessageDtoSchema, { maxItems: 500 }),
    hasMore: Type.Boolean(),
  },
  { ...strict, $id: "v1.ThreadContextPageDto" },
);
export type ThreadContextPageDto = Static<typeof ThreadContextPageDtoSchema>;

export const ThreadContinuityStatusDtoSchema = Type.Object(
  {
    boundary: Type.Union([
      Type.Literal("new_thread"),
      Type.Literal("legacy_anchor"),
      Type.Literal("manual"),
      Type.Literal("unmigrated"),
    ]),
    readMode: Type.Union([Type.Literal("legacy"), Type.Literal("v2")]),
    anchorState: Type.Union([Type.Literal("none"), Type.Literal("completed")]),
    queueDepth: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    contextSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    compactionWindow: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    sandboxState: Type.Optional(
      Type.Union([
        Type.Literal("running"),
        Type.Literal("pausing"),
        Type.Literal("paused"),
        Type.Literal("resuming"),
        Type.Literal("terminated"),
        Type.Literal("unknown"),
      ]),
    ),
  },
  { ...strict, $id: "v1.ThreadContinuityStatusDto" },
);
export type ThreadContinuityStatusDto = Static<typeof ThreadContinuityStatusDtoSchema>;

export const ThreadRunPageDtoSchema = Type.Object(
  { items: Type.Array(RunDtoSchema, { maxItems: 100 }) },
  { ...strict, $id: "v1.ThreadRunPageDto" },
);
export type ThreadRunPageDto = Static<typeof ThreadRunPageDtoSchema>;

const ThreadInputDispositionSchema = Type.Union([
  Type.Literal("pending_steer"),
  Type.Literal("steered"),
  Type.Literal("queued"),
  Type.Literal("cancelled"),
  Type.Literal("rejected"),
]);

export const ThreadInputReceiptDtoSchema = Type.Object(
  {
    receiptId: Type.String({ minLength: 1, maxLength: 200 }),
    inputSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    requestedMode: Type.Union([
      Type.Literal("auto"),
      Type.Literal("steer"),
      Type.Literal("follow_up"),
    ]),
    disposition: ThreadInputDispositionSchema,
    targetRunId: Type.Optional(IdSchema),
    targetTurnId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    queuedRunId: Type.Optional(IdSchema),
    queueSequence: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    appliedContextSequence: Type.Optional(
      Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    rejectionCode: Type.Optional(
      Type.Union([
        Type.Literal("no_active_turn"),
        Type.Literal("expected_run_mismatch"),
        Type.Literal("expected_turn_mismatch"),
        Type.Literal("unsupported_phase"),
        Type.Literal("target_run_finished"),
      ]),
    ),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    events: Type.Array(
      Type.Object(
        {
          sequence: Type.Integer({ minimum: 1, maximum: 32 }),
          kind: Type.Union([Type.Literal("accepted"), Type.Literal("disposition_changed")]),
          disposition: ThreadInputDispositionSchema,
          targetRunId: Type.Optional(IdSchema),
          targetTurnId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          queuedRunId: Type.Optional(IdSchema),
          queueSequence: Type.Optional(
            Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          ),
          rejectionCode: Type.Optional(
            Type.Union([
              Type.Literal("no_active_turn"),
              Type.Literal("expected_run_mismatch"),
              Type.Literal("expected_turn_mismatch"),
              Type.Literal("unsupported_phase"),
              Type.Literal("target_run_finished"),
            ]),
          ),
          createdAt: IsoTimestampSchema,
        },
        strict,
      ),
      { maxItems: 32 },
    ),
    queuedRun: Type.Optional(RunDtoSchema),
  },
  { ...strict, $id: "v1.ThreadInputReceiptDto" },
);
export type ThreadInputReceiptDto = Static<typeof ThreadInputReceiptDtoSchema>;

const ArtifactDeliveryArtifactDtoSchema = Type.Object(ArtifactDtoSchema.properties, strict);

const ArtifactDeliveryUrlDtoSchema = Type.Object(
  {
    artifact: ArtifactDeliveryArtifactDtoSchema,
    url: Type.String({ minLength: 1, maxLength: 8_192 }),
    expiresInSeconds: Type.Integer({ minimum: 1, maximum: 900 }),
    disposition: Type.Union([Type.Literal("preview"), Type.Literal("download")]),
  },
  strict,
);
const ArtifactTextPreviewDtoSchema = Type.Object(
  {
    artifact: ArtifactDeliveryArtifactDtoSchema,
    text: Type.String({ maxLength: 1_048_576 }),
    disposition: Type.Literal("preview"),
  },
  { ...strict, $id: "v1.ArtifactTextPreviewDto" },
);
export const ArtifactDeliveryDtoSchema = Type.Union(
  [ArtifactDeliveryUrlDtoSchema, ArtifactTextPreviewDtoSchema],
  { $id: "v1.ArtifactDeliveryDto" },
);
export type ArtifactDeliveryDto = Static<typeof ArtifactDeliveryDtoSchema>;

export const ArtifactListDtoSchema = Type.Object(
  { items: Type.Array(ArtifactDtoSchema, { maxItems: 200 }) },
  { ...strict, $id: "v1.ArtifactListDto" },
);
export type ArtifactListDto = Static<typeof ArtifactListDtoSchema>;

export const ModelWireTraceRecordDtoSchema = Type.Object(
  {
    attemptId: IdSchema,
    modelTurn: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    transportAttempt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    part: Type.Union([Type.Literal("request"), Type.Literal("response")]),
    captureStatus: Type.Union([
      Type.Literal("complete"),
      Type.Literal("truncated"),
      Type.Literal("aborted"),
      Type.Literal("failed"),
    ]),
    persistenceStatus: Type.Union([
      Type.Literal("pending"),
      Type.Literal("stored"),
      Type.Literal("unknown"),
      Type.Literal("conflict"),
      Type.Literal("unavailable"),
      Type.Literal("not_captured"),
    ]),
    captureErrorCode: Type.Optional(
      Type.Union([Type.Literal("CAPTURE_UNAVAILABLE"), Type.Literal("BODY_UNREADABLE")]),
    ),
    httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
    sha256: Type.Optional(Sha256DigestSchema),
    size: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    bodyAvailable: Type.Boolean(),
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  },
  strict,
);
export type ModelWireTraceRecordDto = Static<typeof ModelWireTraceRecordDtoSchema>;

export const ModelWireTraceListDtoSchema = Type.Object(
  {
    items: Type.Array(ModelWireTraceRecordDtoSchema, { maxItems: 500 }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1_500 })),
  },
  { ...strict, $id: "v1.ModelWireTraceListDto" },
);
export type ModelWireTraceListDto = Static<typeof ModelWireTraceListDtoSchema>;

export const ThreadSuccessEnvelopeSchema = successEnvelopeSchema(ThreadDtoSchema);
export const ThreadPageSuccessEnvelopeSchema = successEnvelopeSchema(ThreadPageDtoSchema);
export const RunSuccessEnvelopeSchema = successEnvelopeSchema(RunDtoSchema);
export const ThreadRunPageSuccessEnvelopeSchema = successEnvelopeSchema(ThreadRunPageDtoSchema);
export const HealthSuccessEnvelopeSchema = successEnvelopeSchema(HealthDtoSchema);
export const RunEventPageSuccessEnvelopeSchema = successEnvelopeSchema(RunEventPageDtoSchema);
export const ThreadContextPageSuccessEnvelopeSchema = successEnvelopeSchema(
  ThreadContextPageDtoSchema,
);
export const ThreadContinuityStatusSuccessEnvelopeSchema = successEnvelopeSchema(
  ThreadContinuityStatusDtoSchema,
);
export const ThreadInputReceiptSuccessEnvelopeSchema = successEnvelopeSchema(
  ThreadInputReceiptDtoSchema,
);
export const UploadedResourceSuccessEnvelopeSchema =
  successEnvelopeSchema(UploadedResourceDtoSchema);
export const ArtifactListSuccessEnvelopeSchema = successEnvelopeSchema(ArtifactListDtoSchema);
export const ArtifactDeliverySuccessEnvelopeSchema =
  successEnvelopeSchema(ArtifactDeliveryDtoSchema);
export const ModelWireTraceListSuccessEnvelopeSchema = successEnvelopeSchema(
  ModelWireTraceListDtoSchema,
);
