import { createHash } from "node:crypto";
import { workspaceRevisionId } from "@cube-runtime/domain";
import type { WorkspaceRuntimePort } from "@cube-runtime/run-contracts";
import {
  createWorkspaceManifest,
  WorkspaceMaterializer,
  WorkspacePublisher,
  type SandboxWorkspacePort,
  type WorkspaceCandidateBlobWritePort,
  type WorkspaceExecutionPolicy,
  type WorkspaceManifest,
  type WorkspaceOperationJournalPort,
  type WorkspaceStableBlobReadPort,
  type WorkspaceTrustedScope,
} from "@cube-runtime/workspace";

export interface WorkspaceRevisionFactPort {
  loadCurrentManifest(input: {
    readonly scope: WorkspaceTrustedScope;
    readonly expectedRevisionId?: string;
  }): Promise<WorkspaceManifest | undefined>;
}

export interface WorkerWorkspaceRuntimeOptions {
  readonly journal: WorkspaceOperationJournalPort;
  readonly revisions: WorkspaceRevisionFactPort;
  readonly stableBlobs: WorkspaceStableBlobReadPort;
  readonly candidates: WorkspaceCandidateBlobWritePort;
  readonly openSandboxWorkspace: (input: {
    readonly scope: WorkspaceTrustedScope;
    readonly executionScope: Parameters<WorkspaceRuntimePort["verify"]>[0]["scope"];
    readonly session: Parameters<WorkspaceRuntimePort["verify"]>[0]["sandbox"];
    readonly signal?: AbortSignal;
  }) => Promise<SandboxWorkspacePort>;
  readonly policy: WorkspaceExecutionPolicy;
}

/**
 * Worker 只看 manifest-aware RuntimePort：进入模型前物化已提交 head，模型 settled 后将 Sandbox
 * snapshot 发布为待 RuntimeMutation 原子提交的候选。它从不向 Worker 暴露 BlobStore 或 object key。
 */
export class ManifestWorkspaceRuntime implements WorkspaceRuntimePort {
  constructor(private readonly options: WorkerWorkspaceRuntimeOptions) {}

  async materialize(input: Parameters<WorkspaceRuntimePort["materialize"]>[0]): Promise<void> {
    const scope = trustedScope(input.scope);
    const current = await this.options.revisions.loadCurrentManifest({
      scope,
      ...(input.expectedCurrentRevisionId === undefined
        ? {}
        : { expectedRevisionId: input.expectedCurrentRevisionId }),
    });
    const target = current ?? emptyManifest(scope, this.options.policy);
    const sandbox = await this.options.openSandboxWorkspace({
      scope,
      executionScope: input.scope,
      session: input.sandbox,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await new WorkspaceMaterializer({
      journal: this.options.journal,
      stableBlobs: this.options.stableBlobs,
      sandbox,
      policy: this.options.policy,
    }).materialize({
      operationKey: input.operationKey,
      scope,
      target,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async verify(input: Parameters<WorkspaceRuntimePort["verify"]>[0]) {
    const scope = trustedScope(input.scope);
    const base = await this.options.revisions.loadCurrentManifest({
      scope,
      ...(input.expectedCurrentRevisionId === undefined
        ? {}
        : { expectedRevisionId: input.expectedCurrentRevisionId }),
    });
    const sandbox = await this.options.openSandboxWorkspace({
      scope,
      executionScope: input.scope,
      session: input.sandbox,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const published = await new WorkspacePublisher({
      journal: this.options.journal,
      sandbox,
      blobs: this.options.candidates,
      policy: this.options.policy,
    }).publish({
      operationKey: input.operationKey,
      scope,
      ...(base === undefined ? {} : { base }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // 空 Workspace 或没有任何内容变化不创建无意义 revision；这同时保证跨 Run materialize 的
    // head 不会在纯聊天中漂移。
    if (
      (base === undefined && published.candidateManifest.entries.length === 0) ||
      base?.digest === published.candidateManifest.digest
    ) {
      return undefined;
    }
    return Object.freeze({
      tenantId: input.scope.tenantId,
      threadId: input.scope.threadId,
      workspaceId: input.scope.workspaceId,
      rootRunId: input.scope.rootRunId,
      ...(input.expectedCurrentRevisionId === undefined
        ? {}
        : { parentRevisionId: input.expectedCurrentRevisionId }),
      revisionId: workspaceRevisionId(
        `revision-${revisionSuffix(input.operationKey, published.candidateManifest.digest)}`,
      ),
      manifest: published.candidateManifest,
    });
  }
}

function trustedScope(
  input: Parameters<WorkspaceRuntimePort["verify"]>[0]["scope"],
): WorkspaceTrustedScope {
  return Object.freeze({
    tenantId: input.tenantId,
    threadId: input.threadId,
    workspaceId: input.workspaceId,
  });
}

function emptyManifest(
  scope: WorkspaceTrustedScope,
  policy: WorkspaceExecutionPolicy,
): WorkspaceManifest {
  return createWorkspaceManifest(
    { tenantId: scope.tenantId, entries: [] },
    policy.historicalManifest,
  );
}

function revisionSuffix(operationKey: string, manifestDigest: string): string {
  return createHash("sha256")
    .update(`workspace-revision-v1\0${operationKey}\0${manifestDigest}`)
    .digest("hex")
    .slice(0, 48);
}
