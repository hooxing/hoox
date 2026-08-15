import type { InternalTrajectoryEventV1, InternalTrajectoryValue } from "./internal.js";

export type DeepSeekTrajectoryLane = "input" | "model" | "tools";
export type DeepSeekTrajectoryKind =
  | "system"
  | "context"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "subtool"
  | "runtime";

export interface DeepSeekTrajectoryRecord {
  readonly id: string;
  readonly index: number;
  readonly sequence: number;
  readonly turn: number;
  readonly lane: DeepSeekTrajectoryLane;
  readonly kind: DeepSeekTrajectoryKind;
  readonly eventType: string;
  readonly label: string;
  readonly summary: string;
  readonly startedAt: string;
  readonly monotonicOffsetMs: number;
  readonly durationMs: number | null;
  readonly isError: boolean;
  readonly detail: InternalTrajectoryValue;
  readonly usage?: Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  }>;
}

export interface DeepSeekTrajectoryTurn {
  readonly turn: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly records: readonly DeepSeekTrajectoryRecord[];
}

export interface DeepSeekTrajectoryProjection {
  readonly turns: readonly DeepSeekTrajectoryTurn[];
  readonly records: readonly DeepSeekTrajectoryRecord[];
  readonly stats: {
    readonly events: number;
    readonly turns: number;
    readonly calls: number;
    readonly failedCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly durationMs: number;
  };
}

type JsonObject = Readonly<Record<string, InternalTrajectoryValue>>;

export function projectInternalTrajectory(
  input: readonly InternalTrajectoryEventV1[],
): DeepSeekTrajectoryProjection {
  const events = [...input].sort((left, right) => left.sequence - right.sequence);
  const records: DeepSeekTrajectoryRecord[] = [];
  const turnStarts = new Map<number, InternalTrajectoryEventV1>();
  const turnEnds = new Map<number, InternalTrajectoryEventV1>();
  const toolStarts = new Map<string, InternalTrajectoryEventV1>();
  let turn = 0;
  let calls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const event of events) {
    const body = objectValue(event.event);
    if (event.type === "turn_start") {
      if (turn === 0) turn = 1;
      else if (turnStarts.has(turn)) turn += 1;
      turnStarts.set(turn, event);
    } else if (turn === 0 && event.type !== "session_created") {
      // prompt/agent_start 是首个 turn 的前导事件，但不能因此把随后真实 turn_start 计为第二轮。
      turn = 1;
    }
    const effectiveTurn = Math.max(1, turn);
    if (event.type === "turn_end") turnEnds.set(effectiveTurn, event);

    const callId = stringValue(body?.toolCallId);
    if (event.type === "tool_execution_start" && callId !== undefined) {
      toolStarts.set(callId, event);
      calls += 1;
    }
    if (event.type === "tool_execution_end" && body?.isError === true) failedCalls += 1;

    const message = objectValue(body?.message);
    const usage = usageValue(message?.usage);
    if (usage !== undefined && event.type === "message_end" && message?.role === "assistant") {
      inputTokens += usage.input;
      outputTokens += usage.output;
      cacheReadTokens += usage.cacheRead;
      cacheWriteTokens += usage.cacheWrite;
    }

    const classification = classify(event, body);
    const start =
      event.type === "tool_execution_end" && callId !== undefined
        ? toolStarts.get(callId)
        : undefined;
    records.push({
      id: `trajectory-${event.sequence}`,
      index: records.length + 1,
      sequence: event.sequence,
      turn: event.type === "session_created" ? 0 : effectiveTurn,
      lane: classification.lane,
      kind: classification.kind,
      eventType: event.type,
      label: classification.label,
      summary: summarize(event, body),
      startedAt: start?.occurredAt ?? event.occurredAt,
      monotonicOffsetMs: start?.monotonicOffsetMs ?? event.monotonicOffsetMs,
      durationMs:
        start === undefined ? null : Math.max(0, event.monotonicOffsetMs - start.monotonicOffsetMs),
      isError: body?.isError === true || hasMessageError(message),
      detail: event.event,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  const turns: DeepSeekTrajectoryTurn[] = [];
  const turnNumbers = [...new Set(records.map((record) => record.turn))].sort((a, b) => a - b);
  for (const number of turnNumbers) {
    const grouped = records.filter((record) => record.turn === number);
    const first =
      turnStarts.get(number) ?? events.find((event) => event.sequence === grouped[0]?.sequence);
    const last = turnEnds.get(number);
    const durationMs =
      first === undefined || last === undefined
        ? undefined
        : Math.max(0, last.monotonicOffsetMs - first.monotonicOffsetMs);
    turns.push({
      turn: number,
      startedAt: first?.occurredAt ?? grouped[0]?.startedAt ?? events[0]?.occurredAt ?? "",
      ...(last === undefined ? {} : { completedAt: last.occurredAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      records: grouped,
    });
  }

  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  const durationMs =
    firstEvent === undefined || lastEvent === undefined
      ? 0
      : Math.max(0, lastEvent.monotonicOffsetMs - firstEvent.monotonicOffsetMs);
  return {
    turns,
    records,
    stats: {
      events: events.length,
      turns: turns.filter((item) => item.turn > 0).length,
      calls,
      failedCalls,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      durationMs,
    },
  };
}

function classify(
  event: InternalTrajectoryEventV1,
  body: JsonObject | undefined,
): Pick<DeepSeekTrajectoryRecord, "lane" | "kind" | "label"> {
  if (event.type === "session_created") return { lane: "input", kind: "system", label: "SYSTEM" };
  if (event.type === "prompt" || event.type === "steer")
    return { lane: "input", kind: "user", label: event.type === "prompt" ? "USER" : "STEER" };
  if (event.type === "turn_start" || event.type === "agent_start" || event.type === "agent_settled")
    return { lane: "input", kind: "context", label: "CONTEXT" };
  if (event.type.startsWith("tool_execution_")) {
    return {
      lane: "tools",
      kind: "tool",
      label: stringValue(body?.toolName) ?? "TOOL",
    };
  }
  if (event.type === "message_update") {
    const update = objectValue(body?.assistantMessageEvent);
    if (stringValue(update?.type)?.startsWith("thinking") === true)
      return { lane: "model", kind: "reasoning", label: "ASSISTANT" };
    return { lane: "model", kind: "assistant", label: "ASSISTANT" };
  }
  if (event.type === "message_start" || event.type === "message_end") {
    const role = stringValue(objectValue(body?.message)?.role);
    if (role === "user") return { lane: "input", kind: "user", label: "USER" };
    if (role === "toolResult") return { lane: "tools", kind: "tool", label: "TOOL" };
    return { lane: "model", kind: "assistant", label: "ASSISTANT" };
  }
  if (event.type === "turn_end" || event.type === "agent_end")
    return { lane: "model", kind: "assistant", label: "ASSISTANT" };
  return { lane: "input", kind: "runtime", label: "RUNTIME" };
}

function summarize(event: InternalTrajectoryEventV1, body: JsonObject | undefined): string {
  if (event.type === "session_created") {
    const model = objectValue(body?.model);
    return [stringValue(model?.provider), stringValue(model?.id)].filter(Boolean).join(" / ");
  }
  if (event.type === "prompt" || event.type === "steer")
    return preview(stringValue(body?.text) ?? "");
  if (event.type.startsWith("tool_execution_")) {
    const name = stringValue(body?.toolName) ?? "tool";
    const callId = stringValue(body?.toolCallId) ?? "";
    if (event.type === "tool_execution_start") return `${name} ${callId}`.trim();
    if (event.type === "tool_execution_update") return `${name} 更新`;
    return `${name} ${body?.isError === true ? "失败" : "完成"}`;
  }
  if (event.type === "message_update") {
    const update = objectValue(body?.assistantMessageEvent);
    return preview(stringValue(update?.delta) ?? stringValue(update?.type) ?? event.type);
  }
  const message = objectValue(body?.message);
  if (message !== undefined) {
    const text = messageText(message);
    const role = stringValue(message.role) ?? "message";
    return preview(text === "" ? role : text);
  }
  if (event.type === "turn_start") return "Turn 开始";
  if (event.type === "turn_end") return "Turn 完成";
  if (event.type === "agent_start") return "Agent 开始";
  if (event.type === "agent_end") return "Agent 完成";
  if (event.type === "agent_settled") return "Agent 已收敛";
  return event.type;
}

function messageText(message: JsonObject): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const block = objectValue(item);
      return stringValue(block?.text) ?? stringValue(block?.thinking) ?? "";
    })
    .filter((item) => item !== "")
    .join("\n");
}

function usageValue(value: InternalTrajectoryValue | undefined) {
  const usage = objectValue(value);
  if (usage === undefined) return undefined;
  const input = numericValue(usage.input);
  const output = numericValue(usage.output);
  const cacheRead = numericValue(usage.cacheRead);
  const cacheWrite = numericValue(usage.cacheWrite);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function hasMessageError(message: JsonObject | undefined): boolean {
  return (
    message?.stopReason === "error" ||
    message?.stopReason === "aborted" ||
    (typeof message?.errorMessage === "string" && message.errorMessage.length > 0)
  );
}

function objectValue(value: InternalTrajectoryValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: InternalTrajectoryValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numericValue(value: InternalTrajectoryValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function preview(value: string, maximum = 360): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}
