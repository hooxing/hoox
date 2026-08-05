import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0033_optional_skill_source_metadata.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("Skill 可选来源元数据迁移", () => {
  it("允许空来源但保留长度、空白和控制字符约束", () => {
    const sql = migration("up");
    expect(sql).toContain("octet_length(source_url) BETWEEN 0 AND 2048");
    expect(sql).toContain("octet_length(source_revision) BETWEEN 0 AND 200");
    expect(sql).toContain("source_revision=btrim(source_revision)");
    expect(sql).toContain("source_revision !~ '[[:cntrl:]]'");
  });

  it("存在无来源发布事实时拒绝回滚为必填", () => {
    const sql = migration("down");
    expect(sql).toContain("source_url='' OR source_revision=''");
    expect(sql).toContain("拒绝收紧来源约束");
    expect(sql).toContain("octet_length(source_url) BETWEEN 1 AND 2048");
  });
});
