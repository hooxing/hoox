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

describe("外部工具远程名称迁移契约", () => {
  it("以追加迁移为 MCP 版本固定原始工具名并约束 HTTP 为空", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find((item) => item.name === "external_tool_remote_name");
    expect(migration).toBeDefined();
    expect(migration?.upSql).toContain("ADD COLUMN remote_tool_name text");
    expect(migration?.upSql).toContain("source = 'mcp' AND remote_tool_name IS NOT NULL");
    expect(migration?.upSql).toContain("source = 'http' AND remote_tool_name IS NULL");
    expect(migration?.upSql).toContain(") NOT VALID;");
    expect(migration?.downSql).toContain("DROP COLUMN remote_tool_name");
  });
});

describe("外部工具双栅栏与许可迁移契约", () => {
  it("追加双视图与精确版本绑定，许可门不投影密文", async () => {
    const migration = (await loadMigrations()).find(
      (item) => item.name === "external_tool_http_method_and_run_view",
    );
    expect(migration).toBeDefined();
    const sql = migration?.upSql ?? "";
    expect(sql).toContain("CREATE VIEW worker_run_external_tool_snapshots");
    expect(sql).toContain("claim.claim_token=current_setting");
    expect(sql).toContain("fence.lease_epoch=claim.workspace_lease_epoch");
    expect(sql).toContain("lease.expires_at>clock_timestamp()");
    expect(sql).toContain("claim.expires_at>clock_timestamp()");
    expect(sql).toContain("ADD COLUMN tool_version_id text");
    const gate = sql.split("CREATE VIEW runtime_external_tool_permit_gate")[1]?.split("DO $$")[0];
    expect(gate).toContain("FOR UPDATE OF version");
    expect(gate).not.toMatch(/credential|ciphertext|claim_token/u);
    expect(migration?.downSql).toContain("DROP COLUMN tool_version_id");
  });
});
