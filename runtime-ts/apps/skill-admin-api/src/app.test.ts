import type { AuthContextResolver } from "@aisay/api";
import { isoTimestamp, userId, type UserId } from "@aisay/domain";
import {
  SkillPublicationService,
  type SkillPublicationAuthorizationPort,
  type SkillPublicationCommandResult,
  type SkillPublicationPort,
  type SkillPublicationRole,
  type SkillPublicationStatus,
  type SkillPublicationSubmission,
} from "@aisay/skill";
import { describe, expect, it } from "vitest";
import { createSkillAdminApiApp } from "./app.js";

const publisher = userId("user_publisher");
const reviewer = userId("user_reviewer");
const administrator = userId("user_administrator");

class FakeAuthorization implements SkillPublicationAuthorizationPort {
  readonly roles = new Map<UserId, SkillPublicationRole>([
    [publisher, "publisher"],
    [reviewer, "reviewer"],
    [administrator, "admin"],
  ]);

  async resolveRole(user: UserId) {
    return this.roles.get(user);
  }
}

class FakePublicationPort implements SkillPublicationPort {
  current: SkillPublicationSubmission | undefined;

  async list() {
    return { items: this.current === undefined ? [] : [this.current] };
  }

  async get() {
    return this.current;
  }

  async create(input: Parameters<SkillPublicationPort["create"]>[0]) {
    const timestamp = isoTimestamp("2099-08-05T00:00:00.000Z");
    this.current = Object.freeze({
      submissionId: input.submissionId,
      ...input.package.metadata,
      status: "draft" as const,
      securityStatus: "restricted" as const,
      packageDigest: input.package.packageDigest,
      entrypointDigest: input.package.entrypointDigest,
      entrypointMarkdown: input.package.entrypointMarkdown,
      fileCount: input.package.files.length,
      totalBytes: input.package.totalBytes,
      versionToken: 0,
      createdBy: input.actorUserId,
      files: input.package.files.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        contentDigest: file.contentDigest,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { outcome: "created" as const, submission: this.current };
  }

  async submit(input: Parameters<SkillPublicationPort["submit"]>[0]) {
    return this.move(input, "draft", "submitted");
  }

  async review(input: Parameters<SkillPublicationPort["review"]>[0]) {
    return this.move(input, "submitted", input.decision === "approve" ? "approved" : "rejected", {
      reviewedBy: input.actorUserId,
      ...(input.reason === undefined ? {} : { rejectionReason: input.reason }),
    });
  }

  async publish(input: Parameters<SkillPublicationPort["publish"]>[0]) {
    return this.move(input, "approved", "published");
  }

  async revoke(input: Parameters<SkillPublicationPort["revoke"]>[0]) {
    return this.move(input, "published", "revoked");
  }

  private async move(
    input: Parameters<SkillPublicationPort["submit"]>[0],
    from: SkillPublicationStatus,
    to: SkillPublicationStatus,
    changes: Partial<SkillPublicationSubmission> = {},
  ): Promise<SkillPublicationCommandResult> {
    const current = this.current;
    if (current === undefined) return { outcome: "not_found" };
    if (current.versionToken !== input.expectedVersionToken) {
      return { outcome: "version_conflict" };
    }
    if (current.status !== from) return { outcome: "state_conflict" };
    this.current = Object.freeze({
      ...current,
      ...changes,
      status: to,
      versionToken: current.versionToken + 1,
    });
    return { outcome: "updated", submission: this.current };
  }
}

function fixture() {
  const port = new FakePublicationPort();
  const tokens = new Map([
    ["Bearer publisher", publisher],
    ["Bearer reviewer", reviewer],
    ["Bearer admin", administrator],
  ]);
  const auth: AuthContextResolver = {
    async resolve(input) {
      const resolved = tokens.get(input.authorization ?? "");
      return resolved === undefined ? undefined : { userId: resolved };
    },
  };
  const app = createSkillAdminApiApp({
    auth,
    publications: new SkillPublicationService(new FakeAuthorization(), port),
    readiness: { async probe() {} },
    submissionId: () => "submission_http_test",
    now: () => new Date("2099-08-05T00:00:00.000Z"),
  });
  return { app, port };
}

const createPayload = {
  canonicalKey: "code-review",
  displayName: "代码审阅",
  publisher: "Cube",
  version: "1.2.3",
  description: "按照团队检查清单审阅代码变更",
  compatibility: "runtime >= 1",
  sourceUrl: "https://example.invalid/repo",
  sourceRevision: "commit-123",
  licenseSpdx: "Apache-2.0",
  files: [
    {
      path: "SKILL.md",
      mediaType: "text/markdown; charset=utf-8",
      contentBase64: Buffer.from("# Review\n").toString("base64"),
    },
  ],
};

describe("Skill 管理 API", () => {
  it("对未认证主体隐藏管理能力", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/v1/admin/skill-submissions" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("创建请求只从认证主体取 actor，并返回脱敏发布申请", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "idempotency-key": "skill-admin-create-0001",
      },
      payload: createPayload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      submissionId: "submission_http_test",
      createdBy: publisher,
      status: "draft",
      securityStatus: "restricted",
    });
    expect(response.body).not.toContain("blobRef");
    await app.close();
  });

  it("本地上传由系统补充格式兼容性并允许不声明上游来源", async () => {
    const { app } = fixture();
    const {
      compatibility: _compatibility,
      sourceUrl: _sourceUrl,
      sourceRevision: _sourceRevision,
      ...localPayload
    } = createPayload;
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "idempotency-key": "skill-admin-create-local-0001",
      },
      payload: localPayload,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      compatibility: "Agent Skills 标准格式",
      sourceUrl: "",
      sourceRevision: "",
    });
    await app.close();
  });

  it("完成发布者提交、审核者批准、管理员发布和撤销闭环", async () => {
    const { app } = fixture();
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "idempotency-key": "skill-admin-create-0002",
      },
      payload: createPayload,
    });
    let token = created.json().data.versionToken as number;

    for (const action of [
      { name: "submit", authorization: "Bearer publisher", body: {} },
      { name: "review", authorization: "Bearer reviewer", body: { decision: "approve" } },
      { name: "publish", authorization: "Bearer admin", body: { recommended: true } },
      { name: "revoke", authorization: "Bearer admin", body: { reason: "供应链撤销" } },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/admin/skill-submissions/submission_http_test/${action.name}`,
        headers: {
          authorization: action.authorization,
          "content-type": "application/json",
          "idempotency-key": `skill-admin-${action.name}-0001`,
        },
        payload: { expectedVersionToken: token, ...action.body },
      });
      expect(response.statusCode, response.body).toBe(200);
      token = response.json().data.versionToken as number;
    }
    const detail = await app.inject({
      method: "GET",
      url: "/v1/admin/skill-submissions/submission_http_test",
      headers: { authorization: "Bearer admin" },
    });
    expect(detail.json().data.status).toBe("revoked");
    await app.close();
  });

  it("拒绝畸形包、缺少幂等键和越权创建", async () => {
    const { app } = fixture();
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "idempotency-key": "skill-admin-create-0003",
      },
      payload: {
        ...createPayload,
        files: [{ ...createPayload.files[0], contentBase64: "not-base64" }],
      },
    });
    expect(malformed.statusCode).toBe(400);

    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: { authorization: "Bearer publisher", "content-type": "application/json" },
      payload: createPayload,
    });
    expect(missingKey.statusCode).toBe(400);

    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer reviewer",
        "content-type": "application/json",
        "idempotency-key": "skill-admin-create-0004",
      },
      payload: createPayload,
    });
    expect(forbidden.statusCode).toBe(404);
    await app.close();
  });

  it("拒绝重复幂等头和超限正文，且不返回内部错误", async () => {
    const { app } = fixture();
    const duplicateIdempotency = await app.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "idempotency-key": ["skill-admin-duplicate-0001", "skill-admin-duplicate-0001"],
      },
      payload: createPayload,
    });
    expect(duplicateIdempotency.statusCode).toBe(400);

    const constrained = createSkillAdminApiApp(
      {
        auth: {
          async resolve() {
            return { userId: publisher };
          },
        },
        publications: new SkillPublicationService(
          new FakeAuthorization(),
          new FakePublicationPort(),
        ),
        readiness: { async probe() {} },
      },
      { bodyLimitBytes: 64 },
    );
    const oversized = await constrained.inject({
      method: "POST",
      url: "/v1/admin/skill-submissions",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "idempotency-key": "skill-admin-oversized-0001",
      },
      payload: createPayload,
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.code).toBe("INVALID_REQUEST");

    await constrained.close();
    await app.close();
  });
});
