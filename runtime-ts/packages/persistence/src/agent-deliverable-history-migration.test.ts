import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(direction: "up" | "down") {
  return readFile(
    new URL(`../migrations/0040_agent_deliverable_history.${direction}.sql`, import.meta.url),
    "utf8",
  );
}

describe("Agent deliverable 历史目录迁移", () => {
  it("只回填 personal Tenant 已发布的 deliverable，并保留 Artifact 来源约束", async () => {
    const up = await migration("up");
    expect(up).toContain("tenant.kind='personal'");
    expect(up).toContain("publication.purpose='deliverable'");
    expect(up).toContain("settlement.target='published'");
    expect(up).toContain("source_artifact_id");
    expect(up).toContain("source_artifact_purpose");
    expect(up).toContain("REFERENCES artifact_publications(tenant_id,id,thread_id,purpose)");
    expect(up).toContain("relation_type='agent_deliverable'");
    expect(up).not.toContain("purpose IN ('deliverable','diagnostic','trace')");
  });

  it("已有目录保持稳定，重名文件序号位于扩展名前", async () => {
    const up = await migration("up");
    expect(up).toContain("已有附件目录保持原路径不变");
    expect(up).toContain("NOT EXISTS (\n         SELECT 1 FROM thread_history_directories");
    expect(up).toContain("left(base_name,dot_position-1) || '-' || ordinal::text");
    expect(up).toContain("directory_entry_name=candidate");
  });

  it("回退删除 deliverable 关系并恢复 user_attachment 单一约束", async () => {
    const down = await migration("down");
    expect(down).toContain(
      "DELETE FROM thread_history_file_entries WHERE relation_type='agent_deliverable'",
    );
    expect(down).toContain("ALTER COLUMN first_receipt_id SET NOT NULL");
    expect(down).toContain("CHECK (relation_type='user_attachment')");
    expect(down).toContain("DROP CONSTRAINT artifact_publications_history_source_key");
  });
});
