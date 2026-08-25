import { Pool } from "pg";
import { bootstrapMissingDatabaseRoles } from "./database-role-bootstrap.js";
import { readDatabaseRoleBootstrapConfiguration } from "./database-role-bootstrap-config.js";
import { loadDatabaseDevelopmentEnvironment } from "./development-database-environment.js";
import { PersistenceError } from "./errors.js";

async function runDatabaseRoleBootstrap(
  environment: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const configuration = readDatabaseRoleBootstrapConfiguration(environment);
  const pool = new Pool({
    connectionString: configuration.bootstrapUrl,
    application_name: "hoox-database-role-bootstrap",
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await bootstrapMissingDatabaseRoles(client, configuration.credentials);
      await client.query("COMMIT");
      return result.createdRoles;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

try {
  const environment = await loadDatabaseDevelopmentEnvironment(
    process.env,
    new URL("../../../../.env", import.meta.url),
  );
  const createdRoles = await runDatabaseRoleBootstrap(environment);
  if (createdRoles.length === 0) {
    console.log("数据库应用角色已完整，无需补齐");
  } else {
    console.log(`数据库应用角色补齐完成：${createdRoles.join(", ")}`);
  }
} catch (error) {
  const message =
    error instanceof PersistenceError || error instanceof TypeError
      ? error.message
      : "未知数据库角色 bootstrap 错误";
  // 只输出稳定诊断和角色名，不序列化连接串、密码或驱动 cause。
  console.error(`数据库角色 bootstrap 失败：${message}`);
  process.exitCode = 1;
}
