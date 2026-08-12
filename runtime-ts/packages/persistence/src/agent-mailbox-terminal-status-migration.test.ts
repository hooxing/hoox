import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0043_agent_mailbox_terminal_status.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("Agent mailbox 终态 migration", () => {
  it("为完成、中断和失败消息持久化结构化终态", () => {
    const sql = migration("up");
    expect(sql).toContain("ADD COLUMN terminal_status text");
    expect(sql).toContain("ADD COLUMN error_code text");
    expect(sql).toContain("LEGACY_SUBAGENT_ERROR");
    expect(sql).toContain("terminal_status = 'completed'");
    expect(sql).toContain("terminal_status IN ('interrupted', 'failed')");
  });

  it("支持无损删除新增终态字段", () => {
    const sql = migration("down");
    expect(sql).toContain("DROP COLUMN error_code");
    expect(sql).toContain("DROP COLUMN terminal_status");
  });
});
