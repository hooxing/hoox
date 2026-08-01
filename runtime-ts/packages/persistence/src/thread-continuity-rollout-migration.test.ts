import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0026_thread_continuity_rollout.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("阶段 6 Thread continuity rollout migration", () => {
  it("先扩展事实类型，再建立策略、anchor、档案与低基数指标", () => {
    const sql = migration("up");
    expect(sql.indexOf("legacy_history_gap")).toBeLessThan(
      sql.indexOf("CREATE TABLE tenant_thread_continuity_policies"),
    );
    expect(sql.indexOf("CREATE TABLE tenant_thread_continuity_policies")).toBeLessThan(
      sql.indexOf("CREATE TABLE thread_context_legacy_anchors"),
    );
    expect(sql.indexOf("CREATE TABLE thread_context_legacy_anchors")).toBeLessThan(
      sql.indexOf("CREATE TABLE thread_continuity_profiles"),
    );
    expect(sql).toContain("new_thread_rollout_basis_points BETWEEN 0 AND 10000");
    expect(sql).toContain("'legacy_history_gap','legacy_v2_anchor'");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(5);
  });

  it("只保存稳定低基数维度，且事实存在时拒绝 down", () => {
    const up = migration("up");
    expect(up).toContain("metric_name text NOT NULL CHECK");
    expect(up).not.toContain("provider_sandbox_id");
    expect(up).not.toContain("input_text");
    expect(up).not.toContain("lease_token");
    expect(up).not.toContain("credential");
    expect(up).not.toContain("tool_output");
    expect(migration("down")).toContain("阶段 6 continuity facts 已存在，拒绝破坏性回退");
  });
});
