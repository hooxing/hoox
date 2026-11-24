import { Pool } from "pg";
import { PersistenceError } from "./errors.js";
import { bootstrapEvaluationRole } from "./evaluation-role.js";

const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL;
const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;

try {
  if (!bootstrapUrl) throw new TypeError("缺少 DATABASE_BOOTSTRAP_URL");
  if (!runtimeRole) throw new TypeError("缺少 DATABASE_RUNTIME_ROLE");
  const pool = new Pool({
    connectionString: bootstrapUrl,
    application_name: "hoox-evaluation-role-bootstrap",
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await bootstrapEvaluationRole(client, runtimeRole);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  console.log("评测角色及 Runtime 精确成员关系已预置");
} catch (error) {
  const message =
    error instanceof PersistenceError || error instanceof TypeError
      ? error.message
      : "未知评测角色 bootstrap 错误";
  console.error(`评测角色 bootstrap 失败：${message}`);
  process.exitCode = 1;
}
