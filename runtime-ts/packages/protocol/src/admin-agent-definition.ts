import { type Static, Type } from "@sinclair/typebox";
import {
  AgentAvailabilitySchema,
  AgentDefinitionDtoSchema,
  AgentPinnedModelReferenceSchema,
  AgentRevisionContentSchema,
  AgentRevisionDtoSchema,
} from "./agent-definition.js";
import { IdSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const expectedGeneration = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const AdminCreateAgentDefinitionSchema = Type.Object(
  {
    id: IdSchema,
    revisionId: IdSchema,
    availability: AgentAvailabilitySchema,
    content: AgentRevisionContentSchema,
    expectedGeneration,
  },
  strict,
);
export type AdminCreateAgentDefinition = Static<typeof AdminCreateAgentDefinitionSchema>;
export const AdminSaveAgentRevisionSchema = Type.Object(
  { revisionId: IdSchema, content: AgentRevisionContentSchema, expectedGeneration },
  strict,
);
export type AdminSaveAgentRevision = Static<typeof AdminSaveAgentRevisionSchema>;
export const AdminAgentGenerationSchema = Type.Object({ expectedGeneration }, strict);
export type AdminAgentGeneration = Static<typeof AdminAgentGenerationSchema>;
export const AdminRevokeAgentRevisionSchema = Type.Object(
  { expectedGeneration, reason: Type.String({ minLength: 1, maxLength: 500 }) },
  strict,
);
export type AdminRevokeAgentRevision = Static<typeof AdminRevokeAgentRevisionSchema>;
export const AdminSetAgentAvailabilitySchema = Type.Object(
  { expectedGeneration, availability: AgentAvailabilitySchema },
  strict,
);
export type AdminSetAgentAvailability = Static<typeof AdminSetAgentAvailabilitySchema>;

const AgentRevisionSummarySchema = Type.Object(
  {
    ...Type.Omit(AgentRevisionDtoSchema, ["content"]).properties,
    displayName: Type.String(),
  },
  strict,
);
export const AdminAgentDefinitionListSchema = Type.Object(
  {
    canManage: Type.Boolean(),
    builtinToolLimit: Type.Array(Type.String()),
    pinnedModelOptions: Type.Array(AgentPinnedModelReferenceSchema),
    items: Type.Array(
      Type.Object(
        {
          definition: AgentDefinitionDtoSchema,
          revision: Type.Optional(AgentRevisionSummarySchema),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type AdminAgentDefinitionList = Static<typeof AdminAgentDefinitionListSchema>;
export const AdminAgentRevisionHistorySchema = Type.Object(
  { definition: AgentDefinitionDtoSchema, items: Type.Array(AgentRevisionSummarySchema) },
  strict,
);
export type AdminAgentRevisionHistory = Static<typeof AdminAgentRevisionHistorySchema>;
