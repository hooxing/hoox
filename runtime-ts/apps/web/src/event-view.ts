import type { RunEvent } from "./api.js";

const maxAssistantMessageLength = 16_000;

export type TimelineEntry =
  | { readonly type: "assistant"; readonly id: string; readonly text: string }
  | { readonly type: "event"; readonly event: RunEvent };

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 500) : fallback;
}

/** 只呈现已知、受限字段，避免把工具回执或外部输入整体泄露到页面。 */
export function eventSummary(event: RunEvent): string {
  const payload = object(event.payload);
  switch (event.type) {
    case "message.delta":
      return text(payload?.delta, "助手正在生成内容");
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
    case "tool.failed": {
      const name = text(payload?.name, "未命名工具");
      const callId = text(payload?.callId, "未知调用");
      const outcome =
        event.type === "tool.started"
          ? "开始"
          : event.type === "tool.updated"
            ? "更新"
            : event.type === "tool.failed" || payload?.isError === true
              ? "失败"
              : "完成";
      return `工具 ${name}（${callId}）${outcome}`;
    }
    case "attempt_state_changed": {
      const status = text(payload?.status, "未知状态");
      const stage = text(payload?.stage, "未知阶段");
      const code = typeof payload?.code === "string" ? `（${payload.code.slice(0, 120)}）` : "";
      return `运行状态：${status} · ${stage}${code}`;
    }
    case "run_waiting":
      return `等待输入：${text(payload?.question, "需要继续处理")}`;
    default:
      return "已收到运行事件";
  }
}

/** 连续 delta 是同一条助手回复的流式片段，工具和状态事件会切断该回复。 */
export function buildTimeline(events: readonly RunEvent[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (event.type !== "message.delta") {
      entries.push({ type: "event", event });
      continue;
    }
    const delta = eventSummary(event);
    const previous = entries.at(-1);
    if (previous?.type === "assistant") {
      const remaining = maxAssistantMessageLength - previous.text.length;
      if (remaining > 0) {
        entries[entries.length - 1] = {
          ...previous,
          text: `${previous.text}${delta.slice(0, remaining)}`,
        };
      }
      continue;
    }
    entries.push({
      type: "assistant",
      id: event.eventId,
      text: delta.slice(0, maxAssistantMessageLength),
    });
  }
  return entries;
}
