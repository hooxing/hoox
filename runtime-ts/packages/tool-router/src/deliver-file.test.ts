import {
  createArtifactExecutionAuthorizationAuthority,
  SimpleDeliveryCleanupResultUnknownError,
  SimpleDeliveryCommitResultUnknownError,
} from "@cube-runtime/artifact";
import {
  artifactId,
  isoTimestamp,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  workspaceId,
} from "@cube-runtime/domain";
import type {
  ConsumedExternalEffectAuthorization,
  ExecutionScope,
} from "@cube-runtime/run-contracts";
import type { SandboxHandle } from "@cube-runtime/sandbox";
import { describe, expect, it } from "vitest";
import { type DeliverFileReadResult, DeliverFileToolRouterFactory } from "./deliver-file.js";

const scope: ExecutionScope = {
  tenantId: tenantId("tenant_deliver"),
  threadId: threadId("thread_deliver"),
  runId: runId("run_deliver"),
  rootRunId: runId("run_deliver"),
  workspaceId: workspaceId("workspace_deliver"),
};

function harness(read: DeliverFileReadResult, publicationError?: Error) {
  const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 100 });
  const publications: unknown[] = [];
  const factory = new DeliverFileToolRouterFactory({
    source: { read: async () => read },
    publications: {
      publish: async (input) => {
        publications.push(input);
        if (publicationError !== undefined) throw publicationError;
        return {
          artifactId: artifactId("artifact_delivered"),
          resourceVersionId: resourceVersionId("resource_version_delivered"),
          name: input.name,
          size: input.body.byteLength,
          sha256: sha256Digest("a".repeat(64)),
          mediaType: "application/pdf",
        };
      },
    },
    authorizationVerifier: authority.verifier,
  });
  const router = factory.create({
    binding: {
      scope,
      attemptId: "attempt-deliver",
      sandbox: {
        registryId: "registry-deliver",
        providerKey: "cube",
        providerSandboxId: "sandbox-deliver",
        mode: "created",
        sandbox: {} as SandboxHandle,
      },
    },
    authorizer: {
      authorizeToolEffect: async (call) =>
        authority.issuer.issue({
          attemptId: "attempt-deliver",
          consumed: consumed(call.callId, call.toolName, call.argsDigest),
        }),
    },
  });
  return { router, publications };
}

describe("deliver_file Tool Router", () => {
  it("只接收 Sandbox 绝对路径，并在 published 后返回可下载事实", async () => {
    const { router, publications } = harness({
      outcome: "found",
      relativePath: "reports/final.pdf",
      body: new Uint8Array([1, 2, 3]),
    });
    await expect(
      router.deliverFile({
        callId: "call-deliver-1",
        arguments: { path: "/workspace/reports/final.pdf" },
      }),
    ).resolves.toEqual({
      status: "published",
      artifact_id: "artifact_delivered",
      resource_version_id: "resource_version_delivered",
      name: "final.pdf",
      size: 3,
      sha256: "a".repeat(64),
      media_type: "application/pdf",
      download_ready: true,
    });
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      idempotencyKey: "call-deliver-1",
      sourcePath: "reports/final.pdf",
      name: "final.pdf",
    });
  });

  it("文件不存在时立即返回模型可修正的 FILE_NOT_FOUND", async () => {
    const { router } = harness({ outcome: "not_found" });
    const error = await router
      .deliverFile({
        callId: "call-deliver-2",
        arguments: { path: "/workspace/missing.docx" },
      })
      .catch((caught: unknown) => router.projectError(caught));
    expect(error).toEqual({
      status: "failed",
      code: "FILE_NOT_FOUND",
      message: "Sandbox 文件不存在：/workspace/missing.docx",
      correctable: true,
      fatal: false,
    });
  });

  it.each([
    [
      new SimpleDeliveryCommitResultUnknownError(),
      "PUBLICATION_RESULT_UNKNOWN",
      "文件发布结果未知，需要恢复后确认",
    ],
    [
      new SimpleDeliveryCleanupResultUnknownError(),
      "CLEANUP_RESULT_UNKNOWN",
      "文件发布清理结果未知，需要恢复后确认",
    ],
  ])("把发布/清理 unknown 投影为 fatal，禁止模型修正猜测", async (cause, code, message) => {
    const { router } = harness(
      {
        outcome: "found",
        relativePath: "reports/final.pdf",
        body: new Uint8Array([1, 2, 3]),
      },
      cause,
    );
    const failure = await router
      .deliverFile({
        callId: `call-${code}`,
        arguments: { path: "/workspace/reports/final.pdf" },
      })
      .catch((error: unknown) => router.projectError(error));
    expect(failure).toEqual({
      status: "failed",
      code,
      message,
      correctable: false,
      fatal: true,
    });
  });

  it("拒绝宿主路径、相对路径和模型提供的内部发布字段", async () => {
    const { router } = harness({ outcome: "not_found" });
    for (const [index, arguments_] of [
      { path: "reports/final.pdf" },
      { path: "D:/workspace/final.pdf" },
      { path: "/workspace/final.pdf", artifactId: "model-controlled" },
    ].entries()) {
      await expect(
        router.deliverFile({ callId: `call-invalid-${index}`, arguments: arguments_ }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("在读取和写 Blob 前按 UTF-8 字节拒绝超长交付名称", async () => {
    let reads = 0;
    const authority = createArtifactExecutionAuthorizationAuthority({ now: () => 100 });
    const router = new DeliverFileToolRouterFactory({
      source: {
        read: async () => {
          reads += 1;
          return { outcome: "not_found" };
        },
      },
      publications: { publish: async () => Promise.reject(new Error("不得发布")) },
      authorizationVerifier: authority.verifier,
    }).create({
      binding: {
        scope,
        attemptId: "attempt-deliver",
        sandbox: {
          registryId: "registry-deliver",
          providerKey: "cube",
          providerSandboxId: "sandbox-deliver",
          mode: "created",
          sandbox: {} as SandboxHandle,
        },
      },
      authorizer: {
        authorizeToolEffect: async (call) =>
          authority.issuer.issue({
            attemptId: "attempt-deliver",
            consumed: consumed(call.callId, call.toolName, call.argsDigest),
          }),
      },
    });

    await expect(
      router.deliverFile({
        callId: "call-name-too-long",
        arguments: { path: "/workspace/final.pdf", name: `${"文".repeat(85)}a` },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(reads).toBe(0);
  });
});

function consumed(
  callId: string,
  toolName: string,
  argsDigest: string,
): ConsumedExternalEffectAuthorization {
  return {
    permit: {
      permitId: `permit-${callId}`,
      scope,
      runClaimToken: "claim-deliver",
      runClaimEpoch: 1,
      workspaceRootRunId: scope.rootRunId,
      workspaceLeaseEpoch: 1,
      attemptVersion: 1,
      effect: "tool_execution",
      callId,
      toolName,
      argsDigest: sha256Digest(argsDigest),
      issuedAt: isoTimestamp("2026-07-30T00:00:00.000Z"),
      expiresAt: isoTimestamp("2026-07-30T00:01:00.000Z"),
    },
    consumedAt: isoTimestamp("2026-07-30T00:00:01.000Z"),
    consumedAtMonotonicMs: 100,
    maxContinuationDelayMs: 1_000,
  };
}
