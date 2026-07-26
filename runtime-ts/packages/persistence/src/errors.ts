export type PersistenceErrorCode =
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
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as PgLikeError).code;
  return typeof code === "string" ? code : undefined;
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
    return new PersistenceError("UNAVAILABLE", `${operation}暂时不可用`);
  }
  const code = pgCode(error);
  if (code === "23505") {
    return new PersistenceError("CONFLICT", `${operation}发生并发冲突`);
  }
  if (code?.startsWith("23") === true) {
    return new PersistenceError("CONSTRAINT_VIOLATION", `${operation}违反数据约束`);
  }
  if (
    unavailableSystemCodes.has(code ?? "") ||
    code?.startsWith("08") === true ||
    code === "57P01"
  ) {
    return new PersistenceError("UNAVAILABLE", `${operation}暂时不可用`);
  }
  return new PersistenceError("UNEXPECTED", `${operation}失败`);
}
