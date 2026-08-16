import type { CreateSkillSubmissionRequest, SkillSubmissionDto } from "@aisay/protocol";
import { describe, expect, it, vi } from "vitest";
import { AdminApiError, filesToRequests, resolvePackagePaths, SkillAdminApi } from "./api.js";

const digest = "a".repeat(64);

function submission(status: SkillSubmissionDto["status"] = "draft"): SkillSubmissionDto {
  return {
    submissionId: "submission_1",
    canonicalKey: "code-review",
    displayName: "代码审阅",
    publisher: "Cube",
    version: "1.2.3",
    description: "检查代码变更",
    compatibility: "AISay Runtime >= 1",
    sourceUrl: "https://example.com/code-review",
    sourceRevision: "abc123",
    licenseSpdx: "MIT",
    status,
    securityStatus: "restricted",
    packageDigest: digest,
    entrypointDigest: digest,
    fileCount: 1,
    totalBytes: 4,
    versionToken: 7,
    createdBy: "user_admin",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    files: [
      {
        path: "code-review/SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: 4,
        contentDigest: digest,
      },
    ],
    entrypointMarkdown: "# Skill",
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(data: unknown): unknown {
  return { version: "v1", requestId: "request_1", data };
}

describe("技能发布管理 API", () => {
  it("使用同源默认路径读取列表和详情", async () => {
    const item = submission();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(envelope({ items: [item] })))
      .mockResolvedValueOnce(response(envelope(item)));
    const api = new SkillAdminApi(fetcher);

    await expect(api.listSubmissions()).resolves.toEqual({ items: [item] });
    await expect(api.getSubmission("submission/1")).resolves.toEqual(item);

    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/admin/skill-submissions?limit=100");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/admin/skill-submissions/submission%2F1");
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.has("Idempotency-Key")).toBe(false);
  });

  it("每个写操作生成独立幂等键并携带当前版本令牌", async () => {
    const item = submission();
    const fetcher = vi.fn<typeof fetch>(async () => response(envelope(item)));
    const keys = ["key-create", "key-submit", "key-review", "key-publish", "key-revoke"];
    const createKey = vi.fn(() => keys.shift() ?? "unexpected-key");
    const api = new SkillAdminApi(fetcher, "/v1/admin/skill-submissions", createKey);
    const createInput: CreateSkillSubmissionRequest = {
      canonicalKey: item.canonicalKey,
      displayName: item.displayName,
      publisher: item.publisher,
      version: item.version,
      description: item.description,
      compatibility: item.compatibility,
      sourceUrl: item.sourceUrl,
      sourceRevision: item.sourceRevision,
      licenseSpdx: item.licenseSpdx,
      files: [{ path: "SKILL.md", mediaType: "text/markdown", contentBase64: "Iw==" }],
    };

    await api.createSubmission(createInput);
    await api.submitSubmission(item.submissionId, { expectedVersionToken: 7 });
    await api.reviewSubmission(item.submissionId, {
      expectedVersionToken: 8,
      decision: "reject",
      reason: "缺少安全边界",
    });
    await api.publishSubmission(item.submissionId, {
      expectedVersionToken: 9,
      recommended: true,
    });
    await api.revokeSubmission(item.submissionId, {
      expectedVersionToken: 10,
      reason: "上游撤回",
    });

    expect(createKey).toHaveBeenCalledTimes(5);
    expect(
      fetcher.mock.calls.map((call) => new Headers(call[1]?.headers).get("Idempotency-Key")),
    ).toEqual(["key-create", "key-submit", "key-review", "key-publish", "key-revoke"]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      expectedVersionToken: 7,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      expectedVersionToken: 8,
      decision: "reject",
      reason: "缺少安全边界",
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      expectedVersionToken: 9,
      recommended: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual({
      expectedVersionToken: 10,
      reason: "上游撤回",
    });
  });

  it("网络失败后以相同正文重试时复用原幂等键", async () => {
    const item = submission();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network detail must stay private"))
      .mockResolvedValueOnce(response(envelope(item)));
    const createKey = vi.fn(() => "retry-stable-key");
    const api = new SkillAdminApi(fetcher, "/v1/admin/skill-submissions", createKey);
    const input: CreateSkillSubmissionRequest = {
      canonicalKey: item.canonicalKey,
      displayName: item.displayName,
      publisher: item.publisher,
      version: item.version,
      description: item.description,
      compatibility: item.compatibility,
      sourceUrl: item.sourceUrl,
      sourceRevision: item.sourceRevision,
      licenseSpdx: item.licenseSpdx,
      files: [{ path: "SKILL.md", mediaType: "text/markdown", contentBase64: "Iw==" }],
    };

    await expect(api.createSubmission(input)).rejects.toBeInstanceOf(AdminApiError);
    await expect(api.createSubmission(input)).resolves.toEqual(item);
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.map((call) => new Headers(call[1]?.headers).get("Idempotency-Key")),
    ).toEqual(["retry-stable-key", "retry-stable-key"]);
  });

  it("剥离目录选择器的公共根目录并生成无前缀的规范 Base64", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 255])], "SKILL.md", {
      type: "text/markdown",
    });
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: "my-skill\\SKILL.md",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([0, 1, 2, 255]).buffer,
    });

    await expect(filesToRequests([file])).resolves.toEqual([
      {
        path: "SKILL.md",
        mediaType: "text/markdown",
        contentBase64: "AAEC/w==",
      },
    ]);
    expect(resolvePackagePaths([file])).toEqual(["SKILL.md"]);
  });

  it("不把服务端敏感错误细节传入界面", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(
        {
          error: {
            code: "INTERNAL",
            message: "password=secret; postgres://internal-host/database",
            retryable: true,
          },
        },
        500,
      ),
    );
    const api = new SkillAdminApi(fetcher);

    const error = await api.listSubmissions().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toBe("管理服务暂时不可用，请稍后重试。");
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("internal-host");
  });
});
