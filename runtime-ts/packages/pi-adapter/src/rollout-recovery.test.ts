import { type RuntimeRolloutEntry, sha256Digest } from "@cube-runtime/domain";
import { FakeSandboxHandle } from "@cube-runtime/sandbox/testing";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createRecoveredSafePiSession,
  projectRuntimeRecovery,
  RuntimeRecoveryError,
  type RuntimeRecoveryFacts,
} from "./rollout-recovery.js";

const compatibility = {
  modelId: "faux-recovery-model",
  modelCompatibilityHash: sha256Digest("model"),
  promptPolicyHash: sha256Digest("prompt"),
  toolSchemaHash: sha256Digest("tools"),
  skillManifestHash: sha256Digest("skills"),
};

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
    bodyDigest: sha256Digest(JSON.stringify(body)),
    isTruncated: false,
    occurredAt: "2026-07-28T00:00:00.000Z" as RuntimeRolloutEntry["occurredAt"],
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function facts(tail: readonly RuntimeRolloutEntry[]): RuntimeRecoveryFacts {
  return { recordedCompatibility: compatibility, tail };
}

describe("Runtime Rollout → Pi 恢复投影", () => {
  it("严格拒绝五项兼容身份中的任意漂移", () => {
    expect(() =>
      projectRuntimeRecovery({
        expectedCompatibility: { ...compatibility, toolSchemaHash: sha256Digest("other-tools") },
        facts: facts([]),
      }),
    ).toThrow(new RuntimeRecoveryError("COMPATIBILITY_MISMATCH"));
  });

  it("严格配对工具事实；未配对尾部进入明确协调分支", () => {
    expect(
      projectRuntimeRecovery({
        expectedCompatibility: compatibility,
        facts: facts([entry(0, "tool_call", { name: "sandbox_read_file" }, "call-0")]),
      }),
    ).toEqual({ outcome: "requires_tool_reconciliation", pendingToolCallId: "call-0" });
    expect(() =>
      projectRuntimeRecovery({
        expectedCompatibility: compatibility,
        facts: facts([entry(0, "tool_result", { text: "伪造结果" }, "call-0")]),
      }),
    ).toThrow(new RuntimeRecoveryError("MALFORMED_FACTS"));
  });

  it("checkpoint 仅替换模型投影，tail 事实按序追加且重启结果确定", () => {
    const input: RuntimeRecoveryFacts = {
      recordedCompatibility: compatibility,
      checkpoint: {
        checkpointId: "cp-recovery",
        windowStartSequence: 0,
        throughSequence: 3,
        projection: {
          schemaVersion: 1,
          checkpointId: "cp-recovery",
          turns: [{ role: "user", text: "已压缩的历史" }],
        },
        projectionDigest: sha256Digest("projection"),
        replacementHistory: [{ from: 0, through: 3 }],
        createdAt: "2026-07-28T00:00:00.000Z" as never,
      },
      tail: [
        entry(4, "user", { text: "新的问题" }),
        entry(5, "tool_call", { name: "sandbox_read_file" }, "call-5"),
        entry(6, "tool_result", { text: "只保留事实，不进入文本投影" }, "call-5"),
        entry(7, "assistant", { text: "新的回答" }),
      ],
    };
    const first = projectRuntimeRecovery({ expectedCompatibility: compatibility, facts: input });
    const second = projectRuntimeRecovery({ expectedCompatibility: compatibility, facts: input });
    expect(first).toEqual(second);
    expect(first).toEqual({
      outcome: "ready",
      projection: {
        schemaVersion: 1,
        checkpointId: "cp-recovery",
        turns: [
          { role: "user", text: "已压缩的历史" },
          { role: "user", text: "新的问题" },
          { role: "assistant", text: "新的回答" },
        ],
      },
    });
  });

  it.runIf(process.platform === "linux")(
    "Linux Faux Pi 从恢复投影创建全新 Session，且不暴露 compaction",
    async () => {
      const faux = fauxProvider({
        api: "faux-recovery",
        provider: "faux-recovery",
        tokensPerSecond: 10_000,
      });
      faux.setResponses([fauxAssistantMessage("恢复后继续")]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const controller = await createRecoveredSafePiSession({
        model: faux.getModel(),
        modelRuntime,
        sandbox: new FakeSandboxHandle("recovery-fake"),
        expectedCompatibility: compatibility,
        facts: facts([entry(0, "user", { text: "恢复前的问题" })]),
        authorizeToolEffect: async () => ({
          consumedAtMonotonicMs: performance.now(),
          maxContinuationDelayMs: 100,
        }),
      });
      try {
        expect(controller.getDiagnostics().compactionEnabled).toBe(false);
        expect("compact" in controller).toBe(false);
        await controller.prompt("恢复后的输入");
      } finally {
        controller.dispose();
      }
    },
  );
});
