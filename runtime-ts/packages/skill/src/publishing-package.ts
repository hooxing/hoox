import { createHash } from "node:crypto";
import type {
  SkillPublicationMetadata,
  SkillPublicationUploadFile,
  ValidatedSkillPublicationFile,
  ValidatedSkillPublicationPackage,
} from "./publishing-contracts.js";
import { SkillServiceError, skillInvariant } from "./errors.js";

export const MAX_SKILL_PUBLICATION_FILES = 256;
export const MAX_SKILL_PUBLICATION_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SKILL_PUBLICATION_ENTRYPOINT_BYTES = 64 * 1024;
export const DEFAULT_SKILL_PUBLICATION_COMPATIBILITY = "Agent Skills 标准格式";

const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const mediaTypePattern =
  /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=(?:"[^"\r\n]*"|[\w!#$&^_.+-]+))*$/u;
const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$/u;
const forbiddenExecutableExtension = /\.(?:com|dll|dylib|exe|msi|scr|so)$/iu;
const secretMarker = /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function validateSkillPublicationPackage(input: {
  readonly metadata: SkillPublicationMetadata;
  readonly files: readonly SkillPublicationUploadFile[];
}): ValidatedSkillPublicationPackage {
  const metadata = canonicalMetadata(input.metadata);
  validateMetadata(metadata);
  skillInvariant(
    Array.isArray(input.files) &&
      input.files.length >= 1 &&
      input.files.length <= MAX_SKILL_PUBLICATION_FILES,
    "INVALID_REQUEST",
    "Skill 发布包文件数量无效",
  );

  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const files: ValidatedSkillPublicationFile[] = [];
  let totalBytes = 0;
  for (const candidate of input.files) {
    const path = validatePath(candidate.path);
    const folded = path.toLocaleLowerCase("en-US");
    skillInvariant(
      !paths.has(path) && !foldedPaths.has(folded),
      "INVALID_REQUEST",
      "Skill 发布包包含重复或大小写冲突路径",
    );
    paths.add(path);
    foldedPaths.add(folded);
    skillInvariant(
      mediaTypePattern.test(candidate.mediaType) && candidate.mediaType.length <= 255,
      "INVALID_REQUEST",
      "Skill 发布包媒体类型无效",
    );
    skillInvariant(
      !forbiddenExecutableExtension.test(path),
      "INVALID_REQUEST",
      "Skill 发布包包含禁止的原生可执行文件",
    );
    const body = decodeCanonicalBase64(candidate.contentBase64);
    totalBytes += body.byteLength;
    skillInvariant(
      totalBytes <= MAX_SKILL_PUBLICATION_PACKAGE_BYTES,
      "LIMIT_EXCEEDED",
      "Skill 发布包超过大小限制",
    );
    if (looksLikeText(candidate.mediaType, path)) scanText(body);
    files.push(
      Object.freeze({
        path,
        mediaType: candidate.mediaType,
        sizeBytes: body.byteLength,
        contentDigest: sha256(body),
        body,
      }),
    );
  }
  files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  for (let index = 0; index < files.length - 1; index += 1) {
    const current = files[index];
    const next = files[index + 1];
    skillInvariant(
      current !== undefined && next !== undefined && !next.path.startsWith(`${current.path}/`),
      "INVALID_REQUEST",
      "Skill 发布包包含文件与目录前缀冲突",
    );
  }

  const entrypoint = files.find((file) => file.path === "SKILL.md");
  skillInvariant(
    entrypoint !== undefined &&
      entrypoint.sizeBytes >= 1 &&
      entrypoint.sizeBytes <= MAX_SKILL_PUBLICATION_ENTRYPOINT_BYTES,
    "INVALID_REQUEST",
    "Skill 发布包缺少有效 SKILL.md",
  );
  const entrypointMarkdown = decodeText(entrypoint.body);
  const packageManifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      metadata,
      files: files.map(({ path, mediaType, sizeBytes, contentDigest }) => ({
        path,
        mediaType,
        sizeBytes,
        contentDigest,
      })),
    }),
  );
  const packageDigest = sha256(packageManifest);
  skillInvariant(digestPattern.test(packageDigest), "INVALID_REQUEST", "Skill 包摘要无效");
  return Object.freeze({
    metadata,
    files: Object.freeze(files),
    packageManifest,
    packageDigest,
    entrypointDigest: entrypoint.contentDigest,
    entrypointMarkdown,
    totalBytes,
  });
}

function canonicalMetadata(metadata: SkillPublicationMetadata): SkillPublicationMetadata {
  // 固定字段顺序，避免等价 JSON 因调用方属性插入顺序不同而产生不同包摘要。
  return Object.freeze({
    canonicalKey: metadata.canonicalKey,
    displayName: metadata.displayName,
    publisher: metadata.publisher,
    version: metadata.version,
    description: metadata.description,
    compatibility: metadata.compatibility,
    sourceUrl: metadata.sourceUrl,
    sourceRevision: metadata.sourceRevision,
    licenseSpdx: metadata.licenseSpdx,
  });
}

function validateMetadata(metadata: SkillPublicationMetadata): void {
  skillInvariant(
    canonicalKeyPattern.test(metadata.canonicalKey),
    "INVALID_REQUEST",
    "Skill 规范键无效",
  );
  skillInvariant(versionPattern.test(metadata.version), "INVALID_REQUEST", "Skill 版本无效");
  plainText(metadata.displayName, 200, "Skill 显示名称无效");
  plainText(metadata.publisher, 200, "Skill 发布者无效");
  plainText(metadata.description, 2_048, "Skill 描述无效");
  plainText(metadata.compatibility, 500, "Skill 兼容性无效");
  optionalPlainText(metadata.sourceRevision, 200, "Skill 来源版本无效");
  skillInvariant(spdxPattern.test(metadata.licenseSpdx), "INVALID_REQUEST", "Skill 许可证无效");
  if (metadata.sourceUrl.length === 0) return;
  let source: URL;
  try {
    source = new URL(metadata.sourceUrl);
  } catch {
    throw new SkillServiceError("INVALID_REQUEST", "Skill 来源地址无效");
  }
  skillInvariant(
    (source.protocol === "https:" || source.protocol === "http:") &&
      source.username.length === 0 &&
      source.password.length === 0 &&
      metadata.sourceUrl.length <= 2_048,
    "INVALID_REQUEST",
    "Skill 来源地址无效",
  );
}

function optionalPlainText(value: string, maxLength: number, message: string): void {
  if (value.length === 0) return;
  plainText(value, maxLength, message);
}

function validatePath(value: string): string {
  const normalized = value.normalize("NFC");
  const segments = normalized.split("/");
  skillInvariant(
    value === normalized &&
      value.length >= 1 &&
      Buffer.byteLength(value, "utf8") <= 1_024 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !hasForbiddenPathCharacter(segment),
      ),
    "INVALID_REQUEST",
    "Skill 发布包路径无效",
  );
  return normalized;
}

function decodeCanonicalBase64(value: string): Uint8Array {
  skillInvariant(
    value.length > 0 && value.length <= 45 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value),
    "INVALID_REQUEST",
    "Skill 文件内容编码无效",
  );
  const body = Buffer.from(value, "base64");
  skillInvariant(
    body.toString("base64") === value,
    "INVALID_REQUEST",
    "Skill 文件内容编码不是规范 Base64",
  );
  return new Uint8Array(body);
}

function looksLikeText(mediaType: string, path: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    /\.(?:cjs|css|html|js|json|jsx|md|mjs|py|sh|svg|toml|ts|tsx|txt|xml|yaml|yml)$/iu.test(path)
  );
}

function scanText(body: Uint8Array): void {
  const text = decodeText(body);
  skillInvariant(!secretMarker.test(text), "INVALID_REQUEST", "Skill 发布包疑似包含秘密值");
}

function decodeText(body: Uint8Array): string {
  try {
    return utf8.decode(body);
  } catch {
    throw new SkillServiceError("INVALID_REQUEST", "Skill 文本文件不是有效 UTF-8");
  }
}

function plainText(value: string, maxBytes: number, message: string): void {
  skillInvariant(
    value.trim() === value &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= maxBytes &&
      !hasControl(value),
    "INVALID_REQUEST",
    message,
  );
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function hasForbiddenPathCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return (
      point !== undefined &&
      (point <= 31 ||
        point === 127 ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069) ||
        point === 0x200b ||
        point === 0x200c ||
        point === 0x200d ||
        point === 0xfeff)
    );
  });
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
