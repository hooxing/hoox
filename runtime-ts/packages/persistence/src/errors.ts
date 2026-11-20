export type PersistenceErrorCode =
  | "CONFLICT"
  | "CONSTRAINT_VIOLATION"
  | "MIGRATION_MISMATCH"
  | "UNAVAILABLE"
  | "UNEXPECTED";

export interface PostgreSqlDiagnosticCause {
  readonly kind: "postgresql";
  readonly code: string;
  readonly message: string;
}

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersistenceError";
    this.code = code;
  }
}

/**
 * 需要被共享错误边界稳定收敛为 UNAVAILABLE 的内部异常基类。
 *
 * 该类型放在 errors 模块中，避免事务实现与错误映射相互导入；具体基础设施异常通过继承
 * 表达映射语义，上层仍只会看到脱敏后的 PersistenceError。
 */
export abstract class PersistenceUnavailableCause extends Error {}

interface PgLikeError {
  readonly code?: unknown;
  readonly message?: unknown;
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as PgLikeError).code;
  return typeof code === "string" ? code : undefined;
}

function postgresDiagnostic(error: unknown): PostgreSqlDiagnosticCause | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as PgLikeError;
  if (
    typeof candidate.code !== "string" ||
    !/^[0-9A-Z]{5}$/u.test(candidate.code) ||
    typeof candidate.message !== "string"
  ) {
    return undefined;
  }
  // 只保留 SQLSTATE 与 message；detail、query、连接参数可能包含业务数据或凭据。
  const message = candidate.message
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/giu, "[数据库连接地址已隐藏]")
    .replace(/password\s*=\s*[^\s,;]+/giu, "password=[已隐藏]");
  return Object.freeze({ kind: "postgresql", code: candidate.code, message });
}

export function getPostgreSqlDiagnosticCause(
  error: unknown,
): PostgreSqlDiagnosticCause | undefined {
  if (!(error instanceof PersistenceError)) return undefined;
  const cause = error.cause;
  if (
    typeof cause !== "object" ||
    cause === null ||
    (cause as PostgreSqlDiagnosticCause).kind !== "postgresql" ||
    typeof (cause as PostgreSqlDiagnosticCause).code !== "string" ||
    typeof (cause as PostgreSqlDiagnosticCause).message !== "string"
  ) {
    return undefined;
  }
  return cause as PostgreSqlDiagnosticCause;
}

const unavailableSystemCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
]);

/** 将驱动细节收敛为稳定错误码，避免把 SQL、连接串或约束名暴露到上层。 */
export function mapPersistenceError(error: unknown, operation: string): PersistenceError {
  if (error instanceof PersistenceError) return error;
  if (error instanceof PersistenceUnavailableCause) {
    const diagnostic = postgresDiagnostic(error.cause);
    return new PersistenceError("UNAVAILABLE", `${operation}暂时不可用`, diagnostic);
  }
  const code = pgCode(error);
  const diagnostic = postgresDiagnostic(error);
  if (code === "23505") {
    return new PersistenceError("CONFLICT", `${operation}发生并发冲突`, diagnostic);
  }
  if (code?.startsWith("23") === true) {
    return new PersistenceError("CONSTRAINT_VIOLATION", `${operation}违反数据约束`, diagnostic);
  }
  if (
    unavailableSystemCodes.has(code ?? "") ||
    code?.startsWith("08") === true ||
    code === "57P01"
  ) {
    return new PersistenceError("UNAVAILABLE", `${operation}暂时不可用`, diagnostic);
  }
  return new PersistenceError("UNEXPECTED", `${operation}失败`, diagnostic);
}
