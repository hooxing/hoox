import type { BlobStore, StableBlobRef } from "@cube-runtime/persistence";
import type { ResourceFilesystemCatalog } from "@cube-runtime/resource";
import type { PromptImageLoaderPort } from "./pi-session-factory.js";

const DIRECT_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_DIRECT_IMAGE_INPUT_BYTES = 32 * 1024 * 1024;

/**
 * 视觉模型在当前 user turn 开始前直接取得全部图片；非图片附件继续只通过 `/resources` 暴露。
 * 读取发生在模型副作用许可签发前，Base64 只存在于 Worker 内存与随后一次 Provider 请求中。
 */
export class BlobPromptImageLoader implements PromptImageLoaderPort {
  constructor(
    private readonly catalog: ResourceFilesystemCatalog,
    private readonly blobs: BlobStore,
    private readonly maxTotalBytes = MAX_DIRECT_IMAGE_INPUT_BYTES,
  ) {
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
      throw new TypeError("视觉输入总字节上限无效");
    }
  }

  async load(input: Parameters<PromptImageLoaderPort["load"]>[0]) {
    const images: Array<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }> = [];
    let totalBytes = 0;
    for (const attachment of input.attachments) {
      const file = await this.catalog.resolve({
        tenantId: input.tenantId,
        resourceId: attachment.resourceId,
        versionId: attachment.versionId,
      });
      if (file === undefined) throw new Error("当前 user turn 图片已不可读取");
      if (!DIRECT_IMAGE_MEDIA_TYPES.has(file.mediaType)) continue;
      totalBytes += file.sizeBytes;
      if (totalBytes > this.maxTotalBytes)
        throw new Error("当前 user turn 图片总大小超过视觉输入上限");
      const blob: StableBlobRef = {
        kind: "stable",
        tenantId: file.object.tenantId,
        purpose: "resource",
        sha256: file.object.sha256,
        size: file.object.size,
        mediaType: file.object.mediaType,
        incarnationId: file.object.incarnationId,
        physicalObjectKey: file.object.physicalObjectKey,
      };
      const bytes = await this.blobs.getBytes({ tenantId: input.tenantId }, blob);
      if (bytes.byteLength !== file.sizeBytes) throw new Error("当前 user turn 图片字节数不匹配");
      images.push(
        Object.freeze({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: file.mediaType,
        }),
      );
    }
    return Object.freeze(images);
  }
}
