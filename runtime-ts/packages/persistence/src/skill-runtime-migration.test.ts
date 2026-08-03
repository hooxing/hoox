import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0030_skill_runtime.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("Skill Runtime migration", () => {
  it("持久化不可变 Run 快照、显式请求和 durable 调用事实", () => {
    const sql = migration("up");

    expect(sql).toContain("CREATE TABLE run_skill_snapshots");
    expect(sql).toContain("'preview', 'skill'");
    expect(sql).toContain("CREATE TABLE run_skill_snapshot_items");
    expect(sql).toContain("CREATE TABLE skill_invocations");
    expect(sql).toContain("explicit_invocation_name");
    expect(sql).toContain("source IN ('explicit', 'tool')");
    expect(sql).toContain("run_skill_snapshots_tenant_policy");
    expect(sql).toContain("skill_invocations_tenant_policy");
  });

  it("模型目录没有持久化 Blob URL，回滚保护历史快照与调用", () => {
    const up = migration("up");
    const down = migration("down");

    expect(up).not.toContain("signed_url");
    expect(down).toContain("Skill Runtime 调用事实非空，拒绝破坏性回滚");
    expect(down).toContain("Run Skill 快照事实非空，拒绝破坏性回滚");
    expect(down).toContain("Skill Blob 生命周期事实非空，拒绝破坏性回滚");
  });
});
