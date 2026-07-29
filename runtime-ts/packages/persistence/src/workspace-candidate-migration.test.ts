import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../migrations/0015_workspace_candidate_handoff.up.sql", import.meta.url),
);

describe("0015 Workspace candidate handoff migration contract", () => {
  it("绑定完整候选身份、released 非可达、RLS 与恢复索引", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const field of [
      "tenant_id",
      "workspace_id",
      "attempt_id",
      "run_id",
      "root_run_id",
      "parent_revision_id",
      "revision_id",
      "operation_key",
      "operation_digest",
      "manifest_digest",
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain("state IN ('staged', 'stable', 'released')");
    expect(sql).toContain("workspace_revision_candidate_files_reference_unique");
    expect(sql).toContain("status IN ('building', 'prepared')");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain(
      "REVOKE ALL ON workspace_revision_candidates, workspace_revision_candidate_files FROM PUBLIC",
    );
  });
});
