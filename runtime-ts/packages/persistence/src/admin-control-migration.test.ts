import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");
}

describe("后台控制面迁移", () => {
  it("把配置、激活、审计和 Run 快照分表，并对 Runtime 只开放已发布读取", () => {
    const sql = migration("0050_admin_control_plane.up.sql");
    expect(sql).toContain("CREATE TABLE admin_control_config_revisions");
    expect(sql).toContain("CREATE TABLE admin_control_activation_events");
    expect(sql).toContain("CREATE TABLE run_runtime_config_snapshots");
    expect(sql).toContain("CREATE VIEW admin_runtime_statistics");
    expect(sql).toContain("runtime_control_revisions_read_policy");
    expect(sql).toContain("run_runtime_config_snapshots_runtime_policy");
    expect(sql).toContain(
      "snapshot.tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')",
    );
    expect(sql).not.toContain("run_runtime_config_snapshots_control_read_policy");
    expect(sql).toContain("admin_control_configuration_shape");
    expect(sql).toContain("configuration-ARRAY[");
    expect(sql).toContain("configuration->>'providerKey'=object_key");
    expect(sql).toContain("object_key='global'");
    expect(sql).not.toContain("MODEL_API_KEY");
    expect(sql).not.toContain("MEM0_API_KEY");
  });

  it("存在任何配置、审计或 Run 快照时拒绝破坏性回滚", () => {
    const sql = migration("0050_admin_control_plane.down.sql");
    expect(sql).toContain("后台控制面已有事实，禁止破坏性回退");
    expect(sql).toContain("run_runtime_config_snapshots");
  });
});
