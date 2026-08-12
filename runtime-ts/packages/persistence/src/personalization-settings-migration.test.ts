import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("个性化设置迁移", () => {
  it("个人设置按用户隔离，团队设置按成员读取和管理员修改", async () => {
    const [sql, bootstrap] = await Promise.all([
      readFile(
        new URL("../migrations/0046_personalization_settings.up.sql", import.meta.url),
        "utf8",
      ),
      readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8"),
    ]);
    expect(sql).toContain("CREATE TABLE user_personalization_settings");
    expect(sql).toContain("CREATE TABLE team_personalization_settings");
    expect(sql).toContain("user_personalization_self_policy");
    expect(sql).toContain("team_personalization_read_policy");
    expect(sql).toContain("team_personalization_manage_policy");
    expect(sql).toContain("actor.role IN ('owner','admin')");
    expect(sql).toContain("character_length(content) <= 2000");
    expect(sql).toContain("octet_length(content) <= 8192");
    expect(bootstrap).toContain('["team_personalization_settings", new Set(["SELECT"])]');
    expect(bootstrap).toContain(
      'policy.set("team_personalization_settings", new Set(["SELECT", "INSERT"]))',
    );
    expect(bootstrap).toContain(
      'new Set(["content", "version", "updated_by_user_id", "updated_at"])',
    );
  });

  it("存在个性化事实时拒绝破坏性回滚", async () => {
    const sql = await readFile(
      new URL("../migrations/0046_personalization_settings.down.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("个性化设置非空，拒绝破坏性回滚");
  });
});
