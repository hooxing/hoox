import type { RunEvent } from "./api.js";

const maxAssistantMessageLength = 16_000;

export type UserFacingStep = {
  readonly id: string;
  readonly label: string;
  readonly status: "running" | "completed" | "failed";
  readonly count: number;
};

export type RunProgress = {
  readonly currentAction: string;
  readonly steps: readonly UserFacingStep[];
  readonly finalMessage: string | undefined;
};

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 500)
    : undefined;
}

/** 工具名只用于归类，不把调用标识或工具协议直接暴露给用户。 */
export function toolActionLabel(name: string | undefined): string {
  const normalized = name?.toLowerCase() ?? "";
  if (/(search|web|browse|fetch|crawl)/u.test(normalized)) return "正在搜索网页…";
  if (/(write|artifact|export|generate.*file|create.*file)/u.test(normalized)) {
    return "正在生成文件…";
  }
  if (/(shell|command|code|python|node|execute|run)/u.test(normalized)) {
    return "正在执行代码…";
  }
  if (/(read|list|inspect|open)/u.test(normalized)) return "正在读取资料…";
  return "正在处理任务…";
}

function toolDescriptor(
  event: RunEvent,
): { readonly key: string; readonly label: string } | undefined {
  if (!event.type.startsWith("tool.")) return undefined;
  const payload = object(event.payload);
  const name = text(payload?.name);
  // callId 仅作前端聚合键，不能进入可见文案。
  const key = text(payload?.callId) ?? `${name ?? "unknown"}:${event.sequence}`;
  return { key, label: toolActionLabel(name) };
}

/**
 * 将底层事件投影为有限的用户动作。未知生命周期事件被刻意忽略，避免页面成为调试日志。
 */
export function buildRunProgress(events: readonly RunEvent[]): RunProgress {
  const byTool = new Map<string, number>();
  const steps: UserFacingStep[] = [];
  let finalMessage = "";

  for (const event of events) {
    if (event.type === "message.delta") {
      const delta = text(object(event.payload)?.delta);
      if (delta !== undefined && finalMessage.length < maxAssistantMessageLength) {
        finalMessage += delta.slice(0, maxAssistantMessageLength - finalMessage.length);
      }
      continue;
    }
    const descriptor = toolDescriptor(event);
    if (descriptor === undefined) continue;
    const index = byTool.get(descriptor.key);
    const nextStatus =
      event.type === "tool.failed" || object(event.payload)?.isError === true
        ? "failed"
        : event.type === "tool.completed"
          ? "completed"
          : "running";
    if (index === undefined) {
      byTool.set(descriptor.key, steps.length);
      steps.push({ id: descriptor.key, label: descriptor.label, status: nextStatus, count: 1 });
    } else {
      const previous = steps[index];
      if (previous !== undefined) steps[index] = { ...previous, status: nextStatus };
    }
  }

  // 相邻的同类完成动作压缩为一步，降低重复工具调用的视觉噪声。
  const compacted: UserFacingStep[] = [];
  for (const step of steps) {
    const previous = compacted.at(-1);
    if (
      previous?.label === step.label &&
      previous.status === step.status &&
      step.status !== "running"
    ) {
      compacted[compacted.length - 1] = { ...previous, count: previous.count + step.count };
    } else {
      compacted.push(step);
    }
  }
  const active = [...compacted].reverse().find((step) => step.status === "running");
  return {
    currentAction: active?.label ?? compacted.at(-1)?.label ?? "正在准备任务…",
    steps: compacted,
    finalMessage: finalMessage.length > 0 ? finalMessage : undefined,
  };
}
