import { createHash } from "node:crypto";
import type { ExecutionScope, SandboxSessionRef } from "@hoox/run-contracts";
import {
  createWorkspaceManifest,
  type SandboxWorkspacePort,
  WorkspaceDependencyError,
  type WorkspaceExecutionPolicy,
} from "@hoox/workspace";
import { describe, expect, it, vi } from "vitest";
import {
  ManifestWorkspaceRuntime,
  WorkspaceMaterializationStageError,
} from "./workspace-runtime.js";

const policy: WorkspaceExecutionPolicy = {
  maxEntries: 1,
  maxFiles: 1,
  maxTotalBytes: 1,
  maxSingleFileBytes: 1,
  maxChunkBytes: 1,
  maxPathUtf8Bytes: 128,
  historicalManifest: { maxFiles: 1, maxTotalBytes: 1 },
};

const scope = {
  tenantId: "tenant-workspace-unknown",
  threadId: "thread-workspace-unknown",
  runId: "run-workspace-unknown",
  rootRunId: "run-workspace-unknown",
  workspaceId: "workspace-unknown",
} as ExecutionScope;

const session = {
  registryId: "registry-workspace-unknown",
  providerSandboxId: "sandbox-workspace-unknown",
  mode: "created",
  sandbox: {},
} as SandboxSessionRef;

function unknownSandbox(): SandboxWorkspacePort {
  return {
    currentSession: async () => {
      throw new WorkspaceDependencyError("unknown", "SANDBOX_CURRENT_UNKNOWN");
    },
    captureSnapshot: async () => {
      throw new Error("不应 capture snapshot");
    },
    releaseSnapshots: async () => undefined,
    inspectRegularFile: async () => ({ status: "missing" }),
    removeFile: async () => undefined,
    removeDirectory: async () => undefined,
    removeUnexpectedDirectory: async () => undefined,
    ensureDirectory: async () => undefined,
    writeFileAtomically: async () => undefined,
    listWorkspace: async function* () {},
    readRegularFile: async function* () {},
  };
}

function emptySandbox(): SandboxWorkspacePort {
  const sandbox = { sessionId: "sandbox-workspace-unknown", generation: 1 };
  return {
    currentSession: async () => sandbox,
    captureSnapshot: async () => ({ ...sandbox, snapshotToken: "snapshot-workspace-unknown" }),
    releaseSnapshots: async () => undefined,
    inspectRegularFile: async () => ({ status: "missing" }),
    removeFile: async () => undefined,
    removeDirectory: async () => undefined,
    removeUnexpectedDirectory: async () => undefined,
    ensureDirectory: async () => undefined,
    writeFileAtomically: async () => undefined,
    listWorkspace: async function* () {},
    readRegularFile: async function* () {},
  };
}

/** 与空 Sandbox 不同的单文件 head，用于让发布结果形成真实变更。 */
function oneFileHead() {
  const digest = createHash("sha256").update("a").digest("hex");
  const incarnationId = "11111111-1111-4111-8111-111111111111";
  return createWorkspaceManifest(
    {
      tenantId: scope.tenantId,
      entries: [
        {
          type: "file",
          path: "a.txt",
          content: { sha256: digest, size: 1 },
          object: {
            tenantId: scope.tenantId,
            purpose: "workspace",
            incarnationId,
            physicalObjectKey: `runtime/stable/${scope.tenantId}/workspace/sha256/${digest}/incarnations/${incarnationId}`,
          },
        },
      ],
    },
    { maxFiles: 1, maxTotalBytes: 1, maxSingleFileBytes: 1, maxPathUtf8Bytes: 128 },
  );
}

describe("ManifestWorkspaceRuntime candidate 恢复边界", () => {
  it("同一 Session 的 materialize 与 verify 复用已打开的 Workspace，换 Session 才重新打开", async () => {
    const open = vi.fn(async () => emptySandbox());
    const runtime = new ManifestWorkspaceRuntime({
      journal: {
        lookupCompleted: async () => ({ status: "not_found" }),
        begin: async () => ({ status: "started" }),
        complete: async () => undefined,
        failKnown: async () => undefined,
        recordUnknown: async () => undefined,
      },
      revisions: { loadCurrentManifest: async () => undefined },
      stableBlobs: {
        authorize: async () => ({ status: "denied" }),
        head: async () => ({ status: "not_found" }),
        read: async function* () {},
      },
      candidateBlobs: {
        putCandidate: async () => {
          throw new Error("空 Workspace 不应上传 candidate");
        },
        headCandidate: async () => ({ status: "not_found" }),
      },
      candidates: {
        begin: async () => undefined,
        prepare: async () => undefined,
        release: async () => undefined,
      },
      openSandboxWorkspace: open,
      policy,
    });

    await runtime.materialize({
      scope,
      attemptId: "attempt-workspace-reuse" as never,
      sandbox: session,
      operationKey: "workspace-reuse-materialize",
    });
    await runtime.verify({
      scope,
      attemptId: "attempt-workspace-reuse" as never,
      sandbox: session,
      operationKey: "workspace-reuse-publish",
    });
    expect(open).toHaveBeenCalledOnce();

    await runtime.verify({
      scope,
      attemptId: "attempt-workspace-reuse-2" as never,
      sandbox: { ...session },
      operationKey: "workspace-reuse-publish-2",
    });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("内容与当前 head 相同时不形成 Revision，并以 superseded 释放候选", async () => {
    const phases: string[] = [];
    const prepare = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const runtime = new ManifestWorkspaceRuntime({
      journal: {
        lookupCompleted: async () => ({ status: "not_found" }),
        begin: async () => ({ status: "started" }),
        complete: async () => undefined,
        failKnown: async () => undefined,
        recordUnknown: async () => undefined,
      },
      revisions: { loadCurrentManifest: async () => undefined },
      stableBlobs: {
        authorize: async () => ({ status: "denied" }),
        head: async () => ({ status: "not_found" }),
        read: async function* () {},
      },
      candidateBlobs: {
        putCandidate: async () => {
          throw new Error("未变更 Workspace 不应上传 candidate");
        },
        headCandidate: async () => ({ status: "not_found" }),
      },
      candidates: { begin: async () => undefined, prepare, release },
      openSandboxWorkspace: async () => emptySandbox(),
      policy,
    });

    await expect(
      runtime.verify({
        scope,
        attemptId: "attempt-workspace-unchanged" as never,
        sandbox: session,
        operationKey: "workspace-unchanged-operation",
        phaseTiming: { record: (span) => phases.push(span.phase) },
      }),
    ).resolves.toBeUndefined();
    // 子阶段只用于诊断：按实际调用记录，不改变 verify 结果。
    expect(new Set(phases)).toEqual(
      new Set([
        "workspace_head_load",
        "workspace_open",
        "workspace_snapshot",
        "workspace_journal",
        "workspace_candidate_persist",
      ]),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ reason: "superseded" }));
  });

  it("物化前读取 head 失败时只暴露固定阶段，不传播底层错误", async () => {
    const runtime = new ManifestWorkspaceRuntime({
      journal: {
        lookupCompleted: async () => ({ status: "not_found" }),
        begin: async () => ({ status: "started" }),
        complete: async () => undefined,
        failKnown: async () => undefined,
        recordUnknown: async () => undefined,
      },
      revisions: {
        loadCurrentManifest: async () => {
          throw new Error("private database detail");
        },
      },
      stableBlobs: {
        authorize: async () => ({ status: "denied" }),
        head: async () => ({ status: "not_found" }),
        read: async function* () {},
      },
      candidateBlobs: {
        putCandidate: async () => {
          throw new Error("不应写入 candidate");
        },
        headCandidate: async () => ({ status: "not_found" }),
      },
      candidates: {
        begin: async () => undefined,
        prepare: async () => undefined,
        release: async () => undefined,
      },
      openSandboxWorkspace: async () => emptySandbox(),
      policy,
    });

    await expect(
      runtime.materialize({
        scope,
        attemptId: "attempt-workspace-stage" as never,
        sandbox: session,
        operationKey: "workspace-stage-operation",
      }),
    ).rejects.toEqual(new WorkspaceMaterializationStageError("load_current_manifest"));
  });

  it("发布结果未知时保留 candidate，不以 publish_failed 释放", async () => {
    const begin = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const runtime = new ManifestWorkspaceRuntime({
      journal: {
        lookupCompleted: async () => ({ status: "not_found" }),
        begin: async () => ({ status: "started" }),
        complete: async () => undefined,
        failKnown: async () => undefined,
        recordUnknown: async () => undefined,
      },
      revisions: { loadCurrentManifest: async () => undefined },
      stableBlobs: {
        authorize: async () => ({ status: "denied" }),
        head: async () => ({ status: "not_found" }),
        read: async function* () {},
      },
      candidateBlobs: {
        putCandidate: async () => {
          throw new Error("不应上传 candidate");
        },
        headCandidate: async () => ({ status: "not_found" }),
      },
      candidates: {
        begin,
        prepare: async () => undefined,
        release,
      },
      openSandboxWorkspace: async () => unknownSandbox(),
      policy,
    });

    await expect(
      runtime.verify({
        scope,
        attemptId: "attempt-workspace-unknown" as never,
        sandbox: session,
        operationKey: "workspace-unknown-operation",
      }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(begin).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("candidate prepare COMMIT 结果未知时转换为 RESULT_UNKNOWN 并保留原 identity", async () => {
    const release = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => {
      throw new WorkspaceDependencyError("unknown", "WORKSPACE_CANDIDATE_PREPARE_COMMIT_UNKNOWN");
    });
    const runtime = new ManifestWorkspaceRuntime({
      journal: {
        lookupCompleted: async () => ({ status: "not_found" }),
        begin: async () => ({ status: "started" }),
        complete: async () => undefined,
        failKnown: async () => undefined,
        recordUnknown: async () => undefined,
      },
      revisions: { loadCurrentManifest: async () => oneFileHead() },
      stableBlobs: {
        authorize: async () => ({ status: "denied" }),
        head: async () => ({ status: "not_found" }),
        read: async function* () {},
      },
      candidateBlobs: {
        putCandidate: async () => {
          throw new Error("空 Workspace 不应上传 candidate");
        },
        headCandidate: async () => ({ status: "not_found" }),
      },
      candidates: {
        begin: async () => undefined,
        prepare,
        release,
      },
      openSandboxWorkspace: async () => emptySandbox(),
      policy,
    });

    await expect(
      runtime.verify({
        scope,
        attemptId: "attempt-workspace-prepare-unknown" as never,
        expectedCurrentRevisionId: "revision-head" as never,
        sandbox: session,
        operationKey: "workspace-prepare-unknown-operation",
      }),
    ).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });
});
