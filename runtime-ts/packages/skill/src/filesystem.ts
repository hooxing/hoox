import type { TenantId } from "@cube-runtime/domain";

export const SKILL_FILESYSTEM_ROOT = "/resources/skills" as const;
export const SKILL_FILESYSTEM_ROOT_SEGMENT = "skills" as const;
export const SKILL_FILESYSTEM_METADATA_FILE = "_metadata.json" as const;
export const MAX_SKILL_FILESYSTEM_FILE_BYTES = 32 * 1024 * 1024;

const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const forbiddenSegmentCharacters = /[\p{Cc}\p{Cf}\p{Cs}\\/]/u;

export type SkillFilesystemEntry =
  | { readonly kind: "directory"; readonly name: string }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly contentDigest: string;
    };

export type SkillFilesystemFileSource =
  | { readonly kind: "blob"; readonly blobRef: string }
  | { readonly kind: "inline"; readonly body: Uint8Array };

export interface SkillFilesystemFile {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  readonly source: SkillFilesystemFileSource;
}

/** Skill 市场目录是全局视图；tenantId 只用于建立最小权限 PostgreSQL RLS 上下文。 */
export interface SkillFilesystemCatalog {
  listDirectory(input: {
    readonly tenantId: TenantId;
    /** 相对于 /resources/skills 的已解码路径段。 */
    readonly segments: readonly string[];
  }): Promise<readonly SkillFilesystemEntry[] | undefined>;

  resolveFile(input: {
    readonly tenantId: TenantId;
    /** 相对于 /resources/skills 的已解码路径段。 */
    readonly segments: readonly string[];
  }): Promise<SkillFilesystemFile | undefined>;
}

export function skillFilesystemPackageRoot(canonicalKey: string, version: string): string {
  if (!canonicalKeyPattern.test(canonicalKey) || !versionPattern.test(version)) {
    throw new TypeError("Skill 文件系统包身份无效");
  }
  return `${SKILL_FILESYSTEM_ROOT}/${canonicalKey}/${version}`;
}

export function assertSkillFilesystemEntry(entry: SkillFilesystemEntry): void {
  assertSkillFilesystemSegment(entry.name);
  if (entry.kind === "directory") return;
  if (
    entry.mediaType.trim().length < 3 ||
    entry.mediaType.length > 255 ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0 ||
    entry.sizeBytes > MAX_SKILL_FILESYSTEM_FILE_BYTES ||
    !digestPattern.test(entry.contentDigest)
  ) {
    throw new TypeError("Skill 文件系统文件元数据无效");
  }
}

export function assertSkillFilesystemFile(file: SkillFilesystemFile): void {
  assertSkillFilesystemEntry({
    kind: "file",
    name: "validated-file",
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    contentDigest: file.contentDigest,
  });
  if (
    (file.source.kind === "blob" &&
      (file.source.blobRef.trim().length === 0 || file.source.blobRef.length > 512)) ||
    (file.source.kind === "inline" && file.source.body.byteLength !== file.sizeBytes)
  ) {
    throw new TypeError("Skill 文件系统文件来源无效");
  }
}

export function assertSkillFilesystemSegment(value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    forbiddenSegmentCharacters.test(value)
  ) {
    throw new TypeError("Skill 文件系统路径段无效");
  }
}
