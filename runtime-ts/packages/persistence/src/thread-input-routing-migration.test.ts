import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0023_thread_input_routing.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("阶段 3 Thread input routing migration", () => {
  it("先扩展 receipt，再建立 disposition 事件与 RLS", () => {
    const up = migration("up");
    expect(up.indexOf("ADD COLUMN next_input_sequence")).toBeLessThan(
      up.indexOf("CREATE TABLE thread_input_receipt_events"),
    );
    expect(up).toContain("requested_mode IN ('auto','steer','follow_up')");
    expect(up).toContain("thread_input_receipts_pending_steer_idx");
    expect(up).toContain("FORCE ROW LEVEL SECURITY");
    expect(up).toContain("applied_context_sequence IS NOT NULL");
  });

  it("有阶段 3 receipt/event 时拒绝破坏性 down", () => {
    const down = migration("down");
    expect(down).toContain("阶段 3 input receipt/event 非空，拒绝破坏性回滚");
    expect(down.indexOf("DROP TABLE thread_input_receipt_events")).toBeLessThan(
      down.indexOf("DROP COLUMN input_sequence"),
    );
  });
});
