import { createHash } from "node:crypto";
import { type RuntimeRolloutEntry, sha256Digest } from "@cube-runtime/domain";
import { FakeSandboxHandle } from "@cube-runtime/sandbox/testing";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  projectLoadedRuntimeRecovery,
  RuntimeRecoveryError,
  type RuntimeRolloutLoadRecoveryResult,
  recoverSafePiSession,
} from "./rollout-recovery.js";

const HASH_A = sha256Digest("a".repeat(64));

function digest(value: unknown) {
  return sha256Digest(
    createHash("sha256")
      .update(JSON.stringify(canonical(value)), "utf8")
      .digest("hex"),
  );
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function entry(
  sequence: number,
  kind: RuntimeRolloutEntry["kind"],
  body: Record<string, unknown> = {},
  toolCallId?: string,
): RuntimeRolloutEntry {
  return {
    sequence,
    kind,
    body,
    bodyDigest: digest(body),
    isTruncated: false,
    occurredAt: "2026-07-28T00:00:00.000Z" as RuntimeRolloutEntry["occurredAt"],
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function loaded(
  tail: readonly RuntimeRolloutEntry[],
): Extract<RuntimeRolloutLoadRecoveryResult, { outcome: "loaded" }> {
  return {
    outcome: "loaded",
    recordedCompatibility: {
      modelId: "placeholder",
      modelCompatibilityHash: HASH_A,
      promptPolicyHash: HASH_A,
      toolSchemaHash: HASH_A,
      skillManifestHash: HASH_A,
    },
    tail,
  };
}

describe("Runtime Rollout → Pi 恢复投影", () => {
  it("不排序掩盖乱序输入，并校验每条事实 bodyDigest", () => {
    expect(() =>
      projectLoadedRuntimeRecovery(
        loaded([entry(1, "assistant", { text: "后" }), entry(0, "user", { text: "前" })]),
      ),
    ).toThrow(new RuntimeRecoveryError("MALFORMED_FACTS"));
    const tampered = { ...entry(0, "user", { text: "原文" }), body: { text: "篡改" } };
    expect(() => projectLoadedRuntimeRecovery(loaded([tampered]))).toThrow(
      new RuntimeRecoveryError("MALFORMED_FACTS"),
    );
  });

  it("严格配对工具事实；未配对尾部保留协调信息且不伪造结果", () => {
    expect(
      projectLoadedRuntimeRecovery(
        loaded([entry(0, "tool_call", { name: "sandbox_read_file" }, "call-0")]),
      ),
    ).toEqual({
      outcome: "requires_tool_reconciliation",
      action: "reconcile_external_effect",
      pendingToolCallId: "call-0",
      pendingToolCallSequence: 0,
    });
    expect(() =>
      projectLoadedRuntimeRecovery(
        loaded([entry(0, "tool_result", { text: "伪造结果" }, "call-0")]),
      ),
    ).toThrow(new RuntimeRecoveryError("MALFORMED_FACTS"));
  });

  it("验证 checkpoint 摘要、replacement 前缀与窗口，重启投影确定", () => {
    const projection = {
      schemaVersion: 1,
      checkpointId: "cp-recovery",
      turns: [{ role: "user", text: "已压缩的历史" }],
    };
    const input = {
      ...loaded([
        entry(4, "user", { text: "新的问题" }),
        entry(5, "tool_call", { name: "sandbox_read_file" }, "call-5"),
        entry(6, "tool_result", { text: "工具事实" }, "call-5"),
        entry(7, "assistant", { text: "新的回答" }),
      ]),
      checkpoint: {
        checkpointId: "cp-recovery",
        windowStartSequence: 0,
        throughSequence: 3,
        projection,
        projectionDigest: digest(projection),
        replacementHistory: [{ from: 0, through: 3 }],
        createdAt: "2026-07-28T00:00:00.000Z" as RuntimeRolloutEntry["occurredAt"],
      },
    };
    const first = projectLoadedRuntimeRecovery(input);
    expect(first).toEqual(projectLoadedRuntimeRecovery(input));
    expect(first).toMatchObject({
      outcome: "ready",
      projection: {
        checkpointId: "cp-recovery",
        turns: [
          { role: "user", text: "已压缩的历史" },
          { role: "user", text: "新的问题" },
          { role: "assistant", text: "新的回答" },
        ],
      },
    });
    expect(() =>
      projectLoadedRuntimeRecovery({
        ...input,
        checkpoint: { ...input.checkpoint, projectionDigest: HASH_A },
      }),
    ).toThrow(new RuntimeRecoveryError("MALFORMED_FACTS"));
    expect(() =>
      projectLoadedRuntimeRecovery({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          replacementHistory: [{ from: 1, through: 2 }],
        },
      }),
    ).toThrow(new RuntimeRecoveryError("MALFORMED_FACTS"));
  });

  it("公开入口用实际 Session 身份调用 loadRecovery，原样返回 rebuild 且不创建 Session", async () => {
    const harness = await sessionHarness();
    let capturedModelId = "";
    const result = await recoverSafePiSession({
      ...harness.options,
      loadRecovery: async (current) => {
        capturedModelId = current.modelId;
        expect(Object.values(current).slice(1)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/u)]),
        );
        return {
          outcome: "compatibility_mismatch",
          action: "rebuild_attempt",
          mismatches: ["toolSchemaHash"],
        };
      },
    });
    expect(capturedModelId).toBe(harness.faux.getModel().id);
    expect(result).toEqual({
      outcome: "compatibility_mismatch",
      action: "rebuild_attempt",
      mismatches: ["toolSchemaHash"],
    });
  });

  it("公开入口对未配对工具返回协调分支，且不会创建平台 Session", async () => {
    const harness = await sessionHarness();
    const result = await recoverSafePiSession({
      ...harness.options,
      loadRecovery: async (current) => ({
        ...loaded([entry(0, "tool_call", { name: "sandbox_read_file" }, "call-pending")]),
        recordedCompatibility: current,
      }),
    });
    expect(result).toMatchObject({
      outcome: "requires_tool_reconciliation",
      pendingToolCallId: "call-pending",
    });
  });

  it.runIf(process.platform === "linux")(
    "Linux Faux Pi 从 PG loaded 形状创建全新 Session，且无 compaction 入口",
    async () => {
      const harness = await sessionHarness();
      harness.faux.setResponses([fauxAssistantMessage("恢复后继续")]);
      const result = await recoverSafePiSession({
        ...harness.options,
        loadRecovery: async (current) => ({
          ...loaded([entry(0, "user", { text: "恢复前的问题" })]),
          recordedCompatibility: current,
        }),
      });
      expect(result.outcome).toBe("session_created");
      if (result.outcome !== "session_created") return;
      try {
        expect(result.controller.getDiagnostics().compactionEnabled).toBe(false);
        expect("compact" in result.controller).toBe(false);
        await result.controller.prompt("恢复后的输入");
      } finally {
        result.controller.dispose();
      }
    },
  );
});

async function sessionHarness() {
  const faux = fauxProvider({
    api: `faux-recovery-${Date.now()}-${Math.random()}`,
    provider: `faux-recovery-${Date.now()}-${Math.random()}`,
    tokensPerSecond: 10_000,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
  return {
    faux,
    options: {
      model: faux.getModel(),
      modelRuntime,
      sandbox: new FakeSandboxHandle("recovery-fake"),
      authorizeToolEffect: async () => ({
        consumedAtMonotonicMs: performance.now(),
        maxContinuationDelayMs: 100,
      }),
      untrustedPromptContent: {
        tenant: [],
        skill: [{ id: "skill-1", content: "低信任 Skill 内容" }],
        user: [],
      },
    },
  };
}
