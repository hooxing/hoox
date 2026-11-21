import { Type } from "@sinclair/typebox";

export const ExternalToolVersionDtoSchema = Type.Object(
  {
    toolVersionId: Type.String({ minLength: 1, maxLength: 128 }),
    source: Type.Union([Type.Literal("mcp"), Type.Literal("http")]),
    remoteToolName: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    httpMethod: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")])),
    modelToolName: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
    }),
    description: Type.String({ maxLength: 2048 }),
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
    inputSchemaDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    timeoutMs: Type.Integer({ minimum: 100, maximum: 120000 }),
    maxResponseBytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    sideEffect: Type.Union([
      Type.Literal("read_only"),
      Type.Literal("write"),
      Type.Literal("destructive"),
    ]),
    idempotent: Type.Boolean(),
    credentialRef: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ExternalToolCredentialProjectionSchema = Type.Object(
  { configured: Type.Boolean() },
  { additionalProperties: false },
);
