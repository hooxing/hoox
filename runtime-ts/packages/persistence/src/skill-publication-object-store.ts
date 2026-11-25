import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { SkillPublicationFileDescriptor, ValidatedSkillPublicationPackage } from "@hoox/skill";
import { RUNTIME_BLOB_OBJECT_PREFIX } from "./blob-storage-contract.js";
import type { StableBlobRef } from "./blob-store.js";
import {
  applyS3ConditionalWrite,
  isS3ObjectAlreadyExists,
  probeS3ObjectReadiness,
  resolveS3ConditionalWrite,
  type S3ConditionalWrite,
} from "./s3-compatibility.js";

const catalogTenantId = "skill_catalog";
const manifestMediaType = "application/vnd.cube.skill-manifest+json";
const digestPattern = /^[0-9a-f]{64}$/u;

export interface StoredSkillPublicationFile extends SkillPublicationFileDescriptor {
  readonly blobRef: string;
}

export interface StoredSkillPublicationPackage {
  readonly packageBlobRef: string;
  readonly files: readonly StoredSkillPublicationFile[];
}

export interface StableSkillPublicationObjectStore {
  publishPackage(
    packageInput: ValidatedSkillPublicationPackage,
  ): Promise<StoredSkillPublicationPackage>;
  read(input: {
    readonly blobRef: string;
    readonly expectedDigest: string;
    readonly expectedSizeBytes: number;
  }): Promise<Uint8Array>;
}

export interface SkillPublicationS3Client {
  send(command: HeadObjectCommand | PutObjectCommand | GetObjectCommand): Promise<unknown>;
  destroy?(): void;
}

export interface S3StableSkillPublisherConfig {
  readonly conditionalWrite?: S3ConditionalWrite;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
  /** 仅供组合根或测试注入；注入时生命周期仍由调用方管理。 */
  readonly client?: SkillPublicationS3Client;
}

/**
 * 管理发布对象使用内容摘要派生固定 incarnation。相同正文无论媒体类型如何都共享物理身份；
 * mediaType 只保留在每个 StableBlobRef 中，读取完整性仍由 size + sha256 决定。
 */
export class S3StableSkillPublisher implements StableSkillPublicationObjectStore {
  private readonly client: SkillPublicationS3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly conditionalWrite: S3ConditionalWrite;

  constructor(config: S3StableSkillPublisherConfig) {
    assertConfiguration(config);
    this.bucket = config.bucket;
    this.conditionalWrite = resolveS3ConditionalWrite(config);
    this.ownsClient = config.client === undefined;
    this.client =
      config.client ??
      (new S3Client(s3Configuration(config)) as unknown as SkillPublicationS3Client);
  }

  async publishPackage(
    packageInput: ValidatedSkillPublicationPackage,
  ): Promise<StoredSkillPublicationPackage> {
    assertPackage(packageInput);
    const files: StoredSkillPublicationFile[] = [];
    for (const file of packageInput.files) {
      const blob = await this.putStable({
        body: file.body,
        digest: file.contentDigest,
        mediaType: file.mediaType,
      });
      files.push(
        Object.freeze({
          path: file.path,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          contentDigest: file.contentDigest,
          blobRef: stringifyStableRef(blob),
        }),
      );
    }
    const manifest = await this.putStable({
      body: packageInput.packageManifest,
      digest: packageInput.packageDigest,
      mediaType: manifestMediaType,
    });
    return Object.freeze({
      packageBlobRef: stringifyStableRef(manifest),
      files: Object.freeze(files),
    });
  }

  /** 与发布领域术语对齐的便捷别名。 */
  publish(packageInput: ValidatedSkillPublicationPackage): Promise<StoredSkillPublicationPackage> {
    return this.publishPackage(packageInput);
  }

  async read(input: {
    readonly blobRef: string;
    readonly expectedDigest: string;
    readonly expectedSizeBytes: number;
  }): Promise<Uint8Array> {
    const blob = parseStableRef(input.blobRef);
    if (
      blob.sha256 !== input.expectedDigest ||
      blob.size !== input.expectedSizeBytes ||
      blob.tenantId !== catalogTenantId ||
      blob.purpose !== "skill" ||
      blob.physicalObjectKey !== stableKey(blob.sha256)
    ) {
      throw new Error("Skill 发布对象引用与期望内容不一致");
    }
    return this.getAndVerify(blob.physicalObjectKey, blob.sha256, blob.size);
  }

  close(): void {
    if (this.ownsClient) this.client.destroy?.();
  }

  async probe(): Promise<void> {
    await probeS3ObjectReadiness(this.client, this.bucket);
  }

  private async putStable(input: {
    readonly body: Uint8Array;
    readonly digest: string;
    readonly mediaType: string;
  }): Promise<StableBlobRef> {
    if (
      !digestPattern.test(input.digest) ||
      createHash("sha256").update(input.body).digest("hex") !== input.digest
    ) {
      throw new TypeError("Skill 发布对象摘要无效");
    }
    const physicalObjectKey = stableKey(input.digest);
    const existing = await this.head(physicalObjectKey);
    if (existing === undefined) {
      try {
        const command = new PutObjectCommand({
          Bucket: this.bucket,
          Key: physicalObjectKey,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentType: input.mediaType,
          Metadata: { sha256: input.digest },
          CacheControl: "private, no-store",
        });
        applyS3ConditionalWrite(command, this.conditionalWrite);
        await this.client.send(command);
      } catch (error) {
        if (!isS3ObjectAlreadyExists(error)) throw error;
      }
    }
    const stored = await this.head(physicalObjectKey);
    if (
      stored === undefined ||
      stored.size !== input.body.byteLength ||
      stored.sha256 !== input.digest
    ) {
      throw new Error("Skill 发布对象 HEAD 完整性校验失败");
    }
    await this.getAndVerify(physicalObjectKey, input.digest, input.body.byteLength);
    return Object.freeze({
      kind: "stable",
      tenantId: catalogTenantId,
      purpose: "skill",
      sha256: input.digest,
      size: input.body.byteLength,
      mediaType: input.mediaType,
      incarnationId: deterministicUuidV4(input.digest),
      physicalObjectKey,
    });
  }

  private async head(
    key: string,
  ): Promise<{ readonly size: number; readonly sha256: string } | undefined> {
    try {
      const value = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        readonly ContentLength?: number;
        readonly Metadata?: Readonly<Record<string, string | undefined>>;
      };
      const sha256 = value.Metadata?.sha256;
      if (value.ContentLength === undefined || sha256 === undefined) {
        throw new Error("Skill 发布对象缺少固定完整性元数据");
      }
      return { size: value.ContentLength, sha256 };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  private async getAndVerify(key: string, expectedDigest: string, expectedSize: number) {
    const value = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { readonly Body?: unknown; readonly ContentLength?: number };
    if (value.Body === undefined || value.ContentLength !== expectedSize) {
      throw new Error("Skill 发布对象 GET 元数据与固定大小不一致");
    }
    const body = await bodyBytes(value.Body, expectedSize);
    if (
      body.byteLength !== expectedSize ||
      createHash("sha256").update(body).digest("hex") !== expectedDigest
    ) {
      throw new Error("Skill 发布对象正文完整性校验失败");
    }
    return body;
  }
}

export async function probeS3StableSkillPublisher(
  publisher: Pick<S3StableSkillPublisher, "probe">,
): Promise<void> {
  await publisher.probe();
}

function assertConfiguration(config: S3StableSkillPublisherConfig): void {
  if (config.bucket.trim().length === 0 || config.region.trim().length === 0) {
    throw new TypeError("Skill 发布对象存储配置无效");
  }
  if ((config.accessKeyId === undefined) !== (config.secretAccessKey === undefined)) {
    throw new TypeError("Skill 发布对象存储凭据必须成对提供");
  }
}

function s3Configuration(config: S3StableSkillPublisherConfig): S3ClientConfig {
  return {
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? false,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.accessKeyId === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey as string,
          },
        }),
  };
}

function assertPackage(packageInput: ValidatedSkillPublicationPackage): void {
  if (
    !digestPattern.test(packageInput.packageDigest) ||
    packageInput.files.length < 1 ||
    packageInput.files.length > 256 ||
    packageInput.files.some(
      (file) =>
        file.body.byteLength !== file.sizeBytes ||
        !digestPattern.test(file.contentDigest) ||
        createHash("sha256").update(file.body).digest("hex") !== file.contentDigest,
    )
  ) {
    throw new TypeError("Skill 发布规范包无效");
  }
}

function stableKey(digest: string): string {
  const incarnationId = deterministicUuidV4(digest);
  return `${RUNTIME_BLOB_OBJECT_PREFIX}/stable/${catalogTenantId}/skill/sha256/${digest}/incarnations/${incarnationId}`;
}

function deterministicUuidV4(digest: string): string {
  if (!digestPattern.test(digest)) throw new TypeError("Skill 发布内容摘要无效");
  const bytes = Uint8Array.from(Buffer.from(digest.slice(0, 32), "hex"));
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined) throw new TypeError("Skill 发布内容摘要无效");
  bytes[6] = (byte6 & 0x0f) | 0x40;
  bytes[8] = (byte8 & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stringifyStableRef(blob: StableBlobRef): string {
  const value = JSON.stringify(blob);
  if (Buffer.byteLength(value, "utf8") > 512) throw new Error("Skill 发布对象引用过长");
  return value;
}

function parseStableRef(value: string): StableBlobRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Skill 发布对象引用无效");
  }
  const blob = parsed as Partial<StableBlobRef>;
  if (
    blob.kind !== "stable" ||
    blob.tenantId !== catalogTenantId ||
    blob.purpose !== "skill" ||
    typeof blob.sha256 !== "string" ||
    !digestPattern.test(blob.sha256) ||
    typeof blob.size !== "number" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 0 ||
    typeof blob.mediaType !== "string" ||
    typeof blob.incarnationId !== "string" ||
    typeof blob.physicalObjectKey !== "string"
  ) {
    throw new TypeError("Skill 发布对象引用无效");
  }
  return blob as StableBlobRef;
}

async function bodyBytes(value: unknown, maximumSize: number): Promise<Uint8Array> {
  if (
    typeof value === "object" &&
    value !== null &&
    "transformToByteArray" in value &&
    typeof value.transformToByteArray === "function"
  ) {
    return new Uint8Array(await value.transformToByteArray());
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !(Symbol.asyncIterator in value) ||
    typeof value[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error("Skill 发布对象响应体不可读取");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const raw of value as AsyncIterable<Uint8Array>) {
    const chunk = new Uint8Array(raw);
    size += chunk.byteLength;
    if (size > maximumSize) throw new Error("Skill 发布对象响应超过固定大小");
    chunks.push(chunk);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isMissingObject(error: unknown): boolean {
  const value = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404
  );
}
