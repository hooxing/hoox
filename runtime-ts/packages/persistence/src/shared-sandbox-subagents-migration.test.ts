import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0034_shared_sandbox_subagents.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("共享 Sandbox SubAgent migration", () => {
  it("持久化 Agent Thread、Turn、mailbox 和幂等命令，并开放独立 Rollout", () => {
    const sql = migration("up");
    expect(sql).toContain("CREATE TABLE runtime_agent_threads");
    expect(sql).toContain("CREATE TABLE runtime_agent_turns");
    expect(sql).toContain("CREATE TABLE runtime_agent_mailbox_messages");
    expect(sql).toContain("CREATE TABLE runtime_agent_commands");
    expect(sql).toContain("agent_kind IN ('root', 'subagent')");
    expect(sql).toContain("DROP CONSTRAINT runtime_rollout_streams_tenant_id_attempt_id_key");
    expect(sql).toContain("'agent_model_start'");
    expect(sql).toContain("REFERENCES execution_attempts(tenant_id, attempt_id)");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(4);
  });

  it("没有引入 writer token、文件版本 CAS 或自动合并表", () => {
    const sql = migration("up");
    expect(sql).not.toContain("writer_token");
    expect(sql).not.toContain("file_version");
    expect(sql).not.toContain("merge_candidate");
  });

  it("存在 SubAgent 事实时拒绝破坏性回退", () => {
    expect(migration("down")).toContain("存在 SubAgent 运行事实，不能无损回退 0034");
  });
});
