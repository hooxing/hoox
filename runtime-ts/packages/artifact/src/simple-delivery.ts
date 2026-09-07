import { createHash } from "node:crypto";
import {
  measureExecutionPhase,
  type ExecutionPhaseTimingObserver,
  type ArtifactId,
  artifactId,
  type ResourceVersionId,
  resourceVersionId,
  type Sha256Digest,
  sha256Digest,
} from "@hoox/domain";
import type { PersistResourceBlobResult } from "@hoox/persistence";
import type { ArtifactExecutionAuthorization } from "./authorization.js";

export interface SimpleDeliveredFileSnapshot {
  readonly artifactId: ArtifactId;
  readonly resourceVersionId: ResourceVersionId;
  readonly name: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly mediaType: string;
}

export interface SimpleDeliveredFileRepositoryPort {
  commit(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly commandDigest: Sha256Digest;
    readonly ids: {
      readonly artifactId: ArtifactId;
      readonly resourceId: string;
      readonly resourceVersionId: ResourceVersionId;
      readonly deliverableKey: string;
    };
    readonly sourcePath: string;
    readonly name: string;
    readonly mediaType: string;
    readonly persisted: PersistResourceBlobResult;
  }): Promise<SimpleDeliveredFileSnapshot>;
}

export interface SimpleResourceBlobWriterPort {
  persist(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly body: Uint8Array;
    readonly sha256: string;
    readonly mediaType: string;
  }): Promise<PersistResourceBlobResult>;
  /**
   * Publication 未能形成规范引用时释放本次 stable reference。实现必须先在数据库中确认
   * ResourceVersion/Artifact 均未绑定该引用；COMMIT 响应未知时不能仅凭异常删除对象。
   */
  abandon(input: {
    readonly tenantId: string;
    readonly persisted: PersistResourceBlobResult;
  }): Promise<"released" | "still_referenced">;
}

/** 发布未形成确定结果且清理也未能收敛；Attempt 必须进入恢复，不能让模型重试猜测。 */
export class SimpleDeliveryCleanupResultUnknownError extends Error {
  constructor() {
    super("DELIVER_FILE_CLEANUP_RESULT_UNKNOWN");
    this.name = "SimpleDeliveryCleanupResultUnknownError";
  }
}

/** PG COMMIT 已发送，但规范读回不可用；只能恢复后按原幂等身份确认。 */
export class SimpleDeliveryCommitResultUnknownError extends Error {
  constructor() {
    super("DELIVER_FILE_COMMIT_RESULT_UNKNOWN");
    this.name = "SimpleDeliveryCommitResultUnknownError";
  }
}

/** deliver_file 的应用服务：先固定字节，再原子提交 ResourceVersion 与 published Artifact。 */
export class SimpleArtifactDeliveryService {
  constructor(
    private readonly repository: SimpleDeliveredFileRepositoryPort,
    private readonly blobs: SimpleResourceBlobWriterPort,
  ) {}

  async publish(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly toolArgsDigest: Sha256Digest;
    readonly sourcePath: string;
    readonly name: string;
    readonly body: Uint8Array;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): Promise<SimpleDeliveredFileSnapshot> {
    const bytes = Uint8Array.from(input.body);
    const sha256 = sha256Digest(createHash("sha256").update(bytes).digest("hex"));
    const mediaType = mediaTypeFor(input.name);
    const ids = deterministicIds(
      input.authorization.scope.tenantId,
      input.authorization.attemptId,
      input.idempotencyKey,
    );
    const commandDigest = sha256Digest(
      createHash("sha256")
        .update(
          JSON.stringify({
            schemaVersion: 1,
            kind: "deliver_file",
            tenantId: input.authorization.scope.tenantId,
            attemptId: input.authorization.attemptId,
            callId: input.authorization.callId,
            toolArgsDigest: input.toolArgsDigest,
            sourcePath: input.sourcePath,
            name: input.name,
            size: bytes.byteLength,
            sha256,
            mediaType,
            ids,
          }),
        )
        .digest("hex"),
    );
    // Blob 写入包含对象上传及其稳定引用持久化；不等同于纯网络上传。
    const timingDetails = { toolCallId: input.authorization.callId, toolName: "deliver_file" };
    const persisted = await measureExecutionPhase(
      input.phaseTiming,
      "file_upload",
      () =>
        this.blobs.persist({
          tenantId: input.authorization.scope.tenantId,
          idempotencyKey: input.idempotencyKey,
          body: bytes,
          sha256,
          mediaType,
        }),
      timingDetails,
    );
    try {
      return await measureExecutionPhase(
        input.phaseTiming,
        "file_metadata_commit",
        () =>
          this.repository.commit({
            authorization: input.authorization,
            idempotencyKey: input.idempotencyKey,
            commandDigest,
            ids,
            sourcePath: input.sourcePath,
            name: input.name,
            mediaType,
            persisted,
          }),
        timingDetails,
      );
    } catch (error) {
      // abandon 内部以 PG 规范引用做 guarded release；若 COMMIT 实际成功，只会返回 still_referenced。
      try {
        await this.blobs.abandon({
          tenantId: input.authorization.scope.tenantId,
          persisted,
        });
      } catch {
        if (error instanceof SimpleDeliveryCommitResultUnknownError) throw error;
        throw new SimpleDeliveryCleanupResultUnknownError();
      }
      throw error;
    }
  }
}

function deterministicIds(tenantId: string, attemptId: string, callId: string) {
  const digest = createHash("sha256")
    .update(`deliver-file-v1\0${tenantId}\0${attemptId}\0${callId}`, "utf8")
    .digest("hex");
  return Object.freeze({
    artifactId: artifactId(`artifact_${digest}`),
    resourceId: `resource_${digest}`,
    resourceVersionId: resourceVersionId(`resource_version_${digest}`),
    deliverableKey: `deliver_file_${digest.slice(0, 32)}`,
  });
}

function mediaTypeFor(name: string): string {
  const extension = name.toLocaleLowerCase("en-US").split(".").at(-1);
  const known: Readonly<Record<string, string>> = {
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return extension === undefined
    ? "application/octet-stream"
    : (known[extension] ?? "application/octet-stream");
}
