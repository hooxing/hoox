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

export interface DeepSeekTrajectoryRecordSource {
  readonly runId: string;
  readonly attemptId: string;
}

export interface DeepSeekTrajectoryRecord {
  readonly id: string;
  readonly index: number;
  /** 逻辑记录覆盖的首个原始事件 sequence，同时作为页面选择锚点。 */
  readonly sequence: number;
  /** 逻辑记录覆盖的最后一个原始事件 sequence。 */
  readonly sequenceEnd: number;
  readonly rawEventCount: number;
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
  readonly source?: DeepSeekTrajectoryRecordSource;
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
  /** turn_start 到首个 assistant message_start，包含请求准备，不等同 HTTP TTFT。 */
  readonly modelWaitDurationMs?: number;
  readonly records: readonly DeepSeekTrajectoryRecord[];
}

export interface DeepSeekTrajectoryProjection {
  readonly turns: readonly DeepSeekTrajectoryTurn[];
  readonly records: readonly DeepSeekTrajectoryRecord[];
  readonly stats: {
    /** 无损账本中的原始事件数量。 */
    readonly events: number;
    /** 聚合后展示的业务记录数量。 */
    readonly records: number;
    readonly turns: number;
    readonly calls: number;
    readonly failedCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    /** Assistant 流从 message_start 到 message_end 的累计解码时长。 */
    readonly modelDurationMs: number;
    /** 已观察到首个 assistant message_start 的各轮等待累计；缺少边界的轮次不估算，完全未采集时为 null。 */
    readonly modelWaitDurationMs: number | null;
    readonly outputTokensPerSecond: number | null;
    /** cacheRead / (input + cacheRead)，无输入时为 null。 */
    readonly cacheHitRate: number | null;
    readonly durationMs: number;
  };
}

export interface DeepSeekTrajectorySegment {
  readonly runId: string;
  readonly attemptId: string;
  readonly projection: DeepSeekTrajectoryProjection;
}

/**
 * Thread 视图只组合逻辑投影，不改写任何 Run/Attempt 原始事件；原始 sequence 通过 source 保持可定位。
 */
export function combineDeepSeekTrajectoryProjections(
  segments: readonly DeepSeekTrajectorySegment[],
): DeepSeekTrajectoryProjection {
  const records: DeepSeekTrajectoryRecord[] = [];
  const turns = new Map<number, DeepSeekTrajectoryTurn>();
  let turnOffset = 0;
  let durationOffsetMs = 0;
  let events = 0;
  let calls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let modelDurationMs = 0;
  let modelWaitDurationMs = 0;
  let hasModelWait = false;

  for (const segment of segments) {
    const mappedRecords = segment.projection.records.map((record) => {
      const mapped: DeepSeekTrajectoryRecord = {
        ...record,
        id: `${segment.runId}/${segment.attemptId}/${record.id}`,
        index: records.length + 1,
        turn: record.turn === 0 ? 0 : record.turn + turnOffset,
        monotonicOffsetMs: record.monotonicOffsetMs + durationOffsetMs,
        source: { runId: segment.runId, attemptId: segment.attemptId },
      };
      records.push(mapped);
      return mapped;
    });

    for (const sourceTurn of segment.projection.turns) {
      const mappedTurn = sourceTurn.turn === 0 ? 0 : sourceTurn.turn + turnOffset;
      const turnRecords = mappedRecords.filter((record) => record.turn === mappedTurn);
      const existing = turns.get(mappedTurn);
      if (existing === undefined) {
        turns.set(mappedTurn, { ...sourceTurn, turn: mappedTurn, records: turnRecords });
      } else {
        turns.set(mappedTurn, { ...existing, records: [...existing.records, ...turnRecords] });
      }
    }

    const stats = segment.projection.stats;
    events += stats.events;
    calls += stats.calls;
    failedCalls += stats.failedCalls;
    inputTokens += stats.inputTokens;
    outputTokens += stats.outputTokens;
    cacheReadTokens += stats.cacheReadTokens;
    cacheWriteTokens += stats.cacheWriteTokens;
    modelDurationMs += stats.modelDurationMs;
    if (stats.modelWaitDurationMs !== null) {
      modelWaitDurationMs += stats.modelWaitDurationMs;
      hasModelWait = true;
    }
    turnOffset += stats.turns;
    durationOffsetMs += stats.durationMs;
  }

  const cacheEligibleTokens = inputTokens + cacheReadTokens;
  return {
    turns: [...turns.values()].sort((left, right) => left.turn - right.turn),
    records,
    stats: {
      events,
      records: records.length,
      turns: turnOffset,
      calls,
      failedCalls,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      modelDurationMs,
      modelWaitDurationMs: hasModelWait ? modelWaitDurationMs : null,
      outputTokensPerSecond: modelDurationMs > 0 ? outputTokens / (modelDurationMs / 1_000) : null,
      cacheHitRate: cacheEligibleTokens > 0 ? cacheReadTokens / cacheEligibleTokens : null,
      durationMs: durationOffsetMs,
    },
  };
}

type JsonObject = Readonly<Record<string, InternalTrajectoryValue>>;
type Usage = NonNullable<DeepSeekTrajectoryRecord["usage"]>;
type RecordDraft = Omit<DeepSeekTrajectoryRecord, "id" | "index">;

interface AssistantAccumulator {
  readonly turn: number;
  readonly start: InternalTrajectoryEventV1;
  last: InternalTrajectoryEventV1;
  rawEventCount: number;
  firstDelta?: InternalTrajectoryEventV1;
  lastPartial?: JsonObject;
  readonly updateCounts: Record<string, number>;
}

interface ToolAccumulator {
  readonly turn: number;
  readonly start: InternalTrajectoryEventV1;
  last: InternalTrajectoryEventV1;
  rawEventCount: number;
  readonly updates: InternalTrajectoryValue[];
}

export function projectInternalTrajectory(
  input: readonly InternalTrajectoryEventV1[],
): DeepSeekTrajectoryProjection {
  const events = [...input].sort((left, right) => left.sequence - right.sequence);
  const drafts: RecordDraft[] = [];
  const turnStarts = new Map<number, InternalTrajectoryEventV1>();
  const turnEnds = new Map<number, InternalTrajectoryEventV1>();
  const modelWaits = new Map<number, number>();
  const activeTools = new Map<string, ToolAccumulator>();
  const completedToolCalls = new Set<string>();
  let activeAssistant: AssistantAccumulator | undefined;
  let turn = 0;
  let calls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  const finishAssistant = (end?: InternalTrajectoryEventV1) => {
    if (activeAssistant === undefined) return;
    if (end !== undefined) {
      activeAssistant.last = end;
      activeAssistant.rawEventCount += 1;
    }
    const record = assistantRecord(activeAssistant, end);
    drafts.push(record);
    if (record.usage !== undefined) {
      inputTokens += record.usage.input;
      outputTokens += record.usage.output;
      cacheReadTokens += record.usage.cacheRead;
      cacheWriteTokens += record.usage.cacheWrite;
    }
    activeAssistant = undefined;
  };

  for (const event of events) {
    const body = objectValue(event.event);
    if (event.type === "turn_start") {
      finishAssistant();
      if (turn === 0) turn = 1;
      else if (turnStarts.has(turn)) turn += 1;
      turnStarts.set(turn, event);
    } else if (turn === 0 && event.type !== "session_created") {
      // prompt 是首个 turn 的前导事件，随后真实 turn_start 仍应属于同一轮。
      turn = 1;
    }
    const effectiveTurn = Math.max(1, turn);

    if (event.type === "turn_end") {
      finishAssistant();
      turnEnds.set(effectiveTurn, event);
      continue;
    }
    if (
      event.type === "turn_start" ||
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "agent_settled"
    ) {
      // 生命周期边界用于 Turn 和耗时计算，不作为 DeepSeek 账本中的独立业务行。
      continue;
    }

    if (event.type === "message_start") {
      const message = objectValue(body?.message);
      if (message?.role === "assistant") {
        const turnStart = turnStarts.get(effectiveTurn);
        if (turnStart !== undefined && !modelWaits.has(effectiveTurn)) {
          modelWaits.set(
            effectiveTurn,
            Math.max(0, event.monotonicOffsetMs - turnStart.monotonicOffsetMs),
          );
        }
        finishAssistant();
        activeAssistant = {
          turn: effectiveTurn,
          start: event,
          last: event,
          rawEventCount: 1,
          updateCounts: {},
        };
      }
      // user 已由 runtime prompt/steer 表示；toolResult 已并入 tool_execution 记录。
      continue;
    }

    if (event.type === "message_update") {
      activeAssistant ??= {
        turn: effectiveTurn,
        start: event,
        last: event,
        rawEventCount: 0,
        updateCounts: {},
      };
      activeAssistant.last = event;
      activeAssistant.rawEventCount += 1;
      const update = objectValue(body?.assistantMessageEvent);
      const updateType = stringValue(update?.type) ?? "unknown";
      activeAssistant.updateCounts[updateType] =
        (activeAssistant.updateCounts[updateType] ?? 0) + 1;
      const partial = objectValue(update?.partial);
      if (partial !== undefined) activeAssistant.lastPartial = partial;
      if (
        activeAssistant.firstDelta === undefined &&
        ((stringValue(update?.delta)?.length ?? 0) > 0 || updateType.endsWith("_delta"))
      ) {
        activeAssistant.firstDelta = event;
      }
      continue;
    }

    if (event.type === "message_end") {
      const message = objectValue(body?.message);
      if (message?.role === "assistant") {
        activeAssistant ??= {
          turn: effectiveTurn,
          start: event,
          last: event,
          rawEventCount: 0,
          updateCounts: {},
        };
        finishAssistant(event);
      } else if (message?.role === "toolResult") {
        const callId = stringValue(message.toolCallId);
        if (callId === undefined || !completedToolCalls.has(callId)) {
          drafts.push(messageRecord(event, effectiveTurn, message));
        }
      }
      continue;
    }

    if (event.type === "tool_execution_start") {
      const callId = stringValue(body?.toolCallId) ?? `sequence-${event.sequence}`;
      activeTools.set(callId, {
        turn: effectiveTurn,
        start: event,
        last: event,
        rawEventCount: 1,
        updates: [],
      });
      calls += 1;
      continue;
    }

    if (event.type === "tool_execution_update") {
      const callId = stringValue(body?.toolCallId) ?? `sequence-${event.sequence}`;
      const active = activeTools.get(callId);
      if (active === undefined) {
        activeTools.set(callId, {
          turn: effectiveTurn,
          start: event,
          last: event,
          rawEventCount: 1,
          updates: [event.event],
        });
        calls += 1;
      } else {
        active.last = event;
        active.rawEventCount += 1;
        active.updates.push(event.event);
      }
      continue;
    }

    if (event.type === "tool_execution_end") {
      const callId = stringValue(body?.toolCallId) ?? `sequence-${event.sequence}`;
      const existing = activeTools.get(callId);
      if (existing === undefined) calls += 1;
      const active = existing ?? {
        turn: effectiveTurn,
        start: event,
        last: event,
        rawEventCount: 0,
        updates: [],
      };
      active.last = event;
      active.rawEventCount += 1;
      drafts.push(toolRecord(active, event));
      activeTools.delete(callId);
      completedToolCalls.add(callId);
      if (body?.isError === true) failedCalls += 1;
      continue;
    }

    drafts.push(simpleRecord(event, event.type === "session_created" ? 0 : effectiveTurn));
  }

  finishAssistant();
  for (const active of activeTools.values()) drafts.push(toolRecord(active));

  const records: DeepSeekTrajectoryRecord[] = drafts
    .sort((left, right) => left.sequence - right.sequence || left.sequenceEnd - right.sequenceEnd)
    .map((draft, index) => ({
      ...draft,
      id: `trajectory-${draft.sequence}-${draft.sequenceEnd}`,
      index: index + 1,
    }));

  const turnNumbers = [
    ...new Set([
      ...records.map((record) => record.turn),
      ...turnStarts.keys(),
      ...(events.some((event) => event.type === "session_created") ? [0] : []),
    ]),
  ].sort((left, right) => left - right);
  const turns: DeepSeekTrajectoryTurn[] = turnNumbers.map((number) => {
    const grouped = records.filter((record) => record.turn === number);
    const first =
      turnStarts.get(number) ??
      events.find((event) => event.sequence === grouped[0]?.sequence) ??
      events[0];
    const last = turnEnds.get(number);
    const durationMs =
      first === undefined || last === undefined
        ? undefined
        : Math.max(0, last.monotonicOffsetMs - first.monotonicOffsetMs);
    const modelWaitDurationMs = modelWaits.get(number);
    return {
      turn: number,
      startedAt: first?.occurredAt ?? new Date(0).toISOString(),
      ...(last === undefined ? {} : { completedAt: last.occurredAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(modelWaitDurationMs === undefined ? {} : { modelWaitDurationMs }),
      records: grouped,
    };
  });

  const modelWaitDurationMs = [...modelWaits.values()].reduce((sum, value) => sum + value, 0);
  const modelDurationMs = records
    .filter((record) => record.eventType === "assistant_generation")
    .reduce((sum, record) => sum + (record.durationMs ?? 0), 0);
  const cacheEligibleTokens = inputTokens + cacheReadTokens;
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  return {
    turns,
    records,
    stats: {
      events: events.length,
      records: records.length,
      turns: turnStarts.size > 0 ? turnStarts.size : turns.filter((item) => item.turn !== 0).length,
      calls,
      failedCalls,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      modelDurationMs,
      modelWaitDurationMs: modelWaits.size > 0 ? modelWaitDurationMs : null,
      outputTokensPerSecond: modelDurationMs > 0 ? outputTokens / (modelDurationMs / 1_000) : null,
      cacheHitRate: cacheEligibleTokens > 0 ? cacheReadTokens / cacheEligibleTokens : null,
      durationMs:
        firstEvent === undefined || lastEvent === undefined
          ? 0
          : Math.max(0, lastEvent.monotonicOffsetMs - firstEvent.monotonicOffsetMs),
    },
  };
}

function assistantRecord(
  active: AssistantAccumulator,
  end: InternalTrajectoryEventV1 | undefined,
): RecordDraft {
  const endBody = objectValue(end?.event);
  const startBody = objectValue(active.start.event);
  const message =
    objectValue(endBody?.message) ?? active.lastPartial ?? objectValue(startBody?.message);
  const usage = usageValue(message?.usage);
  const sequenceEnd = active.last.sequence;
  const updateCounts: Record<string, InternalTrajectoryValue> = {};
  for (const [type, count] of Object.entries(active.updateCounts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    updateCounts[type] = count;
  }
  const stream: Record<string, InternalTrajectoryValue> = {
    sequenceStart: active.start.sequence,
    sequenceEnd,
    rawEventCount: active.rawEventCount,
    updateCounts,
  };
  if (active.firstDelta !== undefined) {
    stream.firstDeltaSequence = active.firstDelta.sequence;
    stream.timeToFirstDeltaMs = Math.max(
      0,
      active.firstDelta.monotonicOffsetMs - active.start.monotonicOffsetMs,
    );
  }
  const detail: Record<string, InternalTrajectoryValue> = {
    type: "assistant_generation",
    stream,
    message: message ?? null,
  };
  const responseId = stringValue(message?.responseId);
  if (responseId !== undefined) detail.responseId = responseId;
  const api = stringValue(message?.api);
  if (api !== undefined) detail.api = api;
  const provider = stringValue(message?.provider);
  if (provider !== undefined) detail.provider = provider;
  const model = stringValue(message?.model);
  if (model !== undefined) detail.model = model;
  const stopReason = stringValue(message?.stopReason);
  if (stopReason !== undefined) detail.stopReason = stopReason;

  return {
    sequence: active.start.sequence,
    sequenceEnd,
    rawEventCount: active.rawEventCount,
    turn: active.turn,
    lane: "model",
    kind: "assistant",
    eventType: "assistant_generation",
    label: "ASSISTANT",
    summary: assistantSummary(message),
    startedAt: active.start.occurredAt,
    monotonicOffsetMs: active.start.monotonicOffsetMs,
    durationMs: Math.max(0, active.last.monotonicOffsetMs - active.start.monotonicOffsetMs),
    isError: hasMessageError(message),
    detail,
    ...(usage === undefined ? {} : { usage }),
  };
}

function toolRecord(active: ToolAccumulator, end?: InternalTrajectoryEventV1): RecordDraft {
  const startBody = objectValue(active.start.event);
  const endBody = objectValue(end?.event);
  const name = stringValue(endBody?.toolName) ?? stringValue(startBody?.toolName) ?? "TOOL";
  const callId = stringValue(endBody?.toolCallId) ?? stringValue(startBody?.toolCallId) ?? "";
  const detail: Record<string, InternalTrajectoryValue> = {
    type: "tool_execution",
    sequenceStart: active.start.sequence,
    sequenceEnd: active.last.sequence,
    rawEventCount: active.rawEventCount,
    callId,
    name,
    start: active.start.event,
    updates: active.updates,
    end: end?.event ?? null,
  };
  const isError = endBody?.isError === true;
  return {
    sequence: active.start.sequence,
    sequenceEnd: active.last.sequence,
    rawEventCount: active.rawEventCount,
    turn: active.turn,
    lane: "tools",
    kind: "tool",
    eventType: "tool_execution",
    label: name,
    summary: `${name} ${end === undefined ? "未结束" : isError ? "失败" : "完成"}`,
    startedAt: active.start.occurredAt,
    monotonicOffsetMs: active.start.monotonicOffsetMs,
    durationMs: Math.max(0, active.last.monotonicOffsetMs - active.start.monotonicOffsetMs),
    isError,
    detail,
  };
}

function messageRecord(
  event: InternalTrajectoryEventV1,
  turn: number,
  message: JsonObject,
): RecordDraft {
  const role = stringValue(message.role) ?? "message";
  const isTool = role === "toolResult";
  return {
    sequence: event.sequence,
    sequenceEnd: event.sequence,
    rawEventCount: 1,
    turn,
    lane: isTool ? "tools" : "input",
    kind: isTool ? "tool" : "user",
    eventType: isTool ? "tool_result" : "user_message",
    label: isTool ? (stringValue(message.toolName) ?? "TOOL") : "USER",
    summary: preview(messageText(message) || role),
    startedAt: event.occurredAt,
    monotonicOffsetMs: event.monotonicOffsetMs,
    durationMs: null,
    isError: message.isError === true,
    detail: event.event,
  };
}

function simpleRecord(event: InternalTrajectoryEventV1, turn: number): RecordDraft {
  const body = objectValue(event.event);
  const classification = classifySimple(event, body);
  return {
    sequence: event.sequence,
    sequenceEnd: event.sequence,
    rawEventCount: 1,
    turn,
    lane: classification.lane,
    kind: classification.kind,
    eventType: event.type,
    label: classification.label,
    summary: summarizeSimple(event, body),
    startedAt: event.occurredAt,
    monotonicOffsetMs: event.monotonicOffsetMs,
    durationMs: null,
    isError: body?.isError === true,
    detail: event.event,
  };
}

function classifySimple(
  event: InternalTrajectoryEventV1,
  _body: JsonObject | undefined,
): Pick<DeepSeekTrajectoryRecord, "lane" | "kind" | "label"> {
  if (event.type === "session_created") return { lane: "input", kind: "system", label: "SYSTEM" };
  if (event.type === "prompt" || event.type === "steer") {
    return { lane: "input", kind: "user", label: event.type === "prompt" ? "USER" : "STEER" };
  }
  return { lane: "input", kind: "runtime", label: "RUNTIME" };
}

function summarizeSimple(event: InternalTrajectoryEventV1, body: JsonObject | undefined): string {
  if (event.type === "session_created") {
    const model = objectValue(body?.model);
    return [stringValue(model?.provider), stringValue(model?.id)].filter(Boolean).join(" / ");
  }
  if (event.type === "prompt" || event.type === "steer") {
    return preview(stringValue(body?.text) ?? "");
  }
  return event.type;
}

function assistantSummary(message: JsonObject | undefined): string {
  if (message === undefined) return "模型流未产生完整消息";
  const text = messageTextByType(message, "text");
  if (text !== "") return preview(text);
  const toolNames = messageBlocks(message)
    .filter((block) => stringValue(block.type) === "toolCall")
    .map((block) => stringValue(block.name))
    .filter((name): name is string => name !== undefined && name !== "");
  if (toolNames.length > 0) return `调用 ${toolNames.join("、")}`;
  const reasoning = messageTextByType(message, "thinking");
  if (reasoning !== "") return preview(reasoning);
  return stringValue(message.stopReason) ?? "assistant";
}

function messageText(message: JsonObject): string {
  return messageBlocks(message)
    .flatMap((block) => [stringValue(block.text) ?? stringValue(block.thinking) ?? ""])
    .filter((item) => item !== "")
    .join("\n");
}

function messageTextByType(message: JsonObject, type: "text" | "thinking"): string {
  return messageBlocks(message)
    .filter((block) => stringValue(block.type) === type)
    .map((block) => (type === "text" ? stringValue(block.text) : stringValue(block.thinking)) ?? "")
    .filter((item) => item !== "")
    .join("\n");
}

function messageBlocks(message: JsonObject): JsonObject[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const block = objectValue(item);
    return block === undefined ? [] : [block];
  });
}

function usageValue(value: InternalTrajectoryValue | undefined): Usage | undefined {
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
