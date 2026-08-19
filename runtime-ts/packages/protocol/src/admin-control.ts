import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const ProviderKeySchema = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", maxLength: 64 });
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

export const ModelProviderConfigurationDtoSchema = Type.Object(
  {
    providerKey: ProviderKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    protocol: Type.Literal("openai-compatible"),
    baseUrl: ProviderUrlSchema,
    secretRef: Type.Literal("deployment:model"),
    modelId: Type.String({ minLength: 1, maxLength: 255 }),
    supportsImages: Type.Boolean(),
    contextWindow: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    maxOutputTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  },
  strict,
);
export type ModelProviderConfigurationDto = Static<typeof ModelProviderConfigurationDtoSchema>;

export const MemoryProviderConfigurationDtoSchema = Type.Object(
  {
    providerKey: ProviderKeySchema,
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    providerKind: Type.Literal("mem0"),
    baseUrl: ProviderUrlSchema,
    apiSecretRef: Type.Literal("deployment:memory-api"),
    scopeSecretRef: Type.Literal("deployment:memory-scope"),
    requestTimeoutMs: Type.Integer({ minimum: 100, maximum: 120_000 }),
    enabled: Type.Boolean(),
  },
  strict,
);
export type MemoryProviderConfigurationDto = Static<typeof MemoryProviderConfigurationDtoSchema>;

export const RuntimeSettingsConfigurationDtoSchema = Type.Object(
  {
    compactionSoftLimitPercent: Type.Integer({ minimum: 50, maximum: 95 }),
    compactionTargetPercent: Type.Integer({ minimum: 20, maximum: 90 }),
    compactionRecentUserTokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    compactionMaxOutputTokens: Type.Integer({ minimum: 128, maximum: 1_000_000 }),
    compactionTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 600_000 }),
  },
  strict,
);
export type RuntimeSettingsConfigurationDto = Static<typeof RuntimeSettingsConfigurationDtoSchema>;

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
  },
  strict,
);
export type RuntimeStatisticsDto = Static<typeof RuntimeStatisticsDtoSchema>;

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
  [ModelProviderConfigurationDtoSchema, Type.Object({ reason: ChangeReasonSchema }, strict)],
  strict,
);
export type CreateModelProviderDraftRequest = Static<typeof CreateModelProviderDraftRequestSchema>;

export const CreateMemoryProviderDraftRequestSchema = Type.Composite(
  [MemoryProviderConfigurationDtoSchema, Type.Object({ reason: ChangeReasonSchema }, strict)],
  strict,
);
export type CreateMemoryProviderDraftRequest = Static<
  typeof CreateMemoryProviderDraftRequestSchema
>;

export const CreateRuntimeSettingsDraftRequestSchema = Type.Composite(
  [RuntimeSettingsConfigurationDtoSchema, Type.Object({ reason: ChangeReasonSchema }, strict)],
  strict,
);
export type CreateRuntimeSettingsDraftRequest = Static<
  typeof CreateRuntimeSettingsDraftRequestSchema
>;

export const ProbeControlRevisionRequestSchema = Type.Object(
  { expectedVersionToken: VersionTokenSchema, reason: ChangeReasonSchema },
  strict,
);
export type ProbeControlRevisionRequest = Static<typeof ProbeControlRevisionRequestSchema>;

export const PublishControlRevisionRequestSchema = ProbeControlRevisionRequestSchema;
export type PublishControlRevisionRequest = Static<typeof PublishControlRevisionRequestSchema>;

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
