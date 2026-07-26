import type {
  WorkspaceContentIdentity,
  WorkspaceManifest,
  WorkspaceStableObjectIdentity,
} from "./manifest.js";

export interface WorkspaceOperationIdentity {
  readonly operationKey: string;
  readonly kind: "materialize" | "publish";
  readonly inputDigest: string;
}

export interface ValidatedWorkspaceChange {
  readonly kind: "validated_workspace_change";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly baseManifestDigest?: string;
  readonly candidateManifest: WorkspaceManifest;
  readonly verifiedAt: string;
}

export type WorkspaceOperationResult =
  | {
      readonly kind: "materialized";
      readonly operationKey: string;
      readonly targetManifestDigest: string;
    }
  | {
      readonly kind: "published";
      readonly operationKey: string;
      readonly change: ValidatedWorkspaceChange;
    };

export type WorkspaceOperationBeginResult =
  | { readonly status: "started" }
  | { readonly status: "completed"; readonly result: WorkspaceOperationResult }
  | { readonly status: "in_progress" | "unknown" | "conflict" };

export interface WorkspaceUnknownFact {
  readonly operationKey: string;
  readonly kind: "materialize" | "publish";
  readonly phase: string;
  readonly dependencyCode: string;
  readonly occurredAt: string;
}

/** 生产实现必须持久化 operationKey、输入摘要和 UNKNOWN 事实。 */
export interface WorkspaceOperationJournalPort {
  begin(identity: WorkspaceOperationIdentity): Promise<WorkspaceOperationBeginResult>;
  /** 幂等完成；响应未知时后续 begin 必须能读回已提交结果或 unknown，不能回到可重发的 started。 */
  complete(identity: WorkspaceOperationIdentity, result: WorkspaceOperationResult): Promise<void>;
  /** 只允许清理仍为 running 的同一输入；不得删除 completed 或 unknown 事实。 */
  failKnown(identity: WorkspaceOperationIdentity, phase: string, code: string): Promise<void>;
  /** 以 CAS 记录 running→unknown；若 complete 已提交，必须保留 completed，绝不能降级覆盖。 */
  recordUnknown(identity: WorkspaceOperationIdentity, fact: WorkspaceUnknownFact): Promise<void>;
}

export interface WorkspaceStableAuthorizationReceipt {
  readonly authorizationId: string;
  readonly tenantId: string;
  readonly purpose: "workspace";
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
}

/** 授权必须来自当前事实源，物理键中的 tenant 字符串本身不构成授权。 */
export interface WorkspaceStableBlobReadPort {
  authorize(input: {
    readonly tenantId: string;
    readonly purpose: "workspace_materialization";
    readonly content: WorkspaceContentIdentity;
    readonly object: WorkspaceStableObjectIdentity;
  }): Promise<
    | { readonly status: "authorized"; readonly receipt: WorkspaceStableAuthorizationReceipt }
    | { readonly status: "denied" | "not_found" }
  >;
  head(receipt: WorkspaceStableAuthorizationReceipt): Promise<
    | {
        readonly status: "exists";
        readonly content: WorkspaceContentIdentity;
        readonly object: WorkspaceStableObjectIdentity;
      }
    | { readonly status: "not_found" }
  >;
  read(
    receipt: WorkspaceStableAuthorizationReceipt,
    control?: { readonly signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;
}

export type SandboxWorkspaceEntryKind = "file" | "directory" | "symlink" | "special";

export interface SandboxWorkspaceEntry {
  readonly relativePath: string;
  readonly kind: SandboxWorkspaceEntryKind;
  readonly size?: number;
}

/**
 * 适配器只能操作自身 Sandbox 中固定的 /workspace。所有参数都是经 schema 校验的相对路径，
 * 禁止实现为宿主 fs 或 shell 拼接；原子写必须采用同目录临时文件、fsync（若支持）和 rename。
 */
export interface SandboxWorkspacePort {
  inspectRegularFile(
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<
    | { readonly status: "missing" }
    | { readonly status: "regular"; readonly body: AsyncIterable<Uint8Array> }
    | { readonly status: "unsafe"; readonly kind: "directory" | "symlink" | "special" }
  >;
  removeFile(relativePath: string, control?: { readonly signal?: AbortSignal }): Promise<void>;
  removeDirectory(relativePath: string, control?: { readonly signal?: AbortSignal }): Promise<void>;
  ensureDirectory(relativePath: string, control?: { readonly signal?: AbortSignal }): Promise<void>;
  /** 返回成功前必须消费 body 到 EOF，并完成同目录临时普通文件到目标的原子 rename。 */
  writeFileAtomically(input: {
    readonly relativePath: string;
    readonly operationKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  listWorkspace(control?: { readonly signal?: AbortSignal }): AsyncIterable<SandboxWorkspaceEntry>;
  readRegularFile(
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;
}

export interface WorkspaceCandidateBlob {
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
}

/** 上传端口内部负责 staging、stable lifecycle 授权与响应未知对账；应用层不会盲目重放。 */
export interface WorkspaceCandidateBlobWritePort {
  /** 返回成功前必须把 body 消费到 EOF；提前返回属于协议错误，不能宣称对象完整。 */
  putCandidate(input: {
    readonly tenantId: string;
    readonly purpose: "workspace";
    readonly operationKey: string;
    readonly relativePath: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceCandidateBlob>;
  headCandidate(input: {
    readonly tenantId: string;
    readonly blob: WorkspaceCandidateBlob;
  }): Promise<
    | { readonly status: "exists"; readonly blob: WorkspaceCandidateBlob }
    | { readonly status: "not_found" }
  >;
}

export interface WorkspaceExecutionPolicy {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxSingleFileBytes: number;
  readonly maxChunkBytes: number;
  readonly maxPathUtf8Bytes: number;
}
