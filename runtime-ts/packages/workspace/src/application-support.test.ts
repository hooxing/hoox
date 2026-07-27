import { describe, expect, it } from "vitest";
import type {
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
} from "./application-ports.js";
import {
  beginOperation,
  parseSandboxSession,
  parseSandboxSnapshot,
} from "./application-support.js";

describe("Workspace Sandbox 身份严格解析", () => {
  it("Session/Snapshot 经 Journal JSON 往返仍保持 exact keys", async () => {
    const session = parseSandboxSession(
      JSON.parse(JSON.stringify({ sessionId: "sandbox-a", generation: 1 })),
    );
    const snapshot = parseSandboxSnapshot(
      JSON.parse(JSON.stringify({ ...session, snapshotToken: "snapshot-operation-a" })),
    );
    const journal: WorkspaceOperationJournalPort = {
      begin: async () => JSON.parse(JSON.stringify({ status: "completed", result: { snapshot } })),
      complete: async () => undefined,
      failKnown: async () => undefined,
      recordUnknown: async () => undefined,
    };
    const begun = await beginOperation(journal, {} as WorkspaceOperationIdentity);
    if (begun.status !== "completed") throw new Error("测试前置条件失败");
    const result = begun.result as { snapshot: unknown };
    const roundTripped = parseSandboxSnapshot(result.snapshot);

    expect(Object.keys(session).sort()).toEqual(["generation", "sessionId"]);
    expect(Object.keys(roundTripped).sort()).toEqual(["generation", "sessionId", "snapshotToken"]);
    expect(roundTripped).toEqual(snapshot);
  });

  it("Session/Snapshot 拒绝 capability scope 或其他额外字段", () => {
    expect(() =>
      parseSandboxSession({
        sessionId: "sandbox-a",
        generation: 1,
        scope: { tenantId: "tenant-a", threadId: "thread-a", workspaceId: "workspace-a" },
      }),
    ).toThrow("字段不符合契约");
    expect(() =>
      parseSandboxSnapshot({
        sessionId: "sandbox-a",
        generation: 1,
        snapshotToken: "snapshot-a",
        tenantId: "tenant-a",
      }),
    ).toThrow("字段不符合契约");
  });
});
