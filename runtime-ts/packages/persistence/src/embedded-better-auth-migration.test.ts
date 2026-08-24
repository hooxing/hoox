import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");
}

const up = migration("0053_embedded_better_auth.up.sql");
const down = migration("0053_embedded_better_auth.down.sql");
const roleBootstrap = readFileSync(
  fileURLToPath(new URL("./role-bootstrap.ts", import.meta.url)),
  "utf8",
);

describe("0053 内嵌 Better Auth 迁移", () => {
  it("固定 Better Auth 表、RLS 和账号映射候选，不引入独立身份服务", () => {
    for (const table of [
      "better_auth_users",
      "better_auth_sessions",
      "better_auth_accounts",
      "better_auth_verifications",
      "better_auth_rate_limits",
    ]) {
      expect(up).toContain(`CREATE TABLE ${table}`);
      expect(up).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(up).toContain("better_auth_user_id text UNIQUE");
    expect(up).toContain("app.auth_better_auth_user_id");
    expect(up).toContain("user_accounts_password_shape");
  });

  it("后台配置只保存加密秘密、版本、幂等命令和审计事实", () => {
    expect(up).toContain("CREATE TABLE identity_auth_configuration");
    expect(up).toContain("secrets_ciphertext bytea");
    expect(up).toContain("secrets_nonce bytea");
    expect(up).toContain("secrets_tag bytea");
    expect(up).toContain("CREATE TABLE identity_auth_commands");
    expect(up).toContain("CREATE TABLE identity_auth_audits");
    expect(up).not.toMatch(/client_secret\s+text/iu);
    expect(up).not.toMatch(/sms_webhook_secret\s+text/iu);
  });

  it("Runtime 与 Admin Control 权限按身份边界收敛，禁用用户可删除两类会话", () => {
    expect(roleBootstrap).toContain("GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE");
    expect(roleBootstrap).toMatch(
      /GRANT SELECT,INSERT,UPDATE ON TABLE \$\{schema\}\.identity_auth_configuration/u,
    );
    expect(roleBootstrap).toMatch(
      /GRANT DELETE ON TABLE \$\{schema\}\.better_auth_sessions TO \$\{control\}/u,
    );
    expect(roleBootstrap).toContain(
      'new Set(["better_auth_user_id", "display_name", "updated_at"])',
    );
    expect(up).toContain("better_auth_sessions_control_delete_policy");
  });

  it("存在身份、映射、配置、命令或审计事实时拒绝破坏性回退", () => {
    expect(down).toContain("Better Auth 已存在身份或配置数据，禁止破坏性回退");
    expect(down).toContain("better_auth_user_id IS NOT NULL");
    expect(down).toContain("CREATE POLICY user_accounts_authentication_policy");
  });
});
