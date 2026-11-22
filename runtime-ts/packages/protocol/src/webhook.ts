import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";
const strict = { additionalProperties: false } as const;
export const WebhookEventTypeSchema = Type.Union([
  Type.Literal("run.waiting"),
  Type.Literal("run.requires_action"),
  Type.Literal("run.succeeded"),
  Type.Literal("run.failed"),
  Type.Literal("run.cancelled"),
  Type.Literal("artifact.published"),
]);
export type WebhookEventType = Static<typeof WebhookEventTypeSchema>;
export const TenantWebhookSchema = Type.Object(
  {
    id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    endpointUrl: Type.String({ maxLength: 2048 }),
    eventTypes: Type.Array(WebhookEventTypeSchema, { minItems: 1 }),
    createdAt: IsoTimestampSchema,
    disabledAt: Type.Optional(IsoTimestampSchema),
    disabledReason: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  strict,
);
export type TenantWebhookDto = Static<typeof TenantWebhookSchema>;
export const CreateWebhookRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
    endpointUrl: Type.String({ maxLength: 2048 }),
    eventTypes: Type.Array(WebhookEventTypeSchema, { minItems: 1, uniqueItems: true }),
  },
  strict,
);
export type CreateWebhookRequest = Static<typeof CreateWebhookRequestSchema>;
export const WebhookPathSchema = Type.Object({ webhookId: IdSchema }, strict);
export const WebhookListSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ items: Type.Array(TenantWebhookSchema) }, strict),
);
export const WebhookCreatedSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ webhook: TenantWebhookSchema, secret: Type.String({ minLength: 1 }) }, strict),
);
export const WebhookSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ webhook: TenantWebhookSchema }, strict),
);
export const WebhookSecretSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ secret: Type.String({ minLength: 1 }) }, strict),
);
export const WebhookDeletedSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ deleted: Type.Boolean() }, strict),
);
