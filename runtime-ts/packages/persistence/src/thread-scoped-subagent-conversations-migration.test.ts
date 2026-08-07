import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(
      `../migrations/0035_thread_scoped_subagent_conversations.${direction}.sql`,
      import.meta.url,
    ),
    "utf8",
  );
const roleBootstrap = () => readFileSync(new URL("./role-bootstrap.ts", import.meta.url), "utf8");

describe("Thread 级 SubAgent 对话 migration", () => {
  it("独立保存固定工具清单、全局 turn 序号和可复用历史", () => {
    const sql = migration("up");
    expect(sql).toContain("CREATE TABLE runtime_subagent_conversations");
    expect(sql).toContain("tool_manifest_digest");
    expect(sql).toContain("turn_ordinal");
    expect(sql).toContain("history_digest");
    expect(sql).toContain("REFERENCES threads(tenant_id, id)");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("没有为跨 Run 复用引入后台执行或可变工具清单", () => {
    const sql = migration("up");
    expect(sql).not.toContain("background_execution");
    expect(sql).not.toContain("pending_tool_manifest");
  });

  it("Runtime 角色只能更新 turn 序号和完整完成历史", () => {
    const source = roleBootstrap();
    expect(source).toContain('new Set(["runtime_subagent_conversations"])');
    expect(source).toMatch(/runtime_subagent_conversations TO \$\{role\}/u);
    expect(source).toContain("GRANT UPDATE(turn_ordinal,history,history_digest,updated_at)");
    expect(source).not.toContain("GRANT UPDATE(enabled_tools,tool_manifest_digest)");
  });

  it("存在持久对话时拒绝破坏性回退", () => {
    expect(migration("down")).toContain("存在可复用 SubAgent 对话，不能无损回退 0035");
  });
});
