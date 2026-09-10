import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";

const strict = { additionalProperties: false } as const;
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Provider = Type.Union([
  Type.Literal("cube"),
  Type.Literal("e2b"),
  Type.Literal("tencent-ags"),
]);
export const SandboxPolicyDtoSchema = Type.Object(
  {
    templateId: Type.String({ minLength: 1, maxLength: 255 }),
    sessionTtlSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
    operationTimeoutMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
    lifecycleTimeoutMs: Type.Integer({ minimum: 1000, maximum: 90000 }),
    pausedRetentionSeconds: Type.Integer({ minimum: 0, maximum: 2592000 }),
    idleAction: Type.Union([Type.Literal("pause"), Type.Literal("kill")]),
  },
  strict,
);
export const SandboxProfileDtoSchema = Type.Object(
  {
    providerKey: Provider,
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    cubeProxy: Type.Optional(
      Type.Object(
        {
          host: Type.String({ minLength: 1, maxLength: 253 }),
          port: Type.Integer({ minimum: 1, maximum: 65535 }),
          scheme: Type.Union([Type.Literal("http"), Type.Literal("https")]),
        },
        strict,
      ),
    ),
    credentialConfigured: Type.Boolean(),
    policy: SandboxPolicyDtoSchema,
  },
  strict,
);
export const SandboxProfileRevisionDtoSchema = Type.Object(
  {
    revision: Revision,
    configuration: SandboxProfileDtoSchema,
    createdAt: Type.String(),
    probeStatus: Type.Union([
      Type.Literal("untested"),
      Type.Literal("healthy"),
      Type.Literal("failed"),
    ]),
  },
  strict,
);
export const SandboxRoutingDtoSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("single"), Type.Literal("weighted")]),
    targets: Type.Array(
      Type.Object(
        {
          providerKey: Provider,
          profileRevision: Revision,
          weight: Type.Integer({ minimum: 1, maximum: 1000 }),
        },
        strict,
      ),
      { minItems: 1, maxItems: 3 },
    ),
  },
  strict,
);
export const SandboxControlDtoSchema = Type.Object(
  {
    generation: Type.Integer({ minimum: 0 }),
    routing: Type.Optional(SandboxRoutingDtoSchema),
    profiles: Type.Array(SandboxProfileRevisionDtoSchema),
  },
  strict,
);
export const SaveSandboxProfileRequestSchema = Type.Object(
  {
    expectedGeneration: Type.Integer({ minimum: 0 }),
    configuration: Type.Omit(SandboxProfileDtoSchema, ["credentialConfigured"]),
    apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
    reuseCredentialFromRevision: Type.Optional(Revision),
  },
  strict,
);
export const PublishSandboxRoutingRequestSchema = Type.Object(
  { expectedGeneration: Type.Integer({ minimum: 0 }), configuration: SandboxRoutingDtoSchema },
  strict,
);
export const SandboxProfilePathSchema = Type.Object(
  { providerKey: Provider, revision: Revision },
  strict,
);
export const SandboxProbeResultDtoSchema = Type.Object(
  { healthy: Type.Boolean(), durationMs: Type.Integer({ minimum: 0, maximum: 3600000 }) },
  strict,
);
export const SandboxControlSuccessSchema = successEnvelopeSchema(SandboxControlDtoSchema);
export const SandboxProfileSuccessSchema = successEnvelopeSchema(SandboxProfileRevisionDtoSchema);
export const SandboxProbeSuccessSchema = successEnvelopeSchema(SandboxProbeResultDtoSchema);
export type SandboxControlDto = Static<typeof SandboxControlDtoSchema>;
export type SandboxProfileRevisionDto = Static<typeof SandboxProfileRevisionDtoSchema>;
export type SaveSandboxProfileRequest = Static<typeof SaveSandboxProfileRequestSchema>;
export type PublishSandboxRoutingRequest = Static<typeof PublishSandboxRoutingRequestSchema>;
export type SandboxProfilePath = Static<typeof SandboxProfilePathSchema>;
