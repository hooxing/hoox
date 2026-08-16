import { resourceId, resourceVersionId, tenantId } from "@aisay/domain";
import type { BlobStore } from "@aisay/persistence";
import type { ResourceFilesystemCatalog, ResourceFilesystemFile } from "@aisay/resource";
import { describe, expect, it, vi } from "vitest";
import { BlobPromptImageLoader } from "./prompt-image-loader.js";

const tenant = tenantId("tenant-image-test");

function file(input: {
  resource: string;
  version: string;
  mediaType: string;
  size: number;
}): ResourceFilesystemFile {
  const resource = resourceId(input.resource);
  const version = resourceVersionId(input.version);
  return {
    resourceId: resource,
    versionId: version,
    name: `${input.resource}.bin`,
    path: `/resources/${resource}/${version}/${input.resource}.bin`,
    mediaType: input.mediaType,
    sizeBytes: input.size,
    object: {
      tenantId: tenant,
      purpose: "resource",
      sha256: "a".repeat(64),
      size: input.size,
      mediaType: input.mediaType,
      incarnationId: "11111111-1111-4111-8111-111111111111",
      physicalObjectKey: `objects/${input.resource}`,
    },
  };
}

describe("BlobPromptImageLoader", () => {
  it("只读取当前 user turn 的图片并按附件顺序生成 Pi ImageContent", async () => {
    const image = file({
      resource: "resource-image",
      version: "version-image",
      mediaType: "image/png",
      size: 3,
    });
    const document = file({
      resource: "resource-pdf",
      version: "version-pdf",
      mediaType: "application/pdf",
      size: 100,
    });
    const catalog: ResourceFilesystemCatalog = {
      list: vi.fn(),
      resolve: vi.fn(async ({ resourceId: requested }) =>
        requested === image.resourceId ? image : document,
      ),
    };
    const getBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const loader = new BlobPromptImageLoader(catalog, { getBytes } as unknown as BlobStore);

    await expect(
      loader.load({
        tenantId: tenant,
        attachments: [
          { resourceId: image.resourceId, versionId: image.versionId },
          { resourceId: document.resourceId, versionId: document.versionId },
        ],
      }),
    ).resolves.toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    expect(getBytes).toHaveBeenCalledOnce();
  });

  it("在读取 Blob 前拒绝超过当前轮总上限的视觉输入", async () => {
    const image = file({
      resource: "resource-large-image",
      version: "version-large-image",
      mediaType: "image/webp",
      size: 4,
    });
    const catalog: ResourceFilesystemCatalog = {
      list: vi.fn(),
      resolve: vi.fn(async () => image),
    };
    const getBytes = vi.fn();
    const loader = new BlobPromptImageLoader(catalog, { getBytes } as unknown as BlobStore, 3);

    await expect(
      loader.load({
        tenantId: tenant,
        attachments: [{ resourceId: image.resourceId, versionId: image.versionId }],
      }),
    ).rejects.toThrow("图片总大小超过视觉输入上限");
    expect(getBytes).not.toHaveBeenCalled();
  });
});
