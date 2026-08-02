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
    expect(up).toContain("jsonb_array_length(attachment_list) > 20");
    expect(up).toContain("resourceId");
    expect(up).toContain("versionId");
    expect(up).toContain("attachment_identity = ANY(attachment_identities)");
    expect(up).not.toMatch(/physical_object_key|base64|image_data/iu);
  });

  it("回退先删除约束与列，再删除校验函数", async () => {
    const down = await migration("down");
    expect(down.indexOf("DROP COLUMN input_attachments")).toBeLessThan(
      down.indexOf("DROP FUNCTION runtime_valid_user_input_attachments"),
    );
  });
});
