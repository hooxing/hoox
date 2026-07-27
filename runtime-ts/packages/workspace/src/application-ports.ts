import type {
  WorkspaceContentIdentity,
  WorkspaceManifest,
  WorkspaceManifestPolicy,
  WorkspaceStableObjectIdentity,
} from "./manifest.js";

export interface WorkspaceTrustedScope {
  readonly tenantId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

export interface SandboxSessionIdentity {
  readonly sessionId: string;
  readonly generation: number;
}

export interface SandboxWorkspaceSnapshot extends SandboxSessionIdentity {
  readonly snapshotToken: string;
}

export interface WorkspaceOperationIdentity extends WorkspaceTrustedScope {
  readonly schemaVersion: 1;
  readonly digestAlgorithm: "workspace-operation-v2";
  readonly operationKey: string;
  readonly kind: "materialize" | "publish";
  readonly inputDigest: string;
  readonly sandbox: SandboxSessionIdentity;
  readonly snapshotToken?: string;
}

export interface ValidatedWorkspaceChange extends WorkspaceTrustedScope {
  readonly kind: "validated_workspace_change";
  readonly operationKey: string;
  readonly sandboxSnapshot: SandboxWorkspaceSnapshot;
  readonly baseManifestDigest?: string;
  readonly candidateManifest: WorkspaceManifest;
  readonly verifiedAt: string;
}

export type WorkspaceOperationResult =
  | {
      readonly kind: "materialized";
      readonly operationKey: string;
      readonly scope: WorkspaceTrustedScope;
      readonly sandbox: SandboxSessionIdentity;
      readonly targetManifestDigest: string;
    }
  | {
      readonly kind: "published";
      readonly operationKey: string;
      readonly change: ValidatedWorkspaceChange;
    };

/** Journal 属于 unknown 边界，端口实现返回值必须由应用核心完整解析。 */
export type WorkspaceOperationBeginResult = unknown;

export interface WorkspaceUnknownFact {
  readonly operationKey: string;
  readonly kind: "materialize" | "publish";
  readonly inputDigest: string;
  readonly phase: string;
  readonly dependencyCode: string;
  readonly occurredAt: string;
}

export type WorkspaceKnownFailureDisposition = "retryable" | "terminal";

/**
 * operationKey 首次 begin 后必须永久绑定完整 identity。known failure 只改变状态，不删除绑定；
 * retryable 可由同 digest 重入，terminal 永久失败；任何不同 digest 永久 conflict。
 */
export interface WorkspaceOperationJournalPort {
  begin(identity: WorkspaceOperationIdentity): Promise<WorkspaceOperationBeginResult>;
  complete(identity: WorkspaceOperationIdentity, result: WorkspaceOperationResult): Promise<void>;
  failKnown(input: {
    readonly identity: WorkspaceOperationIdentity;
    readonly phase: string;
    readonly code: string;
    readonly disposition: WorkspaceKnownFailureDisposition;
  }): Promise<void>;
  /** CAS running→unknown；若 complete 已提交，必须保留 completed，绝不能降级。 */
  recordUnknown(identity: WorkspaceOperationIdentity, fact: WorkspaceUnknownFact): Promise<void>;
}

export interface WorkspaceStableAuthorizationReceipt {
  readonly authorizationId: string;
  readonly tenantId: string;
  readonly purpose: "workspace";
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
}

export interface WorkspaceStableBlobReadPort {
  authorize(input: {
    readonly scope: WorkspaceTrustedScope;
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

/** 所有相对路径都绑定端口返回的 session/generation；适配器必须在每次调用时拒绝代际漂移。 */
export interface SandboxWorkspacePort {
  currentSession(): Promise<SandboxSessionIdentity>;
  /** 同 operationKey 必须返回同一不可变快照，便于 abort/部分上传后恢复。 */
  captureSnapshot(input: {
    readonly operationKey: string;
    readonly scope: WorkspaceTrustedScope;
  }): Promise<SandboxWorkspaceSnapshot>;
  /** operation 进入任一终态后释放其进程内/远端快照；同 key capture 与 release 必须原子互斥。 */
  releaseSnapshots(input: {
    readonly sandbox: SandboxSessionIdentity;
    readonly operationKey: string;
  }): Promise<void>;
  inspectRegularFile(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<
    | { readonly status: "missing" }
    | { readonly status: "regular"; readonly body: AsyncIterable<Uint8Array> }
    | { readonly status: "unsafe"; readonly kind: "directory" | "symlink" | "special" }
  >;
  removeFile(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  removeDirectory(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  /** 只用于验证阶段发现的目录类型漂移；递归删除不得跟随 symlink。 */
  removeUnexpectedDirectory(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  ensureDirectory(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  /** 同目录临时普通文件写完并校验 EOF 后，以 POSIX rename 原子替换文件或 symlink；目录须先删除。 */
  writeFileAtomically(input: {
    readonly sandbox: SandboxSessionIdentity;
    readonly relativePath: string;
    readonly operationKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  listWorkspace(
    snapshot: SandboxWorkspaceSnapshot,
    control?: { readonly signal?: AbortSignal },
  ): AsyncIterable<SandboxWorkspaceEntry>;
  readRegularFile(
    snapshot: SandboxWorkspaceSnapshot,
    relativePath: string,
    control?: { readonly signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;
}

export interface WorkspaceCandidateBlob {
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
}

export interface WorkspaceCandidateBlobWritePort {
  putCandidate(input: {
    readonly scope: WorkspaceTrustedScope;
    readonly purpose: "workspace";
    readonly operationKey: string;
    readonly relativePath: string;
    readonly expectedContent: WorkspaceContentIdentity;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceCandidateBlob>;
  headCandidate(input: {
    readonly scope: WorkspaceTrustedScope;
    readonly blob: WorkspaceCandidateBlob;
  }): Promise<
    | { readonly status: "exists"; readonly blob: WorkspaceCandidateBlob }
    | { readonly status: "not_found" }
  >;
}

export interface WorkspaceExecutionPolicy {
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxSingleFileBytes: number;
  readonly maxChunkBytes: number;
  readonly maxPathUtf8Bytes: number;
  readonly historicalManifest: WorkspaceManifestPolicy;
}
