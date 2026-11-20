import { type Static, Type } from "@sinclair/typebox";
import { IdSchema, IsoTimestampSchema, Sha256DigestSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const boundedText = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const AgentAvailabilitySchema = Type.Union([
  Type.Object({ mode: Type.Literal("all_tenants") }, strict),
  Type.Object(
    {
      mode: Type.Literal("selected_tenants"),
      tenantIds: Type.Array(IdSchema, { minItems: 1, maxItems: 1000, uniqueItems: true }),
    },
    strict,
  ),
]);
const AgentModelReferenceSchema = Type.Union([
  Type.Object({ mode: Type.Literal("platform_default") }, strict),
  Type.Object(
    { mode: Type.Literal("pinned"), providerRevisionId: IdSchema, modelId: boundedText(200) },
    strict,
  ),
]);
export const AgentRevisionContentSchema = Type.Object(
  {
    displayName: boundedText(200),
    description: Type.String({ maxLength: 2048 }),
    avatarRef: Type.Optional(boundedText(512)),
    welcomeMessage: Type.Optional(Type.String({ maxLength: 2048 })),
    suggestedQuestions: Type.Array(boundedText(500), { maxItems: 12 }),
    operatorInstructions: boundedText(32768),
    replyLanguage: boundedText(100),
    model: AgentModelReferenceSchema,
    builtinTools: Type.Array(boundedText(100), { maxItems: 64, uniqueItems: true }),
    externalTools: Type.Array(
      Type.Object(
        { kind: Type.Union([Type.Literal("mcp"), Type.Literal("http")]), versionId: IdSchema },
        strict,
      ),
      { maxItems: 64 },
    ),
    clientTools: Type.Array(
      Type.Object(
        {
          name: boundedText(100),
          description: boundedText(1000),
          inputSchema: Type.Record(Type.String(), Type.Unknown()),
        },
        strict,
      ),
      { maxItems: 64 },
    ),
    toolCallingMode: Type.Union([Type.Literal("native"), Type.Literal("ptc")]),
    skillVersions: Type.Array(
      Type.Object({ skillId: IdSchema, version: boundedText(64) }, strict),
      { maxItems: 64 },
    ),
    includeTenantSkills: Type.Boolean(),
    sandboxTemplateId: Type.Optional(IdSchema),
    sandboxIdleAction: Type.Union([Type.Literal("pause"), Type.Literal("kill")]),
    longTermMemoryEnabled: Type.Boolean(),
  },
  { ...strict, $id: "v1.AgentRevisionContent" },
);
export type AgentRevisionContentDto = Static<typeof AgentRevisionContentSchema>;
export const AgentDefinitionStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("published"),
  Type.Literal("disabled"),
  Type.Literal("revoked"),
]);
export const AgentRevisionStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("published"),
  Type.Literal("revoked"),
]);
export const AgentDefinitionDtoSchema = Type.Object(
  {
    id: IdSchema,
    status: AgentDefinitionStatusSchema,
    generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    availability: AgentAvailabilitySchema,
    currentRevisionId: Type.Optional(IdSchema),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.AgentDefinitionDto" },
);
export type AgentDefinitionDto = Static<typeof AgentDefinitionDtoSchema>;
export const AgentRevisionDtoSchema = Type.Object(
  {
    id: IdSchema,
    definitionId: IdSchema,
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    status: AgentRevisionStatusSchema,
    content: AgentRevisionContentSchema,
    digest: Sha256DigestSchema,
    createdAt: IsoTimestampSchema,
    createdBy: IdSchema,
  },
  { ...strict, $id: "v1.AgentRevisionDto" },
);
export type AgentRevisionDto = Static<typeof AgentRevisionDtoSchema>;
export const CreateAgentDefinitionRequestSchema = Type.Object(
  {
    id: IdSchema,
    availability: AgentAvailabilitySchema,
    content: AgentRevisionContentSchema,
    idempotencyKey: boundedText(200),
    expectedGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.CreateAgentDefinitionRequest" },
);
export const PublishAgentRevisionRequestSchema = Type.Object(
  {
    definitionId: IdSchema,
    revisionId: IdSchema,
    idempotencyKey: boundedText(200),
    expectedGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.PublishAgentRevisionRequest" },
);
export const AgentDefinitionIdRequestSchema = Type.Object(
  {
    definitionId: IdSchema,
    idempotencyKey: boundedText(200),
    expectedGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.AgentDefinitionIdRequest" },
);
export const RevokeAgentRevisionRequestSchema = Type.Object(
  {
    definitionId: IdSchema,
    revisionId: IdSchema,
    idempotencyKey: boundedText(200),
    expectedGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.RevokeAgentRevisionRequest" },
);
export const AgentDefinitionResponseSchema = Type.Object(
  { definition: AgentDefinitionDtoSchema, revision: Type.Optional(AgentRevisionDtoSchema) },
  { additionalProperties: false, $id: "v1.AgentDefinitionResponse" },
);

export const CreateAgentRevisionRequestSchema = Type.Object(
  {
    definitionId: IdSchema,
    revisionId: IdSchema,
    content: AgentRevisionContentSchema,
    idempotencyKey: boundedText(200),
    expectedGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { ...strict, $id: "v1.CreateAgentRevisionRequest" },
);
export const AgentDefinitionListResponseSchema = Type.Object(
  { items: Type.Array(AgentDefinitionResponseSchema, { maxItems: 1000 }) },
  { ...strict, $id: "v1.AgentDefinitionListResponse" },
);
