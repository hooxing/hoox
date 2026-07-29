export type WorkspaceApplicationErrorCode =
  | "INVALID_INPUT"
  | "OPERATION_CONFLICT"
  | "OPERATION_IN_PROGRESS"
  | "ACCESS_DENIED"
  | "INTEGRITY_MISMATCH"
  | "LIMIT_EXCEEDED"
  | "CANCELLED"
  | "UNSAFE_SANDBOX_ENTRY"
  | "DEPENDENCY_FAILED"
  | "RESULT_UNKNOWN";

/** 仅开发期受控日志可用的固定标签；任何未知值都不得离开异常边界。 */
export type WorkspaceApplicationDiagnostic = "candidate_stream_pending";

/** 应用核心只暴露稳定分类；底层路径、对象键和 Provider 消息不得跨边界泄漏。 */
export class WorkspaceApplicationError extends Error {
  constructor(
    readonly code: WorkspaceApplicationErrorCode,
    message: string,
    /** 仅允许固定枚举式诊断，不承载 Provider、路径或对象身份。 */
    readonly diagnostic?: WorkspaceApplicationDiagnostic,
  ) {
    super(message);
    this.name = "WorkspaceApplicationError";
  }
}

/** 仅供本包内部模块使用，不从 package 主入口导出；外部适配器无法伪造核心错误身份。 */
export class WorkspaceCoreApplicationError extends WorkspaceApplicationError {}

export type WorkspaceDependencyResult = "known" | "unknown";

/** 窄端口适配器用它标记远端结果是否确定；cause 只供适配器内部诊断，不向上复制。 */
export class WorkspaceDependencyError extends Error {
  constructor(
    readonly result: WorkspaceDependencyResult,
    readonly dependencyCode: string,
  ) {
    super("Workspace 外部依赖调用失败");
    this.name = "WorkspaceDependencyError";
  }
}
