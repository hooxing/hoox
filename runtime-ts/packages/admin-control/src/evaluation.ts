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

const MAX_REGEX_EVIDENCE_LENGTH = 32_768;
const REGEX_WORKER_TIMEOUT_MS = 250;
const regexWorkerSource = `
  const { parentPort } = require("node:worker_threads");
  parentPort.once("message", ({ pattern, text }) => {
    try {
      parentPort.postMessage({ matched: new RegExp(pattern).test(text) });
    } catch {
      parentPort.postMessage({ error: true });
    }
  });
`;

function safePattern(pattern: string): void {
  if (pattern.length > 256 || /[()\\]/.test(pattern)) {
    throw new TypeError("正则仅支持不含分组和转义的安全子集，且最长 256 字符");
  }
  const quantifiers = pattern.match(/[+*?]|\{\d+(?:,\d*)?\}/g) ?? [];
  if (quantifiers.length > 1) throw new TypeError("正则最多包含一个量词");
  try {
    new RegExp(pattern);
  } catch {
    throw new TypeError("正则表达式格式无效");
  }
}

export async function evaluateAssertion(
  assertion: EvaluationAssertion,
  evidence: EvaluationEvidence,
): Promise<EvaluationAssertionResult> {
  let passed: boolean;
  switch (assertion.kind) {
    case "text_contains":
      passed = evidence.finalText.includes(assertion.value);
      if (assertion.negate) passed = !passed;
      break;
    case "text_regex":
      if (evidence.finalText.length > MAX_REGEX_EVIDENCE_LENGTH)
        throw new TypeError("正则断言证据超过长度限制");
      safePattern(assertion.pattern);
      passed = await testRegexInWorker(assertion.pattern, evidence.finalText);
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

async function testRegexInWorker(pattern: string, text: string): Promise<boolean> {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(regexWorkerSource, { eval: true });
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value === true);
    };
    const timer = setTimeout(() => finish(new Error("正则断言执行超时")), REGEX_WORKER_TIMEOUT_MS);
    worker.once("message", (message: { matched?: unknown; error?: unknown }) => {
      if (message.error === true || typeof message.matched !== "boolean")
        finish(new Error("正则断言执行失败"));
      else finish(undefined, message.matched);
    });
    worker.once("error", () => finish(new Error("正则断言执行失败")));
    worker.postMessage({ pattern, text });
  });
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
  const assertionResults = [];
  for (const assertion of input.testCase.assertions) {
    assertionResults.push(
      await evaluateAssertion(assertion, {
        ...input.evidence,
        ...(score === undefined ? {} : { modelScore: score.score }),
      }),
    );
  }
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
