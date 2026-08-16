import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const up = readFileSync(
  fileURLToPath(new URL("../migrations/0048_user_account_authentication.up.sql", import.meta.url)),
  "utf8",
);
const down = readFileSync(
  fileURLToPath(
    new URL("../migrations/0048_user_account_authentication.down.sql", import.meta.url),
  ),
  "utf8",
);
const roleBootstrap = readFileSync(
  fileURLToPath(new URL("./role-bootstrap.ts", import.meta.url)),
  "utf8",
);

describe("0048 本地账号认证迁移", () => {
  it("只持久化密码派生材料和会话摘要，并强制 RLS", () => {
    expect(up).toContain("CREATE TABLE user_accounts");
    expect(up).toContain(
      "password_algorithm text NOT NULL CHECK (password_algorithm = 'scrypt-v1')",
    );
    expect(up).toContain("password_salt bytea");
    expect(up).toContain("password_hash bytea");
    expect(up).not.toMatch(/password_plain|plain_password/iu);
    expect(up).toContain("CREATE TABLE user_sessions");
    expect(up).toContain("token_digest text PRIMARY KEY");
    expect(up).not.toContain("access_token");
    expect(up).toContain("ALTER TABLE user_accounts FORCE ROW LEVEL SECURITY");
    expect(up).toContain("ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY");
    expect(up).toContain("current_setting('app.auth_email', true)");
    expect(up).toContain("current_setting('app.auth_session_digest', true)");
  });

  it("Runtime 获得最小账号权限，Team Coordinator 被显式排除", () => {
    expect(roleBootstrap).toContain('["user_accounts", new Set(["SELECT", "INSERT"])]');
    expect(roleBootstrap).toContain('["user_sessions", new Set(["SELECT", "INSERT", "DELETE"])]');
    expect(roleBootstrap).toContain(
      "for (const table of localAccountTables) policy.set(table, new Set())",
    );
  });

  it("回滚按依赖顺序移除认证状态", () => {
    expect(down.indexOf("DROP TABLE user_sessions")).toBeLessThan(
      down.indexOf("DROP TABLE user_accounts"),
    );
    expect(down).toContain("DROP CONSTRAINT tenants_personal_owner_identity_key");
  });
});
