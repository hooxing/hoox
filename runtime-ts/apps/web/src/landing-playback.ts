import type { RunEvent } from "./api.js";
import { bookRun } from "./landing-case.js";
import { useLandingClock } from "./landing-motion.js";

const steps = [
  { action: "read", title: "国富论.epub", text: "正在读取资料，梳理全书五篇的结构。" },
  {
    action: "write",
    title: "国富论-思维导图.md",
    text: "核心脉络已整理，正在生成 Markdown 大纲。",
  },
  {
    action: "write",
    title: "国富论-思维导图.html",
    text: "正在构建交互导图，支持展开、缩放与平移。",
  },
] as const;
export const playbackTickMs = 32;
const stepDurationMs = 1_280;
export const playbackDurationMs = steps.length * stepDurationMs;

// 这是公开案例的编辑回放，不读取真实 Run，也不将生产思考日志作为展示数据。
export function bookPlaybackFrame(elapsed: number) {
  const finished = elapsed >= playbackDurationMs;
  const events: RunEvent[] = [];
  const append = (type: string, payload: unknown) => {
    const sequence = events.length + 1;
    events.push({
      eventId: `public-book-event-${sequence}`,
      sequence,
      occurredAt: bookRun.createdAt,
      kind: "agent_event",
      type,
      payload,
    });
  };
  for (const [index, step] of steps.entries()) {
    const offset = elapsed - index * stepDurationMs;
    if (offset < 0) break;
    const payload = {
      callId: `public-book-step-${index}`,
      name: step.action,
      presentation: { action: step.action, title: step.title },
    };
    append("tool.started", payload);
    append("message.delta", {
      delta: step.text.slice(0, Math.max(1, Math.floor(offset / playbackTickMs))),
    });
    if (offset < stepDurationMs) break;
    append("message.completed", {});
    append("tool.completed", payload);
  }
  if (finished) {
    append("message.delta", { delta: "两份思维导图已准备好。" });
    append("message.completed", {});
  }
  return {
    events,
    finished,
    run: { ...bookRun, status: finished ? ("succeeded" as const) : ("running" as const) },
  };
}

export function useBookPlayback() {
  const clock = useLandingClock(playbackDurationMs, playbackTickMs);
  return {
    ...clock,
    ...bookPlaybackFrame(clock.elapsed),
  };
}
