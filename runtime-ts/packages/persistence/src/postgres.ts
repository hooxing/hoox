import { Pool, type PoolClient, type PoolConfig } from "pg";
import { mapPersistenceError } from "./errors.js";

export interface PostgresPoolOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly schema?: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly onBackgroundError?: (error: ReturnType<typeof mapPersistenceError>) => void;
}

const schemaPattern = /^[a-z][a-z0-9_]{0,62}$/;

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
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema},public` }),
  };
  const pool = new Pool(config);
  // pg 的空闲连接错误若没有监听器会变成进程级未捕获错误；回调仍只收到脱敏后的稳定错误。
  pool.on("error", (error) => {
    options.onBackgroundError?.(mapPersistenceError(error, "PostgreSQL 后台连接"));
  });
  return pool;
}

export async function probePostgres(pool: Pool): Promise<void> {
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    throw mapPersistenceError(error, "PostgreSQL 启动探针");
  }
}

export interface TransactionOptions {
  readonly isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  readonly readOnly?: boolean;
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect().catch((error: unknown) => {
    throw mapPersistenceError(error, "取得数据库连接");
  });
  const isolation = options.isolationLevel ?? "READ COMMITTED";
  let releaseError: Error | undefined;
  try {
    await client.query(
      `BEGIN ISOLATION LEVEL ${isolation}${options.readOnly === true ? " READ ONLY" : ""}`,
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // 原始失败比回滚失败更有诊断价值，但坏连接必须显式从连接池淘汰。
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("数据库回滚失败");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export type { Pool, PoolClient } from "pg";
