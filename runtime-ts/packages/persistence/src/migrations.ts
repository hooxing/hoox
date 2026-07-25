import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

async function loadMigrations(): Promise<readonly Migration[]> {
  const files = await readdir(migrationDirectory);
  const upFiles = files.filter((name) => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(name)).sort();
  return Promise.all(
    upFiles.map(async (fileName) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.up\.sql$/.exec(fileName);
      if (match === null) throw new PersistenceError("MIGRATION_MISMATCH", "迁移文件名无效");
      const versionText = match[1];
      const name = match[2];
      if (versionText === undefined || name === undefined) {
        throw new PersistenceError("MIGRATION_MISMATCH", "迁移文件名无效");
      }
      const downName = `${versionText}_${name}.down.sql`;
      if (!files.includes(downName)) {
        throw new PersistenceError("MIGRATION_MISMATCH", `迁移 ${versionText} 缺少 down 文件`);
      }
      const [upSql, downSql] = await Promise.all([
        readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"),
        readFile(new URL(`../migrations/${downName}`, import.meta.url), "utf8"),
      ]);
      return {
        version: Number.parseInt(versionText, 10),
        name,
        upSql,
        downSql,
        checksum: createHash("sha256").update(upSql).digest("hex"),
      };
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

export async function migrateUp(pool: Pool): Promise<readonly MigrationRecord[]> {
  const migrations = await loadMigrations();
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
      return appliedMigrations(client);
    });
  } catch (error) {
    throw mapPersistenceError(error, "执行向前迁移");
  }
}

export async function migrateDown(
  pool: Pool,
  targetVersion = 0,
): Promise<readonly MigrationRecord[]> {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new TypeError("目标迁移版本必须是非负整数");
  }
  const migrations = await loadMigrations();
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
