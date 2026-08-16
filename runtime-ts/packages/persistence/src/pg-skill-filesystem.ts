import { createHash } from "node:crypto";
import {
  assertSkillFilesystemEntry,
  assertSkillFilesystemFile,
  assertSkillFilesystemSegment,
  SKILL_FILESYSTEM_METADATA_FILE,
  type SkillFilesystemCatalog,
  type SkillFilesystemEntry,
  type SkillFilesystemFile,
} from "@aisay/skill";
import type { Pool, PoolClient } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const maxPackageFiles = 256;

interface SkillKeyRow {
  readonly canonical_key: string;
}

interface SkillMetadataRow {
  readonly canonical_key: string;
  readonly display_name: string;
  readonly publisher: string;
  readonly description: string;
  readonly recommended_version: string;
  readonly compatibility: string;
  readonly security_status: "verified" | "restricted";
}

interface SkillVersionRow {
  readonly version: string;
}

interface SkillFileRow {
  readonly normalized_path: string;
  readonly media_type: string;
  readonly size_bytes: string;
  readonly content_digest: string;
  readonly blob_ref: string;
}

interface MarketMetadata {
  readonly row: SkillMetadataRow;
  readonly versions: readonly string[];
  readonly body: Uint8Array;
  readonly digest: string;
}

/** 全局公开 Skill 市场投影；用户安装关系不参与文件可见性。 */
export class PgSkillFilesystemCatalog implements SkillFilesystemCatalog {
  constructor(private readonly pool: Pool) {}

  async listDirectory(
    input: Parameters<SkillFilesystemCatalog["listDirectory"]>[0],
  ): Promise<readonly SkillFilesystemEntry[] | undefined> {
    const segments = validSegments(input.segments);
    if (segments === undefined) return undefined;
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.tenantId },
        async (client) => {
          if (segments.length === 0) return listMarketSkills(client);
          const canonicalKey = segments[0];
          if (canonicalKey === undefined || !canonicalKeyPattern.test(canonicalKey)) {
            return undefined;
          }
          if (segments.length === 1) return listSkillVersions(client, canonicalKey);
          const version = segments[1];
          if (version === undefined || !versionPattern.test(version)) return undefined;
          const files = await listVersionFiles(client, canonicalKey, version);
          if (files.length === 0) return undefined;
          return packageDirectoryEntries(files, segments.slice(2));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出 Skill 虚拟文件系统");
    }
  }

  async resolveFile(
    input: Parameters<SkillFilesystemCatalog["resolveFile"]>[0],
  ): Promise<SkillFilesystemFile | undefined> {
    const segments = validSegments(input.segments);
    if (segments === undefined || segments.length < 2) return undefined;
    const canonicalKey = segments[0];
    if (canonicalKey === undefined || !canonicalKeyPattern.test(canonicalKey)) return undefined;
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.tenantId },
        async (client) => {
          if (segments.length === 2 && segments[1] === SKILL_FILESYSTEM_METADATA_FILE) {
            const metadata = await readMarketMetadata(client, canonicalKey);
            return metadata === undefined ? undefined : inlineMetadataFile(metadata);
          }
          const version = segments[1];
          if (version === undefined || !versionPattern.test(version) || segments.length < 3) {
            return undefined;
          }
          const relativePath = segments.slice(2).join("/");
          if (Buffer.byteLength(relativePath, "utf8") > 1_024) return undefined;
          const result = await client.query<SkillFileRow>(
            `${versionFilesQuery}
               AND file.normalized_path=$3`,
            [canonicalKey, version, relativePath],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : blobFile(row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析 Skill 虚拟文件系统路径");
    }
  }
}

async function listMarketSkills(client: PoolClient): Promise<readonly SkillFilesystemEntry[]> {
  const result = await client.query<SkillKeyRow>(
    `SELECT skill.canonical_key
       FROM skills skill
       JOIN skill_versions recommended
         ON recommended.skill_id=skill.id AND recommended.version=skill.recommended_version
      WHERE skill.status='active' AND recommended.status='available'
      ORDER BY skill.canonical_key COLLATE "C"`,
  );
  return freezeEntries(
    result.rows.map((row) => ({ kind: "directory" as const, name: row.canonical_key })),
  );
}

async function listSkillVersions(
  client: PoolClient,
  canonicalKey: string,
): Promise<readonly SkillFilesystemEntry[] | undefined> {
  const metadata = await readMarketMetadata(client, canonicalKey);
  if (metadata === undefined) return undefined;
  return freezeEntries([
    metadataEntry(metadata),
    ...metadata.versions.map((version) => ({ kind: "directory" as const, name: version })),
  ]);
}

async function readMarketMetadata(
  client: PoolClient,
  canonicalKey: string,
): Promise<MarketMetadata | undefined> {
  const metadataResult = await client.query<SkillMetadataRow>(
    `SELECT skill.canonical_key,skill.display_name,skill.publisher,
            recommended.description,skill.recommended_version,
            recommended.compatibility,recommended.security_status
       FROM skills skill
       JOIN skill_versions recommended
         ON recommended.skill_id=skill.id AND recommended.version=skill.recommended_version
      WHERE skill.canonical_key=$1 AND skill.status='active' AND recommended.status='available'`,
    [canonicalKey],
  );
  const row = metadataResult.rows[0];
  if (row === undefined) return undefined;
  const versionsResult = await client.query<SkillVersionRow>(
    `SELECT version.version
       FROM skill_versions version
       JOIN skills skill ON skill.id=version.skill_id
      WHERE skill.canonical_key=$1 AND skill.status='active' AND version.status='available'
      ORDER BY version.version COLLATE "C"`,
    [canonicalKey],
  );
  const versions = Object.freeze(versionsResult.rows.map((version) => version.version));
  const body = new TextEncoder().encode(
    `${JSON.stringify({
      schemaVersion: 1,
      canonicalKey: row.canonical_key,
      displayName: row.display_name,
      publisher: row.publisher,
      description: row.description,
      recommendedVersion: row.recommended_version,
      availableVersions: versions,
      compatibility: row.compatibility,
      securityStatus: row.security_status,
    })}\n`,
  );
  return Object.freeze({ row, versions, body, digest: sha256(body) });
}

async function listVersionFiles(
  client: PoolClient,
  canonicalKey: string,
  version: string,
): Promise<readonly SkillFileRow[]> {
  const result = await client.query<SkillFileRow>(
    `${versionFilesQuery}
       ORDER BY file.normalized_path COLLATE "C"
       LIMIT ${maxPackageFiles + 1}`,
    [canonicalKey, version],
  );
  if (result.rows.length > maxPackageFiles) throw new Error("Skill 包文件数量无效");
  return result.rows;
}

const versionFilesQuery = `SELECT file.normalized_path,file.media_type,file.size_bytes::text,
                                  file.content_digest,file.blob_ref
                             FROM skills skill
                             JOIN skill_versions recommended
                               ON recommended.skill_id=skill.id
                              AND recommended.version=skill.recommended_version
                              AND recommended.status='available'
                             JOIN skill_versions version
                               ON version.skill_id=skill.id AND version.version=$2
                              AND version.status='available'
                             JOIN skill_version_files file
                               ON file.skill_id=version.skill_id AND file.skill_version=version.version
                            WHERE skill.canonical_key=$1 AND skill.status='active'`;

function packageDirectoryEntries(
  rows: readonly SkillFileRow[],
  directorySegments: readonly string[],
): readonly SkillFilesystemEntry[] | undefined {
  const entries = new Map<string, SkillFilesystemEntry>();
  let directoryExists = directorySegments.length === 0;
  for (const row of rows) {
    const fileSegments = row.normalized_path.split("/");
    if (!startsWithSegments(fileSegments, directorySegments)) continue;
    const remaining = fileSegments.slice(directorySegments.length);
    if (remaining.length === 0) continue;
    directoryExists = true;
    const name = remaining[0];
    if (name === undefined) continue;
    const candidate: SkillFilesystemEntry =
      remaining.length === 1
        ? fileEntry(name, row)
        : Object.freeze({ kind: "directory" as const, name });
    const existing = entries.get(name);
    if (existing !== undefined && existing.kind !== candidate.kind) {
      throw new Error("Skill 包文件与目录路径冲突");
    }
    entries.set(name, candidate);
  }
  if (!directoryExists) return undefined;
  return freezeEntries([...entries.values()].sort(compareEntries));
}

function metadataEntry(metadata: MarketMetadata): SkillFilesystemEntry {
  return Object.freeze({
    kind: "file" as const,
    name: SKILL_FILESYSTEM_METADATA_FILE,
    mediaType: "application/json",
    sizeBytes: metadata.body.byteLength,
    contentDigest: metadata.digest,
  });
}

function inlineMetadataFile(metadata: MarketMetadata): SkillFilesystemFile {
  const file: SkillFilesystemFile = {
    mediaType: "application/json",
    sizeBytes: metadata.body.byteLength,
    contentDigest: metadata.digest,
    source: { kind: "inline", body: metadata.body },
  };
  assertSkillFilesystemFile(file);
  return Object.freeze(file);
}

function fileEntry(name: string, row: SkillFileRow): SkillFilesystemEntry {
  const entry: SkillFilesystemEntry = {
    kind: "file",
    name,
    mediaType: row.media_type,
    sizeBytes: parseSize(row.size_bytes),
    contentDigest: row.content_digest,
  };
  assertSkillFilesystemEntry(entry);
  return Object.freeze(entry);
}

function blobFile(row: SkillFileRow): SkillFilesystemFile {
  const file: SkillFilesystemFile = {
    mediaType: row.media_type,
    sizeBytes: parseSize(row.size_bytes),
    contentDigest: row.content_digest,
    source: { kind: "blob", blobRef: row.blob_ref },
  };
  assertSkillFilesystemFile(file);
  return Object.freeze(file);
}

function validSegments(input: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(input) || input.length > 258) return undefined;
  try {
    for (const segment of input) assertSkillFilesystemSegment(segment);
  } catch {
    return undefined;
  }
  return [...input];
}

function parseSize(value: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Skill 文件大小无效");
  return size;
}

function startsWithSegments(value: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => value[index] === segment);
}

function compareEntries(left: SkillFilesystemEntry, right: SkillFilesystemEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function freezeEntries(entries: readonly SkillFilesystemEntry[]): readonly SkillFilesystemEntry[] {
  for (const entry of entries) assertSkillFilesystemEntry(entry);
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
