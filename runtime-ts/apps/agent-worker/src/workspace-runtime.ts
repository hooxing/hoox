import { createHash } from "node:crypto";
import { sha256Digest, workspaceRevisionId } from "@cube-runtime/domain";
import { workspaceCandidateOperationDigest } from "@cube-runtime/persistence";
import type { WorkspaceRuntimePort } from "@cube-runtime/run-contracts";
import {
  createWorkspaceManifest,
  type SandboxWorkspacePort,
  WorkspaceApplicationError,
  type WorkspaceCandidateBlobWritePort,
  type WorkspaceCandidateHandoffPort,
  type WorkspaceCandidateIdentity,
  type WorkspaceExecutionPolicy,
  type WorkspaceManifest,
  WorkspaceMaterializer,
  type WorkspaceOperationJournalPort,
  WorkspacePublisher,
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
  readonly candidateBlobs: WorkspaceCandidateBlobWritePort;
  readonly candidates: WorkspaceCandidateHandoffPort;
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
    // 新 acquire 的 Sandbox 不能把模板/上次执行残留当作 manifest 的 previous。先以受控快照
    // 证明 /workspace 为空；根不存在、列举失败或任意额外项都在模型 Session 创建前失败关闭。
    await assertEmptyWorkspaceBaseline({
      sandbox,
      operationKey: input.operationKey,
      scope,
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
      ...(input.expectedCurrentRevisionId === undefined
        ? {}
        : { targetRevisionId: input.expectedCurrentRevisionId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async verify(
    input: Parameters<WorkspaceRuntimePort["verify"]>[0],
  ): Promise<Awaited<ReturnType<WorkspaceRuntimePort["verify"]>>> {
    if (input.attemptId === undefined) throw new Error("WORKSPACE_ATTEMPT_ID_REQUIRED");
    const attemptId = input.attemptId;
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
    const revisionId = workspaceRevisionId(
      `revision-${createHash("sha256")
        .update(`${scope.tenantId}\0${scope.workspaceId}\0${attemptId}\0${input.operationKey}`)
        .digest("hex")}`,
    );
    const unsigned = {
      ...scope,
      attemptId,
      runId: input.scope.runId,
      rootRunId: input.scope.rootRunId,
      ...(input.expectedCurrentRevisionId === undefined
        ? {}
        : { parentRevisionId: input.expectedCurrentRevisionId }),
      revisionId,
      operationKey: input.operationKey,
    };
    const identity: WorkspaceCandidateIdentity = Object.freeze({
      ...unsigned,
      operationDigest: workspaceCandidateOperationDigest(unsigned),
    });
    await this.options.candidates.begin(identity);
    try {
      const change = await new WorkspacePublisher({
        journal: this.options.journal,
        sandbox,
        blobs: this.options.candidateBlobs,
        policy: this.options.policy,
      }).publish({
        operationKey: input.operationKey,
        scope,
        ...(base === undefined ? {} : { base }),
        candidate: identity,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await this.options.candidates.prepare({ identity, manifest: change.candidateManifest });
      return Object.freeze({
        tenantId: input.scope.tenantId,
        threadId: input.scope.threadId,
        workspaceId: input.scope.workspaceId,
        rootRunId: input.scope.rootRunId,
        ...(input.expectedCurrentRevisionId === undefined
          ? {}
          : { parentRevisionId: input.expectedCurrentRevisionId }),
        revisionId,
        candidateOperationKey: identity.operationKey,
        candidateOperationDigest: sha256Digest(identity.operationDigest),
        manifest: change.candidateManifest,
      });
    } catch (error) {
      if (error instanceof WorkspaceApplicationError && error.code === "RESULT_UNKNOWN") {
        // unknown 仍可能已经完成远端副作用或 journal COMMIT，只能由原 operation 重入/readback，
        // 或在 Attempt 过期后恢复；此处释放会把仍在对账的 stable 引用错误变成不可达。
        throw error;
      }
      // release 的 COMMIT 若未知，候选仍由 Attempt 过期恢复收敛；绝不能据异常猜测引用已释放。
      await this.options.candidates
        .release({ identity, reason: "publish_failed" })
        .catch(() => undefined);
      throw error;
    }
  }
}

async function assertEmptyWorkspaceBaseline(input: {
  readonly sandbox: SandboxWorkspacePort;
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const session = await input.sandbox.currentSession();
  const operationKey = `workspace-baseline:${createHash("sha256")
    .update(input.operationKey)
    .digest("hex")}`;
  const snapshot = await input.sandbox.captureSnapshot({ operationKey, scope: input.scope });
  try {
    if (snapshot.sessionId !== session.sessionId || snapshot.generation !== session.generation) {
      throw new Error("WORKSPACE_BASELINE_SANDBOX_DRIFT");
    }
    for await (const _entry of input.sandbox.listWorkspace(
      snapshot,
      input.signal === undefined ? {} : { signal: input.signal },
    )) {
      throw new Error("WORKSPACE_BASELINE_NOT_EMPTY");
    }
  } finally {
    await input.sandbox.releaseSnapshots({ sandbox: session, operationKey });
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
