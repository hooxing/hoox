import { type Static, Type } from "@sinclair/typebox";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const expectedGeneration = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const timestamp = IsoTimestampSchema;
const sideEffect = Type.Union([
  Type.Literal("read_only"),
  Type.Literal("write"),
  Type.Literal("destructive"),
]);
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** MCP Server 注册设置；凭据不在此结构内，只能经独立只写字段提交。 */
export const AdminMcpDraftSettingsSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    serverName: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
    endpoint: Type.String({ minLength: 9, maxLength: 2048, pattern: "^https://[^?#]+$" }),
    timeoutMs: Type.Integer({ minimum: 100, maximum: 120000 }),
    maxResponseBytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    sideEffect,
    idempotent: Type.Boolean(),
  },
  strict,
);
export type AdminMcpDraftSettings = Static<typeof AdminMcpDraftSettingsSchema>;

const credential = Type.String({ minLength: 1, maxLength: 8192 });

export const AdminCreateMcpDraftSchema = Type.Object(
  {
    draftId: IdSchema,
    settings: AdminMcpDraftSettingsSchema,
    credential: Type.Optional(credential),
    expectedGeneration,
  },
  strict,
);
export type AdminCreateMcpDraft = Static<typeof AdminCreateMcpDraftSchema>;
export const AdminUpdateMcpDraftSchema = Type.Object(
  { settings: AdminMcpDraftSettingsSchema, expectedGeneration },
  strict,
);
export type AdminUpdateMcpDraft = Static<typeof AdminUpdateMcpDraftSchema>;
/** `credential: null` 清除草稿凭据；任何响应都只返回 credentialConfigured。 */
export const AdminSetMcpDraftCredentialSchema = Type.Object(
  { credential: Type.Union([credential, Type.Null()]), expectedGeneration },
  strict,
);
export type AdminSetMcpDraftCredential = Static<typeof AdminSetMcpDraftCredentialSchema>;
export const AdminExternalToolGenerationSchema = Type.Object({ expectedGeneration }, strict);
export type AdminExternalToolGeneration = Static<typeof AdminExternalToolGenerationSchema>;
export const AdminRevokeExternalToolBatchSchema = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500 }) },
  strict,
);
export type AdminRevokeExternalToolBatch = Static<typeof AdminRevokeExternalToolBatchSchema>;

export const AdminMcpDraftDtoSchema = Type.Object(
  {
    draftId: IdSchema,
    source: Type.Literal("mcp"),
    ...AdminMcpDraftSettingsSchema.properties,
    credentialConfigured: Type.Boolean(),
    generation: expectedGeneration,
    publishedBatchCount: Type.Integer({ minimum: 0 }),
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  strict,
);
export type AdminMcpDraftDto = Static<typeof AdminMcpDraftDtoSchema>;

export const AdminExternalToolVersionSummarySchema = Type.Object(
  {
    toolVersionId: IdSchema,
    modelToolName: Type.String({ maxLength: 128 }),
    remoteToolName: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    description: Type.String({ maxLength: 2048 }),
    inputSchemaDigest: digest,
    timeoutMs: Type.Integer(),
    maxResponseBytes: Type.Integer(),
    sideEffect,
    idempotent: Type.Boolean(),
    credentialConfigured: Type.Boolean(),
    revoked: Type.Boolean(),
  },
  strict,
);
export type AdminExternalToolVersionSummary = Static<typeof AdminExternalToolVersionSummarySchema>;

export const AdminExternalToolBatchDtoSchema = Type.Object(
  {
    batchId: IdSchema,
    draftId: IdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    displayName: Type.String({ maxLength: 200 }),
    source: Type.Union([Type.Literal("mcp"), Type.Literal("http")]),
    serverName: Type.String({ maxLength: 64 }),
    endpoint: Type.String({ maxLength: 2048 }),
    draftGeneration: expectedGeneration,
    createdAt: timestamp,
    createdBy: Type.String({ maxLength: 128 }),
    revoked: Type.Boolean(),
    revokedAt: Type.Optional(timestamp),
    revocationReason: Type.Optional(Type.String({ maxLength: 1000 })),
    tools: Type.Array(AdminExternalToolVersionSummarySchema),
  },
  strict,
);
export type AdminExternalToolBatchDto = Static<typeof AdminExternalToolBatchDtoSchema>;

export const AdminExternalToolOverviewSchema = Type.Object(
  {
    drafts: Type.Array(AdminMcpDraftDtoSchema),
    batches: Type.Array(AdminExternalToolBatchDtoSchema),
  },
  strict,
);
export type AdminExternalToolOverview = Static<typeof AdminExternalToolOverviewSchema>;

/** 逐工具探测结果；拒绝原因只含受控代码与文案，不回显 Schema 或服务端原始错误。 */
export const AdminMcpProbeToolSchema = Type.Union([
  Type.Object(
    {
      accepted: Type.Literal(true),
      remoteToolName: Type.String({ maxLength: 512 }),
      modelToolName: Type.String({ maxLength: 128 }),
      description: Type.String({ maxLength: 2048 }),
      inputSchemaDigest: digest,
    },
    strict,
  ),
  Type.Object(
    {
      accepted: Type.Literal(false),
      remoteToolName: Type.Optional(Type.String({ maxLength: 512 })),
      reason: Type.String({ maxLength: 128 }),
      reasonMessage: Type.String({ maxLength: 200 }),
    },
    strict,
  ),
]);
export type AdminMcpProbeTool = Static<typeof AdminMcpProbeToolSchema>;

export const AdminMcpProbeReportSchema = Type.Object(
  {
    draftId: IdSchema,
    generation: expectedGeneration,
    publishable: Type.Boolean(),
    failure: Type.Optional(
      Type.Object(
        { code: Type.String({ maxLength: 64 }), message: Type.String({ maxLength: 200 }) },
        strict,
      ),
    ),
    tools: Type.Array(AdminMcpProbeToolSchema),
  },
  strict,
);
export type AdminMcpProbeReport = Static<typeof AdminMcpProbeReportSchema>;

/** HTTP 工具当前只支持预览：持久化契约尚无 HTTP 方法字段前不得发布。 */
export const AdminHttpToolPreviewRequestSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("endpoint"),
      toolName: Type.String({ minLength: 1, maxLength: 64 }),
      description: Type.String({ maxLength: 2048 }),
      endpoint: Type.String({ minLength: 9, maxLength: 2048 }),
      method: Type.Union([Type.Literal("GET"), Type.Literal("POST")]),
      inputSchema: Type.Record(Type.String(), Type.Unknown()),
    },
    strict,
  ),
  Type.Object(
    {
      mode: Type.Literal("openapi"),
      toolName: Type.String({ minLength: 1, maxLength: 64 }),
      description: Type.String({ maxLength: 2048 }),
      document: Type.Record(Type.String(), Type.Unknown()),
    },
    strict,
  ),
]);
export type AdminHttpToolPreviewRequest = Static<typeof AdminHttpToolPreviewRequestSchema>;

export const AdminHttpToolPreviewSchema = Type.Object(
  {
    modelToolName: Type.String({ maxLength: 128 }),
    description: Type.String({ maxLength: 2048 }),
    endpoint: Type.String({ maxLength: 2048 }),
    method: Type.Union([Type.Literal("GET"), Type.Literal("POST")]),
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
    inputSchemaDigest: digest,
    timeoutMs: Type.Integer(),
    maxResponseBytes: Type.Integer(),
    sideEffect,
    idempotent: Type.Boolean(),
    publishable: Type.Literal(false),
  },
  strict,
);
export type AdminHttpToolPreview = Static<typeof AdminHttpToolPreviewSchema>;
