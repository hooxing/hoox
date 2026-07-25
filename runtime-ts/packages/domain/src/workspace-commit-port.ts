import type { Workspace, WorkspaceRevisionCommit } from "./content.js";
import type { RunId, TenantId } from "./ids.js";

export interface WorkspaceWriteScope {
  readonly tenantId: TenantId;
  readonly rootRunId: RunId;
}

export type WorkspaceCommitResult =
  | { readonly outcome: "committed" }
  | { readonly outcome: "revision_conflict" }
  | { readonly outcome: "lease_lost" };

/**
 * 持久层必须用一次原子条件写同时比较 revision number、writer rootRunId、lease epoch
 * 和数据库时钟下的 expiresAt；领域内存快照本身不能提供并发安全。
 */
export interface WorkspaceRevisionCommitPort {
  compareAndSetLease(
    scope: WorkspaceWriteScope,
    expected: Workspace,
    next: Workspace,
  ): Promise<WorkspaceCommitResult>;
  commitRevision(
    scope: WorkspaceWriteScope,
    command: WorkspaceRevisionCommit,
  ): Promise<WorkspaceCommitResult>;
}
