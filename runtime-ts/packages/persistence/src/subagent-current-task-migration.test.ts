import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0044_subagent_current_task.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("SubAgent 当前任务 migration", () => {
  it("回填并约束当前任务", () => {
    const sql = migration("up");
    expect(sql).toContain("ADD COLUMN current_task text");
    expect(sql).toContain("SET current_task = task");
    expect(sql).toContain("ALTER COLUMN current_task SET NOT NULL");
  });

  it("支持删除当前任务字段", () => {
    expect(migration("down")).toContain("DROP COLUMN current_task");
  });
});
