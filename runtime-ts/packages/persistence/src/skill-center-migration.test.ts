import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0029_skill_center_installations.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("Skill Center 安装迁移", () => {
  it("中心内容与用户安装分表，并以当前用户 RLS 隔离全局安装", () => {
    const sql = migration("up");
    expect(sql).toContain("CREATE TABLE skills");
    expect(sql).toContain("CREATE TABLE skill_versions");
    expect(sql).toContain("CREATE TABLE skill_version_files");
    expect(sql).toContain("CREATE TABLE user_skill_installations");
    expect(sql).toContain("user_id = NULLIF(current_setting('app.user_id', true), '')");
    expect(sql).toContain("WHERE status IN ('enabled', 'disabled')");
    expect(sql).toContain("version_token bigint NOT NULL");
    expect(sql).toContain("user_skill_installation_audits");
  });

  it("Runtime 不能发布或修改目录版本，只能维护自己的安装状态", () => {
    const source = readFileSync(new URL("./role-bootstrap.ts", import.meta.url), "utf8");
    expect(source).toContain('["skills", new Set(["SELECT"])]');
    expect(source).toContain('["skill_versions", new Set(["SELECT"])]');
    expect(source).toContain('["user_skill_installations", new Set(["SELECT", "INSERT"])]');
    expect(source).not.toContain('["skills", new Set(["SELECT", "INSERT"])');
  });

  it("存在安装或审计事实时拒绝破坏性回滚", () => {
    expect(migration("down")).toContain("Skill 安装或审计事实非空，拒绝破坏性回滚");
  });
});
