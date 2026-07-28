import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertControlledToolObservation,
  encodeControlledToolReceipt,
  parseControlledToolReceipt,
  ToolObservationPipeline,
  type StableTraceBlobIdentity,
  type ToolObservationRolloutPort,
  type TraceBlobPersistencePort,
} from "./tool-observation.js";

const tenantId = "tenant_observation";
const callId = "call_observation";

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
function stable(body: Uint8Array): StableTraceBlobIdentity {
  return {
    kind: "stable",
    tenantId,
    purpose: "trace",
    sha256: digest(body),
    size: body.byteLength,
    incarnationId: "incarnation_observation",
    physicalObjectKey: "trace/observation",
  };
}

class Traces implements TraceBlobPersistencePort {
  readonly calls: Parameters<TraceBlobPersistencePort["persistTrace"]>[0][] = [];
  outcome: "persisted" | "replayed" | "conflict" | "unavailable" | "unknown" = "persisted";
  async persistTrace(input: Parameters<TraceBlobPersistencePort["persistTrace"]>[0]) {
    this.calls.push(input);
    if (this.outcome === "conflict" || this.outcome === "unavailable" || this.outcome === "unknown")
      return { outcome: this.outcome } as const;
    return {
      outcome: this.outcome,
      referenceId: "reference_observation",
      blob: stable(input.body),
    } as const;
  }
}
class Rollout implements ToolObservationRolloutPort {
  readonly calls: Parameters<ToolObservationRolloutPort["appendToolResult"]>[0][] = [];
  outcome: "created" | "replayed" | "conflict" | "unavailable" | "unknown" = "created";
  async appendToolCall() {
    return { outcome: this.outcome } as const;
  }
  async appendToolResult(input: Parameters<ToolObservationRolloutPort["appendToolResult"]>[0]) {
    this.calls.push(input);
    return { outcome: this.outcome } as const;
  }
}
function pipeline(max = 80) {
  const traces = new Traces();
  const rollout = new Rollout();
  return {
    traces,
    rollout,
    subject: new ToolObservationPipeline(
      traces,
      rollout,
      { readControlledReceipt: async () => currentOutput },
      { maxModelObservationBytes: max },
    ),
  };
}
let currentOutput = encodeControlledToolReceipt("sandbox_command", "succeeded");
function input(_output: string) {
  currentOutput = encodeControlledToolReceipt("sandbox_command", "succeeded");
  return {
    binding: {
      tenantId,
      threadId: "thread_observation",
      runId: "run_observation",
      rootRunId: "run_observation",
      workspaceId: "workspace_observation",
      attemptId: "attempt_observation",
      agentThreadId: "agent_observation",
      runClaimToken: "claim_observation",
      runClaimEpoch: 1,
      workspaceLeaseRootRunId: "run_observation",
      workspaceLeaseEpoch: 1,
    },
    idempotencyKey: "observation_command",
    toolCallId: callId,
    toolName: "sandbox_command",
  };
}
function recorded(result: Awaited<ReturnType<ToolObservationPipeline["record"]>>) {
  if (result.outcome !== "recorded" && result.outcome !== "replayed")
    throw new Error("测试需要已记录结果");
  return result;
}

describe("Tool Observation Blob 截断切片", () => {
  it("先保存固定受控回执，再将严格有界 observation 与 trace Blob 写入 Rollout", async () => {
    const { subject, traces, rollout } = pipeline(30);
    const result = await subject.record(input("😀😀😀😀😀😀😀😀😀😀😀😀"));
    expect(result).toMatchObject({ outcome: "recorded", isTruncated: true });
    expect(Buffer.byteLength(recorded(result).observation, "utf8")).toBeLessThanOrEqual(30);
    expect(traces.calls[0]?.body).toEqual(Buffer.from(currentOutput, "utf8"));
    expect(rollout.calls[0]).toMatchObject({
      toolCallId: callId,
      isTruncated: true,
      blob: { referenceId: "reference_observation" },
    });
    expect(rollout.calls[0]?.body).toMatchObject({
      toolName: "sandbox_command",
      receiptSha256: digest(traces.calls[0]?.body ?? new Uint8Array()),
      truncation: { reason: "model_utf8_budget_or_rollout_body_budget" },
    });
  });

  it("极小预算也不超字节上限，且不会切开 Unicode", async () => {
    const { subject } = pipeline(1);
    const result = await subject.record(input("😀x"));
    expect(result).toMatchObject({ outcome: "recorded", isTruncated: true, observation: "{" });
    expect(Buffer.byteLength(recorded(result).observation, "utf8")).toBe(1);
  });

  it("Blob 失败或未知时不写 Rollout，也不返回已保存的 observation", async () => {
    const { subject, traces, rollout } = pipeline();
    traces.outcome = "unknown";
    await expect(subject.record(input("large output"))).resolves.toEqual({ outcome: "unknown" });
    expect(rollout.calls).toHaveLength(0);
  });

  it("重放使用固定命令键，且 Rollout replay 保留同一结果", async () => {
    const { subject, traces, rollout } = pipeline();
    traces.outcome = "replayed";
    rollout.outcome = "replayed";
    await expect(subject.record(input("ok"))).resolves.toMatchObject({
      outcome: "replayed",
      isTruncated: true,
    });
    expect(traces.calls[0]?.idempotencyKey).toBe("observation_command.trace");
    expect(rollout.calls[0]?.idempotencyKey).toBe("observation_command.rollout");
  });

  it("拒绝跨租户或摘要不匹配的伪造 stable Blob", async () => {
    const { subject, traces } = pipeline();
    traces.persistTrace = async (value) => ({
      outcome: "persisted",
      referenceId: "reference_observation",
      blob: { ...stable(value.body), tenantId: "tenant_other" },
    });
    await expect(subject.record(input("x"))).rejects.toThrow("无效 stable 身份");
  });

  it("模型预算与 Rollout 16KiB 预算独立生效，恶意物理键不进入 body", async () => {
    const { subject, rollout } = pipeline(100_000);
    const result = recorded(await subject.record(input("x".repeat(30_000))));
    expect(Buffer.byteLength(result.observation, "utf8")).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(rollout.calls[0]?.body), "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(JSON.stringify(rollout.calls[0]?.body)).not.toContain("trace/observation");
  });

  it("截断标记必须严格对应完整回执的更短 UTF-8 前缀", () => {
    const encoded = encodeControlledToolReceipt("sandbox_command", "succeeded");
    const receipt = parseControlledToolReceipt(encoded);
    const bytes = Buffer.byteLength(encoded, "utf8");
    expect(() =>
      assertControlledToolObservation({
        receipt,
        observation: encoded,
        isTruncated: true,
        modelVisibleBytes: bytes,
        reason: "model_utf8_budget_or_rollout_body_budget",
      }),
    ).toThrow("严格短于");
    expect(() =>
      assertControlledToolObservation({
        receipt,
        observation: `${encoded}x`,
        isTruncated: true,
        modelVisibleBytes: bytes + 1,
        reason: "model_utf8_budget_or_rollout_body_budget",
      }),
    ).toThrow("严格短于");
    expect(() =>
      assertControlledToolObservation({
        receipt,
        observation: encoded.slice(0, -1),
        isTruncated: false,
        modelVisibleBytes: bytes - 1,
      }),
    ).toThrow("未截断");
  });
});
