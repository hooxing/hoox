import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(direction: "up" | "down") {
  return readFile(
    new URL(`../migrations/0036_personal_history_filesystem.${direction}.sql`, import.meta.url),
    "utf8",
  );
}

describe("个人历史文件系统迁移", () => {
  it("只回填 personal Tenant 的 durable 附件关系并建立 Tenant RLS", async () => {
    const up = await migration("up");
    expect(up).toContain("tenant.kind='personal'");
    expect(up).toContain("thread_history_directories");
    expect(up).toContain("thread_history_file_entries");
    expect(up).toContain("receipt.disposition IN ('queued', 'pending_steer', 'steered')");
    expect(up).toContain("ENABLE ROW LEVEL SECURITY");
    expect(up).toContain("FORCE ROW LEVEL SECURITY");
    expect(up.match(/resource\.visibility='searchable'/g)).toHaveLength(2);
    expect(up).not.toContain("CREATE FUNCTION");
  });

  it("目录与文件关系保留 Tenant 复合身份和稳定 receipt 来源", async () => {
    const up = await migration("up");
    expect(up).toContain("PRIMARY KEY (tenant_id, thread_id)");
    expect(up).toContain("UNIQUE (tenant_id, directory_name)");
    expect(up).toContain(
      "PRIMARY KEY (tenant_id, thread_id, resource_id, resource_version_id, relation_type)",
    );
    expect(up).toContain("REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id)");
    expect(up).toContain("directory_time_zone");
    expect(up.match(/^\s+45\r?$/gm)).toHaveLength(2);
  });

  it("回退先删除关系表再删除 Thread 标题状态", async () => {
    const down = await migration("down");
    expect(down.indexOf("DROP TABLE IF EXISTS thread_history_file_entries")).toBeLessThan(
      down.indexOf("DROP COLUMN IF EXISTS title_generation_version"),
    );
  });
});
