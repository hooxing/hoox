import { ResourceServiceError, resourceInvariant } from "./errors.js";

const MAX_PATH_BYTES = 1_024;
const MAX_SEGMENT_BYTES = 255;

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
      !containsControl(normalized) &&
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
        Buffer.byteLength(segment, "utf8") <= MAX_SEGMENT_BYTES,
    ),
    "INVALID_REQUEST",
    "目标路径包含非法片段",
  );
  return normalized;
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

export function assertResourceName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    normalized !== value.trim() ||
    Buffer.byteLength(normalized, "utf8") > 255 ||
    containsControl(normalized)
  ) {
    throw new ResourceServiceError("INVALID_REQUEST", "Resource 名称格式无效");
  }
  return normalized;
}
