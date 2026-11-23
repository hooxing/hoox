import { describe, expect, it, vi } from "vitest";
import {
  evaluateAssertion,
  evaluateCase,
  evaluationReviewerPrompt,
  type EvaluationReviewerPort,
  scoreEvaluationCase,
} from "./evaluation.js";

const evidence = {
  finalText: "订单已完成",
  toolNames: ["lookup"],
  artifacts: [{ name: "invoice", type: "application/pdf" }],
};

describe("评测确定性断言", () => {
  it("检查文本、工具与 Artifact 事实", () => {
    expect(evaluateAssertion({ kind: "text_contains", value: "完成" }, evidence).passed).toBe(true);
    expect(evaluateAssertion({ kind: "tool_called", toolName: "lookup" }, evidence).passed).toBe(
      true,
    );
    expect(
      evaluateAssertion(
        { kind: "artifact_exists", name: "invoice", type: "application/pdf" },
        evidence,
      ).passed,
    ).toBe(true);
  });

  it("限制危险正则表达式", () => {
    expect(
      evaluateAssertion({ kind: "text_regex", pattern: "^订单.*完成$" }, evidence).passed,
    ).toBe(true);
    expect(() => evaluateAssertion({ kind: "text_regex", pattern: "(a+)+$" }, evidence)).toThrow();
    expect(() => evaluateAssertion({ kind: "text_regex", pattern: "a*a*a" }, evidence)).toThrow();
  });

  it("评审 Prompt 固定且不拼入用例正文", () => {
    expect(evaluationReviewerPrompt()).toBe(
      "你是评测评分器。依据用户消息中的评分标准和评测内容，给出 0 到 1 的分数、是否通过和简短理由。只输出 JSON。",
    );
    expect(evaluationReviewerPrompt()).not.toContain(evidence.finalText);
  });

  it("把评分用例放入评审模型 user turn，并返回替身评分", async () => {
    const score = vi.fn(async (_input: Parameters<EvaluationReviewerPort["score"]>[0]) => ({
      score: 0.9,
      passed: true,
      reason: "符合标准",
    }));
    const result = await scoreEvaluationCase(
      { score },
      {
        model: { providerKey: "provider_test", providerRevision: 2, modelId: "model_test" },
        rubric: "准确说明结果",
        caseInput: "特殊输入甲",
        finalText: "特殊回答乙",
      },
    );
    expect(result.score).toBe(0.9);
    expect(score.mock.calls[0]?.[0].userTurn).toContain("特殊输入甲");
    expect(score.mock.calls[0]?.[0].userTurn).toContain("特殊回答乙");
    expect(score.mock.calls[0]?.[0].systemPrompt).not.toContain("特殊输入甲");
  });

  it("批量评测汇总确定性与替身模型评分结果", async () => {
    const score = vi.fn(async () => ({ score: 0.9, passed: true, reason: "达到标准" }));
    const result = await evaluateCase({
      testCase: {
        id: "case_model",
        name: "模型评分",
        inputText: "输入内容",
        attachments: [],
        assertions: [
          { kind: "text_contains", value: "完成" },
          { kind: "model_score", minimumScore: 0.8 },
        ],
      },
      evidence: { ...evidence, finalText: "订单完成" },
      reviewer: { score },
      reviewerModel: { providerKey: "provider_test", providerRevision: 1, modelId: "model_test" },
      reviewerRubric: "准确性",
    });
    expect(result).toMatchObject({ outcome: "passed", score: 0.9 });
    expect(result.assertionResults).toHaveLength(2);
    expect(score).toHaveBeenCalledOnce();
  });
});
