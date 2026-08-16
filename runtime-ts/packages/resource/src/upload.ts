import { createHash } from "node:crypto";
import {
  type IsoTimestamp,
  type Resource,
  type ResourceId,
  type ResourceVersion,
  type ResourceVersionId,
  resourceId,
  resourceVersionId,
} from "@aisay/domain";
import type { TrustedResourceContext } from "./contracts.js";
import { ResourceServiceError, resourceInvariant } from "./errors.js";
import { assertResourceName } from "./path.js";
import {
  type ResourceAttachment,
  resourceFilesystemPath,
  type ResourceFilesystemStoredObject,
} from "./resource-filesystem.js";

export interface PersistedResourceUpload {
  readonly referenceId: string;
  readonly object: ResourceFilesystemStoredObject;
}

export interface ResourceUploadBlobWriter {
  persist(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly body: Uint8Array;
    readonly sha256: string;
    readonly mediaType: string;
  }): Promise<PersistedResourceUpload>;
  abandon?(input: {
    readonly tenantId: string;
    readonly persisted: PersistedResourceUpload;
  }): Promise<unknown>;
}

export type ResourceUploadCommitResult =
  | {
      readonly outcome: "committed" | "replayed";
      readonly resource: Resource;
      readonly version: ResourceVersion;
    }
  | { readonly outcome: "key_conflict" | "not_authorized" | "blob_unavailable" };

export interface ResourceUploadRepository {
  commit(input: {
    readonly context: TrustedResourceContext;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
    readonly name: string;
    readonly mediaType: string;
    readonly now: IsoTimestamp;
    readonly persisted: PersistedResourceUpload;
  }): Promise<ResourceUploadCommitResult>;
}

export interface ResourceUploadPort {
  upload(input: {
    readonly context: TrustedResourceContext;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly mediaType: string;
    readonly body: Uint8Array;
  }): Promise<ResourceAttachment>;
}

export class ResourceUploadService implements ResourceUploadPort {
  constructor(
    private readonly blobs: ResourceUploadBlobWriter,
    private readonly repository: ResourceUploadRepository,
    private readonly config: {
      readonly maxBytes: number;
      readonly now: () => IsoTimestamp;
    },
  ) {
    resourceInvariant(
      Number.isSafeInteger(config.maxBytes) && config.maxBytes >= 1,
      "INVALID_REQUEST",
      "上传文件大小配置无效",
    );
  }

  async upload(input: {
    readonly context: TrustedResourceContext;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly mediaType: string;
    readonly body: Uint8Array;
  }): Promise<ResourceAttachment> {
    const name = assertResourceName(input.name);
    const mediaType = normalizeMediaType(input.mediaType);
    resourceInvariant(
      input.body instanceof Uint8Array && input.body.byteLength <= this.config.maxBytes,
      "LIMIT_EXCEEDED",
      "上传文件超过大小限制",
    );
    resourceInvariant(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.idempotencyKey),
      "INVALID_REQUEST",
      "上传幂等键格式无效",
    );
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    const requestDigest = createHash("sha256")
      .update(`${name}\0${mediaType}\0${sha256}\0${input.body.byteLength}`, "utf8")
      .digest("hex");
    const identity = createHash("sha256")
      .update(`${input.context.tenantId}\0${input.context.userId}\0${input.idempotencyKey}`, "utf8")
      .digest("hex")
      .slice(0, 48);
    const targetResourceId = resourceId(`resource_upload_${identity}`);
    const targetVersionId = resourceVersionId(`resource_version_upload_${identity}`);
    let persisted: PersistedResourceUpload;
    try {
      persisted = await this.blobs.persist({
        tenantId: input.context.tenantId,
        idempotencyKey: `api-upload.${input.context.userId}.${input.idempotencyKey}`,
        body: input.body,
        sha256,
        mediaType,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "RESOURCE_BLOB_IDEMPOTENCY_CONFLICT") {
        throw new ResourceServiceError("CONFLICT", "上传幂等键已用于其他文件");
      }
      if (error instanceof Error && error.message === "RESOURCE_BLOB_LIMIT_EXCEEDED") {
        throw new ResourceServiceError("LIMIT_EXCEEDED", "上传文件超过大小限制");
      }
      throw new ResourceServiceError("DEPENDENCY_UNAVAILABLE", "上传文件暂时不可用");
    }
    let committed: ResourceUploadCommitResult;
    try {
      committed = await this.repository.commit({
        context: input.context,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        resourceId: targetResourceId,
        versionId: targetVersionId,
        name,
        mediaType,
        now: this.config.now(),
        persisted,
      });
    } catch (error) {
      await this.blobs
        .abandon?.({ tenantId: input.context.tenantId, persisted })
        .catch(() => undefined);
      throw error;
    }
    if (committed.outcome !== "committed" && committed.outcome !== "replayed") {
      await this.blobs
        .abandon?.({ tenantId: input.context.tenantId, persisted })
        .catch(() => undefined);
    }
    switch (committed.outcome) {
      case "key_conflict":
        throw new ResourceServiceError("CONFLICT", "上传幂等键已用于其他文件");
      case "not_authorized":
        throw new ResourceServiceError("NOT_FOUND", "上传目标不存在或无权访问");
      case "blob_unavailable":
        throw new ResourceServiceError("DEPENDENCY_UNAVAILABLE", "上传文件暂时不可用");
      case "committed":
      case "replayed":
        return Object.freeze({
          resourceId: committed.resource.id,
          versionId: committed.version.id,
          name: committed.resource.name,
          path: resourceFilesystemPath(
            committed.resource.id,
            committed.version.id,
            committed.resource.name,
          ),
          mediaType: committed.version.mediaType,
          sizeBytes: committed.version.sizeBytes,
        });
    }
  }
}

function normalizeMediaType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  resourceInvariant(
    normalized.length >= 3 &&
      normalized.length <= 255 &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(normalized),
    "INVALID_REQUEST",
    "上传文件媒体类型无效",
  );
  return normalized;
}
