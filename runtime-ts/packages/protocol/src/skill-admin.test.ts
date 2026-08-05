import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CreateSkillSubmissionRequestSchema,
  CreateSkillSubmissionSuccessEnvelopeSchema,
  MAX_SKILL_SUBMISSION_CONTENT_BASE64_CHARS,
  MAX_SKILL_SUBMISSION_FILES,
  PublishSkillSubmissionRequestSchema,
  ReviewSkillSubmissionRequestSchema,
  RevokeSkillSubmissionRequestSchema,
  type SkillPlatformRole,
  SkillPlatformRoleSchema,
  type SkillPublicationStatus,
  SkillPublicationStatusSchema,
  SkillSubmissionDtoSchema,
  SkillSubmissionPageDtoSchema,
  SkillSubmissionPageSuccessEnvelopeSchema,
  SkillSubmissionStatusActionRequestSchema,
  SubmitSkillSubmissionRequestSchema,
} from "./skill-admin.js";

const fileRequest = {
  path: "SKILL.md",
  mediaType: "text/markdown; charset=utf-8",
  contentBase64: "IyBUZXN0",
};

const createRequest = {
  canonicalKey: "acme.code-review",
  displayName: "Code Review",
  publisher: "Acme",
  version: "1.2.3-rc_1+build.5",
  description: "Review code changes",
  compatibility: "runtime >= 1",
  sourceUrl: "https://example.test/acme/code-review",
  sourceRevision: "refs/tags/v1.2.3",
  licenseSpdx: "Apache-2.0",
  files: [fileRequest],
};

const submission = {
  submissionId: "sub_123",
  canonicalKey: createRequest.canonicalKey,
  displayName: createRequest.displayName,
  publisher: createRequest.publisher,
  version: createRequest.version,
  description: createRequest.description,
  compatibility: createRequest.compatibility,
  sourceUrl: createRequest.sourceUrl,
  sourceRevision: createRequest.sourceRevision,
  licenseSpdx: createRequest.licenseSpdx,
  status: "submitted",
  securityStatus: "restricted",
  packageDigest: "a".repeat(64),
  entrypointDigest: "b".repeat(64),
  fileCount: 1,
  totalBytes: 6,
  versionToken: 1,
  createdBy: "usr_123",
  reviewedBy: "usr_456",
  rejectionReason: "需要补充来源说明",
  createdAt: "2026-08-05T01:02:03.004Z",
  updatedAt: "2026-08-05T02:03:04Z",
  files: [
    {
      path: "SKILL.md",
      mediaType: "text/markdown; charset=utf-8",
      sizeBytes: 6,
      contentDigest: "b".repeat(64),
    },
  ],
  entrypointMarkdown: "# Test",
};

describe("管理员 Skill 发布协议", () => {
  it("平台角色和发布状态只接受约定字面量", () => {
    expectTypeOf<SkillPlatformRole>().toEqualTypeOf<"publisher" | "reviewer" | "admin">();
    expectTypeOf<SkillPublicationStatus>().toEqualTypeOf<
      "draft" | "submitted" | "approved" | "rejected" | "published" | "revoked"
    >();

    for (const role of ["publisher", "reviewer", "admin"]) {
      expect(Value.Check(SkillPlatformRoleSchema, role)).toBe(true);
    }
    expect(Value.Check(SkillPlatformRoleSchema, "owner")).toBe(false);

    for (const status of ["draft", "submitted", "approved", "rejected", "published", "revoked"]) {
      expect(Value.Check(SkillPublicationStatusSchema, status)).toBe(true);
    }
    expect(Value.Check(SkillPublicationStatusSchema, "active")).toBe(false);
  });

  it("创建请求沿用 Skill key/version 规则，并允许系统补充兼容性与可选来源", () => {
    expect(Value.Check(CreateSkillSubmissionRequestSchema, createRequest)).toBe(true);
    expect(
      Value.Check(CreateSkillSubmissionRequestSchema, { ...createRequest, canonicalKey: "ACME" }),
    ).toBe(false);
    expect(
      Value.Check(CreateSkillSubmissionRequestSchema, { ...createRequest, version: ".1.0" }),
    ).toBe(false);
    const {
      compatibility: _compatibility,
      sourceUrl: _sourceUrl,
      sourceRevision: _sourceRevision,
      ...minimalRequest
    } = createRequest;
    expect(Value.Check(CreateSkillSubmissionRequestSchema, minimalRequest)).toBe(true);
    expect(
      Value.Check(CreateSkillSubmissionRequestSchema, { ...createRequest, unknown: true }),
    ).toBe(false);
    expect(
      Value.Check(CreateSkillSubmissionRequestSchema, {
        ...createRequest,
        files: [{ ...fileRequest, unknown: true }],
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateSkillSubmissionRequestSchema, {
        ...createRequest,
        files: [{ ...fileRequest, path: "../SKILL.md" }],
      }),
    ).toBe(false);
  });

  it("发布申请响应允许来源未声明", () => {
    expect(
      Value.Check(SkillSubmissionDtoSchema, {
        ...submission,
        sourceUrl: "",
        sourceRevision: "",
      }),
    ).toBe(true);
  });

  it("创建请求限制 256 个文件和单项 45 MiB Base64 字符", () => {
    expect(CreateSkillSubmissionRequestSchema.properties.files.maxItems).toBe(
      MAX_SKILL_SUBMISSION_FILES,
    );
    expect(
      CreateSkillSubmissionRequestSchema.properties.files.items.properties.contentBase64.maxLength,
    ).toBe(MAX_SKILL_SUBMISSION_CONTENT_BASE64_CHARS);
    expect(
      Value.Check(CreateSkillSubmissionRequestSchema, {
        ...createRequest,
        files: Array.from({ length: MAX_SKILL_SUBMISSION_FILES + 1 }, () => fileRequest),
      }),
    ).toBe(false);
    expect(Value.Check(CreateSkillSubmissionRequestSchema, { ...createRequest, files: [] })).toBe(
      false,
    );
  });

  it("Submission DTO 固定 restricted 并严格校验摘要、清单和时间", () => {
    expect(Value.Check(SkillSubmissionDtoSchema, submission)).toBe(true);
    expect(
      Value.Check(SkillSubmissionDtoSchema, { ...submission, securityStatus: "verified" }),
    ).toBe(false);
    expect(Value.Check(SkillSubmissionDtoSchema, { ...submission, packageDigest: "SHA256" })).toBe(
      false,
    );
    expect(
      Value.Check(SkillSubmissionDtoSchema, {
        ...submission,
        files: [{ ...submission.files[0], extra: true }],
      }),
    ).toBe(false);
    expect(Value.Check(SkillSubmissionDtoSchema, { ...submission, createdAt: "2026-08-05" })).toBe(
      false,
    );
    expect(Value.Check(SkillSubmissionDtoSchema, { ...submission, reviewedBy: undefined })).toBe(
      true,
    );
  });

  it("列表页和成功信封保持严格 v1 结构", () => {
    const page = { items: [submission], nextCursor: "cursor-1" };
    expect(Value.Check(SkillSubmissionPageDtoSchema, page)).toBe(true);
    expect(Value.Check(SkillSubmissionPageDtoSchema, { ...page, extra: true })).toBe(false);

    const itemEnvelope = { version: "v1", requestId: "req_123", data: submission };
    const pageEnvelope = { version: "v1", requestId: "req_123", data: page };
    expect(Value.Check(CreateSkillSubmissionSuccessEnvelopeSchema, itemEnvelope)).toBe(true);
    expect(Value.Check(SkillSubmissionPageSuccessEnvelopeSchema, pageEnvelope)).toBe(true);
    expect(
      Value.Check(CreateSkillSubmissionSuccessEnvelopeSchema, {
        ...itemEnvelope,
        version: "v2",
      }),
    ).toBe(false);
  });

  it("状态动作携带乐观锁，审核 reason 的条件要求留给领域层", () => {
    expect(Value.Check(SkillSubmissionStatusActionRequestSchema, { expectedVersionToken: 0 })).toBe(
      true,
    );
    expect(Value.Check(SubmitSkillSubmissionRequestSchema, { expectedVersionToken: 0 })).toBe(true);
    expect(
      Value.Check(SubmitSkillSubmissionRequestSchema, {
        expectedVersionToken: 0,
        extra: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewSkillSubmissionRequestSchema, {
        expectedVersionToken: 1,
        decision: "approve",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReviewSkillSubmissionRequestSchema, {
        expectedVersionToken: 1,
        decision: "reject",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReviewSkillSubmissionRequestSchema, {
        expectedVersionToken: 1,
        decision: "reject",
        reason: "安全扫描失败",
      }),
    ).toBe(true);
    expect(
      Value.Check(PublishSkillSubmissionRequestSchema, {
        expectedVersionToken: 2,
        recommended: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(RevokeSkillSubmissionRequestSchema, {
        expectedVersionToken: 3,
        reason: "发现供应链风险",
      }),
    ).toBe(true);
    expect(
      Value.Check(RevokeSkillSubmissionRequestSchema, {
        expectedVersionToken: -1,
        reason: "x",
      }),
    ).toBe(false);
  });
});
