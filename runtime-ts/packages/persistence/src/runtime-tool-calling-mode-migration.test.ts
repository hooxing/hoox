import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrations } from "./migrations.js";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

const constraint = (sql: string) =>
  sql
    .slice(
      sql.indexOf("ALTER TABLE admin_control_config_revisions DROP CONSTRAINT"),
      sql.indexOf("\nALTER TABLE run_runtime_config_snapshots") === -1
        ? undefined
        : sql.indexOf("\nALTER TABLE run_runtime_config_snapshots"),
    )
    .trim();

describe("运行设置工具调用模式迁移", () => {
  it("只扩展可选模式，完整保留既有模型、记忆与运行参数约束", () => {
    const previous = constraint(migration("0062_managed_memory_configuration.up.sql"));
    const current = constraint(migration("0067_runtime_tool_calling_mode_configuration.up.sql"));
    const modeGuard =
      "      AND (\n" +
      "        NOT (configuration ? 'toolCallingMode')\n" +
      "        OR (jsonb_typeof(configuration->'toolCallingMode')='string'\n" +
      "          AND configuration->>'toolCallingMode' IN ('native','ptc'))\n" +
      "      )\n";
    expect(current).toContain(modeGuard);
    expect(current).toContain("'toolCallingMode','workerMaxConcurrentRuns'");
    expect(
      current
        .replace("'toolCallingMode','workerMaxConcurrentRuns'", "'workerMaxConcurrentRuns'")
        .replace(modeGuard, ""),
    ).toBe(previous);
    expect(current).not.toContain("UPDATE admin_control_config_revisions");
  });

  it("先锁定并拒绝移除含模式字段的历史事实，再恢复原约束", () => {
    const down = migration("0067_runtime_tool_calling_mode_configuration.down.sql");
    expect(down).toContain("LOCK TABLE admin_control_config_revisions IN ACCESS EXCLUSIVE MODE");
    expect(down).toContain("object_kind='runtime_settings' AND configuration ? 'toolCallingMode'");
    expect(down).toContain("DOWN_MIGRATION_BLOCKED:runtime_tool_calling_mode_configuration_exists");
    expect(down.indexOf("RAISE EXCEPTION")).toBeLessThan(down.indexOf("DROP CONSTRAINT"));
    expect(constraint(down)).toBe(
      constraint(migration("0062_managed_memory_configuration.up.sql")),
    );
    expect(down).not.toContain("UPDATE admin_control_config_revisions");
  });

  it("新增成对迁移，不修改已发布的 PTC journal 指纹", async () => {
    const migrations = await loadMigrations();
    expect(migrations.find((source) => source.version === 66)?.checksum).toBe(
      "e3cc49e569947cc035043749441ac0a4b22ca083a66a1bf13ffc768276c23361",
    );
    const mode = migrations.find((source) => source.version === 67);
    expect(mode?.name).toBe("runtime_tool_calling_mode_configuration");
    expect(mode?.upSql).toContain("toolCallingMode");
    expect(mode?.downSql).toContain("DOWN_MIGRATION_BLOCKED");
  });
});
