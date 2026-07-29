import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../migrations/0014_workspace_manifest_journal.up.sql", import.meta.url),
);

describe("0014 Workspace manifest migration contract", () => {
  it("拒绝带 legacy current head 的半升级，并声明 manifest/incarnation/RLS/journal 约束", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("current_revision_id IS NOT NULL");
    expect(sql).toContain("requires workspace manifest backfill before upgrade");
    expect(sql).toContain("REFERENCES workspace_revision_manifests");
    expect(sql).toContain("REFERENCES blob_incarnations");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON workspace_revision_manifests");
    expect(sql).toContain("status IN ('running', 'completed', 'retryable', 'terminal', 'unknown')");
  });
});
