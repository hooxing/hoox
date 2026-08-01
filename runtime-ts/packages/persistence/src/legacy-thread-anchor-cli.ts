import { createPostgresPool, PgLegacyThreadContextAnchor, probePostgres } from "./index.js";

const values = parseArguments(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL;
const schema = process.env.DATABASE_SCHEMA;
const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;

if (connectionString === undefined || schema === undefined || runtimeRole === undefined) {
  console.error(
    "旧 Thread anchor 失败：缺少 DATABASE_URL、DATABASE_SCHEMA 或 DATABASE_RUNTIME_ROLE",
  );
  process.exitCode = 2;
} else if (values === undefined) {
  console.error(
    "用法：--tenant <tenant-id> --thread <thread-id> --max-runs <1..10000> [--operation <id>]",
  );
  process.exitCode = 2;
} else {
  const pool = createPostgresPool({
    connectionString,
    schema,
    applicationName: "cube-runtime-legacy-thread-anchor",
    expectedRuntimeRole: runtimeRole,
  });
  try {
    await probePostgres(pool, runtimeRole);
    const result = await new PgLegacyThreadContextAnchor(pool).anchor(values);
    console.log(JSON.stringify(result));
    if (
      result.outcome === "busy" ||
      result.outcome === "not_found" ||
      result.outcome === "not_legacy"
    ) {
      process.exitCode = 1;
    }
  } catch {
    // 不序列化数据库/驱动错误，避免连接信息进入运维日志。
    console.error("旧 Thread anchor 失败：持久化操作未完成");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function parseArguments(values: readonly string[]):
  | {
      readonly tenantId: string;
      readonly threadId: string;
      readonly maxRuns: number;
      readonly operationId?: string;
    }
  | undefined {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--") || options.has(name)) {
      return undefined;
    }
    options.set(name, value);
  }
  if (
    [...options.keys()].some(
      (key) => !["--tenant", "--thread", "--max-runs", "--operation"].includes(key),
    )
  ) {
    return undefined;
  }
  const tenantId = options.get("--tenant");
  const threadId = options.get("--thread");
  const maxRuns = Number(options.get("--max-runs"));
  if (
    tenantId === undefined ||
    threadId === undefined ||
    !tenantId.trim() ||
    !threadId.trim() ||
    !Number.isSafeInteger(maxRuns) ||
    maxRuns < 1 ||
    maxRuns > 10_000
  ) {
    return undefined;
  }
  const operationId = options.get("--operation");
  return {
    tenantId,
    threadId,
    maxRuns,
    ...(operationId === undefined ? {} : { operationId }),
  };
}
