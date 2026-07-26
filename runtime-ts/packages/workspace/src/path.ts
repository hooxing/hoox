import { posix } from "node:path";
import { manifestError } from "./errors.js";

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;
const WINDOWS_ILLEGAL_CHARACTER = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

export function containsForbiddenCodePoint(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 31 ||
        (codePoint >= 127 && codePoint <= 159) ||
        // Unicode 格式控制字符会制造不可见路径或双向文本歧义，schema v1 全部拒绝。
        /\p{Cf}/u.test(character))
    );
  });
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * 校验并返回已经规范化的 POSIX 相对路径。
 *
 * 本函数故意不把 Windows 路径或 Unicode NFD 静默转换成可接受路径，调用方必须先显式修正。
 */
export function workspaceRelativePath(value: unknown): string {
  manifestError(typeof value === "string", "INVALID_PATH", "Workspace 路径必须是字符串");
  manifestError(value.length > 0, "INVALID_PATH", "Workspace 路径不能为空");
  manifestError(!hasUnpairedSurrogate(value), "INVALID_PATH", "Workspace 路径包含未配对 surrogate");
  manifestError(
    value.normalize("NFC") === value,
    "PATH_NOT_CANONICAL",
    "Workspace 路径必须使用 Unicode NFC",
  );
  manifestError(!value.startsWith("/"), "INVALID_PATH", "Workspace 路径不能是绝对路径");
  manifestError(!WINDOWS_DRIVE_PREFIX.test(value), "INVALID_PATH", "Workspace 路径不能带盘符");
  manifestError(!value.includes("\\"), "INVALID_PATH", "Workspace 路径不能包含反斜杠");
  manifestError(
    !containsForbiddenCodePoint(value),
    "INVALID_PATH",
    "Workspace 路径不能包含控制字符",
  );

  const segments = value.split("/");
  manifestError(
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "INVALID_PATH",
    "Workspace 路径不能包含空段、. 或 ..",
  );
  manifestError(
    segments.every(
      (segment) =>
        !WINDOWS_ILLEGAL_CHARACTER.test(segment) &&
        !segment.endsWith(".") &&
        !segment.endsWith(" ") &&
        !WINDOWS_RESERVED_DEVICE.test(segment),
    ),
    "INVALID_PATH",
    "Workspace 路径包含 Windows 非法字符、保留设备名或歧义尾缀",
  );
  return value;
}

/** schema v1 只折叠 ASCII A-Z；非 ASCII 保持原样，避免依赖运行时 Unicode 表。 */
export function workspaceCaseCollisionKey(path: string): string {
  return path.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

export function assertMaterializationRoot(value: unknown): string {
  manifestError(typeof value === "string", "INVALID_PATH", "物化根目录必须是字符串");
  manifestError(value.startsWith("/"), "INVALID_PATH", "物化根目录必须是 POSIX 绝对路径");
  manifestError(!value.includes("\\"), "INVALID_PATH", "物化根目录不能包含反斜杠");
  manifestError(!hasUnpairedSurrogate(value), "INVALID_PATH", "物化根目录包含未配对 surrogate");
  manifestError(!containsForbiddenCodePoint(value), "INVALID_PATH", "物化根目录不能包含控制字符");
  manifestError(value.normalize("NFC") === value, "PATH_NOT_CANONICAL", "物化根目录必须使用 NFC");
  manifestError(posix.normalize(value) === value, "INVALID_PATH", "物化根目录必须已经规范化");
  manifestError(value === "/" || !value.endsWith("/"), "INVALID_PATH", "物化根目录不能带尾斜线");
  return value;
}

/** 纯字符串解析，不创建或读取宿主目录；返回值始终位于给定 POSIX 根目录内。 */
export function resolveWorkspaceTargetPath(root: string, relativePath: string): string {
  const safeRoot = assertMaterializationRoot(root);
  const safeRelativePath = workspaceRelativePath(relativePath);
  const target = posix.resolve(safeRoot, safeRelativePath);
  const prefix = safeRoot === "/" ? "/" : `${safeRoot}/`;
  manifestError(target.startsWith(prefix), "INVALID_PATH", "物化目标逃逸 Workspace 根目录");
  return target;
}
