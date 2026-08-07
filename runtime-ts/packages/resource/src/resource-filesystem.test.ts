import {
  appendResourceVersion,
  createResource,
  isoTimestamp,
  resourceId,
  resourceVersionId,
  sha256Digest,
  tenantId,
  userId,
} from "@cube-runtime/domain";
import { describe, expect, it, vi } from "vitest";
import type { ResourceCatalog, TrustedResourceContext } from "./contracts.js";
import {
  appendAttachmentsToLatestUserPrompt,
  createResourceFilesystemCapabilityCodec,
  historyFilesystemCollisionName,
  historyFilesystemDirectoryName,
  historyFilesystemEntryName,
  historyFilesystemTimestamp,
  ResourceAttachmentResolver,
  resourceFilesystemFileName,
  resourceFilesystemPath,
  stripAttachmentsFromUserFacingPrompt,
} from "./resource-filesystem.js";
import {
  type PersistedResourceUpload,
  ResourceUploadService,
  type ResourceUploadRepository,
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
    expect(
      stripAttachmentsFromUserFacingPrompt(
        '旧请求\n\n# 用户在本轮上传的文件\n- {"文件名":"旧文件.txt"}',
      ),
    ).toBe("旧请求");
  });

  it("按固化时区生成可排序的语义历史目录与文件名", () => {
    expect(historyFilesystemTimestamp("2026-08-07T06:32:08.000Z", "Asia/Shanghai")).toBe(
      "2026-08-07_14-32-08",
    );
    expect(
      historyFilesystemDirectoryName({
        createdAt: "2026-08-07T06:32:08.000Z",
        title: "../采购/合同\n审查 ",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe("2026-08-07_14-32-08_.._采购_合同_审查");
    expect(
      historyFilesystemEntryName({
        attachedAt: "2026-08-07T06:33:10.000Z",
        name: "采购合同.docx",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe("2026-08-07_14-33-10_采购合同.docx");
    expect(historyFilesystemCollisionName("2026-08-07_14-32-08_合同审查", 2)).toBe(
      "2026-08-07_14-32-08_合同审查-2",
    );
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
  it("先持久化 Blob，再提交不可变首版并返回统一 /resources 路径", async () => {
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
      name: "说明.txt",
      mediaType: "TEXT/PLAIN",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(blobs.persist).toHaveBeenCalledOnce();
    expect(repository.commit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      name: "说明.txt",
      mediaType: "text/plain",
      sizeBytes: 3,
    });
    expect(result.path).toBe(`/resources/${result.resourceId}/${result.versionId}/说明.txt`);
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
