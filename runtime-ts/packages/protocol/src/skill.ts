import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const CanonicalSkillKeySchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
  maxLength: 128,
});
const SkillVersionSchema = Type.String({
  pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$",
  maxLength: 64,
});
const InvocationNameSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  maxLength: 128,
});

export const SkillPathSchema = Type.Object({ canonicalKey: CanonicalSkillKeySchema }, strict);
export type SkillPath = Static<typeof SkillPathSchema>;

export const SkillCatalogQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 256 })),
    cursor: Type.Optional(CanonicalSkillKeySchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  },
  strict,
);
export type SkillCatalogQuery = Static<typeof SkillCatalogQuerySchema>;

export const SkillCatalogItemDtoSchema = Type.Object(
  {
    canonicalKey: CanonicalSkillKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    publisher: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2_048 }),
    recommendedVersion: SkillVersionSchema,
    compatibility: Type.String({ minLength: 1, maxLength: 500 }),
    securityStatus: Type.Union([Type.Literal("verified"), Type.Literal("restricted")]),
  },
  { ...strict, $id: "v1.SkillCatalogItemDto" },
);
export type SkillCatalogItemDto = Static<typeof SkillCatalogItemDtoSchema>;

export const SkillCatalogPageDtoSchema = Type.Object(
  {
    items: Type.Array(SkillCatalogItemDtoSchema, { maxItems: 100 }),
    nextCursor: Type.Optional(CanonicalSkillKeySchema),
  },
  { ...strict, $id: "v1.SkillCatalogPageDto" },
);
export type SkillCatalogPageDto = Static<typeof SkillCatalogPageDtoSchema>;

export const SkillInstallationDtoSchema = Type.Object(
  {
    canonicalKey: CanonicalSkillKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    publisher: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2_048 }),
    skillVersion: SkillVersionSchema,
    invocationName: InvocationNameSchema,
    status: Type.Union([Type.Literal("enabled"), Type.Literal("disabled")]),
    versionToken: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    installedAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.SkillInstallationDto" },
);
export type SkillInstallationDto = Static<typeof SkillInstallationDtoSchema>;

export const SkillInstallationListDtoSchema = Type.Object(
  { items: Type.Array(SkillInstallationDtoSchema, { maxItems: 64 }) },
  { ...strict, $id: "v1.SkillInstallationListDto" },
);

export const InstallSkillRequestSchema = Type.Object(
  {
    version: Type.Union([Type.Literal("recommended"), SkillVersionSchema]),
    invocationName: InvocationNameSchema,
  },
  strict,
);
export type InstallSkillRequest = Static<typeof InstallSkillRequestSchema>;

export const ConfigureSkillRequestSchema = Type.Object(
  {
    expectedVersionToken: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    version: Type.Optional(Type.Union([Type.Literal("recommended"), SkillVersionSchema])),
    invocationName: Type.Optional(InvocationNameSchema),
    enabled: Type.Optional(Type.Boolean()),
  },
  { ...strict, minProperties: 2 },
);
export type ConfigureSkillRequest = Static<typeof ConfigureSkillRequestSchema>;

export const UninstallSkillQuerySchema = Type.Object(
  {
    expectedVersionToken: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  strict,
);
export type UninstallSkillQuery = Static<typeof UninstallSkillQuerySchema>;

export const SkillUninstallResultDtoSchema = Type.Object(
  { canonicalKey: CanonicalSkillKeySchema, uninstalled: Type.Literal(true) },
  { ...strict, $id: "v1.SkillUninstallResultDto" },
);

export const SkillCatalogPageSuccessEnvelopeSchema =
  successEnvelopeSchema(SkillCatalogPageDtoSchema);
export const SkillInstallationListSuccessEnvelopeSchema = successEnvelopeSchema(
  SkillInstallationListDtoSchema,
);
export const SkillInstallationSuccessEnvelopeSchema = successEnvelopeSchema(
  SkillInstallationDtoSchema,
);
export const SkillUninstallSuccessEnvelopeSchema = successEnvelopeSchema(
  SkillUninstallResultDtoSchema,
);
