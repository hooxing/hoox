import {
  type AcceptWorkspaceArtifactIntentCommand,
  ArtifactCompletionGateAdapter,
  ArtifactDeliveryError,
  createArtifactExecutionAuthorizationAuthority,
} from "@cube-runtime/artifact";
import {
  isoTimestamp,
  resourceVersionId,
  runId,
  tenantId,
  threadId,
  workspaceId,
} from "@cube-runtime/domain";
import {
  bindTrustedPiModelContextCapability,
  createSafePiSession,
  type RuntimeAgentEvent,
} from "@cube-runtime/pi-adapter";
import type { ExternalEffectCall } from "@cube-runtime/run-contracts";
import { FakeSandboxHandle } from "@cube-runtime/sandbox/testing";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type ArtifactPublicationResourcePort,
  ArtifactToolRouter,
  type ArtifactToolServicePort,
  type TrustedArtifactSessionBinding,
} from "./artifact-tools.js";

const scope = Object.freeze({
  tenantId: tenantId("tenant_faux_artifact"),
  threadId: threadId("thread_faux_artifact"),
  runId: runId("run_faux_artifact"),
  rootRunId: runId("run_faux_artifact"),
  workspaceId: workspaceId("workspace_faux_artifact"),
});
const binding: TrustedArtifactSessionBinding = Object.freeze({
  scope,
  attemptId: "attempt-faux-artifact",
});

class StatefulFauxArtifactService implements ArtifactToolServicePort {
  required = new Set<string>();
  published = new Set<string>();
  failedArtifacts = new Set<string>();

  async declareDeliverables(
    input: Parameters<ArtifactToolServicePort["declareDeliverables"]>[0],
  ): Promise<void> {
    this.required = new Set(
      input.declarations.filter((item) => item.requirement === "required").map((item) => item.key),
    );
  }

  async acceptWorkspaceArtifactIntent(command: AcceptWorkspaceArtifactIntentCommand) {
    return {
      artifactId: command.requestedArtifactId,
      resourceVersionId: resourceVersionId("version_faux_workspace_intent"),
      sourceRelativePath: command.sourceRelativePath,
      status: "accepted" as const,
    };
  }

  async publishArtifact(command: Parameters<ArtifactToolServicePort["publishArtifact"]>[0]) {
    if (command.resourceVersionId === resourceVersionId("version_faux_broken")) {
      this.failedArtifacts.add(command.artifactId);
      throw new ArtifactDeliveryError(
        "ARTIFACT_PUBLICATION_FAILED",
        "private object key and signed url",
      );
    }
    if (
      command.replacesArtifactId !== undefined &&
      !this.failedArtifacts.has(command.replacesArtifactId)
    ) {
      throw new ArtifactDeliveryError("ARTIFACT_IDEMPOTENCY_CONFLICT", "private replacement");
    }
    if (command.purpose === "deliverable" && command.deliverableKey) {
      this.published.add(command.deliverableKey);
    }
    return {
      artifactId: command.artifactId,
      tenantId: command.authorization.scope.tenantId,
      threadId: command.authorization.scope.threadId,
      runId: command.authorization.scope.runId,
      resourceVersionId: command.resourceVersionId,
      ...(command.replacesArtifactId === undefined
        ? {}
        : { replacesArtifactId: command.replacesArtifactId }),
      name: command.name,
      purpose: command.purpose,
      ...(command.deliverableKey === undefined ? {} : { deliverableKey: command.deliverableKey }),
      status: "published" as const,
    };
  }

  async assertReadyForCompletion(): Promise<void> {
    if ([...this.required].some((key) => !this.published.has(key))) {
      throw new ArtifactDeliveryError("ARTIFACT_NOT_READY", "必需交付物尚未全部发布成功");
    }
  }
}

class FauxResources implements ArtifactPublicationResourcePort {
  async prepareImmutableVersion(
    input: Parameters<ArtifactPublicationResourcePort["prepareImmutableVersion"]>[0],
  ) {
    if (input.source.kind === "resource_version") {
      return { outcome: "ready" as const, resourceVersionId: input.source.resourceVersionId };
    }
    return {
      outcome: "ready" as const,
      resourceVersionId:
        input.source.relativePath === "reports/broken.md"
          ? resourceVersionId("version_faux_broken")
          : resourceVersionId("version_faux_fixed"),
    };
  }
}

function authorization(call: ExternalEffectCall) {
  return {
    permit: {
      permitId: `permit-${call.callId}`,
      scope,
      runClaimToken: "claim-faux-artifact",
      runClaimEpoch: 1,
      workspaceRootRunId: scope.rootRunId,
      workspaceLeaseEpoch: 2,
      attemptVersion: 12,
      effect: "tool_execution" as const,
      callId: call.callId,
      toolName: call.toolName,
      argsDigest: call.argsDigest,
      issuedAt: isoTimestamp("2026-07-26T00:00:00.000Z"),
      expiresAt: isoTimestamp("2026-07-26T00:01:00.000Z"),
    },
    consumedAt: isoTimestamp("2026-07-26T00:00:01.000Z"),
    consumedAtMonotonicMs: 100,
    maxContinuationDelayMs: 10_000,
  };
}

const declaration = {
  idempotencyKey: "declare:faux:1",
  declarations: [{ key: "report", name: "最终报告", requirement: "required" }],
};
const brokenPublication = {
  idempotencyKey: "publish:faux:broken",
  artifactId: "artifact_faux_broken",
  name: "最终报告.md",
  purpose: "deliverable",
  deliverableKey: "report",
  source: {
    kind: "resource_version",
    resourceVersionId: "version_faux_broken",
  },
};
const fixedPublication = {
  idempotencyKey: "publish:faux:fixed",
  artifactId: "artifact_faux_fixed",
  replacesArtifactId: "artifact_faux_broken",
  name: "最终报告.md",
  purpose: "deliverable",
  deliverableKey: "report",
  source: {
    kind: "resource_version",
    resourceVersionId: "version_faux_fixed",
  },
};

describe("Pi Faux Artifact 纵向链路", () => {
  it.runIf(process.platform === "linux")(
    "模型声明、失败修正为新版本与新 Artifact 后通过完成门，公开上下文不泄漏存储信息",
    async () => {
      const service = new StatefulFauxArtifactService();
      const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 100 });
      const router = new ArtifactToolRouter({
        binding,
        artifacts: service,
        resources: new FauxResources(),
        authorizationVerifier: authority.verifier,
        authorizer: {
          authorizeToolEffect: async (call) =>
            authority.issuer.issue({
              consumed: authorization(call),
              attemptId: binding.attemptId,
            }),
        },
      });
      let initialContext = "";
      let correctionContext = "";
      let completionContext = "";
      const faux = fauxProvider({
        api: `faux-artifact-${Date.now()}`,
        provider: `faux-artifact-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        (context) => {
          initialContext = JSON.stringify(context);
          return fauxAssistantMessage(
            fauxToolCall("declare_deliverables", declaration, { id: "call-faux-declare" }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage(
          fauxToolCall("publish_artifact", brokenPublication, { id: "call-faux-broken" }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          correctionContext = JSON.stringify(context.messages);
          return fauxAssistantMessage(
            fauxToolCall("publish_artifact", fixedPublication, { id: "call-faux-fixed" }),
            { stopReason: "toolUse" },
          );
        },
        (context) => {
          completionContext = JSON.stringify(context.messages);
          return fauxAssistantMessage("交付物已发布");
        },
      ]);
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const model = faux.getModel();
      const controller = await createSafePiSession({
        model,
        modelContext: bindTrustedPiModelContextCapability(runtime, model),
        modelRuntime: runtime,
        sandbox: new FakeSandboxHandle("artifact-faux"),
        artifactToolRouter: router,
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
      const diagnostics = controller.getDiagnostics();
      expect(diagnostics.activeToolNames).toEqual(
        expect.arrayContaining(["declare_deliverables", "publish_artifact"]),
      );
      expect(diagnostics.capabilityManifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      try {
        await controller.prompt("生成并发布报告");
      } finally {
        controller.dispose();
      }

      const gate = new ArtifactCompletionGateAdapter(service);
      await expect(gate.assertReadyForCompletion({ scope })).resolves.toBeUndefined();
      expect(service.failedArtifacts).toContain("artifact_faux_broken");
      expect(service.published).toContain("report");
      expect(initialContext).toContain("declare_deliverables");
      expect(initialContext).toContain("publish_artifact");
      expect(initialContext).not.toContain("request_user_input");
      expect(correctionContext).toContain("sandbox_untrusted");
      expect(completionContext).toContain("sandbox_untrusted");
      expect(correctionContext).not.toContain("ARTIFACT_PUBLICATION_FAILED");
      expect(completionContext).not.toContain("ARTIFACT_PUBLISHED");
      expect(JSON.stringify({ correctionContext, completionContext, events })).not.toMatch(
        /objectKey|physicalObjectKey|signed url|X-Amz|private object/iu,
      );
      expect(events.filter((event) => event.type === "tool.completed")).toEqual([
        expect.objectContaining({ name: "declare_deliverables", isError: false }),
        expect.objectContaining({ name: "publish_artifact", isError: true }),
        expect.objectContaining({ name: "publish_artifact", isError: false }),
      ]);
    },
  );

  it("缺失 required 时完成门稳定阻塞，不能把 Run 伪装为成功", async () => {
    const service = new StatefulFauxArtifactService();
    service.required.add("report");
    const gate = new ArtifactCompletionGateAdapter(service);
    await expect(gate.assertReadyForCompletion({ scope })).rejects.toMatchObject({
      code: "ARTIFACT_NOT_READY",
      message: "必需交付物尚未全部发布成功",
    });
  });
});
