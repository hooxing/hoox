export const skillErrorCodes = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "LIMIT_EXCEEDED",
  "DEPENDENCY_UNAVAILABLE",
] as const;

export type SkillErrorCode = (typeof skillErrorCodes)[number];

/** 对外错误只暴露稳定类别，不携带用户 ID、目录内部 ID 或 Blob 定位信息。 */
export class SkillServiceError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillServiceError";
  }
}

export function skillInvariant(
  condition: unknown,
  code: SkillErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new SkillServiceError(code, message);
}
