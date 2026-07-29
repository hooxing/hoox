import type { ExecutionScope, SandboxSessionRef } from "@cube-runtime/run-contracts";
import {
  type SandboxWorkspacePort,
  WorkspaceDependencyError,
  type WorkspaceExecutionPolicy,
} from "@cube-runtime/workspace";
import { describe, expect, it, vi } from "vitest";
import { ManifestWorkspaceRuntime } from "./workspace-runtime.js";

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

describe("ManifestWorkspaceRuntime candidate 恢复边界", () => {
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
});
