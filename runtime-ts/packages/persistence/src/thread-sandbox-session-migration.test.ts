import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0025_thread_sandbox_sessions.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("阶段 5 Thread Sandbox Session migration", () => {
  it("按 Session、唯一 lease、effect intent/receipt 顺序安装并强制 Tenant RLS", () => {
    const sql = migration("up");
    expect(sql.indexOf("CREATE TABLE thread_sandbox_sessions")).toBeLessThan(
      sql.indexOf("CREATE TABLE thread_sandbox_leases"),
    );
    expect(sql.indexOf("CREATE TABLE thread_sandbox_leases")).toBeLessThan(
      sql.indexOf("CREATE TABLE sandbox_lifecycle_effects"),
    );
    expect(sql).toContain("thread_sandbox_leases_one_unreleased_idx");
    expect(sql).toContain("WHERE released_at IS NULL");
    expect(sql).toContain("UNIQUE (provider_sandbox_id)");
    expect(sql).toContain("'running', 'pausing', 'paused', 'resuming', 'terminated', 'unknown'");
    expect(sql).toContain("'pending', 'started', 'succeeded', 'failed_not_applied', 'unknown'");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
  });

  it("unknown 不阻塞 cold generation，且存在任何 lifecycle facts 时拒绝 down", () => {
    const up = migration("up");
    const down = migration("down");
    expect(up).toContain("WHERE state IN ('running', 'pausing', 'paused', 'resuming')");
    expect(down).toContain("阶段 5 Sandbox Session 已产生事实，拒绝破坏性回退");
  });
});
