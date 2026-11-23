import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

import { RUNTIME_TOOL_NAMES } from "./tool-configuration.js";

const strict = { additionalProperties: false } as const;
const ProviderKeySchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  maxLength: 64,
});
const VersionTokenSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RevisionNumberSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const ChangeReasonSchema = Type.String({ minLength: 1, maxLength: 500 });
const ProviderUrlSchema = Type.String({ minLength: 9, maxLength: 2_048 });

export const ControlRevisionStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("active"),
  Type.Literal("retired"),
]);
export const ProviderProbeStatusSchema = Type.Union([
  Type.Literal("untested"),
  Type.Literal("healthy"),
  Type.Literal("failed"),
]);

export const ModelProviderModelConfigurationDtoSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 255 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    enabled: Type.Boolean(),
    reasoning: Type.Boolean(),
    input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    contextWindow: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    pricing: Type.Optional(
      Type.Object(
        {
          currency: Type.String({ pattern: "^[A-Z]{3}$" }),
          inputPerMillion: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
          outputPerMillion: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
          cacheReadPerMillion: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type ModelProviderModelConfigurationDto = Static<
  typeof ModelProviderModelConfigurationDtoSchema
>;

export const ModelProviderConfigurationDtoSchema = Type.Object(
  {
    providerKey: ProviderKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    protocol: Type.Literal("openai-compatible"),
    baseUrl: ProviderUrlSchema,
    credentialConfigured: Type.Boolean(),
    defaultModelId: Type.String({ minLength: 1, maxLength: 255 }),
    models: Type.Array(ModelProviderModelConfigurationDtoSchema, {
      minItems: 1,
      maxItems: 100,
    }),
  },
  strict,
);
export type ModelProviderConfigurationDto = Static<typeof ModelProviderConfigurationDtoSchema>;

export const AgentMetricsQueryDtoSchema = Type.Object(
  {
    from: IsoTimestampSchema,
    to: IsoTimestampSchema,
    agentDefinitionId: Type.Optional(IdSchema),
    agentRevisionId: Type.Optional(IdSchema),
    tenantId: Type.Optional(IdSchema),
    origin: Type.Optional(
      Type.Union([
        Type.Literal("normal"),
        Type.Literal("api"),
        Type.Literal("playground"),
        Type.Literal("evaluation"),
      ]),
    ),
  },
  strict,
);
export type AgentMetricsQueryDto = Static<typeof AgentMetricsQueryDtoSchema>;

export const AgentMetricsRowDtoSchema = Type.Object(
  {
    windowStart: IsoTimestampSchema,
    agentDefinitionId: Type.Union([IdSchema, Type.Null()]),
    agentRevisionId: Type.Union([IdSchema, Type.Null()]),
    tenantId: IdSchema,
    origin: Type.String(),
    currency: Type.Union([Type.String(), Type.Null()]),
    runCount: Type.Integer({ minimum: 0 }),
    succeededCount: Type.Integer({ minimum: 0 }),
    failedCount: Type.Integer({ minimum: 0 }),
    resultUnknownCount: Type.Integer({ minimum: 0 }),
    successRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    failureRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    resultUnknownRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    feedbackUpCount: Type.Integer({ minimum: 0 }),
    feedbackDownCount: Type.Integer({ minimum: 0 }),
    feedbackUpRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    feedbackDownRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    toolFailureRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    latencyP50Ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    latencyP90Ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    latencyP99Ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    averageModelRounds: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    toolCalls: Type.Integer({ minimum: 0 }),
    failedToolCalls: Type.Integer({ minimum: 0 }),
    inputTokens: Type.Number({ minimum: 0 }),
    outputTokens: Type.Number({ minimum: 0 }),
    cacheReadTokens: Type.Number({ minimum: 0 }),
    cost: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  },
  strict,
);
export type AgentMetricsRowDto = Static<typeof AgentMetricsRowDtoSchema>;
export const AgentMetricsSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ items: Type.Array(AgentMetricsRowDtoSchema) }, strict),
);

export const PiModelCatalogProviderDtoSchema = Type.Object(
  {
    providerId: ProviderKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    baseUrl: ProviderUrlSchema,
    modelCount: Type.Integer({ minimum: 1, maximum: 10_000 }),
  },
  strict,
);
export type PiModelCatalogProviderDto = Static<typeof PiModelCatalogProviderDtoSchema>;

export const PiModelCatalogModelDtoSchema = Type.Object(
  {
    providerId: ProviderKeySchema,
    providerName: Type.String({ minLength: 1, maxLength: 120 }),
    id: Type.String({ minLength: 1, maxLength: 255 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    api: Type.Literal("openai-completions"),
    reasoning: Type.Boolean(),
    input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    contextWindow: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  },
  strict,
);
export type PiModelCatalogModelDto = Static<typeof PiModelCatalogModelDtoSchema>;

export const MemoryProviderConfigurationDtoSchema = Type.Object(
  {
    providerKey: ProviderKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    providerKind: Type.Literal("mem0"),
    baseUrl: ProviderUrlSchema,
    apiSecretRef: Type.Union([
      Type.Literal("deployment:memory-api"),
      Type.Literal("managed:memory-api"),
    ]),
    scopeSecretRef: Type.Union([
      Type.Literal("deployment:memory-scope"),
      Type.Literal("platform:memory-scope"),
    ]),
    requestTimeoutMs: Type.Integer({ minimum: 100, maximum: 120_000 }),
    enabled: Type.Boolean(),
  },
  strict,
);
export type MemoryProviderConfigurationDto = Static<typeof MemoryProviderConfigurationDtoSchema>;

const TitleGenerationConfigurationSchema = Type.Union([
  Type.Object({ enabled: Type.Literal(false) }, strict),
  Type.Object(
    {
      enabled: Type.Literal(true),
      providerKey: ProviderKeySchema,
      providerRevision: RevisionNumberSchema,
      modelId: Type.String({ minLength: 1, maxLength: 512 }),
    },
    strict,
  ),
]);

export const RuntimeSettingsConfigurationDtoSchema = Type.Object(
  {
    enabledTools: Type.Optional(
      Type.Array(Type.Union(RUNTIME_TOOL_NAMES.map((name) => Type.Literal(name))), {
        uniqueItems: true,
        maxItems: RUNTIME_TOOL_NAMES.length,
      }),
    ),
    toolCallingMode: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("ptc")])),
    titleGeneration: Type.Optional(TitleGenerationConfigurationSchema),
    compactionEnabled: Type.Optional(Type.Boolean()),
    workerMaxConcurrentRuns: Type.Integer({ minimum: 1, maximum: 100 }),
    userMaxConcurrentRunsPerTenant: Type.Integer({ minimum: 1, maximum: 100 }),
    compactionSoftLimitPercent: Type.Integer({ minimum: 50, maximum: 95 }),
    compactionTargetPercent: Type.Integer({ minimum: 20, maximum: 90 }),
    compactionRecentUserTokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    compactionMaxOutputTokens: Type.Integer({ minimum: 128, maximum: 1_000_000 }),
    compactionTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 600_000 }),
  },
  strict,
);
export type RuntimeSettingsConfigurationDto = Static<typeof RuntimeSettingsConfigurationDtoSchema>;

export const SaveRuntimeSettingsConfigurationRequestSchema = Type.Composite(
  [
    RuntimeSettingsConfigurationDtoSchema,
    Type.Object({ expectedGeneration: Type.Integer({ minimum: 0 }) }, strict),
  ],
  strict,
);
export type SaveRuntimeSettingsConfigurationRequest = Static<
  typeof SaveRuntimeSettingsConfigurationRequestSchema
>;

function revisionSchema<T extends ReturnType<typeof Type.Object>>(configuration: T) {
  return Type.Object(
    {
      revision: RevisionNumberSchema,
      versionToken: VersionTokenSchema,
      status: ControlRevisionStatusSchema,
      configuration,
      probeStatus: ProviderProbeStatusSchema,
      createdBy: IdSchema,
      createdAt: IsoTimestampSchema,
      updatedAt: IsoTimestampSchema,
      activatedAt: Type.Optional(IsoTimestampSchema),
    },
    strict,
  );
}

export const ModelProviderRevisionDtoSchema = revisionSchema(ModelProviderConfigurationDtoSchema);
export type ModelProviderRevisionDto = Static<typeof ModelProviderRevisionDtoSchema>;
export const MemoryProviderRevisionDtoSchema = revisionSchema(MemoryProviderConfigurationDtoSchema);
export type MemoryProviderRevisionDto = Static<typeof MemoryProviderRevisionDtoSchema>;
export const RuntimeSettingsRevisionDtoSchema = revisionSchema(
  RuntimeSettingsConfigurationDtoSchema,
);
export type RuntimeSettingsRevisionDto = Static<typeof RuntimeSettingsRevisionDtoSchema>;

export const RuntimeStatisticsDtoSchema = Type.Object(
  {
    generatedAt: IsoTimestampSchema,
    users: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        registered24h: Type.Integer({ minimum: 0 }),
        active7d: Type.Integer({ minimum: 0 }),
        disabled: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
    conversations: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        created24h: Type.Integer({ minimum: 0 }),
        active24h: Type.Integer({ minimum: 0 }),
        archived: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
    runs: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        queued: Type.Integer({ minimum: 0 }),
        running: Type.Integer({ minimum: 0 }),
        succeeded24h: Type.Integer({ minimum: 0 }),
        failed24h: Type.Integer({ minimum: 0 }),
        cancelled24h: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
    dispatch: Type.Object(
      { pending: Type.Integer({ minimum: 0 }), claimed: Type.Integer({ minimum: 0 }) },
      strict,
    ),
    sandboxes: Type.Object(
      {
        active: Type.Integer({ minimum: 0 }),
        paused: Type.Integer({ minimum: 0 }),
        cleanupPending: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
    memory: Type.Object(
      { pending: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }) },
      strict,
    ),
    automations: Type.Object(
      { active: Type.Integer({ minimum: 0 }), failedOccurrences24h: Type.Integer({ minimum: 0 }) },
      strict,
    ),
    skills: Type.Object(
      { published: Type.Integer({ minimum: 0 }), installed: Type.Integer({ minimum: 0 }) },
      strict,
    ),
    modelUsage24h: Type.Object(
      {
        inputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        outputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        outputTokensPerSecond: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
        cacheHitRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
      },
      strict,
    ),
  },
  strict,
);
export type RuntimeStatisticsDto = Static<typeof RuntimeStatisticsDtoSchema>;

export const PlatformUserSummaryDtoSchema = Type.Object(
  {
    userId: IdSchema,
    email: Type.String({ maxLength: 254 }),
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    source: Type.Optional(Type.Literal("api_mapping")),
    status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
    createdAt: IsoTimestampSchema,
    lastActiveAt: Type.Optional(IsoTimestampSchema),
    activeSessions: Type.Integer({ minimum: 0 }),
    conversationCount: Type.Integer({ minimum: 0 }),
    runCount: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export type PlatformUserSummaryDto = Static<typeof PlatformUserSummaryDtoSchema>;

export const PlatformUserPageDtoSchema = Type.Object(
  {
    items: Type.Array(PlatformUserSummaryDtoSchema, { maxItems: 200 }),
    total: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export type PlatformUserPageDto = Static<typeof PlatformUserPageDtoSchema>;

export const DeploymentSettingDescriptorDtoSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 128 }),
    category: Type.Union([
      Type.Literal("bootstrap"),
      Type.Literal("secret"),
      Type.Literal("restart_required"),
    ]),
    source: Type.Literal("environment"),
    configured: Type.Boolean(),
    mutable: Type.Literal(false),
    description: Type.String({ minLength: 1, maxLength: 500 }),
  },
  strict,
);
export type DeploymentSettingDescriptorDto = Static<typeof DeploymentSettingDescriptorDtoSchema>;

export const AdminControlOverviewDtoSchema = Type.Object(
  {
    runtimeEnvironment: Type.Optional(
      Type.Union([Type.Literal("development"), Type.Literal("test"), Type.Literal("production")]),
    ),
    generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    activeModel: Type.Optional(ModelProviderRevisionDtoSchema),
    activeMemory: Type.Optional(MemoryProviderRevisionDtoSchema),
    activeRuntimeSettings: Type.Optional(RuntimeSettingsRevisionDtoSchema),
    statistics: RuntimeStatisticsDtoSchema,
    deploymentSettings: Type.Array(DeploymentSettingDescriptorDtoSchema, { maxItems: 256 }),
  },
  { ...strict, $id: "v1.AdminControlOverviewDto" },
);
export type AdminControlOverviewDto = Static<typeof AdminControlOverviewDtoSchema>;

export const CreateModelProviderDraftRequestSchema = Type.Composite(
  [
    Type.Omit(ModelProviderConfigurationDtoSchema, ["credentialConfigured"]),
    Type.Object(
      {
        apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192 })),
        reuseCredentialFromRevision: Type.Optional(RevisionNumberSchema),
      },
      strict,
    ),
  ],
  strict,
);
export type CreateModelProviderDraftRequest = Static<typeof CreateModelProviderDraftRequestSchema>;

export const ModelProviderControlRevisionRequestSchema = Type.Object(
  { expectedVersionToken: VersionTokenSchema },
  strict,
);
export type ModelProviderControlRevisionRequest = Static<
  typeof ModelProviderControlRevisionRequestSchema
>;

export const CreateMemoryProviderDraftRequestSchema = Type.Composite(
  [
    MemoryProviderConfigurationDtoSchema,
    Type.Object({ reason: Type.Optional(ChangeReasonSchema) }, strict),
  ],
  strict,
);
export type CreateMemoryProviderDraftRequest = Static<
  typeof CreateMemoryProviderDraftRequestSchema
>;

const SaveConfigurationExpectationSchema = Type.Object(
  { expectedGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) },
  strict,
);

export const SaveModelProviderConfigurationRequestSchema = Type.Composite(
  [CreateModelProviderDraftRequestSchema, SaveConfigurationExpectationSchema],
  strict,
);
export type SaveModelProviderConfigurationRequest = Static<
  typeof SaveModelProviderConfigurationRequestSchema
>;

export const SaveMemoryProviderConfigurationRequestSchema = Type.Composite(
  [
    CreateMemoryProviderDraftRequestSchema,
    SaveConfigurationExpectationSchema,
    Type.Object(
      {
        apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
        reuseCredentialFromRevision: Type.Optional(
          Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        ),
      },
      strict,
    ),
  ],
  strict,
);
export type SaveMemoryProviderConfigurationRequest = Static<
  typeof SaveMemoryProviderConfigurationRequestSchema
>;

export const CreateRuntimeSettingsDraftRequestSchema = Type.Composite(
  [RuntimeSettingsConfigurationDtoSchema, Type.Object({ reason: ChangeReasonSchema }, strict)],
  strict,
);
export type CreateRuntimeSettingsDraftRequest = Static<
  typeof CreateRuntimeSettingsDraftRequestSchema
>;

export const ProbeControlRevisionRequestSchema = Type.Object(
  { expectedVersionToken: VersionTokenSchema, reason: Type.Optional(ChangeReasonSchema) },
  strict,
);
export type ProbeControlRevisionRequest = Static<typeof ProbeControlRevisionRequestSchema>;

export const PublishControlRevisionRequestSchema = ProbeControlRevisionRequestSchema;
export type PublishControlRevisionRequest = Static<typeof PublishControlRevisionRequestSchema>;

export const UpdatePlatformUserStatusRequestSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
    reason: Type.Optional(ChangeReasonSchema),
  },
  strict,
);
export type UpdatePlatformUserStatusRequest = Static<typeof UpdatePlatformUserStatusRequestSchema>;

export const PlatformUserPathSchema = Type.Object({ userId: IdSchema }, strict);
export type PlatformUserPath = Static<typeof PlatformUserPathSchema>;

export const PlatformUserQuerySchema = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  strict,
);

export const ControlRevisionPathSchema = Type.Object(
  { providerKey: ProviderKeySchema, revision: RevisionNumberSchema },
  strict,
);
export type ControlRevisionPath = Static<typeof ControlRevisionPathSchema>;

export const ControlAuditEventDtoSchema = Type.Object(
  {
    auditId: IdSchema,
    actorUserId: IdSchema,
    objectKind: Type.Union([
      Type.Literal("model_provider"),
      Type.Literal("memory_provider"),
      Type.Literal("runtime_settings"),
    ]),
    objectKey: Type.String({ minLength: 1, maxLength: 64 }),
    revision: RevisionNumberSchema,
    action: Type.Union([
      Type.Literal("create_draft"),
      Type.Literal("probe"),
      Type.Literal("publish"),
      Type.Literal("rollback"),
    ]),
    reason: ChangeReasonSchema,
    outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
    createdAt: IsoTimestampSchema,
  },
  strict,
);
export type ControlAuditEventDto = Static<typeof ControlAuditEventDtoSchema>;

export const ModelProviderRevisionListDtoSchema = Type.Object(
  { items: Type.Array(ModelProviderRevisionDtoSchema, { maxItems: 500 }) },
  strict,
);
export const MemoryProviderRevisionListDtoSchema = Type.Object(
  { items: Type.Array(MemoryProviderRevisionDtoSchema, { maxItems: 500 }) },
  strict,
);
export const RuntimeSettingsRevisionListDtoSchema = Type.Object(
  { items: Type.Array(RuntimeSettingsRevisionDtoSchema, { maxItems: 500 }) },
  strict,
);
export const ControlAuditListDtoSchema = Type.Object(
  { items: Type.Array(ControlAuditEventDtoSchema, { maxItems: 200 }) },
  strict,
);
export const PiModelCatalogProviderListDtoSchema = Type.Object(
  { items: Type.Array(PiModelCatalogProviderDtoSchema, { maxItems: 100 }) },
  strict,
);
export const PiModelCatalogModelListDtoSchema = Type.Object(
  { items: Type.Array(PiModelCatalogModelDtoSchema, { maxItems: 100 }) },
  strict,
);

export const AdminControlOverviewSuccessEnvelopeSchema = successEnvelopeSchema(
  AdminControlOverviewDtoSchema,
);
export const ModelProviderRevisionSuccessEnvelopeSchema = successEnvelopeSchema(
  ModelProviderRevisionDtoSchema,
);
export const MemoryProviderRevisionSuccessEnvelopeSchema = successEnvelopeSchema(
  MemoryProviderRevisionDtoSchema,
);
export const ModelProviderRevisionListSuccessEnvelopeSchema = successEnvelopeSchema(
  ModelProviderRevisionListDtoSchema,
);
export const MemoryProviderRevisionListSuccessEnvelopeSchema = successEnvelopeSchema(
  MemoryProviderRevisionListDtoSchema,
);
export const RuntimeSettingsRevisionSuccessEnvelopeSchema = successEnvelopeSchema(
  RuntimeSettingsRevisionDtoSchema,
);
export const RuntimeSettingsRevisionListSuccessEnvelopeSchema = successEnvelopeSchema(
  RuntimeSettingsRevisionListDtoSchema,
);
export const ControlAuditListSuccessEnvelopeSchema =
  successEnvelopeSchema(ControlAuditListDtoSchema);
export const PiModelCatalogProviderListSuccessEnvelopeSchema = successEnvelopeSchema(
  PiModelCatalogProviderListDtoSchema,
);
export const PiModelCatalogModelListSuccessEnvelopeSchema = successEnvelopeSchema(
  PiModelCatalogModelListDtoSchema,
);
export const PlatformUserPageSuccessEnvelopeSchema =
  successEnvelopeSchema(PlatformUserPageDtoSchema);
export const PlatformUserSummarySuccessEnvelopeSchema = successEnvelopeSchema(
  PlatformUserSummaryDtoSchema,
);

const IdentityProviderKeyAdminSchema = Type.Union([
  Type.Literal("google"),
  Type.Literal("github"),
  Type.Literal("wechat"),
  Type.Literal("qq"),
]);

export const IdentityAdminConfigurationDtoSchema = Type.Object(
  {
    versionToken: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    emailPasswordEnabled: Type.Boolean(),
    emailVerificationEnabled: Type.Boolean(),
    emailFromAddress: Type.Optional(Type.String({ format: "email", maxLength: 320 })),
    emailFromName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    smtpHost: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    smtpPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
    smtpSecure: Type.Boolean(),
    smtpUsername: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    smtpPasswordConfigured: Type.Boolean(),
    registrationEnabled: Type.Boolean(),
    phoneEnabled: Type.Boolean(),
    smsWebhookUrl: Type.Optional(ProviderUrlSchema),
    smsWebhookSecretConfigured: Type.Boolean(),
    providers: Type.Array(
      Type.Object(
        {
          key: IdentityProviderKeyAdminSchema,
          enabled: Type.Boolean(),
          clientId: Type.String({ maxLength: 512 }),
          secretConfigured: Type.Boolean(),
        },
        strict,
      ),
      { minItems: 4, maxItems: 4 },
    ),
    updatedAt: Type.Optional(IsoTimestampSchema),
    updatedBy: Type.Optional(IdSchema),
  },
  strict,
);
export type IdentityAdminConfigurationDto = Static<typeof IdentityAdminConfigurationDtoSchema>;

export const UpdateIdentityAdminConfigurationRequestSchema = Type.Object(
  {
    expectedVersionToken: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    emailPasswordEnabled: Type.Boolean(),
    emailVerificationEnabled: Type.Boolean(),
    emailFromAddress: Type.Optional(Type.String({ format: "email", maxLength: 320 })),
    emailFromName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    smtpHost: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    smtpPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
    smtpSecure: Type.Boolean(),
    smtpUsername: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    smtpPassword: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    registrationEnabled: Type.Boolean(),
    phoneEnabled: Type.Boolean(),
    smsWebhookUrl: Type.Optional(ProviderUrlSchema),
    smsWebhookSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    providers: Type.Array(
      Type.Object(
        {
          key: IdentityProviderKeyAdminSchema,
          enabled: Type.Boolean(),
          clientId: Type.String({ maxLength: 512 }),
          clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        },
        strict,
      ),
      { minItems: 4, maxItems: 4 },
    ),
    reason: Type.Optional(ChangeReasonSchema),
  },
  strict,
);
export type UpdateIdentityAdminConfigurationRequest = Static<
  typeof UpdateIdentityAdminConfigurationRequestSchema
>;
export const IdentityAdminConfigurationSuccessEnvelopeSchema = successEnvelopeSchema(
  IdentityAdminConfigurationDtoSchema,
);
