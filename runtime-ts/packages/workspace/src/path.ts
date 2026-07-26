import { posix } from "node:path";
import { manifestError } from "./errors.js";

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

/**
 * 校验并返回已经规范化的 POSIX 相对路径。
 *
 * 本函数故意不把 Windows 路径或 Unicode NFD 静默转换成可接受路径，调用方必须先显式修正。
 */
export function workspaceRelativePath(value: unknown): string {
  manifestError(typeof value === "string", "INVALID_PATH", "Workspace 路径必须是字符串");
  manifestError(value.length > 0, "INVALID_PATH", "Workspace 路径不能为空");
  manifestError(
    value.normalize("NFC") === value,
    "PATH_NOT_CANONICAL",
    "Workspace 路径必须使用 Unicode NFC",
  );
  manifestError(!value.startsWith("/"), "INVALID_PATH", "Workspace 路径不能是绝对路径");
  manifestError(!WINDOWS_DRIVE_PREFIX.test(value), "INVALID_PATH", "Workspace 路径不能带盘符");
  manifestError(!value.includes("\\"), "INVALID_PATH", "Workspace 路径不能包含反斜杠");
  manifestError(!containsAsciiControl(value), "INVALID_PATH", "Workspace 路径不能包含控制字符");

  const segments = value.split("/");
  manifestError(
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "INVALID_PATH",
    "Workspace 路径不能包含空段、. 或 ..",
  );
  return value;
}

/** 大小写碰撞键只用于拒绝歧义；清单仍保存用户提供的原始 NFC 大小写。 */
export function workspaceCaseCollisionKey(path: string): string {
  return path.toLowerCase().normalize("NFC");
}

export function assertMaterializationRoot(value: unknown): string {
  manifestError(typeof value === "string", "INVALID_PATH", "物化根目录必须是字符串");
  manifestError(value.startsWith("/"), "INVALID_PATH", "物化根目录必须是 POSIX 绝对路径");
  manifestError(!value.includes("\\"), "INVALID_PATH", "物化根目录不能包含反斜杠");
  manifestError(!containsAsciiControl(value), "INVALID_PATH", "物化根目录不能包含控制字符");
  manifestError(value.normalize("NFC") === value, "PATH_NOT_CANONICAL", "物化根目录必须使用 NFC");
  manifestError(posix.normalize(value) === value, "INVALID_PATH", "物化根目录必须已经规范化");
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
