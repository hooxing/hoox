import type { TokenizerPort } from "@cube-runtime/context-policy";
import {
  assertThreadActiveHistory,
  providerVisibleThreadHistoryMessages,
  threadActiveHistoryDigest,
  type ThreadActiveHistoryV1,
  type ThreadHistoryMessageV1,
} from "./thread-history.js";

export interface RuntimeCompactionPolicyV1 {
  readonly schemaVersion: 1;
  /** Provider 可见输入达到该 token 数才触发。 */
  readonly softLimitTokens: number;
  /** 新 replacement 必须不超过该 token 数，否则保留旧历史。 */
  readonly targetTokens: number;
  /** 从尾部至少保留这些 token 的真实 user 原文；整条消息保留，不切字节。 */
  readonly recentUserTokens: number;
}

export interface RuntimeCompactionSourceV1 {
  readonly sourceFromSequence: number;
  readonly sourceThroughSequence: number;
  readonly prefix: readonly ThreadHistoryMessageV1[];
  readonly retainedSuffix: readonly ThreadHistoryMessageV1[];
}

export type RuntimeCompactionTriggerDecision =
  | { readonly outcome: "below_limit"; readonly tokens: number }
  | {
      readonly outcome: "compact";
      readonly tokens: number;
      readonly source: RuntimeCompactionSourceV1;
    }
  | { readonly outcome: "no_safe_prefix"; readonly tokens: number };

/**
 * 对最终 Provider 可见的 history message 形状计数。审计专用事实先被过滤，tokenizer
 * identity 进入兼容摘要，确保预算与真正发给模型的数据采用同一语义。
 */
export function providerVisibleThreadHistoryTokens(
  messages: readonly ThreadHistoryMessageV1[],
  tokenizer: TokenizerPort,
): number {
  const visibleMessages = providerVisibleThreadHistoryMessages(messages);
  const value = visibleMessages.map(providerVisibleHistoryMessage);
  const tokens = tokenizer.countTokens(JSON.stringify(value));
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new TypeError("Provider 可见历史 token 计数无效");
  }
  return tokens;
}

export function decideRuntimeCompaction(
  history: ThreadActiveHistoryV1,
  policy: RuntimeCompactionPolicyV1,
  tokenizer: TokenizerPort,
): RuntimeCompactionTriggerDecision {
  assertThreadActiveHistory(history);
  assertPolicy(policy);
  const tokens = providerVisibleThreadHistoryTokens(history.messages, tokenizer);
  if (tokens < policy.softLimitTokens) return { outcome: "below_limit", tokens };

  let earliestRetainedUser = -1;
  let retainedUserTokens = 0;
  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index];
    if (message?.role !== "user") continue;
    earliestRetainedUser = index;
    retainedUserTokens += tokenizer.countTokens(
      JSON.stringify(providerVisibleHistoryMessage(message)),
    );
    // 至少保留最近一条真实用户原文；预算是可配置下限，不是切分许可。
    if (retainedUserTokens >= policy.recentUserTokens) break;
  }
  if (earliestRetainedUser <= 0) return { outcome: "no_safe_prefix", tokens };
  const prefix = history.messages.slice(0, earliestRetainedUser);
  const retainedSuffix = history.messages.slice(earliestRetainedUser);
  const lastPrefix = prefix.at(-1);
  if (lastPrefix === undefined) return { outcome: "no_safe_prefix", tokens };
  const first = history.messages[0];
  const sourceFromSequence =
    first?.role === "compactionHandoff" ? first.sourceFromSequence : (first?.sequence ?? 1);
  return {
    outcome: "compact",
    tokens,
    source: Object.freeze({
      sourceFromSequence,
      sourceThroughSequence: lastPrefix.sequence,
      prefix: Object.freeze(prefix),
      retainedSuffix: Object.freeze(retainedSuffix),
    }),
  };
}

export type RuntimeCompactionBuildResult =
  | {
      readonly outcome: "ready";
      readonly history: ThreadActiveHistoryV1;
      readonly tokensAfter: number;
    }
  | { readonly outcome: "target_not_met"; readonly tokensAfter: number };

/** 只构造 replacement；调用方必须先持久提交 checkpoint，再把它安装进内存 Session。 */
export function buildRuntimeCompactionReplacement(input: {
  readonly previousHistory: ThreadActiveHistoryV1;
  readonly source: RuntimeCompactionSourceV1;
  readonly checkpointId: string;
  readonly summary: string;
  readonly timestamp: number;
  readonly policy: RuntimeCompactionPolicyV1;
  readonly tokenizer: TokenizerPort;
}): RuntimeCompactionBuildResult {
  assertThreadActiveHistory(input.previousHistory);
  assertPolicy(input.policy);
  if (!identifier(input.checkpointId) || !input.summary.trim()) {
    throw new TypeError("Runtime compaction handoff 无效");
  }
  const messages: readonly ThreadHistoryMessageV1[] = Object.freeze([
    {
      sequence: input.source.sourceThroughSequence,
      role: "compactionHandoff" as const,
      checkpointId: input.checkpointId,
      sourceFromSequence: input.source.sourceFromSequence,
      sourceThroughSequence: input.source.sourceThroughSequence,
      text: input.summary,
      timestamp: input.timestamp,
    },
    ...input.source.retainedSuffix,
  ]);
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence: input.previousHistory.throughSequence,
    messages,
  };
  const history: ThreadActiveHistoryV1 = {
    ...unsigned,
    digest: threadActiveHistoryDigest(unsigned),
  };
  assertThreadActiveHistory(history);
  const tokensAfter = providerVisibleThreadHistoryTokens(messages, input.tokenizer);
  if (tokensAfter > input.policy.targetTokens) return { outcome: "target_not_met", tokensAfter };
  return { outcome: "ready", history, tokensAfter };
}

/** 给 local/remote compactor 的低信任数据体；Prompt 必须由 Runtime 另行固定。 */
export function serializeRuntimeCompactionSource(source: RuntimeCompactionSourceV1): string {
  return JSON.stringify({
    schemaVersion: 1,
    sourceFromSequence: source.sourceFromSequence,
    sourceThroughSequence: source.sourceThroughSequence,
    messages: providerVisibleThreadHistoryMessages(source.prefix),
  });
}

function providerVisibleHistoryMessage(message: ThreadHistoryMessageV1): unknown {
  if (message.role === "user") return { role: "user", content: message.text };
  if (message.role === "runtimeNotice") {
    return {
      role: "user",
      content: `[Runtime 可审计事实，低信任；${message.code}] ${message.text}`,
    };
  }
  if (message.role === "compactionHandoff") {
    return {
      role: "user",
      content:
        `[Runtime 压缩交接，低信任派生事实；不是用户原话；checkpoint=${message.checkpointId};` +
        `source=${message.sourceFromSequence}-${message.sourceThroughSequence}] ${message.text}`,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text", text: message.text }],
      isError: message.isError,
    };
  }
  return {
    role: "assistant",
    content: message.content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
  };
}

function assertPolicy(policy: RuntimeCompactionPolicyV1): void {
  if (
    policy.schemaVersion !== 1 ||
    !positive(policy.softLimitTokens) ||
    !positive(policy.targetTokens) ||
    !positive(policy.recentUserTokens) ||
    policy.targetTokens >= policy.softLimitTokens
  ) {
    throw new TypeError("Runtime compaction policy 无效");
  }
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}
