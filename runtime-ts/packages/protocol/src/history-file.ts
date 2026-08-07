import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const HistoryFileListQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 120 })),
    activeAfter: Type.Optional(IsoTimestampSchema),
    activeBefore: Type.Optional(IsoTimestampSchema),
    beforeLastFileAt: Type.Optional(IsoTimestampSchema),
    beforeThreadId: Type.Optional(IdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 24 })),
  },
  strict,
);
export type HistoryFileListQuery = Static<typeof HistoryFileListQuerySchema>;

export const HistoryFileDownloadPathSchema = Type.Object(
  { resourceId: IdSchema, versionId: IdSchema },
  strict,
);
export type HistoryFileDownloadPath = Static<typeof HistoryFileDownloadPathSchema>;

export const HistoryFileDtoSchema = Type.Object(
  {
    threadId: IdSchema,
    taskName: Type.String({ minLength: 1, maxLength: 255 }),
    resourceId: IdSchema,
    versionId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    entryName: Type.String({ minLength: 1, maxLength: 255 }),
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
    sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    attachedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.HistoryFileDto" },
);
export type HistoryFileDto = Static<typeof HistoryFileDtoSchema>;

export const HistoryFileTaskDtoSchema = Type.Object(
  {
    threadId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    createdAt: IsoTimestampSchema,
    lastFileAt: IsoTimestampSchema,
    fileCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    files: Type.Array(HistoryFileDtoSchema, { maxItems: 2_000 }),
  },
  { ...strict, $id: "v1.HistoryFileTaskDto" },
);
export type HistoryFileTaskDto = Static<typeof HistoryFileTaskDtoSchema>;

const HistoryFileRangeDtoSchema = Type.Object(
  {
    activeAfter: Type.Optional(IsoTimestampSchema),
    activeBefore: Type.Optional(IsoTimestampSchema),
  },
  strict,
);

const HistoryFileCursorDtoSchema = Type.Object(
  { lastFileAt: IsoTimestampSchema, threadId: IdSchema },
  strict,
);

export const HistoryFilePageDtoSchema = Type.Object(
  {
    items: Type.Array(HistoryFileTaskDtoSchema, { maxItems: 50 }),
    range: HistoryFileRangeDtoSchema,
    hasMore: Type.Boolean(),
    hasOlder: Type.Boolean(),
    next: Type.Optional(HistoryFileCursorDtoSchema),
  },
  { ...strict, $id: "v1.HistoryFilePageDto" },
);
export type HistoryFilePageDto = Static<typeof HistoryFilePageDtoSchema>;

export const HistoryFileDownloadDtoSchema = Type.Object(
  {
    file: HistoryFileDtoSchema,
    url: Type.String({ minLength: 1, maxLength: 4_096 }),
    expiresInSeconds: Type.Integer({ minimum: 1, maximum: 3_600 }),
  },
  { ...strict, $id: "v1.HistoryFileDownloadDto" },
);

export const HistoryFilePageSuccessEnvelopeSchema = successEnvelopeSchema(HistoryFilePageDtoSchema);
export const HistoryFileDownloadSuccessEnvelopeSchema = successEnvelopeSchema(
  HistoryFileDownloadDtoSchema,
);
