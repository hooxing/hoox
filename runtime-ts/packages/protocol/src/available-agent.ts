import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const AvailableAgentDtoSchema = Type.Object(
  {
    id: IdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 2048 }),
    avatarRef: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    welcomeMessage: Type.Optional(Type.String({ maxLength: 2048 })),
    suggestedQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      maxItems: 12,
    }),
  },
  { ...strict, $id: "v1.AvailableAgentDto" },
);
export type AvailableAgentDto = Static<typeof AvailableAgentDtoSchema>;

export const AvailableAgentListSchema = Type.Object(
  { items: Type.Array(AvailableAgentDtoSchema, { maxItems: 1000 }) },
  { ...strict, $id: "v1.AvailableAgentList" },
);
export type AvailableAgentList = Static<typeof AvailableAgentListSchema>;
export const AvailableAgentListSuccessEnvelopeSchema =
  successEnvelopeSchema(AvailableAgentListSchema);
