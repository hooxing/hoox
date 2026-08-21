import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PgLocalAccountRepository } from "./pg-local-account.js";

class SessionClient {
  readonly statements: string[] = [];

  async query(
    sql: string,
  ): Promise<{ readonly rows: readonly unknown[]; readonly rowCount: number }> {
    this.statements.push(sql.replace(/\s+/gu, " ").trim());
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

describe("PostgreSQL 本地账号会话", () => {
  it("登录和账号资料读取只接受 active 用户", async () => {
    const client = new SessionClient();
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PgLocalAccountRepository(pool);

    await repository.findByNormalizedEmail("user@example.com");

    expect(client.statements.some((statement) => statement.includes("status='active'"))).toBe(true);
  });

  it("在同一事务中分别发送过期清理与会话插入，避免参数化多命令失败", async () => {
    const client = new SessionClient();
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PgLocalAccountRepository(pool);

    await repository.createSession({
      tokenDigest: "a".repeat(64),
      userId: "user_local",
      personalTenantId: "tenant_local",
      createdAt: "2026-08-16T08:00:00.000Z",
      expiresAt: "2026-09-15T08:00:00.000Z",
    });

    const businessStatements = client.statements.filter(
      (statement) =>
        !statement.startsWith("BEGIN") &&
        statement !== "COMMIT" &&
        !statement.includes("set_config"),
    );
    expect(businessStatements).toEqual([
      "DELETE FROM user_sessions WHERE user_id=$1 AND expires_at <= $2",
      "INSERT INTO user_sessions( token_digest,user_id,personal_tenant_id,created_at,expires_at ) VALUES ($1,$2,$3,$4,$5)",
    ]);
  });
});
