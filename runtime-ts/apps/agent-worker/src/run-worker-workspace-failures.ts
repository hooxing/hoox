// Workspace 候选校验与物化/应用失败的稳定类别映射，诊断输出不含用户内容。
import { WorkspaceApplicationError, WorkspaceDependencyError } from "@hoox/workspace";
import type { ValidatedWorkspaceChange, WorkspaceRevisionCandidate } from "./ports.js";
import { WorkspaceMaterializationStageError } from "./workspace-runtime.js";
import type { ExecutionContext } from "./run-worker-context.js";

export function validateWorkspaceCandidate(
  context: ExecutionContext,
  candidate: WorkspaceRevisionCandidate | undefined,
): ValidatedWorkspaceChange | undefined {
  if (candidate === undefined) return undefined;
  if (
    candidate.tenantId !== context.scope.tenantId ||
    candidate.threadId !== context.scope.threadId ||
    candidate.workspaceId !== context.scope.workspaceId ||
    candidate.rootRunId !== context.scope.rootRunId ||
    candidate.parentRevisionId !== context.currentRevisionId
  ) {
    throw new Error("WORKSPACE_CONFLICT");
  }
  return candidate;
}

/**
 * Run 的公开错误码必须保持稳定，不能把驱动、对象键或路径写入事件；开发进程日志只记录
 * 固定分类，供区分 Workspace head、Sandbox 数据面和依赖结果未知。
 */
export function reportWorkspaceMaterializeFailure(error: unknown): void {
  const category =
    error instanceof WorkspaceMaterializationStageError
      ? workspaceMaterializationCategory(error)
      : error instanceof WorkspaceApplicationError
        ? workspaceApplicationCategory(error)
        : error instanceof WorkspaceDependencyError
          ? workspaceDependencyCategory(error)
          : "unclassified";
  console.warn(`WORKSPACE_MATERIALIZE_FAILED category=${category}`);
}

/** Workspace candidate 发布与物化同样只记录固定分类，避免异常正文越过 Worker 边界。 */
export function reportWorkspaceVerifyFailure(error: unknown): void {
  const category =
    error instanceof WorkspaceApplicationError
      ? workspaceApplicationCategory(error)
      : error instanceof WorkspaceDependencyError
        ? workspaceDependencyCategory(error)
        : "unclassified";
  console.warn(`WORKSPACE_VERIFY_FAILED category=${category}`);
}

export function workspaceMaterializationCategory(
  error: WorkspaceMaterializationStageError,
): string {
  const stage = new Set([
    "load_current_manifest",
    "open_workspace",
    "baseline_snapshot",
    "baseline_list",
    "baseline_release",
    "materializer",
  ]).has(error.stage)
    ? error.stage
    : undefined;
  if (stage === undefined) return "unclassified";
  const detail = new Set([
    "invalid_operation_key",
    "invalid_scope",
    "invalid_sandbox_session",
    "invalid_manifest",
    "invalid_revision",
    "other_application",
    "dependency",
    "unclassified",
  ]).has(error.detail ?? "")
    ? error.detail
    : undefined;
  return `stage_${stage}${detail === undefined ? "" : `_${detail}`}`;
}

export function workspaceApplicationCategory(error: WorkspaceApplicationError): string {
  const code = new Map([
    ["INVALID_INPUT", "invalid_input"],
    ["OPERATION_CONFLICT", "operation_conflict"],
    ["OPERATION_IN_PROGRESS", "operation_in_progress"],
    ["ACCESS_DENIED", "access_denied"],
    ["INTEGRITY_MISMATCH", "integrity_mismatch"],
    ["LIMIT_EXCEEDED", "limit_exceeded"],
    ["CANCELLED", "cancelled"],
    ["UNSAFE_SANDBOX_ENTRY", "unsafe_sandbox_entry"],
    ["DEPENDENCY_FAILED", "dependency_failed"],
    ["RESULT_UNKNOWN", "result_unknown"],
  ]).get(error.code);
  if (code === undefined) return "unclassified";
  return `application_${code}${
    error.diagnostic === "candidate_stream_pending" ? "_candidate_stream_pending" : ""
  }`;
}

export function workspaceDependencyCategory(error: WorkspaceDependencyError): string {
  switch (error.result) {
    case "known":
      return "dependency_known";
    case "unknown":
      return "dependency_unknown";
    default:
      return "unclassified";
  }
}
