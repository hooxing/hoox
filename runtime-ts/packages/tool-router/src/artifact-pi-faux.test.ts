import { createArtifactExecutionAuthorizationAuthority } from "@hoox/artifact";
import {
  artifactId,
  isoTimestamp,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  workspaceId,
} from "@hoox/domain";
import {
  bindTrustedPiModelContextCapability,
  createSafePiSession,
  type RuntimeAgentEvent,
} from "@hoox/pi-adapter";
import type { ExternalEffectCall } from "@hoox/run-contracts";
import { FakeSandboxHandle } from "@hoox/sandbox/testing";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DeliverFileToolRouterFactory } from "./deliver-file.js";

const scope = Object.freeze({
  tenantId: tenantId("tenant_faux_deliver"),
  threadId: threadId("thread_faux_deliver"),
  runId: runId("run_faux_deliver"),
  rootRunId: runId("run_faux_deliver"),
  workspaceId: workspaceId("workspace_faux_deliver"),
});

function consumed(call: ExternalEffectCall) {
  return {
    permit: {
      permitId: `permit-${call.callId}`,
      scope,
      runClaimToken: "claim-faux-deliver",
      runClaimEpoch: 1,
      workspaceRootRunId: scope.rootRunId,
      workspaceLeaseEpoch: 2,
      attemptVersion: 12,
      effect: "tool_execution" as const,
      callId: call.callId,
      toolName: call.toolName,
      argsDigest: call.argsDigest,
      issuedAt: isoTimestamp("2026-07-30T00:00:00.000Z"),
      expiresAt: isoTimestamp("2026-07-30T00:01:00.000Z"),
    },
    consumedAt: isoTimestamp("2026-07-30T00:00:01.000Z"),
    consumedAtMonotonicMs: 100,
    maxContinuationDelayMs: 10_000,
  };
}

describe("Pi Faux deliver_file 纵向链路", () => {
  it("模型看到单一交付工具、修正缺失路径并在下一轮获得真实发布结果", async () => {
    const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 101 });
    const sourcePaths: string[] = [];
    const router = new DeliverFileToolRouterFactory({
      source: {
        read: async ({ absolutePath }) => {
          sourcePaths.push(absolutePath);
          return absolutePath.endsWith("missing.pdf")
            ? { outcome: "not_found" as const }
            : {
                outcome: "found" as const,
                relativePath: "reports/final.pdf",
                body: new Uint8Array([1, 2, 3]),
              };
        },
      },
      publications: {
        publish: async (input) => ({
          artifactId: artifactId("artifact_faux_delivered"),
          resourceVersionId: resourceVersionId("resource_version_faux_delivered"),
          name: input.name,
          size: input.body.byteLength,
          sha256: sha256Digest("a".repeat(64)),
          mediaType: "application/pdf",
        }),
      },
      authorizationVerifier: authority.verifier,
    }).create({
      binding: {
        scope,
        attemptId: "attempt-faux-deliver",
        sandbox: {
          registryId: "registry-faux-deliver",
          providerKey: "cube",
          providerSandboxId: "sandbox-faux-deliver",
          mode: "created",
          sandbox: new FakeSandboxHandle("faux-deliver"),
        },
      },
      authorizer: {
        authorizeToolEffect: async (call) =>
          authority.issuer.issue({
            consumed: consumed(call),
            attemptId: "attempt-faux-deliver",
          }),
      },
    });
    let initialContext = "";
    let correctionContext = "";
    let completionContext = "";
    const faux = fauxProvider({
      api: `faux-deliver-${Date.now()}`,
      provider: `faux-deliver-${Date.now()}`,
      tokensPerSecond: 10_000,
    });
    faux.setResponses([
      (context) => {
        initialContext = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxToolCall(
            "deliver_file",
            { path: "/workspace/reports/missing.pdf" },
            { id: "call-faux-missing" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        correctionContext = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall(
            "deliver_file",
            { path: "/workspace/reports/final.pdf" },
            { id: "call-faux-final" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        completionContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("文件已经交付");
      },
    ]);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(faux.provider.id, async () => ({
      type: "api_key",
      key: "test-only-key",
    }));
    const runtime = createModels({ credentials });
    runtime.setProvider(faux.provider);
    const model = faux.getModel();
    const controller = await createSafePiSession({
      model,
      modelContext: bindTrustedPiModelContextCapability(runtime, model),
      modelRuntime: runtime,
      sandbox: new FakeSandboxHandle("faux-deliver-session"),
      deliverFileToolRouter: router,
      authorizeToolEffect: async () => ({
        consumedAtMonotonicMs: performance.now(),
        maxContinuationDelayMs: 250,
      }),
      createToolObservationRecorder: (outputs) => ({
        record: async (call) => {
          const observation = await outputs.readControlledReceipt(call);
          return observation === undefined
            ? { outcome: "conflict" as const }
            : { outcome: "recorded" as const, observation, isTruncated: false };
        },
      }),
    });
    const events: RuntimeAgentEvent[] = [];
    controller.subscribe((event) => events.push(event));
    try {
      expect(controller.getDiagnostics().activeToolNames).toEqual([
        "exec_command",
        "read",
        "edit",
        "write",
        "collapse_process_for_final_answer",
        "skill",
        "deliver_file",
      ]);
      await controller.prompt("生成并交付报告");
    } finally {
      controller.dispose();
    }

    expect(sourcePaths).toEqual(["/workspace/reports/missing.pdf", "/workspace/reports/final.pdf"]);
    expect(initialContext).toContain("deliver_file");
    expect(initialContext).not.toContain("declare_deliverables");
    expect(initialContext).not.toContain("publish_artifact");
    expect(correctionContext).toContain("FILE_NOT_FOUND");
    expect(completionContext).toContain("artifact_faux_delivered");
    expect(events.filter((event) => event.type === "tool.completed")).toEqual([
      expect.objectContaining({ name: "deliver_file", isError: true }),
      expect.objectContaining({ name: "deliver_file", isError: false }),
    ]);
  });
});
