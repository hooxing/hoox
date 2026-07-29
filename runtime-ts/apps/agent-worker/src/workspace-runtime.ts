import { createHash } from "node:crypto";
import type { WorkspaceRuntimePort } from "@cube-runtime/run-contracts";
import {
  createWorkspaceManifest,
  WorkspaceMaterializer,
  type SandboxWorkspacePort,
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async verify(input: Parameters<WorkspaceRuntimePort["verify"]>[0]): Promise<undefined> {
    // WorkspacePublisher 目前会在 RuntimeMutation/CAS 之前独立创建 stable 引用。若随后是
    // unchanged、取消、双栅栏 conflict 或 unknown，这些引用没有可证明的交接/回收路径。
    // 因此本实现绝不触发 publish 或 Blob 写；真正的候选引用事务协议接通前必须失败关闭。
    void input;
    throw new Error("WORKSPACE_MANIFEST_PUBLICATION_DISABLED");
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
