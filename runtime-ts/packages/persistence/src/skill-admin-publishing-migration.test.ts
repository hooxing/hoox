import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0032_skill_admin_publishing.${direction}.sql`, import.meta.url),
    "utf8",
  );

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("管理员 Skill 发布迁移", () => {
  it("把平台角色、草稿、文件、幂等命令和审计与公开目录隔离", () => {
    const sql = migration("up");
    expect(sql).toContain("CREATE TABLE platform_skill_operators");
    expect(sql).toContain("CREATE TABLE skill_publication_submissions");
    expect(sql).toContain("CREATE TABLE skill_publication_files");
    expect(sql).toContain("CREATE TABLE skill_publication_commands");
    expect(sql).toContain("CREATE TABLE skill_publication_audits");
    expect(sql).toContain("UNIQUE (canonical_key, skill_version)");
    expect(sql).toContain("security_status='restricted'");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(5);
    expect(sql).not.toContain("entrypoint_markdown");
  });

  it("只向迁移时固定的专用角色授予发布权限，普通 Runtime 不进入发布策略", () => {
    const sql = migration("up");
    expect(sql).toContain("current_setting('app.skill_publisher_role')");
    expect(sql).toContain("TO %I");
    expect(sql).toContain("operator.role=''admin''");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA");
    expect(sql).toContain("GRANT UPDATE(status) ON skill_versions");
    expect(sql).not.toMatch(/GRANT[^;]*(tenants|runs|threads)/u);
    expect(sql).not.toContain("DATABASE_RUNTIME_ROLE");
  });

  it("存在发布事实时拒绝破坏性回滚", () => {
    const sql = migration("down");
    expect(sql).toContain("Skill 管理发布事实非空，拒绝破坏性回滚");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON SCHEMA");
    expect(sql).toContain("DROP POLICY IF EXISTS skills_admin_publisher_policy");
  });

  it("迁移入口以事务级配置固定 Publisher 角色并拒绝危险角色边界", () => {
    expect(source("cli.ts")).toContain("DATABASE_SKILL_PUBLISHER_ROLE");
    expect(source("migrations.ts")).toContain(
      "SELECT set_config('app.skill_publisher_role', $1, true)",
    );
    const bootstrap = source("role-bootstrap.ts");
    expect(bootstrap).toContain("skillPublisherRole");
    expect(bootstrap).toContain("publisher_inherits");
    expect(bootstrap).toContain("publisher_has_parent");
    expect(bootstrap).toContain("publisher_owns_relation");
    expect(bootstrap).toContain("Skill Publisher 表权限偏离白名单");
  });
});
