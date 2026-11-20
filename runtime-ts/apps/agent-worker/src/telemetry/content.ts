import { types } from "node:util";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Span } from "@opentelemetry/api";

export const CONTENT_MAX_BYTES = 8192;

export function captureModelInput(span: Span, context: Context): void {
  if (context.systemPrompt !== undefined) {
    setContent(span, "gen_ai.system_instructions", [
      { type: "text", content: context.systemPrompt },
    ]);
  }
  setContent(
    span,
    "gen_ai.input.messages",
    context.messages.slice(-32).map((message) => {
      if (message.role === "assistant") return assistantMessage(message);
      const parts = (
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content
      )
        .slice(0, 32)
        .flatMap((part) => (part.type === "text" ? [{ type: "text", content: part.text }] : []));
      if (message.role === "toolResult")
        return {
          role: "tool",
          parts: parts.map((part) => ({
            type: "tool_call_response",
            id: message.toolCallId,
            response: part.content,
          })),
        };
      return { role: "user", parts };
    }),
  );
}

export function captureModelOutput(
  span: Span,
  message: AssistantMessage,
  finishReason: string,
): void {
  setContent(span, "gen_ai.output.messages", [
    { ...assistantMessage(message), finish_reason: finishReason },
  ]);
}

function assistantMessage(message: AssistantMessage) {
  const parts: object[] = [];
  for (const part of message.content.slice(0, 32)) {
    if (part.type === "text") parts.push({ type: "text", content: part.text });
    if (part.type === "toolCall")
      parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
  }
  return { role: "assistant", parts };
}

function setContent(span: Span, key: string, value: unknown): void {
  const json = encodeContent(value);
  if (json !== undefined) span.setAttribute(key, json);
}

// 只序列化有界的普通 JSON 数据；不调用工具返回对象的 getter 或 toJSON，不读取二进制。
export function encodeContent(value: unknown): string | undefined {
  let budget = CONTENT_MAX_BYTES;
  function copy(input: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 12) throw new Error();
    if (typeof input === "string") {
      budget -= input.length;
      if (budget < 0) throw new Error();
      return input;
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input !== "object" || types.isProxy(input)) throw new Error();
    if (Array.isArray(input)) {
      if (input.length > 128) throw new Error();
      return Array.from({ length: input.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(input, index);
        if (item === undefined || !Object.hasOwn(item, "value")) throw new Error();
        return copy(item.value, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new Error();
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in input) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (property === undefined) continue;
      if (++count > 128 || !Object.hasOwn(property, "value")) throw new Error();
      if (property.value === undefined) continue;
      budget -= key.length;
      result[key] = copy(property.value, depth + 1);
    }
    return result;
  }
  try {
    const json = JSON.stringify(copy(value, 0));
    return Buffer.byteLength(json, "utf8") <= CONTENT_MAX_BYTES ? json : undefined;
  } catch {
    return undefined;
  }
}

export function encodeToolResult(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
  const content = Object.getOwnPropertyDescriptor(value, "content")?.value;
  if (!Array.isArray(content) || types.isProxy(content) || content.length > 128) return undefined;
  const text: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const part: unknown = Object.getOwnPropertyDescriptor(content, index)?.value;
    if (part === null || typeof part !== "object" || types.isProxy(part)) continue;
    if (Object.getOwnPropertyDescriptor(part, "type")?.value !== "text") continue;
    const value: unknown = Object.getOwnPropertyDescriptor(part, "text")?.value;
    if (typeof value === "string") text.push(value);
  }
  return text.length === 0 ? undefined : encodeContent(text);
}
