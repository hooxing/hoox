import { ResourceServiceError, resourceInvariant } from "./errors.js";

const MAX_PATH_BYTES = 1_024;
const MAX_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/iu;

/**
 * Workspace 的逻辑路径统一使用 POSIX 相对路径。这里仅做平台无关的词法安全检查；
 * 真实物化时 Workspace 包还必须在 Sandbox 内执行无符号链接逃逸检查。
 */
export function normalizeWorkspaceRelativePath(value: string): string {
  resourceInvariant(typeof value === "string", "INVALID_REQUEST", "目标路径格式无效");
  const normalized = value.normalize("NFKC");
  resourceInvariant(
    normalized === value &&
      normalized.length > 0 &&
      !normalized.startsWith("/") &&
      !normalized.includes("\\") &&
      !normalized.includes(":") &&
      !containsForbiddenUnicode(normalized) &&
      Buffer.byteLength(normalized, "utf8") <= MAX_PATH_BYTES,
    "INVALID_REQUEST",
    "目标路径必须是规范的 Workspace 相对路径",
  );
  const segments = normalized.split("/");
  resourceInvariant(
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.endsWith(".") &&
        !segment.endsWith(" ") &&
        !isWindowsReservedName(segment) &&
        Buffer.byteLength(segment, "utf8") <= MAX_SEGMENT_BYTES,
    ),
    "INVALID_REQUEST",
    "目标路径包含非法片段",
  );
  return normalized;
}

function containsForbiddenUnicode(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function isWindowsReservedName(segment: string): boolean {
  const basename = segment.split(".", 1)[0] ?? "";
  return WINDOWS_RESERVED_BASENAME.test(basename);
}

export function assertResourceName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  // Resource 名称是展示元数据而不是可执行路径；在上传边界统一兼容字符，
  // 避免全角括号等常见中文文件名被误判，同时后续路径仍只使用安全化副本。
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 255 ||
    containsForbiddenUnicode(normalized)
  ) {
    throw new ResourceServiceError("INVALID_REQUEST", "Resource 名称格式无效");
  }
  return normalized;
}
