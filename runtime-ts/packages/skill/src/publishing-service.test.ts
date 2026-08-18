import { isoTimestamp, userId, type UserId } from "@hoox/domain";
import { describe, expect, it } from "vitest";
import type {
  SkillPublicationAuthorizationPort,
  SkillPublicationCommandResult,
  SkillPublicationPort,
  SkillPublicationRole,
  SkillPublicationSubmission,
} from "./publishing-contracts.js";
import { SkillPublicationService } from "./publishing-service.js";

const publisher = userId("user_publisher");
const reviewer = userId("user_reviewer");
const administrator = userId("user_administrator");

const submission: SkillPublicationSubmission = Object.freeze({
  submissionId: "submission_test",
  canonicalKey: "code-review",
  displayName: "代码审阅",
  publisher: "Cube",
  version: "1.2.3",
  description: "按照团队检查清单审阅代码变更",
  compatibility: "runtime >= 1",
  sourceUrl: "https://example.invalid/skills/code-review",
  sourceRevision: "commit-123",
  licenseSpdx: "Apache-2.0",
  status: "draft",
  securityStatus: "restricted",
  packageDigest: "a".repeat(64),
  entrypointDigest: "b".repeat(64),
  entrypointMarkdown: "# Review\n",
  fileCount: 1,
  totalBytes: 9,
  versionToken: 0,
  createdBy: publisher,
  files: [
    {
      path: "SKILL.md",
      mediaType: "text/markdown",
      sizeBytes: 9,
      contentDigest: "b".repeat(64),
    },
  ],
  createdAt: isoTimestamp("2099-08-05T00:00:00.000Z"),
  updatedAt: isoTimestamp("2099-08-05T00:00:00.000Z"),
});

class FakeAuthorization implements SkillPublicationAuthorizationPort {
  readonly roles = new Map<UserId, SkillPublicationRole>([
    [publisher, "publisher"],
    [reviewer, "reviewer"],
    [administrator, "admin"],
  ]);

  async resolveRole(userId: UserId) {
    return this.roles.get(userId);
  }
}

class FakePort implements SkillPublicationPort {
  current = submission;
  lastCreate: Parameters<SkillPublicationPort["create"]>[0] | undefined;
  lastCommand: Parameters<SkillPublicationPort["submit"]>[0] | undefined;

  async list() {
    return { items: [this.current] };
  }

  async get() {
    return this.current;
  }

  async create(input: Parameters<SkillPublicationPort["create"]>[0]) {
    this.lastCreate = input;
    return { outcome: "created" as const, submission: this.current };
  }

  async submit(input: Parameters<SkillPublicationPort["submit"]>[0]) {
    this.lastCommand = input;
    return this.updated();
  }

  async review(input: Parameters<SkillPublicationPort["review"]>[0]) {
    this.lastCommand = input;
    return this.updated();
  }

  async publish(input: Parameters<SkillPublicationPort["publish"]>[0]) {
    this.lastCommand = input;
    return this.updated();
  }

  async revoke(input: Parameters<SkillPublicationPort["revoke"]>[0]) {
    this.lastCommand = input;
    return this.updated();
  }

  private updated(): SkillPublicationCommandResult {
    return { outcome: "updated", submission: this.current };
  }
}

describe("管理员 Skill 发布领域服务", () => {
  it("只有发布者或管理员可以创建，并把规范包摘要绑定到幂等请求", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    await service.create({
      userId: publisher,
      submissionId: "submission_test",
      metadata: {
        canonicalKey: "code-review",
        displayName: "代码审阅",
        publisher: "Cube",
        version: "1.2.3",
        description: "代码审阅工作流",
        compatibility: "runtime >= 1",
        sourceUrl: "https://example.invalid/repo",
        sourceRevision: "commit-123",
        licenseSpdx: "Apache-2.0",
      },
      files: [
        {
          path: "SKILL.md",
          mediaType: "text/markdown",
          contentBase64: Buffer.from("# Review\n").toString("base64"),
        },
      ],
      idempotencyKey: "skill-publish-create-0001",
    });
    expect(port.lastCreate?.package.packageDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(port.lastCreate?.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    const firstRequestDigest = port.lastCreate?.requestDigest;
    await service.create({
      userId: publisher,
      submissionId: "submission_retry_generated_id",
      metadata: port.lastCreate?.package.metadata ?? ({} as never),
      files: [
        {
          path: "SKILL.md",
          mediaType: "text/markdown",
          contentBase64: Buffer.from("# Review\n").toString("base64"),
        },
      ],
      idempotencyKey: "skill-publish-create-0001",
    });
    expect(port.lastCreate?.requestDigest).toBe(firstRequestDigest);

    await expect(
      service.create({
        userId: reviewer,
        submissionId: "submission_forbidden",
        metadata: port.lastCreate?.package.metadata ?? ({} as never),
        files: [],
        idempotencyKey: "skill-publish-create-0002",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("普通审核者不能审核自己的申请，管理员可以完成紧急审核", async () => {
    const authorization = new FakeAuthorization();
    authorization.roles.set(publisher, "reviewer");
    const service = new SkillPublicationService(authorization, new FakePort());
    await expect(
      service.review({
        userId: publisher,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        decision: "approve",
        idempotencyKey: "skill-publish-review-0001",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      service.review({
        userId: administrator,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        decision: "approve",
        idempotencyKey: "skill-publish-review-0002",
      }),
    ).resolves.toMatchObject({ submissionId: submission.submissionId });
  });

  it("驳回与撤销必须填写原因，发布和撤销仅允许管理员", async () => {
    const service = new SkillPublicationService(new FakeAuthorization(), new FakePort());
    await expect(
      service.review({
        userId: reviewer,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        decision: "reject",
        idempotencyKey: "skill-publish-review-0003",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      service.publish({
        userId: publisher,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        recommended: true,
        idempotencyKey: "skill-publish-release-0001",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.revoke({
        userId: administrator,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        reason: "",
        idempotencyKey: "skill-publish-revoke-0001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("动作摘要绑定审核原因和推荐版本选择", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    await service.review({
      userId: reviewer,
      submissionId: submission.submissionId,
      expectedVersionToken: 0,
      decision: "reject",
      reason: "缺少来源证明",
      idempotencyKey: "skill-publish-review-0004",
    });
    const reviewDigest = port.lastCommand?.requestDigest;
    await service.publish({
      userId: administrator,
      submissionId: submission.submissionId,
      expectedVersionToken: 0,
      recommended: true,
      idempotencyKey: "skill-publish-release-0002",
    });
    expect(port.lastCommand?.requestDigest).not.toBe(reviewDigest);
  });
});
