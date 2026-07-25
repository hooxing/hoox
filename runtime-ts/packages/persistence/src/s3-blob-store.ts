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
  type PutStagingBlobInput,
  type StableBlobRef,
  type StagedBlobRef,
  type TenantBlobScope,
  assertBlobPurpose,
  assertBlobRef,
  assertDownloadName,
  assertTenantScope,
  assertUploadId,
  descriptorFor,
  sha256Hex,
} from "./blob-store.js";

export interface S3BlobStoreConfig {
  readonly bucket: string;
  readonly prefix?: string;
  readonly maxPresignTtlSeconds?: number;
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

export interface S3CopyObjectInput {
  readonly sourceKey: string;
  readonly destinationKey: string;
}

export interface S3PresignInput {
  readonly key: string;
  readonly ttlSeconds: number;
  readonly downloadName?: string;
}

/**
 * SDK 的最窄端口。单元测试替换此接口，不需要接触网络或真实凭据。
 * 写操作抛出的 BlobStoreError 必须用 result 标明结果是否可能已经发生。
 */
export interface S3ObjectClient {
  put(input: S3PutObjectInput): Promise<void>;
  head(key: string): Promise<S3ObjectMetadata | undefined>;
  get(key: string): Promise<Uint8Array | undefined>;
  copy(input: S3CopyObjectInput): Promise<void>;
  delete(key: string): Promise<void>;
  presignGet(input: S3PresignInput): Promise<string>;
}

export class S3BlobStore implements BlobStore {
  private readonly prefix: string;
  private readonly maxPresignTtlSeconds: number;

  constructor(
    private readonly client: S3ObjectClient,
    config: S3BlobStoreConfig,
  ) {
    assertBucket(config.bucket);
    this.prefix = normalizePrefix(config.prefix ?? "agent-runtime");
    this.maxPresignTtlSeconds = assertMaxPresignTtl(config.maxPresignTtlSeconds ?? 600);
  }

  async putStaging(input: PutStagingBlobInput): Promise<StagedBlobRef> {
    assertTenantScope(input.scope);
    assertBlobPurpose(input.purpose);
    assertUploadId(input.uploadId);
    const descriptor = descriptorFor(input.body, input.mediaType);
    assertExpectedDescriptor(input, descriptor);
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
      assertStoredDescriptor(existing, descriptor, "BLOB_IDEMPOTENCY_CONFLICT");
      return blob;
    }

    try {
      await this.client.put({ key, body: input.body, descriptor });
    } catch (error) {
      if (await this.writeActuallySucceeded(key, descriptor)) {
        return blob;
      }
      throw normalizeWriteError(error, "staging 对象上传失败，结果可能未知");
    }

    await this.assertWritten(key, descriptor);
    return blob;
  }

  async promote(scope: TenantBlobScope, staged: StagedBlobRef): Promise<StableBlobRef> {
    assertBlobRef(scope, staged);
    const sourceKey = this.keyFor(staged);
    const stagedHead = await this.client.head(sourceKey);
    if (stagedHead === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "待提交的 staging 对象不存在");
    }
    assertStoredDescriptor(stagedHead, staged);

    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: staged.tenantId,
      purpose: staged.purpose,
      sha256: staged.sha256,
      size: staged.size,
      mediaType: staged.mediaType,
    };
    const destinationKey = this.keyFor(stable);
    const existing = await this.client.head(destinationKey);
    if (existing !== undefined) {
      assertStoredDescriptor(existing, stable);
      return stable;
    }

    try {
      await this.client.copy({ sourceKey, destinationKey });
    } catch (error) {
      if (await this.writeActuallySucceeded(destinationKey, stable)) {
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
    assertStoredDescriptor(metadata, blob);
    return metadata.etag === undefined ? { blob } : { blob, etag: metadata.etag };
  }

  async get(scope: TenantBlobScope, blob: BlobRef): Promise<Uint8Array> {
    assertBlobRef(scope, blob);
    const body = await this.client.get(this.keyFor(blob));
    if (body === undefined) {
      throw new BlobStoreError("BLOB_NOT_FOUND", "对象不存在");
    }
    if (body.byteLength !== blob.size || sha256Hex(body) !== blob.sha256) {
      throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "对象内容与固定哈希或大小不一致");
    }
    return body;
  }

  async delete(scope: TenantBlobScope, blob: BlobRef): Promise<void> {
    assertBlobRef(scope, blob);
    const key = this.keyFor(blob);
    try {
      await this.client.delete(key);
    } catch (error) {
      // 删除响应丢失时先 HEAD；不存在即视为幂等成功，存在则必须保留“结果未知”。
      if ((await this.client.head(key)) === undefined) {
        return;
      }
      throw normalizeWriteError(error, "对象删除失败，结果可能未知");
    }
  }

  async presignDownload(input: PresignBlobDownloadInput): Promise<string> {
    assertBlobRef(input.scope, input.blob);
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
    assertStoredDescriptor(metadata, input.blob);
    return this.client.presignGet({
      key,
      ttlSeconds: input.ttlSeconds,
      ...(input.downloadName === undefined ? {} : { downloadName: input.downloadName }),
    });
  }

  private keyFor(blob: BlobRef): string {
    // 对象键只由已验证的 Tenant、用途和不透明 ID/哈希派生；调用方没有传完整 key 的入口。
    const suffix =
      blob.kind === "staging"
        ? `staging/${blob.purpose}/${blob.uploadId}`
        : `stable/${blob.purpose}/sha256/${blob.sha256}`;
    return `${this.prefix}/tenants/${blob.tenantId}/${suffix}`;
  }

  private async assertWritten(key: string, descriptor: BlobDescriptor): Promise<void> {
    const metadata = await this.client.head(key);
    if (metadata === undefined) {
      throw new BlobStoreError("BLOB_RESULT_UNKNOWN", "写操作返回成功但对象不可见", {
        result: "unknown",
      });
    }
    assertStoredDescriptor(metadata, descriptor);
  }

  private async writeActuallySucceeded(key: string, descriptor: BlobDescriptor): Promise<boolean> {
    try {
      const metadata = await this.client.head(key);
      if (metadata === undefined) {
        return false;
      }
      assertStoredDescriptor(metadata, descriptor);
      return true;
    } catch (error) {
      if (error instanceof BlobStoreError && error.code === "BLOB_INTEGRITY_MISMATCH") {
        throw error;
      }
      return false;
    }
  }
}

export function createS3BlobStore(config: CreateS3BlobStoreConfig): S3BlobStore {
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
  return new S3BlobStore(new AwsS3ObjectClient(client, presignClient, config.bucket), config);
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

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (result.Body === undefined) {
        throw new BlobStoreError("BLOB_INTEGRITY_MISMATCH", "对象响应没有内容");
      }
      return result.Body.transformToByteArray();
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
        ...(input.downloadName === undefined
          ? {}
          : { ResponseContentDisposition: contentDisposition(input.downloadName) }),
      });
      return await getSignedUrl(this.presignClient, command, { expiresIn: input.ttlSeconds });
    } catch (error) {
      throw awsOperationError(error, false);
    }
  }
}

function assertExpectedDescriptor(input: PutStagingBlobInput, actual: BlobDescriptor): void {
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
  if (
    stored.sha256 !== expected.sha256 ||
    stored.size !== expected.size ||
    stored.mediaType !== expected.mediaType
  ) {
    throw new BlobStoreError(code, "对象键已经存在，但内容描述不一致");
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

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function contentDisposition(downloadName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}
