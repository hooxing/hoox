import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BlobStoreError,
  type BlobDescriptor,
  type BlobObjectHead,
  type BlobRef,
  type BlobStore,
  type PresignBlobDownloadInput,
  type PromotionAuthorizationRef,
  type PutStagingBlobInput,
  type StableBlobRef,
  type StableBlobGcClaim,
  type StableBlobGcClaimPort,
  type StableBlobGcPort,
  type StableBlobPromotionAuthorization,
  type StableBlobPromotionAuthorizationPort,
  type StagedBlobRef,
  type TenantBlobScope,
  assertBlobPurpose,
  assertBlobRef,
  assertDownloadName,
  assertIncarnationId,
  assertMediaType,
  assertPhysicalObjectKey,
  assertTenantScope,
  assertUploadId,
  descriptorFor,
} from "./blob-store.js";

export interface S3BlobStoreConfig {
  readonly bucket: string;
  readonly prefix?: string;
  readonly maxPresignTtlSeconds?: number;
  readonly maxBlobSizeBytes: number;
}

export interface CreateS3BlobStoreConfig extends S3BlobStoreConfig {
  readonly endpoint?: string;
  readonly publicEndpoint?: string;
  readonly region: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
}

export interface S3ObjectMetadata {
  readonly size: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly etag?: string;
}

export interface S3PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly descriptor: BlobDescriptor;
}

export interface S3GetObjectResult {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength: number;
}

export interface S3CopyObjectInput {
  readonly sourceKey: string;
  readonly destinationKey: string;
}

export interface S3PresignInput {
  readonly key: string;
  readonly ttlSeconds: number;
  readonly responseMediaType: string;
  readonly delivery: "artifact-download" | "inline-preview";
  readonly downloadName?: string;
}

/**
 * SDK 的最窄端口。单元测试替换此接口，不需要接触网络或真实凭据。
 * 写操作抛出的 BlobStoreError 必须用 result 标明结果是否可能已经发生。
 */
export interface S3ObjectClient {
  put(input: S3PutObjectInput): Promise<void>;
  head(key: string): Promise<S3ObjectMetadata | undefined>;
  get(key: string): Promise<S3GetObjectResult | undefined>;
  copy(input: S3CopyObjectInput): Promise<void>;
  delete(key: string): Promise<void>;
  presignGet(input: S3PresignInput): Promise<string>;
}

export class S3BlobStore implements BlobStore {
  private readonly prefix: string;
  private readonly maxPresignTtlSeconds: number;
  private readonly maxBlobSizeBytes: number;

  constructor(
    private readonly client: S3ObjectClient,
    private readonly authorizations: StableBlobPromotionAuthorizationPort,
    config: S3BlobStoreConfig,
  ) {
    assertBucket(config.bucket);
    this.prefix = normalizePrefix(config.prefix ?? "agent-runtime");
    this.maxPresignTtlSeconds = assertMaxPresignTtl(config.maxPresignTtlSeconds ?? 600);
    this.maxBlobSizeBytes = assertMaxBlobSize(config.maxBlobSizeBytes);
  }

  async putStaging(input: PutStagingBlobInput): Promise<StagedBlobRef> {
    assertTenantScope(input.scope);
    assertBlobPurpose(input.purpose);
    assertUploadId(input.uploadId);
    this.assertWithinSizeLimit(input.body.byteLength);
    assertExpectedDeclaration(input);
    const descriptor = descriptorFor(input.body, input.mediaType);
    assertExpectedContent(input, descriptor);
    const blob: StagedBlobRef = {
      kind: "staging",
      tenantId: input.scope.tenantId,
      purpose: input.purpose,
      uploadId: input.uploadId,
      ...descriptor,
    };
    const key = this.keyFor(blob);
    const existing = await this.client.head(key);
    if (existing !== undefined) {
      assertProviderBlobSizeWithin(existing.size, this.maxBlobSizeBytes);
      assertStoredDescriptor(existing, descriptor, "BLOB_IDEMPOTENCY_CONFLICT");
      return blob;
    }

    try {
      await this.client.put({ key, body: input.body, descriptor });
    } catch (error) {
      if (await this.resolveWriteResult(key, descriptor, error)) {
        return blob;
      }
      throw normalizeWriteError(error, "staging 对象上传失败，结果可能未知");
    }

    await this.assertWritten(key, descriptor);
    return blob;
  }

  async promote(
    scope: TenantBlobScope,
    staged: StagedBlobRef,
    authorizationRef: PromotionAuthorizationRef,
  ): Promise<StableBlobRef> {
    assertBlobRef(scope, staged);
    assertPromotionAuthorizationRef(scope, authorizationRef);
    const resolution = await this.authorizations.resolveAuthorizedForCopy({
      scope,
      authorization: authorizationRef,
    });
    if (resolution.status !== "authorized") {
      throw new BlobStoreError(
        "INVALID_BLOB_ARGUMENT",
        `stable promote 授权不可用：${resolution.status}`,
      );
    }
    const persisted = resolution.authorization;
    assertPromotionAuthorizationMatches(scope, staged, authorizationRef, persisted, this.prefix);
    this.assertWithinSizeLimit(staged.size);
    const sourceKey = this.keyFor(staged);
    const stagedHead = await this.client.head(sourceKey);
    if (stagedHead === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "待提交的 staging 对象不存在");
    }
    assertProviderBlobSizeWithin(stagedHead.size, this.maxBlobSizeBytes);
    assertStoredDescriptor(stagedHead, staged);

    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: staged.tenantId,
      purpose: staged.purpose,
      sha256: staged.sha256,
      size: staged.size,
      mediaType: staged.mediaType,
      incarnationId: persisted.incarnationId,
      physicalObjectKey: persisted.physicalObjectKey,
    };
    const destinationKey = this.keyFor(stable);
    const existing = await this.client.head(destinationKey);
    if (existing !== undefined) {
      assertProviderBlobSizeWithin(existing.size, this.maxBlobSizeBytes);
      assertStoredDescriptor(existing, stable);
      return stable;
    }

    try {
      await this.client.copy({ sourceKey, destinationKey });
    } catch (error) {
      if (await this.resolveWriteResult(destinationKey, stable, error)) {
        return stable;
      }
      throw normalizeWriteError(error, "稳定对象复制失败，结果可能未知");
    }

    await this.assertWritten(destinationKey, stable);
    return stable;
  }

  async head(scope: TenantBlobScope, blob: BlobRef): Promise<BlobObjectHead | undefined> {
    assertBlobRef(scope, blob);
    const metadata = await this.client.head(this.keyFor(blob));
    if (metadata === undefined) {
      return undefined;
    }
    assertProviderBlobSizeWithin(metadata.size, this.maxBlobSizeBytes);
    assertStoredDescriptor(metadata, blob);
    return metadata.etag === undefined ? { blob } : { blob, etag: metadata.etag };
  }

  async *read(scope: TenantBlobScope, blob: BlobRef): AsyncIterable<Uint8Array> {
    assertBlobRef(scope, blob);
    this.assertWithinSizeLimit(blob.size);
    const response = await this.client.get(this.keyFor(blob));
    if (response === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "对象不存在");
    }
    assertProviderBlobSizeWithin(response.contentLength, this.maxBlobSizeBytes);
    if (response.contentLength !== blob.size) {
      throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "GET ContentLength 与固定大小不一致");
    }

    const hash = createHash("sha256");
    let received = 0;
    const verifiedChunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      assertProviderBlobSizeWithin(received, this.maxBlobSizeBytes);
      if (received > blob.size) {
        throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "读取内容超过固定大小");
      }
      hash.update(chunk);
      // 当前绝对上限为 16 MiB，先缓冲并完成全量校验，避免消费者在最终哈希失败前提交外部效果。
      verifiedChunks.push(chunk.slice());
    }
    if (received !== blob.size || hash.digest("hex") !== blob.sha256) {
      throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "对象内容与固定哈希或大小不一致");
    }
    for (const chunk of verifiedChunks) {
      yield chunk;
    }
  }

  async getBytes(scope: TenantBlobScope, blob: BlobRef): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of this.read(scope, blob)) {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async deleteStaging(scope: TenantBlobScope, blob: StagedBlobRef): Promise<void> {
    assertBlobRef(scope, blob);
    if (blob.kind !== "staging") {
      throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "普通 BlobStore 只能删除 staging 对象");
    }
    const key = this.keyFor(blob);
    await deleteAndResolve(this.client, key);
  }

  async presignDownload(input: PresignBlobDownloadInput): Promise<string> {
    assertBlobRef(input.scope, input.blob);
    assertMediaType(input.responseMediaType);
    const delivery = input.delivery ?? "artifact-download";
    if (delivery !== "artifact-download" && delivery !== "inline-preview") {
      throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "预签名交付策略无效");
    }
    if (delivery === "inline-preview" && input.downloadName !== undefined) {
      throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "预览策略不能携带下载文件名");
    }
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1) {
      throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "预签名 TTL 必须是正整数");
    }
    if (input.ttlSeconds > this.maxPresignTtlSeconds) {
      throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "预签名 TTL 超过允许上限");
    }
    if (input.downloadName !== undefined) {
      assertDownloadName(input.downloadName);
    }
    const key = this.keyFor(input.blob);
    const metadata = await this.client.head(key);
    if (metadata === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "待下载对象不存在");
    }
    assertProviderBlobSizeWithin(metadata.size, this.maxBlobSizeBytes);
    assertStoredDescriptor(metadata, input.blob);
    return this.client.presignGet({
      key,
      ttlSeconds: input.ttlSeconds,
      responseMediaType: input.responseMediaType,
      delivery,
      ...(input.downloadName === undefined ? {} : { downloadName: input.downloadName }),
    });
  }

  private keyFor(blob: BlobRef): string {
    return keyFor(this.prefix, blob);
  }

  private async assertWritten(key: string, descriptor: BlobDescriptor): Promise<void> {
    let metadata: S3ObjectMetadata | undefined;
    try {
      metadata = await this.client.head(key);
    } catch (error) {
      throw unknownAfterVerificationFailure("写操作返回成功，但 HEAD 校验失败", error);
    }
    if (metadata === undefined) {
      throw new BlobStoreError("BLOB_RESULT_UNKNOWN", "写操作返回成功但对象不可见", {
        result: "unknown",
      });
    }
    assertStoredDescriptor(metadata, descriptor);
  }

  private async resolveWriteResult(
    key: string,
    descriptor: BlobDescriptor,
    originalError: unknown,
  ): Promise<boolean> {
    try {
      const metadata = await this.client.head(key);
      if (metadata === undefined) {
        return false;
      }
      assertStoredDescriptor(
        metadata,
        descriptor,
        originalError instanceof BlobStoreError && originalError.code === "BLOB_PRECONDITION_FAILED"
          ? "BLOB_IDEMPOTENCY_CONFLICT"
          : "BLOB_INTEGRITY_MISMATCH",
      );
      return true;
    } catch (headError) {
      if (
        headError instanceof BlobStoreError &&
        (headError.code === "BLOB_INTEGRITY_MISMATCH" ||
          headError.code === "BLOB_IDEMPOTENCY_CONFLICT")
      ) {
        throw headError;
      }
      throw unknownAfterVerificationFailure(
        "写操作失败后无法通过 HEAD 确认结果",
        new AggregateError([originalError, headError]),
      );
    }
  }

  private assertWithinSizeLimit(size: number): void {
    assertBlobSizeWithin(size, this.maxBlobSizeBytes);
  }
}

export function createS3BlobStore(
  config: CreateS3BlobStoreConfig,
  authorizations: StableBlobPromotionAuthorizationPort,
): S3BlobStore {
  return new S3BlobStore(createAwsObjectClient(config), authorizations, config);
}

export function createS3StableBlobGarbageCollector(
  config: CreateS3BlobStoreConfig,
  claims: StableBlobGcClaimPort,
): StableBlobGcPort {
  const maxBlobSizeBytes = assertMaxBlobSize(config.maxBlobSizeBytes);
  const prefix = normalizePrefix(config.prefix ?? "agent-runtime");
  return new S3StableBlobGarbageCollector(
    createAwsObjectClient(config),
    claims,
    prefix,
    maxBlobSizeBytes,
  );
}

export class S3StableBlobGarbageCollector implements StableBlobGcPort {
  constructor(
    private readonly client: S3ObjectClient,
    private readonly claims: StableBlobGcClaimPort,
    private readonly prefix: string,
    private readonly maxBlobSizeBytes: number,
  ) {}

  async collectIfUnreachable(
    scope: TenantBlobScope,
    blob: StableBlobRef,
  ): Promise<"deleted" | "still_referenced" | "in_progress"> {
    assertBlobRef(scope, blob);
    assertBlobSizeWithin(blob.size, this.maxBlobSizeBytes);
    const result = await this.claims.claimUnreachable({ scope, blob });
    if (result.status === "already_deleted") {
      return "deleted";
    }
    if (result.status !== "claimed") {
      return result.status;
    }
    assertGcClaim(scope, blob, result.claim, this.prefix);
    let deletingClaim = result.claim;
    if (deletingClaim.phase === "pre_delete") {
      const begin = await this.claims.beginDeletion({ scope, blob, claim: deletingClaim });
      if (begin.status === "claim_lost") {
        return "in_progress";
      }
      assertDeletionContinuation(deletingClaim, begin.claim);
      deletingClaim = begin.claim;
      assertGcClaim(scope, blob, deletingClaim, this.prefix);
      if (deletingClaim.phase !== "deleting") {
        throw new BlobStoreError("BLOB_PROVIDER_ERROR", "GC beginDeletion 未返回 deleting claim");
      }
    }
    // 一旦取得 deleting intent，任何 DELETE 失败/UNKNOWN 都不能恢复 active：旧 DELETE 仍可能延迟成功。
    await deleteAndResolve(this.client, deletingClaim.physicalObjectKey);
    // 删除已确认后才完成 claim；完成失败也不能释放，否则新引用可能指向已删除对象。
    await this.claims.completeDeletion({ scope, blob, claim: deletingClaim });
    return "deleted";
  }
}

function assertDeletionContinuation(
  reserved: StableBlobGcClaim,
  deleting: StableBlobGcClaim,
): void {
  if (
    deleting.phase !== "deleting" ||
    reserved.claimId !== deleting.claimId ||
    reserved.generation !== deleting.generation ||
    reserved.leaseExpiresAt !== deleting.leaseExpiresAt ||
    reserved.tenantId !== deleting.tenantId ||
    reserved.purpose !== deleting.purpose ||
    reserved.sha256 !== deleting.sha256 ||
    reserved.size !== deleting.size ||
    reserved.incarnationId !== deleting.incarnationId ||
    reserved.physicalObjectKey !== deleting.physicalObjectKey
  ) {
    throw new BlobStoreError(
      "BLOB_INTEGRITY_MISMATCH",
      "beginDeletion 返回的 claim 未保持完整物理身份与 CAS 身份连续",
    );
  }
}

function createAwsObjectClient(config: CreateS3BlobStoreConfig): S3ObjectClient {
  const credentials = credentialsFrom(config);
  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? false,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(credentials === undefined ? {} : { credentials }),
  };
  const client = new S3Client(clientConfig);
  // Worker 可走 Docker 内部 endpoint，而下载签名必须使用浏览器可访问的 public endpoint。
  const presignClient =
    config.publicEndpoint === undefined
      ? client
      : new S3Client({ ...clientConfig, endpoint: config.publicEndpoint });
  return new AwsS3ObjectClient(client, presignClient, config.bucket);
}

class AwsS3ObjectClient implements S3ObjectClient {
  constructor(
    private readonly client: S3Client,
    private readonly presignClient: S3Client,
    private readonly bucket: string,
  ) {}

  async put(input: S3PutObjectInput): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentLength: input.descriptor.size,
          ContentType: input.descriptor.mediaType,
          Metadata: { sha256: input.descriptor.sha256 },
          CacheControl: "private, no-store",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      throw awsOperationError(error, true);
    }
  }

  async head(key: string): Promise<S3ObjectMetadata | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const sha256 = result.Metadata?.sha256;
      if (
        result.ContentLength === undefined ||
        result.ContentType === undefined ||
        sha256 === undefined
      ) {
        throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "对象缺少必要完整性元数据");
      }
      return {
        size: result.ContentLength,
        mediaType: result.ContentType,
        sha256,
        ...(result.ETag === undefined ? {} : { etag: result.ETag }),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      if (error instanceof BlobStoreError) {
        throw error;
      }
      throw awsOperationError(error, false);
    }
  }

  async get(key: string): Promise<S3GetObjectResult | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (result.Body === undefined || result.ContentLength === undefined) {
        throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "对象响应缺少内容或 ContentLength");
      }
      return {
        body: sdkBodyAsAsyncIterable(result.Body),
        contentLength: result.ContentLength,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      if (error instanceof BlobStoreError) {
        throw error;
      }
      throw awsOperationError(error, false);
    }
  }

  async copy(input: S3CopyObjectInput): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: input.destinationKey,
          CopySource: `${encodeURIComponent(this.bucket)}/${encodeKey(input.sourceKey)}`,
          MetadataDirective: "COPY",
          CacheControl: "private, no-store",
        }),
      );
    } catch (error) {
      throw awsOperationError(error, true);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw awsOperationError(error, true);
    }
  }

  async presignGet(input: S3PresignInput): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentType: input.responseMediaType,
        ResponseContentDisposition: contentDisposition(input.delivery, input.downloadName),
      });
      return await getSignedUrl(this.presignClient, command, { expiresIn: input.ttlSeconds });
    } catch (error) {
      throw awsOperationError(error, false);
    }
  }
}

function assertExpectedDeclaration(input: PutStagingBlobInput): void {
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "expectedSha256 格式无效");
  }
  if (
    input.expectedSize !== undefined &&
    (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0)
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "expectedSize 格式无效");
  }
}

function assertExpectedContent(input: PutStagingBlobInput, actual: BlobDescriptor): void {
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== actual.sha256) {
    throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "上传内容 SHA-256 与调用方声明不一致");
  }
  if (input.expectedSize !== undefined && input.expectedSize !== actual.size) {
    throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "上传内容大小与调用方声明不一致");
  }
}

function assertStoredDescriptor(
  stored: S3ObjectMetadata,
  expected: BlobDescriptor,
  code: "BLOB_INTEGRITY_MISMATCH" | "BLOB_IDEMPOTENCY_CONFLICT" = "BLOB_INTEGRITY_MISMATCH",
): void {
  // mediaType 属于业务引用展示元数据，不参与内容身份；同一内容可以被不同业务类型引用。
  if (stored.sha256 !== expected.sha256 || stored.size !== expected.size) {
    throw new BlobStoreError(code, "对象键已经存在，但内容哈希或大小不一致");
  }
}

function normalizeWriteError(error: unknown, message: string): BlobStoreError {
  if (error instanceof BlobStoreError) {
    return error;
  }
  return new BlobStoreError("BLOB_RESULT_UNKNOWN", message, { result: "unknown", cause: error });
}

function awsOperationError(error: unknown, mutating: boolean): BlobStoreError {
  const statusCode = awsStatusCode(error);
  if (statusCode === 412) {
    return new BlobStoreError("BLOB_PRECONDITION_FAILED", "对象条件写入未满足", {
      result: "known",
      cause: error,
    });
  }
  const result = mutating && statusCode === undefined ? "unknown" : "known";
  return new BlobStoreError(
    result === "unknown" ? "BLOB_RESULT_UNKNOWN" : "BLOB_PROVIDER_ERROR",
    result === "unknown" ? "对象存储写操作结果未知" : "对象存储请求失败",
    { result, cause: error },
  );
}

function awsStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = (error as { readonly $metadata?: { readonly httpStatusCode?: unknown } })
    .$metadata;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function isNotFound(error: unknown): boolean {
  if (awsStatusCode(error) === 404) {
    return true;
  }
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  return error.name === "NotFound" || error.name === "NoSuchKey";
}

function credentialsFrom(
  config: CreateS3BlobStoreConfig,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  const hasAccessKey = config.accessKeyId !== undefined;
  const hasSecretKey = config.secretAccessKey !== undefined;
  if (hasAccessKey !== hasSecretKey) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "S3 access key 和 secret key 必须同时提供");
  }
  return hasAccessKey && hasSecretKey
    ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    : undefined;
}

function assertBucket(bucket: string): string {
  if (bucket.length < 3 || bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket)) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "S3 bucket 格式无效");
  }
  return bucket;
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/gu, "");
  if (
    normalized.length < 1 ||
    normalized.length > 160 ||
    normalized.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(segment))
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "对象存储前缀格式无效");
  }
  return normalized;
}

function assertMaxPresignTtl(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3_600) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "预签名 TTL 上限必须在 1 到 3600 秒之间");
  }
  return value;
}

function assertMaxBlobSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_IN_MEMORY_BLOB_SIZE_BYTES) {
    throw new BlobStoreError(
      "INVALID_BLOB_ARGUMENT",
      `小对象上限必须在 1 到 ${MAX_IN_MEMORY_BLOB_SIZE_BYTES} 字节之间`,
    );
  }
  return value;
}

function assertBlobSizeWithin(size: number, maximum: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "Blob 大小超过当前小对象上限");
  }
}

function assertProviderBlobSizeWithin(size: number, maximum: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    throw new BlobStoreError(
      "BLOB_INTEGRITY_MISMATCH",
      "对象存储响应的 Blob 大小超过当前小对象上限",
    );
  }
}

async function deleteAndResolve(client: S3ObjectClient, key: string): Promise<void> {
  try {
    await client.delete(key);
  } catch (error) {
    try {
      // 只有明确 NotFound 才能把删除收敛为成功；HEAD 故障仍表示删除结果未知。
      if ((await client.head(key)) === undefined) {
        return;
      }
    } catch (headError) {
      throw unknownAfterVerificationFailure(
        "删除失败后无法通过 HEAD 确认结果",
        new AggregateError([error, headError]),
      );
    }
    throw normalizeWriteError(error, "对象删除失败，结果可能未知");
  }
}

function keyFor(prefix: string, blob: BlobRef): string {
  if (blob.kind === "staging") {
    return `${prefix}/tenants/${blob.tenantId}/staging/${blob.purpose}/${blob.uploadId}`;
  }
  const expected = stableKeyFor(prefix, blob, blob.incarnationId);
  if (blob.physicalObjectKey !== expected) {
    throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "stable 物理对象键与 incarnation 不一致");
  }
  return expected;
}

function stableKeyFor(
  prefix: string,
  blob: Pick<StableBlobRef, "tenantId" | "purpose" | "sha256">,
  incarnationId: string,
): string {
  return `${prefix}/stable/${blob.tenantId}/${blob.purpose}/sha256/${blob.sha256}/incarnations/${incarnationId}`;
}

function assertPromotionAuthorizationRef(
  scope: TenantBlobScope,
  authorization: PromotionAuthorizationRef,
): void {
  assertTenantScope({ tenantId: authorization.tenantId });
  if (
    !OPERATION_ID_PATTERN.test(authorization.operationId) ||
    !UUID_V4_PATTERN.test(authorization.authorizationId)
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "stable promote 授权引用格式无效");
  }
  if (authorization.tenantId !== scope.tenantId) {
    throw new BlobStoreError("TENANT_SCOPE_MISMATCH", "stable promote 授权不属于当前 Tenant");
  }
}

function assertPromotionAuthorizationFormat(authorization: StableBlobPromotionAuthorization): void {
  assertTenantScope({ tenantId: authorization.tenantId });
  assertBlobPurpose(authorization.purpose);
  assertUploadId(authorization.stagingUploadId);
  assertIncarnationId(authorization.incarnationId);
  assertPhysicalObjectKey(authorization.stagingObjectKey);
  assertPhysicalObjectKey(authorization.physicalObjectKey);
  if (
    !/^[a-f0-9]{64}$/u.test(authorization.sha256) ||
    !Number.isSafeInteger(authorization.size) ||
    authorization.size < 0 ||
    !UUID_V4_PATTERN.test(authorization.authorizationId) ||
    !OPERATION_ID_PATTERN.test(authorization.operationId) ||
    !REFERENCE_ID_PATTERN.test(authorization.referenceId) ||
    !UUID_V4_PATTERN.test(authorization.lifecycleId) ||
    !UUID_V4_PATTERN.test(authorization.allocationId) ||
    !Number.isSafeInteger(authorization.generation) ||
    authorization.generation < 1 ||
    (authorization.mode !== "active_reuse" && authorization.mode !== "new_after_deleted")
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "stable promote 规范授权格式无效");
  }
}

function assertPromotionAuthorizationMatches(
  scope: TenantBlobScope,
  staged: StagedBlobRef,
  supplied: PromotionAuthorizationRef,
  persisted: StableBlobPromotionAuthorization,
  prefix: string,
): void {
  assertPromotionAuthorizationFormat(persisted);
  if (persisted.tenantId !== scope.tenantId) {
    throw new BlobStoreError("TENANT_SCOPE_MISMATCH", "stable promote 规范授权不属于当前 Tenant");
  }
  const expectedStagingKey = keyFor(prefix, staged);
  const expectedKey = stableKeyFor(prefix, staged, persisted.incarnationId);
  if (
    supplied.tenantId !== persisted.tenantId ||
    supplied.operationId !== persisted.operationId ||
    supplied.authorizationId !== persisted.authorizationId ||
    persisted.tenantId !== staged.tenantId ||
    persisted.stagingUploadId !== staged.uploadId ||
    persisted.stagingObjectKey !== expectedStagingKey ||
    persisted.purpose !== staged.purpose ||
    persisted.sha256 !== staged.sha256 ||
    persisted.size !== staged.size ||
    persisted.physicalObjectKey !== expectedKey
  ) {
    throw new BlobStoreError(
      "BLOB_INTEGRITY_MISMATCH",
      "stable promote 规范授权与授权引用、staging 或派生物理目标不一致",
    );
  }
}

function assertGcClaim(
  scope: TenantBlobScope,
  blob: StableBlobRef,
  claim: StableBlobGcClaim,
  prefix: string,
): void {
  assertTenantScope({ tenantId: claim.tenantId });
  assertBlobPurpose(claim.purpose);
  assertIncarnationId(claim.incarnationId);
  assertPhysicalObjectKey(claim.physicalObjectKey);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(claim.claimId) ||
    !Number.isSafeInteger(claim.generation) ||
    claim.generation < 1 ||
    (claim.phase !== "pre_delete" && claim.phase !== "deleting") ||
    !/^[a-f0-9]{64}$/u.test(claim.sha256) ||
    !Number.isSafeInteger(claim.size) ||
    claim.size < 0 ||
    !isCanonicalUtcIso(claim.leaseExpiresAt)
  ) {
    throw new BlobStoreError("INVALID_BLOB_ARGUMENT", "stable GC claim 格式无效");
  }
  if (claim.tenantId !== scope.tenantId) {
    throw new BlobStoreError("TENANT_SCOPE_MISMATCH", "stable GC claim 不属于当前 Tenant");
  }
  const expectedPhysicalKey = stableKeyFor(prefix, blob, blob.incarnationId);
  if (
    claim.purpose !== blob.purpose ||
    claim.sha256 !== blob.sha256 ||
    claim.size !== blob.size ||
    claim.incarnationId !== blob.incarnationId ||
    claim.physicalObjectKey !== blob.physicalObjectKey ||
    blob.physicalObjectKey !== expectedPhysicalKey
  ) {
    throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "stable GC claim 与物理对象不一致");
  }
}

function sdkBodyAsAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (
    typeof body !== "object" ||
    body === null ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== "function"
  ) {
    throw new BlobStoreError("BLOB_PROVIDER_ERROR", "S3 响应体不支持流式读取");
  }
  return body as AsyncIterable<Uint8Array>;
}

function unknownAfterVerificationFailure(message: string, cause: unknown): BlobStoreError {
  return new BlobStoreError("BLOB_RESULT_UNKNOWN", message, { result: "unknown", cause });
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function contentDisposition(
  delivery: "artifact-download" | "inline-preview",
  downloadName: string | undefined,
): string {
  if (delivery === "inline-preview") {
    return "inline";
  }
  return downloadName === undefined
    ? "attachment"
    : `attachment; filename*=UTF-8''${encodeRfc5987Value(downloadName)}`;
}

export function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const MAX_IN_MEMORY_BLOB_SIZE_BYTES = 16 * 1024 * 1024;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isCanonicalUtcIso(value: string): boolean {
  const epochMilliseconds = Date.parse(value);
  return !Number.isNaN(epochMilliseconds) && new Date(epochMilliseconds).toISOString() === value;
}
