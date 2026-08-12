import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
// TypeBox maxLength 按 UTF-16 code unit 工作；真正的 2,000 Unicode 字符与 8 KiB 边界由领域层验证。
export const PERSONALIZATION_CONTENT_SCHEMA_MAX_LENGTH = 8_192;

export const PersonalPersonalizationDtoSchema = Type.Object(
  {
    content: Type.String({ maxLength: PERSONALIZATION_CONTENT_SCHEMA_MAX_LENGTH }),
    applyToTeamTasks: Type.Boolean(),
    version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    updatedAt: Type.Optional(IsoTimestampSchema),
  },
  { ...strict, $id: "v1.PersonalPersonalizationDto" },
);
export type PersonalPersonalizationDto = Static<typeof PersonalPersonalizationDtoSchema>;

export const TeamPersonalizationDtoSchema = Type.Object(
  {
    teamId: IdSchema,
    content: Type.String({ maxLength: PERSONALIZATION_CONTENT_SCHEMA_MAX_LENGTH }),
    version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    canEdit: Type.Boolean(),
    updatedAt: Type.Optional(IsoTimestampSchema),
  },
  { ...strict, $id: "v1.TeamPersonalizationDto" },
);
export type TeamPersonalizationDto = Static<typeof TeamPersonalizationDtoSchema>;

export const UpdatePersonalPersonalizationRequestSchema = Type.Object(
  {
    content: Type.String({ maxLength: PERSONALIZATION_CONTENT_SCHEMA_MAX_LENGTH }),
    applyToTeamTasks: Type.Boolean(),
    expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  strict,
);
export type UpdatePersonalPersonalizationRequest = Static<
  typeof UpdatePersonalPersonalizationRequestSchema
>;

export const UpdateTeamPersonalizationRequestSchema = Type.Object(
  {
    content: Type.String({ maxLength: PERSONALIZATION_CONTENT_SCHEMA_MAX_LENGTH }),
    expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  strict,
);
export type UpdateTeamPersonalizationRequest = Static<
  typeof UpdateTeamPersonalizationRequestSchema
>;

export const PersonalPersonalizationSuccessEnvelopeSchema = successEnvelopeSchema(
  PersonalPersonalizationDtoSchema,
);
export const TeamPersonalizationSuccessEnvelopeSchema = successEnvelopeSchema(
  TeamPersonalizationDtoSchema,
);
