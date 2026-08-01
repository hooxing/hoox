import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

describe("阶段 2 Thread Context migrations", () => {
  it("按 stream/entry/append command 再 history audit 的顺序安装", () => {
    const stream = migration("0021_thread_context_stream.up.sql");
    const audits = migration("0022_thread_context_history_audits.up.sql");
    expect(stream.indexOf("CREATE TABLE thread_context_streams")).toBeLessThan(
      stream.indexOf("CREATE TABLE thread_context_entries"),
    );
    expect(stream.indexOf("CREATE TABLE thread_context_entries")).toBeLessThan(
      stream.indexOf("CREATE TABLE thread_context_append_commands"),
    );
    expect(stream).toContain("tool_call_predecessor_kind");
    expect(stream).toContain("REFERENCES blob_references");
    expect(stream).toContain("body_operation_id");
    expect(stream).toContain("body_lifecycle_id");
    expect(stream).toContain("lifecycle_id,incarnation_id,physical_object_key");
    expect(audits).toContain("compatibility_digest");
    expect(audits).toContain("history_digest");
  });

  it("facts 非空时拒绝破坏性 down", () => {
    expect(migration("0021_thread_context_stream.down.sql")).toContain(
      "thread_context_entries 非空，拒绝破坏性回滚",
    );
    expect(migration("0022_thread_context_history_audits.down.sql")).toContain(
      "thread_context_entries 非空，拒绝破坏性回滚",
    );
  });
});

describe("阶段 4 Runtime compaction migrations", () => {
  it("先扩展事实 kind，再创建 checkpoint 与 normalized replacement items", () => {
    const sql = migration("0024_thread_context_compaction.up.sql");
    expect(sql.indexOf("compaction_checkpoint")).toBeLessThan(
      sql.indexOf("CREATE TABLE thread_context_compaction_checkpoints"),
    );
    expect(sql.indexOf("CREATE TABLE thread_context_compaction_checkpoints")).toBeLessThan(
      sql.indexOf("CREATE TABLE thread_context_compaction_replacement_items"),
    );
    expect(sql).toContain("previous_checkpoint_id");
    expect(sql).toContain("replacement_history_digest");
    expect(sql).toContain("predecessor_ordinal");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("checkpoint 非空时拒绝 down，避免丢失恢复链", () => {
    expect(migration("0024_thread_context_compaction.down.sql")).toContain(
      "Thread compaction checkpoint 非空，拒绝破坏性回滚",
    );
  });
});
