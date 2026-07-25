import { FormatRegistry, Type } from "@sinclair/typebox";

export const protocolVersion = "v1" as const;
export const ProtocolVersionSchema = Type.Literal(protocolVersion);

export const IdSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$",
});

const isoUtcTimestampFormat = "cube-iso-utc-timestamp-v1";

export function isIsoUtcTimestamp(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (matched === null) return false;
  const normalized = matched[7] === undefined ? value.replace(/Z$/u, ".000Z") : value;
  const parsed = new Date(normalized);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === normalized;
}

FormatRegistry.Set(isoUtcTimestampFormat, isIsoUtcTimestamp);

export const IsoTimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
  format: isoUtcTimestampFormat,
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
