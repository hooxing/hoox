import { describe, expect, it } from "vitest";
import { loadMigrations } from "./migrations.js";

describe("外部工具迁移契约", () => {
  it("追加成对的不可变版本、撤销和只写凭据表且不授予 Runtime", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find((item) => item.name === "external_tools");
    expect(migration).toBeDefined();
    const sql = migration?.upSql ?? "";
    expect(sql).toContain("CREATE TABLE external_tool_versions");
    expect(sql).toContain("CREATE TABLE external_tool_credentials");
    expect(sql).toContain("CREATE TABLE external_tool_revocations");
    expect(sql).toContain("GRANT INSERT ON external_tool_credentials");
    expect(sql).not.toMatch(/GRANT\s+[^;]*\b(?:runtime|worker_coordinator)\b/iu);
    expect(sql).not.toMatch(/GRANT\s+SELECT[^;]*external_tool_credentials[^;]*admin_control/iu);
    expect(sql).not.toMatch(
      /GRANT\s+(?:UPDATE|DELETE|ALL)[^;]*external_tool_(?:versions|credentials|revocations)/iu,
    );
    expect(migration?.downSql).toContain("DROP TABLE external_tool_revocations");
  });
});
