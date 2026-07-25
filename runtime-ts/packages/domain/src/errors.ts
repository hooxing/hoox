export const domainErrorCodes = [
  "INVALID_ARGUMENT",
  "NOT_AUTHORIZED",
  "OWNERSHIP_MISMATCH",
  "INVALID_STATE_TRANSITION",
  "VERSION_CONFLICT",
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function domainInvariant(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}

// 所有权错误故意不包含实体 ID，避免上层把跨 Tenant 的存在性带入公开错误。
export function assertSameTenant(left: string, right: string): void {
  domainInvariant(left === right, "OWNERSHIP_MISMATCH", "资源不属于当前租户");
}
