import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { IdSchema, IsoTimestampSchema, ProtocolVersionSchema } from "./schemas.js";

export const publicErrorCodes = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_STATE",
  "RATE_LIMITED",
  "DEPENDENCY_UNAVAILABLE",
  "INTERNAL",
] as const;

export const PublicErrorCodeSchema = Type.Union(publicErrorCodes.map((code) => Type.Literal(code)));
export type PublicErrorCode = Static<typeof PublicErrorCodeSchema>;

export const ErrorEnvelopeSchema = Type.Object(
  {
    version: ProtocolVersionSchema,
    requestId: IdSchema,
    error: Type.Object(
      {
        code: PublicErrorCodeSchema,
        message: Type.String({ minLength: 1, maxLength: 500 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "v1.ErrorEnvelope" },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export function successEnvelopeSchema<T extends TSchema>(data: T) {
  return Type.Object(
    { version: ProtocolVersionSchema, requestId: IdSchema, data },
    { additionalProperties: false },
  );
}

export function eventEnvelopeSchema<TType extends string, TPayload extends TSchema>(
  eventType: TType,
  payload: TPayload,
) {
  return Type.Object(
    {
      version: ProtocolVersionSchema,
      eventId: IdSchema,
      sequence: Type.Integer({ minimum: 0 }),
      occurredAt: IsoTimestampSchema,
      type: Type.Literal(eventType),
      payload,
    },
    { additionalProperties: false },
  );
}

// “不存在”和“无权访问”必须在上层统一映射成 NOT_FOUND，防止探测其他 Tenant 的实体。
export function createNotFoundEnvelope(requestId: string): ErrorEnvelope {
  return {
    version: "v1",
    requestId,
    error: { code: "NOT_FOUND", message: "请求的资源不存在", retryable: false },
  };
}
