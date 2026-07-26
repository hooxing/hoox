export const resourceErrorCodes = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "NOT_AUTHORIZED",
  "PREVIEW_BUDGET_EXCEEDED",
  "CONTENT_INTEGRITY_ERROR",
  "DEPENDENCY_FAILURE",
] as const;

export type ResourceErrorCode = (typeof resourceErrorCodes)[number];

/** 对外错误不携带实体 ID、对象键或存储供应商细节。 */
export class ResourceServiceError extends Error {
  readonly code: ResourceErrorCode;

  constructor(code: ResourceErrorCode, message: string) {
    super(message);
    this.name = "ResourceServiceError";
    this.code = code;
  }
}

export function resourceInvariant(
  condition: unknown,
  code: ResourceErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new ResourceServiceError(code, message);
}
