import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const up = new URL("../migrations/0016_workspace_artifact_intents.up.sql", import.meta.url);
const down = new URL("../migrations/0016_workspace_artifact_intents.down.sql", import.meta.url);

describe("0016 Workspace Artifact intent migration contract", () => {
  it("保持 pending 不可见、消费 permit 证明、完整 source FK、RLS/FORCE 与最小 ACL", async () => {
    const [sql, rollback] = await Promise.all([readFile(up, "utf8"), readFile(down, "utf8")]);
    expect(sql).toContain("CREATE TABLE workspace_artifact_publication_intents");
    expect(sql).toContain("workspace_revision_files_artifact_source_key");
    expect(sql).toContain("artifact_publication_workspace_source_fk");
    expect(sql).toContain("tool_args_digest text NOT NULL");
    expect(sql).toContain("permit_consumed_at timestamptz NOT NULL");
    expect(sql).toContain("effect text GENERATED ALWAYS AS ('tool_execution'::text)");
    expect(sql).toContain("tool_name text GENERATED ALWAYS AS ('publish_artifact'::text)");
    expect(sql).toContain("external_effect_permits_artifact_intent_key");
    expect(sql).toContain("REFERENCES effect_invocations");
    expect(sql).toContain("REFERENCES external_effect_permits");
    expect(sql).toContain("source_relative_path text NOT NULL");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON workspace_artifact_publication_intents FROM PUBLIC");
    expect(sql).not.toContain("GRANT UPDATE");
    expect(rollback).toContain("DROP TABLE IF EXISTS workspace_artifact_publication_intents");
    expect(rollback).toContain("DELETE FROM artifact_publications publication");
    expect(rollback).toContain("workspace_artifact_down_publications");
    expect(rollback).toContain("intent.resource_version_id=publication.resource_version_id");
    expect(rollback).toContain("DELETE FROM resource_versions version");
    expect(rollback.indexOf("DELETE FROM resource_versions version")).toBeLessThan(
      rollback.indexOf("resource_versions_blob_purpose_check"),
    );
  });
});
