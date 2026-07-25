import { createHash } from "node:crypto";

export const BLOB_PURPOSES = ["workspace", "resource", "artifact", "trace", "preview"] as const;

export type BlobPurpose = (typeof BLOB_PURPOSES)[number];

export interface TenantBlobScope {
  readonly tenantId: string;
}

export interface BlobDescriptor {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

export interface StagedBlobRef extends BlobDescriptor {
  readonly kind: "staging";
  readonly tenantId: string;
  readonly purpose: BlobPurpose;
  readonly uploadId: string;
}

export interface StableBlobRef extends BlobDescriptor {
  readonly kind: "stable";
  readonly tenantId: string;
  readonly purpose: BlobPurpose;
}

export type BlobRef = StagedBlobRef | StableBlobRef;

export interface PutStagingBlobInput {
  readonly scope: TenantBlobScope;
  readonly purpose: BlobPurpose;
  readonly uploadId: string;
  readonly body: Uint8Array;
  readonly mediaType: string;
  readonly expectedSha256?: string;
  readonly expectedSize?: number;
}

export interface PresignBlobDownloadInput {
  readonly scope: TenantBlobScope;
  readonly blob: StableBlobRef;
  readonly ttlSeconds: number;
  readonly downloadName?: string;
}

export interface BlobObjectHead {
  readonly blob: BlobRef;
  readonly etag?: string;
}

export interface BlobStore {
  putStaging(input: PutStagingBlobInput): Promise<StagedBlobRef>;
  promote(scope: TenantBlobScope, staged: StagedBlobRef): Promise<StableBlobRef>;
  head(scope: TenantBlobScope, blob: BlobRef): Promise<BlobObjectHead | undefined>;
  get(scope: TenantBlobScope, blob: BlobRef): Promise<Uint8Array>;
  delete(scope: TenantBlobScope, blob: BlobRef): Promise<void>;
  presignDownload(input: PresignBlobDownloadInput): Promise<string>;
}

export type BlobStoreErrorCode =
  | "INVALID_BLOB_ARGUMENT"
  | "TENANT_SCOPE_MISMATCH"
  | "BLOB_NOT_FOUND"
  | "BLOB_INTEGRITY_MISMATCH"
  | "BLOB_IDEMPOTENCY_CONFLICT"
  | "BLOB_RESULT_UNKNOWN"
  | "BLOB_PROVIDER_ERROR";

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  readonly result: "known" | "unknown";
  override readonly cause?: unknown;

  constructor(
    code: BlobStoreErrorCode,
    message: string,
    options: { readonly result?: "known" | "unknown"; readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
    this.result = options.result ?? "known";
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function descriptorFor(body: Uint8Array, mediaType: string): BlobDescriptor {
  assertMediaType(mediaType);
  return { sha256: sha256Hex(body), size: body.byteLength, mediaType };
}

export function assertTenantScope(scope: TenantBlobScope): void {
  if (!TENANT_ID_PATTERN.test(scope.tenantId)) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "tenantId 格式无效");
  }
}

export function assertBlobPurpose(purpose: string): asserts purpose is BlobPurpose {
  if (!(BLOB_PURPOSES as readonly string[]).includes(purpose)) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "对象用途不在允许列表中");
  }
}

export function assertBlobRef(scope: TenantBlobScope, blob: BlobRef): void {
  assertTenantScope(scope);
  assertTenantScope({ tenantId: blob.tenantId });
  assertBlobPurpose(blob.purpose);
  assertDescriptor(blob);
  if (scope.tenantId !== blob.tenantId) {
    throw new BlobStoreError("TENANT_SCOPE_MISMATCH", "Blob 不属于当前 Tenant");
  }
  if (blob.kind === "staging") {
    assertUploadId(blob.uploadId);
  }
}

export function assertDescriptor(descriptor: BlobDescriptor): void {
  if (!SHA256_PATTERN.test(descriptor.sha256)) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "SHA-256 格式无效");
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "对象大小无效");
  }
  assertMediaType(descriptor.mediaType);
}

export function assertUploadId(uploadId: string): void {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "uploadId 格式无效");
  }
}

export function assertDownloadName(downloadName: string): void {
  if (
    downloadName.length < 1 ||
    downloadName.length > 180 ||
    containsAsciiControl(downloadName) ||
    downloadName.includes("/") ||
    downloadName.includes("\\")
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "下载文件名包含非法字符");
  }
}

function assertMediaType(mediaType: string): void {
  if (
    mediaType.length < 1 ||
    mediaType.length > 255 ||
    containsAsciiControl(mediaType) ||
    !mediaType.includes("/")
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "媒体类型格式无效");
  }
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
