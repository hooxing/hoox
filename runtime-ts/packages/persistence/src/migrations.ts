import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool, PoolClient } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { withTransaction } from "./postgres.js";
import {
  assertMigrationContextSafe,
  bootstrapRuntimeAccessOnClient,
  type MigrationSecurityContext,
  teardownRuntimeSchemaAccessOnClient,
} from "./role-bootstrap.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly checksum: string;
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationSourceOptions {
  readonly directory?: string;
}

export interface MigrationUpOptions extends MigrationSourceOptions, MigrationSecurityContext {}

export interface MigrationDownOptions extends MigrationSourceOptions, MigrationSecurityContext {
  readonly targetVersion?: number;
  readonly allowDestructive: true;
  readonly environment: "development" | "test";
  readonly runtimeRole: string;
}

const defaultMigrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationPattern = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

function migrationUrl(directory: string, fileName: string): URL {
  const base = pathToFileURL(
    directory.endsWith("/") || directory.endsWith("\\") ? directory : `${directory}/`,
  );
  return new URL(fileName, base);
}

/** 严格装载成对迁移；测试可传隔离目录验证篡改与畸形文件。 */
export async function loadMigrations(
  options: MigrationSourceOptions = {},
): Promise<readonly Migration[]> {
  const directory = options.directory ?? defaultMigrationDirectory;
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const pairs = new Map<number, { name: string; up?: string; down?: string }>();
  for (const fileName of files) {
    const match = migrationPattern.exec(fileName);
    if (match === null) {
      throw new PersistenceError("MIGRATION_MISMATCH", `无法识别迁移文件 ${fileName}`);
    }
    const [, versionText, name, direction] = match;
    if (versionText === undefined || name === undefined || direction === undefined) {
      throw new PersistenceError("MIGRATION_MISMATCH", "迁移文件名无效");
    }
    const version = Number.parseInt(versionText, 10);
    const pair = pairs.get(version);
    if (pair !== undefined && pair.name !== name) {
      throw new PersistenceError("MIGRATION_MISMATCH", `迁移版本 ${version} 重复`);
    }
    const current = pair ?? { name };
    if (current[direction as "up" | "down"] !== undefined) {
      throw new PersistenceError("MIGRATION_MISMATCH", `迁移版本 ${version} 方向重复`);
    }
    current[direction as "up" | "down"] = fileName;
    pairs.set(version, current);
  }

  return Promise.all(
    [...pairs.entries()]
      .sort(([left], [right]) => left - right)
      .map(async ([version, pair]) => {
        if (pair.up === undefined || pair.down === undefined) {
          throw new PersistenceError("MIGRATION_MISMATCH", `迁移版本 ${version} 未成对`);
        }
        const [upSql, downSql] = await Promise.all([
          readFile(migrationUrl(directory, pair.up), "utf8"),
          readFile(migrationUrl(directory, pair.down), "utf8"),
        ]);
        const checksum = createHash("sha256")
          .update(`${version}\0${pair.name}\0${upSql}\0${downSql}`)
          .digest("hex");
        return { version, name: pair.name, upSql, downSql, checksum };
      }),
  );
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

async function appliedMigrations(client: PoolClient): Promise<readonly MigrationRecord[]> {
  const result = await client.query<MigrationRecord>(
    "SELECT version, name, checksum FROM runtime_schema_migrations ORDER BY version",
  );
  return result.rows;
}

export async function migrateUp(
  pool: Pool,
  options: MigrationUpOptions,
): Promise<readonly MigrationRecord[]> {
  const migrations = await loadMigrations(options);
  try {
    const records = await withTransaction(pool, async (client) => {
      // 该 legacy key 是跨版本迁移进程的共同锁身份；品牌改名不能让新旧进程取得两把不同的锁。
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cube_runtime_schema_migrations_v1'))",
      );
      // 安全检查必须早于迁移表和任何业务 DDL，失败时数据库保持原状。
      await assertMigrationContextSafe(client, options);
      // 迁移脚本只读取事务级固定值，不能从会话或 SQL 文本动态选择发布角色。
      await client.query("SELECT set_config('app.skill_publisher_role', $1, true)", [
        options.skillPublisherRole,
      ]);
      await client.query("SELECT set_config('app.admin_control_role', $1, true)", [
        options.adminControlRole,
      ]);
      await client.query("SELECT set_config('app.runtime_role', $1, true)", [options.runtimeRole]);
      await client.query("SELECT set_config('app.worker_coordinator_role', $1, true)", [
        options.workerCoordinatorRole,
      ]);
      await ensureMigrationTable(client);
      const applied = await appliedMigrations(client);
      // 2026-11 基线压缩后，压缩前的迁移记录（任意 0001 以外版本或旧 0001 名称）都会在此失败关闭；
      // 这类数据库必须清空 Schema 后重新执行 db:setup，不能改写迁移记录。
      for (const record of applied) {
        const source = migrations.find((migration) => migration.version === record.version);
        if (
          source === undefined ||
          source.name !== record.name ||
          source.checksum !== record.checksum
        ) {
          throw new PersistenceError(
            "MIGRATION_MISMATCH",
            `已应用迁移 ${record.version} 与当前源码不一致`,
          );
        }
      }
      for (const migration of migrations) {
        if (applied.some((record) => record.version === migration.version)) continue;
        await client.query(migration.upSql);
        await client.query(
          "INSERT INTO runtime_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
      }
      // 首版 manifest 禁止 routine；迁移 SQL 若创建函数/过程/聚合，必须在提交前整体回滚。
      await assertMigrationContextSafe(client, options);
      // 业务 DDL、迁移记录与 Runtime ACL 必须原子提交，白名单断言失败会回滚首次建表。
      await bootstrapRuntimeAccessOnClient(client, options);
      return appliedMigrations(client);
    });
    return records;
  } catch (error) {
    // mapPersistenceError 已保留脱敏 SQLSTATE；重复定义 cause 会在其不可配置时遮蔽原始迁移错误。
    throw mapPersistenceError(error, "执行向前迁移");
  }
}

export async function migrateDown(
  pool: Pool,
  options: MigrationDownOptions,
): Promise<readonly MigrationRecord[]> {
  if (options.allowDestructive !== true || !["development", "test"].includes(options.environment)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "当前环境禁止破坏性数据库回退");
  }
  const targetVersion = options.targetVersion ?? 0;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new TypeError("目标迁移版本必须是非负整数");
  }
  const migrations = await loadMigrations(options);
  try {
    const records = await withTransaction(pool, async (client) => {
      // down 必须与旧版和新版 up 共用同一 legacy 锁身份，不能随项目品牌改名。
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cube_runtime_schema_migrations_v1'))",
      );
      // 与 up 使用同一套 Runtime/Migrator/Schema preflight，且必须早于迁移表 DDL。
      await assertMigrationContextSafe(client, options);
      await client.query("SELECT set_config('app.skill_publisher_role', $1, true)", [
        options.skillPublisherRole,
      ]);
      await client.query("SELECT set_config('app.admin_control_role', $1, true)", [
        options.adminControlRole,
      ]);
      await client.query("SELECT set_config('app.runtime_role', $1, true)", [options.runtimeRole]);
      await client.query("SELECT set_config('app.worker_coordinator_role', $1, true)", [
        options.workerCoordinatorRole,
      ]);
      await ensureMigrationTable(client);
      const applied = await appliedMigrations(client);
      for (const record of [...applied].reverse()) {
        if (record.version <= targetVersion) continue;
        const source = migrations.find((migration) => migration.version === record.version);
        if (source === undefined || source.checksum !== record.checksum) {
          throw new PersistenceError("MIGRATION_MISMATCH", `无法安全回退迁移 ${record.version}`);
        }
        // 某个 down migration 可能为冲刷自身约束临时切到 IMMEDIATE；下一项必须恢复
        // DEFERRABLE 约束的初始语义，避免一个迁移的会话状态污染后续回退脚本。
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(source.downSql);
        await client.query("DELETE FROM runtime_schema_migrations WHERE version = $1", [
          record.version,
        ]);
      }
      await assertMigrationContextSafe(client, options);
      const records = await appliedMigrations(client);
      if (targetVersion === 0) {
        // down SQL 与 ACL 回收共用当前 client/事务，任一步失败都会整体回滚。
        await teardownRuntimeSchemaAccessOnClient(client, options);
      } else {
        await bootstrapRuntimeAccessOnClient(client, options);
      }
      return records;
    });
    return records;
  } catch (error) {
    throw mapPersistenceError(error, "执行回退迁移");
  }
}
