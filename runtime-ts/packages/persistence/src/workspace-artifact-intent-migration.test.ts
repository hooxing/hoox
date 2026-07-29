import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const up = new URL("../migrations/0016_workspace_artifact_intents.up.sql", import.meta.url);
const down = new URL("../migrations/0016_workspace_artifact_intents.down.sql", import.meta.url);

describe("0016 Workspace Artifact intent migration contract", () => {
  it("保持 pending 不可见、完整 source FK、RLS/FORCE 与最小 ACL", async () => {
    const [sql, rollback] = await Promise.all([readFile(up, "utf8"), readFile(down, "utf8")]);
    expect(sql).toContain("CREATE TABLE workspace_artifact_publication_intents");
    expect(sql).toContain("workspace_revision_files_artifact_source_key");
    expect(sql).toContain("artifact_publication_workspace_source_fk");
    expect(sql).toContain("tool_args_digest text NOT NULL");
    expect(sql).toContain("source_relative_path text NOT NULL");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON workspace_artifact_publication_intents FROM PUBLIC");
    expect(sql).not.toContain("GRANT UPDATE");
    expect(rollback).toContain("DROP TABLE IF EXISTS workspace_artifact_publication_intents");
  });
});
