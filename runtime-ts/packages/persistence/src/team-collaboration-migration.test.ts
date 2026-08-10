import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("团队协作迁移", () => {
  it("团队目录按用户枚举，并保留 Tenant 内成员复核", async () => {
    const sql = await readFile(
      new URL("../migrations/0041_team_collaboration.up.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE team_member_directory");
    expect(sql).toContain("team_member_directory_read_policy");
    expect(sql).toContain("team_member_directory_manage_policy");
    expect(sql).toContain("FOR SELECT");
    expect(sql).toContain("user_id=NULLIF(current_setting('app.user_id',true),'')");
    expect(sql).toContain("actor.status='active'");
  });

  it("任务分支独立成新 Thread，并记录来源而不跨租户级联", async () => {
    const sql = await readFile(
      new URL("../migrations/0041_team_collaboration.up.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE thread_forks");
    expect(sql).toContain("fork_kind IN ('branch','team_publish')");
    expect(sql).not.toContain("FOREIGN KEY (source_tenant_id,source_thread_id)");
  });

  it("Skill 安装按 Tenant 隔离，团队不继承个人安装", async () => {
    const sql = await readFile(
      new URL("../migrations/0041_team_collaboration.up.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE tenant_skill_installations");
    expect(sql).toContain("tenant.kind='personal'");
    expect(sql).toContain("actor.role IN ('owner','admin')");
    const bootstrap = await readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8");
    expect(bootstrap).toContain("旧用户级安装表仅保留为回滚数据，不再授予 Runtime");
    expect(bootstrap).toContain("policy.set(table, new Set())");
    expect(bootstrap).toContain('policy.set("user_skill_installations", new Set())');
  });

  it("普通 Runtime 保持 Membership 只读授权列，团队变更只授予独立 Coordinator", async () => {
    const [bootstrap, runtime, processEntry] = await Promise.all([
      readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8"),
      readFile(new URL("./runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../apps/api/src/process-entry.ts", import.meta.url), "utf8"),
    ]);

    expect(bootstrap).toContain("团队目录与 Membership 变更只向独立 Team Coordinator 开放");
    expect(bootstrap).toContain('policy.set("team_member_directory", new Set())');
    expect(bootstrap).toContain('membershipColumns.add("role")');
    expect(bootstrap).toContain('membershipColumns.add("status")');
    expect(bootstrap).toContain(
      'policy.set("team_member_directory", new Set(["role", "status", "updated_at"]))',
    );
    expect(bootstrap).toContain("Team Coordinator 列级 UPDATE 权限偏离白名单");
    expect(runtime).toContain("teamCoordinator?: PostgresPoolOptions");
    expect(runtime).toContain("new PgTeamCollaborationRepository(teamCoordinatorPool)");
    expect(processEntry).toContain("DATABASE_TEAM_COORDINATOR_URL");
    expect(processEntry).toContain("DATABASE_TEAM_COORDINATOR_ROLE");
  });

  it("已有团队、分支或 Skill 事实时拒绝破坏性回滚", async () => {
    const sql = await readFile(
      new URL("../migrations/0041_team_collaboration.down.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("团队协作、分支或 Tenant Skill 事实非空，拒绝破坏性回滚");
  });
});
