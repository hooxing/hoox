import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { Pool, PoolClient } from "pg";
import { RUNTIME_BLOB_OBJECT_PREFIX } from "./blob-storage-contract.js";
import type { StableBlobRef } from "./blob-store.js";

const upstreamCommit = "b29e7cf65e5cb78a5ac33d582270551bc74a14eb";
const expectedPackageDigest = "8d95d791ec2800a1b6bb0cadeb20f3ae4ffb8b9a42f02552988d7d0efc976067";
const catalogBlobTenant = "skill_catalog";
const skillId = "skill_anthropic_pptx";
const canonicalKey = "pptx";
const description = "创建、编辑、读取和验证 PPTX/POTX 演示文稿的开发测试技能。";
const compatibility = `Hoox development；上游固定提交 ${upstreamCommit}`;
const metadataFiles = new Set(["SOURCE.md"]);
const maxFiles = 256;
const maxPackageBytes = 32 * 1024 * 1024;

export interface DevelopmentPptxFile {
  readonly path: string;
  readonly mediaType: string;
  readonly body: Uint8Array;
  readonly sizeBytes: number;
  readonly contentDigest: string;
}

export interface DevelopmentPptxPackage {
  readonly upstreamCommit: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly manifest: Uint8Array;
  readonly entrypoint: DevelopmentPptxFile;
  readonly files: readonly DevelopmentPptxFile[];
}

export interface DevelopmentSkillObjectStorageConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** 读取固定 vendor 目录并生成与遍历顺序无关的规范包清单。 */
export async function loadDevelopmentPptxPackage(
  sourceRoot: string,
): Promise<DevelopmentPptxPackage> {
  const root = await realpath(resolve(sourceRoot));
  const source = await lstat(root);
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new TypeError("PPTX Skill 来源必须是普通目录");
  }
  const paths = await collectFiles(root, root);
  const folded = new Set<string>();
  const files: DevelopmentPptxFile[] = [];
  let packageBytes = 0;
  for (const path of paths.sort()) {
    if (metadataFiles.has(path)) continue;
    const foldedPath = path.toLocaleLowerCase("en-US");
    if (folded.has(foldedPath)) throw new TypeError("PPTX Skill 包含大小写冲突路径");
    folded.add(foldedPath);
    const absolute = resolve(root, ...path.split("/"));
    const body = new Uint8Array(await readFile(absolute));
    packageBytes += body.byteLength;
    if (packageBytes > maxPackageBytes) throw new TypeError("PPTX Skill 包超过大小限制");
    files.push(
      Object.freeze({
        path,
        mediaType: mediaTypeFor(path),
        body,
        sizeBytes: body.byteLength,
        contentDigest: digest(body),
      }),
    );
  }
  if (files.length < 1 || files.length > maxFiles) {
    throw new TypeError("PPTX Skill 文件数量无效");
  }
  const entrypoint = files.find((file) => file.path === "SKILL.md");
  const license = files.find((file) => file.path === "LICENSE.txt");
  if (entrypoint === undefined || entrypoint.sizeBytes < 1 || entrypoint.sizeBytes > 64 * 1024) {
    throw new TypeError("PPTX Skill 缺少有效 SKILL.md");
  }
  if (license === undefined || license.sizeBytes < 1) {
    throw new TypeError("PPTX Skill 缺少 LICENSE.txt");
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      upstreamCommit,
      files: files.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        contentDigest: file.contentDigest,
      })),
    }),
  );
  const packageDigest = digest(manifest);
  const sourceMetadata = await readFile(resolve(root, "SOURCE.md"), "utf8");
  if (
    packageDigest !== expectedPackageDigest ||
    !sourceMetadata.includes(`固定提交：\`${upstreamCommit}\``) ||
    !sourceMetadata.includes(`规范包摘要：\`${expectedPackageDigest}\``)
  ) {
    throw new TypeError("PPTX Skill 来源或规范包摘要与固定版本不一致");
  }
  return Object.freeze({
    upstreamCommit,
    version: upstreamCommit,
    packageDigest,
    manifest,
    entrypoint,
    files: Object.freeze(files),
  });
}

/** development-only：先幂等写入固定对象，再原子发布不可变目录版本。 */
export async function publishDevelopmentPptxSkill(input: {
  readonly sourceRoot: string;
  readonly pool: Pool;
  readonly objectStorage: DevelopmentSkillObjectStorageConfiguration;
}): Promise<{
  readonly version: string;
  readonly fileCount: number;
  readonly packageDigest: string;
}> {
  const skill = await loadDevelopmentPptxPackage(input.sourceRoot);
  const s3 = new S3Client(s3Configuration(input.objectStorage));
  try {
    const fileRefs = new Map<string, StableBlobRef>();
    for (const file of skill.files) {
      fileRefs.set(
        file.path,
        await putStableObject(s3, input.objectStorage.bucket, {
          body: file.body,
          digest: file.contentDigest,
          mediaType: file.mediaType,
        }),
      );
    }
    const packageRef = await putStableObject(s3, input.objectStorage.bucket, {
      body: skill.manifest,
      digest: skill.packageDigest,
      mediaType: "application/vnd.cube.skill-manifest+json",
    });
    await publishCatalogRows(input.pool, skill, fileRefs, packageRef);
    return Object.freeze({
      version: skill.version,
      fileCount: skill.files.length,
      packageDigest: skill.packageDigest,
    });
  } finally {
    s3.destroy();
  }
}

async function collectFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new TypeError("PPTX Skill 不允许符号链接");
    if (info.isDirectory()) {
      paths.push(...(await collectFiles(root, absolute)));
      continue;
    }
    if (!info.isFile()) throw new TypeError("PPTX Skill 只允许普通文件");
    const normalized = relative(root, absolute).split(sep).join("/").normalize("NFC");
    if (
      normalized.length < 1 ||
      normalized.length > 1_024 ||
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      normalized
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new TypeError("PPTX Skill 包含无效路径");
    }
    paths.push(normalized);
  }
  return paths;
}

async function putStableObject(
  client: S3Client,
  bucket: string,
  input: { readonly body: Uint8Array; readonly digest: string; readonly mediaType: string },
): Promise<StableBlobRef> {
  const incarnationId = deterministicUuidV4(input.digest);
  const physicalObjectKey = `${RUNTIME_BLOB_OBJECT_PREFIX}/stable/${catalogBlobTenant}/skill/sha256/${input.digest}/incarnations/${incarnationId}`;
  const blob = Object.freeze({
    kind: "stable" as const,
    tenantId: catalogBlobTenant,
    purpose: "skill" as const,
    sha256: input.digest,
    size: input.body.byteLength,
    mediaType: input.mediaType,
    incarnationId,
    physicalObjectKey,
  });
  const existing = await headDescriptor(client, bucket, physicalObjectKey);
  if (existing === undefined) {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: physicalObjectKey,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentType: input.mediaType,
          Metadata: { sha256: input.digest },
          CacheControl: "private, no-store",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
    }
  }
  const stored = await headDescriptor(client, bucket, physicalObjectKey);
  if (
    stored === undefined ||
    stored.size !== blob.size ||
    stored.mediaType !== blob.mediaType ||
    stored.sha256 !== blob.sha256
  ) {
    throw new Error("PPTX Skill 对象完整性校验失败");
  }
  const downloaded = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: physicalObjectKey }),
  );
  const body = await downloaded.Body?.transformToByteArray();
  if (body === undefined || body.byteLength !== blob.size || digest(body) !== blob.sha256) {
    throw new Error("PPTX Skill 对象正文校验失败");
  }
  return blob;
}

async function headDescriptor(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<
  { readonly size: number; readonly mediaType: string; readonly sha256: string } | undefined
> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (
      head.ContentLength === undefined ||
      head.ContentType === undefined ||
      head.Metadata?.sha256 === undefined
    ) {
      throw new Error("PPTX Skill 对象缺少完整性元数据");
    }
    return { size: head.ContentLength, mediaType: head.ContentType, sha256: head.Metadata.sha256 };
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw error;
  }
}

async function publishCatalogRows(
  pool: Pool,
  skill: DevelopmentPptxPackage,
  fileRefs: ReadonlyMap<string, StableBlobRef>,
  packageRef: StableBlobRef,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const existing = await client.query<{
      readonly id: string;
      readonly canonical_key: string;
      readonly publisher: string;
    }>("SELECT id,canonical_key,publisher FROM skills WHERE id=$1 OR canonical_key=$2 FOR UPDATE", [
      skillId,
      canonicalKey,
    ]);
    const current = existing.rows[0];
    if (
      existing.rows.length > 1 ||
      (current !== undefined &&
        (current.id !== skillId ||
          current.canonical_key !== canonicalKey ||
          current.publisher !== "Anthropic"))
    ) {
      throw new Error("PPTX Skill 目录键已被其他发布者占用");
    }
    if (current === undefined) {
      await client.query(
        `INSERT INTO skills(id,canonical_key,publisher,display_name,recommended_version,status)
         VALUES ($1,$2,'Anthropic','PPTX',$3,'active')`,
        [skillId, canonicalKey, skill.version],
      );
    }
    const packageBlobRef = JSON.stringify(packageRef);
    await client.query(
      `INSERT INTO skill_versions(
         skill_id,version,description,compatibility,package_digest,entrypoint_path,
         entrypoint_digest,package_blob_ref,security_status,status
       ) VALUES ($1,$2,$3,$4,$5,'SKILL.md',$6,$7,'restricted','available')
       ON CONFLICT (skill_id,version) DO NOTHING`,
      [
        skillId,
        skill.version,
        description,
        compatibility,
        skill.packageDigest,
        skill.entrypoint.contentDigest,
        packageBlobRef,
      ],
    );
    await assertVersionMatches(client, skill, packageBlobRef);
    for (const file of skill.files) {
      const blob = fileRefs.get(file.path);
      if (blob === undefined) throw new Error("PPTX Skill 文件对象引用缺失");
      await client.query(
        `INSERT INTO skill_version_files(
           skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (skill_id,skill_version,normalized_path) DO NOTHING`,
        [
          skillId,
          skill.version,
          file.path,
          file.mediaType,
          file.sizeBytes,
          file.contentDigest,
          JSON.stringify(blob),
        ],
      );
    }
    await assertFilesMatch(client, skill, fileRefs);
    await client.query(
      `UPDATE skills SET display_name='PPTX',recommended_version=$2,status='active',updated_at=clock_timestamp()
       WHERE id=$1`,
      [skillId, skill.version],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertVersionMatches(
  client: PoolClient,
  skill: DevelopmentPptxPackage,
  packageBlobRef: string,
): Promise<void> {
  const result = await client.query<{
    readonly description: string;
    readonly compatibility: string;
    readonly package_digest: string;
    readonly entrypoint_path: string;
    readonly entrypoint_digest: string;
    readonly package_blob_ref: string;
    readonly security_status: string;
    readonly status: string;
  }>(
    `SELECT description,compatibility,package_digest,entrypoint_path,
            entrypoint_digest,package_blob_ref,security_status,status
       FROM skill_versions WHERE skill_id=$1 AND version=$2`,
    [skillId, skill.version],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.description !== description ||
    row.compatibility !== compatibility ||
    row?.package_digest !== skill.packageDigest ||
    row.entrypoint_path !== "SKILL.md" ||
    row.entrypoint_digest !== skill.entrypoint.contentDigest ||
    row.package_blob_ref !== packageBlobRef ||
    row.security_status !== "restricted" ||
    row.status !== "available"
  ) {
    throw new Error("PPTX Skill 固定版本与既有目录不一致");
  }
}

async function assertFilesMatch(
  client: PoolClient,
  skill: DevelopmentPptxPackage,
  fileRefs: ReadonlyMap<string, StableBlobRef>,
): Promise<void> {
  const result = await client.query<{
    readonly normalized_path: string;
    readonly media_type: string;
    readonly size_bytes: string;
    readonly content_digest: string;
    readonly blob_ref: string;
  }>(
    `SELECT normalized_path,media_type,size_bytes::text,content_digest,blob_ref
       FROM skill_version_files WHERE skill_id=$1 AND skill_version=$2
       ORDER BY normalized_path COLLATE "C"`,
    [skillId, skill.version],
  );
  if (result.rows.length !== skill.files.length) {
    throw new Error("PPTX Skill 文件清单与既有目录不一致");
  }
  for (let index = 0; index < skill.files.length; index += 1) {
    const expected = skill.files[index];
    const actual = result.rows[index];
    const blob = expected === undefined ? undefined : fileRefs.get(expected.path);
    if (
      expected === undefined ||
      actual === undefined ||
      blob === undefined ||
      actual.normalized_path !== expected.path ||
      actual.media_type !== expected.mediaType ||
      Number(actual.size_bytes) !== expected.sizeBytes ||
      actual.content_digest !== expected.contentDigest ||
      actual.blob_ref !== JSON.stringify(blob)
    ) {
      throw new Error("PPTX Skill 文件清单与既有目录不一致");
    }
  }
}

function s3Configuration(input: DevelopmentSkillObjectStorageConfiguration): S3ClientConfig {
  return {
    endpoint: input.endpoint,
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
  };
}

function deterministicUuidV4(hexDigest: string): string {
  const bytes = Uint8Array.from(Buffer.from(hexDigest.slice(0, 32), "hex"));
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (bytes.length !== 16 || byte6 === undefined || byte8 === undefined) {
    throw new TypeError("PPTX Skill 内容摘要无效");
  }
  bytes[6] = (byte6 & 0x0f) | 0x40;
  bytes[8] = (byte8 & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mediaTypeFor(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".py")) return "text/x-python; charset=utf-8";
  if (path.endsWith(".xsd")) return "application/xml";
  throw new TypeError(`PPTX Skill 包含未登记媒体类型：${path}`);
}

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
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

function isPreconditionFailure(error: unknown): boolean {
  const value = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
}
