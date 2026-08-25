import {
  appendResourceVersion,
  createResource,
  isoTimestamp,
  resourceId,
  resourceVersionId,
  sha256Digest,
  tenantId,
  userId,
} from "@hoox/domain";
import { describe, expect, it, vi } from "vitest";
import type { ResourceCatalog, TrustedResourceContext } from "./contracts.js";
import {
  appendAttachmentsToLatestUserPrompt,
  attachmentReferencesFromUserPrompt,
  createResourceFilesystemCapabilityCodec,
  historyFilesystemCollisionName,
  historyFilesystemDirectoryName,
  historyFilesystemEntryCollisionName,
  historyFilesystemEntryName,
  historyFilesystemTimestamp,
  ResourceAttachmentResolver,
  resourceFilesystemFileName,
  resourceFilesystemPath,
  stripAttachmentsFromUserFacingPrompt,
} from "./resource-filesystem.js";
import {
  type PersistedResourceUpload,
  type ResourceUploadRepository,
  ResourceUploadService,
} from "./upload.js";

const context: TrustedResourceContext = {
  tenantId: tenantId("tenant-resource-files"),
  userId: userId("user-resource-files"),
};
const now = isoTimestamp("2026-08-01T12:00:00.000Z");

describe("Resource 只读文件系统", () => {
  it("生成稳定安全路径，并把附件事实只追加到最新 user 文本", () => {
    const name = "../设计稿\n?.png";
    const safeName = resourceFilesystemFileName(name);
    expect(safeName).toBe(".._设计稿_?.png");
    const path = resourceFilesystemPath(
      resourceId("resource-path-test"),
      resourceVersionId("version-path-test"),
      name,
    );
    expect(path).toBe(`/resources/resource-path-test/version-path-test/${safeName}`);

    const projected = appendAttachmentsToLatestUserPrompt("分析一下", [
      {
        resourceId: resourceId("resource-path-test"),
        versionId: resourceVersionId("version-path-test"),
        name: "设计稿.png",
        path,
        mediaType: "image/png",
        sizeBytes: 12,
      },
    ]);
    expect(projected).toContain("分析一下\n\n# 用户在本轮提供的文件");
    expect(projected).toContain(JSON.stringify({ 文件名: "设计稿.png", 文件地址: path }));
    expect(stripAttachmentsFromUserFacingPrompt(projected)).toBe("分析一下");
    expect(attachmentReferencesFromUserPrompt(projected)).toEqual([
      {
        resourceId: "resource-path-test",
        versionId: "version-path-test",
      },
    ]);
    expect(
      stripAttachmentsFromUserFacingPrompt(
        '旧请求\n\n# 用户在本轮上传的文件\n- {"文件名":"旧文件.txt"}',
      ),
    ).toBe("旧请求");
    expect(
      attachmentReferencesFromUserPrompt(
        `${projected}\n- 非法 JSON\n- ${JSON.stringify({ 文件地址: "/workspace/not-resource.png" })}`,
      ),
    ).toEqual([{ resourceId: "resource-path-test", versionId: "version-path-test" }]);
  });

  it("历史路径使用面向人的语义名称，重名时才增加序号", () => {
    expect(historyFilesystemTimestamp("2026-08-07T06:32:08.000Z", "Asia/Shanghai")).toBe(
      "2026-08-07_14-32-08",
    );
    expect(historyFilesystemDirectoryName({ title: "../采购/合同\n审查 " })).toBe(
      ".._采购_合同_审查",
    );
    expect(historyFilesystemEntryName({ name: "采购合同.docx" })).toBe("采购合同.docx");
    expect(historyFilesystemCollisionName("合同审查", 2)).toBe("合同审查-2");
    expect(historyFilesystemEntryCollisionName("采购合同.docx", 2)).toBe("采购合同-2.docx");
  });

  it("capability 绑定 tenant、sandbox 和过期时间，篡改或过期即失败", () => {
    let current = 1_000;
    const codec = createResourceFilesystemCapabilityCodec({
      secret: "resource-filesystem-test-signing-key-32-bytes",
      now: () => current,
    });
    const token = codec.issue({
      tenantId: context.tenantId,
      sandboxId: "sandbox-resource-test",
      ttlSeconds: 10,
    });
    expect(codec.verify(token)).toEqual({
      tenantId: context.tenantId,
      sandboxId: "sandbox-resource-test",
      expiresAt: 11_000,
    });
    expect(codec.verify(`${token.slice(0, -1)}x`)).toBeUndefined();
    current = 11_000;
    expect(codec.verify(token)).toBeUndefined();
  });

  it("为 Cube Volume 宿主机挂载签发专用 capability", () => {
    const codec = createResourceFilesystemCapabilityCodec({
      secret: "resource-filesystem-test-signing-key-32-bytes",
      now: () => 1_000,
    });
    const token = codec.issueHostVolume({ tenantId: context.tenantId });

    expect(codec.verify(token)).toEqual({
      kind: "host_volume",
      tenantId: context.tenantId,
    });
    expect(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")).toBe(
      `{"v":2,"tenantId":"${context.tenantId}"}`,
    );
  });

  it("附件解析只接受目录授权成功的不可变版本", async () => {
    const aggregate = uploadedAggregate("授权说明.md", 7);
    const catalog: ResourceCatalog = {
      search: vi.fn(),
      resolveVersion: vi.fn(async (input) =>
        input.resourceId === aggregate.resource.id && input.versionId === aggregate.version.id
          ? { status: "found" as const, ...aggregate }
          : { status: "not_found" as const },
      ),
    };
    const resolver = new ResourceAttachmentResolver(catalog);
    await expect(
      resolver.resolve({
        context,
        attachments: [{ resourceId: aggregate.resource.id, versionId: aggregate.version.id }],
      }),
    ).resolves.toMatchObject([
      {
        name: "授权说明.md",
        path: `/resources/${aggregate.resource.id}/${aggregate.version.id}/授权说明.md`,
      },
    ]);
    await expect(
      resolver.resolve({
        context,
        attachments: [
          {
            resourceId: resourceId("resource-not-visible"),
            versionId: resourceVersionId("version-not-visible"),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Resource 上传服务", () => {
  it("规范化兼容字符后持久化 Blob，并返回统一 /resources 路径", async () => {
    const persisted: PersistedResourceUpload = {
      referenceId: "blob-reference-upload",
      object: {
        tenantId: context.tenantId,
        purpose: "resource",
        sha256: "a".repeat(64),
        size: 3,
        mediaType: "text/plain",
        incarnationId: "11111111-1111-4111-8111-111111111111",
        physicalObjectKey: "resource/upload/object",
      },
    };
    const blobs = {
      persist: vi.fn(async () => persisted),
      abandon: vi.fn(async () => undefined),
    };
    const repository: ResourceUploadRepository = {
      commit: vi.fn(async (input) => {
        const initial = createResource({
          id: input.resourceId,
          tenantId: context.tenantId,
          name: input.name,
          origin: "upload",
          now: input.now,
        });
        const aggregate = appendResourceVersion({
          resource: initial,
          tenantId: context.tenantId,
          versionId: input.versionId,
          expectedLatestVersionNumber: 0,
          objectKey: persisted.object.physicalObjectKey,
          digest: sha256Digest(persisted.object.sha256),
          mediaType: input.mediaType,
          sizeBytes: input.persisted.object.size,
          now: input.now,
        });
        return { outcome: "committed" as const, ...aggregate };
      }),
    };
    const service = new ResourceUploadService(blobs, repository, {
      maxBytes: 8,
      now: () => now,
    });
    const result = await service.upload({
      context,
      idempotencyKey: "upload-test-key-0001",
      name: "说明（简洁）.txt",
      mediaType: "TEXT/PLAIN",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(blobs.persist).toHaveBeenCalledOnce();
    expect(repository.commit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      name: "说明(简洁).txt",
      mediaType: "text/plain",
      sizeBytes: 3,
    });
    expect(result.path).toBe(`/resources/${result.resourceId}/${result.versionId}/说明(简洁).txt`);
  });

  it("拒绝超限文件和幂等键冲突", async () => {
    const persisted: PersistedResourceUpload = {
      referenceId: "blob-reference-conflict",
      object: {
        tenantId: context.tenantId,
        purpose: "resource",
        sha256: "b".repeat(64),
        size: 1,
        mediaType: "text/plain",
        incarnationId: "22222222-2222-4222-8222-222222222222",
        physicalObjectKey: "resource/upload/conflict",
      },
    };
    const service = new ResourceUploadService(
      { persist: async () => persisted },
      { commit: async () => ({ outcome: "key_conflict" }) },
      { maxBytes: 1, now: () => now },
    );
    await expect(
      service.upload({
        context,
        idempotencyKey: "upload-test-key-0002",
        name: "太大.txt",
        mediaType: "text/plain",
        body: new Uint8Array([1, 2]),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    await expect(
      service.upload({
        context,
        idempotencyKey: "upload-test-key-0002",
        name: "冲突.txt",
        mediaType: "text/plain",
        body: new Uint8Array([1]),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "CONFLICT" }));

    const blobConflict = new ResourceUploadService(
      {
        persist: async () => {
          throw new Error("RESOURCE_BLOB_IDEMPOTENCY_CONFLICT");
        },
      },
      { commit: async () => ({ outcome: "blob_unavailable" }) },
      { maxBytes: 1, now: () => now },
    );
    await expect(
      blobConflict.upload({
        context,
        idempotencyKey: "upload-test-key-0003",
        name: "冲突.txt",
        mediaType: "text/plain; charset=utf-8",
        body: new Uint8Array([1]),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("规范名继续拒绝不可见字符与超长名称", async () => {
    const blobs = { persist: vi.fn() };
    const repository = { commit: vi.fn() };
    const service = new ResourceUploadService(blobs, repository, {
      maxBytes: 8,
      now: () => now,
    });

    for (const name of ["　", "坏\u200b名字.txt", "坏\ud800名字.txt", `${"a".repeat(256)}.txt`]) {
      await expect(
        service.upload({
          context,
          idempotencyKey: "upload-test-key-invalid-name",
          name,
          mediaType: "text/plain",
          body: new Uint8Array([1]),
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }
    expect(blobs.persist).not.toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
  });

  it("NFKC 等价名称共享上传请求摘要", async () => {
    const persisted: PersistedResourceUpload = {
      referenceId: "blob-reference-normalized-name",
      object: {
        tenantId: context.tenantId,
        purpose: "resource",
        sha256: "c".repeat(64),
        size: 1,
        mediaType: "application/pdf",
        incarnationId: "33333333-3333-4333-8333-333333333333",
        physicalObjectKey: "resource/upload/normalized-name",
      },
    };
    const repository: ResourceUploadRepository = {
      commit: vi.fn(async () => ({ outcome: "key_conflict" as const })),
    };
    const service = new ResourceUploadService({ persist: async () => persisted }, repository, {
      maxBytes: 8,
      now: () => now,
    });
    const upload = (name: string) =>
      service.upload({
        context,
        idempotencyKey: "upload-test-key-normalized-name",
        name,
        mediaType: "application/pdf",
        body: new Uint8Array([1]),
      });

    await expect(upload("报告（简洁）.pdf")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(upload("报告(简洁).pdf")).rejects.toMatchObject({ code: "CONFLICT" });
    const [first, second] = vi.mocked(repository.commit).mock.calls;
    expect(first?.[0].requestDigest).toBe(second?.[0].requestDigest);
    expect(first?.[0].name).toBe("报告(简洁).pdf");
    expect(second?.[0].name).toBe("报告(简洁).pdf");
  });
});

function uploadedAggregate(name: string, sizeBytes: number) {
  const resource = createResource({
    id: resourceId("resource-resolver-test"),
    tenantId: context.tenantId,
    name,
    origin: "upload",
    now,
  });
  return appendResourceVersion({
    resource,
    tenantId: context.tenantId,
    versionId: resourceVersionId("version-resolver-test"),
    expectedLatestVersionNumber: 0,
    objectKey: "resource/resolver/object",
    digest: sha256Digest("c".repeat(64)),
    mediaType: "text/markdown",
    sizeBytes,
    now,
  });
}
