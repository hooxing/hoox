import type { EvaluationAssertion, EvaluationCase } from "@hoox/protocol";

export interface EvaluationEvidence {
  readonly finalText: string;
  readonly toolNames: readonly string[];
  readonly artifacts: readonly { readonly name: string; readonly type: string }[];
  readonly modelScore?: number;
}

export interface EvaluationAssertionResult {
  readonly passed: boolean;
  readonly reason: string;
}

function safePattern(pattern: string): RegExp {
  if (pattern.length > 256 || /[()\\]/.test(pattern)) {
    throw new TypeError("正则仅支持不含分组和转义的安全子集，且最长 256 字符");
  }
  const quantifiers = pattern.match(/[+*?]|\{\d+(?:,\d*)?\}/g) ?? [];
  if (quantifiers.length > 1) throw new TypeError("正则最多包含一个量词");
  try {
    return new RegExp(pattern);
  } catch {
    throw new TypeError("正则表达式格式无效");
  }
}

export function evaluateAssertion(
  assertion: EvaluationAssertion,
  evidence: EvaluationEvidence,
): EvaluationAssertionResult {
  let passed: boolean;
  switch (assertion.kind) {
    case "text_contains":
      passed = evidence.finalText.includes(assertion.value);
      if (assertion.negate) passed = !passed;
      break;
    case "text_regex":
      passed = safePattern(assertion.pattern).test(evidence.finalText);
      if (assertion.negate) passed = !passed;
      break;
    case "tool_called":
      passed = evidence.toolNames.includes(assertion.toolName);
      if (assertion.negate) passed = !passed;
      break;
    case "artifact_exists":
      passed = evidence.artifacts.some(
        (artifact) =>
          (assertion.name === undefined || artifact.name === assertion.name) &&
          (assertion.type === undefined || artifact.type === assertion.type),
      );
      break;
    case "model_score":
      passed = evidence.modelScore !== undefined && evidence.modelScore >= assertion.minimumScore;
      break;
  }
  return { passed, reason: passed ? "断言通过" : "断言未通过" };
}

export function evaluationReviewerPrompt(): string {
  return "你是评测评分器。依据用户消息中的评分标准和评测内容，给出 0 到 1 的分数、是否通过和简短理由。只输出 JSON。";
}

export interface EvaluationReviewerPort {
  score(input: {
    readonly model: {
      readonly providerKey: string;
      readonly providerRevision: number;
      readonly modelId: string;
    };
    readonly systemPrompt: string;
    readonly userTurn: string;
  }): Promise<{ readonly score: number; readonly passed: boolean; readonly reason: string }>;
}

export interface EvaluationCaseResult {
  readonly outcome: "passed" | "failed";
  readonly assertionResults: readonly EvaluationAssertionResult[];
  readonly score?: number;
  readonly reason: string;
}

export async function scoreEvaluationCase(
  reviewer: EvaluationReviewerPort,
  input: {
    readonly model: {
      readonly providerKey: string;
      readonly providerRevision: number;
      readonly modelId: string;
    };
    readonly rubric: string;
    readonly caseInput: string;
    readonly finalText: string;
  },
) {
  return reviewer.score({
    model: input.model,
    systemPrompt: evaluationReviewerPrompt(),
    userTurn: `评分标准：\n${input.rubric}\n\n用例输入：\n${input.caseInput}\n\nAgent 最终回复：\n${input.finalText}`,
  });
}

export async function evaluateCase(input: {
  readonly testCase: EvaluationCase;
  readonly evidence: Omit<EvaluationEvidence, "modelScore">;
  readonly reviewer?: EvaluationReviewerPort;
  readonly reviewerModel?: {
    readonly providerKey: string;
    readonly providerRevision: number;
    readonly modelId: string;
  };
  readonly reviewerRubric?: string;
}): Promise<EvaluationCaseResult> {
  const requiresReviewer = input.testCase.assertions.some((item) => item.kind === "model_score");
  let score:
    | { readonly score: number; readonly passed: boolean; readonly reason: string }
    | undefined;
  if (requiresReviewer) {
    if (!input.reviewer || !input.reviewerModel || !input.reviewerRubric) {
      throw new TypeError("用例包含模型评分断言，但评审模型配置不可用");
    }
    score = await scoreEvaluationCase(input.reviewer, {
      model: input.reviewerModel,
      rubric: input.reviewerRubric,
      caseInput: input.testCase.inputText,
      finalText: input.evidence.finalText,
    });
    if (!Number.isFinite(score.score) || score.score < 0 || score.score > 1) {
      throw new TypeError("评审模型返回的评分必须在 0 到 1 之间");
    }
    if (typeof score.passed !== "boolean" || score.reason.trim().length === 0) {
      throw new TypeError("评审模型结果缺少通过状态或理由");
    }
  }
  const assertionResults = input.testCase.assertions.map((assertion) =>
    evaluateAssertion(assertion, {
      ...input.evidence,
      ...(score === undefined ? {} : { modelScore: score.score }),
    }),
  );
  const passed = assertionResults.every((result) => result.passed);
  const reason = [
    ...assertionResults.map((result) => result.reason),
    ...(score === undefined ? [] : [`模型评分 ${score.score}：${score.reason}`]),
  ].join("；");
  return {
    outcome: passed ? "passed" : "failed",
    assertionResults,
    ...(score === undefined ? {} : { score: score.score }),
    reason: reason || (passed ? "无断言" : "断言未通过"),
  };
}
