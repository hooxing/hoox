import {
  type AcceptWorkspaceArtifactIntentCommand,
  ArtifactDeliveryError,
  createArtifactExecutionAuthorizationAuthority,
  type PublishArtifactCommand,
} from "@hoox/artifact";
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
import type {
  ConsumedExternalEffectAuthorization,
  ExecutionScope,
  ExternalEffectCall,
} from "@hoox/run-contracts";
import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import { describe, expect, it } from "vitest";
import {
  type ArtifactPublicationResourcePort,
  ArtifactToolError,
  ArtifactToolRouter,
  ArtifactToolRouterFactory,
  type ArtifactToolServicePort,
  artifactToolErrorProjection,
  type TrustedArtifactSessionBinding,
} from "./artifact-tools.js";

const scope: ExecutionScope = Object.freeze({
  tenantId: tenantId("tenant_tool"),
  threadId: threadId("thread_tool"),
  runId: runId("run_tool"),
  rootRunId: runId("run_tool"),
  workspaceId: workspaceId("workspace_tool"),
});
const binding: TrustedArtifactSessionBinding = Object.freeze({
  scope,
  attemptId: "attempt-tool-1",
});
const versionOne = resourceVersionId("version_tool_one");

class FakeArtifactService implements ArtifactToolServicePort {
  readonly declarations: Parameters<ArtifactToolServicePort["declareDeliverables"]>[0][] = [];
  readonly publications: PublishArtifactCommand[] = [];
  publishError?: unknown;

  async declareDeliverables(
    input: Parameters<ArtifactToolServicePort["declareDeliverables"]>[0],
  ): Promise<void> {
    this.declarations.push(input);
  }

  async acceptWorkspaceArtifactIntent(command: AcceptWorkspaceArtifactIntentCommand) {
    return {
      artifactId: command.requestedArtifactId,
      resourceVersionId: resourceVersionId("resource_version_workspace_intent"),
      sourceRelativePath: command.sourceRelativePath,
      status: "accepted" as const,
    };
  }

  async publishArtifact(command: PublishArtifactCommand) {
    this.publications.push(command);
    if (this.publishError) throw this.publishError;
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
}

class FakeResources implements ArtifactPublicationResourcePort {
  readonly calls: Parameters<ArtifactPublicationResourcePort["prepareImmutableVersion"]>[0][] = [];
  outcome: Awaited<ReturnType<ArtifactPublicationResourcePort["prepareImmutableVersion"]>> = {
    outcome: "ready",
    resourceVersionId: versionOne,
  };

  async prepareImmutableVersion(
    input: Parameters<ArtifactPublicationResourcePort["prepareImmutableVersion"]>[0],
  ) {
    this.calls.push(input);
    return this.outcome;
  }
}

function consumed(
  call: ExternalEffectCall,
  overrides: Partial<ConsumedExternalEffectAuthorization["permit"]> = {},
): ConsumedExternalEffectAuthorization {
  return {
    permit: {
      permitId: `permit-${call.callId}`,
      scope,
      runClaimToken: "claim-tool-1",
      runClaimEpoch: 3,
      workspaceRootRunId: scope.rootRunId,
      workspaceLeaseEpoch: 5,
      attemptVersion: 9,
      effect: "tool_execution",
      callId: call.callId,
      toolName: call.toolName,
      argsDigest: call.argsDigest,
      issuedAt: isoTimestamp("2026-07-26T00:00:00.000Z"),
      expiresAt: isoTimestamp("2026-07-26T00:01:00.000Z"),
      ...overrides,
    },
    consumedAt: isoTimestamp("2026-07-26T00:00:01.000Z"),
    consumedAtMonotonicMs: 100,
    maxContinuationDelayMs: 1_000,
  };
}

function harness(
  authorization: (call: ExternalEffectCall) => ConsumedExternalEffectAuthorization = consumed,
  authorizationAttemptId = binding.attemptId,
) {
  const artifacts = new FakeArtifactService();
  const resources = new FakeResources();
  const calls: ExternalEffectCall[] = [];
  const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 100 });
  const router = new ArtifactToolRouter({
    binding,
    artifacts,
    resources,
    authorizationVerifier: authority.verifier,
    authorizer: {
      authorizeToolEffect: async (call) => {
        calls.push(call);
        return authority.issuer.issue({
          consumed: authorization(call),
          attemptId: authorizationAttemptId,
        });
      },
    },
  });
  return { router, artifacts, resources, calls };
}

const declareArgs = {
  idempotencyKey: "declare:run_tool:1",
  declarations: [
    { key: "report", name: "最终报告", requirement: "required" as const },
    { key: "appendix", name: "附录", requirement: "optional" as const },
  ],
};

const publishArgs = {
  idempotencyKey: "publish:run_tool:1",
  artifactId: "artifact_tool_one",
  name: "最终报告.md",
  purpose: "deliverable" as const,
  deliverableKey: "report",
  source: {
    kind: "workspace_file" as const,
    relativePath: "reports/final.md",
    resourceName: "最终报告源文件",
  },
};

const fixedVersionPublishArgs = {
  ...publishArgs,
  source: { kind: "resource_version" as const, resourceVersionId: "version_tool_one" },
};

describe("Artifact Tool Router", () => {
  it("Workspace 文件只接受 durable intent，不在 Revision 提交前谎报 published", async () => {
    const { router, artifacts, resources } = harness();
    const accepted: AcceptWorkspaceArtifactIntentCommand[] = [];
    Object.defineProperty(artifacts, "acceptWorkspaceArtifactIntent", {
      value: async (command: AcceptWorkspaceArtifactIntentCommand) => {
        accepted.push(command);
        return {
          artifactId: artifactId("artifact_server_deterministic"),
          resourceVersionId: resourceVersionId("resource_version_server_deterministic"),
          sourceRelativePath: command.sourceRelativePath,
          status: "accepted" as const,
        };
      },
    });

    await expect(
      router.publishArtifact({ callId: "call-intent-1", arguments: publishArgs }),
    ).resolves.toEqual({
      ok: true,
      code: "ARTIFACT_ACCEPTED",
      artifactId: artifactId("artifact_server_deterministic"),
      sourceRelativePath: "reports/final.md",
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      requestedArtifactId: artifactId("artifact_tool_one"),
      sourceRelativePath: "reports/final.md",
      resourceName: "最终报告源文件",
      toolArgsDigest: digestCanonical(publishArgs),
    });
    expect(resources.calls).toHaveLength(0);
    expect(artifacts.publications).toHaveLength(0);
  });

  it("严格协议只授权 canonical 实参，并从可信上下文收窄写能力", async () => {
    const { router, artifacts, resources, calls } = harness();
    await expect(
      router.declareDeliverables({ callId: "call-declare-1", arguments: declareArgs }),
    ).resolves.toEqual({
      ok: true,
      code: "DELIVERABLES_DECLARED",
      requiredCount: 1,
      optionalCount: 1,
    });
    await expect(
      router.publishArtifact({ callId: "call-publish-1", arguments: fixedVersionPublishArgs }),
    ).resolves.toMatchObject({
      ok: true,
      code: "ARTIFACT_PUBLISHED",
      artifactId: artifactId("artifact_tool_one"),
      resourceVersionId: versionOne,
    });

    expect(calls).toEqual([
      {
        callId: "call-declare-1",
        toolName: "declare_deliverables",
        argsDigest: digestCanonical(declareArgs),
      },
      {
        callId: "call-publish-1",
        toolName: "publish_artifact",
        argsDigest: digestCanonical(fixedVersionPublishArgs),
      },
    ]);
    expect(resources.calls[0]?.source).toEqual({
      kind: "resource_version",
      resourceVersionId: versionOne,
    });
    expect(artifacts.publications[0]?.toolArgsDigest).toBe(
      digestCanonical(fixedVersionPublishArgs),
    );
    expect(artifacts.publications[0]?.authorization.scope).toEqual(scope);
  });

  it("固定 ResourceVersion 来源无需对象键，结果也不泄漏存储定位信息", async () => {
    const { router, resources } = harness();
    const result = await router.publishArtifact({
      callId: "call-fixed-version",
      arguments: {
        ...publishArgs,
        source: { kind: "resource_version", resourceVersionId: "version_tool_fixed" },
      },
    });
    expect(resources.calls[0]?.source).toEqual({
      kind: "resource_version",
      resourceVersionId: resourceVersionId("version_tool_fixed"),
    });
    expect(JSON.stringify(result)).not.toMatch(/objectKey|physicalObjectKey|headers|url/iu);
  });

  it("不同 callId 重放同一业务参数时保持相同幂等键和工具摘要", async () => {
    const { router, artifacts } = harness();
    await router.publishArtifact({
      callId: "call-replay-first",
      arguments: fixedVersionPublishArgs,
    });
    await router.publishArtifact({
      callId: "call-replay-second",
      arguments: fixedVersionPublishArgs,
    });
    expect(artifacts.publications).toHaveLength(2);
    expect(artifacts.publications[0]?.idempotencyKey).toBe(
      artifacts.publications[1]?.idempotencyKey,
    );
    expect(artifacts.publications[0]?.toolArgsDigest).toBe(
      artifacts.publications[1]?.toolArgsDigest,
    );
    expect(artifacts.publications[0]?.resourceVersionId).toBe(
      artifacts.publications[1]?.resourceVersionId,
    );
  });

  it("未知字段、越界路径、Unicode 歧义和访问器对象在消费许可前拒绝", async () => {
    const cases: unknown[] = [
      { ...declareArgs, tenantId: "tenant_attacker" },
      { ...publishArgs, objectKey: "private/key" },
      { ...publishArgs, source: { ...publishArgs.source, relativePath: "../secret" } },
      { ...publishArgs, source: { ...publishArgs.source, relativePath: "e\u0301/report.md" } },
      { ...publishArgs, source: { ...publishArgs.source, relativePath: "safe/\u202e.md" } },
      { ...publishArgs, source: { ...publishArgs.source, headers: { authorization: "secret" } } },
      { ...publishArgs, name: "报告\u202e.md" },
      { ...publishArgs, name: "e\u0301.md" },
      { ...publishArgs, name: " 报告.md" },
      { ...publishArgs, purpose: "diagnostic", deliverableKey: "report" },
      { ...publishArgs, deliverableKey: undefined },
    ];
    const poisoned = { ...publishArgs } as Record<string, unknown>;
    Object.defineProperty(poisoned, "name", { enumerable: true, get: () => "secret" });
    cases.push(poisoned);

    for (const [index, args] of cases.entries()) {
      const { router, calls } = harness();
      const operation =
        index === 0 ? router.declareDeliverables.bind(router) : router.publishArtifact.bind(router);
      await expect(
        operation({ callId: `call-invalid-${index}`, arguments: args }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_TOOL_INVALID_ARGUMENT",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("参数预扫描限制节点、键、数组与 UTF-8 预算，并拒绝稀疏、额外属性和非枚举字段", async () => {
    const wideUnknown = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`unknown_${index}`, index]),
    );
    const sparseDeclarations = new Array(2);
    sparseDeclarations[0] = declareArgs.declarations[0];
    const declarationsWithExtra = [...declareArgs.declarations] as Array<unknown> & {
      extra?: string;
    };
    declarationsWithExtra.extra = "not-json-array";
    const nonEnumerable = { ...publishArgs };
    Object.defineProperty(nonEnumerable, "hidden", {
      enumerable: false,
      value: "must-be-rejected",
    });
    const symbolKey = { ...publishArgs } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("secret")] = "must-be-rejected";
    const cases: unknown[] = [
      { ...publishArgs, ...wideUnknown },
      { ...publishArgs, unknownHuge: "😀".repeat(20_000) },
      {
        ...declareArgs,
        declarations: Array.from({ length: 257 }, () => declareArgs.declarations[0]),
      },
      { ...declareArgs, declarations: sparseDeclarations },
      { ...declareArgs, declarations: declarationsWithExtra },
      nonEnumerable,
      symbolKey,
    ];

    for (const [index, arguments_] of cases.entries()) {
      const { router, calls } = harness();
      const operation =
        index >= 2 && index <= 4
          ? router.declareDeliverables.bind(router)
          : router.publishArtifact.bind(router);
      await expect(
        operation({ callId: `call-budget-${index}`, arguments: arguments_ }),
      ).rejects.toMatchObject({ code: "ARTIFACT_TOOL_INVALID_ARGUMENT" });
      expect(calls).toHaveLength(0);
    }
  });

  it("跨 Attempt 栅栏、同形 JSON、过期 continuation、取消和重复 permit 全部关闭", async () => {
    const wrongAttempt = harness(consumed, "attempt-tool-other");
    await expect(
      wrongAttempt.router.declareDeliverables({
        callId: "call-cross-attempt",
        arguments: declareArgs,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOOL_NOT_AUTHORIZED" });
    expect(wrongAttempt.artifacts.declarations).toHaveLength(0);

    const wrongDigest = harness((call) =>
      consumed(call, { argsDigest: sha256Digest("f".repeat(64)) }),
    );
    await expect(
      wrongDigest.router.declareDeliverables({ callId: "call-same-shape", arguments: declareArgs }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOOL_NOT_AUTHORIZED" });

    const expired = harness((call) => ({
      ...consumed(call),
      consumedAtMonotonicMs: 1,
      maxContinuationDelayMs: 2,
    }));
    await expect(
      expired.router.publishArtifact({ callId: "call-expired", arguments: publishArgs }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOOL_NOT_AUTHORIZED" });
    expect(expired.resources.calls).toHaveLength(0);

    const cancelled = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.router.publishArtifact({
        callId: "call-cancelled",
        arguments: publishArgs,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOOL_NOT_AUTHORIZED" });
    expect(cancelled.calls).toHaveLength(0);

    const duplicate = harness((call) => consumed(call, { permitId: "same-permit-id" }));
    await duplicate.router.declareDeliverables({ callId: "call-first", arguments: declareArgs });
    await expect(
      duplicate.router.declareDeliverables({ callId: "call-second", arguments: declareArgs }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOOL_NOT_AUTHORIZED" });
    expect(duplicate.artifacts.declarations).toHaveLength(1);
  });

  it("发布失败给 Agent 稳定可修正结构，未知依赖异常完全脱敏", async () => {
    const { router, artifacts } = harness();
    artifacts.publishError = new ArtifactDeliveryError(
      "ARTIFACT_PUBLICATION_FAILED",
      "private object key",
    );
    const failed = await router
      .publishArtifact({ callId: "call-failed", arguments: fixedVersionPublishArgs })
      .catch(artifactToolErrorProjection);
    expect(failed).toEqual({
      ok: false,
      code: "ARTIFACT_PUBLICATION_FAILED",
      message: "Artifact 发布失败，请修正文件后创建新版本和新 Artifact",
      correctable: true,
    });
    expect(JSON.stringify(failed)).not.toContain("private object key");

    const unknown = harness();
    unknown.artifacts.publishError = new Error(
      "s3://secret-bucket/private-key?X-Amz-Signature=secret",
    );
    const projection = await unknown.router
      .publishArtifact({ callId: "call-upstream", arguments: fixedVersionPublishArgs })
      .catch(artifactToolErrorProjection);
    expect(projection).toMatchObject({ code: "ARTIFACT_TOOL_UNAVAILABLE" });
    expect(JSON.stringify(projection)).not.toMatch(/bucket|signature|private-key/iu);
  });

  it("没有 Resource/Artifact 真实依赖时生产 Factory 构造即失败", () => {
    expect(
      () => new ArtifactToolRouterFactory({ resources: undefined, artifacts: undefined } as never),
    ).toThrowError(ArtifactToolError);
  });
});
