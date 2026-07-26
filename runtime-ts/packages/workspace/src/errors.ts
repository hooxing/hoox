export type WorkspaceManifestErrorCode =
  | "INVALID_MANIFEST"
  | "INVALID_PATH"
  | "PATH_NOT_CANONICAL"
  | "DUPLICATE_PATH"
  | "PATH_CONFLICT"
  | "INVALID_OBJECT_IDENTITY"
  | "TENANT_SCOPE_MISMATCH"
  | "LIMIT_EXCEEDED";

/** Workspace 清单边界只暴露稳定错误码，不泄漏底层实现消息。 */
export class WorkspaceManifestError extends Error {
  readonly code: WorkspaceManifestErrorCode;

  constructor(code: WorkspaceManifestErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceManifestError";
    this.code = code;
  }
}

export function manifestError(
  condition: unknown,
  code: WorkspaceManifestErrorCode,
  message: string,
): asserts condition {
  if (!condition) {
    throw new WorkspaceManifestError(code, message);
  }
}
