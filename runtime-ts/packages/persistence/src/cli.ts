import { PersistenceError } from "./errors.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { createPostgresPool, probePostgres } from "./postgres.js";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("用法：迁移命令需要指定 up 或 down");
  process.exitCode = 2;
} else {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    console.error("迁移失败：缺少 DATABASE_URL");
    process.exitCode = 2;
  } else {
    const pool = createPostgresPool({
      connectionString,
      applicationName: "cube-runtime-migration",
    });
    try {
      await probePostgres(pool);
      const records = direction === "up" ? await migrateUp(pool) : await migrateDown(pool);
      const current = records.at(-1)?.version ?? 0;
      console.log(`数据库迁移完成，当前版本：${current}`);
    } catch (error) {
      const message = error instanceof PersistenceError ? error.message : "未知迁移错误";
      // 只报告稳定错误，不序列化 cause，避免驱动配置或连接串进入日志。
      console.error(`数据库迁移失败：${message}`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
