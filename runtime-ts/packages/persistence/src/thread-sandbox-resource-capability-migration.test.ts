import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(
      `../migrations/0031_thread_sandbox_resource_capability.${direction}.sql`,
      import.meta.url,
    ),
    "utf8",
  );

describe("Thread Sandbox ResourceFS capability migration", () => {
  it("把旧 Session 回填为已挂载，并让新 Session 默认不挂载", () => {
    const sql = migration("up");
    expect(sql.indexOf("DEFAULT true")).toBeLessThan(sql.indexOf("SET DEFAULT false"));
    expect(sql).toContain("resource_filesystem_mounted boolean NOT NULL");
  });

  it("存在可复用的无挂载 Session 时拒绝回退", () => {
    const sql = migration("down");
    expect(sql).toContain("resource_filesystem_mounted = false");
    expect(sql).toContain("'running', 'pausing', 'paused', 'resuming'");
    expect(sql).toContain("拒绝回退能力字段");
  });
});
