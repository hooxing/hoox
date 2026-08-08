import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(direction: "up" | "down") {
  return readFile(
    new URL(
      `../migrations/0039_semantic_history_filesystem_names.${direction}.sql`,
      import.meta.url,
    ),
    "utf8",
  );
}

describe("历史文件语义路径迁移", () => {
  it("up 使用 Thread 标题与 Resource 原名，并只在冲突时追加序号", async () => {
    const up = await migration("up");
    expect(up).toContain("JOIN threads thread");
    expect(up).toContain("JOIN resources resource");
    expect(up).not.toContain("to_char(");
    expect(up).toContain("PARTITION BY tenant_id,base_name");
    expect(up).toContain("PARTITION BY tenant_id,thread_id,base_name");
    expect(up).toContain("substring(base_name from '(\\.[^.]*)$')");
    expect(up).toContain("tenant.kind='personal'");
    expect(up).toContain("ALTER TABLE tenants DISABLE ROW LEVEL SECURITY");
    expect(up).toContain("ALTER TABLE tenants FORCE ROW LEVEL SECURITY");
  });

  it("down 使用保留的时间元数据恢复旧命名", async () => {
    const down = await migration("down");
    expect(down).toContain("directory.directory_timestamp");
    expect(down).toContain("entry.first_attached_at");
    expect(down.match(/to_char\(/gu)).toHaveLength(2);
  });
});
