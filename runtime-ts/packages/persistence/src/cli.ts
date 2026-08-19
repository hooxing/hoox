import { PersistenceError } from "./errors.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { assertDestructiveMigrationAllowed } from "./migration-safety.js";
import { createPostgresPool, probePostgres } from "./postgres.js";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("用法：迁移命令需要指定 up 或 down");
  process.exitCode = 2;
} else {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;
  const migratorRole = process.env.DATABASE_MIGRATOR_ROLE;
  const skillPublisherRole = process.env.DATABASE_SKILL_PUBLISHER_ROLE;
  const workerCoordinatorRole = process.env.DATABASE_WORKER_COORDINATOR_ROLE;
  const teamCoordinatorRole = process.env.DATABASE_TEAM_COORDINATOR_ROLE;
  const adminControlRole = process.env.DATABASE_ADMIN_CONTROL_ROLE;
  const schema = process.env.DATABASE_SCHEMA;
  if (connectionString === undefined || connectionString.length === 0) {
    console.error("迁移失败：缺少 MIGRATION_DATABASE_URL");
    process.exitCode = 2;
  } else if (runtimeRole === undefined || runtimeRole.length === 0) {
    console.error("迁移失败：缺少 DATABASE_RUNTIME_ROLE");
    process.exitCode = 2;
  } else if (migratorRole === undefined || migratorRole.length === 0) {
    console.error("迁移失败：缺少 DATABASE_MIGRATOR_ROLE");
    process.exitCode = 2;
  } else if (skillPublisherRole === undefined || skillPublisherRole.length === 0) {
    console.error("迁移失败：缺少 DATABASE_SKILL_PUBLISHER_ROLE");
    process.exitCode = 2;
  } else if (workerCoordinatorRole === undefined || workerCoordinatorRole.length === 0) {
    console.error("迁移失败：缺少 DATABASE_WORKER_COORDINATOR_ROLE");
    process.exitCode = 2;
  } else if (teamCoordinatorRole === undefined || teamCoordinatorRole.length === 0) {
    console.error("迁移失败：缺少 DATABASE_TEAM_COORDINATOR_ROLE");
    process.exitCode = 2;
  } else if (adminControlRole === undefined || adminControlRole.length === 0) {
    console.error("迁移失败：缺少 DATABASE_ADMIN_CONTROL_ROLE");
    process.exitCode = 2;
  } else if (schema === undefined || schema.length === 0) {
    console.error("迁移失败：缺少 DATABASE_SCHEMA");
    process.exitCode = 2;
  } else {
    const pool = createPostgresPool({
      connectionString,
      applicationName: "hoox-migration",
      schema,
    });
    try {
      await probePostgres(pool);
      const security = {
        runtimeRole,
        migratorRole,
        skillPublisherRole,
        workerCoordinatorRole,
        teamCoordinatorRole,
        adminControlRole,
        schema,
      } as const;
      let records: Awaited<ReturnType<typeof migrateUp>>;
      if (direction === "up") {
        records = await migrateUp(pool, security);
      } else {
        const environment = process.env.RUNTIME_ENV;
        assertDestructiveMigrationAllowed(process.argv, environment);
        records = await migrateDown(pool, {
          allowDestructive: true,
          environment,
          ...security,
        });
      }
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
