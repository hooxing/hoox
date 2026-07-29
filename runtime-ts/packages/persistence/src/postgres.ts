import { Pool, type PoolClient, type PoolConfig } from "pg";
import { mapPersistenceError, PersistenceUnavailableCause } from "./errors.js";

export interface PostgresPoolOptions {
  readonly connectionString: string;
  /** 运行进程只能以此最小权限登录角色连接；禁止依赖可被继承或 SET ROLE 的上游身份。 */
  readonly expectedRuntimeRole?: string;
  readonly applicationName?: string;
  readonly schema?: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly onBackgroundError?: (error: ReturnType<typeof mapPersistenceError>) => void;
}

const schemaPattern = /^[a-z][a-z0-9_]{0,62}$/;
const isolationLevels = new Set(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return resolved;
}

export function assertSafeSchemaName(schema: string): void {
  if (!schemaPattern.test(schema)) {
    throw new TypeError("PostgreSQL schema 名称只能包含小写字母、数字和下划线");
  }
}

export function createPostgresPool(options: PostgresPoolOptions): Pool {
  if (options.connectionString.trim().length === 0) {
    throw new TypeError("DATABASE_URL 不能为空");
  }
  if (options.schema !== undefined) assertSafeSchemaName(options.schema);
  const config: PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "cube-agent-runtime",
    max: boundedInteger(options.maxConnections, 10, 1, 100, "maxConnections"),
    idleTimeoutMillis: boundedInteger(
      options.idleTimeoutMs,
      30_000,
      1_000,
      600_000,
      "idleTimeoutMs",
    ),
    connectionTimeoutMillis: boundedInteger(
      options.connectionTimeoutMs,
      5_000,
      100,
      60_000,
      "connectionTimeoutMs",
    ),
    statement_timeout: boundedInteger(
      options.statementTimeoutMs,
      30_000,
      100,
      600_000,
      "statementTimeoutMs",
    ),
    // 不把 public 放入业务连接的解析路径，避免同名对象劫持；pg_catalog 仍由 PostgreSQL 隐式提供。
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
  };
  const pool = new Pool(config);
  // pg 的空闲连接错误若没有监听器会变成进程级未捕获错误；回调仍只收到脱敏后的稳定错误。
  pool.on("error", (error) => {
    options.onBackgroundError?.(mapPersistenceError(error, "PostgreSQL 后台连接"));
  });
  return pool;
}

export async function probePostgres(pool: Pool, expectedRuntimeRole?: string): Promise<void> {
  try {
    if (expectedRuntimeRole === undefined) {
      await pool.query("SELECT 1");
      return;
    }
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(expectedRuntimeRole)) {
      throw new TypeError("DATABASE_RUNTIME_ROLE 格式无效");
    }
    const result = await pool.query<{ readonly current_user: string }>("SELECT current_user");
    if (result.rows[0]?.current_user !== expectedRuntimeRole) {
      // 不泄漏真实连接角色，避免将部署拓扑或管理员误配带到日志/健康端点。
      throw new Error("POSTGRES_RUNTIME_ROLE_MISMATCH");
    }
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.message === "POSTGRES_RUNTIME_ROLE_MISMATCH")) {
      throw error;
    }
    throw mapPersistenceError(error, "PostgreSQL 启动探针");
  }
}

export interface TransactionOptions {
  readonly isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  readonly readOnly?: boolean;
}

/**
 * COMMIT 已发出但客户端没有取得可判定响应。此时禁止把它降格为普通 unavailable，
 * 调用方必须按业务幂等键读回事实；该错误不暴露驱动原始消息。
 */
export class TransactionCommitUnknownError extends PersistenceUnavailableCause {
  constructor(options?: { readonly cause?: unknown }) {
    super("PostgreSQL COMMIT 结果未知", options);
    this.name = "TransactionCommitUnknownError";
  }
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** 这些 SQLSTATE 明确表示数据库拒绝提交；连接/协议/超时错误一律保守视为结果未知。 */
function commitWasDefinitelyRejected(error: unknown): boolean {
  const code = postgresCode(error);
  return (
    code !== undefined &&
    (/^23/u.test(code) || /^25/u.test(code) || code === "40001" || code === "40P01")
  );
}

function asReleaseError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolation = options.isolationLevel ?? "READ COMMITTED";
  if (!isolationLevels.has(isolation)) throw new TypeError("事务隔离级别不在运行时白名单中");
  const client = await pool.connect().catch((error: unknown) => {
    throw mapPersistenceError(error, "取得数据库连接");
  });
  let releaseError: Error | undefined;
  try {
    await client.query(
      `BEGIN ISOLATION LEVEL ${isolation}${options.readOnly === true ? " READ ONLY" : ""}`,
    );
    let result: T;
    try {
      result = await operation(client);
    } catch (operationError) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // 原始失败比回滚失败更有诊断价值，但坏连接必须显式从连接池淘汰。
        releaseError = asReleaseError(rollbackError, "数据库回滚失败");
      }
      throw operationError;
    }
    try {
      await client.query("COMMIT");
      return result;
    } catch (commitError) {
      if (commitWasDefinitelyRejected(commitError)) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          releaseError = asReleaseError(rollbackError, "提交失败后的回滚失败");
        }
        throw commitError;
      }
      // 不能在未知连接上再发 ROLLBACK；COMMIT 可能已经成功，坏连接直接淘汰。
      releaseError = asReleaseError(commitError, "数据库 COMMIT 响应未知");
      throw new TransactionCommitUnknownError({ cause: commitError });
    }
  } finally {
    client.release(releaseError);
  }
}

export interface DatabaseTenantContext {
  readonly tenantId: string;
  readonly userId?: string;
}

export async function withTenantTransaction<T>(
  pool: Pool,
  context: DatabaseTenantContext,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return withTransaction(
    pool,
    async (client) => {
      // true 表示事务级配置，连接归还池中后不会遗留上一个租户的上下文。
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [context.tenantId, context.userId ?? ""],
      );
      return operation(client);
    },
    options,
  );
}

export type { Pool, PoolClient } from "pg";
