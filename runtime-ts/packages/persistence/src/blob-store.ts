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
  /** 来自当前 Artifact/Resource 引用，不能使用 stable 对象首次上传时的 Content-Type。 */
  readonly responseMediaType: string;
  /** 默认是交付物下载；预览必须由上层明确选择独立策略。 */
  readonly delivery?: "artifact-download" | "inline-preview";
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
  read(scope: TenantBlobScope, blob: BlobRef): AsyncIterable<Uint8Array>;
  getBytes(scope: TenantBlobScope, blob: BlobRef): Promise<Uint8Array>;
  deleteStaging(scope: TenantBlobScope, blob: StagedBlobRef): Promise<void>;
  presignDownload(input: PresignBlobDownloadInput): Promise<string>;
}

export interface StableBlobGcClaim {
  readonly claimId: string;
  readonly generation: number;
  readonly leaseExpiresAt: string;
  readonly phase: "pre_delete" | "deleting";
  readonly tenantId: string;
  readonly purpose: BlobPurpose;
  readonly sha256: string;
  readonly size: number;
}

/**
 * 由 PostgreSQL 事务实现。claimUnreachable 必须在同一事务中检查零引用并签发租约；
 * beginDeletion 必须把 pre_delete 原子推进为不可逆 deleting，再允许发起远端 DELETE。
 * 新增 stable 引用也必须锁定并读取同一生命周期行，pre_delete/deleting 状态下一律拒绝。
 * deleted 对象只有在重新 promote 并经 HEAD 校验后，才能由引用事务原子恢复为 active。
 * lease 只控制恢复 Worker 的执行权，过期不能自动把 deleting 改回 active；接管时递增 generation。
 * begin/complete/pre-delete release 必须以 claimId + generation 做 compare-and-set，拒绝过期 Worker。
 */
export interface StableBlobGcClaimPort {
  claimUnreachable(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
  }): Promise<
    | { readonly status: "claimed"; readonly claim: StableBlobGcClaim }
    | { readonly status: "still_referenced" }
    | { readonly status: "in_progress" }
    | { readonly status: "already_deleted" }
  >;
  beginDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }): Promise<
    | { readonly status: "started"; readonly claim: StableBlobGcClaim }
    | { readonly status: "claim_lost" }
  >;
  completeDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }): Promise<void>;
  /** 仅能释放尚未调用 beginDeletion 的 pre_delete claim；deleting 永远不能恢复 active。 */
  releasePreDeleteClaim(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }): Promise<void>;
  resolveLifecycle(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
  }): Promise<"active" | "pre_delete" | "deleting" | "deleted">;
}

export interface StableBlobGcPort {
  collectIfUnreachable(
    scope: TenantBlobScope,
    blob: StableBlobRef,
  ): Promise<"deleted" | "still_referenced" | "in_progress">;
}

export type BlobStoreErrorCode =
  | "INVALID_BLOB_ARGUMENT"
  | "TENANT_SCOPE_MISMATCH"
  | "BLOB_NOT_FOUND"
  | "BLOB_INTEGRITY_MISMATCH"
  | "BLOB_IDEMPOTENCY_CONFLICT"
  | "BLOB_PRECONDITION_FAILED"
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

export function assertMediaType(mediaType: string): void {
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
