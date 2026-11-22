import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrations.js";

vi.mock("./role-bootstrap.js", () => ({
  assertMigrationContextSafe: vi.fn(),
  bootstrapRuntimeAccessOnClient: vi.fn(),
  teardownRuntimeSchemaAccessOnClient: vi.fn(),
}));

const security = {
  runtimeRole: "test_runtime",
  migratorRole: "test_migrator",
  skillPublisherRole: "test_publisher",
  workerCoordinatorRole: "test_worker",
  teamCoordinatorRole: "test_team",
  adminControlRole: "test_control",
  schema: "test_migrations",
};

describe("迁移执行器约束检查时序", () => {
  it.each(["up", "down"] as const)("每个 %s 脚本前都恢复即时检查", async (direction) => {
    const directory = await mkdtemp(join(tmpdir(), "hoox-migration-constraints-"));
    try {
      for (const name of ["0001_first", "0002_second"]) {
        for (const scriptDirection of ["up", "down"]) {
          await writeFile(
            join(directory, `${name}.${scriptDirection}.sql`),
            `SELECT '${name}_${scriptDirection}'; SET CONSTRAINTS ALL DEFERRED;`,
          );
        }
      }
      const migrations = await loadMigrations({ directory });
      const applied = migrations.map(({ version, name, checksum }) => ({
        version,
        name,
        checksum,
      }));
      const statements: string[] = [];
      const client = {
        release: vi.fn(),
        query: vi.fn(async (sql: string) => {
          statements.push(sql);
          return {
            rows:
              sql.startsWith("SELECT version, name, checksum") && direction === "down"
                ? applied
                : [],
          };
        }),
      } as unknown as PoolClient;
      const pool = { connect: async () => client } as unknown as Pool;
      if (direction === "up") {
        await migrateUp(pool, { ...security, directory });
      } else {
        await migrateDown(pool, {
          ...security,
          directory,
          allowDestructive: true,
          environment: "test",
        });
      }
      const scripts =
        direction === "up"
          ? migrations.map((migration) => migration.upSql)
          : [...migrations].reverse().map((migration) => migration.downSql);
      expect(statements.filter((sql) => scripts.includes(sql))).toEqual(scripts);
      for (const sql of scripts) {
        const position = statements.indexOf(sql);
        expect(position).toBeGreaterThan(0);
        expect(statements[position - 1]).toBe("SET CONSTRAINTS ALL IMMEDIATE");
      }
      expect(statements.filter((sql) => sql === "SET CONSTRAINTS ALL IMMEDIATE")).toHaveLength(
        migrations.length,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
