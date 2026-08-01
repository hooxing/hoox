import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0027_thread_continuity_default_on.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("0027 Thread continuity 默认开启迁移", () => {
  it("新策略默认全量并为既有 Tenant 补齐开启策略", () => {
    const sql = migration("up");
    expect(sql).toContain("ALTER COLUMN v2_read_enabled SET DEFAULT true");
    expect(sql).toContain("ALTER COLUMN new_thread_rollout_basis_points SET DEFAULT 10000");
    expect(sql).toContain("ALTER COLUMN legacy_anchor_read_enabled SET DEFAULT true");
    expect(sql).toContain("SELECT id,1,true,10000,true FROM tenants");
    expect(sql).toContain("policy_version=0");
  });

  it("数据修复结束前恢复所有暂时关闭的 RLS，并保留显式 policy 的回退能力", () => {
    const up = migration("up");
    for (const table of [
      "tenants",
      "tenant_thread_continuity_policies",
      "thread_continuity_profiles",
    ]) {
      expect(up).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(up).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration("down")).toContain("ALTER COLUMN v2_read_enabled SET DEFAULT false");
  });
});
