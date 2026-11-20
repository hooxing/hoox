export type PersistenceErrorCode =
  | "AGENT_REVISION_UNAVAILABLE"
  | "CONFLICT"
  | "CONSTRAINT_VIOLATION"
  | "MIGRATION_MISMATCH"
  | "UNAVAILABLE"
  | "UNEXPECTED";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
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
  readonly cause?: unknown;
}

function postgresSqlState(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as PgLikeError;
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code) &&
      !unavailableSystemCodes.has(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as PgLikeError).code;
  return typeof code === "string" ? code : undefined;
}

function withSqlState(error: PersistenceError, original: unknown): PersistenceError {
  const code = postgresSqlState(original);
  if (code !== undefined) {
    // 只传递可验证的 SQLSTATE；原始驱动异常及其消息、SQL 和连接信息不得越过持久层边界。
    Object.defineProperty(error, "cause", { value: Object.freeze({ code }) });
  }
  return error;
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
    return withSqlState(new PersistenceError("UNAVAILABLE", `${operation}暂时不可用`), error);
  }
  const code = pgCode(error);
  if (code === "23505") {
    return withSqlState(new PersistenceError("CONFLICT", `${operation}发生并发冲突`), error);
  }
  if (code?.startsWith("23") === true) {
    return withSqlState(
      new PersistenceError("CONSTRAINT_VIOLATION", `${operation}违反数据约束`),
      error,
    );
  }
  if (
    unavailableSystemCodes.has(code ?? "") ||
    code?.startsWith("08") === true ||
    code === "57P01"
  ) {
    return withSqlState(new PersistenceError("UNAVAILABLE", `${operation}暂时不可用`), error);
  }
  return withSqlState(new PersistenceError("UNEXPECTED", `${operation}失败`), error);
}
