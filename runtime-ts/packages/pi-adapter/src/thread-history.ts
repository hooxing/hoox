import { createHash } from "node:crypto";
import { projectFileReferencePrompt } from "./file-reference-prompt.js";

export interface ThreadActiveHistoryV1 {
  readonly schemaVersion: 1;
  readonly projectionSchemaVersion: 1;
  readonly throughSequence: number;
  readonly messages: readonly ThreadHistoryMessageV1[];
  readonly digest: string;
}

export type ThreadHistoryMessageV1 =
  | {
      readonly sequence: number;
      readonly role: "user";
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly sequence: number;
      readonly role: "assistant";
      readonly content: readonly (
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "thinking";
            readonly thinking: string;
            readonly thinkingSignature?: string;
            readonly redacted?: boolean;
          }
        | {
            readonly type: "toolCall";
            readonly id: string;
            readonly name: string;
            readonly arguments: Readonly<Record<string, unknown>>;
            readonly thoughtSignature?: string;
          }
      )[];
      readonly api: string;
      readonly provider: string;
      readonly model: string;
      readonly stopReason: "stop" | "length" | "toolUse";
      readonly timestamp: number;
    }
  | {
      readonly sequence: number;
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly isError: boolean;
      readonly timestamp: number;
    }
  | {
      readonly sequence: number;
      readonly role: "runtimeNotice";
      readonly code: "run_failed" | "run_cancelled" | "workspace_unchanged" | "legacy_history_gap";
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      /** Runtime 生成的交接摘要；它是低信任派生事实，绝不是用户原话。 */
      readonly sequence: number;
      readonly role: "compactionHandoff";
      readonly checkpointId: string;
      readonly sourceFromSequence: number;
      readonly sourceThroughSequence: number;
      readonly text: string;
      readonly timestamp: number;
    };

/**
 * workspace_unchanged 是持久审计结论，不会改变后续任务的语义；它保留在 Thread 历史中，
 * 但不得伪装成 user 消息进入 Provider、预算或压缩摘要。
 */
export function isProviderVisibleThreadHistoryMessage(message: ThreadHistoryMessageV1): boolean {
  return message.role !== "runtimeNotice" || message.code !== "workspace_unchanged";
}

export function providerVisibleThreadHistoryMessages(
  messages: readonly ThreadHistoryMessageV1[],
): readonly ThreadHistoryMessageV1[] {
  return messages
    .filter(isProviderVisibleThreadHistoryMessage)
    .map((message) =>
      message.role === "user"
        ? { ...message, text: projectFileReferencePrompt(message.text) }
        : message,
    );
}

export function threadActiveHistoryDigest(history: Omit<ThreadActiveHistoryV1, "digest">): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(history)), "utf8")
    .digest("hex");
}

export function assertThreadActiveHistory(history: ThreadActiveHistoryV1): void {
  if (
    history.schemaVersion !== 1 ||
    history.projectionSchemaVersion !== 1 ||
    !Number.isSafeInteger(history.throughSequence) ||
    history.throughSequence < 0 ||
    history.messages.length > 10_000 ||
    !/^[0-9a-f]{64}$/u.test(history.digest)
  ) {
    throw new TypeError("Thread Active History 元数据无效");
  }
  let previous = 0;
  const pendingTools = new Map<string, string>();
  for (const message of history.messages) {
    if (
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= previous ||
      message.sequence > history.throughSequence ||
      !Number.isSafeInteger(message.timestamp) ||
      message.timestamp < 0
    ) {
      throw new TypeError("Thread Active History 顺序无效");
    }
    previous = message.sequence;
    if (pendingTools.size > 0 && message.role !== "toolResult") {
      throw new TypeError("Thread tool call/result 之间出现非法消息");
    }
    if (message.role === "user" || message.role === "runtimeNotice") {
      assertText(message.text);
      continue;
    }
    if (message.role === "compactionHandoff") {
      assertIdentifier(message.checkpointId);
      if (
        !Number.isSafeInteger(message.sourceFromSequence) ||
        !Number.isSafeInteger(message.sourceThroughSequence) ||
        message.sourceFromSequence < 1 ||
        message.sourceThroughSequence < message.sourceFromSequence ||
        message.sourceThroughSequence !== message.sequence
      ) {
        throw new TypeError("Thread compaction handoff 来源范围无效");
      }
      assertText(message.text);
      continue;
    }
    if (message.role === "assistant") {
      if (!message.api.trim() || !message.provider.trim() || !message.model.trim()) {
        throw new TypeError("Thread Assistant 兼容身份无效");
      }
      for (const item of message.content) {
        if (item.type === "text") {
          assertText(item.text);
        } else if (item.type === "thinking") {
          assertText(item.thinking, item.redacted === true);
          if (item.thinkingSignature !== undefined) assertOpaqueSignature(item.thinkingSignature);
          if (item.redacted === true && item.thinkingSignature === undefined) {
            throw new TypeError("Thread redacted thinking 缺少签名");
          }
        } else {
          assertIdentifier(item.id);
          assertIdentifier(item.name);
          if (item.thoughtSignature !== undefined) assertOpaqueSignature(item.thoughtSignature);
          if (pendingTools.has(item.id)) throw new TypeError("Thread tool callId 重复");
          pendingTools.set(item.id, item.name);
        }
      }
      continue;
    }
    assertIdentifier(message.toolCallId);
    assertIdentifier(message.toolName);
    assertText(message.text, true);
    if (pendingTools.get(message.toolCallId) !== message.toolName) {
      throw new TypeError("Thread tool result 缺少配对 call");
    }
    pendingTools.delete(message.toolCallId);
  }
  if (pendingTools.size !== 0) throw new TypeError("Thread tool call 缺少 result");
  const { digest, ...unsigned } = history;
  if (threadActiveHistoryDigest(unsigned) !== digest) {
    throw new TypeError("Thread Active History digest 不匹配");
  }
}

function assertText(value: string, allowEmpty = false): void {
  if ((!allowEmpty && !value.trim()) || Buffer.byteLength(value, "utf8") > 8 * 1024 * 1024) {
    throw new TypeError("Thread history 文本无效");
  }
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new TypeError("Thread history 标识符无效");
  }
}

function assertOpaqueSignature(value: string): void {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > 2 * 1_048_576) {
    throw new TypeError("Thread history 推理签名无效");
  }
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Thread history 含非法数值");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  throw new TypeError("Thread history 只接受 JSON 值");
}
