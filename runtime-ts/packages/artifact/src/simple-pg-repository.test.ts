import { sha256Digest } from "@hoox/domain";
import { TransactionCommitUnknownError, type Pool } from "@hoox/persistence/postgres";
import { describe, expect, it } from "vitest";
import type { ArtifactExecutionAuthorization } from "./authorization.js";
import {
  SimpleDeliveryCommitResultUnknownError,
  type SimpleDeliveredFileRepositoryPort,
} from "./simple-delivery.js";
import { PgSimpleDeliveredFileRepository } from "./simple-pg-repository.js";

describe("PgSimpleDeliveredFileRepository COMMIT unknown", () => {
  it("COMMIT 响应未知但规范事实可读回时返回既有 published 结果", async () => {
    const repository = new PgSimpleDeliveredFileRepository(poolWithUnknownCommit("found"));

    await expect(repository.commit(commitInput())).resolves.toMatchObject({
      artifactId: "artifact_simple_unknown",
      resourceVersionId: "resource_version_simple_unknown",
      name: "report.pdf",
      size: 3,
      sha256: "b".repeat(64),
      mediaType: "application/pdf",
    });
  });

  it("COMMIT 响应未知且规范读回成功确认缺失时收敛为确定失败", async () => {
    const repository = new PgSimpleDeliveredFileRepository(poolWithUnknownCommit("missing"));

    await expect(repository.commit(commitInput())).rejects.toThrow("DELIVER_FILE_COMMIT_FAILED");
  });

  it("COMMIT 响应未知且规范读回也不可用时保留 unknown，不伪装成确定失败", async () => {
    const repository = new PgSimpleDeliveredFileRepository(poolWithUnknownCommit("unavailable"));

    await expect(repository.commit(commitInput())).rejects.toBeInstanceOf(
      SimpleDeliveryCommitResultUnknownError,
    );
  });
});

function poolWithUnknownCommit(readback: "found" | "missing" | "unavailable"): Pool {
  let connections = 0;
  return {
    connect: async () => {
      connections += 1;
      if (connections === 2 && readback === "unavailable") {
        throw new Error("readback connection unavailable");
      }
      const first = connections === 1;
      return {
        query: async (text: string) => {
          if (first && text.includes("FOR UPDATE OF run,attempt,claim,lease,permit")) {
            throw new TransactionCommitUnknownError();
          }
          if (!first && text.includes("SELECT command.command_digest")) {
            return {
              rows:
                readback === "found"
                  ? [
                      {
                        command_digest: "a".repeat(64),
                        artifact_id: "artifact_simple_unknown",
                        resource_version_id: "resource_version_simple_unknown",
                        name: "report.pdf",
                        digest: "b".repeat(64),
                        media_type: "application/pdf",
                        size: "3",
                        target: "published",
                      },
                    ]
                  : [],
              rowCount: readback === "found" ? 1 : 0,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
    },
  } as unknown as Pool;
}

function commitInput(): Parameters<SimpleDeliveredFileRepositoryPort["commit"]>[0] {
  return {
    authorization: {
      scope: {
        tenantId: "tenant_simple_unknown",
        threadId: "thread_simple_unknown",
        runId: "run_simple_unknown",
        rootRunId: "run_simple_unknown",
        workspaceId: "workspace_simple_unknown",
      },
      attemptId: "attempt_simple_unknown",
    } as ArtifactExecutionAuthorization,
    idempotencyKey: "call-simple-unknown",
    commandDigest: sha256Digest("a".repeat(64)),
    ids: {
      artifactId: "artifact_simple_unknown",
      resourceId: "resource_simple_unknown",
      resourceVersionId: "resource_version_simple_unknown",
      deliverableKey: "deliverable_simple_unknown",
    },
    sourcePath: "report.pdf",
    name: "report.pdf",
    mediaType: "application/pdf",
    persisted: {
      referenceId: "reference-simple-unknown",
      blob: {
        kind: "stable",
        tenantId: "tenant_simple_unknown",
        purpose: "resource",
        sha256: "b".repeat(64),
        size: 3,
        mediaType: "application/pdf",
        incarnationId: "00000000-0000-4000-8000-000000000099",
        physicalObjectKey: "agent-runtime/stable/resource/simple-unknown",
      },
    },
  } as Parameters<SimpleDeliveredFileRepositoryPort["commit"]>[0];
}
