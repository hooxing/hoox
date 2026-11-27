import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { IdSchema, IsoTimestampSchema, ProtocolVersionSchema } from "./schemas.js";

export const publicErrorCodes = [
  "INVALID_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "AGENT_REVISION_UNAVAILABLE",
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
    validationErrors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({ maxLength: 512 }),
            code: Type.String({ minLength: 1, maxLength: 64 }),
            message: Type.String({ minLength: 1, maxLength: 500 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
  },
  { additionalProperties: false, $id: "v1.ErrorEnvelope" },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export type PublicFailure =
  | { readonly kind: "bad_request" }
  | { readonly kind: "payload_too_large" }
  | { readonly kind: "unsupported_media_type" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "agent_revision_unavailable" }
  | { readonly kind: "invalid_state" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "dependency_unavailable" }
  | { readonly kind: "internal" };

const fixedErrors: Readonly<Record<PublicFailure["kind"], ErrorEnvelope["error"]>> = Object.freeze({
  payload_too_large: Object.freeze({
    code: "PAYLOAD_TOO_LARGE",
    message: "请求正文超过大小限制",
    retryable: false,
  }),
  bad_request: Object.freeze({
    code: "INVALID_REQUEST",
    message: "请求参数无效",
    retryable: false,
  }),
  unsupported_media_type: Object.freeze({
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "不支持的媒体类型",
    retryable: false,
  }),
  unauthorized: Object.freeze({ code: "UNAUTHORIZED", message: "身份认证失败", retryable: false }),
  forbidden: Object.freeze({ code: "FORBIDDEN", message: "凭据无权执行此操作", retryable: false }),
  not_found: Object.freeze({ code: "NOT_FOUND", message: "请求的资源不存在", retryable: false }),
  conflict: Object.freeze({ code: "CONFLICT", message: "资源状态已经变化", retryable: true }),
  agent_revision_unavailable: Object.freeze({
    code: "AGENT_REVISION_UNAVAILABLE",
    message: "所选 Agent 当前不可用，请联系管理员或选择其他 Agent",
    retryable: false,
  }),
  invalid_state: Object.freeze({
    code: "INVALID_STATE",
    message: "当前状态不允许该操作",
    retryable: false,
  }),
  rate_limited: Object.freeze({ code: "RATE_LIMITED", message: "请求过于频繁", retryable: true }),
  dependency_unavailable: Object.freeze({
    code: "DEPENDENCY_UNAVAILABLE",
    message: "依赖服务暂时不可用",
    retryable: true,
  }),
  internal: Object.freeze({ code: "INTERNAL", message: "服务内部错误", retryable: false }),
});

export class ProtocolConstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolConstructionError";
  }
}

export function createErrorEnvelope(requestId: unknown, failure: PublicFailure): ErrorEnvelope {
  if (!Value.Check(IdSchema, requestId)) {
    throw new ProtocolConstructionError("requestId 格式无效");
  }
  const envelope: ErrorEnvelope = {
    version: "v1",
    requestId,
    error: fixedErrors[failure.kind],
  };
  if (!Value.Check(ErrorEnvelopeSchema, envelope)) {
    throw new ProtocolConstructionError("错误信封未通过协议校验");
  }
  return envelope;
}

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

export function createNotFoundEnvelope(requestId: unknown): ErrorEnvelope {
  return createErrorEnvelope(requestId, { kind: "not_found" });
}
