import type { PersistedResourceUpload, ResourceUploadBlobWriter } from "@aisay/resource";
import type {
  DurableResourceBlobWriter,
  PersistResourceBlobResult,
} from "./resource-blob-persistence-adapter.js";

/** 让通用 Resource 上传服务复用现有可恢复 Blob 提交状态机，不暴露 Persistence 私有引用。 */
export class DurableResourceUploadBlobAdapter implements ResourceUploadBlobWriter {
  constructor(private readonly writer: DurableResourceBlobWriter) {}

  async persist(
    input: Parameters<ResourceUploadBlobWriter["persist"]>[0],
  ): Promise<PersistedResourceUpload> {
    return project(await this.writer.persist(input));
  }

  async abandon(input: {
    readonly tenantId: string;
    readonly persisted: PersistedResourceUpload;
  }): Promise<unknown> {
    return this.writer.abandon({
      tenantId: input.tenantId,
      persisted: restore(input.persisted),
    });
  }
}

function project(input: PersistResourceBlobResult): PersistedResourceUpload {
  return Object.freeze({
    referenceId: input.referenceId,
    object: Object.freeze({ ...input.blob }),
  });
}

function restore(input: PersistedResourceUpload): PersistResourceBlobResult {
  return Object.freeze({
    referenceId: input.referenceId,
    blob: Object.freeze({
      kind: "stable" as const,
      ...input.object,
      purpose: "resource" as const,
    }),
  });
}
