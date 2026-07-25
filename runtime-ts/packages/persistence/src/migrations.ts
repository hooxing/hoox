import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool, PoolClient } from "pg";
import { PersistenceError, mapPersistenceError } from "./errors.js";
import { withTransaction } from "./postgres.js";

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

export interface MigrationUpOptions extends MigrationSourceOptions {
  readonly runtimeRole?: string;
}

export interface MigrationDownOptions extends MigrationSourceOptions {
  readonly targetVersion?: number;
  readonly allowDestructive: true;
  readonly environment: "development" | "test";
}

const defaultMigrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationPattern = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

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

function quoteIdentifier(value: string): string {
  if (!rolePattern.test(value)) throw new TypeError("数据库角色名称无效");
  return `"${value}"`;
}

const runtimeTables = [
  "app_users",
  "tenants",
  "memberships",
  "threads",
  "runs",
  "workspaces",
  "workspace_revisions",
  "workspace_write_leases",
] as const;

async function configureRuntimeRole(client: PoolClient, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const roleState = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [runtimeRole],
  );
  const state = roleState.rows[0];
  if (state === undefined || state.rolsuper || state.rolbypassrls) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 数据库角色缺失或权限过高");
  }
  const context = await client.query<{ schema_name: string; database_name: string }>(
    "SELECT current_schema() AS schema_name, current_database() AS database_name",
  );
  const schemaName = context.rows[0]?.schema_name;
  const databaseName = context.rows[0]?.database_name;
  if (schemaName === undefined || databaseName === undefined) {
    throw new PersistenceError("UNEXPECTED", "无法识别迁移数据库上下文");
  }
  const schema = quoteIdentifier(schemaName);
  const database = quoteIdentifier(databaseName);
  const tables = runtimeTables.map(quoteIdentifier).join(", ");
  await client.query(`REVOKE CREATE ON DATABASE ${database} FROM PUBLIC, ${role}`);
  await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${role}`);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables} TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  const ownership = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relnamespace = $1::regnamespace AND r.rolname = $2`,
    [schemaName, runtimeRole],
  );
  if (ownership.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 角色不能拥有业务表");
  }
}

export async function migrateUp(
  pool: Pool,
  options: MigrationUpOptions = {},
): Promise<readonly MigrationRecord[]> {
  const migrations = await loadMigrations(options);
  try {
    return await withTransaction(pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cube_runtime_schema_migrations_v1'))",
      );
      await ensureMigrationTable(client);
      const applied = await appliedMigrations(client);
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
      if (options.runtimeRole !== undefined) {
        await configureRuntimeRole(client, options.runtimeRole);
      }
      return appliedMigrations(client);
    });
  } catch (error) {
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
    return await withTransaction(pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cube_runtime_schema_migrations_v1'))",
      );
      await ensureMigrationTable(client);
      const applied = await appliedMigrations(client);
      for (const record of [...applied].reverse()) {
        if (record.version <= targetVersion) continue;
        const source = migrations.find((migration) => migration.version === record.version);
        if (source === undefined || source.checksum !== record.checksum) {
          throw new PersistenceError("MIGRATION_MISMATCH", `无法安全回退迁移 ${record.version}`);
        }
        await client.query(source.downSql);
        await client.query("DELETE FROM runtime_schema_migrations WHERE version = $1", [
          record.version,
        ]);
      }
      return appliedMigrations(client);
    });
  } catch (error) {
    throw mapPersistenceError(error, "执行回退迁移");
  }
}
