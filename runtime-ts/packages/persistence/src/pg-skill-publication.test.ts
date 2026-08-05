import { userId } from "@cube-runtime/domain";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  PgSkillPublicationAuthorization,
  PgSkillPublicationRepository,
} from "./pg-skill-publication.js";
import type { StableSkillPublicationObjectStore } from "./skill-publication-object-store.js";

class ScriptedClient {
  readonly statements: string[] = [];
  failCommit = false;
  submissionStatus: "rejected" | undefined;
  releasedWith: unknown;

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push(sql);
    if (sql === "COMMIT" && this.failCommit)
      throw Object.assign(new Error("lost"), { code: "08006" });
    if (sql.includes("set_config('app.user_id'")) {
      expect(values).toEqual(["user_admin"]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM platform_skill_operators")) {
      if (!this.statements.some((statement) => statement.includes("set_config('app.user_id'"))) {
        throw new Error("未先设置 user_id");
      }
      return { rows: [{ role: "admin" }], rowCount: 1 };
    }
    if (sql.includes("FROM skill_publication_commands")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM skill_publication_submissions") && sql.includes("FOR UPDATE")) {
      if (this.submissionStatus !== undefined) {
        return {
          rows: [
            {
              submission_id: "submission_rejected",
              status: this.submissionStatus,
              version_token: "1",
              created_by: "user_admin",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(error?: unknown) {
    this.releasedWith = error;
  }
}

const unusedObjects: StableSkillPublicationObjectStore = {
  async publishPackage() {
    throw new Error("不应写对象");
  },
  async read() {
    throw new Error("不应读对象");
  },
};

describe("PostgreSQL 管理 Skill 发布持久化", () => {
  it("Authorization 在事务级 user_id 上下文中解析当前 operator", async () => {
    const client = new ScriptedClient();
    const authorization = new PgSkillPublicationAuthorization(poolFor(client));
    await expect(authorization.resolveRole(userId("user_admin"))).resolves.toBe("admin");
    expect(client.statements[0]).toContain("BEGIN");
    expect(client.statements[1]).toContain("set_config('app.user_id'");
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it("Repository 即使被直接调用也二次校验角色，并对不存在申请返回 not_found", async () => {
    const client = new ScriptedClient();
    const repository = new PgSkillPublicationRepository(poolFor(client), unusedObjects);
    await expect(
      repository.submit({
        actorUserId: userId("user_admin"),
        submissionId: "submission_missing",
        expectedVersionToken: 0,
        idempotencyKey: "publish-submit-0001",
        requestDigest: "a".repeat(64),
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    const roleIndex = client.statements.findIndex((sql) =>
      sql.includes("platform_skill_operators"),
    );
    const submissionIndex = client.statements.findIndex((sql) => sql.includes("FOR UPDATE"));
    expect(roleIndex).toBeGreaterThan(0);
    expect(submissionIndex).toBeGreaterThan(roleIndex);
  });

  it("COMMIT 响应未知时保守映射为 UNAVAILABLE，要求以同一幂等键重试", async () => {
    const client = new ScriptedClient();
    client.failCommit = true;
    const repository = new PgSkillPublicationRepository(poolFor(client), unusedObjects);
    await expect(
      repository.submit({
        actorUserId: userId("user_admin"),
        submissionId: "submission_missing",
        expectedVersionToken: 0,
        idempotencyKey: "publish-submit-0002",
        requestDigest: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(client.releasedWith).toBeInstanceOf(Error);
  });

  it("驳回申请是不可重新提交的终态", async () => {
    const client = new ScriptedClient();
    client.submissionStatus = "rejected";
    const repository = new PgSkillPublicationRepository(poolFor(client), unusedObjects);
    await expect(
      repository.submit({
        actorUserId: userId("user_admin"),
        submissionId: "submission_rejected",
        expectedVersionToken: 1,
        idempotencyKey: "publish-submit-rejected-0001",
        requestDigest: "c".repeat(64),
      }),
    ).resolves.toEqual({ outcome: "state_conflict" });
  });
});

function poolFor(client: ScriptedClient): Pool {
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}
