import { sha256Digest } from "@cube-runtime/domain";
import { describe, expect, it } from "vitest";
import {
  compareRecordedContextBudget,
  decideModelAwareContextBudget,
} from "./model-aware-budget.js";

const MODEL = Object.freeze({
  modelId: "pi-test",
  contextWindow: 10_000,
  maxOutputTokens: 1_000,
  compatibilityHash: sha256Digest("a".repeat(64)),
});
const base = () => ({
  model: MODEL,
  trustedSystemPrompt: "可信系统提示",
  toolSchema: '[{"name":"read"}]',
  entries: [] as const,
});

describe("模型感知 Context Budget", () => {
  it("fallback 对中文、emoji 与高熵文本使用 UTF-8 上界，绝不 bytes/4 低估", () => {
    const result = decideModelAwareContextBudget({
      ...base(),
      entries: [
        { sequence: 0, kind: "user", text: "中文🙂\u0000\u00ff高熵" },
        { sequence: 1, kind: "assistant", text: "回应" },
      ],
    });
    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") expect(result.activeEntryTokens).toBeGreaterThanOrEqual(20);
  });

  it("工具调用和结果是不可拆分原子组，不静默丢弃半对", () => {
    const ready = decideModelAwareContextBudget({
      ...base(),
      entries: [
        { sequence: 0, kind: "user", text: "早" },
        { sequence: 1, kind: "tool_call", text: "调用".repeat(12), toolCallId: "call-1" },
        { sequence: 2, kind: "tool_result", text: "结果".repeat(12), toolCallId: "call-1" },
      ],
    });
    expect(ready.outcome).toBe("ready");
    if (ready.outcome === "ready") {
      const kinds = ready.activeEntries.map((entry) => entry.kind);
      expect(kinds.includes("tool_call")).toBe(kinds.includes("tool_result"));
    }
    expect(() =>
      decideModelAwareContextBudget({
        ...base(),
        entries: [{ sequence: 0, kind: "tool_call", text: "x", toolCallId: "x" }],
      }),
    ).toThrow("工具调用缺少对应结果");
  });

  it("极小窗口、非法配置与单个原子组过大都失败关闭", () => {
    expect(() =>
      decideModelAwareContextBudget({ ...base(), model: { ...MODEL, contextWindow: 0 } }),
    ).toThrow("正安全整数");
    expect(() =>
      decideModelAwareContextBudget({ ...base(), safetyMarginRatio: Number.NaN }),
    ).toThrow("有限数值");
    const reserved = decideModelAwareContextBudget({
      ...base(),
      model: { ...MODEL, contextWindow: 20, maxOutputTokens: 20 },
    });
    expect(reserved.outcome).toBe("context_too_large");
    const atom = decideModelAwareContextBudget({
      ...base(),
      entries: [{ sequence: 0, kind: "user", text: "x".repeat(20_000) }],
    });
    expect(atom).toMatchObject({
      outcome: "context_too_large",
      reason: "single_atomic_entry_exceeds_budget",
    });
  });

  it("模型切换、缩窗和策略变化返回 rebuild_required，且相同输入跨重启稳定", () => {
    const first = decideModelAwareContextBudget(base());
    expect(first.outcome).toBe("ready");
    if (first.outcome !== "ready") return;
    const previous = {
      modelId: MODEL.modelId,
      compatibilityHash: MODEL.compatibilityHash,
      contextWindow: MODEL.contextWindow,
      policyHash: first.policy.policyHash,
    };
    expect(compareRecordedContextBudget(previous, first.policy)).toEqual({ outcome: "compatible" });
    const shrunk = decideModelAwareContextBudget({
      ...base(),
      model: { ...MODEL, contextWindow: 9_000 },
    });
    if (shrunk.outcome !== "ready") throw new Error("测试模型预算未就绪");
    expect(compareRecordedContextBudget(previous, shrunk.policy)).toMatchObject({
      outcome: "rebuild_required",
      reason: "context_window_shrunk",
    });
    expect(
      compareRecordedContextBudget({ ...previous, modelId: "other" }, first.policy),
    ).toMatchObject({
      outcome: "rebuild_required",
      reason: "model_changed",
    });
    const changed = decideModelAwareContextBudget({ ...base(), recoveryMarginRatio: 0.1 });
    if (changed.outcome !== "ready") throw new Error("测试策略预算未就绪");
    expect(compareRecordedContextBudget(previous, changed.policy)).toMatchObject({
      outcome: "rebuild_required",
      reason: "policy_changed",
    });
  });

  it("固定输入、协议开销和聚合溢出全部进入预算", () => {
    const withFixed = decideModelAwareContextBudget({
      ...base(),
      additionalFixedInputs: ["低信任内容".repeat(200)],
      providerOverheadTokens: 512,
    });
    expect(withFixed.outcome).toBe("ready");
    if (withFixed.outcome === "ready") {
      expect(withFixed.policy.additionalFixedInputTokens).toBeGreaterThan(1_000);
      expect(withFixed.policy.providerOverheadTokens).toBe(512);
    }
    expect(() =>
      decideModelAwareContextBudget({
        ...base(),
        providerOverheadTokens: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("安全整数");
  });
});
