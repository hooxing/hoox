import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadMigrations } from "./migrations.js";

describe("Run 部署压缩参数迁移", () => {
  it("独立快照支持部署模型并限定 Runtime 只能在本 Tenant 读取和新增", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find((candidate) => candidate.version === 61);
    const bootstrap = await readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8");
    expect(migration?.upSql).toContain("REFERENCES runs(tenant_id,id)");
    expect(migration?.upSql).toContain("PRIMARY KEY (tenant_id,run_id)");
    expect(migration?.upSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.upSql).toContain(
      "tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')",
    );
    expect(migration?.upSql).not.toContain("admin_control_active_configs");
    expect(bootstrap).toContain(
      '["run_compaction_settings_snapshots", new Set(["SELECT", "INSERT"])]',
    );
    expect(bootstrap).toContain("hasRunCompactionSettingsState");
    expect(bootstrap).toContain("ALTER POLICY run_compaction_settings_runtime_policy");
    expect(migration?.downSql).toContain("Run 上下文压缩快照非空，拒绝破坏性回滚");
  });
});
