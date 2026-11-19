import { createHash } from "node:crypto";
import {
  type ExecutionPhaseTimingObserver,
  type ExecutionTimingPhase,
  measureExecutionPhase,
  sha256Digest,
  workspaceRevisionId,
} from "@hoox/domain";
import { workspaceCandidateOperationDigest } from "@hoox/persistence/run-execution";
import type { WorkspaceRuntimePort } from "@hoox/run-contracts";
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
} from "@hoox/workspace";

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
  /**
   * 同一 Session 对象（一次 acquire 的结果）在 materialize 与 verify 之间复用已打开的适配器，
   * 安全探测只做一次。适配器每次调用仍重验可信 binding 的 session/generation/scope，失效时
   * 失败关闭；打开失败不缓存。键是对象身份，Run 结束后随 Session 一起回收。
   */
  private readonly openedWorkspaces = new WeakMap<
    object,
    { readonly scopeKey: string; readonly opened: Promise<SandboxWorkspacePort> }
  >();

  constructor(private readonly options: WorkerWorkspaceRuntimeOptions) {}

  private timedPorts(timing: ExecutionPhaseTimingObserver | undefined) {
    return {
      journal: timedMethods(this.options.journal, timing, "workspace_journal", [
        "lookupCompleted",
        "begin",
        "complete",
        "failKnown",
        "recordUnknown",
      ]),
      stableBlobs: timedMethods(this.options.stableBlobs, timing, "workspace_stable_read", [
        "authorize",
        "head",
      ]),
      candidateBlobs: timedMethods(
        this.options.candidateBlobs,
        timing,
        "workspace_candidate_upload",
        ["putCandidate", "headCandidate"],
      ),
      candidates: timedMethods(this.options.candidates, timing, "workspace_candidate_persist", [
        "begin",
        "prepare",
        "release",
      ]),
    };
  }

  private async openTimedSandbox(
    input: Parameters<WorkspaceRuntimePort["verify"]>[0],
    scope: WorkspaceTrustedScope,
    timing: ExecutionPhaseTimingObserver | undefined,
  ): Promise<SandboxWorkspacePort> {
    const scopeKey = executionScopeKey(input.scope);
    const cached = this.openedWorkspaces.get(input.sandbox);
    let opened: Promise<SandboxWorkspacePort>;
    if (cached !== undefined && cached.scopeKey === scopeKey) {
      opened = cached.opened;
    } else {
      opened = measureExecutionPhase(timing, "workspace_open", () =>
        this.options.openSandboxWorkspace({
          scope,
          executionScope: input.scope,
          session: input.sandbox,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
      const entry = { scopeKey, opened };
      this.openedWorkspaces.set(input.sandbox, entry);
      opened.catch(() => {
        if (this.openedWorkspaces.get(input.sandbox) === entry) {
          this.openedWorkspaces.delete(input.sandbox);
        }
      });
    }
    const sandbox = await opened;
    // 物化删除/建目录也是远端命令，与文件写入合并计入 workspace_file_write。
    return timedMethods(
      timedMethods(sandbox, timing, "workspace_snapshot", ["captureSnapshot"]),
      timing,
      "workspace_file_write",
      [
        "inspectRegularFile",
        "removeFile",
        "removeDirectory",
        "removeUnexpectedDirectory",
        "ensureDirectory",
        "writeFileAtomically",
      ],
    );
  }

  async materialize(input: Parameters<WorkspaceRuntimePort["materialize"]>[0]): Promise<void> {
    const scope = trustedScope(input.scope);
    const timing = input.phaseTiming;
    const ports = this.timedPorts(timing);
    let current: WorkspaceManifest | undefined;
    try {
      current = await measureExecutionPhase(timing, "workspace_head_load", () =>
        this.options.revisions.loadCurrentManifest({
          scope,
          ...(input.expectedCurrentRevisionId === undefined
            ? {}
            : { expectedRevisionId: input.expectedCurrentRevisionId }),
        }),
      );
    } catch {
      throw new WorkspaceMaterializationStageError("load_current_manifest");
    }
    const target = current ?? emptyManifest(scope, this.options.policy);
    let sandbox: SandboxWorkspacePort;
    try {
      sandbox = await this.openTimedSandbox(input, scope, timing);
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
        journal: ports.journal,
        stableBlobs: ports.stableBlobs,
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
    const timing = input.phaseTiming;
    const ports = this.timedPorts(timing);
    const base = await measureExecutionPhase(timing, "workspace_head_load", () =>
      this.options.revisions.loadCurrentManifest({
        scope,
        ...(input.expectedCurrentRevisionId === undefined
          ? {}
          : { expectedRevisionId: input.expectedCurrentRevisionId }),
      }),
    );
    const sandbox = await this.openTimedSandbox(input, scope, timing);
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
    await ports.candidates.begin(identity);
    try {
      const change = await new WorkspacePublisher({
        journal: ports.journal,
        sandbox,
        blobs: ports.candidateBlobs,
        policy: this.options.policy,
      }).publish({
        operationKey: input.operationKey,
        scope,
        ...(base === undefined ? {} : { base }),
        candidate: identity,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (sameWorkspaceContent(base, change.candidateManifest)) {
        // 内容与当前 head 完全一致时不形成新 Revision：候选以 superseded 释放，Run 按
        // workspace_unchanged 收口。未变更文件不会上传 Blob，因此释放不涉及新增引用。
        await ports.candidates.release({ identity, reason: "superseded" });
        return undefined;
      }
      await ports.candidates.prepare({ identity, manifest: change.candidateManifest });
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
      await ports.candidates.release({ identity, reason: "publish_failed" }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * 把端口方法包装成子阶段计时。只计时返回 Promise 的方法；流式方法（async iterable）原样转发，
 * 其耗时计入消费它的那个方法。没有 observer 时直接返回原对象。
 */
function timedMethods<T extends object>(
  target: T,
  observer: ExecutionPhaseTimingObserver | undefined,
  phase: ExecutionTimingPhase,
  methods: readonly (keyof T & string)[],
): T {
  if (observer === undefined) return target;
  const timed = new Set<string | symbol>(methods);
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      if (!timed.has(property)) return value.bind(object);
      return (...args: unknown[]) =>
        measureExecutionPhase(observer, phase, async () => value.apply(object, args));
    },
  });
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

function executionScopeKey(scope: Parameters<WorkspaceRuntimePort["verify"]>[0]["scope"]): string {
  return [scope.tenantId, scope.threadId, scope.runId, scope.rootRunId, scope.workspaceId].join(
    "\0",
  );
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

function sameWorkspaceContent(
  base: WorkspaceManifest | undefined,
  candidate: WorkspaceManifest,
): boolean {
  return base === undefined ? candidate.entries.length === 0 : base.digest === candidate.digest;
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
