import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema, Sha256DigestSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

const CanonicalSkillKeySchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
  maxLength: 128,
});
const SkillVersionSchema = Type.String({
  pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$",
  maxLength: 64,
});
const SkillDisplayNameSchema = Type.String({ minLength: 1, maxLength: 200 });
const SkillPublisherSchema = Type.String({ minLength: 1, maxLength: 200 });
const SkillDescriptionSchema = Type.String({ minLength: 1, maxLength: 2_048 });
const SkillCompatibilitySchema = Type.String({ minLength: 1, maxLength: 500 });
// URL 的 http/https 语义与规范化由领域层校验，协议层只限制输入规模。
const SkillSourceUrlSchema = Type.String({ minLength: 1, maxLength: 2_048 });
const SkillSourceRevisionSchema = Type.String({ minLength: 1, maxLength: 200 });
const SkillLicenseSpdxSchema = Type.String({ minLength: 1, maxLength: 100 });
const VersionTokenSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const SkillPackagePathSchema = Type.String({
  minLength: 1,
  maxLength: 1_024,
  pattern: "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\x00-\\x1F\\x7F]+$",
});
const SkillMediaTypeSchema = Type.String({ minLength: 3, maxLength: 255 });

export const MAX_SKILL_SUBMISSION_FILES = 256;
export const MAX_SKILL_SUBMISSION_CONTENT_BASE64_CHARS = 45 * 1024 * 1024;

export const SkillPlatformRoleSchema = Type.Union([
  Type.Literal("publisher"),
  Type.Literal("reviewer"),
  Type.Literal("admin"),
]);
export type SkillPlatformRole = Static<typeof SkillPlatformRoleSchema>;

export const SkillPublicationStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("submitted"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("published"),
  Type.Literal("revoked"),
]);
export type SkillPublicationStatus = Static<typeof SkillPublicationStatusSchema>;

export const SkillSubmissionFileRequestSchema = Type.Object(
  {
    path: SkillPackagePathSchema,
    mediaType: SkillMediaTypeSchema,
    // 只限制 JSON 字符规模；规范 Base64 与包的解码总字节数由领域层统一校验。
    contentBase64: Type.String({
      minLength: 1,
      maxLength: MAX_SKILL_SUBMISSION_CONTENT_BASE64_CHARS,
    }),
  },
  strict,
);
export type SkillSubmissionFileRequest = Static<typeof SkillSubmissionFileRequestSchema>;

export const CreateSkillSubmissionRequestSchema = Type.Object(
  {
    canonicalKey: CanonicalSkillKeySchema,
    displayName: SkillDisplayNameSchema,
    publisher: SkillPublisherSchema,
    version: SkillVersionSchema,
    description: SkillDescriptionSchema,
    compatibility: SkillCompatibilitySchema,
    sourceUrl: SkillSourceUrlSchema,
    sourceRevision: SkillSourceRevisionSchema,
    licenseSpdx: SkillLicenseSpdxSchema,
    files: Type.Array(SkillSubmissionFileRequestSchema, {
      minItems: 1,
      maxItems: MAX_SKILL_SUBMISSION_FILES,
    }),
  },
  strict,
);
export type CreateSkillSubmissionRequest = Static<typeof CreateSkillSubmissionRequestSchema>;

export const SkillSubmissionFileDtoSchema = Type.Object(
  {
    path: SkillPackagePathSchema,
    mediaType: SkillMediaTypeSchema,
    sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    contentDigest: Sha256DigestSchema,
  },
  { ...strict, $id: "v1.SkillSubmissionFileDto" },
);
export type SkillSubmissionFileDto = Static<typeof SkillSubmissionFileDtoSchema>;

export const SkillSubmissionDtoSchema = Type.Object(
  {
    submissionId: IdSchema,
    canonicalKey: CanonicalSkillKeySchema,
    displayName: SkillDisplayNameSchema,
    publisher: SkillPublisherSchema,
    version: SkillVersionSchema,
    description: SkillDescriptionSchema,
    compatibility: SkillCompatibilitySchema,
    sourceUrl: SkillSourceUrlSchema,
    sourceRevision: SkillSourceRevisionSchema,
    licenseSpdx: SkillLicenseSpdxSchema,
    status: SkillPublicationStatusSchema,
    securityStatus: Type.Literal("restricted"),
    packageDigest: Sha256DigestSchema,
    entrypointDigest: Sha256DigestSchema,
    fileCount: Type.Integer({ minimum: 1, maximum: MAX_SKILL_SUBMISSION_FILES }),
    totalBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    versionToken: VersionTokenSchema,
    createdBy: IdSchema,
    reviewedBy: Type.Optional(IdSchema),
    rejectionReason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    files: Type.Array(SkillSubmissionFileDtoSchema, {
      minItems: 1,
      maxItems: MAX_SKILL_SUBMISSION_FILES,
    }),
    entrypointMarkdown: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  },
  { ...strict, $id: "v1.SkillSubmissionDto" },
);
export type SkillSubmissionDto = Static<typeof SkillSubmissionDtoSchema>;

export const SkillSubmissionPageDtoSchema = Type.Object(
  {
    items: Type.Array(SkillSubmissionDtoSchema, { maxItems: 100 }),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { ...strict, $id: "v1.SkillSubmissionPageDto" },
);
export type SkillSubmissionPageDto = Static<typeof SkillSubmissionPageDtoSchema>;

export const SkillSubmissionStatusActionRequestSchema = Type.Object(
  { expectedVersionToken: VersionTokenSchema },
  strict,
);
export type SkillSubmissionStatusActionRequest = Static<
  typeof SkillSubmissionStatusActionRequestSchema
>;

export const SubmitSkillSubmissionRequestSchema = SkillSubmissionStatusActionRequestSchema;
export type SubmitSkillSubmissionRequest = Static<typeof SubmitSkillSubmissionRequestSchema>;

export const ReviewSkillSubmissionRequestSchema = Type.Object(
  {
    expectedVersionToken: VersionTokenSchema,
    decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
    // reject 必须携带 reason 是状态机不变量，由领域层在同一处校验。
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  },
  strict,
);
export type ReviewSkillSubmissionRequest = Static<typeof ReviewSkillSubmissionRequestSchema>;

export const PublishSkillSubmissionRequestSchema = Type.Object(
  {
    expectedVersionToken: VersionTokenSchema,
    recommended: Type.Boolean(),
  },
  strict,
);
export type PublishSkillSubmissionRequest = Static<typeof PublishSkillSubmissionRequestSchema>;

export const RevokeSkillSubmissionRequestSchema = Type.Object(
  {
    expectedVersionToken: VersionTokenSchema,
    reason: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  strict,
);
export type RevokeSkillSubmissionRequest = Static<typeof RevokeSkillSubmissionRequestSchema>;

export const SkillSubmissionSuccessEnvelopeSchema = successEnvelopeSchema(SkillSubmissionDtoSchema);
export const SkillSubmissionPageSuccessEnvelopeSchema = successEnvelopeSchema(
  SkillSubmissionPageDtoSchema,
);

export const CreateSkillSubmissionSuccessEnvelopeSchema = SkillSubmissionSuccessEnvelopeSchema;
export const SubmitSkillSubmissionSuccessEnvelopeSchema = SkillSubmissionSuccessEnvelopeSchema;
export const ReviewSkillSubmissionSuccessEnvelopeSchema = SkillSubmissionSuccessEnvelopeSchema;
export const PublishSkillSubmissionSuccessEnvelopeSchema = SkillSubmissionSuccessEnvelopeSchema;
export const RevokeSkillSubmissionSuccessEnvelopeSchema = SkillSubmissionSuccessEnvelopeSchema;
