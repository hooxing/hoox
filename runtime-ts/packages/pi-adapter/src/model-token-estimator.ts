import type { TokenizerPort } from "@hoox/context-policy";

export type EstimatedTokenProvider = "openai" | "gemini" | "claude";

interface TokenMultipliers {
  readonly word: number;
  readonly number: number;
  readonly cjk: number;
  readonly symbol: number;
  readonly mathSymbol: number;
  readonly urlDelimiter: number;
  readonly atSign: number;
  readonly emoji: number;
  readonly newline: number;
  readonly space: number;
}

export interface EstimatedModelTokenizerCapability extends TokenizerPort {
  readonly strategy: "estimated";
  readonly modelFamily: EstimatedTokenProvider;
  readonly sourceRevision: "new-api-token-estimator-v1";
}

const MULTIPLIERS = Object.freeze<Record<EstimatedTokenProvider, TokenMultipliers>>({
  gemini: Object.freeze({
    word: 1.15,
    number: 2.8,
    cjk: 0.68,
    symbol: 0.38,
    mathSymbol: 1.05,
    urlDelimiter: 1.2,
    atSign: 2.5,
    emoji: 1.08,
    newline: 1.15,
    space: 0.2,
  }),
  claude: Object.freeze({
    word: 1.13,
    number: 1.63,
    cjk: 1.21,
    symbol: 0.4,
    mathSymbol: 4.52,
    urlDelimiter: 1.26,
    atSign: 2.82,
    emoji: 2.6,
    newline: 0.89,
    space: 0.39,
  }),
  openai: Object.freeze({
    word: 1.02,
    number: 1.55,
    cjk: 0.85,
    symbol: 0.4,
    mathSymbol: 2.68,
    urlDelimiter: 1,
    atSign: 2,
    emoji: 2.12,
    newline: 0.5,
    space: 0.42,
  }),
});
const LETTER = /\p{L}/u;
const NUMBER = /\p{N}/u;
const HAN = /\p{Script=Han}/u;
const WHITESPACE = /\s/u;
const URL_DELIMITERS = new Set(["/", ":", "?", "&", "=", ";", "#", "%"]);
const MATH_SYMBOLS = new Set(
  Array.from("∑∫∂√∞≤≥≠≈±×÷∈∉∋∌⊂⊃⊆⊇∪∩∧∨¬∀∃∄∅∆∇∝∟∠∡∢°′″‴⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎²³¹⁴⁵⁶⁷⁸⁹⁰"),
);
const ESTIMATORS = new Map<EstimatedTokenProvider, EstimatedModelTokenizerCapability>();

/** 未知模型不加载远程 tokenizer；按 new-api 的厂商权重提供稳定本地降级计数。 */
export function createEstimatedModelTokenizerCapability(
  modelId: string,
): EstimatedModelTokenizerCapability {
  const family = resolveEstimatedTokenProvider(modelId);
  const cached = ESTIMATORS.get(family);
  if (cached !== undefined) return cached;
  const capability = Object.freeze({
    strategy: "estimated" as const,
    modelFamily: family,
    sourceRevision: "new-api-token-estimator-v1" as const,
    identity: `new-api-token-estimator:${family}-v1`,
    countTokens(text: string): number {
      return estimateTokens(family, text);
    },
  });
  ESTIMATORS.set(family, capability);
  return capability;
}

export function resolveEstimatedTokenProvider(modelId: string): EstimatedTokenProvider {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("claude")) return "claude";
  return "openai";
}

export function estimateTokens(provider: EstimatedTokenProvider, text: string): number {
  if (text.length === 0) return 0;
  const weights = MULTIPLIERS[provider];
  let count = 0;
  let currentWordType: "none" | "letter" | "number" = "none";

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (WHITESPACE.test(character)) {
      currentWordType = "none";
      count += character === "\n" || character === "\t" ? weights.newline : weights.space;
      continue;
    }
    if (isCjk(character, codePoint)) {
      currentWordType = "none";
      count += weights.cjk;
      continue;
    }
    if (isEmoji(codePoint)) {
      currentWordType = "none";
      count += weights.emoji;
      continue;
    }
    if (LETTER.test(character) || NUMBER.test(character)) {
      const nextWordType = NUMBER.test(character) ? "number" : "letter";
      if (currentWordType !== nextWordType) {
        count += nextWordType === "number" ? weights.number : weights.word;
        currentWordType = nextWordType;
      }
      continue;
    }

    currentWordType = "none";
    if (isMathSymbol(character, codePoint)) count += weights.mathSymbol;
    else if (character === "@") count += weights.atSign;
    else if (URL_DELIMITERS.has(character)) count += weights.urlDelimiter;
    else count += weights.symbol;
  }

  return Math.ceil(count);
}

function isCjk(character: string, codePoint: number): boolean {
  return (
    HAN.test(character) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3)
  );
}

function isEmoji(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x26ff) ||
    (codePoint >= 0x2700 && codePoint <= 0x27bf) ||
    (codePoint >= 0x1fa00 && codePoint <= 0x1faff)
  );
}

function isMathSymbol(character: string, codePoint: number): boolean {
  return (
    MATH_SYMBOLS.has(character) ||
    (codePoint >= 0x2200 && codePoint <= 0x22ff) ||
    (codePoint >= 0x2a00 && codePoint <= 0x2aff) ||
    (codePoint >= 0x1d400 && codePoint <= 0x1d7ff)
  );
}
