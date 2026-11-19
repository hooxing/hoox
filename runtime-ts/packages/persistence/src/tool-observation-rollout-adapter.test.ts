import {
  agentThreadId,
  isoTimestamp,
  runId,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@hoox/domain";
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

describe("PTC journal 分流", () => {
  it("有父 ID 的开始和结果只进 journal，不调用 native append", async () => {
    const native: unknown[] = [];
    const starts: unknown[] = [];
    const results: unknown[] = [];
    const repository = {
      append: async (input: unknown) => {
        native.push(input);
        return { outcome: "created", value: [] } as const;
      },
      appendPtcToolCall: async (input: unknown) => {
        starts.push(input);
        return { outcome: "created", value: undefined } as const;
      },
      appendPtcToolResult: async (input: unknown) => {
        results.push(input);
        return { outcome: "created", value: undefined } as const;
      },
    };
    const adapter = new PgToolObservationRolloutAdapter(repository, context);
    expect(
      await adapter.appendToolCall({
        binding,
        idempotencyKey: "ptc.start",
        toolCallId: command.toolCallId,
        toolName: "read",
        parentToolCallId: "outer_call",
      }),
    ).toEqual({ outcome: "created" });
    expect(await adapter.appendToolResult({ ...command, parentToolCallId: "outer_call" })).toEqual({
      outcome: "created",
    });
    expect(native).toHaveLength(0);
    expect(starts[0]).toMatchObject({
      parentToolCallId: "outer_call",
      toolName: "read",
      toolCallId: command.toolCallId,
    });
    expect(results[0]).toMatchObject({
      parentToolCallId: "outer_call",
      body: command.body,
      blob: command.blob,
    });
  });

  it("内联回执不带 Blob 进入 native 与 PTC 写入，不再以缺 Blob 拒绝", async () => {
    const native: { entries: readonly Record<string, unknown>[] }[] = [];
    const results: Record<string, unknown>[] = [];
    const repository = {
      append: async (input: { entries: readonly Record<string, unknown>[] }) => {
        native.push(input);
        return { outcome: "created", value: [] } as const;
      },
      appendPtcToolResult: async (input: Record<string, unknown>) => {
        results.push(input);
        return { outcome: "created", value: undefined } as const;
      },
    } as unknown as PgRuntimeRolloutRepository;
    const adapter = new PgToolObservationRolloutAdapter(repository, context);
    const { blob: _blob, ...inline } = command;
    expect(await adapter.appendToolResult(inline)).toEqual({ outcome: "created" });
    expect(await adapter.appendToolResult({ ...inline, parentToolCallId: "outer_call" })).toEqual({
      outcome: "created",
    });
    expect(native[0]?.entries[0]).not.toHaveProperty("blob");
    expect(results[0]).not.toHaveProperty("blob");
    expect(results[0]).toMatchObject({ parentToolCallId: "outer_call", body: command.body });
  });

  it("缺失 PTC 能力不能静默写回 Rollout", async () => {
    let calls = 0;
    const adapter = new PgToolObservationRolloutAdapter(
      {
        append: async () => {
          calls += 1;
          return { outcome: "created", value: [] } as const;
        },
      },
      context,
    );
    expect(await adapter.appendToolResult({ ...command, parentToolCallId: "outer_call" })).toEqual({
      outcome: "unavailable",
    });
    expect(calls).toBe(0);
  });

  it("journal committed-but-unknown 以同对象同键收敛且冻结嵌套正文", async () => {
    for (const kind of ["call", "result"]) {
      const calls: unknown[] = [];
      const write = async (input: unknown) => {
        calls.push(input);
        if (calls.length === 1) throw new PersistenceError("UNAVAILABLE", "提交结果未知");
        return { outcome: "replayed", value: undefined } as const;
      };
      const adapter = new PgToolObservationRolloutAdapter(
        {
          append: async () => {
            throw new Error("内层不得进入 Rollout");
          },
          appendPtcToolCall: write,
          appendPtcToolResult: write,
        },
        context,
      );
      const result =
        kind === "call"
          ? await adapter.appendToolCall({
              binding,
              idempotencyKey: "ptc.start",
              toolCallId: command.toolCallId,
              toolName: "read",
              parentToolCallId: "outer_call",
            })
          : await adapter.appendToolResult({ ...command, parentToolCallId: "outer_call" });
      expect(result).toEqual({ outcome: "replayed" });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(calls[1]);
      expect(Object.isFrozen(calls[0])).toBe(true);
      expect(Object.isFrozen((calls[0] as { body: unknown }).body)).toBe(true);
    }
  });

  it("journal 授权失效与约束错误不伪装成功；连续未知不合成结果", async () => {
    for (const outcome of ["not_authorized", "not_found", "conflict"] as const) {
      const adapter = new PgToolObservationRolloutAdapter(
        {
          append: async () => ({ outcome: "created", value: [] }) as const,
          appendPtcToolResult: async () => ({ outcome }),
        },
        context,
      );
      expect(
        await adapter.appendToolResult({ ...command, parentToolCallId: "outer_call" }),
      ).toEqual({ outcome: "conflict" });
    }
    let calls = 0;
    const adapter = new PgToolObservationRolloutAdapter(
      {
        append: async () => ({ outcome: "created", value: [] }) as const,
        appendPtcToolResult: async () => {
          calls += 1;
          throw new PersistenceError("UNAVAILABLE", "结果未知");
        },
      },
      context,
    );
    expect(await adapter.appendToolResult({ ...command, parentToolCallId: "outer_call" })).toEqual({
      outcome: "unknown",
    });
    expect(calls).toBe(4);
  });
});
