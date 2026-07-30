import {
  isoTimestamp,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  workspaceId,
} from "@cube-runtime/domain";
import type { StableBlobRef } from "@cube-runtime/persistence";
import type {
  ConsumedExternalEffectAuthorization,
  ExecutionScope,
} from "@cube-runtime/run-contracts";
import { describe, expect, it } from "vitest";
import { createArtifactExecutionAuthorizationAuthority } from "./authorization.js";
import {
  SimpleArtifactDeliveryService,
  type SimpleDeliveredFileRepositoryPort,
} from "./simple-delivery.js";

const scope: ExecutionScope = {
  tenantId: tenantId("tenant_simple_delivery"),
  threadId: threadId("thread_simple_delivery"),
  runId: runId("run_simple_delivery"),
  rootRunId: runId("run_simple_delivery"),
  workspaceId: workspaceId("workspace_simple_delivery"),
};

describe("SimpleArtifactDeliveryService", () => {
  it("计算二进制身份并只在 Repository 提交 published 事实后成功", async () => {
    const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 100 });
    const argsDigest = sha256Digest("a".repeat(64));
    const authorization = authority.issuer.issue({
      attemptId: "attempt-simple-delivery",
      consumed: consumed(argsDigest),
    });
    let committed: Parameters<SimpleDeliveredFileRepositoryPort["commit"]>[0] | undefined;
    const service = new SimpleArtifactDeliveryService(
      {
        commit: async (input) => {
          committed = input;
          return {
            artifactId: input.ids.artifactId,
            resourceVersionId: input.ids.resourceVersionId,
            name: input.name,
            size: input.persisted.blob.size,
            sha256: sha256Digest(input.persisted.blob.sha256),
            mediaType: input.mediaType,
          };
        },
      },
      {
        persist: async (input) => ({
          referenceId: "reference-simple-delivery",
          blob: stable(input.tenantId, input.sha256, input.body.byteLength, input.mediaType),
        }),
      },
      authority.verifier,
    );
    const result = await service.publish({
      authorization,
      idempotencyKey: "call-simple-delivery",
      toolArgsDigest: argsDigest,
      sourcePath: "report.docx",
      name: "报告.docx",
      body: new Uint8Array([0, 255, 1]),
    });

    expect(result).toMatchObject({
      name: "报告.docx",
      size: 3,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(committed).toMatchObject({
      idempotencyKey: "call-simple-delivery",
      sourcePath: "report.docx",
      name: "报告.docx",
      persisted: { referenceId: "reference-simple-delivery" },
    });
    expect(committed?.persisted.blob.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

function consumed(
  argsDigest: ReturnType<typeof sha256Digest>,
): ConsumedExternalEffectAuthorization {
  return {
    permit: {
      permitId: "permit-simple-delivery",
      scope,
      runClaimToken: "claim-simple-delivery",
      runClaimEpoch: 1,
      workspaceRootRunId: scope.rootRunId,
      workspaceLeaseEpoch: 1,
      attemptVersion: 1,
      effect: "tool_execution",
      callId: "call-simple-delivery",
      toolName: "deliver_file",
      argsDigest,
      issuedAt: isoTimestamp("2026-07-30T00:00:00.000Z"),
      expiresAt: isoTimestamp("2026-07-30T00:01:00.000Z"),
    },
    consumedAt: isoTimestamp("2026-07-30T00:00:01.000Z"),
    consumedAtMonotonicMs: 100,
    maxContinuationDelayMs: 1_000,
  };
}

function stable(
  tenant: string,
  sha256: string,
  size: number,
  mediaType: string,
): StableBlobRef & { readonly purpose: "resource" } {
  return {
    kind: "stable",
    tenantId: tenant,
    purpose: "resource",
    sha256,
    size,
    mediaType,
    incarnationId: "00000000-0000-4000-8000-000000000077",
    physicalObjectKey: "agent-runtime/stable/resource/simple-delivery",
  };
}
