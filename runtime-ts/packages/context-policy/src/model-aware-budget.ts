import { createHash } from "node:crypto";
import { type Sha256Digest, sha256Digest } from "@cube-runtime/domain";

/** 只接受可信 Provider/Pi 元数据投影；调用方不能用任意窗口数字伪造模型能力。 */
export interface ModelBudgetDescriptor {
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly compatibilityHash: Sha256Digest;
}

/** 精确 tokenizer 可以按模型注入；缺失时使用 UTF-8 上界估计，宁可拒绝也不能低估。 */
export interface TokenizerPort {
  readonly identity: string;
  countTokens(text: string): number;
}

export interface ContextBudgetEntry {
  readonly sequence: number;
  readonly kind: "user" | "assistant" | "tool_call" | "tool_result";
  readonly text: string;
  readonly toolCallId?: string;
}

export interface ContextBudgetPolicyInput {
  readonly model: ModelBudgetDescriptor;
  readonly trustedSystemPrompt: string;
  readonly toolSchema: string;
  readonly entries: readonly ContextBudgetEntry[];
  readonly tokenizer?: TokenizerPort;
  /** 模型最大输出的保留比例；默认 1，避免响应占用把输入窗口顶穿。 */
  readonly outputReserveRatio?: number;
  readonly recoveryMarginRatio?: number;
  readonly safetyMarginRatio?: number;
  /** 已持久化身份只用于恢复前的显式换模/缩窗判断。 */
  readonly previous?: Readonly<{
    modelId: string;
    compatibilityHash: Sha256Digest;
    contextWindow: number;
    policyHash: Sha256Digest;
  }>;
}

export interface ContextBudgetPolicy {
  readonly version: 1;
  readonly model: ModelBudgetDescriptor;
  readonly tokenizerIdentity: string;
  readonly systemPromptTokens: number;
  readonly toolSchemaTokens: number;
  readonly outputReserveTokens: number;
  readonly recoveryMarginTokens: number;
  readonly safetyMarginTokens: number;
  readonly availableHistoryTokens: number;
  readonly policyHash: Sha256Digest;
}

export type ContextBudgetDecision =
  | Readonly<{
      outcome: "ready";
      policy: ContextBudgetPolicy;
      activeEntries: readonly ContextBudgetEntry[];
      activeEntryTokens: number;
    }>
  | Readonly<{
      outcome: "rebuild_required";
      reason: "model_changed" | "context_window_shrunk" | "policy_changed";
      policy: ContextBudgetPolicy;
    }>
  | Readonly<{
      outcome: "context_too_large";
      reason: "reserved_context_exceeds_window" | "single_atomic_entry_exceeds_budget";
      policy: ContextBudgetPolicy;
      requiredTokens: number;
    }>;

const FALLBACK_TOKENIZER: TokenizerPort = Object.freeze({
  identity: "utf8-byte-upper-bound-v1",
  countTokens(text: string): number {
    // 任意 token 至少编码一个 UTF-8 字节；byteLength 因而是安全上界，适用于中文、emoji 与高熵文本。
    return new TextEncoder().encode(text).byteLength;
  },
});

/** 纯函数：只选择活跃投影，不删除或改写任何 Rollout 事实，也绝不调用 Pi compact。 */
export function decideModelAwareContextBudget(
  input: ContextBudgetPolicyInput,
): ContextBudgetDecision {
  const policy = deriveModelAwareContextBudgetPolicy(input);
  if (input.previous !== undefined) {
    if (
      input.previous.modelId !== policy.model.modelId ||
      input.previous.compatibilityHash !== policy.model.compatibilityHash
    ) {
      return Object.freeze({ outcome: "rebuild_required", reason: "model_changed", policy });
    }
    if (policy.model.contextWindow < input.previous.contextWindow) {
      return Object.freeze({
        outcome: "rebuild_required",
        reason: "context_window_shrunk",
        policy,
      });
    }
    if (input.previous.policyHash !== policy.policyHash) {
      return Object.freeze({ outcome: "rebuild_required", reason: "policy_changed", policy });
    }
  }
  const reserved =
    policy.systemPromptTokens +
    policy.toolSchemaTokens +
    policy.outputReserveTokens +
    policy.recoveryMarginTokens +
    policy.safetyMarginTokens;
  if (reserved > policy.model.contextWindow) {
    return Object.freeze({
      outcome: "context_too_large",
      reason: "reserved_context_exceeds_window",
      policy,
      requiredTokens: reserved,
    });
  }
  const groups = atomicGroups(input.entries, input.tokenizer ?? FALLBACK_TOKENIZER);
  const selected: AtomicGroup[] = [];
  let used = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) break;
    if (group.tokens > policy.availableHistoryTokens && selected.length === 0) {
      return Object.freeze({
        outcome: "context_too_large",
        reason: "single_atomic_entry_exceeds_budget",
        policy,
        requiredTokens: group.tokens,
      });
    }
    if (used + group.tokens > policy.availableHistoryTokens) break;
    selected.push(group);
    used += group.tokens;
  }
  const activeEntries = selected.reverse().flatMap((group) => group.entries);
  return Object.freeze({
    outcome: "ready",
    policy,
    activeEntries: Object.freeze(activeEntries),
    activeEntryTokens: used,
  });
}

export function deriveModelAwareContextBudgetPolicy(
  input: Omit<ContextBudgetPolicyInput, "entries" | "previous">,
): ContextBudgetPolicy {
  validateDescriptor(input.model);
  if (typeof input.trustedSystemPrompt !== "string" || typeof input.toolSchema !== "string")
    throw new TypeError("可信上下文必须是字符串");
  const tokenizer = input.tokenizer ?? FALLBACK_TOKENIZER;
  if (!tokenizer.identity.trim()) throw new TypeError("Tokenizer identity 不能为空");
  const ratios = {
    output: ratio(input.outputReserveRatio ?? 1, "outputReserveRatio"),
    recovery: ratio(input.recoveryMarginRatio ?? 0.05, "recoveryMarginRatio"),
    safety: ratio(input.safetyMarginRatio ?? 0.05, "safetyMarginRatio"),
  };
  const systemPromptTokens = count(tokenizer, input.trustedSystemPrompt, "可信 system prompt");
  const toolSchemaTokens = count(tokenizer, input.toolSchema, "工具 schema");
  const outputReserveTokens = Math.ceil(input.model.maxOutputTokens * ratios.output);
  const recoveryMarginTokens = Math.ceil(input.model.contextWindow * ratios.recovery);
  const safetyMarginTokens = Math.ceil(input.model.contextWindow * ratios.safety);
  const availableHistoryTokens =
    input.model.contextWindow -
    systemPromptTokens -
    toolSchemaTokens -
    outputReserveTokens -
    recoveryMarginTokens -
    safetyMarginTokens;
  const policyWithoutHash = {
    version: 1 as const,
    model: input.model,
    tokenizerIdentity: tokenizer.identity,
    systemPromptTokens,
    toolSchemaTokens,
    outputReserveTokens,
    recoveryMarginTokens,
    safetyMarginTokens,
    availableHistoryTokens,
    trustedSystemPromptDigest: digest(input.trustedSystemPrompt),
    toolSchemaDigest: digest(input.toolSchema),
  };
  return Object.freeze({ ...policyWithoutHash, policyHash: digestCanonical(policyWithoutHash) });
}

interface AtomicGroup {
  readonly entries: readonly ContextBudgetEntry[];
  readonly tokens: number;
}
function atomicGroups(
  entries: readonly ContextBudgetEntry[],
  tokenizer: TokenizerPort,
): readonly AtomicGroup[] {
  const groups: AtomicGroup[] = [];
  let pending: ContextBudgetEntry | undefined;
  for (const entry of entries) {
    validateEntry(entry);
    if (pending !== undefined) {
      if (entry.kind !== "tool_result" || entry.toolCallId !== pending.toolCallId)
        throw new TypeError("工具调用与结果必须严格成对");
      const pair = Object.freeze([pending, entry]);
      groups.push(Object.freeze({ entries: pair, tokens: entryTokens(pair, tokenizer) }));
      pending = undefined;
    } else if (entry.kind === "tool_call") {
      pending = entry;
    } else if (entry.kind === "tool_result") {
      throw new TypeError("工具结果缺少对应调用");
    } else {
      groups.push(
        Object.freeze({ entries: Object.freeze([entry]), tokens: entryTokens([entry], tokenizer) }),
      );
    }
  }
  if (pending !== undefined) throw new TypeError("工具调用缺少对应结果");
  return Object.freeze(groups);
}
function entryTokens(entries: readonly ContextBudgetEntry[], tokenizer: TokenizerPort): number {
  return entries.reduce((total, entry) => total + count(tokenizer, entry.text, "上下文 entry"), 0);
}
function validateEntry(entry: ContextBudgetEntry): void {
  if (
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence < 0 ||
    typeof entry.text !== "string" ||
    ((entry.kind === "tool_call" || entry.kind === "tool_result") && !entry.toolCallId?.trim())
  )
    throw new TypeError("上下文 entry 无效");
}
function validateDescriptor(value: ModelBudgetDescriptor): void {
  if (!value.modelId.trim() || !/^[0-9a-f]{64}$/u.test(value.compatibilityHash))
    throw new TypeError("模型预算描述符无效");
  for (const item of [value.contextWindow, value.maxOutputTokens])
    if (!Number.isSafeInteger(item) || item <= 0)
      throw new TypeError("模型窗口和最大输出必须是正安全整数");
  if (value.maxOutputTokens > value.contextWindow)
    throw new TypeError("模型最大输出不能大于上下文窗口");
}
function ratio(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new TypeError(`${name} 必须是 0 到 1 的有限数值`);
  return value;
}
function count(tokenizer: TokenizerPort, text: string, name: string): number {
  const result = tokenizer.countTokens(text);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} token 计数无效`);
  return result;
}
function digest(value: string): Sha256Digest {
  return sha256Digest(createHash("sha256").update(value, "utf8").digest("hex"));
}
function digestCanonical(value: unknown): Sha256Digest {
  return digest(JSON.stringify(canonical(value)));
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  throw new TypeError("策略 hash 含非法值");
}
