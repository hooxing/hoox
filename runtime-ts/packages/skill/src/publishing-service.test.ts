import { isoTimestamp, type UserId, userId } from "@hoox/domain";
import { describe, expect, it } from "vitest";
import type {
  SkillPublicationAuthorizationPort,
  SkillPublicationCommandResult,
  SkillPublicationCreateResult,
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
  canonicalKey: "team.code-review",
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
  readonly namespaces = new Map<UserId, Set<string>>([[publisher, new Set(["team"])]]);

  async resolveRole(userId: UserId) {
    return this.roles.get(userId);
  }

  async hasNamespaceAccess(userId: UserId, namespace: string) {
    return this.namespaces.get(userId)?.has(namespace) ?? false;
  }

  async listAccessibleNamespaces(userId: UserId) {
    return [...(this.namespaces.get(userId) ?? [])];
  }
}

class FakePort implements SkillPublicationPort {
  current = submission;
  createResult: SkillPublicationCreateResult | undefined;
  lastCreate: Parameters<SkillPublicationPort["create"]>[0] | undefined;
  lastCommand: Parameters<SkillPublicationPort["submit"]>[0] | undefined;
  lastList: Parameters<SkillPublicationPort["list"]>[0] | undefined;

  async listNamespaces() {
    return [];
  }
  async createNamespace() {}
  async grantNamespace() {}
  async revokeNamespace() {}

  async list(input: Parameters<SkillPublicationPort["list"]>[0]) {
    this.lastList = input;
    return { items: [this.current] };
  }

  async get() {
    return this.current;
  }

  async create(
    input: Parameters<SkillPublicationPort["create"]>[0],
  ): Promise<SkillPublicationCreateResult> {
    this.lastCreate = input;
    return this.createResult ?? { outcome: "created", submission: this.current };
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
  it("当前技能列表把按规范键聚合模式与游标传给持久化，旧调用仍保持完整历史", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    await service.list({
      userId: administrator,
      latestOnly: true,
      limit: 2,
      cursor: "submission_cursor",
    });
    expect(port.lastList).toEqual({
      actorUserId: administrator,
      latestOnly: true,
      limit: 2,
      afterSubmissionId: "submission_cursor",
    });
    await service.list({ userId: administrator });
    expect(port.lastList).not.toHaveProperty("latestOnly");
  });
  it("只有发布者或管理员可以创建，并把规范包摘要绑定到幂等请求", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    await service.create({
      userId: publisher,
      submissionId: "submission_test",
      metadata: {
        canonicalKey: "team.code-review",
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

  it("授权撤销和他命名空间请求统一失败，包校验仍在持久化前执行", async () => {
    const authorization = new FakeAuthorization();
    const port = new FakePort();
    const service = new SkillPublicationService(authorization, port);
    authorization.namespaces.set(publisher, new Set());
    await expect(
      service.create({
        userId: publisher,
        submissionId: "submission_other_namespace",
        metadata: {
          canonicalKey: "other.code-review",
          displayName: "其他命名空间 Skill",
          publisher: "Cube",
          description: "权限测试",
          compatibility: "runtime >= 1",
          sourceUrl: "https://example.invalid/repo",
          sourceRevision: "commit-123",
          licenseSpdx: "MIT",
        },
        files: [],
        idempotencyKey: "skill-publish-other-space-01",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(port.lastCreate).toBeUndefined();
    await expect(
      service.publish({
        userId: publisher,
        submissionId: submission.submissionId,
        expectedVersionToken: 0,
        recommended: true,
        idempotencyKey: "skill-publish-revoked-space-01",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(port.lastCommand).toBeUndefined();
  });

  it("持久化提交前发现命名空间授权已撤销时隐藏发布冲突", async () => {
    const port = new FakePort();
    port.createResult = { outcome: "not_found" };
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    await expect(
      service.create({
        userId: publisher,
        submissionId: "submission_revoked_during_create",
        metadata: {
          canonicalKey: "team.revoked-skill",
          displayName: "撤权竞态技能",
          publisher: "Cube",
          description: "验证撤权后的统一隐藏语义",
          compatibility: "runtime >= 1",
          sourceUrl: "https://example.invalid/repo",
          sourceRevision: "commit-123",
          licenseSpdx: "MIT",
        },
        files: [
          {
            path: "SKILL.md",
            mediaType: "text/markdown",
            contentBase64: Buffer.from("# Revoked\n").toString("base64"),
          },
        ],
        idempotencyKey: "skill-publish-revoked-create-01",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("不接受缺少入口文件的包，即使操作者是管理员", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    await expect(
      service.create({
        userId: administrator,
        submissionId: "submission_invalid_package",
        metadata: {
          canonicalKey: "legacy-skill",
          displayName: "无效包",
          publisher: "Cube",
          description: "缺少技能入口",
          compatibility: "runtime >= 1",
          sourceUrl: "https://example.invalid/repo",
          sourceRevision: "commit-123",
          licenseSpdx: "MIT",
        },
        files: [],
        idempotencyKey: "skill-invalid-package-0001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(port.lastCreate).toBeUndefined();
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

  it("审核仍受管理员角色限制，发布者可以发布已授权命名空间", async () => {
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
    ).resolves.toMatchObject({ submissionId: submission.submissionId });
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

  it("自动版本对幂等重试保持稳定，重新上传生成新的内部版本", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    const { version: _version, ...metadata } = submission;
    const request = {
      userId: administrator,
      submissionId: "submission_auto_first",
      metadata,
      files: [
        {
          path: "SKILL.md",
          mediaType: "text/markdown",
          contentBase64: Buffer.from("# Review\n").toString("base64"),
        },
      ],
      idempotencyKey: "skill-auto-version-0001",
    };
    await service.create(request);
    const first = port.lastCreate;
    expect(first?.package.metadata.version).toMatch(/^upload-[0-9a-f]{32}$/u);
    await service.create({ ...request, submissionId: "submission_auto_retry" });
    expect(port.lastCreate?.package.metadata.version).toBe(first?.package.metadata.version);
    expect(port.lastCreate?.requestDigest).toBe(first?.requestDigest);
    await service.create({ ...request, idempotencyKey: "skill-auto-version-0002" });
    expect(port.lastCreate?.package.metadata.version).not.toBe(first?.package.metadata.version);
  });

  it("发布者可撤回授权命名空间版本，管理员下架不要求原因", async () => {
    const port = new FakePort();
    const service = new SkillPublicationService(new FakeAuthorization(), port);
    const request = {
      userId: administrator,
      submissionId: submission.submissionId,
      expectedVersionToken: 0,
      idempotencyKey: "skill-revoke-no-reason-0001",
    };
    await expect(service.revoke(request)).resolves.toMatchObject({
      submissionId: submission.submissionId,
    });
    expect(port.lastCommand).not.toHaveProperty("reason");
    await expect(service.revoke({ ...request, userId: publisher })).resolves.toMatchObject({
      submissionId: submission.submissionId,
    });
    port.revoke = async () => ({ outcome: "version_conflict" });
    await expect(service.revoke(request)).rejects.toMatchObject({ code: "CONFLICT" });
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
