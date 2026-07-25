import type { Workspace, WorkspaceRevisionCommit } from "./content.js";

export type WorkspaceCommitResult =
  | { readonly outcome: "committed" }
  | { readonly outcome: "revision_conflict" }
  | { readonly outcome: "lease_lost" };

/**
 * 持久层必须用一次原子条件写同时比较 revision number、writer rootRunId、lease epoch
 * 和数据库时钟下的 expiresAt；领域内存快照本身不能提供并发安全。
 */
export interface WorkspaceRevisionCommitPort {
  compareAndSetLease(expected: Workspace, next: Workspace): Promise<WorkspaceCommitResult>;
  commitRevision(command: WorkspaceRevisionCommit): Promise<WorkspaceCommitResult>;
}
