import { createHash } from "node:crypto";
import { sha256Digest, workspaceRevisionId } from "@cube-runtime/domain";
import { workspaceCandidateOperationDigest } from "@cube-runtime/persistence";
import type { WorkspaceRuntimePort } from "@cube-runtime/run-contracts";
import {
  createWorkspaceManifest,
  type SandboxSessionIdentity,
  type SandboxWorkspacePort,
  type SandboxWorkspaceSnapshot,
  WorkspaceApplicationError,
  type WorkspaceCandidateBlobWritePort,
  type WorkspaceCandidateHandoffPort,
  type WorkspaceCandidateIdentity,
  WorkspaceDependencyError,
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

/** 只表达已审查的边界阶段；不承载底层错误正文、路径或对象身份。 */
export type WorkspaceMaterializationStage =
  | "load_current_manifest"
  | "open_workspace"
  | "baseline_snapshot"
  | "baseline_list"
  | "baseline_release"
  | "materializer";

export type WorkspaceMaterializerFailureDetail =
  | "invalid_operation_key"
  | "invalid_scope"
  | "invalid_sandbox_session"
  | "invalid_manifest"
  | "invalid_revision"
  | "other_application"
  | "dependency"
  | "unclassified";

export class WorkspaceMaterializationStageError extends Error {
  constructor(
    readonly stage: WorkspaceMaterializationStage,
    readonly detail?: WorkspaceMaterializerFailureDetail,
  ) {
    super(`WORKSPACE_MATERIALIZATION_${stage.toUpperCase()}`);
    this.name = "WorkspaceMaterializationStageError";
  }
}

/**
 * Worker 只看 manifest-aware RuntimePort：进入模型前物化已提交 head，模型 settled 后将 Sandbox
 * snapshot 发布为待 RuntimeMutation 原子提交的候选。它从不向 Worker 暴露 BlobStore 或 object key。
 */
export class ManifestWorkspaceRuntime implements WorkspaceRuntimePort {
  constructor(private readonly options: WorkerWorkspaceRuntimeOptions) {}

  async materialize(input: Parameters<WorkspaceRuntimePort["materialize"]>[0]): Promise<void> {
    const scope = trustedScope(input.scope);
    let current: WorkspaceManifest | undefined;
    try {
      current = await this.options.revisions.loadCurrentManifest({
        scope,
        ...(input.expectedCurrentRevisionId === undefined
          ? {}
          : { expectedRevisionId: input.expectedCurrentRevisionId }),
      });
    } catch {
      throw new WorkspaceMaterializationStageError("load_current_manifest");
    }
    const target = current ?? emptyManifest(scope, this.options.policy);
    let sandbox: SandboxWorkspacePort;
    try {
      sandbox = await this.options.openSandboxWorkspace({
        scope,
        executionScope: input.scope,
        session: input.sandbox,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      throw new WorkspaceMaterializationStageError("open_workspace");
    }
    // 新 acquire 的 Sandbox 不能把模板/上次执行残留当作 manifest 的 previous。先以受控快照
    // 证明 /workspace 为空；根不存在、列举失败或任意额外项都在模型 Session 创建前失败关闭。
    await assertEmptyWorkspaceBaseline({
      sandbox,
      operationKey: input.operationKey,
      scope,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    try {
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
    } catch (error) {
      throw new WorkspaceMaterializationStageError(
        "materializer",
        materializerFailureDetail(error),
      );
    }
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
      if (
        (error instanceof WorkspaceApplicationError && error.code === "RESULT_UNKNOWN") ||
        (error instanceof WorkspaceDependencyError && error.result === "unknown")
      ) {
        // unknown 仍可能已经完成远端副作用或 journal COMMIT，只能由原 operation 重入/readback，
        // 或在 Attempt 过期后恢复；此处释放会把仍在对账的 stable 引用错误变成不可达。
        throw error instanceof WorkspaceApplicationError
          ? error
          : new WorkspaceApplicationError("RESULT_UNKNOWN", "Workspace candidate 等待结果对账");
      }
      // release 的 COMMIT 若未知，候选仍由 Attempt 过期恢复收敛；绝不能据异常猜测引用已释放。
      await this.options.candidates
        .release({ identity, reason: "publish_failed" })
        .catch(() => undefined);
      throw error;
    }
  }
}

/** 只将核心固定文案映射为枚举；绝不复制错误正文到上层日志。 */
function materializerFailureDetail(error: unknown): WorkspaceMaterializerFailureDetail {
  if (error instanceof WorkspaceDependencyError) return "dependency";
  if (!(error instanceof WorkspaceApplicationError)) return "unclassified";
  if (error.code !== "INVALID_INPUT") return "other_application";
  if (error.message === "operationKey 格式无效") return "invalid_operation_key";
  if (
    error.message === "tenantId 格式无效" ||
    error.message === "threadId 格式无效" ||
    error.message === "workspaceId 格式无效"
  ) {
    return "invalid_scope";
  }
  if (
    error.message === "Sandbox sessionId 格式无效" ||
    error.message === "Sandbox generation 格式无效"
  ) {
    return "invalid_sandbox_session";
  }
  if (
    error.message === "非空 Workspace 缺少 Revision 身份" ||
    error.message === "Workspace Revision 身份缺失"
  ) {
    return "invalid_revision";
  }
  return "invalid_manifest";
}

async function assertEmptyWorkspaceBaseline(input: {
  readonly sandbox: SandboxWorkspacePort;
  readonly operationKey: string;
  readonly scope: WorkspaceTrustedScope;
  readonly signal?: AbortSignal;
}): Promise<void> {
  let session: SandboxSessionIdentity;
  try {
    session = await input.sandbox.currentSession();
  } catch {
    throw new WorkspaceMaterializationStageError("baseline_snapshot");
  }
  const operationKey = `workspace-baseline:${createHash("sha256")
    .update(input.operationKey)
    .digest("hex")}`;
  let snapshot: SandboxWorkspaceSnapshot;
  try {
    snapshot = await input.sandbox.captureSnapshot({ operationKey, scope: input.scope });
  } catch {
    throw new WorkspaceMaterializationStageError("baseline_snapshot");
  }
  let failure: WorkspaceMaterializationStageError | undefined;
  try {
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
    } catch {
      failure = new WorkspaceMaterializationStageError("baseline_list");
    }
  } finally {
    // 空快照即使列举失败也必须释放；释放失败比列举失败更接近泄漏风险，因此覆盖阶段。
    await input.sandbox.releaseSnapshots({ sandbox: session, operationKey }).catch(() => {
      failure = new WorkspaceMaterializationStageError("baseline_release");
    });
  }
  if (failure !== undefined) throw failure;
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
