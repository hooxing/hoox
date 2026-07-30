import { createHash } from "node:crypto";
import {
  type ArtifactId,
  artifactId,
  type ResourceVersionId,
  resourceVersionId,
  type Sha256Digest,
  sha256Digest,
} from "@cube-runtime/domain";
import type { PersistResourceBlobResult } from "@cube-runtime/persistence";
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
    const persisted = await this.blobs.persist({
      tenantId: input.authorization.scope.tenantId,
      idempotencyKey: input.idempotencyKey,
      body: bytes,
      sha256,
      mediaType,
    });
    return this.repository.commit({
      authorization: input.authorization,
      idempotencyKey: input.idempotencyKey,
      commandDigest,
      ids,
      sourcePath: input.sourcePath,
      name: input.name,
      mediaType,
      persisted,
    });
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
