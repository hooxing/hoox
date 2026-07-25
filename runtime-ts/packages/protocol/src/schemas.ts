import { Type } from "@sinclair/typebox";

export const protocolVersion = "v1" as const;
export const ProtocolVersionSchema = Type.Literal(protocolVersion);

export const IdSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$",
});

export const IsoTimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});

export const Sha256DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const TenantKindSchema = Type.Union([Type.Literal("personal"), Type.Literal("team")]);
export const RunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
