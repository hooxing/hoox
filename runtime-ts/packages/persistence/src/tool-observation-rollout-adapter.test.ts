import {
  agentThreadId,
  isoTimestamp,
  runId,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@aisay/domain";
import { describe, expect, it } from "vitest";
import { PersistenceError } from "./errors.js";
import type { PgRuntimeRolloutRepository } from "./pg-runtime-rollout.js";
import { PgToolObservationRolloutAdapter } from "./tool-observation-rollout-adapter.js";

const executionScope = {
  tenantId: tenantId("tenant_adapter"),
  threadId: threadId("thread_adapter"),
  runId: runId("run_adapter"),
  rootRunId: runId("run_adapter"),
  workspaceId: workspaceId("workspace_adapter"),
};
const fence = {
  scope: executionScope,
  runClaim: { token: "claim_adapter", epoch: 1, expiresAt: isoTimestamp("2026-07-28T01:00:00Z") },
  workspaceLease: {
    rootRunId: executionScope.rootRunId,
    epoch: 2,
    expiresAt: isoTimestamp("2026-07-28T01:00:00Z"),
  },
};
const context = {
  scope: {
    tenantId: tenantId("tenant_adapter"),
    threadId: threadId("thread_adapter"),
    runId: runId("run_adapter"),
    attemptId: "attempt_adapter",
    agentThreadId: agentThreadId("agent_adapter"),
  },
  userId: userId("user_adapter"),
  fence,
};
const binding = {
  ...executionScope,
  attemptId: context.scope.attemptId,
  agentThreadId: context.scope.agentThreadId,
  runClaimToken: fence.runClaim.token,
  runClaimEpoch: fence.runClaim.epoch,
  workspaceLeaseRootRunId: fence.workspaceLease.rootRunId,
  workspaceLeaseEpoch: fence.workspaceLease.epoch,
};
const command = {
  binding,
  idempotencyKey: "result.adapter",
  toolCallId: "call_adapter",
  body: { toolName: "sandbox_command", observation: "ok" },
  isTruncated: false,
  blob: { referenceId: "reference_adapter", sha256: "a".repeat(64), size: 2 },
};

describe("PostgreSQL Tool Observation adapter", () => {
  it("自动写入 tool_call 前驱并绑定真实工具名", async () => {
    let received: unknown;
    const repository = {
      append: async (input: unknown) => {
        received = input;
        return { outcome: "created", value: [] } as const;
      },
    } as Pick<PgRuntimeRolloutRepository, "append">;
    await expect(
      new PgToolObservationRolloutAdapter(repository, context).appendToolCall({
        binding,
        idempotencyKey: "call.adapter",
        toolCallId: "call_adapter",
        toolName: "sandbox_command",
      }),
    ).resolves.toEqual({ outcome: "created" });
    expect(received).toMatchObject({
      entries: [
        { kind: "tool_call", toolCallId: "call_adapter", body: { toolName: "sandbox_command" } },
      ],
    });
  });

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

  it("committed-but-unknown 使用同键同正文重放收敛", async () => {
    const calls: unknown[] = [];
    const repository = {
      append: async (input: unknown) => {
        calls.push(input);
        if (calls.length === 1) throw new PersistenceError("UNAVAILABLE", "提交结果未知");
        return { outcome: "replayed", value: [] } as const;
      },
    } as Pick<PgRuntimeRolloutRepository, "append">;

    await expect(
      new PgToolObservationRolloutAdapter(repository, context).appendToolResult(command),
    ).resolves.toEqual({ outcome: "replayed" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toBe(calls[1]);
  });

  it("连续连接重置后仍使用同一冻结命令有界收敛", async () => {
    const calls: unknown[] = [];
    const repository = {
      append: async (input: unknown) => {
        calls.push(input);
        if (calls.length < 4) throw new PersistenceError("UNAVAILABLE", "连接被连续重置");
        return { outcome: "replayed", value: [] } as const;
      },
    } as Pick<PgRuntimeRolloutRepository, "append">;

    await expect(
      new PgToolObservationRolloutAdapter(repository, context).appendToolResult(command),
    ).resolves.toEqual({ outcome: "replayed" });
    expect(calls).toHaveLength(4);
    expect(new Set(calls).size).toBe(1);
  });

  it("拒绝错装到另一执行 scope、Attempt、Agent Thread 或双栅栏的 adapter", async () => {
    let called = false;
    const repository = {
      append: async () => {
        called = true;
        return { outcome: "created", value: [] } as const;
      },
    } as Pick<PgRuntimeRolloutRepository, "append">;
    const adapter = new PgToolObservationRolloutAdapter(repository, context);
    await expect(
      adapter.appendToolResult({
        ...command,
        binding: { ...binding, attemptId: "attempt_other" },
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      adapter.appendToolCall({
        binding: { ...binding, agentThreadId: "agent_other" as never },
        idempotencyKey: "call.wrong",
        toolCallId: "call_wrong",
        toolName: "sandbox_command",
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      adapter.appendToolResult({
        ...command,
        binding: { ...binding, workspaceId: "workspace_other" },
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      adapter.appendToolResult({
        ...command,
        binding: { ...binding, runClaimToken: "claim_other" },
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    expect(called).toBe(false);
  });
});
