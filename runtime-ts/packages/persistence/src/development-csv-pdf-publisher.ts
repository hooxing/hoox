import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  type SkillPublicationMetadata,
  type SkillPublicationUploadFile,
  type ValidatedSkillPublicationPackage,
  validateSkillPublicationPackage,
} from "@hoox/skill";
import type { Pool, PoolClient } from "pg";
import {
  S3StableSkillPublisher,
  type StoredSkillPublicationPackage,
} from "./skill-publication-object-store.js";

// 已发布目录的持久主键保留 legacy 值；品牌迁移通过不可变新版本表达，不能原地换主键分裂目录。
const skillId = "skill_cube_csv_to_pdf";
const legacyPublisher = "AISay";
const expectedPackageDigest = "84a8d48b82b54cbf24d60c140189ecb1a08cd02ad691f1782104f35b74c1c77c";
const expectedPaths = Object.freeze(["LICENSE.txt", "SKILL.md", "scripts/csv_to_pdf.py"]);
const metadata: SkillPublicationMetadata = Object.freeze({
  canonicalKey: "csv-to-pdf",
  displayName: "CSV 转 PDF",
  publisher: "Hoox",
  version: "1.3.0",
  description: "将 UTF-8 CSV 或 TSV 表格转换为经过完整性校验的 PDF 并交付。",
  compatibility: "Hoox development；LibreOffice Calc 7.4.7；Debian snapshot 20260202",
  sourceUrl: "",
  sourceRevision: "internal-1.3.0",
  licenseSpdx: "LicenseRef-Hoox-Internal",
});

export interface DevelopmentCsvPdfObjectStorageConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export interface DevelopmentCsvPdfPackage extends ValidatedSkillPublicationPackage {
  readonly version: string;
}

/** 只接受仓库固定的 first-party 包，避免 development 命令演变成任意目录发布后门。 */
export async function loadDevelopmentCsvPdfPackage(
  sourceRoot: string,
): Promise<DevelopmentCsvPdfPackage> {
  const requestedRoot = resolve(sourceRoot);
  const requested = await lstat(requestedRoot);
  if (!requested.isDirectory() || requested.isSymbolicLink()) {
    throw new TypeError("CSV 转 PDF Skill 来源必须是普通目录");
  }
  const root = await realpath(requestedRoot);
  const paths = (await collectFiles(root, root)).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    paths.length !== expectedPaths.length ||
    paths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new TypeError("CSV 转 PDF Skill 文件清单与固定版本不一致");
  }
  const files: SkillPublicationUploadFile[] = await Promise.all(
    paths.map(async (path) => ({
      path,
      mediaType: mediaTypeFor(path),
      contentBase64: (await readFile(resolve(root, ...path.split("/")))).toString("base64"),
    })),
  );
  const validated = validateSkillPublicationPackage({ metadata, files });
  if (validated.packageDigest !== expectedPackageDigest) {
    throw new TypeError("CSV 转 PDF Skill 包摘要与固定版本不一致");
  }
  return Object.freeze({ ...validated, version: metadata.version });
}

/** development-only：写入固定对象后，原子发布不可变目录版本。 */
export async function publishDevelopmentCsvPdfSkill(input: {
  readonly sourceRoot: string;
  readonly pool: Pool;
  readonly objectStorage: DevelopmentCsvPdfObjectStorageConfiguration;
}): Promise<{
  readonly version: string;
  readonly fileCount: number;
  readonly packageDigest: string;
}> {
  const skill = await loadDevelopmentCsvPdfPackage(input.sourceRoot);
  const objects = new S3StableSkillPublisher(input.objectStorage);
  try {
    const stored = await objects.publishPackage(skill);
    await publishCatalogRows(input.pool, skill, stored);
    return Object.freeze({
      version: skill.version,
      fileCount: skill.files.length,
      packageDigest: skill.packageDigest,
    });
  } finally {
    objects.close();
  }
}

async function collectFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new TypeError("CSV 转 PDF Skill 不允许符号链接");
    if (info.isDirectory()) {
      paths.push(...(await collectFiles(root, absolute)));
      continue;
    }
    if (!info.isFile()) throw new TypeError("CSV 转 PDF Skill 只允许普通文件");
    paths.push(relative(root, absolute).split(sep).join("/").normalize("NFC"));
  }
  return paths;
}

async function publishCatalogRows(
  pool: Pool,
  skill: DevelopmentCsvPdfPackage,
  stored: StoredSkillPublicationPackage,
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
      metadata.canonicalKey,
    ]);
    const current = existing.rows[0];
    if (
      existing.rows.length > 1 ||
      (current !== undefined &&
        (current.id !== skillId ||
          current.canonical_key !== metadata.canonicalKey ||
          (current.publisher !== metadata.publisher && current.publisher !== legacyPublisher)))
    ) {
      throw new Error("CSV 转 PDF Skill 目录键已被其他发布者占用");
    }
    if (current === undefined) {
      await client.query(
        `INSERT INTO skills(id,canonical_key,publisher,display_name,recommended_version,status)
         VALUES ($1,$2,$3,$4,$5,'active')`,
        [skillId, metadata.canonicalKey, metadata.publisher, metadata.displayName, skill.version],
      );
    }
    await client.query(
      `INSERT INTO skill_versions(
         skill_id,version,description,compatibility,package_digest,entrypoint_path,
         entrypoint_digest,package_blob_ref,security_status,status
       ) VALUES ($1,$2,$3,$4,$5,'SKILL.md',$6,$7,'restricted','available')
       ON CONFLICT (skill_id,version) DO NOTHING`,
      [
        skillId,
        skill.version,
        metadata.description,
        metadata.compatibility,
        skill.packageDigest,
        skill.entrypointDigest,
        stored.packageBlobRef,
      ],
    );
    await assertVersionMatches(client, skill, stored.packageBlobRef);
    for (const file of stored.files) {
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
          file.blobRef,
        ],
      );
    }
    await assertFilesMatch(client, skill, stored);
    await client.query(
      `UPDATE skills
          SET publisher=$2,display_name=$3,recommended_version=$4,status='active',updated_at=clock_timestamp()
        WHERE id=$1`,
      [skillId, metadata.publisher, metadata.displayName, skill.version],
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
  skill: DevelopmentCsvPdfPackage,
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
    `SELECT description,compatibility,package_digest,entrypoint_path,entrypoint_digest,
            package_blob_ref,security_status,status
       FROM skill_versions WHERE skill_id=$1 AND version=$2`,
    [skillId, skill.version],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.description !== metadata.description ||
    row.compatibility !== metadata.compatibility ||
    row.package_digest !== skill.packageDigest ||
    row.entrypoint_path !== "SKILL.md" ||
    row.entrypoint_digest !== skill.entrypointDigest ||
    row.package_blob_ref !== packageBlobRef ||
    row.security_status !== "restricted" ||
    row.status !== "available"
  ) {
    throw new Error("CSV 转 PDF Skill 固定版本与既有目录不一致");
  }
}

async function assertFilesMatch(
  client: PoolClient,
  skill: DevelopmentCsvPdfPackage,
  stored: StoredSkillPublicationPackage,
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
  if (result.rows.length !== stored.files.length) {
    throw new Error("CSV 转 PDF Skill 文件清单与既有目录不一致");
  }
  for (const [index, expected] of stored.files.entries()) {
    const actual = result.rows[index];
    if (
      actual === undefined ||
      actual.normalized_path !== expected.path ||
      actual.media_type !== expected.mediaType ||
      Number(actual.size_bytes) !== expected.sizeBytes ||
      actual.content_digest !== expected.contentDigest ||
      actual.blob_ref !== expected.blobRef
    ) {
      throw new Error("CSV 转 PDF Skill 文件清单与既有目录不一致");
    }
  }
}

function mediaTypeFor(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".py")) return "text/x-python; charset=utf-8";
  throw new TypeError(`CSV 转 PDF Skill 包含未登记媒体类型：${path}`);
}
