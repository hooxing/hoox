import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(direction: "up" | "down") {
  return readFile(
    new URL(`../migrations/0028_direct_vision_attachments.${direction}.sql`, import.meta.url),
    "utf8",
  );
}

describe("视觉输入附件迁移", () => {
  it("只在 receipt 保存 Resource/Version 身份并限制为单轮二十项", async () => {
    const up = await migration("up");
    expect(up).toContain("ADD COLUMN input_attachments jsonb NOT NULL");
    expect(up).toContain("jsonb_path_query_array(input_attachments, '$.*.*')");
    expect(up).toContain("@.key like_regex");
    expect(up).toContain("@ >= 0 && @ < 20 && @.floor() == @");
    expect(up).not.toContain("CREATE FUNCTION");
    expect(up).not.toMatch(/physical_object_key|base64|image_data/iu);
  });

  it("回退只删除约束与列，不引入 routine 生命周期", async () => {
    const down = await migration("down");
    expect(down).toContain("DROP COLUMN input_attachments");
    expect(down).not.toContain("DROP FUNCTION");
  });
});
