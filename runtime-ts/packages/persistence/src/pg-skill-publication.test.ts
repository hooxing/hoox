import { createHash } from "node:crypto";
import { userId } from "@hoox/domain";
import type { SkillPublicationRole, SkillPublicationStatus } from "@hoox/skill";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
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
    if (sql.includes("FROM skill_publication_submissions")) {
      if (values?.[0] === "submission_missing") return { rows: [], rowCount: 0 };
      if (this.submissionStatus !== undefined) {
        return {
          rows: [
            {
              submission_id: "submission_rejected",
              canonical_key: "rejected.skill",
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

function directPublicationFixture(
  status: SkillPublicationStatus,
  role: SkillPublicationRole = "admin",
  currentPublished?: Readonly<{ submissionId: string; versionToken: number }>,
) {
  const body = new TextEncoder().encode("# Skill\n");
  const digest = createHash("sha256").update(body).digest("hex");
  const row = {
    submission_id: "submission_direct",
    canonical_key: "direct-skill",
    display_name: "直接发布",
    publisher: "Hoox",
    skill_version: "upload-123",
    description: "直接发布测试",
    compatibility: "Agent Skills 标准格式",
    source_url: "",
    source_revision: "",
    license_spdx: "MIT",
    status,
    security_status: "restricted",
    package_digest: digest,
    entrypoint_digest: digest,
    package_blob_ref: "package/test",
    file_count: 1,
    total_bytes: String(body.length),
    version_token: "0",
    created_by: "user_admin",
    reviewed_by: status === "approved" ? "user_reviewer" : null,
    rejection_reason: null,
    published_skill_id: null as string | null,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
  };
  const audits: unknown[][] = [];
  const commandRows = new Map<string, object>();
  const statements: string[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (sql.includes("FROM platform_skill_operators")) return { rows: [{ role }], rowCount: 1 };
      if (sql.includes("FROM skills skill"))
        return {
          rows:
            currentPublished === undefined
              ? []
              : [
                  {
                    canonical_key: row.canonical_key,
                    submission_id: currentPublished.submissionId,
                    version_token: String(currentPublished.versionToken),
                  },
                ],
          rowCount: currentPublished === undefined ? 0 : 1,
        };
      if (sql.includes("FROM skill_publication_commands")) {
        const existing = commandRows.get(String(values[1]));
        return {
          rows: existing === undefined ? [] : [existing],
          rowCount: existing === undefined ? 0 : 1,
        };
      }
      if (sql.includes("FROM skill_publication_submissions"))
        return { rows: [{ ...row }], rowCount: 1 };
      if (sql.includes("FROM skill_publication_files"))
        return {
          rows: [
            {
              submission_id: row.submission_id,
              normalized_path: "SKILL.md",
              media_type: "text/markdown",
              size_bytes: String(body.length),
              content_digest: digest,
              blob_ref: "body/test",
            },
          ],
          rowCount: 1,
        };
      if (sql.includes("UPDATE skill_publication_submissions")) {
        row.status = values[3] as SkillPublicationStatus;
        row.version_token = String(Number(row.version_token) + 1);
        row.published_skill_id = values[6] as string;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO skill_publication_commands"))
        commandRows.set(String(values[1]), {
          operation: values[2],
          request_digest: values[3],
          submission_id: values[4],
          result_version_token: String(values[5]),
        });
      if (sql.includes("INSERT INTO skill_publication_audits")) audits.push(values);
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const objects: StableSkillPublicationObjectStore = {
    ...unusedObjects,
    async read() {
      return body;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;
  return { repository: new PgSkillPublicationRepository(pool, objects), audits, statements };
}

describe("PostgreSQL 管理 Skill 发布持久化", () => {
  it("最新上传列表和详情都保留目录当前生效包的下架引用", async () => {
    const currentPublished = { submissionId: "submission_active", versionToken: 5 };
    const { repository } = directPublicationFixture("draft", "admin", currentPublished);
    await expect(
      repository.list({ actorUserId: userId("user_admin"), limit: 1, latestOnly: true }),
    ).resolves.toMatchObject({ items: [{ status: "draft", currentPublished }] });
    await expect(
      repository.get({ actorUserId: userId("user_admin"), submissionId: "submission_direct" }),
    ).resolves.toMatchObject({ status: "draft", currentPublished });
  });
  it.each(["draft", "submitted", "approved"] as const)(
    "%s 直接发布仅记录发布审计，重试不会重复写入",
    async (status) => {
      const { repository, audits } = directPublicationFixture(status);
      const request = {
        actorUserId: userId("user_admin"),
        submissionId: "submission_direct",
        expectedVersionToken: 0,
        recommended: true,
        idempotencyKey: "skill-direct-publish-0001",
        requestDigest: "a".repeat(64),
      };
      await expect(repository.publish(request)).resolves.toMatchObject({
        outcome: "updated",
        submission: { status: "published", versionToken: 1 },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.slice(3, 7)).toEqual(["publish", status, "published", null]);
      await expect(repository.publish(request)).resolves.toMatchObject({
        outcome: "replayed",
        submission: { versionToken: 1 },
      });
      expect(audits).toHaveLength(1);
      await expect(
        repository.publish({ ...request, requestDigest: "b".repeat(64) }),
      ).resolves.toEqual({ outcome: "state_conflict" });
      await expect(
        repository.publish({ ...request, idempotencyKey: "skill-direct-stale-0001" }),
      ).resolves.toEqual({ outcome: "version_conflict" });
    },
  );

  it.each(["rejected", "revoked", "published"] as const)(
    "%s 不能直接发布或复活",
    async (status) => {
      const { repository, statements } = directPublicationFixture(status);
      await expect(
        repository.publish({
          actorUserId: userId("user_admin"),
          submissionId: "submission_direct",
          expectedVersionToken: 0,
          recommended: true,
          idempotencyKey: "skill-direct-rejected-0001",
          requestDigest: "a".repeat(64),
        }),
      ).resolves.toEqual({ outcome: "state_conflict" });
      expect(statements.some((sql) => sql.includes("INSERT INTO skill_versions"))).toBe(false);
    },
  );

  it("绕过领域层调用发布也拒绝普通审核者", async () => {
    const { repository, statements } = directPublicationFixture("draft", "reviewer");
    await expect(
      repository.publish({
        actorUserId: userId("user_admin"),
        submissionId: "submission_direct",
        expectedVersionToken: 0,
        recommended: true,
        idempotencyKey: "skill-direct-forbidden-0001",
        requestDigest: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(statements.some((sql) => sql.includes("INSERT INTO skill_versions"))).toBe(false);
  });
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
    const submissionIndex = client.statements.findIndex((sql) =>
      sql.includes("FROM skill_publication_submissions"),
    );
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
