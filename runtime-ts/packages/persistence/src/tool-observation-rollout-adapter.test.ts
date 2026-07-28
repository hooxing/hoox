import { agentThreadId, runId, tenantId, threadId, userId } from "@cube-runtime/domain";
import { describe, expect, it } from "vitest";
import { PersistenceError } from "./errors.js";
import type { PgRuntimeRolloutRepository } from "./pg-runtime-rollout.js";
import { PgToolObservationRolloutAdapter } from "./tool-observation-rollout-adapter.js";

const context = {
  scope: {
    tenantId: tenantId("tenant_adapter"),
    threadId: threadId("thread_adapter"),
    runId: runId("run_adapter"),
    attemptId: "attempt_adapter",
    agentThreadId: agentThreadId("agent_adapter"),
  },
  userId: userId("user_adapter"),
};
const command = {
  idempotencyKey: "result.adapter",
  toolCallId: "call_adapter",
  body: { toolName: "sandbox_command", observation: "ok" },
  isTruncated: false,
  blob: { referenceId: "reference_adapter", sha256: "a".repeat(64), size: 2 },
};

describe("PostgreSQL Tool Observation adapter", () => {
  it("保持 toolCallId 与 stable trace 摘要，不改写配对身份", async () => {
    let received: unknown;
    const repository = {
      append: async (input: unknown) => {
        received = input;
        return { outcome: "created", value: [] } as const;
      },
    } as Pick<PgRuntimeRolloutRepository, "append">;
    await expect(
      new PgToolObservationRolloutAdapter(repository, context).appendToolResult(command),
    ).resolves.toEqual({ outcome: "created" });
    expect(received).toMatchObject({
      entries: [
        {
          kind: "tool_result",
          toolCallId: "call_adapter",
          blob: { referenceId: "reference_adapter", size: 2 },
        },
      ],
    });
  });

  it("授权缺失稳定收敛为 conflict，基础设施错误脱敏为 unknown", async () => {
    const missing = { append: async () => ({ outcome: "not_found" }) } as Pick<
      PgRuntimeRolloutRepository,
      "append"
    >;
    await expect(
      new PgToolObservationRolloutAdapter(missing, context).appendToolResult(command),
    ).resolves.toEqual({ outcome: "conflict" });
    const failed = {
      append: async () => {
        throw new PersistenceError("UNAVAILABLE", "包含内部连接信息");
      },
    } as Pick<PgRuntimeRolloutRepository, "append">;
    await expect(
      new PgToolObservationRolloutAdapter(failed, context).appendToolResult(command),
    ).resolves.toEqual({ outcome: "unknown" });
  });
});
