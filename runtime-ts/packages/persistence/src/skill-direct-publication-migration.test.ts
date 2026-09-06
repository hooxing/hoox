import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0060_skill_direct_publication.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("Skill 管理员直接发布迁移", () => {
  it("允许发布时没有审核者，并保留历史批准与驳回证据约束", () => {
    const sql = migration("up");
    expect(sql).toContain("status IN ('published','revoked') AND rejection_reason IS NULL");
    expect(sql).toContain("status='approved' AND reviewed_by IS NOT NULL");
    expect(sql).toContain(
      "status='rejected' AND reviewed_by IS NOT NULL AND rejection_reason IS NOT NULL",
    );
    expect(sql).not.toContain("UPDATE skill_publication_submissions");
  });

  it("存在直接发布事实时拒绝通过伪造审核者恢复旧约束", () => {
    const sql = migration("down");
    expect(sql).toContain("status IN ('published','revoked') AND reviewed_by IS NULL");
    expect(sql).toContain("无法无损恢复旧审核约束");
  });
});
