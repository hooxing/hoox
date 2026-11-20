import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
export const ApiKeyScopeSchema = Type.Union([
  Type.Literal("threads:read"),
  Type.Literal("runs:read"),
  Type.Literal("threads:create"),
  Type.Literal("runs:create"),
  Type.Literal("tool-results:submit"),
  Type.Literal("webhooks:manage"),
]);
export const ApiKeyDtoSchema = Type.Object(
  {
    id: IdSchema,
    prefix: Type.String({ minLength: 1, maxLength: 32 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    note: Type.Optional(Type.String({ maxLength: 500 })),
    scopes: Type.Array(ApiKeyScopeSchema, { minItems: 1 }),
    createdAt: IsoTimestampSchema,
    expiresAt: Type.Optional(IsoTimestampSchema),
    revokedAt: Type.Optional(IsoTimestampSchema),
    lastUsedAt: Type.Optional(IsoTimestampSchema),
  },
  strict,
);
export type ApiKeyDto = Static<typeof ApiKeyDtoSchema>;
export const CreateApiKeyRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    note: Type.Optional(Type.String({ maxLength: 500 })),
    scopes: Type.Array(ApiKeyScopeSchema, { minItems: 1, uniqueItems: true }),
    expiresAt: Type.Optional(IsoTimestampSchema),
  },
  strict,
);
export type CreateApiKeyRequest = Static<typeof CreateApiKeyRequestSchema>;
export const ApiKeyPathSchema = Type.Object({ keyId: IdSchema }, strict);
export const ApiKeyListSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ items: Type.Array(ApiKeyDtoSchema) }, strict),
);
export const ApiKeyCreatedSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ key: ApiKeyDtoSchema, token: Type.String({ minLength: 1 }) }, strict),
);
export const ApiKeySuccessEnvelopeSchema = successEnvelopeSchema(ApiKeyDtoSchema);
